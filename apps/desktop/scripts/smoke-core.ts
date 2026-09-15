/**
 * Drive the shell core the way the shell does, without a window.
 *
 * The core is what the shell spawns under the bundled Node.js; this program
 * speaks its frame protocol directly, so a Host failure, a protocol mistake, or
 * a broken profile can be reproduced in a terminal with the core's own
 * diagnostics. `smoke:host` covers the Host alone; this covers the core and the
 * Host together.
 *
 * Usage:
 *   pnpm --filter @deepseek-ai/dsh-desktop run smoke:core
 *   pnpm --filter @deepseek-ai/dsh-desktop run smoke:core -- --runtime <dir> --profile <dir>
 *   pnpm --filter @deepseek-ai/dsh-desktop run smoke:core -- --allow-linked-profile
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { encodeShellCoreRequestControl } from '../src/shell-core-wire.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const RESOURCES = join(APP_ROOT, 'src-tauri', 'resources', 'desktop-runtime')
const WIN = process.platform === 'win32'

/** Read one `--name value` pair, falling back to the packaged resource tree. */
function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  return value ?? fallback
}

const node = option('node', join(RESOURCES, 'node', WIN ? 'node.exe' : 'node'))
const core = option('core', join(RESOURCES, 'shell-core.js'))
const runtime = option('runtime', join(RESOURCES, 'dsh'))
const profile = option('profile', join(
  process.env['DSH_HOME'] ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.dsh'),
  'profiles',
  'desktop',
))
const allowLinked = process.argv.includes('--allow-linked-profile')

for (const [label, path] of [['node', node], ['core', core], ['runtime', runtime], ['profile', profile]] as const) {
  if (!existsSync(path)) throw new Error(`desktop core smoke: ${label} ${path} is missing`)
}

process.stdout.write([
  `core smoke: node ${node}`,
  `core smoke: core ${core}`,
  `core smoke: runtime ${runtime}`,
  `core smoke: profile ${profile}`,
  '',
].join('\n'))

const args = [core, runtime, profile]
if (allowLinked) args.push('--allow-linked-profile')
const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'] })

/**
 * Request frame, as the Rust shell encodes it (`src-tauri/src/host/frame.rs`)
 * and `shell-core-wire.ts` decodes it.
 */
const MAGIC = 0x44534833
const REQUEST_START = 1
const REQUEST_DATA = 2
const REQUEST_END = 3
function frame(type: number, streamId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(MAGIC, 0)
  header.writeUInt8(type, 4)
  header.writeUInt32BE(streamId, 5)
  header.writeUInt32BE(payload.byteLength, 9)
  return Buffer.concat([header, payload])
}

let buffer = Buffer.alloc(0)
let nextStream = 1
/** Request ids awaiting a response, with the bytes each response carried. */
const pending = new Map<number, { status: number; body: Buffer }>()
/** Stream endpoint to open once the core reports readiness, with lines to print. */
const streamEndpoint = option('stream', '')
let streamLines = 0

function request(url: string, method: string, body?: string, keepOpen = false): void {
  const id = nextStream
  nextStream += 1
  pending.set(id, { status: 0, body: Buffer.alloc(0) })
  child.stdin.write(frame(REQUEST_START, id, Buffer.from(JSON.stringify({
    url,
    method,
    headers: body === undefined ? [['accept', 'text/html']] : [['accept', 'application/json'], ['content-type', 'application/json']],
    hasBody: body !== undefined,
  }))))
  // Only a request that declared a body ends one; the injected renderer
  // transport does the same.
  if (body !== undefined) {
    child.stdin.write(frame(REQUEST_DATA, id, Buffer.from(body)))
    child.stdin.write(frame(REQUEST_END, id, Buffer.alloc(0)))
  }
  if (keepOpen) openStreams.add(id)
}

/** Requests that must not be answered before the run reports, such as event streams. */
const openStreams = new Set<number>()

child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
child.stdout.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (buffer.byteLength < 13) return
    const length = buffer.readUInt32BE(9)
    if (buffer.byteLength < 13 + length) return
    const type = buffer.readUInt8(4)
    const id = buffer.readUInt32BE(5)
    const payload = buffer.subarray(13, 13 + length)
    buffer = buffer.subarray(13 + length)
    if (type === 5) {
      const event = JSON.parse(payload.toString('utf8')) as { event: string; dshVersion?: string; message?: string }
      process.stdout.write(`core smoke: event ${event.event} ${event.dshVersion ?? event.message ?? ''}\n`)
      if (event.event === 'ready') {
        if (streamEndpoint !== '') {
          request('dsh-app://app/.dsh/remote-stream', 'POST', JSON.stringify({ endpoint: streamEndpoint, payload: { args: {} } }), true)
        } else {
          request('dsh-app://app/index.html', 'GET')
        }
      }
      if (event.event === 'fatal') process.exitCode = 1
      continue
    }
    const entry = pending.get(id)
    if (entry === undefined) continue
    if (type === 1) entry.status = (JSON.parse(payload.toString('utf8')) as { status: number }).status
    if (type === 2) {
      entry.body = Buffer.concat([entry.body, payload])
      if (openStreams.has(id) && streamLines < 3) {
        streamLines += 1
        const text = payload.toString('utf8').trim()
        process.stdout.write(`core smoke: chunk ${String(streamLines)} ${text.slice(0, 300)}\n`)
        if (streamLines >= 3) {
          child.stdin.write(encodeShellCoreRequestControl(1, 'shutdown'))
        }
      }
    }
    if (type === 3) {
      const text = entry.body.toString('utf8')
      process.stdout.write(`core smoke: ${String(entry.status)} ${String(entry.body.byteLength)} bytes html=${String(text.includes('<html'))}\n`)
      pending.delete(id)
      if (openStreams.delete(id)) continue
      if (entry.status !== 200) {
        process.exitCode = 1
      } else if (id === 1) {
        // The renderer's first call after the document, which is what a working
        // window sends.
        request('dsh-app://app/api/settings/describe', 'POST', '{}')
      } else {
        child.stdin.write(encodeShellCoreRequestControl(1, 'shutdown'))
      }
    }
    if (type === 4) {
      process.stdout.write(`core smoke: error ${payload.toString('utf8')}\n`)
      process.exitCode = 1
    }
  }
})
child.once('close', (code) => {
  process.stdout.write(`core smoke: closed ${String(code)}\n`)
  process.exit(process.exitCode ?? (code === 0 ? 0 : 1))
})
setTimeout(() => {
  process.stderr.write('core smoke: timed out\n')
  child.kill('SIGKILL')
}, 180_000)
