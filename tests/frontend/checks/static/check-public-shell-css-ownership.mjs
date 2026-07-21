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
    /\.(?:el-public-shell|el-theme-mode-toggle|public-chrome-|public-colophon(?:__)?|fsusblog-public-brand|fsusblog-public-mobile-menu-utilities|fsusblog-public-shell-runtime)/u,
    'page layer must not own header, search, theme, auth, footer, brand, or runtime-shell selectors'
);
expectNotMatches(
  publicPagePath,
  publicPage,
  /\.markdown-body\.prose\s+:where\((?:h1|h2|h3|p)\)/u,
  'page layer must not redefine Markdown heading or paragraph typography',
)
expectNotMatches(
    foundationPath,
    foundation,
    /\.(?:el-[a-z0-9_-]+|public-chrome-[a-z0-9_-]+)/u,
    'foundation layer must not depend on FsusUI internals or retired consumer chrome selectors'
);
expectNotMatches(
    componentPath,
    componentStyle,
    /\.(?:el-[a-z0-9_-]+|public-colophon(?:__)?|fsusblog-public-brand|public-chrome-[a-z0-9_-]+)/u,
    'component layer must not patch FsusUI chrome, footer, or first-paint brand geometry'
);
expectNotMatches(
    emergencyPath,
    emergency,
    /\.(?:el-[a-z0-9_-]+|public-chrome-[a-z0-9_-]+)/u,
    'emergency fallback must not duplicate FsusUI runtime or critical component CSS'
);

for (const token of [
    '--fsusblog-public-header-height: 4rem;',
    '--fsusblog-public-header-height-current: var(--fsusblog-public-header-height, 4rem);',
    '--fsusblog-public-sticky-top: var(--fsusblog-public-header-height-current);',
    '--fsusblog-public-anchor-offset: calc(var(--fsusblog-public-sticky-top) + 0.75rem);',
    '#fsus-aot-shell [data-public-shell-header]',
    '#fsus-aot-shell .fsusblog-public-brand-mark',
    '#fsus-aot-shell .public-colophon'
])
{
    expectIncludes(foundationPath, foundation, token, `missing product-owned public-shell foundation contract ${token}`);
}

for (const pattern of [
    /--fsusblog-public-(?:control|mobile-control|overlay)[a-z0-9-]*\s*:/u,
    /--el-public-shell-[a-z0-9-]*\s*:/u,
    /--el-dialog-(?:padding-primary|border-radius|box-shadow)\s*:/u
])
{
    expectNotMatches(
        foundationPath,
        foundation,
        pattern,
        `generic component geometry must remain owned by FsusUI: ${pattern}`
  );
}

for (const token of [
    'desktop-search-mode="trigger"',
    ':desktop-search-trigger-label="layoutCopy.searchTriggerLabel"',
    ':auth-label="resolvedAuthLabel"',
    ':auth-href="resolvedAuthHref"',
    ':search-action="PUBLIC_ROUTE_PATHS.search"',
    ':search-query="searchQuery"',
    ':spa-search="spaSearch"',
    '@update:search-query="handleSearchInput"',
    '@search="handleSearch"'
])
{
    expectIncludes(componentPath, component, token, `PublicShell delegation contract is missing ${token}`);
}

for (const pattern of [
    /<template\s+#desktop-search>/u,
    /desktopSearchExpanded/u,
    /desktopSearch(?:Container|Panel|Trigger)Ref/u,
    /handleDesktopSearch(?:Trigger|Escape)/u,
    /handleDocumentPointerDown/u,
    /document\.(?:add|remove)EventListener\(['"]pointerdown['"]/u,
    /public-chrome-search-panel/u,
    /el-public-shell__auth-link/u
])
{
    expectNotMatches(
        componentPath,
        component,
        pattern,
        `Blog-owned shell must not retain delegated search/auth behavior: ${pattern}`
  );
}

expectIncludes(foundationPath, foundation, 'emergency:keep-start', 'foundation must own the emergency source block');
expectIncludes(foundationPath, foundation, 'emergency:keep-end', 'foundation must own the emergency source block')
expectNotMatches(publicPagePath, publicPage, /emergency:keep-(?:start|end)/u, 'page layer must not own emergency shell markers')
expectIncludes(generatorPath, generator, "const sourceRelativePath = 'src/assets/public-shell-foundation.css'", 'emergency generator must read the foundation source')
expectIncludes(emergencyPath, emergency, 'Source: src/assets/public-shell-foundation.css emergency:keep blocks.', 'generated emergency CSS must identify its foundation source')

for (const token of [
    'Foundation 层',
    'FsusUI critical/runtime CSS',
    'Component 层',
    'Public page 层',
    'public-shell-foundation.css` 与 `public-page.css` 对 FsusUI 内部选择器均为零豁免',
    '`[data-public-shell-header]`',
    '`--fsusblog-public-header-height-current`'
])
{
    expectIncludes(docsPath, docs, token, `public layout ownership documentation is missing ${token}`);
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
