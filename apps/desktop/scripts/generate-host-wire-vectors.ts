/**
 * Regenerate the cross-language wire vectors the Rust shell checks its codec
 * against.
 *
 * The vectors are the contract between the shell core (TypeScript) and the
 * desktop shell (Rust): every frame the core emits is encoded here, and the
 * Rust test suite decodes the same bytes. Run it after any wire change:
 *
 *   pnpm exec tsx apps/desktop/scripts/generate-host-wire-vectors.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  encodeDesktopRequestCancel,
  encodeDesktopRequestData,
  encodeDesktopRequestEnd,
  encodeDesktopRequestStart,
} from '../src/host-protocol.ts'
import {
  DESKTOP_HOST_PROTOCOL_VERSION,
  encodeCoreResponseControlResult,
  encodeCoreResponseData,
  encodeCoreResponseEnd,
  encodeCoreResponseError,
  encodeCoreResponseEvent,
  encodeCoreResponseStart,
  encodeShellCoreRequestControl,
} from '../src/shell-core-wire.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const OUTPUT = join(APP_ROOT, 'src-tauri', 'tests', 'fixtures', 'host-wire-vectors.json')
/** Stream id every request vector is encoded with; the Rust test encodes the same id. */
const STREAM_ID = 7

interface WireVector {
  readonly name: string
  readonly direction: 'request' | 'response'
  readonly hex: string
  readonly decoded: Readonly<Record<string, unknown>>
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

const requestBody = Buffer.from('hello desktop', 'utf8')
const responseBody = Buffer.from('<html>desktop</html>', 'utf8')

const vectors: WireVector[] = [
  {
    name: 'request.start',
    direction: 'request',
    hex: hex(encodeDesktopRequestStart(STREAM_ID, {
      url: 'dsh-app://app/index.html',
      method: 'GET',
      headers: [['accept', 'text/html']],
      hasBody: false,
    })),
    decoded: {
      type: 'start',
      url: 'dsh-app://app/index.html',
      method: 'GET',
      headers: [['accept', 'text/html']],
      hasBody: false,
    },
  },
  {
    name: 'request.data',
    direction: 'request',
    hex: hex(encodeDesktopRequestData(STREAM_ID, requestBody)),
    decoded: { type: 'data', dataBase64: requestBody.toString('base64') },
  },
  {
    name: 'request.end',
    direction: 'request',
    hex: hex(encodeDesktopRequestEnd(STREAM_ID)),
    decoded: { type: 'end' },
  },
  {
    name: 'request.cancel',
    direction: 'request',
    hex: hex(encodeDesktopRequestCancel(STREAM_ID)),
    decoded: { type: 'cancel' },
  },
  {
    name: 'request.control.shutdown',
    direction: 'request',
    hex: hex(encodeShellCoreRequestControl(3, 'shutdown')),
    decoded: { type: 'control', id: 3, command: 'shutdown' },
  },
  {
    name: 'response.start',
    direction: 'response',
    hex: hex(encodeCoreResponseStart(1, {
      status: 200,
      headers: [['content-type', 'text/html; charset=utf-8']],
      hasBody: true,
    })),
    decoded: {
      type: 'start',
      status: 200,
      headers: [['content-type', 'text/html; charset=utf-8']],
      hasBody: true,
    },
  },
  {
    name: 'response.data',
    direction: 'response',
    hex: hex(encodeCoreResponseData(1, responseBody)),
    decoded: { type: 'data', dataBase64: responseBody.toString('base64') },
  },
  {
    name: 'response.end',
    direction: 'response',
    hex: hex(encodeCoreResponseEnd(1)),
    decoded: { type: 'end' },
  },
  {
    name: 'response.error',
    direction: 'response',
    hex: hex(encodeCoreResponseError(1, 'handler failed')),
    decoded: { type: 'error', message: 'handler failed' },
  },
  {
    name: 'response.event.ready',
    direction: 'response',
    hex: hex(encodeCoreResponseEvent({
      event: 'ready',
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      dshVersion: '0.1.5-rc.2',
    })),
    decoded: { event: 'ready', protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, dshVersion: '0.1.5-rc.2' },
  },
  {
    name: 'response.event.fatal',
    direction: 'response',
    hex: hex(encodeCoreResponseEvent({ event: 'fatal', message: 'composition failed' })),
    decoded: { event: 'fatal', message: 'composition failed' },
  },
  {
    name: 'response.controlResult',
    direction: 'response',
    hex: hex(encodeCoreResponseControlResult({ id: 2, ok: true, value: { restarted: false } })),
    decoded: { id: 2, ok: true, value: { restarted: false } },
  },
]

mkdirSync(join(APP_ROOT, 'src-tauri', 'tests', 'fixtures'), { recursive: true })
writeFileSync(OUTPUT, `${JSON.stringify({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, vectors }, undefined, 2)}\n`)
process.stdout.write(`desktop vectors: wrote ${String(vectors.length)} vectors to ${OUTPUT}\n`)
