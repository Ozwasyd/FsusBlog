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
    ...createVitestRuntimeOptions('unit-core'),
    environment: 'node',
    include: [
      '../../tests/frontend/unit/utils/**/*.test.ts',
      '../../tests/frontend/unit/composables/**/*.test.ts',
      '../../tests/frontend/unit/services/**/*.test.ts',
      '../../tests/frontend/property/**/*.test.ts',
      '../../tests/frontend/model/**/*.test.ts'
    ],
    setupFiles: [frontendUnitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/unit-core',
      include: ['src/utils/**/*.ts', 'src/composables/**/*.ts', 'src/services/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_UNIT_CORE_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_UNIT_CORE_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_UNIT_CORE_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_UNIT_CORE_STATEMENTS ?? 90)
      }
    }
  }
})
