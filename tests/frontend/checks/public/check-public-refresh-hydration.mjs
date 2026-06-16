#!/usr/bin/env node
/**
 * Public Shell Hydration Regression Check
 *
 * Tests hydration consistency across public SEO routes and shell interactions:
 *   1. First visit   – SSR shell → Vue hydration on page load
 *   2. Reload        – Full browser refresh with fresh SSR HTML
 *   3. Interaction   – Real public route clicks after hydration/runtime takeover
 *   4. Post-click refresh – Reload destination route after SPA/public-shell navigation
 *
 * Checks for Vue hydration mismatch warnings, [public-hydration] errors,
 * uncaught JS errors, and unexpected shell remounts/rebuilds. Public shell
 * micro-navigation intentionally disposes and remounts the hydrated shell; the
 * test asserts that remount is explicit instead of silently replacing a
 * Vue-owned subtree.
 *
 * Usage:
 *   FSUSBLOG_BASE_URL=http://127.0.0.1:5000 node ../../tests/frontend/checks/public/check-public-refresh-hydration.mjs
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))
const publicFixtureIds = readPublicFixtureIds()
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

const PUBLIC_HYDRATION_TIMEOUT_MS = 12000
const PUBLIC_RUNTIME_TIMEOUT_MS = 10000
const PUBLIC_INTERACTION_SETTLE_MS = 800
const PUBLIC_RELOAD_SETTLE_TIMEOUT_MS = parsePositiveInt(
  process.env.FSUSBLOG_PUBLIC_AOT_SETTLE_TIMEOUT_MS,
  30000
)
const PUBLIC_MUTATED_SITE_TITLE = 'Changed Site Settings After SSR'
const PUBLIC_MUTATED_SITE_DESCRIPTION = 'This title should not be used by the first SPA takeover render.'
const PUBLIC_SSR_ENTRY_URL = new URL('../../../../src/frontend/dist/server/renderPublicPage.js', import.meta.url)
const PUBLIC_HYDRATION_DETECTOR_SCHEMA = 'fsusblog.public-hydration-detector.v1'
const PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-detector-summary.json', import.meta.url))
const PUBLIC_HYDRATION_BROWSER = 'chromium'

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

const PUBLIC_SEO_SCENARIOS = [
  {
    name: 'home',
    route: '/',
    expectedKind: 'Home',
    interact: interactHomeScenario,
  },
  {
    name: 'about',
    route: '/about',
    expectedKind: 'About',
    interact: async (page, helpers) => {
      await helpers.clickPublicNav('home', '/', 'Home')
      await helpers.reloadAndWaitForHydration('Home')
    },
  },
  {
    name: 'archive',
    route: '/archive',
    expectedKind: 'Archive',
    interact: interactListToArticleScenario,
  },
  {
    name: 'article',
    route: `/article/${publicFixtureIds.articleId}`,
    expectedKind: 'ArticleDetail',
    interact: async (page, helpers) => {
      await helpers.clickPublicNav('archive', '/archive', 'Archive')
      await helpers.reloadAndWaitForHydration('Archive')
    },
  },
  {
    name: 'category',
    route: `/category/${publicFixtureIds.categoryId}`,
    expectedKind: 'Filter',
    interact: interactListToArticleScenario,
  },
  {
    name: 'tag',
    route: `/tag/${publicFixtureIds.tagId}`,
    expectedKind: 'Filter',
    interact: interactListToArticleScenario,
  },
]

const PUBLIC_INTERACTION_ONLY_SCENARIOS = [
  {
    name: 'takeover-settings-drift',
    route: '/',
    expectedKind: 'Home',
    interact: assertTakeoverIgnoresMutatedSettingsScenario,
  },
  {
    name: 'search-from-home',
    route: '/',
    expectedKind: 'Home',
    interact: interactSearchScenario,
  },
]

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isHydrationIssue(text) {
  const lower = text.toLowerCase()
  return HYDRATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))
}

function normalizeIssueType(type) {
  return type === 'warn' ? 'warning' : type
}

function createHydrationIssueRecorder(page, initialStage = 'setup') {
  const issues = []
  const seenIssues = new Set()
  let currentStage = initialStage

  function recordIssue(type, text, stage = currentStage) {
    const normalizedType = normalizeIssueType(type)
    const normalizedText = String(text).substring(0, 500)
    const key = `${normalizedType}:${stage}:${normalizedText}`
    if (seenIssues.has(key)) {
      return
    }

    seenIssues.add(key)
    issues.push({
      type: normalizedType,
      text: normalizedText,
      stage,
      isFatalHydrationIssue: true,
    })
  }

  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    if ((type === 'warn' || type === 'warning' || type === 'error') && isHydrationIssue(text)) {
      recordIssue(type, text)
    }
  })

  page.on('pageerror', (err) => {
    const text = err.message
    if (
      isHydrationIssue(text) ||
      text.includes('[public-') ||
      text.includes('remount') ||
      text.includes('subtree rebuilt')
    ) {
      recordIssue('error', text)
    }
  })

  return {
    issues,
    recordIssue,
    setStage(stage) {
      currentStage = stage
    },
  }
}

function issueWithContext(issue, route, viewport) {
  return {
    route: route.route,
    routeName: route.name,
    stage: issue.stage,
    browser: PUBLIC_HYDRATION_BROWSER,
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    type: issue.type,
    text: issue.text,
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE), { recursive: true })
  writeFileSync(PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

async function waitForVueMount(page, maxMs = 5000) {
  try {
    await page.waitForFunction(
      () => document.getElementById('app')?.__vue_app__ != null,
      { timeout: maxMs }
    )
    return true
  } catch {
    return false
  }
}

async function waitForPublicHydration(page, expectedKind, maxMs = PUBLIC_HYDRATION_TIMEOUT_MS) {
  await page.waitForFunction(
    ({ kind }) => {
      const app = document.getElementById('app')
      const shell = app?.querySelector('#fsus-aot-shell')
      const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
        : []

      return Boolean(
        app?.__vue_app__
        && shell
        && shell.parentElement === app
        && shell.getAttribute('data-public-hydration-kind') === kind
        && metrics.some((entry) => entry?.pageKind === kind)
      )
    },
    { kind: expectedKind },
    { timeout: maxMs }
  )
}

async function readHydrationState(page, expectedKind = null) {
  return page.evaluate((kind) => {
    const app = document.getElementById('app')
    const shell = app?.querySelector('#fsus-aot-shell')
    const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
      ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
      : []

    return {
      path: window.location.pathname,
      hasVueApp: Boolean(app?.__vue_app__),
      hasShell: Boolean(shell),
      shellKind: shell?.getAttribute('data-public-hydration-kind') ?? null,
      hasExpectedMetrics: kind == null ? metrics.length > 0 : metrics.some((entry) => entry?.pageKind === kind),
    }
  }, expectedKind)
}

async function waitForRuntimeRoute(page, options) {
  const {
    pathname,
    expectedKind,
    requireKind = true,
    requireIdentity = false,
    maxMs = PUBLIC_RUNTIME_TIMEOUT_MS,
  } = options

  await page.waitForFunction(
    ({ routePathname, kind, needsKind, needsIdentity }) => {
      const app = document.getElementById('app')
      const shell = app?.querySelector('#fsus-aot-shell')
      if (!app?.__vue_app__ || !shell || shell.parentElement !== app) {
        return false
      }

      if (window.location.pathname !== routePathname) {
        return false
      }

      if (needsKind && shell.getAttribute('data-public-hydration-kind') !== kind) {
        return false
      }

      if (needsIdentity && !shell.dataset.publicShellIdentity) {
        return false
      }

      return true
    },
    {
      routePathname: pathname,
      kind: expectedKind ?? null,
      needsKind: requireKind,
      needsIdentity: requireIdentity,
    },
    { timeout: maxMs }
  )
}

async function checkShellStructure(page, options = {}) {
  const {
    expectedKind = null,
    requireKind = true,
    requireHydrationMetrics = true,
  } = options

  return page.evaluate((input) => {
    const app = document.getElementById('app')
    if (!app) return { ok: false, reason: '#app missing' }
    const shell = app.querySelector('#fsus-aot-shell')
    if (!shell) return { ok: false, reason: '#fsus-aot-shell missing inside #app' }
    if (shell.parentElement !== app) {
      return {
        ok: false,
        reason: `#fsus-aot-shell parent is <${shell.parentElement?.tagName?.toLowerCase() ?? '?'}>, expected #app directly`,
      }
    }

    const kind = shell.getAttribute('data-public-hydration-kind')
    if (input.requireKind && kind !== input.expectedKind) {
      return {
        ok: false,
        reason: `data-public-hydration-kind mismatch: expected ${String(input.expectedKind)}, got ${String(kind)}`,
      }
    }

    if (input.requireHydrationMetrics) {
      const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
        : []

      if (!metrics.some((entry) => entry?.pageKind === input.expectedKind)) {
        return { ok: false, reason: `missing hydration metrics for ${String(input.expectedKind)}` }
      }
    }

    return {
      ok: true,
      kind,
      metricsCount: Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? window.__FSUS_PUBLIC_HYDRATION_METRICS__.length
        : 0,
    }
  }, {
    expectedKind,
    requireKind,
    requireHydrationMetrics,
  })
}

async function setShellProbe(page, marker) {
  return await page.evaluate((probe) => {
    const shell = document.querySelector('#fsus-aot-shell')
    if (!(shell instanceof HTMLElement)) {
      return false
    }

    shell.dataset.publicShellProbe = probe
    return true
  }, marker)
}

async function assertShellProbeDisposedByRemount(page, marker, expectedKind) {
  const result = await page.evaluate((probe) => {
    const app = document.getElementById('app')
    const shell = app?.querySelector('#fsus-aot-shell')
    return {
      ok: Boolean(
        app
        && shell
        && shell.parentElement === app
        && shell.dataset.publicShellDisposedProbe === probe
        && shell.dataset.publicShellRemount
      ),
      kind: shell?.getAttribute('data-public-hydration-kind') ?? null,
      remount: shell?.dataset.publicShellRemount ?? null,
    }
  }, marker)

  if (!result.ok) {
    throw new Error(`shell probe ${marker} was not disposed by an explicit remount`)
  }

  if (expectedKind && result.kind !== expectedKind) {
    throw new Error(`shell kind mismatch after interaction: expected ${expectedKind}, got ${String(result.kind)}`)
  }
}

async function triggerFullSpaTakeover(page, expectedKind, expectedPath = null) {
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('fsus:public-shell:takeover'))
  })

  await page.waitForFunction(
    ({ kind, pathname }) => {
      const app = document.getElementById('app')
      const shell = app?.querySelector('#fsus-aot-shell')
      return Boolean(
        app?.__vue_app__
        && app.dataset.publicTakeoverDisposedShell
        && shell
        && shell.parentElement === app
        && (kind == null || shell.getAttribute('data-public-hydration-kind') === kind)
        && (pathname == null || window.location.pathname === pathname)
      )
    },
    {
      kind: expectedKind ?? null,
      pathname: expectedPath,
    },
    { timeout: PUBLIC_RUNTIME_TIMEOUT_MS }
  )
}

let publicAotCodecPromise = null

async function loadPublicAotCodec() {
  publicAotCodecPromise ??= import(PUBLIC_SSR_ENTRY_URL.href)
  const codec = await publicAotCodecPromise
  if (typeof codec.encodePublicAotPayload !== 'function' || typeof codec.decodePublicAotPayload !== 'function') {
    throw new Error('public SSR entry does not expose public AOT payload codec')
  }
  return codec
}

async function createMutatedPublicHydrationRaw(rawPayload) {
  const { decodePublicAotPayload, encodePublicAotPayload } = await loadPublicAotCodec()
  const payload = decodePublicAotPayload(rawPayload)
  if (!payload || typeof payload !== 'object') {
    throw new Error('unable to decode current public hydration payload')
  }

  const compliance = payload.compliance && typeof payload.compliance === 'object'
    ? {
        ...payload.compliance,
        copyrightOwner: 'Changed Owner',
        icpRecordNumber: 'changed-icp-after-ssr',
      }
    : payload.compliance

  return encodePublicAotPayload({
    ...payload,
    title: PUBLIC_MUTATED_SITE_TITLE,
    siteTitle: PUBLIC_MUTATED_SITE_TITLE,
    siteDescription: PUBLIC_MUTATED_SITE_DESCRIPTION,
    compliance,
  })
}

async function readHydrationRawPayload(page) {
  const snapshot = await page.evaluate(() => {
    const script = document.getElementById('fsus-aot-hydration-props')
    return {
      inline: script?.textContent?.trim() ?? '',
      sidecar: script?.getAttribute('data-aeds-src') || script?.getAttribute('src') || '',
      base: window.location.href,
    }
  })

  if (snapshot.inline) {
    return snapshot.inline
  }

  if (!snapshot.sidecar) {
    return ''
  }

  const sidecarUrl = new URL(snapshot.sidecar, snapshot.base)
  const response = await fetch(sidecarUrl, {
    headers: { Accept: 'application/vnd.fsus.aeds' },
  })
  if (!response.ok) {
    throw new Error(`failed to fetch public hydration sidecar ${sidecarUrl.pathname}: HTTP ${response.status}`)
  }

  return Buffer.from(await response.arrayBuffer()).toString('base64url')
}

async function readShellIdentitySignature(page) {
  return await page.evaluate(() => {
    const app = document.getElementById('app')
    const shell = app?.querySelector('#fsus-aot-shell')
    const brand = shell?.querySelector('.el-public-shell__brand')
    const footer = shell?.querySelector('.el-public-shell__footer')
    const firstArticleLink = shell?.querySelector('[data-public-link="article"]')

    return {
      title: document.title,
      kind: shell?.getAttribute('data-public-hydration-kind') ?? null,
      brandText: brand?.textContent?.trim() ?? '',
      brandHref: brand?.getAttribute('href') ?? '',
      footerText: footer?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      firstArticleTag: firstArticleLink?.tagName ?? '',
      firstArticleHref: firstArticleLink?.getAttribute('href') ?? '',
    }
  })
}

async function replaceHydrationRawForTakeover(page, rawPayload) {
  await page.evaluate((raw) => {
    const script = document.getElementById('fsus-aot-hydration-props')
    if (script) {
      script.textContent = raw
    }
    window.__FSUS_PUBLIC_HYDRATION_RAW__ = raw
  }, rawPayload)
}

function assertShellIdentityPreserved({ before, after }) {
  const changedFields = []
  for (const key of ['kind', 'brandText', 'brandHref', 'firstArticleTag', 'firstArticleHref']) {
    if (before[key] !== after[key]) {
      changedFields.push(`${key}: expected ${JSON.stringify(before[key])}, got ${JSON.stringify(after[key])}`)
    }
  }

  if (before.brandText && !after.footerText.includes(before.brandText)) {
    changedFields.push(`footerText no longer contains SSR brand ${JSON.stringify(before.brandText)}`)
  }

  if (after.brandText === PUBLIC_MUTATED_SITE_TITLE || after.title.includes(PUBLIC_MUTATED_SITE_TITLE) || after.footerText.includes(PUBLIC_MUTATED_SITE_TITLE)) {
    changedFields.push('mutated post-SSR site settings leaked into first SPA takeover shell')
  }

  if (changedFields.length > 0) {
    throw new Error(`takeover shell identity drifted after post-SSR settings mutation: ${changedFields.join('; ')}`)
  }
}

async function clickPublicNav(page, navKey, expectedPath, expectedKind) {
  const candidates = page.locator(`[data-public-nav="${navKey}"]`)
  const count = await candidates.count()
  let link = candidates.first()

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (await candidate.isVisible()) {
      link = candidate
      break
    }
  }

  await link.click()
  await page.waitForURL((url) => url.pathname === expectedPath, { timeout: PUBLIC_RUNTIME_TIMEOUT_MS })
  await waitForRuntimeRoute(page, {
    pathname: expectedPath,
    expectedKind,
    requireKind: true,
    requireIdentity: false,
  })
}

async function clickFirstArticleLink(page) {
  const articleLink = page.locator('a[data-public-link="article"]').first()
  const href = await articleLink.getAttribute('href')
  if (!href) {
    throw new Error('missing first article href for interaction scenario')
  }

  const targetUrl = new URL(href, 'http://127.0.0.1')
  await articleLink.click()
  await page.waitForURL((url) => url.pathname === targetUrl.pathname, { timeout: PUBLIC_RUNTIME_TIMEOUT_MS })
  await waitForRuntimeRoute(page, {
    pathname: targetUrl.pathname,
    expectedKind: 'ArticleDetail',
    requireKind: true,
    requireIdentity: false,
  })

  return targetUrl.pathname
}

async function searchFromHome(page) {
  const firstTitleText = (await page.locator('a[data-public-link="article"]').first().textContent())?.trim() || 'hydrate'
  const query = firstTitleText.split(/\s+/u).find((part) => part.length >= 2) || firstTitleText || 'hydrate'
  const forms = page.locator('form[action="/search"]')
  const count = await forms.count()
  let input = null

  for (let index = 0; index < count; index += 1) {
    const candidate = forms
      .nth(index)
      .locator('input:not([type="hidden"]), textarea')
      .first()
    if (await candidate.isVisible()) {
      input = candidate
      break
    }
  }

  if (!input) {
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('fsus:public-shell:search-focus'))
    })
    await page.waitForFunction(
      () => {
        const app = document.getElementById('app')
        const shell = app?.querySelector('#fsus-aot-shell')
        return Boolean(
          app?.__vue_app__
          && app.dataset.publicTakeoverDisposedShell
          && shell
          && shell.parentElement === app
          && shell.getAttribute('data-public-hydration-kind') === 'Home'
          && window.location.pathname === '/'
        )
      },
      { timeout: PUBLIC_RUNTIME_TIMEOUT_MS }
    )
    return 'takeover'
  }

  await input.click()
  await input.fill(query)
  await input.press('Enter')

  await page.waitForURL((url) => url.pathname === '/search' && url.searchParams.get('q')?.length > 0, {
    timeout: PUBLIC_RUNTIME_TIMEOUT_MS,
  })

  const vueReady = await waitForVueMount(page, PUBLIC_RUNTIME_TIMEOUT_MS)
  if (!vueReady) {
    throw new Error('Vue did not mount within timeout after search navigation')
  }

  const sortButton = page.locator('button').filter({ hasText: '最新' }).first()
  if (await sortButton.isVisible()) {
    await sortButton.click()
    await page.waitForTimeout(PUBLIC_INTERACTION_SETTLE_MS)
  }

  return 'search'
}

async function interactListToArticleScenario(page, helpers) {
  await helpers.markShellProbe(`${helpers.name}-list-to-article`)
  const articlePath = await clickFirstArticleLink(page)
  await helpers.assertShellProbeDisposedByRemount(`${helpers.name}-list-to-article`, 'ArticleDetail')
  await helpers.reloadAndWaitForHydration('ArticleDetail', articlePath, { allowInitialSpaFallback: true })
}

async function interactHomeScenario(page, helpers) {
  await helpers.markShellProbe('home-to-article')
  const articlePath = await clickFirstArticleLink(page)
  await helpers.assertShellProbeDisposedByRemount('home-to-article', 'ArticleDetail')
  await helpers.reloadAndWaitForHydration('ArticleDetail', articlePath, { allowInitialSpaFallback: true })
  await helpers.triggerFullSpaTakeover('ArticleDetail', articlePath)
}

async function interactSearchScenario(page, helpers) {
  const mode = await searchFromHome(page)
  if (mode === 'takeover') {
    return
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForURL((url) => url.pathname === '/search' && url.searchParams.get('q')?.length > 0, {
    timeout: PUBLIC_RUNTIME_TIMEOUT_MS,
  })
  const vueReady = await waitForVueMount(page, PUBLIC_RUNTIME_TIMEOUT_MS)
  if (!vueReady) {
    throw new Error('Vue did not mount within timeout after search route reload')
  }
}

async function assertTakeoverIgnoresMutatedSettingsScenario(page, helpers) {
  const rawPayload = await readHydrationRawPayload(page)
  if (!rawPayload) {
    throw new Error('missing public hydration payload before takeover settings drift scenario')
  }

  const before = await readShellIdentitySignature(page)
  const mutatedRaw = await createMutatedPublicHydrationRaw(rawPayload)
  await replaceHydrationRawForTakeover(page, mutatedRaw)
  await helpers.triggerFullSpaTakeover('Home', '/')
  const after = await readShellIdentitySignature(page)
  assertShellIdentityPreserved({ before, after })
}

async function runScenario(page, baseUrl, route) {
  const recorder = createHydrationIssueRecorder(page)

  const helpers = {
    name: route.name,
    async markShellProbe(marker) {
      const applied = await setShellProbe(page, marker)
      if (!applied) {
        throw new Error(`failed to mark shell probe: ${marker}`)
      }
    },
    async assertShellProbeDisposedByRemount(marker, expectedKind) {
      await assertShellProbeDisposedByRemount(page, marker, expectedKind)
    },
    async triggerFullSpaTakeover(expectedKind, expectedPath = null) {
      recorder.setStage(`${route.name}:interaction:full-spa-takeover`)
      await triggerFullSpaTakeover(page, expectedKind, expectedPath)
    },
    async clickPublicNav(navKey, expectedPath, expectedKind) {
      recorder.setStage(`${route.name}:interaction:nav:${navKey}`)
      await clickPublicNav(page, navKey, expectedPath, expectedKind)
    },
    async reloadAndWaitForHydration(expectedKind, expectedPath = null, options = {}) {
      recorder.setStage(`${route.name}:interaction:reload`)
      const deadline = Date.now() + (options.allowInitialSpaFallback
        ? PUBLIC_RELOAD_SETTLE_TIMEOUT_MS
        : PUBLIC_HYDRATION_TIMEOUT_MS)
      let lastError = null
      let attempts = 0

      while (Date.now() < deadline) {
        attempts += 1
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        if (expectedPath) {
          await page.waitForURL((url) => url.pathname === expectedPath, { timeout: PUBLIC_HYDRATION_TIMEOUT_MS })
        }

        try {
          await waitForPublicHydration(page, expectedKind)

          const structure = await checkShellStructure(page, {
            expectedKind,
            requireKind: true,
            requireHydrationMetrics: true,
          })
          if (!structure.ok) {
            throw new Error(`shell structure after interaction reload invalid: ${structure.reason}`)
          }

          return
        } catch (err) {
          lastError = err
          const state = await readHydrationState(page, expectedKind)
          const isExpectedPath = expectedPath == null || state.path === expectedPath
          const isSpaFallback = isExpectedPath && state.hasVueApp && !state.hasShell

          if (!options.allowInitialSpaFallback || !isExpectedPath) {
            throw err
          }

          if (!isSpaFallback && Date.now() + PUBLIC_INTERACTION_SETTLE_MS >= deadline) {
            throw err
          }

          await page.waitForTimeout(PUBLIC_INTERACTION_SETTLE_MS)
        }
      }

      throw new Error(
        `hydration did not settle after ${attempts} reload attempt(s): ${
          lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
        }`
      )
    },
  }

  recorder.setStage(`${route.name}:first-visit:navigation`)
  try {
    await page.goto(`${baseUrl}${route.route}`, { waitUntil: 'networkidle', timeout: 30000 })
  } catch (err) {
    recorder.recordIssue('error', `goto failed: ${err.message}`)
    return recorder.issues
  }

  recorder.setStage(`${route.name}:first-visit:hydrate`)
  try {
    await waitForPublicHydration(page, route.expectedKind)
  } catch (err) {
    recorder.recordIssue('error', `hydration wait failed: ${err.message}`)
    return recorder.issues
  }

  const struct1 = await checkShellStructure(page, {
    expectedKind: route.expectedKind,
    requireKind: true,
    requireHydrationMetrics: true,
  })
  if (!struct1.ok) {
    recorder.recordIssue('error', `DOM structure after first visit: ${struct1.reason}`, `${route.name}:first-visit:structure`)
  }

  recorder.setStage(`${route.name}:reload:navigation`)
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (err) {
    recorder.recordIssue('error', `reload failed: ${err.message}`)
    return recorder.issues
  }

  recorder.setStage(`${route.name}:reload:hydrate`)
  try {
    await waitForPublicHydration(page, route.expectedKind)
  } catch (err) {
    recorder.recordIssue('error', `reload hydration wait failed: ${err.message}`)
    return recorder.issues
  }

  const struct2 = await checkShellStructure(page, {
    expectedKind: route.expectedKind,
    requireKind: true,
    requireHydrationMetrics: true,
  })
  if (!struct2.ok) {
    recorder.recordIssue('error', `DOM structure after reload: ${struct2.reason}`, `${route.name}:reload:structure`)
  }

  if (typeof route.interact === 'function') {
    recorder.setStage(`${route.name}:interaction:start`)
    try {
      await route.interact(page, helpers)
    } catch (err) {
      recorder.recordIssue('error', `interaction failed: ${err.message}`)
    }
  }

  return recorder.issues
}

async function runRoute(baseUrl, route, viewportSize) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  })
  const context = await browser.newContext({ viewport: viewportSize, javaScriptEnabled: true })
  const page = await context.newPage()

  let issues = []
  try {
    issues = await runScenario(page, baseUrl, route)
  } finally {
    await context.close()
    await browser.close()
  }
  return issues
}

async function runDetectorCanary(viewport) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  })
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    javaScriptEnabled: true,
  })
  const page = await context.newPage()
  const recorder = createHydrationIssueRecorder(page, 'detector-canary:console-warn')

  try {
    await page.setContent('<!doctype html><html><body><div id="app"><span>server</span></div></body></html>')
    await page.evaluate(() => {
      console.warn('[Vue warn]: Hydration text content mismatch in <span>: server rendered html didn\'t match client.')
    })
    await page.waitForTimeout(50)
  } finally {
    await context.close()
    await browser.close()
  }

  const fatalIssues = recorder.issues.filter((issue) => issue.isFatalHydrationIssue)
  if (fatalIssues.length === 0) {
    throw new Error('detector canary did not classify a deliberate hydration warning as fatal')
  }

  return {
    status: 'success',
    route: '__detector_canary__',
    stage: 'detector-canary:console-warn',
    browser: PUBLIC_HYDRATION_BROWSER,
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    fatalHydrationIssueCount: fatalIssues.length,
    warnings: fatalIssues.filter((issue) => issue.type === 'warning').map((issue) => ({
      stage: issue.stage,
      text: issue.text,
    })),
    errors: fatalIssues.filter((issue) => issue.type === 'error').map((issue) => ({
      stage: issue.stage,
      text: issue.text,
    })),
  }
}

async function main() {
  const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]
  const scenarios = [...PUBLIC_SEO_SCENARIOS, ...PUBLIC_INTERACTION_ONLY_SCENARIOS]
  const summary = {
    schema: PUBLIC_HYDRATION_DETECTOR_SCHEMA,
    status: 'failure',
    baseUrl,
    generatedAt: new Date().toISOString(),
    fatalHydrationIssueCount: 0,
    routesChecked: [],
    warnings: [],
    errors: [],
    canary: null,
  }

  try {
    summary.canary = await runDetectorCanary(viewports[0])
    console.log(`Detector canary: PASS (caught ${summary.canary.fatalHydrationIssueCount} fatal hydration issue(s))`)
  } catch (err) {
    summary.canary = {
      status: 'failure',
      route: '__detector_canary__',
      stage: 'detector-canary:console-warn',
      browser: PUBLIC_HYDRATION_BROWSER,
      viewport: viewports[0],
      fatalHydrationIssueCount: 0,
      error: err instanceof Error ? err.message : String(err),
    }
    summary.errors.push({
      route: '__detector_canary__',
      routeName: 'detector-canary',
      stage: 'detector-canary:console-warn',
      browser: PUBLIC_HYDRATION_BROWSER,
      viewport: viewports[0],
      type: 'error',
      text: summary.canary.error,
    })
    summary.fatalHydrationIssueCount = summary.errors.length
    writeSummary(summary)
    console.error(`Detector canary failed: ${summary.canary.error}`)
    console.error(`Hydration detector summary: ${PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE}`)
    process.exit(1)
  }

  // Quick connectivity check
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      const text = `Server at ${baseUrl} returned HTTP ${res.status}. Is it running?`
      summary.errors.push({
        route: '__connectivity__',
        routeName: 'connectivity',
        stage: 'connectivity:fetch',
        browser: PUBLIC_HYDRATION_BROWSER,
        viewport: viewports[0],
        type: 'error',
        text,
      })
      summary.fatalHydrationIssueCount = summary.errors.length
      writeSummary(summary)
      console.error(text)
      process.exit(2)
    }
  } catch (err) {
    const text = `Cannot reach ${baseUrl}: ${err.message}`
    summary.errors.push({
      route: '__connectivity__',
      routeName: 'connectivity',
      stage: 'connectivity:fetch',
      browser: PUBLIC_HYDRATION_BROWSER,
      viewport: viewports[0],
      type: 'error',
      text,
    })
    summary.fatalHydrationIssueCount = summary.errors.length
    writeSummary(summary)
    console.error(text)
    console.error('Start the dev/preview server first.')
    process.exit(2)
  }

  let failedCount = 0
  let passedCount = 0
  const allResults = []

  for (const vp of viewports) {
    for (const route of scenarios) {
      const label = `[${vp.name} ${route.route}]`
      process.stdout.write(`Testing ${label}... `)
      const issues = await runRoute(baseUrl, route, { width: vp.width, height: vp.height })

      const fatalHydrationIssues = issues.filter((i) => i.isFatalHydrationIssue)
      const warnings = fatalHydrationIssues.filter((i) => i.type === 'warning')
      const errors = fatalHydrationIssues.filter((i) => i.type === 'error')
      summary.warnings.push(...warnings.map((issue) => issueWithContext(issue, route, vp)))
      summary.errors.push(...errors.map((issue) => issueWithContext(issue, route, vp)))
      summary.routesChecked.push({
        route: route.route,
        routeName: route.name,
        stage: 'route:complete',
        expectedKind: route.expectedKind,
        browser: PUBLIC_HYDRATION_BROWSER,
        viewport: {
          name: vp.name,
          width: vp.width,
          height: vp.height,
        },
        status: fatalHydrationIssues.length === 0 ? 'success' : 'failure',
        fatalHydrationIssueCount: fatalHydrationIssues.length,
      })

      if (fatalHydrationIssues.length > 0) {
        failedCount++
        process.stdout.write('FAIL\n')
        fatalHydrationIssues.forEach((issue) => {
          console.error(`  ✗ [${issue.stage}] ${issue.text}`)
        })
      } else {
        passedCount++
        process.stdout.write('PASS\n')
      }

      allResults.push({ label, issues, fatalHydrationIssues })
    }
  }

  const total = passedCount + failedCount
  summary.fatalHydrationIssueCount = summary.warnings.length + summary.errors.length
  summary.status = summary.fatalHydrationIssueCount === 0 ? 'success' : 'failure'
  writeSummary(summary)

  console.log(`\nResults: ${passedCount}/${total} passed`)
  console.log(`Hydration detector summary: ${PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE}`)

  if (failedCount > 0) {
    console.error('\nFailed scenarios:')
    allResults
      .filter((r) => r.fatalHydrationIssues.length > 0)
      .forEach((r) => console.error(`  ${r.label}`))
    process.exit(1)
  }

  console.log('All hydration checks passed!')
}

main().catch((err) => {
  console.error('Test runner error:', err.message)
  process.exit(1)
})
