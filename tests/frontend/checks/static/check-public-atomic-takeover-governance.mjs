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
const coordinatorPath = 'src/frontend/src/bootstrap/publicActivationCoordinator.ts'
const runtimePath = 'src/frontend/src/bootstrap/publicActivationRuntime.ts'
const routerPath = 'src/frontend/src/router/index.ts'
const publicRoutePreloadPath = 'src/frontend/src/router/publicRoutePreload.ts'
const publicNavigationIntentPath = 'src/frontend/src/bootstrap/publicNavigationIntent.ts'
const articleDetailViewPath = 'src/frontend/src/composables/useArticleDetailView.ts'
const packageJsonPath = 'src/frontend/package.json'
const publicShell = read(publicShellPath)
const fullApp = read(fullAppPath)
const coordinator = read(coordinatorPath)
const runtime = read(runtimePath)
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
  'submitPublicActivationIntent',
  'warmPublicActivation',
  'warmPublicFullAppCore',
  'navigateWithDocumentRequest'
]) {
  if (!publicShell.includes(token)) {
    fail(publicShellPath, `atomic takeover navigation contract missing: ${token}`)
  }
}

// Idle public boot must warm FullApp core only — never prewarm(currentFullPath)
// into a navigation-snapshot fetch for the already-hydrated AOT page.
if (!publicShell.includes('schedulePublicCoreIdleWarm') || !publicShell.includes('warmPublicFullAppCore')) {
  fail(publicShellPath, 'idle public boot must schedule FullApp core warm via warmPublicFullAppCore')
}
if (publicShell.includes('schedulePublicRouteIdlePrewarm')) {
  fail(publicShellPath, 'retired idle route prewarm scheduler must not return')
}
if (/requestPublicRoutePrewarm\(\s*currentPublicShellFullPath\(\)/u.test(publicShell)) {
  fail(publicShellPath, 'idle must not call requestPublicRoutePrewarm(currentPublicShellFullPath())')
}
if (/warmPublicActivation\(\s*currentPublicShellFullPath\(\)/u.test(publicShell)) {
  fail(publicShellPath, 'idle must not call warmPublicActivation(currentPublicShellFullPath())')
}
if (/prewarmFullAppRoute\s*\(/u.test(publicShell) || /prewarmFullAppRoute\s*\(/u.test(runtime)) {
  fail(publicShellPath, 'composite prewarmFullAppRoute API must not return')
}

if (publicShell.includes("@/bootstrap/fullApp")) {
  fail(publicShellPath, 'public shell must submit typed intents instead of importing FullApp')
}

if (publicRoutePreload.includes('@/bootstrap/fullApp')) {
  fail(publicRoutePreloadPath, 'resource preload must not import or own the FullApp bootstrap')
}

if (!router.includes("import type { PublicRoutePrewarmPort } from '@/router/publicRoutePreload'")) {
  fail(routerPath, 'router factory must depend on the prewarm type-only port')
}

for (const token of [
  'prewarmPublicRoute?: PublicRoutePrewarmPort',
  "getPublicActivationOwner?: () => 'aot' | 'full-app'",
  'shouldSuppressNavigationProgress?: () => boolean',
  'options.prewarmPublicRoute',
  'options.getPublicActivationOwner?.()',
  'options.shouldSuppressNavigationProgress?.()'
]) {
  if (!router.includes(token)) {
    fail(routerPath, `router factory prewarm port contract missing: ${token}`)
  }
}

if (router.includes('@/bootstrap/publicActivationRuntime')) {
  fail(routerPath, 'router must consume an injected owner getter instead of importing browser composition')
}
if (router.includes('@/bootstrap/publicActivationCoordinator')) {
  fail(routerPath, 'router must not import the pure coordinator')
}

if (router.includes('export default router')) {
  fail(routerPath, 'router module must not recreate a global router singleton outside FullApp composition')
}

for (const token of [
  'createAppRouter({',
  'prewarmPublicRoute',
  'getPublicActivationOwner: options.getPublicActivationOwner',
  'shouldSuppressNavigationProgress: options.shouldSuppressNavigationProgress'
]) {
  if (!fullApp.includes(token)) {
    fail(fullAppPath, `FullApp router/prewarm composition contract missing: ${token}`)
  }
}

for (const token of [
  'routePreparationPort',
  'fullAppPort',
  'feedbackPort',
  'fallbackPort',
  'telemetryPort',
  'clock',
  'warmCore',
  'Promise.all'
]) {
  if (!coordinator.includes(token)) {
    fail(coordinatorPath, `coordinator port contract missing: ${token}`)
  }
}

if (!coordinator.includes('fullAppPort.warm') && !/warm:\s*\(\)\s*=>\s*Promise<void>/u.test(coordinator)) {
  fail(coordinatorPath, 'fullAppPort.warm core-only contract missing')
}

// Serial prepare (route then core) is forbidden; both must start before either resolves.
if (/routeResult\s*=\s*await[\s\S]*?fullAppPort\.prepare/u.test(coordinator) &&
    !/Promise\.all\(\[routeTask,\s*coreTask\]\)/u.test(coordinator)) {
  fail(coordinatorPath, 'activation must Promise.all core prepare with route preparation')
}

if (!publicRoutePreload.includes('Promise.all([componentTask, snapshotTask])') &&
    !publicRoutePreload.includes('Promise.all([componentTask, snapshotTask]') &&
    !/Promise\.all\(\[componentTask,\s*snapshotTask\]\)/u.test(publicRoutePreload)) {
  fail(publicRoutePreloadPath, 'route preparation must start component and snapshot in parallel')
}

// Serial component-then-snapshot without a parallel barrier is forbidden.
if (/await route\.preloadComponent\(\)[\s\S]*?await fetchNavigationSnapshot/u.test(publicRoutePreload) &&
    !/componentTask/u.test(publicRoutePreload)) {
  fail(publicRoutePreloadPath, 'serial component-then-snapshot preload must not return')
}

for (const forbiddenImport of [
  "'vue'",
  "'vue-router'",
  "'@/bootstrap/fullApp'",
  "'@/bootstrap/publicShell'",
  "'@/services/navigationProgress'",
  "'@/fsusui/",
  "'@/store/"
]) {
  if (coordinator.includes(forbiddenImport)) {
    fail(coordinatorPath, `pure coordinator has forbidden dependency: ${forbiddenImport}`)
  }
}

for (const token of [
  "import('@/bootstrap/fullApp')",
  'new PublicActivationCoordinator',
  'prewarmPublicRoute',
  'showGlobalLoader',
  'markGlobalLoaderBusy',
  'removeGlobalLoader',
  'shouldSuppressNavigationProgress',
  'window.location.assign',
  'warmPublicFullAppCore',
  'prepareTiming'
]) {
  if (!runtime.includes(token)) {
    fail(runtimePath, `browser composition contract missing: ${token}`)
  }
}

if (runtime.includes('showNavigationProgress') || runtime.includes('hideNavigationProgress')) {
  fail(runtimePath, 'AOT feedbackPort must use global-loader, not #nprogress')
}

if (!coordinator.includes('markBusy') || !coordinator.includes('requestFrame')) {
  fail(coordinatorPath, 'foreground feedback must mark busy and use a single animation frame')
}
if (/foregroundDelayMs|feedbackTimer/u.test(coordinator)) {
  fail(coordinatorPath, 'foreground feedback must not use arbitrary delay timers')
}

// Core warm/prepare must not import route seed/head stores.
for (const forbidden of [
  "from '@/public-renderers/publicRouteSeedStore'",
  'putPublicRouteSeed',
  'fetchNavigationSnapshot',
  'navigation-snapshot.aeds'
]) {
  if (runtime.includes(forbidden)) {
    fail(runtimePath, `FullApp core composition must not touch route snapshot/seed: ${forbidden}`)
  }
}

if (publicRoutePreload.includes('@/bootstrap/fullApp') || publicRoutePreload.includes('createApp(')) {
  fail(publicRoutePreloadPath, 'route preparation must not create/mount Vue app or import FullApp')
}

const retiredTokens = [
  ['public', 'TakeoverState'],
  ['beginPublicTakeover', 'Prewarm'],
  ['markPublicTakeover', 'Prepared'],
  ['beginPublicTakeover', 'Commit'],
  ['completePublicTakeover', 'Commit'],
  ['resetPublic', 'Takeover'],
  ['aot', '-idle'],
  ['pre', 'warming'],
  ['spa', '-active'],
  ['fallback', '-navigation']
].map((parts) => parts.join(''))

for (const retiredToken of retiredTokens) {
  for (const [relativePath, source] of [
    [publicShellPath, publicShell],
    [fullAppPath, fullApp],
    [routerPath, router],
    [coordinatorPath, coordinator],
    [runtimePath, runtime]
  ]) {
    if (source.includes(retiredToken)) {
      fail(relativePath, `retired activation authority token must not return: ${retiredToken}`)
    }
  }
}

// Split retired names so exact-string repo searches stay at zero hits.
const retiredEventBridges = [
  ['fsus:public-shell', ':', 'takeover'].join(''),
  ['fsus:public-shell', ':', 'search-focus'].join(''),
  ['aot', 'Action', 'Bridge'].join(''),
  ['handle', 'Root', 'Aot', 'Click'].join(''),
  ['begin', 'Public', 'Takeover', 'Prewarm'].join(''),
  ['mark', 'Public', 'Takeover', 'Prepared'].join(''),
  ['legacy', 'Takeover'].join(''),
  ['compat', 'Takeover'].join(''),
  ['bind', 'Public', 'Activation', 'Triggers'].join('')
]

for (const token of retiredEventBridges) {
  for (const [relativePath, source] of [
    [publicShellPath, publicShell],
    [fullAppPath, fullApp],
    [routerPath, router],
    [coordinatorPath, coordinator],
    [runtimePath, runtime]
  ]) {
    if (source.includes(token)) {
      fail(relativePath, `retired public bootstrap event/bridge token must not return: ${token}`)
    }
  }
}

const retiredAotBridgeRelativePath = ['src/frontend/src/bootstrap/', 'aot', 'Action', 'Bridge', '.ts'].join('')
if (fs.existsSync(path.join(repoRoot, retiredAotBridgeRelativePath))) {
  fail(retiredAotBridgeRelativePath, 'dual root AOT action bridge module must be deleted')
}

if (!runtime.includes('requestPublicSearchFocusIntent')) {
  fail(runtimePath, 'typed search-focus intent API missing from publicActivationRuntime')
}

if (!fullApp.includes('requestPublicSearchFocusIntent') || !fullApp.includes("import('@/bootstrap/publicActivationRuntime')")) {
  fail(fullAppPath, 'FullApp search focus must call the typed intent API without a static runtime import cycle')
}

if (/import\s*\{[^}]*requestPublicSearchFocusIntent[^}]*\}\s*from\s*['"]@\/bootstrap\/publicActivationRuntime['"]/u.test(fullApp)) {
  fail(fullAppPath, 'FullApp must not statically import publicActivationRuntime')
}

const appVuePath = 'src/frontend/src/App.vue'
const appVue = read(appVuePath)
if (appVue.includes(['handle', 'Root', 'Aot', 'Click'].join('')) || appVue.includes(['aot', 'Action', 'Bridge'].join(''))) {
  fail(appVuePath, 'App.vue must not re-enter root AOT click handling')
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
