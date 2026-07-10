import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { createVitestRuntimeOptions } from './vitest.shared.mjs'

const unitSetupFile = fileURLToPath(new URL('./tests/frontend/unit/setup.ts', import.meta.url))

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@wasm': fileURLToPath(new URL('./wasm/web', import.meta.url))
    }
  },
  test: {
    ...createVitestRuntimeOptions('perf'),
    environment: 'node',
    include: ['../../tests/frontend/benchmarks/**/*.test.ts'],
    setupFiles: [unitSetupFile],
    testTimeout: 15000
  }
})
