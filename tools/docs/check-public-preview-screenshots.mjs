#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

const screenshots = [
  'public-home-light.png',
  'article-detail-light.png',
  'article-detail-mobile.png',
  'public-dark.png',
  'admin-dashboard.png',
  'article-editor.png',
  'comment-moderation.png',
  'security-console.png',
  'operations-status.png'
]
const screenshotSet = new Set(screenshots)

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`missing ${path}`)
    return ''
  }
}

function includes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

for (const file of screenshots) {
  const path = `docs/assets/screenshots/${file}`
  const fullPath = resolve(root, path)
  try {
    const buffer = readFileSync(fullPath)
    const stat = statSync(fullPath)
    const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    if (!isPng) errors.push(`${path} is not a PNG`)
    if (stat.size < 2048) errors.push(`${path} is unexpectedly small`)
  } catch {
    errors.push(`missing ${path}`)
  }
}

const gallery = read('docs/assets/screenshots/README.md')
for (const token of [
  'Public home page',
  'Article detail page',
  'Mobile article page',
  'Dark mode public page',
  'Admin dashboard',
  'Article editor',
  'Comment moderation console',
  'Security / anti-crawler console',
  'AOT / cache / operations status',
  'no real production domains',
  'no real personal emails',
  'no real IP addresses',
  'Brand And Asset Rights',
  'live frontend route audit flow',
  'manual-layout-screenshots',
  'capture:manual-layout-screenshots',
  'frontend router table',
  'FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS',
  'FSUSBLOG_MANUAL_SCREENSHOT_THEMES',
  'FSUSBLOG_MANUAL_SCREENSHOT_SCOPES',
  'FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME',
  'FSUSBLOG_MANUAL_SCREENSHOT_DOCS_SHARD_NAME',
  'FSUSBLOG_MANUAL_SCREENSHOT_WRITE_DOCS_ASSETS',
  'FSUSBLOG_MANUAL_SCREENSHOT_LAYOUT_AUDIT'
]) {
  includes('docs/assets/screenshots/README.md', gallery, token)
}

try {
  const extraScreenshots = readdirSync(resolve(root, 'docs/assets/screenshots'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png') && !screenshotSet.has(entry.name))
    .map((entry) => entry.name)
  if (extraScreenshots.length > 0) {
    errors.push(`docs/assets/screenshots contains stale PNG files: ${extraScreenshots.join(', ')}`)
  }
} catch {
  errors.push('missing docs/assets/screenshots')
}

if (existsSync(resolve(root, 'tools/docs/generate-public-preview-screenshots.mjs'))) {
  errors.push('tools/docs/generate-public-preview-screenshots.mjs must not exist; use capture:manual-layout-screenshots')
}

const publicShellCritical = read('src/frontend/src/assets/public-shell-critical.css')
for (const token of [
  '@ozwasyd/element-plus/theme-chalk/el-var.css',
  '@ozwasyd/element-plus/theme-chalk/el-radio-group.css',
  '@ozwasyd/element-plus/theme-chalk/el-radio-button.css',
  '@ozwasyd/element-plus/theme-chalk/el-theme-mode-toggle.css'
]) {
  includes('src/frontend/src/assets/public-shell-critical.css', publicShellCritical, token)
}

const manualCapture = read('tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts')
for (const token of [
  'APP_ROUTE_RECORDS',
  'buildManualRoutesFromRouteRecords',
  'materializeRoutePath',
  'ensureThemeApplied',
  'assertThemeModeToggleStyled',
  'parseManualScreenshotFilter',
  'filterManualScreenshotItems',
  'manualScreenshotShardName',
  'docsScreenshotWriterAllowed',
  'waitForHomeSecondaryContent',
  'pruneStaleDocsScreenshotAssets',
  'data-home-hot-articles-aside'
]) {
  includes('tests/frontend/e2e/manual/manual-layout-screenshots.spec.ts', manualCapture, token)
}
for (const token of [
  'buildAnonymousRoutes',
  'buildUserRoutes',
  'buildAdminRoutes'
]) {
  if (manualCapture.includes(token)) {
    errors.push(`manual layout screenshot script must not use static route matrix helper: ${token}`)
  }
}

const frontendPackage = read('src/frontend/package.json')
for (const token of [
  'capture:manual-layout-screenshots:desktop-light',
  'capture:manual-layout-screenshots:mobile-light',
  'FSUSBLOG_MANUAL_SCREENSHOT_VIEWPORTS=desktop',
  'FSUSBLOG_MANUAL_SCREENSHOT_THEMES=light',
  'FSUSBLOG_MANUAL_SCREENSHOT_SHARD_NAME=desktop-light'
]) {
  includes('src/frontend/package.json', frontendPackage, token)
}

const pageAssemblies = read('src/frontend/src/public-renderers/pageAssemblies.ts')
for (const token of [
  'FeaturedArticlesSection',
  'HomeHotArticlesAside',
  'HomeTextFirstRecommendations',
  'spotlightArticles.length > 0 && hotArticles.length > 0'
]) {
  includes('src/frontend/src/public-renderers/pageAssemblies.ts', pageAssemblies, token)
}

const publicEntryRegistry = read('src/frontend/src/public-renderers/publicEntryRegistry.ts')
for (const token of [
  'featuredArticles',
  'hotArticles',
  'normalizeFeaturedArticle',
  'normalizeHotArticle'
]) {
  includes('src/frontend/src/public-renderers/publicEntryRegistry.ts', publicEntryRegistry, token)
}

const readme = read('README.md')
for (const token of [
  'docs/assets/screenshots/',
  'public-home-light.png',
  'docs/known-limitations.md'
]) {
  includes('README.md', readme, token)
}

const releaseNotes = read('docs/releases/v1.1.0-public-preview.md')
for (const token of [
  'docs/assets/screenshots/',
  'docs/known-limitations.md',
  'ROADMAP.md',
  'docs/api/stability.md',
  'not stable production software'
]) {
  includes('docs/releases/v1.1.0-public-preview.md', releaseNotes, token)
}

const limitations = read('docs/known-limitations.md')
for (const token of [
  'v1.1.0 is public preview, not stable production release',
  'Internal API contracts may change before v1.2.0',
  'AEDS frame contracts are experimental',
  'Multi-node deployment is not supported until v1.3.0',
  'What Is Safe To Try',
  'What Should Not Be Relied On Yet',
  'Reporting Issues',
  'ROADMAP.md'
]) {
  includes('docs/known-limitations.md', limitations, token)
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[public-preview-screenshots] ${error}`)
  }
  process.exit(1)
}

console.log(`[public-preview-screenshots] ok screenshots=${screenshots.length}`)
