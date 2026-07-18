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
    ...createVitestRuntimeOptions('adapters-binary'),
    environment: 'node',
    include: ['../../tests/frontend/unit/adapters/binary/**/*.test.ts', '../../tests/frontend/unit/protocol/**/*.test.ts'],
    setupFiles: [frontendUnitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/adapters-binary',
      include: ['src/adapters/binary/**/*.ts', 'src/api/binaryFrame.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_BINARY_ADAPTERS_LINES ?? 95),
        branches: Number(process.env.FSUSBLOG_FRONTEND_BINARY_ADAPTERS_BRANCHES ?? 90),
        functions: Number(process.env.FSUSBLOG_FRONTEND_BINARY_ADAPTERS_FUNCTIONS ?? 95),
        statements: Number(process.env.FSUSBLOG_FRONTEND_BINARY_ADAPTERS_STATEMENTS ?? 95)
      }
    }
  }
})
