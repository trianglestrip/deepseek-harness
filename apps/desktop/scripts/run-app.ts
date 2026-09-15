/**
 * Run the development application with a clean process tree.
 *
 * Two things make a development run fail in ways that look like a shell bug:
 *
 * - WebView2 keeps a profile per application identifier. A shell killed without
 *   its children leaves `msedgewebview2.exe` processes holding that profile, and
 *   the next run then creates a window that never loads a page. `--fresh` removes
 *   the profile, and every run stops the previous tree first.
 * - A development build serves its pages from Tauri's asset server, so the
 *   executable must be started through `tauri dev`; launching it directly can
 *   only show an empty window.
 *
 * Usage:
 *   pnpm --filter @deepseek-ai/dsh-desktop run app             # packaged resources
 *   pnpm --filter @deepseek-ai/dsh-desktop run app -- --host    # linked runtime
 *   pnpm --filter @deepseek-ai/dsh-desktop run app -- --fresh   # drop the webview profile
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const APP_ROOT = resolve(import.meta.dirname, '..')
const DEV_RUNTIME = join(APP_ROOT, '.desktop-build', 'dev-runtime')
const APP_IDENTIFIER = 'ai.deepseek.dsh.desktop'
const WIN = process.platform === 'win32'

/** Stop the application and every process it left behind. */
export function stopApplication(): void {
  if (WIN) {
    spawnSync('taskkill', ['/F', '/T', '/IM', 'dsh-desktop.exe'], { stdio: 'ignore' })
    spawnSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"'
      + ' | Where-Object { $_.CommandLine -match \'desktop-runtime|shell-core|dsh-desktop-host|dev-runtime\' }'
      + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
      + '; Get-CimInstance Win32_Process -Filter "Name=\'msedgewebview2.exe\'"'
      + ` | Where-Object { $_.CommandLine -like '*${APP_IDENTIFIER}*' }`
      + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'], { stdio: 'ignore' })
    return
  }
  spawnSync('pkill', ['-f', 'dsh-desktop'], { stdio: 'ignore' })
  spawnSync('pkill', ['-f', 'desktop-runtime'], { stdio: 'ignore' })
  spawnSync('pkill', ['-f', 'shell-core'], { stdio: 'ignore' })
}

/**
 * Remove the WebView2 profile, which an interrupted run can leave unusable.
 *
 * The application identifier's profile is what a wedged run corrupts, but it can
 * be held by processes that outlived the shell, so a fresh run points WebView2 at
 * a directory of its own instead of deleting the held one.
 * @returns the directory the run should use, or `undefined` to keep the default.
 */
export function freshWebviewProfile(): string | undefined {
  if (!process.argv.includes('--fresh')) return undefined
  const directory = join(APP_ROOT, '.desktop-build', `webview-profile-${String(Date.now())}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

if (import.meta.main) {
  stopApplication()
  const host = process.argv.includes('--host')
  const args = ['exec', 'tauri', 'dev']
  if (host) {
    await import('./dev-runtime.ts')
    args.push('--config', join('src-tauri', 'tauri.dev.conf.json'))
  }
  const profile = freshWebviewProfile()
  process.stdout.write([
    `desktop app: tauri dev (${host ? 'linked runtime' : 'packaged resources'})`,
    ...(profile === undefined ? [] : [`desktop app: webview profile ${profile}`]),
    '',
  ].join('\n'))
  const child = spawn('pnpm', args, {
    cwd: APP_ROOT,
    stdio: 'inherit',
    shell: WIN,
    env: {
      ...process.env,
      ...(host ? { DSH_DESKTOP_DEV_RUNTIME: DEV_RUNTIME } : {}),
      ...(profile === undefined ? {} : { WEBVIEW2_USER_DATA_FOLDER: profile }),
    },
  })
  child.once('error', (error) => {
    process.stderr.write(`desktop app: ${error.message}\n`)
    process.exitCode = 1
  })
  child.once('close', (code) => {
    // Leave nothing behind: an orphaned WebView2 process wedges the next run.
    stopApplication()
    process.exitCode = code ?? 0
  })
}
