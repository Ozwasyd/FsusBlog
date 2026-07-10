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
    ...createVitestRuntimeOptions('wasm-bridges'),
    environment: 'node',
    include: [
      '../../tests/frontend/unit/services/binaryTransport.test.ts',
      '../../tests/frontend/unit/utils/**/*.test.ts',
      '../../tests/frontend/unit/protocol/**/*.test.ts'
    ],
    setupFiles: [unitSetupFile],
    coverage: {
      provider: 'v8',
      allowExternal: true,
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      reportsDirectory: 'coverage/wasm-bridges',
      include: ['src/wasm/**/*.ts', 'src/utils/wasmImageCodec.ts', 'src/utils/imageCompression.ts', 'src/services/localSearch.ts'],
      thresholds: {
        lines: Number(process.env.FSUSBLOG_FRONTEND_WASM_BRIDGES_LINES ?? 90),
        branches: Number(process.env.FSUSBLOG_FRONTEND_WASM_BRIDGES_BRANCHES ?? 85),
        functions: Number(process.env.FSUSBLOG_FRONTEND_WASM_BRIDGES_FUNCTIONS ?? 90),
        statements: Number(process.env.FSUSBLOG_FRONTEND_WASM_BRIDGES_STATEMENTS ?? 90)
      }
    }
  }
})
