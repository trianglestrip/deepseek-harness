/**
 * Link a development desktop runtime out of the workspace.
 *
 * `tauri dev` reaches the packaged Host only through the resources a build
 * carries, so development runs need the same layout built from the workspace:
 * this creates `.desktop-build/dev-runtime/dsh` (the immutable package closure)
 * and `.desktop-build/dev-runtime/profile` (the desktop profile), both as
 * directory links to the workspace packages. Point the shell at it:
 *
 *   pnpm --filter @deepseek-ai/dsh-desktop run dev:host
 *
 * The tree is disposable: re-run this script after adding or moving packages.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createPluginProfile } from '../src/project-manager.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const OUTPUT = join(APP_ROOT, '.desktop-build', 'dev-runtime')
const RUNTIME = join(OUTPUT, 'dsh')
const PROFILE = join(OUTPUT, 'profile')

interface WorkspacePackage {
  readonly name: string
  readonly directory: string
}

/** Every first-party package the closure and the profile must resolve. */
function workspacePackages(): WorkspacePackage[] {
  const roots: string[] = []
  for (const group of readdirSync(join(REPOSITORY_ROOT, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of readdirSync(join(REPOSITORY_ROOT, 'packages', group.name), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(REPOSITORY_ROOT, 'packages', group.name, entry.name))
    }
  }
  for (const entry of readdirSync(join(REPOSITORY_ROOT, 'vendor'), { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(join(REPOSITORY_ROOT, 'vendor', entry.name))
  }
  roots.push(join(REPOSITORY_ROOT, 'apps', 'cli'), join(REPOSITORY_ROOT, 'apps', 'web'), join(REPOSITORY_ROOT, 'apps', 'desktop-host'))
  const packages: WorkspacePackage[] = []
  for (const directory of roots) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: string }
      if (typeof manifest.name === 'string') packages.push({ name: manifest.name, directory })
    } catch {
      // A directory without a manifest is not a package.
    }
  }
  return packages
}

/** Link every workspace package into one `node_modules` directory. */
function linkPackages(modules: string, packages: readonly WorkspacePackage[], backend: 'junction' | 'dir'): void {
  for (const entry of packages) {
    const target = join(modules, ...entry.name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) continue
    symlinkSync(entry.directory, target, backend)
  }
}

function main(): void {
  const packages = workspacePackages()
  const backend = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    rmSync(OUTPUT, { recursive: true, force: true })
  } catch (error) {
    // Windows refuses to remove a directory a running Host still holds as its
    // working directory; the links below are idempotent, so reuse the tree.
    process.stderr.write(`desktop dev runtime: reusing the existing tree (${String(error)})\n`)
  }
  mkdirSync(RUNTIME, { recursive: true })
  writeFileSync(join(RUNTIME, 'package.json'), `${JSON.stringify({ name: 'dsh-desktop-dev-runtime', private: true }, undefined, 2)}\n`)
  linkPackages(join(RUNTIME, 'node_modules'), packages, backend)
  mkdirSync(PROFILE, { recursive: true })
  // The profile manifest is the manager's own bootstrap shape, so the plugin
  // transactions accept the linked development profile too.
  createPluginProfile(PROFILE)
  linkPackages(join(PROFILE, 'node_modules'), packages, backend)
  process.stdout.write(`desktop dev runtime: linked ${String(packages.length)} packages into ${OUTPUT}\n`)
}

main()
