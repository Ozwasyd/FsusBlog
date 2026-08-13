import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { resolveLocalFsusUiRepositoryRoot } from './fsusui-root.mjs'

export const FSUSUI_PACKAGE_ID = '@ozwasyd/element-plus'
export const FSUSUI_BASE_STYLE_ID = '@fsusblog/fsusui-base-style.scss'

type AliasEntry = {
  find: string | RegExp
  replacement: string
}

const frontendRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = path.resolve(frontendRoot, '../..')
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
  // el-fsus-theme.css is required by the public critical bundle and the
  // full-app base -> theme -> Blog stylesheet loading boundary. Without this
  // entry the alias falls back to the npm dist path, which doesn't exist
  // pre-publish and 404s in dev.
  'el-fsus-theme.css',
]
const publicShellMotionCssAssets = [
  'index.css',
  'el-public-shell-critical.css',
]
const publicShellMotionContracts = [
  'el-public-shell__mobile-nav-menu.is-closing',
  'el-public-shell-mobile-nav-menu-enter-active',
  'el-public-shell-mobile-nav-menu-leave-active',
  'el-public-shell-mobile-nav-menu-enter-from',
  'el-public-shell-mobile-nav-menu-leave-to',
  'prefers-reduced-motion:reduce',
]

const toVitePath = (value: string) => value.replace(/\\/g, '/')

const hasLocalWasmAssets = (root: string | null) => {
  if (!root) {
    return false
  }

  const wasmDist = path.join(root, 'vue', 'packages', 'wasm', 'dist')
  return requiredWasmAssets.every((fileName) => fs.existsSync(path.join(wasmDist, fileName)))
}

const hasLocalThemeCssAssets = (root: string | null) => {
  if (!root) {
    return false
  }

  const themeDist = path.join(root, 'vue', 'packages', 'theme-chalk', 'dist')
  const themeSource = path.join(root, 'vue', 'packages', 'theme-chalk', 'src', 'index.scss')
  if (!fs.existsSync(themeSource)) {
    return false
  }
  if (!requiredThemeCssAssets.every((fileName) => fs.existsSync(path.join(themeDist, fileName)))) {
    return false
  }

  return publicShellMotionCssAssets.every((fileName) => {
    const css = fs.readFileSync(path.join(themeDist, fileName), 'utf8')
    return publicShellMotionContracts.every((contract) => css.includes(contract))
  })
}

export function assertLocalFsusUiPublicShellMotionAssets(localFsusUiRoot: string | null): void {
  if (!localFsusUiRoot || hasLocalThemeCssAssets(localFsusUiRoot)) return
  throw new Error(
    'local FsusUI source requires rebuilt full and critical public-shell motion CSS; '
      + 'run `corepack pnpm run build:theme` in the FsusUI repository',
  )
}

export function resolveLocalFsusUiRoot(override?: string | null): string | null {
  return resolveLocalFsusUiRepositoryRoot({
    override,
    repositoryRoot,
  })
}

export function resolveFsusUiWasmDist(localFsusUiRoot: string | null): string {
  if (hasLocalWasmAssets(localFsusUiRoot)) {
    return path.join(localFsusUiRoot as string, 'vue', 'packages', 'wasm', 'dist')
  }

  return path.join(packagedFsusUiRoot, 'es', 'wasm', 'dist')
}

export function createFsusUiAliases(localFsusUiRoot: string | null): AliasEntry[] {
  if (!localFsusUiRoot) {
    return [
      { find: /^element-plus$/, replacement: FSUSUI_PACKAGE_ID },
      {
        find: FSUSUI_BASE_STYLE_ID,
        replacement: `${toVitePath(packagedFsusUiRoot)}/dist/index.css`,
      },
    ]
  }

  assertLocalFsusUiPublicShellMotionAssets(localFsusUiRoot)

  const root = toVitePath(localFsusUiRoot).replace(/\/+$/, '')
  const packageRoot = `${root}/vue/packages/element-plus`
  const packagedRoot = toVitePath(packagedFsusUiRoot)
  const localWasmReady = hasLocalWasmAssets(localFsusUiRoot)
  const localThemeCssReady = hasLocalThemeCssAssets(localFsusUiRoot)
  const localThemeDist = `${root}/vue/packages/theme-chalk/dist`

  return [
    {
      // Local production and diagnostics compile the pinned source directly.
      // This rejects malformed generated CSS instead of silently concatenating
      // an invalid dist fragment with the following application stylesheet.
      find: FSUSUI_BASE_STYLE_ID,
      replacement: `${root}/vue/packages/theme-chalk/src/index.scss`,
    },
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
      // collide with element-plus base rules by cascade order. The public
      // critical bundle imports it after its component CSS; fullApp.ts loads
      // it after dist/index.css and before Blog-owned overrides.
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
    { find: /^@element-plus\/icons-vue$/, replacement: `${root}/vue/packages/icons-vue/src/index.ts` },
    { find: /^@element-plus\/icons-vue\/(.+)$/, replacement: `${root}/vue/packages/icons-vue/src/$1` },
    { find: /^@element-plus\/theme-chalk\/src$/, replacement: `${root}/vue/packages/theme-chalk/src` },
    { find: /^@element-plus\/theme-chalk\/src\/(.+)$/, replacement: `${root}/vue/packages/theme-chalk/src/$1` },
    { find: /^@element-plus\/theme-chalk\/(.+)\.css$/, replacement: `${root}/vue/packages/theme-chalk/src/$1.scss` },
    {
      find: /^@element-plus\/wasm$/,
      replacement: localWasmReady ? `${root}/vue/packages/wasm/index.ts` : `${packagedRoot}/es/wasm.mjs`,
    },
    ...(localWasmReady
      ? [
        { find: /^@element-plus\/wasm\/(.+)$/, replacement: `${root}/vue/packages/wasm/$1` },
      ]
      : []),
    { find: /^@element-plus\/([^/]+)$/, replacement: `${root}/vue/packages/$1` },
    { find: /^@element-plus\/([^/]+)\/(.+)$/, replacement: `${root}/vue/packages/$1/$2` },
  ]
}
