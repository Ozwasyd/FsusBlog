#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fail(file, message) {
  failures.push(`${file}: ${message}`)
}

function expectIncludes(file, source, token, message) {
  if (!source.includes(token)) {
    fail(file, message)
  }
}

function expectMatches(file, source, pattern, message) {
  if (!pattern.test(source)) {
    fail(file, message)
  }
}

function expectNotMatches(file, source, pattern, message) {
  if (pattern.test(source)) {
    fail(file, message)
  }
}

const foundationPath = 'src/frontend/src/assets/public-shell-foundation.css'
const publicPagePath = 'src/frontend/src/assets/public-page.css'
const componentPath = 'src/frontend/src/components/public/PublicBlogLayoutShell.vue'
const emergencyPath = 'src/frontend/public/public-shell-emergency.css'
const generatorPath = 'tools/frontend/generate-public-shell-emergency.mjs'
const docsPath = 'docs/public-layout-rules.md'
const packagePath = 'src/frontend/package.json'

const foundation = read(foundationPath)
const publicPage = read(publicPagePath)
const component = read(componentPath)
const componentStyle = component.match(/<style scoped>([\s\S]*?)<\/style>/u)?.[1] ?? ''
const emergency = read(emergencyPath)
const generator = read(generatorPath)
const docs = read(docsPath)
const packageJson = JSON.parse(read(packagePath))
const scripts = packageJson.scripts ?? {}

expectNotMatches(
  publicPagePath,
  publicPage,
  /\.(?:el-public-shell__|public-chrome-|public-colophon(?:__)?|fsusblog-public-brand|fsusblog-public-mobile-menu-utilities|fsusblog-public-shell-runtime)/u,
  'page layer must not own header, search, theme, auth, footer, brand, or runtime-shell selectors',
)
expectNotMatches(
  publicPagePath,
  publicPage,
  /\.markdown-body\.prose\s+:where\((?:h1|h2|h3|p)\)/u,
  'page layer must not redefine Markdown heading or paragraph typography',
)
expectNotMatches(
  foundationPath,
  foundation,
  /\.public-chrome-search/u,
  'foundation layer must leave enhanced desktop search panel appearance to its component',
)
expectNotMatches(
  componentPath,
  componentStyle,
  /\.(?:el-public-shell__|public-colophon(?:__)?|fsusblog-public-brand)/u,
  'component layer must not patch FsusUI chrome, footer, or first-paint brand geometry',
)

for (const token of [
  '--fsusblog-public-control-height: 40px;',
  '--fsusblog-public-mobile-control-height: 44px;',
  '--fsusblog-public-control-radius: var(--fsus-radius-control, 6px);',
  '--fsusblog-public-overlay-padding: 10px;',
  '--fsusblog-public-overlay-radius: var(--fsus-radius-popover, 10px);',
  '--fsusblog-public-overlay-shadow: var(--fsus-shadow-panel-light, none);',
  '--fsusblog-public-header-height-current: var(--fsusblog-public-header-height, 4rem);',
  '--fsusblog-public-sticky-top: var(--fsusblog-public-header-height-current);',
  '--fsusblog-public-anchor-offset: calc(var(--fsusblog-public-sticky-top) + 0.75rem);',
]) {
  expectIncludes(foundationPath, foundation, token, `missing shared public-shell token ${token}`)
}
expectMatches(
  foundationPath,
  foundation,
  /\.public-chrome-action\s*\{[\s\S]*?min-height:\s*var\(--fsusblog-public-control-height-current\);[\s\S]*?border-radius:\s*var\(--fsusblog-public-control-radius\);/u,
  'foundation must own the first-paint desktop search trigger geometry',
)

expectMatches(
  foundationPath,
  foundation,
  /@media \(max-width: 767px\)\s*\{[\s\S]*?#fsus-aot-shell\s*\{\s*--fsusblog-public-control-height-current:\s*var\(--fsusblog-public-mobile-control-height, 44px\);[\s\S]*?\.el-public-shell__mobile-search-trigger,[\s\S]*?\.el-public-shell__mobile-nav-menu-trigger,[\s\S]*?\.el-theme-mode-toggle__menu-button,[\s\S]*?\.el-public-shell__auth-link--mobile\s*\{[\s\S]*?min-height:\s*var\(--fsusblog-public-control-height-current\);/u,
  'mobile header controls must consume the shared 44px geometry tier',
)
expectMatches(
  foundationPath,
  foundation,
  /:where\(\s*\.el-theme-mode-toggle__menu,\s*\.el-public-shell__mobile-nav-menu-panel\s*\)\s*\{[\s\S]*?padding:\s*var\(--fsusblog-public-overlay-padding\);[\s\S]*?border-radius:\s*var\(--fsusblog-public-overlay-radius\);[\s\S]*?box-shadow:\s*var\(--fsusblog-public-overlay-shadow\);/u,
  'FsusUI public overlays must consume the shared overlay geometry tokens',
)
expectMatches(
  foundationPath,
  foundation,
  /html:has\(#fsus-aot-shell\)\s*\{[\s\S]*?--el-dialog-padding-primary:\s*var\(--fsusblog-public-overlay-padding\);[\s\S]*?--el-dialog-border-radius:\s*var\(--fsusblog-public-overlay-radius\);[\s\S]*?--el-dialog-box-shadow:\s*var\(--fsusblog-public-overlay-shadow\);/u,
  'public Dialog must consume the shared overlay geometry tokens',
)

for (const token of [
  'padding: var(--fsusblog-public-overlay-padding);',
  'border-radius: var(--fsusblog-public-overlay-radius);',
  'box-shadow: var(--fsusblog-public-overlay-shadow);',
  '.public-chrome-action:focus-visible',
  'box-shadow: inset 0 0 0 2px var(--fsusblog-color-focus-ring);',
  '.public-chrome-search-panel-enter-active',
  'transition-duration: 1ms;',
]) {
  expectIncludes(componentPath, componentStyle, token, `enhanced search component is missing ${token}`)
}

for (const token of [
  ':aria-expanded="desktopSearchExpanded"',
  '@keydown.esc="handleDesktopSearchEscape"',
  'desktopSearchPanelRef.value?.querySelector<HTMLInputElement>(\'input\')?.focus()',
  'desktopSearchTriggerRef.value?.focus()',
]) {
  expectIncludes(componentPath, component, token, `desktop search interaction contract is missing ${token}`)
}

expectIncludes(foundationPath, foundation, 'emergency:keep-start', 'foundation must own the emergency source block')
expectIncludes(foundationPath, foundation, 'emergency:keep-end', 'foundation must own the emergency source block')
expectNotMatches(publicPagePath, publicPage, /emergency:keep-(?:start|end)/u, 'page layer must not own emergency shell markers')
expectIncludes(generatorPath, generator, "const sourceRelativePath = 'src/assets/public-shell-foundation.css'", 'emergency generator must read the foundation source')
expectIncludes(emergencyPath, emergency, 'Source: src/assets/public-shell-foundation.css emergency:keep blocks.', 'generated emergency CSS must identify its foundation source')

for (const token of [
  'Foundation 层',
  'Component/Runtime 层',
  'Public page 层',
  'desktop public header 控件最小命中区为 `40px`',
  'mobile header 控件最小命中区为 `44px`',
  '`--fsusblog-public-overlay-padding`',
  '`--fsusblog-public-header-height-current`',
]) {
  expectIncludes(docsPath, docs, token, `public layout ownership documentation is missing ${token}`)
}

const checkCommand = 'node ../../tests/frontend/checks/static/check-public-shell-css-ownership.mjs'
if (scripts['check:public-shell-css-ownership'] !== checkCommand) {
  fail(packagePath, 'check:public-shell-css-ownership script is missing')
}
if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-shell-css-ownership')) {
  fail(packagePath, 'check:views-constraints must run the public-shell ownership gate')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-shell-css-ownership] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-shell-css-ownership] ok')
