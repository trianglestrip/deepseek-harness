/**
 * Copy the prepared desktop runtime, the pnpm the plugin transactions run, and
 * the shell programs into the Tauri resource tree the shell bundles.
 *
 * Run after `prepare:runtime` and `prepare:dsh`: those materialize the upstream
 * Node.js executable and the installed dsh closure under the target build root,
 * and this step places them, with the core, where `supervisor::host_launch`
 * resolves them. The renderer transport is not a resource: the shell compiles
 * it into the binary and installs it as a window initialization script.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RESOURCES = join(APP_ROOT, 'src-tauri', 'resources', 'desktop-runtime')
const SHELL_CORE = join(APP_ROOT, 'lib', 'shell-core.js')

function main(): void {
  const node = join(BUILD_PATHS.runtime, 'node')
  if (!existsSync(node)) {
    throw new Error(`desktop resources: ${node} is missing; run "pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime" first`)
  }
  if (!existsSync(BUILD_PATHS.dsh)) {
    throw new Error(`desktop resources: ${BUILD_PATHS.dsh} is missing; run "pnpm --filter @deepseek-ai/dsh-desktop run prepare:dsh" first`)
  }
  if (!existsSync(SHELL_CORE)) {
    throw new Error(`desktop resources: ${SHELL_CORE} is missing; run "pnpm --filter @deepseek-ai/dsh-desktop run build:shell-core" first`)
  }
  rmSync(RESOURCES, { recursive: true, force: true })
  mkdirSync(RESOURCES, { recursive: true })
  cpSync(node, join(RESOURCES, 'node'), { recursive: true })
  // The plugin transactions run pnpm from the same bundled runtime.
  cpSync(join(BUILD_PATHS.runtime, 'pnpm'), join(RESOURCES, 'pnpm'), { recursive: true })
  cpSync(BUILD_PATHS.dsh, join(RESOURCES, 'dsh'), { recursive: true, dereference: true })
  // Every built program ships, so no chunk the bundler emits stays behind.
  for (const file of readdirSync(join(APP_ROOT, 'lib'))) {
    if (file.endsWith('.js')) cpSync(join(APP_ROOT, 'lib', file), join(RESOURCES, file))
  }
  process.stdout.write(`desktop resources: wrote ${RESOURCES}\n`)
}

main()
