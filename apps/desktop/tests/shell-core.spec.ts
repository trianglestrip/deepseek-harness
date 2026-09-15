/**
 * The shell core's frame handling: readiness, request streaming, control
 * commands, and the teardown a shell without Node IPC depends on.
 */

import { describe, expect, it } from 'vitest'
import { runShellCore, type ShellCoreHost, type ShellCoreStream } from '../src/shell-core.ts'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  encodeShellCoreRequestControl,
} from '../src/shell-core-wire.ts'
import {
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
} from '../src/host-protocol.ts'

const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13

interface WrittenFrame {
  readonly type: number
  readonly id: number
  readonly payload: Buffer
}

/** Read one expected frame, failing the test when the core wrote fewer. */
function at(frames: readonly WrittenFrame[], index: number): WrittenFrame {
  const frame = frames[index]
  if (frame === undefined) throw new Error(`expected at least ${String(index + 1)} frame(s), saw ${String(frames.length)}`)
  return frame
}

/** Duplex stream driven by the test instead of the standard streams. */
class TestStream implements ShellCoreStream {
  readonly frames: WrittenFrame[] = []
  paused = 0
  private buffer = Buffer.alloc(0)
  private onBytesHandler: ((chunk: Buffer) => void) | undefined
  private onEndHandler: (() => void) | undefined
  private resolvers: Array<() => void> = []

  onBytes(handler: (chunk: Buffer) => void): void {
    this.onBytesHandler = handler
  }

  onEnd(handler: () => void): void {
    this.onEndHandler = handler
  }

  onError(): void {}

  write(frame: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, frame])
    for (;;) {
      if (this.buffer.byteLength < FRAME_HEADER_BYTES) break
      if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('test stream: bad frame marker')
      const length = this.buffer.readUInt32BE(9)
      if (this.buffer.byteLength < FRAME_HEADER_BYTES + length) break
      this.frames.push({
        type: this.buffer.readUInt8(4),
        id: this.buffer.readUInt32BE(5),
        payload: Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)),
      })
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length)
    }
    for (const resolve of this.resolvers.splice(0)) resolve()
    return Promise.resolve()
  }

  pause(): void {
    this.paused += 1
  }

  resume(): void {}

  /** Feed shell request bytes. */
  send(bytes: Buffer): void {
    this.onBytesHandler?.(bytes)
  }

  /** Close the shell's request stream. */
  close(): void {
    this.onEndHandler?.()
  }

  /** Wait until at least `count` frames were written. */
  async waitFor(count: number): Promise<WrittenFrame[]> {
    while (this.frames.length < count) {
      await new Promise<void>((resolve) => { this.resolvers.push(resolve) })
    }
    return this.frames
  }

  /** Wait until the core reports a fatal failure. */
  async waitForFatal(): Promise<WrittenFrame> {
    for (;;) {
      const found = this.frames.find(frame => frame.type === 5 && this.json(frame).event === 'fatal')
      if (found !== undefined) return found
      await new Promise<void>((resolve) => { this.resolvers.push(resolve) })
    }
  }

  json(frame: WrittenFrame): Record<string, unknown> {
    return JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>
  }
}

class TestHost implements ShellCoreHost {
  started = 0
  stopped = 0
  readonly requests: Request[] = []
  private readonly respond: (request: Request) => Promise<Response>
  private readonly failure: Error | undefined

  constructor(respond: (request: Request) => Promise<Response> = async () => new Response('ok'), failure?: Error) {
    this.respond = respond
    this.failure = failure
  }

  async start(): Promise<{ dshVersion: string }> {
    this.started += 1
    if (this.failure !== undefined) throw this.failure
    return { dshVersion: '0.1.5-rc.2' }
  }

  fetch(request: Request): Promise<Response> {
    this.requests.push(request)
    return this.respond(request)
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }
}

function startFrame(streamId: number, hasBody: boolean, url = 'dsh-app://app/index.html'): Buffer {
  return Buffer.from(encodeDesktopRequestStart(streamId, {
    url,
    method: hasBody ? 'POST' : 'GET',
    headers: [['accept', 'text/html']],
    hasBody,
  }))
}

describe('shell core', () => {
  it('publishes readiness as an event frame on the reserved id', async () => {
    const stream = new TestStream()
    const host = new TestHost()
    const running = runShellCore(host, stream)
    const ready = at(await stream.waitFor(1), 0)
    expect(ready.type).toBe(5)
    expect(ready.id).toBe(0)
    expect(stream.json(ready)).toEqual({
      event: 'ready',
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      dshVersion: '0.1.5-rc.2',
    })
    stream.close()
    await running
  })

  it('serves a request without a body as start, data, and end frames', async () => {
    const stream = new TestStream()
    const host = new TestHost(async () => new Response('<html>desktop</html>', { headers: { 'content-type': 'text/html' } }))
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(startFrame(1, false))
    const frames = await stream.waitFor(4)
    expect(at(frames, 1).type).toBe(1)
    expect(at(frames, 1).id).toBe(1)
    expect(stream.json(at(frames, 1))).toMatchObject({ status: 200, hasBody: true })
    expect(at(frames, 2).payload.toString('utf8')).toBe('<html>desktop</html>')
    expect(at(frames, 3).type).toBe(3)
    expect(host.requests[0]?.url).toBe('dsh-app://app/index.html')
    stream.close()
    await running
  })

  it('streams a request body into the Host before the response', async () => {
    const stream = new TestStream()
    const received: string[] = []
    const host = new TestHost(async request => new Response(await request.text()))
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(startFrame(1, true))
    stream.send(encodeDesktopRequestData(1, Buffer.from('hello ')))
    stream.send(encodeDesktopRequestData(1, Buffer.from('desktop')))
    stream.send(encodeDesktopRequestEnd(1))
    const frames = await stream.waitFor(4)
    received.push(at(frames, 2).payload.toString('utf8'))
    expect(received).toEqual(['hello desktop'])
    stream.close()
    await running
  })

  it('answers a shutdown control frame and stops the Host', async () => {
    const stream = new TestStream()
    const host = new TestHost()
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(encodeShellCoreRequestControl(1, 'shutdown'))
    const frames = await stream.waitFor(2)
    expect(at(frames, 1).type).toBe(6)
    expect(at(frames, 1).id).toBe(1)
    expect(stream.json(at(frames, 1))).toEqual({ ok: true })
    await expect(running).resolves.toBe(0)
    expect(host.stopped).toBe(1)
  })

  it('reports an unsupported control command without stopping', async () => {
    const stream = new TestStream()
    const host = new TestHost()
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(encodeShellCoreRequestControl(1, 'restart-everything'))
    const frames = await stream.waitFor(2)
    expect(stream.json(at(frames, 1))).toMatchObject({ ok: false })
    expect(host.stopped).toBe(0)
    stream.close()
    await running
  })

  it('reports a Host startup failure as a fatal event and exits non-zero', async () => {
    const stream = new TestStream()
    const host = new TestHost(async () => new Response('ok'), new Error('composition failed'))
    const running = runShellCore(host, stream)
    const fatal = at(await stream.waitFor(1), 0)
    expect(stream.json(fatal)).toEqual({ event: 'fatal', message: 'composition failed' })
    await expect(running).resolves.toBe(1)
  })

  it('reports a response failure as an error frame for that stream', async () => {
    const stream = new TestStream()
    const host = new TestHost(async () => { throw new Error('handler failed') })
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(startFrame(1, false))
    const frames = await stream.waitFor(2)
    expect(at(frames, 1).type).toBe(4)
    expect(stream.json(at(frames, 1))).toEqual({ message: 'handler failed' })
    stream.close()
    await running
  })

  it('rejects a reused stream id as a fatal transport failure', async () => {
    const stream = new TestStream()
    const host = new TestHost()
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.send(startFrame(2, false))
    stream.send(startFrame(2, false))
    const fatal = await stream.waitForFatal()
    expect(stream.json(fatal)).toMatchObject({ event: 'fatal' })
    await expect(running).resolves.toBe(1)
  })

  it('treats the end of the shell request stream as a failure', async () => {
    const stream = new TestStream()
    const host = new TestHost()
    const running = runShellCore(host, stream)
    await stream.waitFor(1)
    stream.close()
    const frames = await stream.waitFor(2)
    expect(stream.json(at(frames, 1))).toMatchObject({ event: 'fatal' })
    await expect(running).resolves.toBe(1)
    expect(host.stopped).toBe(1)
  })
})
