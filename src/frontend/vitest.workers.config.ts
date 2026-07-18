import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { createVitestRuntimeOptions, frontendTestDependencyDedupe, frontendUnitSetupFile } from './vitest.shared.mjs'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    dedupe: frontendTestDependencyDedupe,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@wasm': fileURLToPath(new URL('./wasm/web', import.meta.url))
    }
  },
  test: {
    ...createVitestRuntimeOptions('workers'),
    environment: 'node',
    include: [
      '../../tests/frontend/unit/services/binaryTransport.test.ts',
      '../../tests/frontend/unit/workers/**/*.test.ts',
      '../../tests/frontend/property/**/*.test.ts'
    ],
    setupFiles: [frontendUnitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/workers',
      include: ['src/workers/**/*.ts', 'src/services/binaryTransport.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_WORKERS_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_WORKERS_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_WORKERS_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_WORKERS_STATEMENTS ?? 90)
      }
    }
  }
})
