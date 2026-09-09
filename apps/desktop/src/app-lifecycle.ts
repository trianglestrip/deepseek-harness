import { app } from 'electron'
import type { ServerHandle } from './server-process'

/**
 * Take the single-instance lock so two shells never fight over one dsh home.
 * @param onSecondInstance - invoked when another instance hands over.
 * @returns true when this instance owns the lock; false means another shell
 * is already running and this one must quit.
 */
export function acquireSingleInstance(onSecondInstance?: () => void): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (gotLock && onSecondInstance !== undefined) {
    app.on('second-instance', () => { onSecondInstance() })
  }
  return gotLock
}

/** The server handle the quit hook tears down; re-registration retargets it. */
let exitHookServer: ServerHandle | null = null
let exitHooksInstalled = false

/**
 * Stop the supervised dsh process tree before the Electron process exits.
 * Safe to call once per launch: later calls retarget the teardown at the
 * newest server without stacking quit listeners.
 * @param handle - the server whose tree must not outlive the window.
 */
export function installExitHooks(handle: ServerHandle): void {
  exitHookServer = handle
  if (exitHooksInstalled) return
  exitHooksInstalled = true
  app.on('before-quit', (event) => {
    const server = exitHookServer
    if (server === null) return
    event.preventDefault()
    exitHookServer = null
    void server.stop().finally(() => { app.quit() })
  })
}

/**
 * Surface an unexpected dsh exit to the shell (crash page, restart affordance).
 * @param handle - the supervised server.
 * @param onDown - invoked once per unexpected exit with a human-readable reason.
 */
export function watchForCrash(handle: ServerHandle, onDown: (reason: string) => void): void {
  handle.onExit((info) => {
    if (info.expected) return
    onDown(`dsh exited unexpectedly with code ${String(info.code)}.`)
  })
}
