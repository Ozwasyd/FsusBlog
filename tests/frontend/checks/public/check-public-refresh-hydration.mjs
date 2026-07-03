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
 * uncaught JS errors, and unexpected shell remounts/rebuilds. Public route
 * clicks are expected to hand off to atomic SPA takeover; unsupported or failed
 * routes fall back to a normal document request instead of detached HTML parsing.
 *
 * Usage:
 *   FSUSBLOG_BASE_URL=http://127.0.0.1:7568 node ../../tests/frontend/checks/public/check-public-refresh-hydration.mjs
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readAedsResponse } from '../../support/aeds-envelope.mjs'
import { readPublicFixtureIds } from '../../support/public-fixtures.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))
const publicFixtureIds = readPublicFixtureIds()
const executablePath = resolveSystemChromiumExecutablePath()

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
const PUBLIC_HYDRATION_ROUTE_PHASE_MATRIX_SCHEMA = 'fsusblog.public-hydration-route-phase-matrix.v1'
const PUBLIC_PAGE_MANIFEST_FILE = fileURLToPath(
  new URL('../../../../src/frontend/src/public-renderers/generated/publicPageManifest.ts', import.meta.url)
)

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
    expectedRouteKey: 'home',
    phases: createHomeNavigationPhases(),
  },
  {
    name: 'about',
    route: '/about',
    expectedKind: 'About',
    expectedRouteKey: 'about',
    phases: createStaticPagePhases(),
  },
  {
    name: 'privacy',
    route: '/privacy',
    expectedKind: 'Privacy',
    expectedRouteKey: 'privacy',
    phases: createStaticPagePhases(),
  },
  {
    name: 'guidelines',
    route: '/guidelines',
    expectedKind: 'Guidelines',
    expectedRouteKey: 'guidelines',
    phases: createStaticPagePhases(),
  },
  {
    name: 'copyright',
    route: '/copyright',
    expectedKind: 'Copyright',
    expectedRouteKey: 'copyright',
    phases: createStaticPagePhases(),
  },
  {
    name: 'archive',
    route: '/archive',
    expectedKind: 'Archive',
    expectedRouteKey: 'archive',
    phases: createListToArticlePhases(),
  },
  {
    name: 'article',
    route: `/article/${publicFixtureIds.articleId}`,
    expectedKind: 'ArticleDetail',
    expectedRouteKey: `article:${publicFixtureIds.articleId}`,
    allowSpaFallback: true,
    allowUnhydratedAotFallback: true,
    phases: [
      {
        phase: 'atomic-navigation',
        run: async (page, helpers) => {
          await helpers.clickPublicNav('archive', '/archive', 'Archive')
        },
      },
      {
        phase: 'post-navigation-reload',
        run: async (_page, helpers) => {
          await helpers.reloadAndWaitForHydration('Archive', '/archive')
        },
      },
    ],
  },
  {
    name: 'category',
    route: `/category/${publicFixtureIds.categoryId}`,
    expectedKind: 'Filter',
    expectedRouteKey: `category:${publicFixtureIds.categoryId}`,
    phases: createListToArticlePhases(),
  },
  {
    name: 'tag',
    route: `/tag/${publicFixtureIds.tagId}`,
    expectedKind: 'Filter',
    expectedRouteKey: `tag:${publicFixtureIds.tagId}`,
    phases: createListToArticlePhases(),
  },
  {
    name: 'invalid-category-fallback',
    route: '/category/0',
    expectedKind: 'Filter',
    allowUnhydratedAotFallback: true,
  },
  {
    name: 'invalid-tag-fallback',
    route: '/tag/0',
    expectedKind: 'Filter',
    allowUnhydratedAotFallback: true,
  },
  {
    name: 'invalid-article-aot-fallback',
    route: '/article/0',
    expectedKind: 'ArticleDetail',
    allowUnhydratedAotFallback: true,
    directWaitUntil: 'domcontentloaded',
  },
]

const PUBLIC_INTERACTION_ONLY_SCENARIOS = [
  {
    name: 'takeover-settings-drift',
    route: '/',
    expectedKind: 'Home',
    expectedRouteKey: 'home',
    phases: [
      {
        phase: 'full-spa-takeover',
        run: assertTakeoverIgnoresMutatedSettingsScenario,
      },
    ],
  },
  {
    name: 'search-from-home',
    route: '/',
    expectedKind: 'Home',
    expectedRouteKey: 'home',
    phases: [
      {
        phase: 'non-aot-search-fallback',
        run: interactSearchScenario,
      },
    ],
  },
  {
    name: 'search-fallback',
    route: '/search?q=hydration',
    expectedKind: null,
    expectSpaFallback: true,
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

function phaseWithContext(phase, route, viewport) {
  return {
    route: route.route,
    routeName: route.name,
    phase: phase.phase,
    stage: phase.stage,
    expectedKind: route.expectedKind,
    expectedRouteKey: route.expectedRouteKey ?? null,
    browser: PUBLIC_HYDRATION_BROWSER,
    viewport: {
      name: viewport.name,
      width: viewport.width,
      height: viewport.height,
    },
    status: phase.status,
    assertions: phase.assertions,
    details: phase.details ?? {},
    error: phase.error ?? null,
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE), { recursive: true })
  writeFileSync(PUBLIC_HYDRATION_DETECTOR_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

function readPublicSeoAotManifestKinds() {
  const source = readFileSync(PUBLIC_PAGE_MANIFEST_FILE, 'utf8')
  const manifestStart = source.indexOf('export const PUBLIC_PAGE_MANIFEST')
  const manifestEnd = source.indexOf('} as const)', manifestStart)
  if (manifestStart < 0 || manifestEnd < 0) {
    throw new Error('unable to locate PUBLIC_PAGE_MANIFEST block')
  }

  const manifestBlock = source.slice(manifestStart, manifestEnd)
  const kinds = []
  for (const match of manifestBlock.matchAll(/\n\s{2}([A-Za-z][A-Za-z0-9]*):\s*\{([\s\S]*?)\n\s{2}\}/g)) {
    const [, fallbackKind, body] = match
    if (!body.includes('seoEligible: true') || !body.includes('aotShellReady: true')) {
      continue
    }

    const kindMatch = body.match(/kind:\s*'([^']+)'/)
    kinds.push(kindMatch?.[1] ?? fallbackKind)
  }

  return kinds
}

function assertScenarioCoverageAgainstPublicPageManifest(scenarios) {
  const requiredKinds = readPublicSeoAotManifestKinds()
  const coveredKinds = Array.from(new Set(
    scenarios
      .filter((scenario) => !scenario.expectSpaFallback)
      .map((scenario) => scenario.expectedKind)
      .filter(Boolean)
  ))
  const missingKinds = requiredKinds.filter((kind) => !coveredKinds.includes(kind))
  if (missingKinds.length > 0) {
    throw new Error(`public hydration route matrix missing manifest AOT kinds: ${missingKinds.join(', ')}`)
  }

  return {
    schema: PUBLIC_HYDRATION_ROUTE_PHASE_MATRIX_SCHEMA,
    manifest: PUBLIC_PAGE_MANIFEST_FILE,
    requiredKinds,
    coveredKinds,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      route: scenario.route,
      expectedKind: scenario.expectedKind,
      expectedRouteKey: scenario.expectedRouteKey ?? null,
      expectSpaFallback: Boolean(scenario.expectSpaFallback || scenario.allowSpaFallback),
      phases: [
        'direct-first-load',
        'reload',
        ...((scenario.phases ?? []).map((phase) => phase.phase)),
      ],
    })),
  }
}

function createPhaseResult(route, phase, status, options = {}) {
  return {
    route: route.route,
    routeName: route.name,
    phase,
    stage: options.stage ?? `${route.name}:${phase}`,
    expectedKind: route.expectedKind,
    expectedRouteKey: route.expectedRouteKey ?? null,
    status,
    assertions: options.assertions ?? [],
    details: options.details ?? {},
    error: options.error ?? null,
  }
}

function normalizeAssertions(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.length > 0)
  }

  if (value && typeof value === 'object' && Array.isArray(value.assertions)) {
    return value.assertions.filter((item) => typeof item === 'string' && item.length > 0)
  }

  return []
}

function normalizePhaseDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const { assertions: _assertions, ...details } = value
  return details
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
    expectedRouteKey = null,
    requireKind = true,
    requireHydrationMetrics = true,
  } = options

  return page.evaluate((input) => {
    const assertions = []
    const appRoots = Array.from(document.querySelectorAll('#app'))
    if (appRoots.length !== 1) return { ok: false, reason: `#app count mismatch: ${appRoots.length}`, assertions }
    assertions.push('single-app-root')

    const app = appRoots[0]
    if (!app) return { ok: false, reason: '#app missing' }
    const shells = Array.from(app.querySelectorAll('#fsus-aot-shell'))
    if (shells.length !== 1) return { ok: false, reason: `#fsus-aot-shell count mismatch inside #app: ${shells.length}`, assertions }
    assertions.push('single-aot-shell')

    const shell = shells[0]
    if (!shell) return { ok: false, reason: '#fsus-aot-shell missing inside #app' }
    if (shell.parentElement !== app) {
      return {
        ok: false,
        reason: `#fsus-aot-shell parent is <${shell.parentElement?.tagName?.toLowerCase() ?? '?'}>, expected #app directly`,
        assertions,
      }
    }
    assertions.push('shell-parent-is-app')

    const kind = shell.getAttribute('data-public-hydration-kind')
    if (input.requireKind && kind !== input.expectedKind) {
      return {
        ok: false,
        reason: `data-public-hydration-kind mismatch: expected ${String(input.expectedKind)}, got ${String(kind)}`,
        assertions,
      }
    }
    assertions.push('expected-hydration-kind')

    if (input.requireHydrationMetrics) {
      const metrics = Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? window.__FSUS_PUBLIC_HYDRATION_METRICS__
        : []

      if (!metrics.some((entry) => entry?.pageKind === input.expectedKind)) {
        return { ok: false, reason: `missing hydration metrics for ${String(input.expectedKind)}`, assertions }
      }
      assertions.push('hydration-metrics-kind')

      if (input.expectedRouteKey && !metrics.some((entry) => entry?.pageKind === input.expectedKind && entry?.routeKey === input.expectedRouteKey)) {
        return {
          ok: false,
          reason: `missing hydration metrics routeKey ${String(input.expectedRouteKey)} for ${String(input.expectedKind)}`,
          assertions,
        }
      }
      if (input.expectedRouteKey) {
        assertions.push('hydration-metrics-route-key')
      }
    }

    for (const id of ['fsus-aot-bootstrap', 'fsus-aot-hydration-props']) {
      const count = document.querySelectorAll(`#${id}`).length
      if (count > 1) {
        return { ok: false, reason: `${id} count mismatch: ${count}`, assertions }
      }
    }
    assertions.push('no-duplicate-public-payload-scripts')

    const managedHeadNodes = Array.from(document.head.querySelectorAll('[data-fsus-aot-head]'))
    const headKeys = managedHeadNodes.map((node) => [
      node.tagName,
      node.getAttribute('name') ?? '',
      node.getAttribute('property') ?? '',
      node.getAttribute('rel') ?? '',
      node.getAttribute('href') ?? '',
      node.getAttribute('content') ?? '',
    ].join('|'))
    const duplicateHeadKey = headKeys.find((key, index) => headKeys.indexOf(key) !== index)
    if (duplicateHeadKey) {
      return { ok: false, reason: `duplicate AOT-managed head node: ${duplicateHeadKey}`, assertions }
    }
    assertions.push('aot-head-nodes-unique')

    return {
      ok: true,
      kind,
      assertions,
      metricsCount: Array.isArray(window.__FSUS_PUBLIC_HYDRATION_METRICS__)
        ? window.__FSUS_PUBLIC_HYDRATION_METRICS__.length
        : 0,
    }
  }, {
    expectedKind,
    expectedRouteKey,
    requireKind,
    requireHydrationMetrics,
  })
}

async function checkSpaFallbackStructure(page, route) {
  return page.evaluate((input) => {
    const assertions = []
    const appRoots = Array.from(document.querySelectorAll('#app'))
    if (appRoots.length !== 1) return { ok: false, reason: `#app count mismatch: ${appRoots.length}`, assertions }
    assertions.push('single-app-root')

    const shell = document.querySelector('#app > #fsus-aot-shell')
    if (shell) {
      const kind = shell.getAttribute('data-public-hydration-kind')
      if (input.expectedKind && kind === input.expectedKind) {
        return { ok: false, reason: `fallback route unexpectedly hydrated as ${kind}`, assertions }
      }
    }
    assertions.push('no-wrong-aot-kind')

    const hydrationPayload = document.getElementById('fsus-aot-hydration-props')
    if (hydrationPayload?.textContent?.trim() && input.expectedKind == null) {
      return { ok: false, reason: 'non-AOT fallback route unexpectedly carried hydration props', assertions }
    }
    assertions.push('no-stale-public-hydration-payload')

    return {
      ok: true,
      assertions,
      hasShell: Boolean(shell),
      shellKind: shell?.getAttribute('data-public-hydration-kind') ?? null,
      path: window.location.pathname,
      search: window.location.search,
    }
  }, {
    expectedKind: route.expectedKind,
  })
}

async function checkUnhydratedAotFallbackStructure(page, route) {
  return page.evaluate((input) => {
    const assertions = []
    const appRoots = Array.from(document.querySelectorAll('#app'))
    if (appRoots.length !== 1) return { ok: false, reason: `#app count mismatch: ${appRoots.length}`, assertions }
    assertions.push('single-app-root')

    const shells = Array.from(document.querySelectorAll('#app > #fsus-aot-shell'))
    if (shells.length !== 1) return { ok: false, reason: `#fsus-aot-shell count mismatch inside #app: ${shells.length}`, assertions }
    assertions.push('single-aot-shell')

    const shell = shells[0]
    const kind = shell.getAttribute('data-public-hydration-kind')
    if (kind !== input.expectedKind) {
      return { ok: false, reason: `AOT fallback shell kind mismatch: expected ${String(input.expectedKind)}, got ${String(kind)}`, assertions }
    }
    assertions.push('expected-hydration-kind')

    for (const id of ['fsus-aot-bootstrap', 'fsus-aot-hydration-props']) {
      const count = document.querySelectorAll(`#${id}`).length
      if (count > 1) {
        return { ok: false, reason: `${id} duplicate count: ${count}`, assertions }
      }
    }
    assertions.push('no-duplicate-public-payload-scripts')

    const managedHeadNodes = Array.from(document.head.querySelectorAll('[data-fsus-aot-head]'))
    const headKeys = managedHeadNodes.map((node) => [
      node.tagName,
      node.getAttribute('name') ?? '',
      node.getAttribute('property') ?? '',
      node.getAttribute('rel') ?? '',
      node.getAttribute('href') ?? '',
      node.getAttribute('content') ?? '',
    ].join('|'))
    const duplicateHeadKey = headKeys.find((key, index) => headKeys.indexOf(key) !== index)
    if (duplicateHeadKey) {
      return { ok: false, reason: `duplicate AOT-managed head node: ${duplicateHeadKey}`, assertions }
    }
    assertions.push('aot-head-nodes-unique')
    assertions.push('unhydrated-aot-fallback-shell')

    return {
      ok: true,
      assertions,
      shellKind: kind,
      path: window.location.pathname,
      search: window.location.search,
    }
  }, {
    expectedKind: route.expectedKind,
  })
}

async function assertHydratedRouteCell(page, route) {
  const structure = await checkShellStructure(page, {
    expectedKind: route.expectedKind,
    expectedRouteKey: route.expectedRouteKey ?? null,
    requireKind: true,
    requireHydrationMetrics: true,
  })
  if (!structure.ok) {
    throw new Error(structure.reason)
  }

  return {
    assertions: structure.assertions,
    metricsCount: structure.metricsCount,
  }
}

async function assertFallbackRouteCell(page, route) {
  const structure = await checkSpaFallbackStructure(page, route)
  if (!structure.ok) {
    throw new Error(structure.reason)
  }

  return {
    assertions: structure.assertions,
    hasShell: structure.hasShell,
    shellKind: structure.shellKind,
  }
}

async function assertUnhydratedAotFallbackRouteCell(page, route) {
  const structure = await checkUnhydratedAotFallbackStructure(page, route)
  if (!structure.ok) {
    throw new Error(structure.reason)
  }

  return {
    assertions: structure.assertions,
    shellKind: structure.shellKind,
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
  if (count === 0) {
    throw new Error(`missing public nav target: ${navKey}`)
  }

  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index)
    if (await candidate.isVisible()) {
      await candidate.click()
      await page.waitForURL((url) => url.pathname === expectedPath, { timeout: PUBLIC_RUNTIME_TIMEOUT_MS })
      await waitForRuntimeRoute(page, {
        pathname: expectedPath,
        expectedKind,
        requireKind: true,
        requireIdentity: false,
      })
      return
    }
  }

  await candidates.first().evaluate((element) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error('public nav target is not an HTMLElement')
    }
    element.click()
  })
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

async function tryClickFirstArticleLink(page) {
  const articleLinks = page.locator('a[data-public-link="article"]')
  if (await articleLinks.count() === 0) {
    return null
  }

  const articleLink = articleLinks.first()
  const href = await articleLink.getAttribute('href', { timeout: 1000 })
  if (!href) {
    return null
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
  const articleLinks = page.locator('a[data-public-link="article"]')
  const firstTitleText = await articleLinks.count() > 0
    ? (await articleLinks.first().textContent({ timeout: 1000 }))?.trim() || 'hydrate'
    : 'hydration'
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

function createListToArticlePhases(options = {}) {
  const {
    includeBackForward = false,
    includeTakeover = false,
  } = options

  return [
    {
      phase: 'atomic-navigation',
      run: async (page, helpers) => {
        const articlePath = await tryClickFirstArticleLink(page)
        if (!articlePath) {
          helpers.state.articlePath = null
          return {
            skipped: true,
            reason: 'route has no article links in the current fixture data',
            assertions: ['route-empty-list-covered'],
          }
        }

        helpers.state.articlePath = articlePath
        return {
          targetPath: articlePath,
          targetKind: 'ArticleDetail',
          assertions: ['atomic-public-route-takeover', 'spa-route-ready'],
        }
      },
    },
    includeBackForward
      ? {
          phase: 'browser-back-forward',
          run: async (page, helpers) => {
            const articlePath = helpers.state.articlePath
            if (!articlePath) {
              throw new Error('missing articlePath from atomic-navigation phase')
            }

            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 })
            await waitForRuntimeRoute(page, {
              pathname: helpers.routePathname,
              expectedKind: helpers.expectedKind,
              requireKind: true,
              requireIdentity: false,
            })
            await assertHydratedRouteCell(page, helpers.route)

            await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 })
            await waitForRuntimeRoute(page, {
              pathname: articlePath,
              expectedKind: 'ArticleDetail',
              requireKind: true,
              requireIdentity: false,
            })

            return {
              targetPath: articlePath,
              assertions: ['browser-back-restores-public-shell-route', 'browser-forward-restores-public-shell-route'],
            }
          },
        }
      : null,
    {
      phase: 'post-navigation-reload',
      run: async (_page, helpers) => {
        const articlePath = helpers.state.articlePath
        if (!articlePath) {
          return {
            skipped: true,
            reason: 'route has no article links in the current fixture data',
            assertions: ['route-empty-list-covered'],
          }
        }

        await helpers.reloadAndWaitForHydration('ArticleDetail', articlePath, { allowInitialSpaFallback: true })
        return {
          targetPath: articlePath,
          targetKind: 'ArticleDetail',
          assertions: ['post-navigation-reload-settled'],
        }
      },
    },
    includeTakeover
      ? {
          phase: 'full-spa-takeover',
          run: async (_page, helpers) => {
            const articlePath = helpers.state.articlePath
            if (!articlePath) {
              throw new Error('missing articlePath from atomic-navigation phase')
            }

            await helpers.triggerFullSpaTakeover('ArticleDetail', articlePath)
            return {
              targetPath: articlePath,
              targetKind: 'ArticleDetail',
              assertions: ['full-spa-takeover-public-shell'],
            }
          },
        }
      : null,
  ].filter(Boolean)
}

function createHomeNavigationPhases() {
  return [
    {
      phase: 'atomic-navigation',
      run: async (_page, helpers) => {
        await helpers.clickPublicNav('archive', '/archive', 'Archive')
        helpers.state.targetPath = '/archive'
        helpers.state.targetKind = 'Archive'
        return {
          targetPath: '/archive',
          targetKind: 'Archive',
          assertions: ['atomic-public-route-takeover', 'spa-route-ready'],
        }
      },
    },
    {
      phase: 'browser-back-forward',
      run: async (page, helpers) => {
        const targetPath = helpers.state.targetPath ?? '/archive'
        const targetKind = helpers.state.targetKind ?? 'Archive'

        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await waitForRuntimeRoute(page, {
          pathname: '/',
          expectedKind: 'Home',
          requireKind: true,
          requireIdentity: false,
        })
        await assertHydratedRouteCell(page, helpers.route)

        await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await waitForRuntimeRoute(page, {
          pathname: targetPath,
          expectedKind: targetKind,
          requireKind: true,
          requireIdentity: false,
        })

        return {
          targetPath,
          targetKind,
          assertions: ['browser-back-restores-public-shell-route', 'browser-forward-restores-public-shell-route'],
        }
      },
    },
    {
      phase: 'post-navigation-reload',
      run: async (_page, helpers) => {
        await helpers.reloadAndWaitForHydration('Archive', '/archive', {
          expectedRouteKey: 'archive',
        })
        return {
          targetPath: '/archive',
          targetKind: 'Archive',
          assertions: ['post-navigation-reload-settled'],
        }
      },
    },
    {
      phase: 'full-spa-takeover',
      run: async (_page, helpers) => {
        await helpers.triggerFullSpaTakeover('Archive', '/archive')
        return {
          targetPath: '/archive',
          targetKind: 'Archive',
          assertions: ['full-spa-takeover-public-shell'],
        }
      },
    },
  ]
}

function createStaticPagePhases() {
  return [
    {
      phase: 'hash-navigation',
      run: async (page, helpers) => {
        await page.evaluate(() => {
          window.location.hash = '#main-content'
        })
        await page.waitForFunction(() => window.location.hash === '#main-content', {
          timeout: PUBLIC_RUNTIME_TIMEOUT_MS,
        })
        await assertHydratedRouteCell(page, helpers.route)
        return {
          hash: '#main-content',
          assertions: ['hash-navigation-preserves-public-shell'],
        }
      },
    },
    {
      phase: 'atomic-navigation',
      run: async (_page, helpers) => {
        await helpers.clickPublicNav('home', '/', 'Home')
        return {
          targetPath: '/',
          targetKind: 'Home',
          assertions: ['atomic-public-route-takeover'],
        }
      },
    },
  ]
}

async function interactSearchScenario(page, helpers) {
  const mode = await searchFromHome(page)
  if (mode === 'takeover') {
    return {
      mode,
      assertions: ['search-focus-triggers-safe-takeover'],
    }
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForURL((url) => url.pathname === '/search' && url.searchParams.get('q')?.length > 0, {
    timeout: PUBLIC_RUNTIME_TIMEOUT_MS,
  })
  const vueReady = await waitForVueMount(page, PUBLIC_RUNTIME_TIMEOUT_MS)
  if (!vueReady) {
    throw new Error('Vue did not mount within timeout after search route reload')
  }

  await assertFallbackRouteCell(page, { ...helpers.route, expectSpaFallback: true, expectedKind: null })
  return {
    mode,
    assertions: ['search-route-spa-fallback', 'no-wrong-aot-kind'],
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
  return {
    assertions: ['full-spa-takeover-public-shell', 'takeover-keeps-ssr-shell-identity'],
  }
}

async function runScenario(page, baseUrl, route) {
  const recorder = createHydrationIssueRecorder(page)
  const phaseResults = []
  const routeUrl = new URL(route.route, baseUrl)
  const routePathname = routeUrl.pathname

  async function runPhase(phase, operation, options = {}) {
    const stage = `${route.name}:${phase}`
    recorder.setStage(stage)
    try {
      const result = await operation()
      phaseResults.push(createPhaseResult(route, phase, 'success', {
        stage,
        assertions: normalizeAssertions(result),
        details: normalizePhaseDetails(result),
      }))
      return { ok: true, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      recorder.recordIssue('error', `${phase} failed: ${message}`, stage)
      phaseResults.push(createPhaseResult(route, phase, 'failure', {
        stage,
        error: message,
      }))
      if (options.stopOnFailure !== false) {
        return { ok: false, error: err }
      }
      return { ok: false, error: err }
    }
  }

  const helpers = {
    name: route.name,
    route,
    routePathname,
    expectedKind: route.expectedKind,
    state: {},
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
            expectedRouteKey: options.expectedRouteKey ?? null,
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

  const direct = await runPhase('direct-first-load', async () => {
    await page.goto(`${baseUrl}${route.route}`, { waitUntil: route.directWaitUntil || 'networkidle', timeout: 30000 })

    if (route.expectSpaFallback) {
      return await assertFallbackRouteCell(page, route)
    }

    const hydrationTimeout = route.allowUnhydratedAotFallback || route.allowSpaFallback
      ? Math.min(PUBLIC_HYDRATION_TIMEOUT_MS, 3000)
      : PUBLIC_HYDRATION_TIMEOUT_MS
    try {
      await waitForPublicHydration(page, route.expectedKind, hydrationTimeout)
    } catch (err) {
      if (route.allowUnhydratedAotFallback) {
        try {
          const fallback = await assertUnhydratedAotFallbackRouteCell(page, route)
          return {
            ...fallback,
            fallbackReason: err instanceof Error ? err.message : String(err),
          }
        } catch (fallbackErr) {
          if (!route.allowSpaFallback) {
            throw fallbackErr
          }
        }
      }
      if (route.allowSpaFallback) {
        const fallback = await assertFallbackRouteCell(page, route)
        return {
          ...fallback,
          fallbackReason: err instanceof Error ? err.message : String(err),
        }
      }
      throw err
    }

    return await assertHydratedRouteCell(page, route)
  })
  if (!direct.ok) {
    return { issues: recorder.issues, phaseResults }
  }

  const reload = await runPhase('reload', async () => {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })

    if (route.expectSpaFallback) {
      const vueReady = await waitForVueMount(page, PUBLIC_RUNTIME_TIMEOUT_MS)
      if (!vueReady) {
        throw new Error('Vue did not mount within timeout after fallback reload')
      }
      return await assertFallbackRouteCell(page, route)
    }

    const hydrationTimeout = route.allowUnhydratedAotFallback || route.allowSpaFallback
      ? Math.min(PUBLIC_HYDRATION_TIMEOUT_MS, 3000)
      : PUBLIC_HYDRATION_TIMEOUT_MS
    try {
      await waitForPublicHydration(page, route.expectedKind, hydrationTimeout)
    } catch (err) {
      if (route.allowUnhydratedAotFallback) {
        try {
          const fallback = await assertUnhydratedAotFallbackRouteCell(page, route)
          return {
            ...fallback,
            fallbackReason: err instanceof Error ? err.message : String(err),
          }
        } catch (fallbackErr) {
          if (!route.allowSpaFallback) {
            throw fallbackErr
          }
        }
      }
      if (route.allowSpaFallback) {
        const fallback = await assertFallbackRouteCell(page, route)
        return {
          ...fallback,
          fallbackReason: err instanceof Error ? err.message : String(err),
        }
      }
      throw err
    }

    return await assertHydratedRouteCell(page, route)
  })
  if (!reload.ok) {
    return { issues: recorder.issues, phaseResults }
  }

  if ((route.expectSpaFallback || route.allowSpaFallback) && (direct.result?.hasShell === false || reload.result?.hasShell === false)) {
    return { issues: recorder.issues, phaseResults }
  }

  for (const phase of route.phases ?? []) {
    const result = await runPhase(phase.phase, async () => await phase.run(page, helpers), {
      stopOnFailure: phase.stopOnFailure !== false,
    })
    if (!result.ok && phase.stopOnFailure !== false) {
      break
    }
  }

  return { issues: recorder.issues, phaseResults }
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
  let phaseResults = []
  try {
    const result = await runScenario(page, baseUrl, route)
    issues = result.issues
    phaseResults = result.phaseResults
  } finally {
    await context.close()
    await browser.close()
  }
  return { issues, phaseResults }
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

async function readBinaryEndpoint(baseUrl, path) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: 'application/vnd.fsus.aeds,application/octet-stream',
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      return null
    }

    return await readAedsResponse(response)
  } catch {
    return null
  }
}

async function resolvePublicTagName(baseUrl, tagId) {
  const tagList = await readBinaryEndpoint(baseUrl, '/api/binary/tag.aeds')
  if (!Array.isArray(tagList)) {
    return ''
  }

  const tag = tagList.find((entry) => Number(entry?.id) === Number(tagId)) ?? tagList[0]
  return String(tag?.name ?? '').trim()
}

async function buildPublicHydrationScenarios(baseUrl) {
  const scenarios = [...PUBLIC_SEO_SCENARIOS, ...PUBLIC_INTERACTION_ONLY_SCENARIOS]
  const tagName = await resolvePublicTagName(baseUrl, publicFixtureIds.tagId)
  if (tagName) {
    scenarios.splice(
      scenarios.findIndex((scenario) => scenario.name === 'invalid-category-fallback'),
      0,
      {
        name: 'tag-name',
        route: `/tag/${encodeURIComponent(tagName)}`,
        expectedKind: 'Filter',
        expectedRouteKey: `tag-name:${tagName}`,
        phases: createListToArticlePhases(),
      }
    )
  }

  return scenarios
}

async function main() {
  const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
  const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]
  const scenarios = await buildPublicHydrationScenarios(baseUrl)
  const routeMatrix = assertScenarioCoverageAgainstPublicPageManifest(scenarios)
  const summary = {
    schema: PUBLIC_HYDRATION_DETECTOR_SCHEMA,
    routePhaseMatrixSchema: PUBLIC_HYDRATION_ROUTE_PHASE_MATRIX_SCHEMA,
    status: 'failure',
    baseUrl,
    generatedAt: new Date().toISOString(),
    fatalHydrationIssueCount: 0,
    routeMatrix,
    phaseResults: [],
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
      const label = `[${vp.name} ${route.name} ${route.route}]`
      process.stdout.write(`Testing ${label}... `)
      const result = await runRoute(baseUrl, route, { width: vp.width, height: vp.height })
      const { issues, phaseResults } = result

      const fatalHydrationIssues = issues.filter((i) => i.isFatalHydrationIssue)
      const warnings = fatalHydrationIssues.filter((i) => i.type === 'warning')
      const errors = fatalHydrationIssues.filter((i) => i.type === 'error')
      summary.warnings.push(...warnings.map((issue) => issueWithContext(issue, route, vp)))
      summary.errors.push(...errors.map((issue) => issueWithContext(issue, route, vp)))
      summary.phaseResults.push(...phaseResults.map((phase) => phaseWithContext(phase, route, vp)))
      summary.routesChecked.push({
        route: route.route,
        routeName: route.name,
        stage: 'route:complete',
        expectedKind: route.expectedKind,
        expectedRouteKey: route.expectedRouteKey ?? null,
        browser: PUBLIC_HYDRATION_BROWSER,
        viewport: {
          name: vp.name,
          width: vp.width,
          height: vp.height,
        },
        status: fatalHydrationIssues.length === 0 ? 'success' : 'failure',
        fatalHydrationIssueCount: fatalHydrationIssues.length,
        phaseCount: phaseResults.length,
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
