import { app, BrowserWindow, Menu, ipcMain } from 'electron'
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
 * Attach mode for development: load an already-running dsh web URL instead of
 * spawning one. Set DSH_DESKTOP_URL=http://127.0.0.1:3080/?token=… to iterate
 * on dsh without restarting the shell.
 */
const externalUrl = process.env.DSH_DESKTOP_URL

let mainWindow: BrowserWindow | null = null
let server: ServerHandle | null = null
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
 * Start one supervised dsh web server and navigate the window to its
 * authenticated URL. The token-to-cookie exchange happens in the browser
 * navigation itself; no dsh-side state is touched.
 */
async function launch(): Promise<void> {
  if (launching || server !== null) return
  launching = true
  try {
    if (externalUrl !== undefined) {
      lastReadyUrl = externalUrl
      await mainWindow?.loadURL(externalUrl)
      return
    }
    await mainWindow?.loadURL(errorPageUrl({ state: 'Starting the dsh web server…' }))
    // Dev resolves the checkout CLI from the repository root; packaged
    // resolves the deployed dsh closure and bundled Node from the
    // Electron resources root.
    const runtime = resolveDshRuntime(
      app.isPackaged ? 'packaged' : 'dev',
      app.isPackaged ? process.resourcesPath : rootDir,
    )
    const handle = startServer(runtime, { port: DEFAULT_PORT })
    server = handle
    installExitHooks(handle)
    watchForCrash(handle, (reason) => {
      server = null
      void mainWindow?.loadURL(errorPageUrl({ reason }))
    })
    const url = await handle.waitForReady(READY_TIMEOUT_MS)
    if (server !== handle) {
      // A restart superseded this launch; retire its server.
      await handle.stop()
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
  if (stale !== null) await stale.stop()
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
