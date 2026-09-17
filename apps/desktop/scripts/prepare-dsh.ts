/** Materialize the complete production runtime before publishing Desktop resources. */

import { spawn, execFile } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { createRuntimeProjectMetadata } from '../src/project-manager.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease, type DesktopRelease } from '../src/release.ts'
import {
  DESKTOP_HOST_PACKAGE,
  DESKTOP_HOST_RUNTIME_FILES,
  DESKTOP_PACKAGES_DIR,
  DESKTOP_PACKAGE_SET_FILE,
  readDesktopCorePackageSet,
  verifyDesktopCoreLockfile,
} from '../src/core-package-set.ts'
import { smokeDesktopRuntime } from './smoke-runtime.ts'
import { writeDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import {
  resolveDesktopAppId,
  resolveMacOSSigningEnvironment,
} from './desktop-release-environment.mjs'
import {
  signMacOSRuntime,
} from './macos-runtime.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { desktopRuntimeFileExclusion } from './runtime-file-policy.ts'

const APP_ROOT = resolve(import.meta.dirname, '..')
const BUILD_PATHS = resolveDesktopTargetBuildPaths()
const DSH_OUTPUT_ROOT = BUILD_PATHS.dsh
const BUILD_ROOT = mkdtempSync(join(tmpdir(), 'dsh-desktop-runtime-'))
const STORE_ROOT = join(BUILD_ROOT, 'store')
const RUNTIME_ROOT = BUILD_PATHS.runtime
const PNPM_BUILD_STATE = BUILD_PATHS.dshPnpm
const PACKAGE_SET_ROOT = BUILD_PATHS.packageSet
const NODE = join(RUNTIME_ROOT, 'node', process.platform === 'win32' ? 'node.exe' : 'node')
const PNPM = join(RUNTIME_ROOT, 'pnpm', 'bin', 'pnpm.mjs')

function manifestVersion(path: string, subject: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error(`desktop runtime: ${subject} has no version`)
  return manifest.version
}

/**
 * Copy a product's own in-box bundles and agent presets into the runtime.
 *
 * A build that ships extra bundles names them in `DESKTOP_PROFILE_BUNDLES`, and a
 * profile resolves those names from the runtime's own `node_modules` — the same
 * place `dsh-base` comes from. Presets land where the Desktop Host looks for the
 * deployment's presets. Both directories are optional, so an upstream build that
 * sets neither env var produces the stock runtime.
 * @returns the package names staged as in-box bundles, for the runtime descriptor.
 */
function copyProductBundles(): readonly string[] {
  const staged: string[] = []
  const bundles = process.env.DSH_DESKTOP_EXTRA_BUNDLES
  if (bundles !== undefined && bundles !== '') {
    for (const entry of readdirSync(bundles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = join(bundles, entry.name)
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name?: unknown }
      if (typeof manifest.name !== 'string' || manifest.name === '') {
        throw new Error(`desktop runtime: extra bundle ${entry.name} declares no package name`)
      }
      cpSync(source, join(DSH_OUTPUT_ROOT, 'node_modules', manifest.name), { recursive: true, dereference: true })
      staged.push(manifest.name)
    }
  }
  const presets = process.env.DSH_DESKTOP_EXTRA_PRESETS
  if (presets !== undefined && presets !== '') {
    // Where the Desktop Host looks for the deployment's own presets: it derives
    // that root from the installed dsh PACKAGE directory (see
    // `desktopComposition()` in apps/desktop-host/src/index.ts), not from the
    // runtime root, so a preset placed at `<runtime>/config` is never scanned.
    const presetRoot = join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets')
    mkdirSync(presetRoot, { recursive: true })
    for (const entry of readdirSync(presets, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      cpSync(join(presets, entry.name), join(presetRoot, entry.name), { recursive: true })
    }
  }
  return staged
}

/**
 * Blank the shipped presets' persona prefix so a deployment's own prompt carries
 * the identity.
 *
 * Every preset mounts `@deepseek-ai/dsh-persona`, whose prefix is a scoped
 * persona that shadows the deployment slot — so a deployment that supplies the
 * identity as prompt sections still gets `You are a coding agent powered by …`
 * in front of them. Emptying the prefix (and leaving the working-directory suffix
 * alone) makes the mode a workflow choice again, not a second identity.
 *
 * Line surgery, not a YAML round trip: these files carry `!!js` tags and comments
 * that dumping would destroy.
 */
function blankPresetPersonaPrefixes(): void {
  if (process.env.DSH_DESKTOP_CLEAR_PRESET_PERSONA !== '1') return
  const presetsRoot = join(DSH_OUTPUT_ROOT, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
  if (!existsSync(presetsRoot)) return
  for (const entry of readdirSync(presetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(presetsRoot, entry.name, 'agent.cordis.yml')
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    const rowAt = lines.findIndex((line) => /^\s*-\s*id:\s*persona\s*$/.test(line))
    if (rowAt === -1) continue
    const nextRow = lines.findIndex((line, index) => index > rowAt && /^\s*-\s/.test(line))
    const rowEnd = nextRow === -1 ? lines.length : nextRow
    const prefixAt = lines.findIndex((line, index) => index > rowAt && index < rowEnd && /^(\s*)prefix:\s*/.test(line))
    if (prefixAt === -1) continue
    const prefixLine = lines[prefixAt] ?? ''
    const indent = /^(\s*)/.exec(prefixLine)?.[1] ?? ''
    let stop = prefixAt + 1
    while (stop < rowEnd) {
      const candidate = lines[stop] ?? ''
      if (candidate.trim() !== '' && (/^(\s*)/.exec(candidate)?.[1] ?? '').length <= indent.length) break
      stop += 1
    }
    lines.splice(prefixAt, stop - prefixAt, `${indent}prefix: ''`)
    writeFileSync(file, lines.join('\n'))
    console.log(`desktop runtime: cleared the persona prefix in ${entry.name}`)
  }
}

function desktopRelease(): DesktopRelease {
  const version = manifestVersion(join(APP_ROOT, 'package.json'), 'desktop package')
  const dshVersion = manifestVersion(resolve(APP_ROOT, '..', '..', 'package.json'), 'root dsh package')
  if (version !== dshVersion) {
    throw new Error(`desktop runtime: Electron ${version} must bind the same version of @deepseek-ai/dsh, found ${dshVersion}`)
  }
  const runtime = JSON.parse(readFileSync(join(RUNTIME_ROOT, 'versions.json'), 'utf8')) as Record<string, unknown>
  return parseDesktopRelease({
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: runtime.node,
    pnpmVersion: runtime.pnpm,
  })
}

function runPnpm(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop runtime: pnpm command is required')
    const config = join(PNPM_BUILD_STATE, 'config')
    const userConfig = join(config, 'npmrc')
    mkdirSync(config, { recursive: true })
    writeFileSync(userConfig, '')
    const child = spawn(NODE, [
      PNPM,
      '--config.registry=https://registry.npmjs.org/',
      `--config.store-dir=${STORE_ROOT}`,
      '--config.enable-global-virtual-store=false',
      `--config.userconfig=${userConfig}`,
      command,
      ...commandArgs,
    ], {
      cwd: BUILD_ROOT,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => (
          name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name) && !/^(?:npm|pnpm|corepack)_/iu.test(name)
        ))),
        NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
        NPM_CONFIG_STORE_DIR: STORE_ROOT,
        NPM_CONFIG_USERCONFIG: userConfig,
        PATH: `${dirname(NODE)}${delimiter}${process.env.PATH ?? ''}`,
        XDG_CACHE_HOME: join(PNPM_BUILD_STATE, 'cache'),
        XDG_CONFIG_HOME: config,
        XDG_STATE_HOME: join(PNPM_BUILD_STATE, 'state'),
      },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`desktop runtime: pnpm exited with ${String(code ?? signal)}`))
    })
  })
}

async function main(): Promise<void> {
  rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
  rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  mkdirSync(STORE_ROOT, { recursive: true })
  try {
    const release = desktopRelease()
    copyFileSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGE_SET_FILE), join(BUILD_ROOT, DESKTOP_PACKAGE_SET_FILE))
    cpSync(join(PACKAGE_SET_ROOT, DESKTOP_PACKAGES_DIR), join(BUILD_ROOT, DESKTOP_PACKAGES_DIR), { recursive: true })
    createRuntimeProjectMetadata(BUILD_ROOT, release)
    await runPnpm(['install', '--lockfile-only'])
    verifyDesktopCoreLockfile(
      readFileSync(join(BUILD_ROOT, 'pnpm-lock.yaml'), 'utf8'),
      readDesktopCorePackageSet(BUILD_ROOT, release.version),
    )
    await runPnpm(['install', '--prod', '--frozen-lockfile', '--trust-lockfile'])
    const packageSet = readDesktopCorePackageSet(BUILD_ROOT, release.version)
    const targetName = resolveDesktopBuildTarget()
    const target = { platform: process.platform, arch: targetName.endsWith('arm64') ? 'arm64' : 'x64' }
    const modules = join(BUILD_ROOT, 'node_modules')
    mkdirSync(DSH_OUTPUT_ROOT, { recursive: true })
    cpSync(modules, join(DSH_OUTPUT_ROOT, 'node_modules'), {
      recursive: true, dereference: true,
      filter: source => desktopRuntimeFileExclusion(relative(modules, source), target) === undefined,
    })
    writeFileSync(join(DSH_OUTPUT_ROOT, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: release.version, type: 'module',
      dependencies: Object.fromEntries(packageSet.packages.map(entry => [entry.name, entry.version])),
    }, undefined, 2)}\n`)
    for (const file of DESKTOP_HOST_RUNTIME_FILES) {
      if (!existsSync(join(DSH_OUTPUT_ROOT, 'node_modules', DESKTOP_HOST_PACKAGE, file))) {
        throw new Error(`desktop runtime: missing private Host file ${file}`)
      }
    }
    if (process.platform === 'darwin') {
      await signMacOSRuntime(DSH_OUTPUT_ROOT, resolveDesktopAppId(process.env), resolveMacOSSigningEnvironment(process.env))
    }
    const productBundles = copyProductBundles()
    blankPresetPersonaPrefixes()
    writeDesktopRuntime(DSH_OUTPUT_ROOT, release, packageSet.packages.map(entry => entry.name), target, productBundles)
    const descriptor = await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
    await new Promise<void>((accept, reject) => {
      execFile(NODE, [join(APP_ROOT, 'tests/fixtures/runtime-payload-smoke.mjs'), DSH_OUTPUT_ROOT],
        { timeout: 120_000, env: { ...process.env, NODE_OPTIONS: '' } }, (error, stdout, stderr) => {
          if (error !== null) reject(new Error(`desktop native payload smoke failed: ${stderr}`, { cause: error }))
          else { process.stdout.write(stdout); accept() }
        })
    })
    await smokeDesktopRuntime(DSH_OUTPUT_ROOT, NODE, descriptor)
    await verifyDesktopRuntime(DSH_OUTPUT_ROOT, release.version, target)
  } catch (error) {
    rmSync(DSH_OUTPUT_ROOT, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(BUILD_ROOT, { recursive: true, force: true })
    rmSync(PNPM_BUILD_STATE, { recursive: true, force: true })
  }
}

await main()
