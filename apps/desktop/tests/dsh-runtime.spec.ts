import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveDshRuntime } from '../src/dsh-runtime'

/** This spec lives at apps/desktop/tests/: one level up is the desktop app root, three the checkout root. */
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(appRoot, '..', '..')

describe('resolveDshRuntime', () => {
  it('resolves the dev checkout launcher through tsx', () => {
    const runtime = resolveDshRuntime('dev', repoRoot, 'linux')
    expect(runtime.command).toBe('node')
    expect(runtime.baseArgs).toEqual(['--import', 'tsx/esm', join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')])
    expect(runtime.cwd).toBe(repoRoot)
    expect(runtime.env).toEqual({})
  })

  it('resolves the packaged launcher to the bundled Node runtime', () => {
    expect(resolveDshRuntime('packaged', appRoot, 'win32').command).toBe(join(appRoot, 'runtime', 'node.exe'))
    expect(resolveDshRuntime('packaged', appRoot, 'linux').command).toBe(join(appRoot, 'runtime', 'node'))
    expect(resolveDshRuntime('packaged', appRoot, 'darwin').command).toBe(join(appRoot, 'runtime', 'node'))
  })

  it('resolves the packaged dsh bin from the app dependency scope', () => {
    const bin = resolveDshRuntime('packaged', appRoot, 'linux').baseArgs[0]
    expect(bin).toBeDefined()
    expect(bin.endsWith(join('lib', 'bin.js'))).toBe(true)
    // The workspace link and the built CLI lib behind it prove the resolution
    // scope is the app's own node_modules — the same layout packaging produces.
    expect(existsSync(bin)).toBe(true)
  })
})
