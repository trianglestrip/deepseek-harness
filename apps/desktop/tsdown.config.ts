import { defineConfig } from 'tsdown'

/**
 * Two runtime programs this package ships, both spawned by the Tauri shell
 * under the bundled Node.js executable: the shell core, which bundles the
 * upstream parent half (`host-process.ts`) with its own wire codec, and the
 * plugin transactions, which reuse the profile manager the Electron main
 * process drove.
 *
 * Each entry builds on its own, so neither program depends on a shared chunk
 * that the resource tree would have to carry as well.
 */
const shared = {
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

export default defineConfig([
  { ...shared, entry: { 'shell-core': 'lib/types/shell-core.js' } },
  { ...shared, entry: { 'desktop-plugins': 'lib/types/desktop-plugins.js' } },
])
