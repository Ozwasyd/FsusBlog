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
    include: ['../../tests/frontend/unit/**/*.test.ts'],
    setupFiles: [unitSetupFile],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/unit',
      include: ['src/**/*.ts', 'src/**/*.vue', 'tests/frontend/support/playwright/testSession.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/main.ts',
        'src/bootstrap/**',
        'src/public-renderers/**',
        'src/wasm/**',
        'src/workers/**'
      ],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD ?? 70),
        branches: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD ?? 65),
        functions: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_FUNCTION_THRESHOLD ?? 70),
        statements: Number(process.env.FSUSBLOG_FRONTEND_COVERAGE_STATEMENT_THRESHOLD ?? 70)
      }
    }
  }
})
