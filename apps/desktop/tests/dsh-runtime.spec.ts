import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveDshRuntime } from '../src/dsh-runtime'

/** This spec lives at apps/desktop/tests/, three levels below the checkout root. */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('resolveDshRuntime', () => {
  it('resolves the dev launcher to the built checkout CLI under plain Node', () => {
    process.env.DSH_HOME = 'H'
    try {
      const runtime = resolveDshRuntime('dev', repoRoot, 'linux')
      expect(runtime.command).toBe('node')
      expect(runtime.baseArgs).toEqual([join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')])
      expect(runtime.cwd).toBe(repoRoot)
      expect(runtime.env).toEqual({ NODE_COMPILE_CACHE: join('H', 'compile-cache') })
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('resolves the packaged launcher to the bundled Node runtime', () => {
    expect(resolveDshRuntime('packaged', 'R', 'win32').command).toBe(join('R', 'runtime', 'node.exe'))
    expect(resolveDshRuntime('packaged', 'R', 'linux').command).toBe(join('R', 'runtime', 'node'))
    expect(resolveDshRuntime('packaged', 'R', 'darwin').command).toBe(join('R', 'runtime', 'node'))
  })

  it('resolves the packaged dsh entry inside the deployed closure', () => {
    expect(resolveDshRuntime('packaged', 'R', 'linux').baseArgs).toEqual([join('R', 'dsh', 'apps', 'cli', 'lib', 'bin.js')])
    expect(resolveDshRuntime('packaged', 'R', 'win32').baseArgs).toEqual([join('R', 'dsh', 'apps', 'cli', 'lib', 'bin.js')])
  })
})
