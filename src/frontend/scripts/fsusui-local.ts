import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const FSUSUI_PACKAGE_ID = '@ozwasyd/element-plus'

type AliasEntry = {
  find: string | RegExp
  replacement: string
}

const frontendRoot = fileURLToPath(new URL('../', import.meta.url))
const defaultLocalFsusUiRoot = fileURLToPath(new URL('../../../../FsusUI/', import.meta.url))
const packagedFsusUiRoot = path.join(frontendRoot, 'node_modules', '@ozwasyd', 'element-plus')
const requiredWasmAssets = [
  'ep_wasm.mjs',
  'ep_wasm.wasm',
  'markdown_basic.js',
  'markdown_basic.wasm',
  'markdown_simd.js',
  'markdown_simd.wasm',
]

const toVitePath = (value: string) => value.replace(/\\/g, '/')

const hasLocalFsusUiSource = (root: string) =>
  fs.existsSync(path.join(root, 'packages', 'element-plus', 'index.ts')) &&
  fs.existsSync(path.join(root, 'packages', 'icons-vue', 'src', 'index.ts'))

const hasLocalWasmAssets = (root: string | null) => {
  if (!root) {
    return false
  }

  const wasmDist = path.join(root, 'packages', 'wasm', 'dist')
  return requiredWasmAssets.every((fileName) => fs.existsSync(path.join(wasmDist, fileName)))
}

export function resolveLocalFsusUiRoot(override?: string | null): string | null {
  const candidate = override?.trim()
    ? path.resolve(override)
    : defaultLocalFsusUiRoot

  return hasLocalFsusUiSource(candidate) ? candidate : null
}

export function resolveFsusUiWasmDist(localFsusUiRoot: string | null): string {
  if (hasLocalWasmAssets(localFsusUiRoot)) {
    return path.join(localFsusUiRoot as string, 'packages', 'wasm', 'dist')
  }

  return path.join(packagedFsusUiRoot, 'es', 'wasm', 'dist')
}

export function createFsusUiAliases(localFsusUiRoot: string | null): AliasEntry[] {
  if (!localFsusUiRoot) {
    return [
      { find: /^element-plus$/, replacement: FSUSUI_PACKAGE_ID },
    ]
  }

  const root = toVitePath(localFsusUiRoot).replace(/\/+$/, '')
  const packageRoot = `${root}/packages/element-plus`
  const packagedRoot = toVitePath(packagedFsusUiRoot)
  const localWasmReady = hasLocalWasmAssets(localFsusUiRoot)

  return [
    { find: /^@ozwasyd\/element-plus$/, replacement: `${packageRoot}/index.ts` },
    { find: /^element-plus$/, replacement: `${packageRoot}/index.ts` },
    { find: /^@ozwasyd\/element-plus\/icons-vue$/, replacement: `${packageRoot}/icons-vue.ts` },
    { find: /^@ozwasyd\/element-plus\/markdown-runtime$/, replacement: `${packageRoot}/markdown-runtime.ts` },
    { find: /^@ozwasyd\/element-plus\/render-pipeline$/, replacement: `${packageRoot}/render-pipeline.ts` },
    { find: /^@ozwasyd\/element-plus\/result$/, replacement: `${packageRoot}/result.ts` },
    { find: /^@ozwasyd\/element-plus\/theme$/, replacement: `${packageRoot}/theme.ts` },
    { find: /^@ozwasyd\/element-plus\/wasm$/, replacement: `${packageRoot}/wasm.ts` },
    { find: /^@ozwasyd\/element-plus\/dist\/index\.css$/, replacement: `${root}/packages/theme-chalk/src/index.scss` },
    {
      find: /^@ozwasyd\/element-plus\/dist\/public-shell-critical\.css$/,
      replacement: `${root}/packages/theme-chalk/src/public-shell-critical.scss`,
    },
    { find: /^@element-plus\/icons-vue$/, replacement: `${root}/packages/icons-vue/src/index.ts` },
    { find: /^@element-plus\/icons-vue\/(.+)$/, replacement: `${root}/packages/icons-vue/src/$1` },
    { find: /^@element-plus\/theme-chalk\/src$/, replacement: `${root}/packages/theme-chalk/src` },
    { find: /^@element-plus\/theme-chalk\/src\/(.+)$/, replacement: `${root}/packages/theme-chalk/src/$1` },
    { find: /^@element-plus\/theme-chalk\/(.+)\.css$/, replacement: `${root}/packages/theme-chalk/src/$1.scss` },
    {
      find: /^@element-plus\/wasm$/,
      replacement: localWasmReady ? `${root}/packages/wasm/index.ts` : `${packagedRoot}/es/wasm.mjs`,
    },
    ...(localWasmReady
      ? [
        { find: /^@element-plus\/wasm\/(.+)$/, replacement: `${root}/packages/wasm/$1` },
      ]
      : []),
    { find: /^@element-plus\/([^/]+)$/, replacement: `${root}/packages/$1` },
    { find: /^@element-plus\/([^/]+)\/(.+)$/, replacement: `${root}/packages/$1/$2` },
  ]
}
