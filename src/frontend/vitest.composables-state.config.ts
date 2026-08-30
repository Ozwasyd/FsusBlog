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
    ...createVitestRuntimeOptions('composables-state'),
    environment: 'node',
    include: ['../../tests/frontend/unit/composables/**/*.test.ts'],
    setupFiles: [frontendUnitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/composables-state',
      include: ['src/composables/**/*.ts', 'src/store/**/*.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_COMPOSABLES_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_COMPOSABLES_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_COMPOSABLES_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_COMPOSABLES_STATEMENTS ?? 90)
      }
    }
  }
})
