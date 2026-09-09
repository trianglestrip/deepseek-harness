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
/** CLI entry inside the closure, at its checkout-relative location. */
const PACKAGED_DSH_BIN = ['apps', 'cli', 'lib', 'bin.js']

/**
 * Resolve how this distribution launches dsh.
 *
 * Dev runs the checkout's CLI through tsx (the dsh source-launch contract):
 * there `rootDir` is the repository checkout. Packaged runs the dsh runtime
 * deployed as a self-contained extraResource (`pnpm deploy` closure under
 * `<resources>/dsh`, carried outside the asar because the spawned bundled
 * Node is a real OS process that cannot read asar virtual paths); there
 * `rootDir` is Electron's `process.resourcesPath`. Electron's embedded Node
 * does not satisfy the engines range, so `ELECTRON_RUN_AS_NODE` is not an
 * option.
 * @param mode - dev launches the checkout, packaged launches the bundled runtime.
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
      baseArgs: ['--import', 'tsx/esm', join(rootDir, 'apps', 'cli', 'src', 'bin.ts')],
      cwd: rootDir,
      env: {},
    }
  }
  return {
    command: join(rootDir, PACKAGED_RUNTIME_DIR, platform === 'win32' ? 'node.exe' : 'node'),
    baseArgs: [join(rootDir, PACKAGED_DSH_DIR, ...PACKAGED_DSH_BIN)],
    env: {},
  }
}
