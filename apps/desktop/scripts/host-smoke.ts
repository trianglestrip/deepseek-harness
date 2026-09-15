/**
 * Smoke-test the installed desktop Host over the `stdio` carrier.
 *
 * It links the workspace packages into a temporary runtime and profile, starts
 * the shell core under the runtime, fetches the application document through the
 * wire, and stops the core with a control frame. Run it after changing the core,
 * the wire, or the Host entry:
 *
 *   pnpm --filter @deepseek-ai/dsh-desktop run smoke:host
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { encodeDesktopRequestStart } from '../src/host-protocol.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION, encodeShellCoreRequestControl } from '../src/shell-core-wire.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
/** First byte group of every frame; the Host rejects anything else. */
const FRAME_MAGIC = 0x44534833
const FRAME_HEADER_BYTES = 13
const STREAM_ID = 1
/** Bound on the whole smoke, including the composition boot. */
const TIMEOUT_MS = 180_000

interface Frame {
  readonly type: number
  readonly id: number
  readonly payload: Buffer
}

function workspacePackages(): Array<{ name: string; directory: string }> {
  const packages: Array<{ name: string; directory: string }> = []
  const groups = readdirSync(join(REPOSITORY_ROOT, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => readdirSync(join(REPOSITORY_ROOT, 'packages', entry.name), { withFileTypes: true })
      .filter(child => child.isDirectory())
      .map(child => join(REPOSITORY_ROOT, 'packages', entry.name, child.name)))
  const roots = [
    ...groups,
    ...readdirSync(join(REPOSITORY_ROOT, 'vendor'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(REPOSITORY_ROOT, 'vendor', entry.name)),
    join(REPOSITORY_ROOT, 'apps', 'cli'),
    join(REPOSITORY_ROOT, 'apps', 'web'),
    join(REPOSITORY_ROOT, 'apps', 'desktop-host'),
  ]
  for (const directory of roots) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string }
      if (typeof manifest.name === 'string') packages.push({ name: manifest.name, directory })
    } catch {
      // A directory without a manifest is not a package.
    }
  }
  return packages
}

/** Link every workspace package so the temporary project resolves its profile bundles. */
function linkWorkspace(modules: string): void {
  for (const entry of workspacePackages()) {
    const target = join(modules, ...entry.name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    try {
      symlinkSync(entry.directory, target, 'junction')
    } catch {
      // An existing link already points at the same package.
    }
  }
}

function readFrames(onFrame: (frame: Frame) => void): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0)
  return (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.byteLength < FRAME_HEADER_BYTES) return
      if (buffer.readUInt32BE(0) !== FRAME_MAGIC) throw new Error('host smoke: bad frame marker')
      const type = buffer.readUInt8(4)
      const id = buffer.readUInt32BE(5)
      const length = buffer.readUInt32BE(9)
      if (buffer.byteLength < FRAME_HEADER_BYTES + length) return
      const payload = buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
      buffer = buffer.subarray(FRAME_HEADER_BYTES + length)
      onFrame({ type, id, payload: Buffer.from(payload) })
    }
  }
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-host-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const runtime = join(home, 'runtime')
  mkdirSync(profile, { recursive: true })
  mkdirSync(join(runtime, 'node_modules', '@deepseek-ai'), { recursive: true })
  linkWorkspace(join(runtime, 'node_modules'))
  linkWorkspace(join(profile, 'node_modules'))
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, undefined, 2)}\n`)

  const host = spawn(process.execPath, [
    join(REPOSITORY_ROOT, 'apps', 'desktop', 'lib', 'shell-core.js'),
    runtime,
    profile,
    '--allow-linked-profile',
  ], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      DSH_HOME: home,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let ready = false
  let document = ''
  let reported: Error | undefined
  const frames = readFrames((frame) => {
    if (reported !== undefined) return
    try {
      if (frame.type === 5 && frame.id === 0) {
        const event = JSON.parse(frame.payload.toString('utf8')) as { event: string; protocolVersion?: number; dshVersion?: string; message?: string }
        if (event.event === 'ready') {
          if (event.protocolVersion !== DESKTOP_HOST_PROTOCOL_VERSION) {
            throw new Error(`host smoke: protocol ${String(event.protocolVersion)} is not ${String(DESKTOP_HOST_PROTOCOL_VERSION)}`)
          }
          ready = true
          process.stdout.write(`host smoke: ready, dsh ${String(event.dshVersion)}\n`)
          host.stdin.write(encodeDesktopRequestStart(STREAM_ID, {
            url: 'dsh-app://app/index.html',
            method: 'GET',
            headers: [['accept', 'text/html']],
            hasBody: false,
          }))
        } else {
          throw new Error(`host smoke: Host reported ${event.event}: ${event.message ?? ''}`)
        }
        return
      }
      if (frame.type === 2) document += frame.payload.toString('utf8')
      if (frame.type === 1) process.stdout.write(`host smoke: response status ${String(JSON.parse(frame.payload.toString('utf8')).status)}\n`)
    } catch (error) {
      reported = error instanceof Error ? error : new Error(String(error))
    }
  })

  host.stdout.on('data', (chunk: Buffer) => { frames(chunk) })
  host.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk) })

  const deadline = Date.now() + TIMEOUT_MS
  try {
    while (Date.now() < deadline && !document.includes('</html>') && reported === undefined) await new Promise(resolve => setTimeout(resolve, 50))
    if (reported !== undefined) throw reported
    if (!ready) throw new Error('host smoke: the Host never reported readiness')
    // The shell installs its own transport as a window initialization script;
    // this only proves the Host served a document that carries its own hooks.
    if (!document.includes('ownsHost')) throw new Error('host smoke: the served document carries no transport hooks')
    process.stdout.write(`host smoke: document ${String(document.length)} bytes carries the shell transport\n`)
    host.stdin.write(encodeShellCoreRequestControl(1, 'shutdown'))
    const exit = new Promise<number | null>(resolve => host.once('close', resolve))
    const code = await Promise.race([exit, new Promise<null>(resolve => setTimeout(() => { resolve(null) }, 30_000))])
    if (code !== 0) throw new Error(`host smoke: the Host exited with ${String(code)} after the shutdown control frame`)
    process.stdout.write('host smoke: ok\n')
  } finally {
    host.kill('SIGKILL')
    // DSH_DESKTOP_SMOKE_KEEP keeps the temporary runtime for diagnosis.
    if (process.env.DSH_DESKTOP_SMOKE_KEEP === '1') process.stderr.write(`host smoke: kept ${home}\n`)
    else rmSync(home, { recursive: true, force: true })
  }
}

await main()
