import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import { createFsusUiAliases, resolveLocalFsusUiRoot } from './scripts/fsusui-local'
import { createVitestRuntimeOptions, frontendTestDependencyDedupe, frontendUnitSetupFile } from './vitest.shared.mjs'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const frontendNodeModules = fileURLToPath(new URL('./node_modules/', import.meta.url))
const disableLocalFsusUi = process.env.FSUSBLOG_USE_LOCAL_FSUSUI === '0'
  || process.env.FSUSBLOG_USE_LOCAL_FSUSUI?.toLowerCase() === 'false'
const localFsusUiRoot = disableLocalFsusUi
  ? null
  : resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT)
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
    ...createVitestRuntimeOptions('model'),
    maxWorkers: 1,
    environment: 'node',
    include: [
      '../../tests/frontend/unit/composables/useAuthLogin.test.ts',
      '../../tests/frontend/unit/composables/useAdminArticleWrite.authoringGates.test.ts',
      '../../tests/frontend/unit/composables/useAdminSettingsPage.test.ts',
      '../../tests/frontend/unit/composables/useAccountMessagesInbox.draftIsolation.test.ts',
      '../../tests/frontend/unit/composables/useImageUploadRuntime.test.ts'
    ],
    setupFiles: [frontendUnitSetupFile]
  }
})
