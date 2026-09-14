/**
 * Byte carriers that move framed requests and responses between a desktop shell
 * and this Host. The frame format is carrier-independent; a carrier only owns
 * which descriptors carry the bytes and how the request stream applies
 * backpressure.
 */

import { once } from 'node:events'
import { closeSync, createReadStream, createWriteStream } from 'node:fs'
import { Writable, type Readable } from 'node:stream'

import { DESKTOP_REQUEST_PIPE_FD, DESKTOP_RESPONSE_PIPE_FD } from './wire.ts'

/** Transport selected for this Host process. */
export type DesktopHostTransport = 'fd' | 'stdio'

/** One duplex carrier for framed Host traffic. */
export interface DesktopHostCarrier {
  readonly transport: DesktopHostTransport
  /** Deliver request bytes in arrival order. */
  onBytes(handler: (chunk: Buffer) => void): void
  /** Deliver the request-stream end. */
  onEnd(handler: () => void): void
  /** Deliver a transport failure. */
  onError(handler: (error: Error) => void): void
  /** Stop reading requests while the response stream is blocked. */
  pause(): void
  /** Resume reading requests. */
  resume(): void
  /** Serialized response writer that applies byte backpressure. */
  write(frame: Buffer): Promise<void>
  /** Close the response stream after the final write. */
  close(): Promise<void>
  /** Register carrier-level stop requests (termination signals). */
  onStopRequest(handler: () => void): void
  /** Release the descriptors this carrier owns. */
  destroy(): void
}

/**
 * Select the carrier named by `DSH_DESKTOP_TRANSPORT`.
 *
 * `fd` reads descriptor 3 and writes descriptor 4, the contract a shell that
 * spawns this process with explicit pipes uses. `stdio` reads standard input and
 * writes standard output, which is the only extra-descriptor-free transport a
 * language without handle inheritance (Rust on Windows) can offer.
 * @returns the carrier this process should serve.
 */
export function createCarrier(): DesktopHostCarrier {
  const transport = process.env.DSH_DESKTOP_TRANSPORT ?? 'fd'
  switch (transport) {
    case 'fd':
      return createDescriptorCarrier()
    case 'stdio':
      return createStdioCarrier()
    default:
      throw new Error(`dsh desktop: unsupported transport ${JSON.stringify(transport)}`)
  }
}

/** The carrier contract shared by both descriptor layouts. */
abstract class StreamCarrier implements DesktopHostCarrier {
  abstract readonly transport: DesktopHostTransport
  protected readonly source: Readable
  private readonly sink: Writable
  private writeTail: Promise<void> = Promise.resolve()
  private closed = false

  protected constructor(source: Readable, sink: Writable) {
    this.source = source
    this.sink = sink
  }

  onBytes(handler: (chunk: Buffer) => void): void {
    this.source.on('data', (chunk: Buffer) => { handler(chunk) })
  }

  onEnd(handler: () => void): void {
    this.source.once('end', handler)
  }

  onError(handler: (error: Error) => void): void {
    this.source.once('error', handler)
    this.sink.once('error', handler)
  }

  pause(): void {
    this.source.pause()
  }

  resume(): void {
    this.source.resume()
  }

  write(frame: Buffer): Promise<void> {
    const write = this.writeTail.then(async () => {
      if (this.closed) throw new Error('dsh desktop: response stream is closed')
      if (!this.sink.write(frame)) await once(this.sink, 'drain')
    })
    this.writeTail = write.catch(() => undefined)
    return write
  }

  async close(): Promise<void> {
    this.closed = true
    await this.writeTail.catch(() => undefined)
    this.closeSink()
  }

  onStopRequest(handler: () => void): void {
    process.once('SIGTERM', handler)
    process.once('SIGINT', handler)
  }

  destroy(): void {
    this.source.destroy()
    this.sink.destroy()
  }

  /** End the response stream; the transport releases its descriptors here. */
  protected closeSink(): void {
    this.sink.end()
  }
}

/**
 * Move every non-frame stdout write to stderr.
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

/** Descriptor 3 in, descriptor 4 out; the shell passes the pipes explicitly. */
class DescriptorCarrier extends StreamCarrier {
  readonly transport = 'fd' as const

  constructor() {
    super(
      createReadStream('', { fd: DESKTOP_REQUEST_PIPE_FD, autoClose: false }),
      createWriteStream('', { fd: DESKTOP_RESPONSE_PIPE_FD, autoClose: false }),
    )
  }

  protected override closeSink(): void {
    super.closeSink()
    closeSync(DESKTOP_RESPONSE_PIPE_FD)
  }

  override destroy(): void {
    try {
      super.destroy()
    } finally {
      closeSync(DESKTOP_REQUEST_PIPE_FD)
      closeSync(DESKTOP_RESPONSE_PIPE_FD)
    }
  }
}

/**
 * Standard input in, standard output out.
 *
 * Frames own standard output, so every other write to it is redirected to
 * standard error: a log line that could reach the frame stream would corrupt
 * it, and the harness logs freely.
 */
class StdioCarrier extends StreamCarrier {
  readonly transport = 'stdio' as const

  constructor() {
    const out = process.stdout
    const writeBytes = out.write.bind(out) as (chunk: Buffer) => boolean
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (writeBytes(chunk)) callback()
        else out.once('drain', () => { callback() })
      },
    })
    super(process.stdin, sink)
    process.stdout.write = redirectStdout as typeof process.stdout.write
  }

  protected override closeSink(): void {
    // Standard input is the request stream: releasing it is what lets the
    // process exit once the shell stops reading.
    this.source.destroy()
    super.closeSink()
  }

  override destroy(): void {
    this.source.pause()
  }
}

/** @returns the carrier named by the transport selection. */
function createDescriptorCarrier(): DesktopHostCarrier {
  return new DescriptorCarrier()
}

/** @returns the standard-stream carrier with stdout reserved for frames. */
function createStdioCarrier(): DesktopHostCarrier {
  return new StdioCarrier()
}
