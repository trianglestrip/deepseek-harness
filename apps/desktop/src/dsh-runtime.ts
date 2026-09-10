import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which dsh distribution the shell supervises. */
export type DshRuntimeMode = 'dev' | 'packaged'

/** The executable, argument prefix, and environment for one dsh launch. */
export interface DshRuntime {
  /** Executable to spawn directly; never a shell and never the Electron binary. */
  command: string
  /** Arguments that precede the profile arguments. */
  baseArgs: string[]
  /** Working directory for the dsh process; undefined inherits the shell's cwd. */
  cwd?: string
  /** Environment layered over the parent environment (credentials inherit as-is). */
  env: NodeJS.ProcessEnv
}

/** Directory under the packaged resources root carrying the bundled Node runtime. */
const PACKAGED_RUNTIME_DIR = 'runtime'
/** Directory under the packaged resources root carrying the deployed dsh closure. */
const PACKAGED_DSH_DIR = 'dsh'
/** CLI entry of the checkout (built), and inside the packaged closure. */
const DSH_BIN = ['apps', 'cli', 'lib', 'bin.js']

/**
 * Resolve the Harness home the shell and dsh share. Mirrors
 * `resolveDshHome` precedence (explicit `$DSH_HOME`, then `~/.dsh`) without
 * importing the dsh package — the shell stays a standalone Electron app.
 */
export function resolveDshHomePath(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Environment layered over the parent for every dsh launch. `NODE_COMPILE_CACHE`
 * persists V8's ESM parse/compile output under the Harness home, so the
 * ~146-plugin module graph (the measured ~66% of boot) is loaded from
 * bytecode instead of being re-parsed on every process start; the cache is
 * keyed by file content and invalidates itself across rebuilds.
 */
export function compileCacheEnv(): NodeJS.ProcessEnv {
  return { NODE_COMPILE_CACHE: join(resolveDshHomePath(), 'compile-cache') }
}

/**
 * Resolve how this distribution launches dsh.
 *
 * Both modes run the BUILT CLI (`apps/cli/lib/bin.js`) under plain Node: the
 * tsx source-launch hook re-transforms hundreds of modules on every boot and
 * costs ~45s on this tree, while the built closure boots in ~11s. A dev
 * checkout must run `pnpm run build` before the shell can start; the shell
 * surfaces a loud error page when the entry is missing. Packaged runs the dsh
 * runtime deployed as a self-contained extraResource (link-graph closure
 * under `<resources>/dsh`, carried outside the asar because the spawned
 * bundled Node is a real OS process that cannot read asar virtual paths);
 * there `rootDir` is Electron's `process.resourcesPath`. Electron's embedded
 * Node does not satisfy the engines range, so `ELECTRON_RUN_AS_NODE` is not
 * an option.
 * @param mode - dev launches the checkout closure, packaged launches the bundled runtime.
 * @param rootDir - dev: the repository checkout root; packaged: the Electron resources root.
 * @param platform - host platform; defaults to the running process.
 * @returns the launch triple for {@link startServer}.
 */
export function resolveDshRuntime(
  mode: DshRuntimeMode,
  rootDir: string,
  platform: NodeJS.Platform = process.platform,
): DshRuntime {
  if (mode === 'dev') {
    return {
      command: 'node',
      baseArgs: [join(rootDir, ...DSH_BIN)],
      cwd: rootDir,
      env: compileCacheEnv(),
    }
  }
  return {
    command: join(rootDir, PACKAGED_RUNTIME_DIR, platform === 'win32' ? 'node.exe' : 'node'),
    baseArgs: [join(rootDir, PACKAGED_DSH_DIR, ...DSH_BIN)],
    env: compileCacheEnv(),
  }
}
