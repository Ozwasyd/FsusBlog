#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { decodePublicAotPayload } from '../../support/aeds-envelope.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))

const CLOCK_MATRIX_SCHEMA = 'fsusblog.public-hydration-clock-matrix.v1'
const CLOCK_MATRIX_SUMMARY_FILE = process.env.FSUSBLOG_PUBLIC_HYDRATION_CLOCK_SUMMARY_FILE
  || fileURLToPath(new URL('../../../../.tmp/release-evidence/public-hydration-clock-matrix-summary.json', import.meta.url))
const PUBLIC_SSR_BUNDLE_FILE = fileURLToPath(new URL('../../../../src/frontend/dist/server/public-ssr.mjs', import.meta.url))
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

const CLOCK_CASES = [
  {
    id: 'stable-noon-utc-zh',
    ssrClock: '2026-06-16T12:00:00.000Z',
    hydrationClock: '2026-06-16T12:00:00.000Z',
    serverTimeZone: 'UTC',
    browserTimeZone: 'UTC',
    locale: 'zh-CN',
    complianceStartYear: null,
  },
  {
    id: 'cross-minute-shanghai-to-new-york',
    ssrClock: '2026-06-16T15:59:30.000Z',
    hydrationClock: '2026-06-16T16:00:40.000Z',
    serverTimeZone: 'Asia/Shanghai',
    browserTimeZone: 'America/New_York',
    locale: 'en-US',
    complianceStartYear: 2024,
  },
  {
    id: 'cross-year-footer',
    ssrClock: '2026-12-31T23:59:59.000Z',
    hydrationClock: '2027-01-01T00:00:01.000Z',
    serverTimeZone: 'UTC',
    browserTimeZone: 'Asia/Shanghai',
    locale: 'zh-CN',
    complianceStartYear: 2024,
  },
  {
    id: 'near-midnight-plus-fifteen-minutes',
    ssrClock: '2026-06-16T23:59:30.000Z',
    hydrationClock: '2026-06-17T00:14:30.000Z',
    serverTimeZone: 'Asia/Shanghai',
    browserTimeZone: 'UTC',
    locale: 'en-US',
    complianceStartYear: 2026,
  },
]

const ARTICLE_TIMESTAMPS = [
  { label: 'just-now', offsetSeconds: 0 },
  { label: 'fifty-nine-seconds', offsetSeconds: 59 },
  { label: 'sixty-one-seconds', offsetSeconds: 61 },
  { label: 'twenty-three-hours-fifty-nine-minutes', offsetSeconds: 23 * 60 * 60 + 59 * 60 },
  { label: 'previous-year', timestamp: '2025-12-31T12:00:00.000Z' },
]

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function installSsrDomGlobals() {
  if (typeof globalThis.Element === 'undefined') {
    globalThis.Element = class Element {}
  }
  if (typeof globalThis.HTMLElement === 'undefined') {
    globalThis.HTMLElement = class HTMLElement extends globalThis.Element {}
  }
  if (typeof globalThis.SVGElement === 'undefined') {
    globalThis.SVGElement = class SVGElement extends globalThis.Element {}
  }
  if (typeof globalThis.ShadowRoot === 'undefined') {
    globalThis.ShadowRoot = class ShadowRoot extends globalThis.Element {}
  }
}

function writeSummary(summary) {
  mkdirSync(dirname(CLOCK_MATRIX_SUMMARY_FILE), { recursive: true })
  writeFileSync(CLOCK_MATRIX_SUMMARY_FILE, `${JSON.stringify(summary, null, 2)}\n`)
}

function isoMinusSeconds(baseIso, seconds) {
  return new Date(new Date(baseIso).getTime() - seconds * 1000).toISOString()
}

function createCompliance(startYear) {
  return {
    enabled: true,
    regionMode: 'global',
    copyrightOwner: 'FsusBlog',
    copyrightStartYear: startYear,
    copyrightText: 'All rights reserved.',
    contentLicenseName: '',
    contentLicenseUrl: '',
    icpRecordNumber: '',
    icpRecordUrl: '',
    policeRecordNumber: '',
    policeRecordUrl: '',
    policeBadgeIconUrl: '',
    operatorName: '',
    contactEmail: '',
  }
}

function createArticleOptions(clockCase, timestampCase) {
  const createTime = timestampCase.timestamp ?? isoMinusSeconds(clockCase.ssrClock, timestampCase.offsetSeconds)
  return {
    id: 4201,
    title: `Clock matrix article ${timestampCase.label}`,
    summary: 'Clock matrix summary',
    bodyContent: '# Clock Matrix\n\nThis fixture keeps public AOT time rendering deterministic.',
    createTime,
    category: { id: 7, name: 'Clock' },
    tags: [{ id: 9, name: 'hydration' }],
    authorName: 'Clock Harness',
    relatedReading: {
      related: [
        {
          id: 4202,
          title: 'Related clock boundary',
          summary: 'Related reading summary',
          createTime: isoMinusSeconds(clockCase.ssrClock, 70),
          reason: 'related',
        },
      ],
      previous: null,
      next: {
        id: 4203,
        title: 'Next clock boundary',
        summary: 'Next summary',
        createTime: isoMinusSeconds(clockCase.ssrClock, 15 * 60),
        reason: 'next',
      },
    },
  }
}

function createEntryOptions(clockCase, kind, timestampCase = ARTICLE_TIMESTAMPS[0]) {
  const common = {
    siteTitle: 'FsusBlog Clock Matrix',
    siteDescription: 'Deterministic public AOT clock matrix.',
    baseUrl: 'https://fsus.blog',
    renderTimestamp: clockCase.ssrClock,
    compliance: createCompliance(clockCase.complianceStartYear),
  }

  if (kind === 'ArticleDetail') {
    return {
      ...common,
      ...createArticleOptions(clockCase, timestampCase),
    }
  }

  if (kind === 'Archive') {
    return {
      ...common,
      title: 'Archive',
      total: ARTICLE_TIMESTAMPS.length,
      articles: ARTICLE_TIMESTAMPS.map((timestamp, index) => ({
        id: 5000 + index,
        title: `Archive ${timestamp.label}`,
        summary: 'Archive clock boundary',
        createTime: timestamp.timestamp ?? isoMinusSeconds(clockCase.ssrClock, timestamp.offsetSeconds),
        category: { id: 8, name: 'Archive' },
        tags: [],
      })),
    }
  }

  return {
    ...common,
    title: kind === 'About' ? 'About' : 'Copyright',
    slug: kind === 'About' ? 'about' : 'copyright',
    content: 'Clock matrix static content for {{year}}.',
  }
}

function buildDocument(entry, clockCase) {
  return `<!doctype html>
<html lang="${clockCase.locale}">
<head>
  <meta charset="utf-8">
  <title>${entry.title ?? 'Clock matrix'}</title>
</head>
<body>
  <div id="app">${entry.html}</div>
  <script id="fsus-aot-bootstrap" type="application/octet-stream">${entry.bootstrapPayload}</script>
  <script id="fsus-aot-hydration-props" type="application/octet-stream">${entry.hydrationPropsPayload}</script>
</body>
</html>`
}

function freezeClockScript(hydrationClock) {
  return `
(() => {
  const fixed = new Date(${JSON.stringify(hydrationClock)}).getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixed] : args));
    }
    static now() {
      return fixed;
    }
  }
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.prototype = RealDate.prototype;
  Object.defineProperty(FrozenDate, 'name', { value: 'Date' });
  globalThis.Date = FrozenDate;
})();
`
}

async function loadSsrBundle() {
  assert(existsSync(PUBLIC_SSR_BUNDLE_FILE), `missing public SSR bundle: ${PUBLIC_SSR_BUNDLE_FILE}`)
  installSsrDomGlobals()
  const bundle = await import(pathToFileURL(PUBLIC_SSR_BUNDLE_FILE).href)
  assert(typeof bundle.buildPublicEntry === 'function', 'public SSR bundle missing buildPublicEntry')
  return bundle
}

async function buildEntryWithServerTimeZone(bundle, clockCase, kind, timestampCase) {
  const previousTimeZone = process.env.TZ
  process.env.TZ = clockCase.serverTimeZone
  try {
    const result = await bundle.buildPublicEntry(kind, createEntryOptions(clockCase, kind, timestampCase))
    return result.entry
  } finally {
    if (previousTimeZone == null) {
      delete process.env.TZ
    } else {
      process.env.TZ = previousTimeZone
    }
  }
}

async function inspectEntryInBrowser(entry, clockCase, kind) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(executablePath ? { executablePath } : {}),
  })
  const context = await browser.newContext({
    timezoneId: clockCase.browserTimeZone,
    locale: clockCase.locale,
    javaScriptEnabled: true,
  })
  await context.addInitScript(freezeClockScript(clockCase.hydrationClock))
  const page = await context.newPage()
  const consoleIssues = []
  page.on('console', (msg) => {
    const text = msg.text()
    const type = msg.type()
    if ((type === 'warning' || type === 'warn' || type === 'error') && /hydration|mismatch|public-hydrat/i.test(text)) {
      consoleIssues.push({ type, text })
    }
  })

  try {
    await page.setContent(buildDocument(entry, clockCase), { waitUntil: 'domcontentloaded' })
    const snapshot = await page.evaluate(() => {
      const timeNodes = Array.from(document.querySelectorAll('time')).map((node) => ({
        text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
        title: node.getAttribute('title') ?? '',
        datetime: node.getAttribute('datetime') ?? '',
      }))
      return {
        now: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        appCount: document.querySelectorAll('#app').length,
        shellKind: document.querySelector('#app > #fsus-aot-shell')?.getAttribute('data-public-hydration-kind') ?? null,
        timeNodes,
        footerText: document.querySelector('.el-public-shell__footer')?.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      }
    })
    await page.waitForTimeout(50)
    const after = await page.evaluate(() => Array.from(document.querySelectorAll('time')).map((node) => ({
      text: node.textContent?.replace(/\s+/gu, ' ').trim() ?? '',
      title: node.getAttribute('title') ?? '',
      datetime: node.getAttribute('datetime') ?? '',
    })))

    assert(snapshot.now === clockCase.hydrationClock, `${clockCase.id}/${kind} browser Date.now was not frozen: ${snapshot.now}`)
    assert(snapshot.timeZone === clockCase.browserTimeZone, `${clockCase.id}/${kind} browser timezone mismatch: ${snapshot.timeZone}`)
    assert(snapshot.appCount === 1, `${clockCase.id}/${kind} #app count mismatch`)
    assert(snapshot.shellKind === kind, `${clockCase.id}/${kind} shell kind mismatch: ${snapshot.shellKind}`)
    assert(JSON.stringify(snapshot.timeNodes) === JSON.stringify(after), `${clockCase.id}/${kind} visible time nodes changed during hydration-start window`)
    assert(consoleIssues.length === 0, `${clockCase.id}/${kind} hydration console issue: ${consoleIssues[0]?.text}`)

    return snapshot
  } finally {
    await context.close()
    await browser.close()
  }
}

async function runCase(bundle, clockCase) {
  const rows = []
  for (const kind of ['About', 'Copyright', 'Archive']) {
    const entry = await buildEntryWithServerTimeZone(bundle, clockCase, kind)
    const hydrationPayload = decodePublicAotPayload(entry.hydrationPropsPayload)
    assert(hydrationPayload?.renderTimestamp === clockCase.ssrClock, `${clockCase.id}/${kind} renderTimestamp missing from hydration payload`)
    assert(hydrationPayload?.renderTimeZone === 'UTC', `${clockCase.id}/${kind} renderTimeZone missing from hydration payload`)
    const browserSnapshot = await inspectEntryInBrowser(entry, clockCase, kind)
    rows.push({
      kind,
      routeKey: entry.routeKey,
      renderTimestamp: hydrationPayload.renderTimestamp,
      renderYear: hydrationPayload.renderYear,
      renderTimeZone: hydrationPayload.renderTimeZone,
      timeNodeCount: browserSnapshot.timeNodes.length,
      footerText: browserSnapshot.footerText,
    })
  }

  for (const timestampCase of ARTICLE_TIMESTAMPS) {
    const entry = await buildEntryWithServerTimeZone(bundle, clockCase, 'ArticleDetail', timestampCase)
    const hydrationPayload = decodePublicAotPayload(entry.hydrationPropsPayload)
    assert(hydrationPayload?.renderTimestamp === clockCase.ssrClock, `${clockCase.id}/ArticleDetail/${timestampCase.label} renderTimestamp missing from hydration payload`)
    assert(hydrationPayload?.detailView?.header?.meta?.fullTime, `${clockCase.id}/ArticleDetail/${timestampCase.label} missing article full time`)
    assert(hydrationPayload?.detailView?.relatedReading, `${clockCase.id}/ArticleDetail/${timestampCase.label} missing related reading`)
    const relatedTimes = [
      hydrationPayload.detailView.relatedReading.previous?.displayTime,
      hydrationPayload.detailView.relatedReading.next?.displayTime,
      ...(hydrationPayload.detailView.relatedReading.items ?? []).map((item) => item.displayTime),
    ].filter(Boolean)
    assert(relatedTimes.length > 0, `${clockCase.id}/ArticleDetail/${timestampCase.label} missing related reading time labels`)
    const browserSnapshot = await inspectEntryInBrowser(entry, clockCase, 'ArticleDetail')
    assert(browserSnapshot.timeNodes.length > 0, `${clockCase.id}/ArticleDetail/${timestampCase.label} missing visible <time> coverage`)
    rows.push({
      kind: 'ArticleDetail',
      timestampCase: timestampCase.label,
      routeKey: entry.routeKey,
      renderTimestamp: hydrationPayload.renderTimestamp,
      renderYear: hydrationPayload.renderYear,
      renderTimeZone: hydrationPayload.renderTimeZone,
      articleFullTime: hydrationPayload.detailView.header.meta.fullTime,
      relatedTimes,
      timeNodeCount: browserSnapshot.timeNodes.length,
    })
  }

  return {
    ...clockCase,
    status: 'success',
    rows,
  }
}

async function main() {
  const summary = {
    schema: CLOCK_MATRIX_SCHEMA,
    status: 'failure',
    generatedAt: new Date().toISOString(),
    cases: [],
  }

  try {
    const bundle = await loadSsrBundle()
    for (const clockCase of CLOCK_CASES) {
      process.stdout.write(`Testing clock matrix ${clockCase.id}... `)
      const result = await runCase(bundle, clockCase)
      summary.cases.push(result)
      process.stdout.write('PASS\n')
    }
    summary.status = 'success'
    writeSummary(summary)
    console.log(`[public-clock-hydration] ok (${summary.cases.length} case(s)); summary=${CLOCK_MATRIX_SUMMARY_FILE}`)
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error)
    writeSummary(summary)
    console.error(`[public-clock-hydration] failed: ${summary.error}`)
    process.exit(1)
  }
}

main()
