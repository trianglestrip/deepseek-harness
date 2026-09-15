/**
 * Run `tauri dev` against a workspace-linked desktop runtime.
 *
 * The development shell boots the same Host the packaged application does, so
 * the carrier, the invoke commands, and the injected renderer transport are
 * exercised while developing. `scripts/dev-runtime.ts` links the tree first.
 *
 * The run declares no bundle resources: the build script copies every declared
 * resource into the target directory on each rebuild, and the linked tree
 * supplies them here instead (see `src-tauri/tauri.dev.conf.json`).
 */

import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const DEV_RUNTIME = join(APP_ROOT, '.desktop-build', 'dev-runtime')

await import('./dev-runtime.ts')

const child = spawn(
  'pnpm',
  ['exec', 'tauri', 'dev', '--config', join('src-tauri', 'tauri.dev.conf.json')],
  {
  cwd: APP_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DSH_DESKTOP_DEV_RUNTIME: DEV_RUNTIME },
})
child.once('error', (error) => {
  process.stderr.write(`desktop dev host: ${error.message}\n`)
  process.exitCode = 1
})
child.once('close', (code) => { process.exitCode = code ?? 0 })
