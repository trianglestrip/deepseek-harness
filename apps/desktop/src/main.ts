import { app, BrowserWindow, Menu, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { acquireSingleInstance, installExitHooks, watchForCrash } from './app-lifecycle'
import { resolveDshRuntime } from './dsh-runtime'
import { startServer, type ServerHandle } from './server-process'

/** 0 lets the OS pick a free port; the readiness line carries the real one. */
const DEFAULT_PORT = 0
/** Upper bound on dsh boot (MCP/plugin initialization can be slow on a cold home). */
const READY_TIMEOUT_MS = 180_000
/**
 * The desktop-first profile: same bundles as `web` without the home's MCP
 * rows, so dsh boots without waiting on stdio MCP servers. Falls back to
 * `web` when the profile has not been initialized.
 */
const DEFAULT_PROFILE = 'desktop'

/**
 * Pick the profile to boot: an explicit `DSH_DESKTOP_PROFILE` wins, then the
 * desktop profile when it exists in the Harness home, then the shipped `web`.
 */
function resolveProfile(): string {
  const override = process.env.DSH_DESKTOP_PROFILE
  if (override !== undefined && override !== '') return override
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return existsSync(join(home, 'profiles', DEFAULT_PROFILE)) ? DEFAULT_PROFILE : 'web'
}
/**
 * Attach mode for development: load an already-running dsh web URL instead of
 * spawning one. Set DSH_DESKTOP_URL=http://127.0.0.1:3080/?token=… to iterate
 * on dsh without restarting the shell.
 */
const externalUrl = process.env.DSH_DESKTOP_URL

let mainWindow: BrowserWindow | null = null
let server: ServerHandle | null = null
let readyPromise: Promise<string> | null = null
let launching = false
let lastReadyUrl: string | null = null

// Both source (tsx) and built (tsc) entries sit directly under apps/desktop.
const rootDir = join(__dirname, '..', '..', '..')

function errorPageUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString()
  return pathToFileURL(join(__dirname, 'window', 'error.html')).href + (search === '' ? '' : `#${search}`)
}

function createWindow(): void {
  // No application menu at all: the shell is a plain window frame around the
  // web UI, so Windows' default File/Edit menu is never created.
  Menu.setApplicationMenu(null)
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'DeepSeek Harness Desktop',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, 'preload.js'),
    },
  })
  mainWindow.on('ready-to-show', () => { mainWindow?.show() })
  mainWindow.on('closed', () => { mainWindow = null })
}

/**
 * Spawn the supervised dsh server as early as possible. The multi-second
 * plugin-tree boot then runs while Electron is still building its window
 * stack; launch() only awaits the already-running readiness instead of
 * starting the clock after app ready. Neither `app.isPackaged` nor
 * `process.resourcesPath` needs the ready event.
 */
function beginServerLaunch(): void {
  if (externalUrl !== undefined || server !== null || readyPromise !== null) return
  const runtime = resolveDshRuntime(
    app.isPackaged ? 'packaged' : 'dev',
    app.isPackaged ? process.resourcesPath : rootDir,
  )
  // Both launch modes run the built CLI; a missing entry means the checkout
  // was not built (or the closure deployment is broken). Fail with the fix.
  const dshEntry = runtime.baseArgs[0]
  if (dshEntry === undefined || !existsSync(dshEntry)) {
    readyPromise = Promise.reject(new Error(`the built dsh CLI is missing at ${String(dshEntry)}; run "pnpm run build" in the checkout first.`))
    readyPromise.catch(() => { /* launch() awaits this same promise and owns the error page */ })
    return
  }
  const handle = startServer(runtime, { port: DEFAULT_PORT, profile: resolveProfile() })
  server = handle
  installExitHooks(handle)
  watchForCrash(handle, (reason) => {
    if (server === handle) server = null
    if (readyPromise !== null) {
      // The awaited promise rejects with the same story; drop the slot so a
      // follow-up launch starts a fresh server instead of re-reading it.
      const spent = readyPromise
      readyPromise = null
      spent.catch(() => { /* the crash page below already carries the reason */ })
    }
    void mainWindow?.loadURL(errorPageUrl({ reason }))
  })
  readyPromise = handle.waitForReady(READY_TIMEOUT_MS)
  readyPromise.catch(() => { /* launch() awaits this same promise and owns the error page */ })
}

/**
 * Navigate the window to the running server's authenticated URL. The
 * token-to-cookie exchange happens in the browser navigation itself; no
 * dsh-side state is touched.
 */
async function launch(): Promise<void> {
  if (launching) return
  launching = true
  try {
    if (externalUrl !== undefined) {
      lastReadyUrl = externalUrl
      await mainWindow?.loadURL(externalUrl)
      return
    }
    if (server === null || readyPromise === null) beginServerLaunch()
    const handle = server
    const pending = readyPromise
    const loadingNavigation = mainWindow?.loadURL(errorPageUrl({ state: 'Starting the dsh web server…' }))
    const url = await (pending ?? Promise.reject(new Error('the dsh server is not starting.')))
    await loadingNavigation
    if (handle === null || server !== handle) {
      // A restart superseded this launch; retire its server.
      await handle?.stop()
      return
    }
    lastReadyUrl = url
    await mainWindow?.loadURL(url)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (mainWindow !== null) await mainWindow.loadURL(errorPageUrl({ reason }))
  } finally {
    launching = false
  }
}

/** Tear down the current server (if any) and start a fresh one. */
async function restart(): Promise<void> {
  const stale = server
  server = null
  readyPromise = null
  if (stale !== null) await stale.stop()
  beginServerLaunch()
  await launch()
}

ipcMain.handle('dsh-status', () => ({ running: server !== null, url: lastReadyUrl }))
ipcMain.handle('dsh-restart', () => { void restart() })

const gotLock = acquireSingleInstance(() => {
  if (mainWindow === null) createWindow()
  else mainWindow.focus()
})
if (!gotLock) {
  app.quit()
} else {
  // The dsh boot is the long pole; start it before Electron builds the
  // window stack so the two initializations overlap.
  beginServerLaunch()
  void app.whenReady().then(() => {
    createWindow()
    void launch()
  })
}

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow()
    void launch()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
