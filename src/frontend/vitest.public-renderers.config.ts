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
    include: ['../../tests/frontend/unit/public-renderers/**/*.test.ts'],
    setupFiles: [unitSetupFile],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/public-renderers',
      include: ['src/public-renderers/**/*.ts', 'src/public-renderers/**/*.vue'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_PUBLIC_RENDERERS_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_PUBLIC_RENDERERS_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_PUBLIC_RENDERERS_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_PUBLIC_RENDERERS_STATEMENTS ?? 90)
      }
    }
  }
})
