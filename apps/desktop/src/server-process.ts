import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { DshRuntime } from './dsh-runtime'

/** How the supervised dsh process ended. */
export interface ServerExitInfo {
  code: number | null
  /** true when the shell itself requested the stop; false is a crash. */
  expected: boolean
}

/** One supervised dsh web server. */
export interface ServerHandle {
  /**
   * Wait until the server announces readiness.
   * @param timeoutMs - reject if the readiness line has not arrived by then.
   * @returns the authenticated web URL printed by dsh (carries `?token=`).
   */
  waitForReady(timeoutMs: number): Promise<string>
  /** Register a listener for the process end; survives multiple launches. */
  onExit(listener: (info: ServerExitInfo) => void): void
  /** Terminate the whole dsh process tree and resolve once it is gone. */
  stop(): Promise<void>
}

export interface StartServerOptions {
  /** Port passed to `--port`; 0 lets the OS pick a free one. */
  port: number
  /** Named profile under `$DSH_HOME/profiles` to boot. */
  profile: string
}

/** The readiness line dsh web prints once the server can serve (web-app's supervisor signal). */
const LAUNCH_LINE_PREFIX = 'dsh web: '
/** Retained stderr characters reported when readiness fails. */
const STDERR_TAIL_CHARS = 4000
/** POSIX group-kill grace before escalating to SIGKILL. */
const POSIX_KILL_GRACE_MS = 3000

/**
 * Parse one dsh stdout line into the readiness URL. The announce line is
 * `dsh web: <authenticatedUrl>` optionally followed by ` (LAN: <url>)`; the
 * companion line `dsh web: opening the default browser…` shares the prefix
 * and must not parse.
 * @param line - one decoded stdout line.
 * @returns the printed URL, or null for any non-URL line.
 */
export function parseLaunchLine(line: string): URL | null {
  if (!line.startsWith(LAUNCH_LINE_PREFIX)) return null
  const firstToken = line.slice(LAUNCH_LINE_PREFIX.length).trim().split(/\s/u)[0]
  if (firstToken === '') return null
  try {
    const url = new URL(firstToken)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * Build the Windows process-tree kill invocation. Returns null on POSIX where
 * the detached child leads its own process group and a group signal suffices.
 * @param pid - the dsh process id.
 * @param platform - host platform; injected so callers stay pure.
 * @returns taskkill arguments on win32, null elsewhere.
 */
export function buildTreeKillArgs(
  pid: number,
  platform: NodeJS.Platform,
): { command: string; args: string[] } | null {
  if (platform === 'win32') return { command: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
  return null
}

/**
 * Spawn one dsh web server as a direct child (no shell) and supervise it.
 * The process starts detached on POSIX so it leads its own process group,
 * which makes the group signal a tree kill; Windows walks the tree through
 * taskkill instead.
 * @param runtime - launch triple from {@link resolveDshRuntime}.
 * @param options - port selection; the real port arrives on the readiness line.
 * @returns the handle for readiness, exit, and teardown.
 */
export function startServer(runtime: DshRuntime, options: StartServerOptions): ServerHandle {
  const child = spawn(runtime.command, [...runtime.baseArgs, '--profile', options.profile, '--no-open', '--port', String(options.port)], {
    cwd: runtime.cwd,
    env: { ...process.env, ...runtime.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
  })

  const exitListeners: Array<(info: ServerExitInfo) => void> = []
  let expectedStop = false
  let announced = false
  let stderrTail = ''

  const notifyExit = (code: number | null): void => {
    for (const listener of exitListeners) listener({ code, expected: expectedStop })
  }
  child.once('exit', (code) => { notifyExit(code) })
  child.once('error', () => { notifyExit(null) })

  const readyPromise = new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    const settle = (settlement: (resolveOutside: (url: string) => void, rejectOutside: (error: Error) => void) => void): void => {
      lines.close()
      settlement(resolve, reject)
    }
    lines.on('line', (line: string) => {
      const url = parseLaunchLine(line)
      // Only the authenticated announce URL carries the exchange token; a
      // token-less http line is not the supervisor signal.
      if (url === null || url.searchParams.get('token') === null || announced) return
      announced = true
      settle((resolveOutside) => { resolveOutside(url.href) })
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    child.once('exit', (code) => {
      if (announced) return
      settle((_r, rejectOutside) => {
        rejectOutside(new Error(`dsh web exited with code ${String(code)} before readiness; stderr tail: ${stderrTail.trim()}`))
      })
    })
    child.once('error', (error: Error) => {
      if (announced) return
      settle((_r, rejectOutside) => { rejectOutside(error) })
    })
  })

  return {
    waitForReady(timeoutMs: number): Promise<string> {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`dsh web did not report readiness within ${String(timeoutMs)}ms; stderr tail: ${stderrTail.trim()}`))
        }, timeoutMs)
      })
      return Promise.race([readyPromise, timeout]).finally(() => { clearTimeout(timer) })
    },
    onExit(listener: (info: ServerExitInfo) => void): void {
      exitListeners.push(listener)
    },
    async stop(): Promise<void> {
      expectedStop = true
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
      const killArgs = buildTreeKillArgs(child.pid, process.platform)
      if (killArgs !== null) {
        await new Promise<void>((resolve) => {
          const killer = spawn(killArgs.command, killArgs.args, { stdio: 'ignore', windowsHide: true })
          killer.once('exit', () => { resolve() })
          killer.once('error', () => { resolve() })
        })
      } else {
        signalProcessGroup(child.pid, 'SIGTERM')
      }
      const graceful = new Promise<'grace'>((resolve) => { const t = setTimeout(() => { resolve('grace') }, POSIX_KILL_GRACE_MS); t.unref() })
      const outcome = await Promise.race([exited.then(() => 'exited' as const), graceful])
      if (outcome === 'grace') {
        // The group ignored SIGTERM within the grace window; escalate.
        signalProcessGroup(child.pid, 'SIGKILL')
      }
      await exited
    },
  }
}

/**
 * Signal the detached child's whole process group; a killed group member is
 * not an error for teardown.
 * @param pid - the group leader's pid.
 * @param signal - the signal to deliver.
 */
function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* the group is already gone; nothing left to signal */
  }
}
