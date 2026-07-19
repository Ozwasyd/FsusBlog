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

const publicShellPath = 'src/frontend/src/bootstrap/publicShell.ts'
const fullAppPath = 'src/frontend/src/bootstrap/fullApp.ts'
const routerPath = 'src/frontend/src/router/index.ts'
const publicRoutePreloadPath = 'src/frontend/src/router/publicRoutePreload.ts'
const publicNavigationIntentPath = 'src/frontend/src/bootstrap/publicNavigationIntent.ts'
const articleDetailViewPath = 'src/frontend/src/composables/useArticleDetailView.ts'
const packageJsonPath = 'src/frontend/package.json'
const publicShell = read(publicShellPath)
const fullApp = read(fullAppPath)
const router = read(routerPath)
const publicRoutePreload = read(publicRoutePreloadPath)
const publicNavigationIntent = read(publicNavigationIntentPath)
const articleDetailView = read(articleDetailViewPath)
const packageJson = JSON.parse(read(packageJsonPath))

for (const token of [
  'DOMParser',
  'applyPublicNavigationDocument',
  'replacePublicShellForNavigation',
  'stripInlineStyleTagsForDetachedParse',
  'publicShellNavigationRemountCount',
  'X-Fsus-Public-Navigation',
  'public_navigation_legacy',
  'replacePublicHydrationPayloadBinary',
  'replacePublicHydrationPayloadSnapshot',
  'readPublicHydrationPayloadFromUrl',
  'settlePublicNavigationMotionForShell',
  'history.scrollRestoration'
]) {
  if (publicShell.includes(token)) {
    fail(publicShellPath, `legacy public HTML micro-router token must not return: ${token}`)
  }
}

for (const token of [
  'navigateWithAtomicPublicTakeover',
  'prewarmFullAppRoute',
  'prepareFullApp',
  'commitPreparedFullApp',
  'navigateWithDocumentRequest'
]) {
  if (!publicShell.includes(token)) {
    fail(publicShellPath, `atomic takeover navigation contract missing: ${token}`)
  }
}

if (publicRoutePreload.includes('@/bootstrap/fullApp')) {
  fail(publicRoutePreloadPath, 'resource preload must not import or own the FullApp bootstrap')
}

if (!router.includes("import type { PublicRoutePrewarmPort } from '@/router/publicRoutePreload'")) {
  fail(routerPath, 'router factory must depend on the prewarm type-only port')
}

for (const token of ['prewarmPublicRoute?: PublicRoutePrewarmPort', 'options.prewarmPublicRoute']) {
  if (!router.includes(token)) {
    fail(routerPath, `router factory prewarm port contract missing: ${token}`)
  }
}

if (router.includes('export default router')) {
  fail(routerPath, 'router module must not recreate a global router singleton outside FullApp composition')
}

for (const token of [
  'createAppRouter({',
  'prewarmPublicRoute',
  'export function prewarmFullAppRoute'
]) {
  if (!fullApp.includes(token)) {
    fail(fullAppPath, `FullApp router/prewarm composition contract missing: ${token}`)
  }
}

if (publicShell.includes('isPublicAtomicTakeoverEnabled')) {
  fail(publicShellPath, 'atomic public route takeover must not remain behind the retired feature flag')
}

if (publicNavigationIntent.includes('VITE_PUBLIC_ATOMIC_TAKEOVER')) {
  fail(publicNavigationIntentPath, 'retired atomic takeover feature flag must not classify public navigation')
}

for (const token of [
  "import { isPublicReadHydrationSuppressed } from '@/services/publicReadHydrationGuard'",
  'if (isPublicReadHydrationSuppressed())',
  'clearCommentState()'
]) {
  if (!articleDetailView.includes(token)) {
    fail(articleDetailViewPath, `public read hydration guard integration missing: ${token}`)
  }
}

const scripts = packageJson.scripts ?? {}
const checkScript = 'node ../../tests/frontend/checks/static/check-public-atomic-takeover-governance.mjs'
if (scripts['check:public-atomic-takeover-governance'] !== checkScript) {
  fail(packageJsonPath, 'check:public-atomic-takeover-governance script is missing')
}

if (!String(scripts['check:views-constraints'] ?? '').includes('check:public-atomic-takeover-governance')) {
  fail(packageJsonPath, 'check:views-constraints must run check:public-atomic-takeover-governance')
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `[public-atomic-takeover-governance] ${failure}`).join('\n'))
  process.exit(1)
}

console.log('[public-atomic-takeover-governance] ok')
