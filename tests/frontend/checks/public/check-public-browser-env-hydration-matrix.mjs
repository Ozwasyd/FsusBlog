#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeAdminPrincipalSnapshotFrame, encodeIdentityAccountSnapshotFrame } from '../../support/aeds-envelope.mjs'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const BROWSER_ENV_SCHEMA = 'fsusblog.public-hydration-browser-env-matrix.v1'
const BROWSER_ENV_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_BROWSER_ENV_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-browser-env-summary.json', import.meta.url))
const baseUrl = (
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:7568'
).replace(/\/+$/u, '')
const publicFixtureIds = readPublicFixtureIds()
const executablePath = resolveSystemChromiumExecutablePath()

const HYDRATION_KEYWORDS = [
  'Hydration',
  'mismatch',
  '[public-hydrate]',
  '[public-hydration]',
  'hydration node mismatch',
  'hydration text content mismatch',
  'hydration attribute mismatch',
  'hydration completed but contains mismatches',
  'server rendered html didn',
]

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
  narrowMobile: { width: 320, height: 720 },
}

const ENVIRONMENT_CELLS = [
  {
    id: 'empty-anonymous-light-desktop',
    themePreference: 'empty',
    savedAppState: 'empty',
    sessionState: 'anonymous',
    localUiPreference: 'not-dismissed',
    storageBehavior: 'normal',
    motionPreference: 'normal',
    colorScheme: 'light',
    viewport: 'desktop',
  },
  {
    id: 'dark-admin-stale-mobile-reduced',
    themePreference: 'dark',
    savedAppState: 'stale-public-shell-state',
    sessionState: 'admin',
    localUiPreference: 'dismissed',
    storageBehavior: 'normal',
    motionPreference: 'reduced',
    colorScheme: 'dark',
    viewport: 'mobile',
  },
  {
    id: 'system-user-storage-unavailable-tablet',
    themePreference: 'system',
    savedAppState: 'stale-site-info',
    sessionState: 'user',
    localUiPreference: 'not-dismissed',
    storageBehavior: 'unavailable',
    motionPreference: 'normal',
    colorScheme: 'dark',
    viewport: 'tablet',
  },
  {
    id: 'light-anonymous-cleared-narrow',
    themePreference: 'light',
    savedAppState: 'stale-site-info',
    sessionState: 'anonymous',
    localUiPreference: 'dismissed',
    storageBehavior: 'cleared-after-reload',
    motionPreference: 'reduced',
    colorScheme: 'light',
    viewport: 'narrowMobile',
  },
]

const ROUTE_CANDIDATES = [
  { id: 'home', route: '/', expectedKind: 'Home', required: true },
  { id: 'article-detail', route: `/article/${publicFixtureIds.articleId}`, expectedKind: 'ArticleDetail', required: false },
  { id: 'filter-category', route: `/category/${publicFixtureIds.categoryId}`, expectedKind: 'Filter', required: true },
  { id: 'static-about', route: '/about', expectedKind: 'About', required: true },
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(BROWSER_ENV_SUMMARY_FILE), { recursive: true })
  writeFileSync(BROWSER_ENV_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

function isHydrationIssue(text) {
  const lower = String(text).toLowerCase()
  return HYDRATION_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
}

function createAuthGate() {
  let released = true
  let waiters = []
  return {
    reset() {
      released = false
      waiters = []
    },
    release() {
      released = true
      for (const resolve of waiters.splice(0)) {
        resolve()
      }
    },
    async wait() {
      if (released) {
        return
      }
      await new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
  }
}

function createScriptGate() {
  let released = true
  let waiters = []
  return {
    reset() {
      released = false
      waiters = []
    },
    release() {
      released = true
      for (const resolve of waiters.splice(0)) {
        resolve()
      }
    },
    async wait() {
      if (released) {
        return
      }
      await new Promise((resolve) => {
        waiters.push(resolve)
      })
    },
  }
}

async function installScriptGate(context, scriptGate) {
  await context.route(/.*\.(?:js|mjs)(?:\?.*)?$/u, async (requestRoute) => {
    await scriptGate.wait()
    await requestRoute.continue()
  })
}

async function installAuthFixture(context, cell, authGate) {
  await context.route('**/api/local/auth-fixture/status', async (requestRoute) => {
    await requestRoute.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hasAccessToken: true,
        hasSessionId: true,
        hasAdminAccessToken: true,
        hasAdminSessionId: true,
        hasHostAccessToken: true,
        hasHostAdminAccessToken: true,
      }),
    })
  })

  await context.route('**/api/local/auth-fixture/admin**', async (requestRoute) => {
    await requestRoute.fulfill({
      status: 204,
      headers: { 'content-type': 'application/json' },
      body: '',
    })
  })

  await context.route('**/api/binary/auth/me', async (requestRoute) => {
    await authGate.wait()
    if (cell.sessionState === 'admin' || cell.sessionState === 'user') {
      await requestRoute.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(encodeIdentityAccountSnapshotFrame({
          accountId: cell.sessionState === 'admin' ? 9001 : 9002,
          publicHandle: `browser-env-${cell.sessionState}`,
          identityKind: 'anonymous_account',
          status: 0,
        })),
      })
      return
    }

    await requestRoute.fulfill({
      status: 401,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
  })

  await context.route('**/api/binary/auth/admin/me', async (requestRoute) => {
    await authGate.wait()
    if (cell.sessionState === 'admin') {
      await requestRoute.fulfill({
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(encodeAdminPrincipalSnapshotFrame({
          id: '9001',
          displayName: 'browser-env-admin',
          permissions: ['system.config'],
          adminSessionStatus: 'active',
        })),
      })
      return
    }

    await requestRoute.fulfill({
      status: 401,
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
  })
}

function seedBrowserStateScript(cell) {
  return `
(() => {
  const cell = ${JSON.stringify(cell)};
  const throwStorage = () => {
    throw new DOMException('storage unavailable for hydration matrix', 'SecurityError');
  };
  if (cell.storageBehavior === 'unavailable') {
    for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
      Object.defineProperty(Storage.prototype, name, { configurable: true, value: throwStorage });
    }
  }
  const safeSet = (storage, key, value) => {
    try { storage.setItem(key, value); } catch {}
  };
  const skipSeedAfterStorageClear = cell.storageBehavior === 'cleared-after-reload'
    && String(window.name || '').includes('fsus-browser-env-storage-cleared');
  if (!skipSeedAfterStorageClear && cell.themePreference !== 'empty') {
    safeSet(window.localStorage, 'fsus:theme-mode', cell.themePreference);
  }
  if (!skipSeedAfterStorageClear && cell.savedAppState !== 'empty') {
    safeSet(window.localStorage, 'fsus:site-info', JSON.stringify({ title: 'Stale Stored Site', updatedAt: '2000-01-01T00:00:00.000Z' }));
    safeSet(window.localStorage, 'fsus:public-shell:state', JSON.stringify({ authLabel: 'Stale Account', routeKey: 'stale' }));
  }
  if (!skipSeedAfterStorageClear && cell.localUiPreference === 'dismissed') {
    safeSet(window.localStorage, 'fsus:console-welcome-callout:dismissed:public-aot', '1');
  }
  if (!skipSeedAfterStorageClear) {
    safeSet(window.sessionStorage, 'fsus:public-shell:stale-route', '/stale-route');
  }
  window.__FSUS_PUBLIC_BROWSER_ENV_MATRIX_SEED__ = cell;
})();
`
}

async function probeRoute(route) {
  try {
    const response = await fetch(`${baseUrl}${route.route}`)
    const html = await response.text()
    const kind = html.match(/data-public-hydration-kind="([^"]+)"/u)?.[1] ?? null
    return {
      ...route,
      status: response.status,
      probedKind: kind,
      skipReason: kind === route.expectedKind ? null : `expected ${route.expectedKind}, got ${kind ?? 'none'}`,
    }
  } catch (error) {
    return {
      ...route,
      status: 0,
      probedKind: null,
      skipReason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function resolveRoutes() {
  const routes = []
  for (const route of ROUTE_CANDIDATES) {
    const probed = await probeRoute(route)
    if (probed.skipReason && probed.required) {
      throw new Error(`${route.id} route is not public-AOT ready: ${probed.skipReason}`)
    }
    routes.push(probed)
  }
  return routes
}

function expectedAuthState(cell) {
  if (cell.sessionState === 'admin') {
    return { text: '控制板', href: '/user/manage' }
  }
  if (cell.sessionState === 'user') {
    return { text: '账户', href: '/user/profile' }
  }
  return { text: '登录', href: '/login' }
}

function routeForCell(route, cell) {
  if (cell.sessionState === 'anonymous') {
    return route.route
  }

  const separator = route.route.includes('?') ? '&' : '?'
  const adminFixture = cell.sessionState === 'admin' ? '&fsusLocalFixtureAdmin=1' : ''
  return `${route.route}${separator}fsusLocalFixtureLogin=1${adminFixture}`
}

function expectedThemeMode(cell) {
  return cell.themePreference === 'empty' || cell.storageBehavior === 'unavailable'
    ? 'system'
    : cell.themePreference
}

function expectedResolvedTheme(cell) {
  const mode = expectedThemeMode(cell)
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return cell.colorScheme === 'dark' ? 'dark' : 'light'
}

function createIssueRecorder(page, row) {
  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    if ((type === 'warn' || type === 'warning' || type === 'error') && isHydrationIssue(text)) {
      row.issues.push({ type: type === 'warn' ? 'warning' : type, text: text.slice(0, 500) })
    }
  })
  page.on('pageerror', (error) => {
    const text = error.message
    if (isHydrationIssue(text) || text.includes('[public-') || text.includes('remount') || text.includes('subtree rebuilt')) {
      row.issues.push({ type: 'error', text: text.slice(0, 500) })
    }
  })
}

async function readSnapshot(page) {
  return await page.evaluate(() => {
    const shell = document.querySelector('#fsus-aot-shell')
    const authLink = document.querySelector('.el-public-shell__auth-link')
    const header = document.querySelector('.el-public-shell__header')
    const footer = document.querySelector('.el-public-shell__footer')
    const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
      ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
      : []
    let storageProbe = 'ok'
    try {
      window.localStorage.getItem('fsus:theme-mode')
      window.sessionStorage.getItem('fsus:public-shell:stale-route')
    } catch (error) {
      storageProbe = error instanceof Error ? error.name : 'throws'
    }
    return {
      appCount: document.querySelectorAll('#app').length,
      shellCount: document.querySelectorAll('#fsus-aot-shell').length,
      shellKind: shell?.getAttribute('data-public-hydration-kind') ?? null,
      shellHydrated: shell?.dataset.publicHydrated === 'true',
      shellChildElementCount: shell?.children.length ?? 0,
      authText: authLink?.textContent?.trim() ?? '',
      authHref: authLink?.getAttribute('href') ?? '',
      themeMode: document.documentElement.dataset.themeMode ?? '',
      themeResolved: document.documentElement.dataset.themeResolved ?? '',
      hasHeader: Boolean(header),
      hasFooter: Boolean(footer),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      darkColorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches,
      metricsCount: metrics.length,
      metricKinds: metrics.map((entry) => entry?.pageKind).filter(Boolean),
      storageProbe,
      seededState: window.__FSUS_PUBLIC_BROWSER_ENV_MATRIX_SEED__ ?? null,
    }
  })
}

async function waitForHydration(page, expectedKind) {
  await page.waitForFunction((kind) => {
    const shell = document.querySelector('#fsus-aot-shell')
    const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
      ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
      : []
    return shell?.dataset.publicHydrated === 'true'
      && shell.getAttribute('data-public-hydration-kind') === kind
      && metrics.some((entry) => entry?.pageKind === kind)
  }, expectedKind, { timeout: 12000 })
}

async function waitForAuthLabel(page, expected) {
  await page.waitForFunction((input) => {
    const link = document.querySelector('.el-public-shell__auth-link')
    return link?.textContent?.trim() === input.text && link?.getAttribute('href') === input.href
  }, expected, { timeout: 8000 })
}

function assertPreHydrationSnapshot(snapshot, route, cell) {
  assert(snapshot, `${cell.id}/${route.id}: pre-hydration snapshot was not captured`)
  assert(snapshot.appCount === 1, `${cell.id}/${route.id}: #app count ${snapshot.appCount}`)
  assert(snapshot.shellCount === 1, `${cell.id}/${route.id}: #fsus-aot-shell count ${snapshot.shellCount}`)
  assert(snapshot.shellKind === route.expectedKind, `${cell.id}/${route.id}: shell kind ${snapshot.shellKind}`)
  assert(snapshot.shellHydrated === false, `${cell.id}/${route.id}: pre-hydration snapshot was already hydrated`)
  assert(snapshot.hasHeader, `${cell.id}/${route.id}: public shell header missing before auth resolution`)
  assert(snapshot.hasFooter, `${cell.id}/${route.id}: public shell footer missing before auth resolution`)
  assert(snapshot.authText === '登录', `${cell.id}/${route.id}: auth text mutated before gated session resolution: ${snapshot.authText}`)
  assert(snapshot.authHref === '/login', `${cell.id}/${route.id}: auth href mutated before gated session resolution: ${snapshot.authHref}`)
}

function assertFinalSnapshot(snapshot, route, cell) {
  const auth = expectedAuthState(cell)
  assert(snapshot.shellHydrated, `${cell.id}/${route.id}: shell did not mark public hydrated`)
  assert(snapshot.shellKind === route.expectedKind, `${cell.id}/${route.id}: final shell kind ${snapshot.shellKind}`)
  assert(snapshot.metricKinds.includes(route.expectedKind), `${cell.id}/${route.id}: missing hydration metric kind ${route.expectedKind}`)
  assert(snapshot.authText === auth.text, `${cell.id}/${route.id}: auth text ${snapshot.authText}`)
  assert(snapshot.authHref === auth.href, `${cell.id}/${route.id}: auth href ${snapshot.authHref}`)
  assert(snapshot.themeMode === expectedThemeMode(cell), `${cell.id}/${route.id}: theme mode ${snapshot.themeMode}`)
  assert(snapshot.themeResolved === expectedResolvedTheme(cell), `${cell.id}/${route.id}: resolved theme ${snapshot.themeResolved}`)
  assert(snapshot.reducedMotion === (cell.motionPreference === 'reduced'), `${cell.id}/${route.id}: reduced motion ${snapshot.reducedMotion}`)
  assert(snapshot.darkColorScheme === (cell.colorScheme === 'dark'), `${cell.id}/${route.id}: dark color scheme ${snapshot.darkColorScheme}`)
  if (cell.storageBehavior === 'unavailable') {
    assert(snapshot.storageProbe !== 'ok', `${cell.id}/${route.id}: storage did not throw`)
  } else {
    assert(snapshot.storageProbe === 'ok', `${cell.id}/${route.id}: storage probe ${snapshot.storageProbe}`)
  }
}

async function runRouteCell(browser, route, cell) {
  const row = {
    route: route.route,
    routeId: route.id,
    expectedKind: route.expectedKind,
    browser: 'chromium',
    environment: cell,
    status: 'failure',
    issues: [],
  }

  if (route.skipReason) {
    return {
      ...row,
      status: 'skipped',
      skipReason: route.skipReason,
    }
  }

  const authGate = createAuthGate()
  const scriptGate = createScriptGate()
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: VIEWPORTS[cell.viewport],
    colorScheme: cell.colorScheme,
    reducedMotion: cell.motionPreference === 'reduced' ? 'reduce' : 'no-preference',
    javaScriptEnabled: true,
  })
  await context.addInitScript(seedBrowserStateScript(cell))
  await installScriptGate(context, scriptGate)
  await installAuthFixture(context, cell, authGate)
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  createIssueRecorder(page, row)

  try {
    authGate.reset()
    scriptGate.reset()
    await page.goto(routeForCell(route, cell), { waitUntil: 'commit', timeout: 30000 })
    await page.waitForSelector('#fsus-aot-shell', { timeout: 12000 })
    const pre = await readSnapshot(page)
    assertPreHydrationSnapshot(pre, route, cell)
    scriptGate.release()
    await waitForHydration(page, route.expectedKind)
    authGate.release()
    await waitForAuthLabel(page, expectedAuthState(cell))
    const final = await readSnapshot(page)
    assertFinalSnapshot(final, route, cell)
    assert(row.issues.length === 0, `${cell.id}/${route.id}: hydration issue ${row.issues[0]?.text}`)

    row.preHydration = pre
    row.afterHydration = final
    row.assertions = [
      'single-public-shell',
      'auth-gated-until-after-hydration',
      'theme-state-hydration-safe',
      'storage-behavior-covered',
      'media-preference-covered',
      'hydration-metrics-kind',
    ]

    if (cell.storageBehavior === 'cleared-after-reload') {
      await page.evaluate(() => {
        window.localStorage.clear()
        window.sessionStorage.clear()
        window.name = `${window.name || ''} fsus-browser-env-storage-cleared`
      })
      authGate.reset()
      scriptGate.reset()
      await page.reload({ waitUntil: 'commit', timeout: 30000 })
      await page.waitForSelector('#fsus-aot-shell', { timeout: 12000 })
      const reloadPre = await readSnapshot(page)
      assertPreHydrationSnapshot(reloadPre, route, cell)
      scriptGate.release()
      await waitForHydration(page, route.expectedKind)
      authGate.release()
      await waitForAuthLabel(page, expectedAuthState(cell))
      const reloadFinal = await readSnapshot(page)
      assert(reloadFinal.themeMode === 'system', `${cell.id}/${route.id}: cleared reload theme mode ${reloadFinal.themeMode}`)
      row.reloadAfterStorageClear = {
        preHydration: reloadPre,
        afterHydration: reloadFinal,
      }
      row.assertions.push('storage-cleared-after-reload')
    }

    row.status = 'success'
    return row
  } catch (error) {
    scriptGate.release()
    authGate.release()
    row.error = error instanceof Error ? error.message : String(error)
    return row
  } finally {
    await context.close()
  }
}

async function main() {
  const summary = {
    schema: BROWSER_ENV_SCHEMA,
    status: 'failure',
    generatedAt: new Date().toISOString(),
    baseUrl,
    routeProbes: [],
    rows: [],
  }

  let browser
  try {
    const routes = await resolveRoutes()
    summary.routeProbes = routes.map((route) => ({
      id: route.id,
      route: route.route,
      expectedKind: route.expectedKind,
      status: route.status,
      probedKind: route.probedKind,
      skipReason: route.skipReason,
    }))

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(executablePath ? { executablePath } : {}),
    })

    for (const cell of ENVIRONMENT_CELLS) {
      for (const route of routes) {
        process.stdout.write(`Testing browser env ${cell.id} ${route.id}... `)
        const row = await runRouteCell(browser, route, cell)
        summary.rows.push(row)
        process.stdout.write(`${row.status.toUpperCase()}\n`)
      }
    }

    const failures = summary.rows.filter((row) => row.status === 'failure')
    if (failures.length > 0) {
      throw new Error(`${failures.length} browser environment hydration cell(s) failed: ${failures.map((row) => `${row.environment.id}/${row.routeId}:${row.error}`).join('; ')}`)
    }
    summary.status = 'success'
    summary.coverage = {
      environmentCells: ENVIRONMENT_CELLS.length,
      routesChecked: summary.rows.filter((row) => row.status === 'success').length,
      routesSkipped: summary.rows.filter((row) => row.status === 'skipped').length,
      sessionStates: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.sessionState))],
      themePreferences: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.themePreference))],
      storageBehaviors: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.storageBehavior))],
      motionPreferences: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.motionPreference))],
      colorSchemes: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.colorScheme))],
      viewports: [...new Set(ENVIRONMENT_CELLS.map((cell) => cell.viewport))],
    }
    writeSummary(summary)
    console.log(`[public-browser-env-hydration] ok (${summary.coverage.routesChecked} passed, ${summary.coverage.routesSkipped} skipped); summary=${BROWSER_ENV_SUMMARY_FILE}`)
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
    writeSummary(summary)
    console.error(`[public-browser-env-hydration] failed: ${summary.error}`)
    process.exit(1)
  } finally {
    if (browser) {
      await browser.close()
    }
  }
}

main()
