/**
 * The framed wire between the desktop shell and the shell core.
 *
 * This is the Host's own protocol (`@deepseek-ai/dsh-desktop-host/src/wire.ts`)
 * seen from the parent side: the same marker, header, and request/response
 * frame types, plus the lifecycle event and control frames a shell without a
 * Node IPC channel needs. `apps/desktop/src-tauri/tests/fixtures/host-wire-vectors.json`
 * pins the bytes against the Rust codec.
 */

import { DESKTOP_HOST_PROTOCOL_VERSION, DESKTOP_PIPE_CHUNK_BYTES } from './host-protocol.ts'

export { DESKTOP_HOST_PROTOCOL_VERSION }

/** Frame marker every desktop frame starts with. */
const FRAME_MAGIC = 0x44534833
/** Frame header: marker, type, stream id, payload length. */
const FRAME_HEADER_BYTES = 13
/** Bound on a lifecycle event or control answer. */
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

/** One validated frame the shell wrote to the core. */
export type ShellCoreRequestFrame = {
  readonly type: 'start'
  readonly streamId: number
  readonly url: string
  readonly method: string
  readonly headers: readonly [string, string][]
  readonly hasBody: boolean
} | {
  readonly type: 'data'
  readonly streamId: number
  readonly data: Uint8Array
} | {
  readonly type: 'end' | 'cancel'
  readonly streamId: number
} | {
  readonly type: 'control'
  readonly id: number
  readonly command: string
}

/** Lifecycle facts the core publishes before and after serving requests. */
export type ShellCoreLifecycleEvent = {
  readonly event: 'ready'
  readonly protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  readonly dshVersion: string
} | {
  readonly event: 'fatal'
  readonly message: string
}

/** One control answer; `ok` false carries the failure message. */
export interface ShellCoreControlResult {
  readonly id: number
  readonly ok: boolean
  readonly value?: unknown
  readonly message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeaders(value: unknown): value is readonly [string, string][] {
  return Array.isArray(value) && value.every(row => (
    Array.isArray(row) && row.length === 2 && row.every(cell => typeof cell === 'string')
  ))
}

function assertStreamId(streamId: number): void {
  if (!Number.isInteger(streamId) || streamId <= 0 || streamId > 0xffff_ffff) {
    throw new Error(`dsh desktop: invalid stream id ${String(streamId)}`)
  }
}

function encodeFrame(type: number, id: number, payload: Buffer, limit: number): Buffer {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
    throw new Error(`dsh desktop: invalid frame id ${String(id)}`)
  }
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

function encodeJsonFrame(type: number, id: number, value: unknown, limit: number): Buffer {
  return encodeFrame(type, id, Buffer.from(JSON.stringify(value), 'utf8'), limit)
}

/**
 * Encode one control command the shell sends to the core.
 * @param id - 1-based control id.
 * @param command - command name the core dispatches.
 * @returns the framed bytes to write to the shell's request stream.
 */
export function encodeShellCoreRequestControl(id: number, command: string): Buffer {
  return encodeJsonFrame(REQUEST_FRAME_CONTROL, id, { command }, MAX_CONTROL_PAYLOAD_BYTES)
}

/** Encode response metadata before any body frames. */
export function encodeCoreResponseStart(
  streamId: number,
  response: {
    readonly status: number
    readonly headers: readonly [string, string][]
    readonly hasBody: boolean
  },
): Buffer {
  assertStreamId(streamId)
  return encodeJsonFrame(RESPONSE_FRAME_START, streamId, response, MAX_CONTROL_PAYLOAD_BYTES)
}

/** Encode one bounded raw response-body chunk. */
export function encodeCoreResponseData(streamId: number, data: Uint8Array): Buffer {
  assertStreamId(streamId)
  return encodeFrame(RESPONSE_FRAME_DATA, streamId, Buffer.from(data), DESKTOP_PIPE_CHUNK_BYTES)
}

/** Encode normal body completion. */
export function encodeCoreResponseEnd(streamId: number): Buffer {
  assertStreamId(streamId)
  return encodeFrame(RESPONSE_FRAME_END, streamId, Buffer.alloc(0), MAX_CONTROL_PAYLOAD_BYTES)
}

/** Encode one response failure. */
export function encodeCoreResponseError(streamId: number, message: string): Buffer {
  assertStreamId(streamId)
  return encodeJsonFrame(RESPONSE_FRAME_ERROR, streamId, { message }, MAX_CONTROL_PAYLOAD_BYTES)
}

/** Encode one lifecycle event on the reserved id 0. */
export function encodeCoreResponseEvent(event: ShellCoreLifecycleEvent): Buffer {
  return encodeJsonFrame(RESPONSE_FRAME_EVENT, 0, event, MAX_CONTROL_PAYLOAD_BYTES)
}

/** Encode one control answer. */
export function encodeCoreResponseControlResult(result: ShellCoreControlResult): Buffer {
  assertStreamId(result.id)
  return encodeJsonFrame(RESPONSE_FRAME_CONTROL_RESULT, result.id, {
    ok: result.ok,
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.message === undefined ? {} : { message: result.message }),
  }, MAX_CONTROL_PAYLOAD_BYTES)
}

/** Incremental decoder for the shell's request stream. */
export class ShellCoreRequestDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  /**
   * Append bytes and return every complete request frame.
   * @param chunk - next bytes read from the shell.
   * @returns complete frames in arrival order.
   */
  push(chunk: Buffer): ShellCoreRequestFrame[] {
    this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: ShellCoreRequestFrame[] = []
    for (;;) {
      const frame = this.next()
      if (frame === undefined) return frames
      frames.push(frame)
    }
  }

  /** Reject a stream that ended inside a frame. */
  finish(): void {
    if (this.buffer.byteLength !== 0) throw new Error('dsh desktop: the shell request stream ended inside a frame')
  }

  private next(): ShellCoreRequestFrame | undefined {
    if (this.buffer.byteLength < FRAME_HEADER_BYTES) return undefined
    if (this.buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('dsh desktop: invalid request frame marker')
    const rawType = this.buffer.readUInt8(4)
    const streamId = this.buffer.readUInt32BE(5)
    const payloadLength = this.buffer.readUInt32BE(9)
    const limit = rawType === REQUEST_FRAME_DATA ? DESKTOP_PIPE_CHUNK_BYTES : MAX_CONTROL_PAYLOAD_BYTES
    if (payloadLength > limit) {
      throw new Error(`dsh desktop: request frame exceeds the ${String(limit)}-byte limit`)
    }
    const frameLength = FRAME_HEADER_BYTES + payloadLength
    if (this.buffer.byteLength < frameLength) return undefined
    const payload = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, frameLength))
    this.buffer = this.buffer.subarray(frameLength)
    switch (rawType) {
      case REQUEST_FRAME_START:
        return this.parseStart(streamId, payload)
      case REQUEST_FRAME_DATA:
        assertStreamId(streamId)
        return { type: 'data', streamId, data: payload }
      case REQUEST_FRAME_END:
        this.assertBare(streamId, payloadLength, 'end')
        return { type: 'end', streamId }
      case REQUEST_FRAME_CANCEL:
        this.assertBare(streamId, payloadLength, 'cancel')
        return { type: 'cancel', streamId }
      case REQUEST_FRAME_CONTROL:
        return this.parseControl(streamId, payload)
      default:
        throw new Error(`dsh desktop: unknown request frame type ${String(rawType)}`)
    }
  }

  private assertBare(streamId: number, payloadLength: number, subject: string): void {
    assertStreamId(streamId)
    if (payloadLength !== 0) throw new Error(`dsh desktop: request ${subject} frame carried a payload`)
  }

  private parseStart(streamId: number, payload: Buffer): ShellCoreRequestFrame {
    assertStreamId(streamId)
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

  private parseControl(id: number, payload: Buffer): ShellCoreRequestFrame {
    assertStreamId(id)
    const value = this.parseJson(payload, 'control')
    if (!isRecord(value) || typeof value.command !== 'string') {
      throw new Error('dsh desktop: invalid request control payload')
    }
    return { type: 'control', id, command: value.command }
  }

  private parseJson(payload: Buffer, subject: string): unknown {
    try {
      return JSON.parse(payload.toString('utf8')) as unknown
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`dsh desktop: request ${subject} payload is not JSON: ${detail}`)
    }
  }
}
