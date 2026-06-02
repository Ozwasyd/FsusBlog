import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

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
    environment: 'node',
    include: ['../../tests/frontend/unit/adapters/binary/**/*.test.ts', '../../tests/frontend/unit/protocol/**/*.test.ts'],
    setupFiles: [unitSetupFile],
    reporters: ['default'],
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
