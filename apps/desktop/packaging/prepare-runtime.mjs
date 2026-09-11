// Assembles the packaged runtime inputs electron-builder carries as
// extraResources (see electron-builder.yml):
// - runtime/: the standalone Node binary. Electron's embedded Node does not
//   satisfy the dsh engines range, so the packaged shell spawns this one.
// - dsh-runtime/: the dsh production closure. Built by walking the workspace
//   link graph from apps/cli: pnpm resolves workspace packages as relative
//   links into the checkout and external packages as relative links into
//   node_modules/.pnpm, so copying every reachable unit while preserving
//   links yields a self-contained tree whose resolution is identical to the
//   checkout's. `pnpm deploy` is not usable here: its legacy output drops
//   transitive .pnpm entries for a workspace of this size. Unit traversal
//   follows the manifest's production dependencies (dependencies,
//   peerDependencies, optionalDependencies) so development-only links inside
//   workspace package node_modules are not pulled in; .pnpm hash units carry
//   only production+peer links by construction and are collected whole.
//   Vendor-link overrides (vendor/cosmokit, vendor/schemastery, …) are
//   reachable units like any other, which keeps their package-node_modules
//   dependencies resolvable inside the closure.
// Download sources fall back so packaging stays reproducible on restricted
// networks: the npmmirror binary mirror first, nodejs.org second.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagingDir = fileURLToPath(new URL('.', import.meta.url))
const NODE_VERSION = process.env.DSH_DESKTOP_NODE_VERSION ?? '22.22.0'

const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const platformDirs = { win32: `win-${arch}`, darwin: `darwin-${arch}`, linux: `linux-${arch}` }
const platformDir = platformDirs[process.platform]
if (platformDir === undefined) {
  console.error(`prepare-runtime: unsupported platform ${process.platform}`)
  process.exit(1)
}
const binaryName = process.platform === 'win32' ? 'node.exe' : 'node'

// --- bundled Node runtime -------------------------------------------------
const runtimeDir = join(packagingDir, 'runtime')
if (existsSync(join(runtimeDir, binaryName))) {
  console.log('prepare-runtime: node runtime already staged; skipping download')
} else {
const remotePath = `v${NODE_VERSION}/${platformDir}/${binaryName}`
const sources = [
  `https://registry.npmmirror.com/-/binary/node/${remotePath}`,
  `https://nodejs.org/dist/${remotePath}`,
]
for (const source of sources) {
  try {
    const response = await fetch(source, { redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, binaryName), bytes)
    if (process.platform !== 'win32') chmodSync(join(runtimeDir, binaryName), 0o755)
    console.log(`prepare-runtime: node ${NODE_VERSION} (${String(bytes.length)} bytes) from ${new URL(source).host}`)
    break
  } catch (error) {
    console.warn(`prepare-runtime: ${source} failed: ${error instanceof Error ? error.message : String(error)}`)
    if (source === sources[sources.length - 1]) {
      console.error('prepare-runtime: all download sources failed')
      process.exit(1)
    }
  }
}
}

// --- deployed dsh closure -------------------------------------------------
const repoRoot = realpathSync(join(packagingDir, '..', '..', '..'))
const repoPrefix = repoRoot + sep
if (!existsSync(join(repoRoot, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.error('prepare-runtime: apps/cli/lib/bin.js is missing; run the workspace build first')
  process.exit(1)
}

const closureDir = join(packagingDir, 'dsh-runtime')
rmSync(closureDir, { recursive: true, force: true })
mkdirSync(closureDir, { recursive: true })

// Entry units: the CLI itself plus the config-tree resources its manifest
// mounts from outside the dependency graph (apps/cli dsh.configTrees).
const queue = [
  join(repoRoot, 'apps', 'cli'),
  join(repoRoot, 'packages', 'preset', 'agent-presets'),
]
const copiedUnits = new Set()

/** Unit-top-level src/tests are build inputs the runtime never reads. */
function isUnitTopLevelBuildDir(source, unit) {
  const rel = relative(unit, source)
  if (rel === '' || rel.startsWith('..')) return false
  const top = rel.split(sep)[0]
  return top === 'src' || top === 'tests'
}

/**
 * Map a realpath inside the checkout to the copyable unit directory that
 * carries it: a .pnpm hash dir for external packages, a vendor package for
 * link overrides, one workspace package otherwise. Returns null for paths
 * outside every unit form.
 */
function classifyUnit(real) {
  const rel = relative(repoRoot, real)
  const segments = rel.split(sep)
  if (segments[0] === 'node_modules' && segments[1] === '.pnpm') {
    return join(repoRoot, 'node_modules', '.pnpm', segments[2])
  }
  if (segments[0] === 'vendor' && segments[1] !== undefined) {
    return join(repoRoot, 'vendor', segments[1])
  }
  if (segments[0] === 'packages' && segments[2] !== undefined) {
    return join(repoRoot, 'packages', segments[1], segments[2])
  }
  if (segments[0] === 'apps' && segments[1] !== undefined) {
    return join(repoRoot, 'apps', segments[1])
  }
  if (segments[0] === 'native' && segments[2] === 'packages' && segments[3] !== undefined) {
    return join(repoRoot, 'native', segments[1], 'packages', segments[3])
  }
  // Top-level node_modules entries outside .pnpm are copied as themselves.
  if (segments[0] === 'node_modules' && segments[2] !== undefined) {
    const scopeWidth = segments[1].startsWith('@') ? 2 : 1
    return join(repoRoot, 'node_modules', ...segments.slice(1, 1 + scopeWidth))
  }
  return null
}

/**
 * The production dependency links of one unit: every link under its
 * node_modules when no manifest bounds it (.pnpm hash dirs), otherwise the
 * links whose package name the manifest declares for runtime — dependencies,
 * peerDependencies, and optionalDependencies; development-only links stay
 * out of the closure.
 */
function dependencyLinks(unit) {
  const nodeModules = join(unit, 'node_modules')
  if (!existsSync(nodeModules)) return []
  const manifestPath = join(unit, 'package.json')
  let allowed = null
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    allowed = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
  }
  const links = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === '@') continue
    if (entry.name.startsWith('@')) {
      const scoped = join(nodeModules, entry.name)
      for (const sub of readdirSync(scoped, { withFileTypes: true })) {
        considerLink(join(scoped, sub.name), `${entry.name}/${sub.name}`)
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      considerLink(join(nodeModules, entry.name), entry.name)
    }
  }
  return links

  function considerLink(path, name) {
    if (allowed !== null && !allowed.has(name)) return
    let isLink = false
    try {
      isLink = lstatSync(path).isSymbolicLink()
    } catch {
      return
    }
    if (isLink) links.push(path)
  }
}

while (queue.length > 0) {
  const unit = queue.pop()
  if (copiedUnits.has(unit)) continue
  copiedUnits.add(unit)
  cpSync(unit, join(closureDir, relative(repoRoot, unit)), {
    recursive: true,
    // Unit-top-level src/tests are build inputs the runtime never reads;
    // every file in the closure is a file the OS may scan at spawn time.
    filter: (source) => !isUnitTopLevelBuildDir(source, unit),
  })
  for (const link of dependencyLinks(unit)) {
    const linkDestination = join(closureDir, relative(repoRoot, link))
    let real
    try {
      real = realpathSync(link)
    } catch {
      console.error(`prepare-runtime: dead link in the checkout at ${link}`)
      process.exit(1)
    }
    if (!real.startsWith(repoPrefix)) {
      // Outside the checkout: replace the link with the real content.
      rmSync(linkDestination)
      cpSync(real, linkDestination, { recursive: true, dereference: true })
      continue
    }
    const targetUnit = classifyUnit(real)
    if (targetUnit === null) {
      console.error(`prepare-runtime: link ${link} resolves to an unclassifiable path ${real}`)
      process.exit(1)
    }
    if (!copiedUnits.has(targetUnit)) queue.push(targetUnit)
  }
}

// Integrity: the closure must contain no dangling links; every link must
// resolve inside the closure, mirroring checkout resolution.
let linkCount = 0
function* walkAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) yield full
    else if (entry.isDirectory()) yield* walkAll(full)
  }
}
for (const link of walkAll(closureDir)) {
  linkCount += 1
  if (!existsSync(link)) {
    console.error(`prepare-runtime: dangling link in the closure at ${link}`)
    process.exit(1)
  }
}
if (!existsSync(join(closureDir, 'apps', 'cli', 'lib', 'bin.js'))) {
  console.error('prepare-runtime: closure has no apps/cli/lib/bin.js')
  process.exit(1)
}
console.log(`prepare-runtime: dsh closure staged at ${closureDir} (${String(copiedUnits.size)} units, ${String(linkCount)} links)`)
