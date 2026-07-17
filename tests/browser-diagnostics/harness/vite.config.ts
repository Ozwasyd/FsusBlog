import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '../../../src/frontend/node_modules/@vitejs/plugin-vue/dist/index.mjs'
import vueJsx from '../../../src/frontend/node_modules/@vitejs/plugin-vue-jsx/dist/index.mjs'
import {
  createFsusUiAliases,
  resolveLocalFsusUiRoot,
} from '../../../src/frontend/scripts/fsusui-local'

const root = fileURLToPath(new URL('./', import.meta.url))
const repositoryRoot = path.resolve(root, '../../..')
const frontendRoot = path.join(repositoryRoot, 'src', 'frontend')
const localFsusUiRoot = resolveLocalFsusUiRoot(process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT)

if (!localFsusUiRoot) {
  throw new Error('the geometry/motion harness requires the sibling local FsusUI checkout')
}

export default {
  root,
  publicDir: false,
  plugins: [vue(), vueJsx()],
  resolve: {
    alias: [
      ...createFsusUiAliases(localFsusUiRoot),
      {
        find: /^vue$/,
        replacement: path.join(frontendRoot, 'node_modules', 'vue', 'dist', 'vue.esm-bundler.js'),
      },
    ],
  },
  server: {
    fs: {
      allow: [repositoryRoot, frontendRoot, localFsusUiRoot],
    },
  },
}
