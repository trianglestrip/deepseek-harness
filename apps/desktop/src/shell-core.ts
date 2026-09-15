/**
 * The shell core: the Node parent of the installed desktop Host.
 *
 * The Tauri shell cannot hand a child the descriptors and IPC channel the
 * installed `@deepseek-ai/dsh-desktop-host` expects, so this process sits
 * between them: it speaks the framed wire on standard streams with the shell
 * and drives `DesktopHostProcess`, the upstream parent half that owns the
 * descriptors, the IPC readiness handshake, backpressure, and teardown.
 *
 * Usage: `node shell-core.js <runtimeDir> <projectDir> [--allow-linked-profile]`
 */

import { once } from 'node:events'
import { DesktopHostProcess } from './host-process.ts'
import { DESKTOP_PIPE_CHUNK_BYTES } from './host-protocol.ts'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  ShellCoreRequestDecoder,
  encodeCoreResponseControlResult,
  encodeCoreResponseData,
  encodeCoreResponseEnd,
  encodeCoreResponseError,
  encodeCoreResponseEvent,
  encodeCoreResponseStart,
  type ShellCoreRequestFrame,
} from './shell-core-wire.ts'

/** The Host operations the core drives; the installed Host satisfies this interface. */
export interface ShellCoreHost {
  /** @returns readiness facts once the composition is active. */
  start(): Promise<{ readonly dshVersion: string }>
  /** @param request - one shell request. @returns its response, streaming both ways. */
  fetch(request: Request): Promise<Response>
  /** @returns completion of child exit. */
  stop(): Promise<void>
}

/** Duplex byte stream to the shell; the shipped core uses the standard streams. */
export interface ShellCoreStream {
  /** Deliver request bytes in arrival order. */
  onBytes(handler: (chunk: Buffer) => void): void
  /** Deliver the request-stream end. */
  onEnd(handler: () => void): void
  /** Deliver a transport failure. */
  onError(handler: (error: Error) => void): void
  /** Serialized response writer that applies byte backpressure. */
  write(frame: Buffer): Promise<void>
  /** Stop reading requests while a request body is blocked. */
  pause(): void
  /** Resume reading requests. */
  resume(): void
}

/** Development runs link profile packages instead of installing them. */
const ALLOW_LINKED_FLAG = '--allow-linked-profile'
/**
 * Port the upstream parent half requires before it appends
 * `--allow-linked-profile`; port 0 asks the operating system for a free one.
 */
const LINKED_PROFILE_INSPECT_PORT = 0

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Serve one Host from the shell's request stream.
 *
 * Every response frame, lifecycle event, and control answer is written through
 * the stream, so the caller owns only process selection and exit handling.
 * @param host - Host the core drives.
 * @param stream - duplex stream to the shell.
 * @returns the process exit code: 0 after a requested stop, 1 after a failure.
 */
export async function runShellCore(host: ShellCoreHost, stream: ShellCoreStream): Promise<number> {
  const decoder = new ShellCoreRequestDecoder()
  const requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const blockedRequests = new Set<number>()
  const discardedRequestBodies = new Set<number>()
  const aborts = new Map<number, AbortController>()
  const runs = new Set<Promise<void>>()
  let lastStreamId = 0
  let exitCode = 0
  let stopping: Promise<void> | undefined
  let settleSession!: () => void
  const sessionFinished = new Promise<void>((resolve) => { settleSession = resolve })

  const resumeRequestStream = (): void => {
    if (blockedRequests.size === 0) stream.resume()
  }

  const stop = (code = 0): Promise<void> => {
    exitCode = Math.max(exitCode, code)
    stopping ??= (async () => {
      stream.pause()
      const stopped = new Error('dsh desktop: the shell core is stopping')
      for (const body of requestBodies.values()) body.error(stopped)
      requestBodies.clear()
      blockedRequests.clear()
      discardedRequestBodies.clear()
      for (const abort of aborts.values()) abort.abort(stopped)
      aborts.clear()
      await Promise.allSettled([...runs])
      await host.stop()
      settleSession()
    })()
    return stopping
  }

  const fail = (reason: unknown): void => {
    const message = messageOf(reason)
    void stream
      .write(encodeCoreResponseEvent({ event: 'fatal', message }))
      .catch(() => undefined)
      .then(() => stop(1))
  }

  const answerControl = (id: number, result: { ok: boolean; value?: unknown; message?: string }): void => {
    void stream.write(encodeCoreResponseControlResult({ id, ...result })).catch(fail)
  }

  const beginRequest = (frame: Extract<ShellCoreRequestFrame, { type: 'start' }>): void => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`dsh desktop: the shell reused or reordered request stream ${String(frame.streamId)}`)
    }
    lastStreamId = frame.streamId
    const abort = new AbortController()
    aborts.set(frame.streamId, abort)
    let body: ReadableStream<Uint8Array> | null = null
    if (frame.hasBody) {
      body = new ReadableStream<Uint8Array>({
        start(controllerOfBody) {
          requestBodies.set(frame.streamId, controllerOfBody)
        },
        pull() {
          blockedRequests.delete(frame.streamId)
          resumeRequestStream()
        },
        cancel() {
          requestBodies.delete(frame.streamId)
          blockedRequests.delete(frame.streamId)
          abort.abort(new Error('dsh desktop: the shell canceled the request body'))
          resumeRequestStream()
        },
      })
    }
    const request = new Request(frame.url, {
      method: frame.method,
      headers: frame.headers,
      signal: abort.signal,
      ...(body === null ? {} : { body, duplex: 'half' }),
    } as RequestInit & { duplex: 'half' })
    const run = (async () => {
      try {
        const response = await host.fetch(request)
        await stream.write(encodeCoreResponseStart(frame.streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null,
        }))
        if (response.body !== null) {
          const reader = response.body.getReader()
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              for (let offset = 0; offset < next.value.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
                await stream.write(encodeCoreResponseData(
                  frame.streamId,
                  next.value.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
                ))
              }
            }
          } finally {
            reader.releaseLock()
          }
        }
        await stream.write(encodeCoreResponseEnd(frame.streamId))
      } catch (error) {
        // A canceled stream already released its response; the shell owes it no error frame.
        if (abort.signal.aborted) return
        await stream.write(encodeCoreResponseError(frame.streamId, messageOf(error)))
      }
    })()
    runs.add(run)
    void run.catch(fail).finally(() => {
      runs.delete(run)
      aborts.delete(frame.streamId)
      const openBody = requestBodies.get(frame.streamId)
      if (openBody === undefined) return
      openBody.error(new Error('dsh desktop: the response completed before the request body ended'))
      requestBodies.delete(frame.streamId)
      blockedRequests.delete(frame.streamId)
      discardedRequestBodies.add(frame.streamId)
      resumeRequestStream()
    })
  }

  const handleRequestFrame = (frame: ShellCoreRequestFrame): void => {
    switch (frame.type) {
      case 'start':
        beginRequest(frame)
        return
      case 'data': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.has(frame.streamId)) return
          throw new Error(`dsh desktop: the shell sent body data for inactive stream ${String(frame.streamId)}`)
        }
        body.enqueue(frame.data)
        if ((body.desiredSize ?? 0) <= 0) {
          blockedRequests.add(frame.streamId)
          stream.pause()
        }
        return
      }
      case 'end': {
        const body = requestBodies.get(frame.streamId)
        if (body === undefined) {
          if (discardedRequestBodies.delete(frame.streamId)) return
          throw new Error(`dsh desktop: the shell ended inactive body stream ${String(frame.streamId)}`)
        }
        body.close()
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        resumeRequestStream()
        return
      }
      case 'cancel': {
        if (frame.streamId > lastStreamId) {
          throw new Error(`dsh desktop: the shell canceled unknown stream ${String(frame.streamId)}`)
        }
        const body = requestBodies.get(frame.streamId)
        body?.error(new Error('dsh desktop: the shell canceled the request'))
        requestBodies.delete(frame.streamId)
        blockedRequests.delete(frame.streamId)
        discardedRequestBodies.delete(frame.streamId)
        aborts.get(frame.streamId)?.abort(new Error('dsh desktop: the shell canceled the request'))
        resumeRequestStream()
        return
      }
      case 'control': {
        if (frame.command === 'shutdown') {
          answerControl(frame.id, { ok: true })
          void stop(0)
          return
        }
        answerControl(frame.id, {
          ok: false,
          message: `dsh desktop: unsupported control command ${JSON.stringify(frame.command)}`,
        })
        return
      }
      default:
        frame satisfies never
    }
  }

  stream.onBytes((chunk) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame)
    } catch (error) {
      fail(error)
    }
  })
  stream.onEnd(() => {
    if (stopping !== undefined) return
    try {
      decoder.finish()
      fail(new Error('dsh desktop: the shell request stream ended'))
    } catch (error) {
      fail(error)
    }
  })
  stream.onError(fail)

  try {
    const ready = await host.start()
    await stream.write(encodeCoreResponseEvent({
      event: 'ready',
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      dshVersion: ready.dshVersion,
    }))
  } catch (error) {
    fail(error)
  }
  await sessionFinished
  return exitCode
}

/**
 * Move every non-frame standard-output write to standard error.
 * @param chunk - text or bytes written to standard output.
 * @param encoding - buffer encoding, or the write callback.
 * @param callback - completion callback of the three-argument form.
 * @returns whether the redirected stream accepted the bytes without buffering.
 */
function redirectStdout(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
  callback?: (error?: Error | null) => void,
): boolean {
  if (typeof encoding === 'function') return process.stderr.write(chunk, encoding)
  return process.stderr.write(chunk, encoding, callback)
}

/** @returns the standard-stream duplex, with standard output reserved for frames. */
function createStdioStream(): ShellCoreStream {
  const out = process.stdout
  const writeBytes = out.write.bind(out) as (chunk: Buffer) => boolean
  let tail: Promise<void> = Promise.resolve()
  // Frames own standard output; Host logs and the piped Host stdout go to stderr.
  out.write = redirectStdout as typeof out.write
  return {
    onBytes(handler) {
      process.stdin.on('data', (chunk: Buffer) => { handler(chunk) })
    },
    onEnd(handler) {
      process.stdin.once('end', handler)
    },
    onError(handler) {
      process.stdin.once('error', handler)
    },
    write(frame) {
      const write = tail.then(async () => {
        if (!writeBytes(frame)) await once(out, 'drain')
      })
      tail = write.catch(() => undefined)
      return write
    },
    pause() {
      process.stdin.pause()
    },
    resume() {
      process.stdin.resume()
    },
  }
}

if (import.meta.main) {
  const [runtimeDir, projectDir, ...options] = process.argv.slice(2)
  const unknown = options.filter(option => option !== ALLOW_LINKED_FLAG)
  if (runtimeDir === undefined || projectDir === undefined || unknown.length > 0) {
    process.stderr.write(
      'dsh shell core: expected a runtime directory, a profile directory,'
      + ` and optionally ${ALLOW_LINKED_FLAG}\n`,
    )
    process.exit(2)
  }
  const allowLinked = options.includes(ALLOW_LINKED_FLAG)
  const host = new DesktopHostProcess(
    process.execPath,
    runtimeDir,
    projectDir,
    allowLinked ? LINKED_PROFILE_INSPECT_PORT : undefined,
    process.env,
    (error) => { process.stderr.write(`dsh shell core: host failure: ${error.message}\n`) },
  )
  const code = await runShellCore(host, createStdioStream())
  process.exit(code)
}
