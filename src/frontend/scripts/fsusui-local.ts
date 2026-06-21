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
const requiredThemeCssAssets = [
  'index.css',
  'el-public-shell-critical.css',
  // el-fsus-theme.css is required since src/assets/public-shell-critical.css
  // and src/assets/main.css both @import '@ozwasyd/element-plus/dist/el-fsus-theme.css'
  // (the new per-component CSS bundle for product-level overrides — see
  // FsusUI theme-chalk gulpfile). Without this entry the alias falls back
  // to the npm dist path, which doesn't exist pre-publish and 404s in dev.
  'el-fsus-theme.css',
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

const hasLocalThemeCssAssets = (root: string | null) => {
  if (!root) {
    return false
  }

  const themeDist = path.join(root, 'packages', 'theme-chalk', 'dist')
  return requiredThemeCssAssets.every((fileName) => fs.existsSync(path.join(themeDist, fileName)))
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
  const localThemeCssReady = hasLocalThemeCssAssets(localFsusUiRoot)
  const localThemeDist = `${root}/packages/theme-chalk/dist`

  return [
    { find: /^@ozwasyd\/element-plus$/, replacement: `${packageRoot}/index.ts` },
    { find: /^element-plus$/, replacement: `${packageRoot}/index.ts` },
    { find: /^@ozwasyd\/element-plus\/icons-vue$/, replacement: `${packageRoot}/icons-vue.ts` },
    { find: /^@ozwasyd\/element-plus\/markdown-runtime$/, replacement: `${packageRoot}/markdown-runtime.ts` },
    { find: /^@ozwasyd\/element-plus\/motion$/, replacement: `${packageRoot}/motion.ts` },
    { find: /^@ozwasyd\/element-plus\/perception-challenge$/, replacement: `${packageRoot}/perception-challenge.ts` },
    { find: /^@ozwasyd\/element-plus\/render-pipeline$/, replacement: `${packageRoot}/render-pipeline.ts` },
    { find: /^@ozwasyd\/element-plus\/result$/, replacement: `${packageRoot}/result.ts` },
    { find: /^@ozwasyd\/element-plus\/theme$/, replacement: `${packageRoot}/theme.ts` },
    { find: /^@ozwasyd\/element-plus\/wasm$/, replacement: `${packageRoot}/wasm.ts` },
    {
      find: /^@ozwasyd\/element-plus\/dist\/index\.css$/,
      replacement: localThemeCssReady
        ? `${localThemeDist}/index.css`
        : `${packagedRoot}/dist/index.css`,
    },
    {
      find: /^@ozwasyd\/element-plus\/dist\/public-shell-critical\.css$/,
      replacement: localThemeCssReady
        ? `${localThemeDist}/el-public-shell-critical.css`
        : `${packagedRoot}/dist/public-shell-critical.css`,
    },
    {
      // fsus-theme.scss was extracted out of dist/index.css (see FsusUI
      // theme-chalk/src/index.scss) so product-level overrides no longer
      // collide with element-plus base rules by cascade order. Consumers
      // (public-shell-critical.css, main.css) now @import this file
      // explicitly AFTER any base CSS they want to override.
      find: /^@ozwasyd\/element-plus\/dist\/el-fsus-theme\.css$/,
      replacement: localThemeCssReady
        ? `${localThemeDist}/el-fsus-theme.css`
        : `${packagedRoot}/dist/el-fsus-theme.css`,
    },
    {
      // Per-component CSS imports from src/assets/public-shell-critical.css
      // (el-var.css, el-radio-group.css, el-radio-button.css,
      // el-theme-mode-toggle.css) previously bypassed the local alias and
      // resolved from npm — so FsusUI source fixes to those files never
      // reached FsusBlog. This regex catches the whole family and points
      // them at the local dist, giving dev the same HMR path that
      // dist/index.css already had.
      find: /^@ozwasyd\/element-plus\/theme-chalk\/(.+)\.css$/,
      replacement: localThemeCssReady
        ? `${localThemeDist}/$1.css`
        : `${packagedRoot}/theme-chalk/$1.css`,
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
