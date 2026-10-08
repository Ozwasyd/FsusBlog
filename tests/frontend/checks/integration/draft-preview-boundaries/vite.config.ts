import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '../../../../../src/frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs'
import vueJsx from '../../../../../src/frontend/node_modules/@vitejs/plugin-vue-jsx/dist/index.mjs'
import { createFsusUiAliases, resolveLocalFsusUiRoot } from '../../../../../src/frontend/scripts/fsusui-local'

const root = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(root, '../../../../..')
const frontendRoot = path.join(repositoryRoot, 'src/frontend')
const sourceRoot = process.env.FSUSBLOG_DRAFT_SOURCE_ROOT || repositoryRoot
const localUiRoot = resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT)
if (!localUiRoot) throw new Error('draft-boundaries-requires-real-local-fsusui')

export default {
  root,
  plugins: [vue(), vueJsx()],
  cacheDir: process.env.FSUSBLOG_DRAFT_BROWSER_CACHE || '/tmp/fsus-draft-boundaries-browser/vite',
  resolve: {
    dedupe: ['vue'],
    alias: [
      ...createFsusUiAliases(localUiRoot),
      { find: 'vue', replacement: path.join(frontendRoot, 'node_modules/vue') },
      { find: '@', replacement: path.join(sourceRoot, 'src/frontend/src') },
    ],
  },
  optimizeDeps: { exclude: ['@ozwasyd/element-plus', '@element-plus/wasm'] },
  server: { host: '127.0.0.1', port: 4179, strictPort: true, fs: { allow: [repositoryRoot, sourceRoot, localUiRoot] } },
}
