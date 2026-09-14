/**
 * The request session a desktop shell drives over a carrier: frame decoding,
 * request-body streaming with backpressure, control commands, and teardown.
 */

import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  DesktopHostRequestDecoder,
  encodeDesktopResponseControlResult,
  encodeDesktopResponseEvent,
  type DesktopHostRequestFrame,
} from './wire.ts'
import type { DesktopHostCarrier } from './carriers.ts'
import type { DesktopHostController } from './index.ts'

/**
 * Serve one Host process until the shell stops it or the request stream ends.
 *
 * Every lifecycle event, response frame, and control answer is written through
 * the carrier, so the caller owns only process selection and exit-code policy.
 * @param controller - active composition the session dispatches requests to.
 * @param carrier - duplex carrier this process was started with.
 * @returns completion after full teardown; the process exit code stays 0 unless
 * the transport failed.
 */
export async function runDesktopHostSession(
  controller: DesktopHostController,
  carrier: DesktopHostCarrier,
): Promise<void> {
  const decoder = new DesktopHostRequestDecoder()
  const requestBodies = new Map<number, ReadableStreamDefaultController<Uint8Array>>()
  const blockedRequests = new Set<number>()
  const discardedRequestBodies = new Set<number>()
  const runs = new Set<Promise<void>>()
  let lastStreamId = 0
  let requestedExitCode = 0
  let stopping: Promise<void> | undefined
  let settleSession!: () => void
  const sessionFinished = new Promise<void>((resolve) => { settleSession = resolve })

  const resumeRequestStream = (): void => {
    if (blockedRequests.size === 0) carrier.resume()
  }

  const stop = (exitCode = 0): Promise<void> => {
    requestedExitCode = Math.max(requestedExitCode, exitCode)
    stopping ??= (async () => {
      carrier.pause()
      const stopped = new Error('dsh desktop: Host is stopping')
      for (const body of requestBodies.values()) body.error(stopped)
      requestBodies.clear()
      blockedRequests.clear()
      discardedRequestBodies.clear()
      carrier.destroy()
      await controller.dispose()
      await Promise.allSettled([...runs])
      await carrier.close()
      process.exitCode = requestedExitCode
      settleSession()
    })()
    return stopping
  }

  const failTransport = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    void carrier
      .write(encodeDesktopResponseEvent({ event: 'fatal', message }))
      .catch(() => undefined)
      .then(() => stop(1))
  }

  const beginRequest = (frame: Extract<DesktopHostRequestFrame, { type: 'start' }>): void => {
    if (frame.streamId <= lastStreamId) {
      throw new Error(`dsh desktop: the shell reused or reordered request stream ${String(frame.streamId)}`)
    }
    lastStreamId = frame.streamId
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
          controller.cancel(frame.streamId)
          resumeRequestStream()
        },
      })
    }
    const run = controller.fetch({
      streamId: frame.streamId,
      request: {
        url: frame.url,
        method: frame.method,
        headers: frame.headers,
      },
    }, body)
    runs.add(run)
    void run.catch(failTransport).finally(() => {
      runs.delete(run)
      const openBody = requestBodies.get(frame.streamId)
      if (openBody === undefined) return
      openBody.error(new Error('dsh desktop: the response completed before the request body ended'))
      requestBodies.delete(frame.streamId)
      blockedRequests.delete(frame.streamId)
      discardedRequestBodies.add(frame.streamId)
      resumeRequestStream()
    })
  }

  const answerControl = (id: number, result: { ok: boolean; value?: unknown; message?: string }): void => {
    void carrier
      .write(encodeDesktopResponseControlResult({ id, ...result }))
      .catch(failTransport)
  }

  const handleRequestFrame = (frame: DesktopHostRequestFrame): void => {
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
          carrier.pause()
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
        controller.cancel(frame.streamId)
        resumeRequestStream()
        return
      }
      case 'control': {
        if (frame.command === 'shutdown') {
          answerControl(frame.id, { ok: true })
          void stop(0)
          return
        }
        answerControl(frame.id, { ok: false, message: `dsh desktop: unsupported control command ${JSON.stringify(frame.command)}` })
        return
      }
      default:
        frame satisfies never
    }
  }

  carrier.onBytes((chunk) => {
    try {
      for (const frame of decoder.push(Buffer.from(chunk))) handleRequestFrame(frame)
    } catch (error) {
      failTransport(error)
    }
  })
  carrier.onEnd(() => {
    if (stopping !== undefined) return
    try {
      decoder.finish()
      failTransport(new Error('dsh desktop: the shell request stream ended'))
    } catch (error) {
      failTransport(error)
    }
  })
  carrier.onError(failTransport)
  carrier.onStopRequest(() => { void stop() })

  // The `fd` carrier is the Electron contract: lifecycle events travel on the
  // Node IPC channel and the shell stops the Host with an IPC message. The
  // `stdio` carrier has no IPC channel, so events become response frames and
  // the shell stops the Host with a control request frame.
  if (carrier.transport === 'fd') {
    process.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'shutdown') {
        void stop(0)
      }
    })
    process.send?.({
      type: 'ready',
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      dshVersion: controller.dshVersion,
    })
  } else {
    await carrier.write(encodeDesktopResponseEvent({
      event: 'ready',
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      dshVersion: controller.dshVersion,
    }))
  }
  await sessionFinished
}
