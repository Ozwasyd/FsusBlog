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
    include: ['../../tests/frontend/unit/composables/**/*.test.ts', '../../tests/frontend/model/**/*.test.ts'],
    setupFiles: [unitSetupFile],
    reporters: ['default'],
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
