import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

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

/** Directory under the packaged app root that carries the bundled Node runtime. */
const PACKAGED_RUNTIME_DIR = 'runtime'

/**
 * Resolve how this distribution launches dsh.
 *
 * Dev runs the checkout's CLI through tsx (the dsh source-launch contract):
 * there `rootDir` is the repository checkout. Packaged runs the same-version
 * `@deepseek-ai/dsh` bin — declared as this app's dependency, so it resolves
 * from the app's own node_modules — under the Node runtime bundled into
 * `extraResources`; there `rootDir` is the desktop app root. Electron's
 * embedded Node does not satisfy the engines range, so
 * `ELECTRON_RUN_AS_NODE` is not an option.
 * @param mode - dev launches the checkout, packaged launches the bundled runtime.
 * @param rootDir - dev: the repository checkout root; packaged: the desktop app root.
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
    baseArgs: [resolvePackagedDshBin(rootDir)],
    env: {},
  }
}

/**
 * Locate the installed `@deepseek-ai/dsh` bin entry relative to a root.
 * @param rootDir - directory whose package resolution scope carries the dsh package.
 * @returns absolute path of the dsh bin JavaScript entry.
 */
function resolvePackagedDshBin(rootDir: string): string {
  const require = createRequire(join(rootDir, 'package.json'))
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = require(manifestPath) as { bin?: Record<string, string> }
  const entry = manifest.bin?.dsh
  if (entry === undefined) throw new Error('dsh-desktop: @deepseek-ai/dsh declares no dsh bin')
  return join(dirname(manifestPath), entry)
}
