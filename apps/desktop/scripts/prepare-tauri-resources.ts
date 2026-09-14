/**
 * Copy the prepared desktop runtime and the renderer transport into the Tauri
 * resource tree the shell bundles.
 *
 * Run after `prepare:runtime` and `prepare:dsh`: those materialize the upstream
 * Node.js executable and the installed dsh closure under the target build root,
 * and this step places them where `supervisor::host_launch` resolves them.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const RESOURCES = join(APP_ROOT, 'src-tauri', 'resources', 'desktop-runtime')
const TRANSPORT_SCRIPT = join(APP_ROOT, 'src-tauri', 'transport', 'desktop-transport.js')

function main(): void {
  const node = join(BUILD_PATHS.runtime, 'node')
  if (!existsSync(node)) {
    throw new Error(`desktop resources: ${node} is missing; run "pnpm --filter @deepseek-ai/dsh-desktop run prepare:runtime" first`)
  }
  if (!existsSync(BUILD_PATHS.dsh)) {
    throw new Error(`desktop resources: ${BUILD_PATHS.dsh} is missing; run "pnpm --filter @deepseek-ai/dsh-desktop run prepare:dsh" first`)
  }
  rmSync(RESOURCES, { recursive: true, force: true })
  mkdirSync(RESOURCES, { recursive: true })
  cpSync(node, join(RESOURCES, 'node'), { recursive: true })
  cpSync(BUILD_PATHS.dsh, join(RESOURCES, 'dsh'), { recursive: true, dereference: true })
  cpSync(TRANSPORT_SCRIPT, join(RESOURCES, 'desktop-transport.js'))
  process.stdout.write(`desktop resources: wrote ${RESOURCES}\n`)
}

main()
