import { defineConfig } from 'tsdown'

/**
 * Two runtime programs this package ships, both spawned by the Tauri shell
 * under the bundled Node.js executable: the shell core, which bundles the
 * upstream parent half (`host-process.ts`) with its own wire codec, and the
 * plugin transactions, which reuse the profile manager the Electron main
 * process drove.
 */
export default defineConfig({
  entry: {
    'shell-core': 'lib/types/shell-core.js',
    'desktop-plugins': 'lib/types/desktop-plugins.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
