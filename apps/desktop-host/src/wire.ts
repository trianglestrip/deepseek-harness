/** Framed request and response bytes for the Desktop Host transport. */

/** Protocol version shared by the desktop shell and the installed Host. */
export const DESKTOP_HOST_PROTOCOL_VERSION = 3 as const

/** Child descriptor that receives request frames in the `fd` transport. */
export const DESKTOP_REQUEST_PIPE_FD = 3

/** Child descriptor that emits response frames in the `fd` transport. */
export const DESKTOP_RESPONSE_PIPE_FD = 4

/** Maximum raw body bytes carried by one data frame. */
export const DESKTOP_PIPE_CHUNK_BYTES = 64 * 1024

const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13
const MAX_CONTROL_PAYLOAD_BYTES = 1024 * 1024

const REQUEST_FRAME_START = 1
const REQUEST_FRAME_DATA = 2
const REQUEST_FRAME_END = 3
const REQUEST_FRAME_CANCEL = 4
const REQUEST_FRAME_CONTROL = 5

const RESPONSE_FRAME_START = 1
const RESPONSE_FRAME_DATA = 2
const RESPONSE_FRAME_END = 3
const RESPONSE_FRAME_ERROR = 4
const RESPONSE_FRAME_EVENT = 5
const RESPONSE_FRAME_CONTROL_RESULT = 6
type ResponseFrameType = typeof RESPONSE_FRAME_START | typeof RESPONSE_FRAME_DATA
  | typeof RESPONSE_FRAME_END | typeof RESPONSE_FRAME_ERROR
  | typeof RESPONSE_FRAME_EVENT | typeof RESPONSE_FRAME_CONTROL_RESULT

/** One validated request frame. */
export type DesktopHostRequestFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Buffer
} | {
  readonly type: 'end' | 'cancel'
  readonly streamId: number
} | {
  readonly type: 'control'
  readonly id: number
  readonly command: string
  readonly payload: unknown
}

/** Commands the control plane accepts. Unknown commands are answered as failures. */
export type DesktopHostControlCommand = {
  readonly id: number
  readonly command: 'shutdown'
  readonly payload?: unknown
}

/** Lifecycle events the Host publishes on the response stream. */
export type DesktopHostLifecycleEvent = {
  readonly event: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly event: 'fatal'
  readonly message: string
}

/** One control answer; `ok` false carries the failure message. */
export type DesktopHostControlResult = {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeaders(value: unknown): value is readonly [string, string][] {
  return Array.isArray(value) && value.every(header => Array.isArray(header) && header.length === 2
    && typeof header[0] === 'string' && typeof header[1] === 'string')
}

/**
 * Frame ids share one slot: request stream ids are 1..2^32-1, control ids are
 * their own 1..2^32-1 sequence, and lifecycle events use 0.
 */
function assertFrameId(id: number): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
    throw new Error(`dsh desktop: invalid frame id ${String(id)}`)
  }
}

function encodeFrame(type: ResponseFrameType, id: number, payload: Buffer): Buffer {
  assertFrameId(id)
  const limit = type === RESPONSE_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
  if (payload.byteLength > limit) {
    throw new Error(`dsh desktop: response frame exceeds the ${String(limit)}-byte limit`)
  }
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength)
  frame.writeUInt32BE(FRAME_MAGIC, 0)
  frame.writeUInt8(type, 4)
  frame.writeUInt32BE(id, 5)
  frame.writeUInt32BE(payload.byteLength, 9)
  payload.copy(frame, FRAME_HEADER_BYTES)
  return frame
}

function encodeJsonFrame(type: ResponseFrameType, id: number, value: unknown): Buffer {
  return encodeFrame(type, id, Buffer.from(JSON.stringify(value), 'utf8'))
}

/**
 * Encode one control command. The `fd` carrier's shell sends these over the
 * control channel; the `stdio` carrier frames them on the request stream, which
 * has no control channel of its own.
 * @param id - 1-based control id.
 * @param command - command name the Host dispatches.
 * @returns the framed bytes to write to the request stream.
 */
export function encodeDesktopRequestControl(id: number, command: string): Buffer {
  return encodeFrame(REQUEST_FRAME_CONTROL, id, Buffer.from(JSON.stringify({ command }), 'utf8'))
}

/** Encode response metadata before any body frames. */
export function encodeDesktopResponseStart(
  streamId: number,
  response: {
    readonly status: number
    readonly headers: readonly [string, string][]
    readonly hasBody: boolean
  },
): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_START, streamId, response)
}

/** Encode one bounded raw response-body chunk. */
export function encodeDesktopResponseData(streamId: number, data: Uint8Array): Buffer {
  return encodeFrame(RESPONSE_FRAME_DATA, streamId, Buffer.from(data))
}

/** Encode normal response completion. */
export function encodeDesktopResponseEnd(streamId: number): Buffer {
  return encodeFrame(RESPONSE_FRAME_END, streamId, Buffer.alloc(0))
}

/** Encode one response failure without exposing an Error object across processes. */
export function encodeDesktopResponseError(streamId: number, message: string): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_ERROR, streamId, { message })
}

/** Encode one lifecycle event on the response stream. */
export function encodeDesktopResponseEvent(event: DesktopHostLifecycleEvent): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_EVENT, 0, event)
}

/** Encode one control answer on the response stream. */
export function encodeDesktopResponseControlResult(result: DesktopHostControlResult): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_CONTROL_RESULT, result.id, result)
}

/** Incrementally decode validated request frames from the request stream. */
export class DesktopHostRequestDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Append bytes and return every complete request frame.
   * @param chunk - next bytes read from the request stream.
   * @returns complete frames in arrival order.
   */
  push(chunk: Buffer): DesktopHostRequestFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: DesktopHostRequestFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  /** Reject EOF that splits a frame. */
  finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error('dsh desktop: request stream ended inside a frame')
  }

  private next(): DesktopHostRequestFrame | undefined {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('dsh desktop: invalid request frame marker')
    const rawType = this.buffer.readUInt8(4)
    const id = this.buffer.readUInt32BE(5)
    const payloadLength = this.buffer.readUInt32BE(9)
    assertFrameId(id)
    const limit = rawType === REQUEST_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
    if (payloadLength > limit) {
      throw new Error(`dsh desktop: request frame exceeds the ${String(limit)}-byte limit`)
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength
    if (this.buffer.byteLength < frameLength) return undefined
    const payload = this.buffer.subarray(FRAME_HEADER_BYTES, frameLength)
    this.buffer = this.buffer.subarray(frameLength)
    switch (rawType) {
      case REQUEST_FRAME_START:
        return this.parseStart(id, payload)
      case REQUEST_FRAME_DATA:
        return { type: 'data', streamId: id, data: payload }
      case REQUEST_FRAME_END:
        this.assertBare(id, payloadLength, 'end')
        return { type: 'end', streamId: id }
      case REQUEST_FRAME_CANCEL:
        this.assertBare(id, payloadLength, 'cancel')
        return { type: 'cancel', streamId: id }
      case REQUEST_FRAME_CONTROL:
        return this.parseControl(id, payload)
      default:
        throw new Error(`dsh desktop: unknown request frame type ${String(rawType)}`)
    }
  }

  private assertBare(id: number, payloadLength: number, subject: string): void {
    if (id === 0) throw new Error(`dsh desktop: request ${subject} frame carried the event id`)
    if (payloadLength !== 0) throw new Error(`dsh desktop: request ${subject} frame carried a payload`)
  }

  private parseStart(streamId: number, payload: Buffer): DesktopHostRequestFrame {
    if (streamId === 0) throw new Error('dsh desktop: request start frame carried the event id')
    const value = this.parseJson(payload, 'start')
    if (!isRecord(value) || typeof value.url !== 'string' || typeof value.method !== 'string'
      || !isHeaders(value.headers) || typeof value.hasBody !== 'boolean') {
      throw new Error('dsh desktop: invalid request start payload')
    }
    return {
      type: 'start',
      streamId,
      url: value.url,
      method: value.method,
      headers: value.headers,
      hasBody: value.hasBody,
    }
  }

  private parseControl(id: number, payload: Buffer): DesktopHostRequestFrame {
    if (id === 0) throw new Error('dsh desktop: request control frame carried the event id')
    const value = this.parseJson(payload, 'control')
    if (!isRecord(value) || typeof value.command !== 'string' || value.command === '') {
      throw new Error('dsh desktop: invalid request control payload')
    }
    return { type: 'control', id, command: value.command, payload: value.payload }
  }

  private parseJson(payload: Buffer, subject: string): unknown {
    try {
      return JSON.parse(payload.toString('utf8')) as unknown
    } catch (error) {
      throw new Error(`dsh desktop: request ${subject} payload is not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
