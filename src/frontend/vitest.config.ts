import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { createFsusUiAliases, resolveLocalFsusUiRoot } from './scripts/fsusui-local'
import {
  createVitestRuntimeOptions,
  frontendTestDependencyDedupe,
  frontendUnitSetupFile
} from './vitest.shared.mjs'
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const frontendNodeModules = fileURLToPath(new URL('./node_modules/', import.meta.url))
const disableLocalFsusUi = process.env.FSUSBLOG_USE_LOCAL_FSUSUI === '0'
  || process.env.FSUSBLOG_USE_LOCAL_FSUSUI?.toLowerCase() === 'false'
const localFsusUiRoot = disableLocalFsusUi
  ? null
  : resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT)
const localFsusUiCoverageExclude = localFsusUiRoot
  ? [`${localFsusUiRoot.replaceAll('\\', '/')}/**`]
  : []
const serverFsAllow = [
  repositoryRoot,
  ...(localFsusUiRoot ? [localFsusUiRoot] : [])
]

export default defineConfig({
  plugins: [vue(), vueJsx()],
  server: {
    fs: {
      allow: serverFsAllow
    }
  },
  resolve: {
    dedupe: frontendTestDependencyDedupe,
    alias: [
      ...createFsusUiAliases(localFsusUiRoot),
      { find: '@vue/test-utils', replacement: `${frontendNodeModules}/@vue/test-utils` },
      { find: 'vue-router', replacement: `${frontendNodeModules}/vue-router` },
      { find: 'vue', replacement: `${frontendNodeModules}/vue` },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      { find: '@wasm', replacement: fileURLToPath(new URL('./wasm/web', import.meta.url)) }
    ]
  },
  test: {
    ...createVitestRuntimeOptions('unit'),
    environment: 'node',
    include: ['../../tests/frontend/unit/**/*.test.ts'],
    setupFiles: [frontendUnitSetupFile],
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
        'src/workers/**',
        ...localFsusUiCoverageExclude
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
