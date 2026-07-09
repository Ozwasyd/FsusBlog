#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

const brandDefaults = {
  faviconSvgUrl: '/favicon/favicon.svg',
  faviconIcoUrl: '/favicon/favicon.ico',
  faviconPngUrl: '/favicon/favicon-32x32.png',
  appleTouchIconUrl: '/favicon/apple-touch-icon.png',
  pwaIcon192Url: '/favicon/pwa-192x192.png',
  pwaIcon512Url: '/favicon/pwa-512x512.png',
  pwaMaskableIconUrl: '/favicon/maskable-icon-512x512.png',
  ogImage: '/social/og-image.png',
  themeColor: '#0B4F7A',
  backgroundColor: '#FFFFFF'
}

const requiredPublicFiles = [
  'src/frontend/public/favicon/favicon.ico',
  'src/frontend/public/favicon/favicon.svg',
  'src/frontend/public/favicon/favicon-16x16.png',
  'src/frontend/public/favicon/favicon-32x32.png',
  'src/frontend/public/favicon/favicon-48x48.png',
  'src/frontend/public/favicon/favicon-64x64.png',
  'src/frontend/public/favicon/apple-touch-icon.png',
  'src/frontend/public/favicon/pwa-192x192.png',
  'src/frontend/public/favicon/pwa-512x512.png',
  'src/frontend/public/favicon/maskable-icon-512x512.png',
  'src/frontend/public/favicon/safari-pinned-tab.svg',
  'src/frontend/public/social/og-image.png',
  'src/frontend/public/social/og-image.webp',
  'src/frontend/public/social/x-card.png',
  'src/frontend/public/social/x-card.webp',
  'src/frontend/public/social/social-square.png',
  'src/frontend/public/social/social-square.webp'
]

const forbiddenLegacyPublicFiles = [
  'src/frontend/public/favicon.ico',
  'src/frontend/public/favicon.svg',
  'src/frontend/public/apple-touch-icon.png',
  'src/frontend/public/icons/icon-192.png',
  'src/frontend/public/icons/icon-512.png',
  'src/frontend/public/icons/maskable-512.png'
]

const defaultSourceFiles = [
  'src/shared/Contracts/Outputs/ServerResponseContracts.cs',
  'src/backend/Models/ReadModels/SystemReadModels.cs',
  'src/backend/Models/Requests/SystemRequests.cs',
  'src/backend/Services/SystemService.cs',
  'src/frontend/src/store/site.ts'
]

const docsFiles = [
  'docs/api/contracts.md',
  'docs/security.md'
]

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fail(message) {
  failures.push(message)
}

for (const file of requiredPublicFiles) {
  if (!fs.existsSync(path.join(repoRoot, file))) {
    fail(`missing public brand asset: ${file}`)
  }
}

for (const file of forbiddenLegacyPublicFiles) {
  if (fs.existsSync(path.join(repoRoot, file))) {
    fail(`legacy public brand entry must not exist: ${file}`)
  }
}

const manifest = JSON.parse(readRepoFile('src/frontend/public/manifest.webmanifest'))
if (manifest.name !== 'Fsu’s Blog.') {
  fail('static manifest name must use the default brand package name')
}
if (manifest.short_name !== 'FsuBlog') {
  fail('static manifest short_name must use the default brand package short name')
}
if (manifest.description !== 'A personal blog under Fsu’s Club.') {
  fail('static manifest description must use the default brand package description')
}
if (manifest.theme_color !== brandDefaults.themeColor) {
  fail('static manifest theme_color must use the brand primary blue')
}
if (manifest.background_color !== brandDefaults.backgroundColor) {
  fail('static manifest background_color must use the brand package background')
}

const manifestIconSources = new Set((manifest.icons ?? []).map((icon) => icon.src))
for (const iconPath of [
  brandDefaults.pwaIcon192Url,
  brandDefaults.pwaIcon512Url,
  brandDefaults.pwaMaskableIconUrl
]) {
  if (!manifestIconSources.has(iconPath)) {
    fail(`static manifest must include icon ${iconPath}`)
  }
}

const indexHtml = readRepoFile('src/frontend/index.html')
for (const expected of [
  `href="${brandDefaults.faviconSvgUrl}"`,
  'rel="manifest" href="/manifest.webmanifest"'
]) {
  if (!indexHtml.includes(expected)) {
    fail(`index.html must include ${expected}`)
  }
}

for (const file of defaultSourceFiles) {
  const source = readRepoFile(file)
  for (const [key, value] of Object.entries(brandDefaults)) {
    if (!source.includes(value)) {
      fail(`${file} must include default ${key}: ${value}`)
    }
  }
}

for (const file of [...defaultSourceFiles, ...docsFiles, 'src/frontend/public/manifest.webmanifest']) {
  const source = readRepoFile(file)
  if (source.includes('/Users/brevis/Downloads')) {
    fail(`${file} must not reference the local Downloads brand package path`)
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[default-brand-assets] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[default-brand-assets] ok')
