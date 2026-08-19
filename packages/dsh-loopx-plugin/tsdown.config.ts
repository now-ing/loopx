import { defineConfig } from 'tsdown'

/** Build the four DSH plugin faces plus the package service entry as Node ESM. */
export default defineConfig({
  entry: [
    'build-temp/index.js',
    'build-temp/service.js',
    'build-temp/command.js',
    'build-temp/tools.js',
    'build-temp/driver.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: false,
})
