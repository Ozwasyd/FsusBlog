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
    ...createVitestRuntimeOptions('bootstrap-hydration'),
    environment: 'node',
    include: ['../../tests/frontend/unit/bootstrap/**/*.test.ts', '../../tests/frontend/unit/public-renderers/**/*.test.ts'],
    setupFiles: [frontendUnitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/bootstrap-hydration',
      include: ['src/bootstrap/**/*.ts', 'src/public-renderers/**/*.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_BOOTSTRAP_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_BOOTSTRAP_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_BOOTSTRAP_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_BOOTSTRAP_STATEMENTS ?? 90)
      }
    }
  }
})
