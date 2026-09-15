import { defineConfig } from 'tsdown'

/**
 * The shell core is the only runtime program this package ships: the Tauri
 * shell spawns it under the bundled Node.js executable, and it bundles the
 * upstream parent half (`host-process.ts`) with the core's own wire codec.
 */
export default defineConfig({
  entry: { 'shell-core': 'lib/types/shell-core.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
