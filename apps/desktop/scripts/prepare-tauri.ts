/**
 * Prepare the packaged desktop runtime the Tauri shell bundles.
 *
 * The steps are the ones the Electron release orchestrator ran before
 * electron-builder: build the workspace, pack the first-party closures, then
 * materialize the upstream Node.js runtime, the package set, the installed dsh
 * closure, and the Tauri resource tree. Each step is skipped when its output is
 * already present, so an interrupted run resumes instead of repeating the
 * expensive ones.
 *
 * Usage: `pnpm --filter @deepseek-ai/dsh-desktop run prepare:all [-- --skip-build]`
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RESOURCES = join(APP_ROOT, 'src-tauri', 'resources', 'desktop-runtime')

interface Step {
  readonly name: string
  /** Whether the step's output is already present. */
  readonly complete: () => boolean
  readonly run: () => Promise<void>
}

function packedFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(entry => entry.endsWith('.tgz'))
}

/** Run one pnpm invocation in the repository and fail on a non-zero exit. */
function pnpm(args: readonly string[], cwd: string = REPOSITORY_ROOT): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pnpm', [...args], { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop prepare: pnpm ${args.join(' ')} exited with ${String(code)}`))
    })
  })
}

const steps: readonly Step[] = [
  {
    name: 'build the desktop Host package and the shell core',
    complete: () => existsSync(join(REPOSITORY_ROOT, 'apps', 'desktop-host', 'lib', 'index.js'))
      && existsSync(join(APP_ROOT, 'lib', 'shell-core.js')),
    run: async () => {
      await pnpm(['exec', 'tsc', '-b', 'apps/desktop-host'])
      await pnpm(['--dir', 'apps/desktop-host', 'exec', 'tsdown'])
      await pnpm(['--dir', 'apps/desktop', 'run', 'build:shell-core'])
    },
  },
  {
    name: 'pack the dsh closure',
    complete: () => packedFiles(BUILD_PATHS.packedDsh).length > 0,
    run: async () => {
      rmSync(BUILD_PATHS.packedDsh, { recursive: true, force: true })
      await pnpm(['run', 'release:pack', '--family', 'dsh', '--out', BUILD_PATHS.packedDsh, '--concurrency', '4'])
    },
  },
  {
    // The dsh family excludes private packages, so the Host is packed on its own.
    name: 'pack the private Host',
    complete: () => packedFiles(BUILD_PATHS.packedDsh).some(file => file.includes('dsh-desktop-host')),
    run: () => pnpm(['--dir', 'apps/desktop-host', 'pack', '--pack-destination', BUILD_PATHS.packedDsh]),
  },
  {
    name: 'pack the vendored closure',
    complete: () => packedFiles(BUILD_PATHS.packedVendor).length > 0,
    run: () => pnpm(['run', 'release:pack', '--family', 'vendor', '--out', BUILD_PATHS.packedVendor, '--concurrency', '4']),
  },
  {
    name: 'pack the landlock entry',
    complete: () => packedFiles(BUILD_PATHS.packedLandlock).length > 0,
    run: async () => {
      rmSync(BUILD_PATHS.packedLandlock, { recursive: true, force: true })
      await pnpm(['--dir', 'native/system', 'run', 'build:ts'])
      await pnpm(['--dir', 'native/system/packages/entry', 'pack', '--pack-destination', BUILD_PATHS.packedLandlock])
    },
  },
  {
    name: 'materialize the upstream Node.js runtime',
    complete: () => existsSync(join(BUILD_PATHS.runtime, 'node')),
    run: () => pnpm(['run', 'prepare:runtime'], APP_ROOT),
  },
  {
    name: 'prepare the core package set',
    complete: () => existsSync(BUILD_PATHS.packageSet),
    run: () => pnpm(['run', 'prepare:packages'], APP_ROOT),
  },
  {
    name: 'install the dsh closure',
    complete: () => existsSync(BUILD_PATHS.dsh),
    run: () => pnpm(['run', 'prepare:dsh'], APP_ROOT),
  },
  {
    name: 'copy the Tauri resource tree',
    complete: () => existsSync(join(RESOURCES, 'dsh')) && existsSync(join(RESOURCES, 'shell-core.js')),
    run: () => pnpm(['run', 'prepare:resources'], APP_ROOT),
  },
]

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean' } }, allowPositionals: false })
  for (const step of steps) {
    if (values['skip-build'] === true && step.name === 'build the desktop Host package') {
      process.stdout.write('desktop prepare: skipping the Host build on request\n')
      continue
    }
    if (step.complete()) {
      process.stdout.write(`desktop prepare: ${step.name} is already complete\n`)
      continue
    }
    const started = Date.now()
    process.stdout.write(`desktop prepare: ${step.name}\n`)
    await step.run()
    process.stdout.write(`desktop prepare: ${step.name} took ${((Date.now() - started) / 1000).toFixed(0)}s\n`)
  }
  process.stdout.write(`desktop prepare: runtime resources are ready at ${RESOURCES}\n`)
}

await main()
