#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

function fail(relativePath, message) {
  failures.push(`${relativePath}: ${message}`)
}

function expectIncludes(relativePath, source, token, message) {
  if (!source.includes(token)) {
    fail(relativePath, message)
  }
}

const viteConfigPath = 'src/frontend/vite.config.ts'
const publicShellPath = 'src/frontend/src/bootstrap/publicShell.ts'
const packageJsonPath = 'src/frontend/package.json'
const developmentDocsPath = 'docs/development.md'
const readmePath = 'README.md'

const viteConfig = read(viteConfigPath)
const publicShell = read(publicShellPath)
const packageJson = JSON.parse(read(packageJsonPath))
const developmentDocs = read(developmentDocsPath)
const readme = read(readmePath)
const scripts = packageJson.scripts ?? {}

expectIncludes(
  viteConfigPath,
  viteConfig,
  "const enablePublicShellProxy = env.VITE_PUBLIC_SHELL_PROXY?.trim() === '1'",
  'dev public shell SSR proxy must be opt-in via VITE_PUBLIC_SHELL_PROXY=1',
)

if (viteConfig.includes('const hasProxyFlag')) {
  fail(viteConfigPath, 'dev public shell proxy must not default to enabled when VITE_PUBLIC_SHELL_PROXY is missing')
}

if (viteConfig.includes("env.VITE_PUBLIC_SHELL_PROXY?.toLowerCase() === 'true'")) {
  fail(viteConfigPath, 'VITE_PUBLIC_SHELL_PROXY must use the single documented value 1')
}

for (const token of [
  'injectPublicSourceCssInDev',
  "name: 'inject-public-source-css-in-dev'",
  "apply: 'serve' as const",
  'transformIndexHtml',
  '/src/assets/public-shell-critical.css?direct',
  '/src/assets/public-page.css?direct',
]) {
  expectIncludes(viteConfigPath, viteConfig, token, `missing dev source CSS injection token: ${token}`)
}

if (!viteConfig.includes('injectPublicSourceCssInDev()')) {
  fail(viteConfigPath, 'Vite plugins must install injectPublicSourceCssInDev()')
}

if (publicShell.includes('?direct')) {
  fail(publicShellPath, 'runtime public shell fallback must not inject dev ?direct stylesheet links')
}

if (scripts['dev:ssr'] !== 'VITE_PUBLIC_SHELL_PROXY=1 npm run dev') {
  fail(packageJsonPath, 'dev:ssr must opt into backend public shell SSR proxy')
}

const checkScript = 'node ../../tests/frontend/checks/static/check-public-dev-mode-governance.mjs'
if (scripts['check:public-dev-mode-governance'] !== checkScript) {
  fail(packageJsonPath, 'check:public-dev-mode-governance script is missing')
}

if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-dev-mode-governance')) {
  fail(packageJsonPath, 'check:views-constraints must run check:public-dev-mode-governance')
}

for (const token of [
  'npm --prefix src/frontend run dev',
  'npm --prefix src/frontend run dev:debug',
  'npm --prefix src/frontend run dev:ssr',
  'VITE_PUBLIC_SHELL_PROXY=1',
  'public shell SSR proxy',
  'transformIndexHtml',
  'emergency fallback',
  'FsusUI HMR',
]) {
  expectIncludes(developmentDocsPath, developmentDocs, token, `missing development docs token: ${token}`)
}

for (const token of [
  'npm --prefix src/frontend run dev:debug',
  'npm --prefix src/frontend run dev:ssr',
  'VITE_PUBLIC_SHELL_PROXY=1',
  'FsusUI HMR',
]) {
  expectIncludes(readmePath, readme, token, `missing README token: ${token}`)
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-dev-mode-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-dev-mode-governance] ok')
