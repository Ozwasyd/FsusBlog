import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildInventoryReport,
  collectSearchConsole,
  collectUrlInventory,
  evaluateReleaseGate,
  experimentRegistrySchema,
  importCrawlerEvents,
  inventoryReportSchema,
  scanEvidenceForSecrets,
  validateExperimentRegistry,
  writeJson
} from '../../tools/seo/measurement-lib.mjs'

const site = 'https://fsus.blog/'
const now = new Date('2026-07-15T00:00:00.000Z')
const measurementFixture = JSON.parse(readFileSync(new URL('./fixtures/seo/measurement-input.json', import.meta.url), 'utf8'))

function credential() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    client_email: 'collector@example.invalid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth.example.invalid/token'
  }
}

function response(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

test('Search Console collector paginates, samples inspection quota and exposes lag/partial coverage', async () => {
  let analyticsCalls = 0
  const fetchImpl = async (url, options = {}) => {
    if (url === 'https://oauth.example.invalid/token') return response(200, { access_token: 'not-exported' })
    if (String(url).includes('/searchAnalytics/query')) {
      analyticsCalls += 1
      const request = JSON.parse(options.body)
      assert.deepEqual(request.dimensions, ['date', 'page', 'query', 'device', 'country'])
      if (request.startRow === 0) {
        return response(200, { rows: [
          { keys: ['2026-07-10', 'https://fsus.blog/article/1', 'alpha', 'MOBILE', 'chn'], clicks: 1, impressions: 10, ctr: 0.1, position: 3 },
          { keys: ['2026-07-11', 'https://fsus.blog/article/1', 'beta', 'DESKTOP', 'usa'], clicks: 0, impressions: 4, ctr: 0, position: 8 }
        ] })
      }
      return response(200, { rows: [
        { keys: ['2026-07-12', 'https://fsus.blog/article/2', 'gamma', 'MOBILE', 'chn'], clicks: 2, impressions: 12, ctr: 1 / 6, position: 2 }
      ] })
    }
    if (String(url).endsWith('/sitemaps')) return response(200, { sitemap: [{ path: 'https://fsus.blog/sitemap.xml', isPending: false }] })
    if (String(url).includes('urlInspection')) {
      const inspectionUrl = JSON.parse(options.body).inspectionUrl
      if (inspectionUrl.endsWith('/article/2')) return response(429, { error: 'quota' }, { 'retry-after': '60' })
      return response(200, { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', googleCanonical: inspectionUrl, userCanonical: inspectionUrl, lastCrawlTime: '2026-07-13T00:00:00Z' } } })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const snapshot = await collectSearchConsole({
    siteUrl: site,
    startDate: '2026-07-01',
    endDate: '2026-07-14',
    credential: credential(),
    inspectionUrls: ['/article/1', '/article/2', '/article/3'],
    inspectionLimit: 2,
    rowLimit: 2,
    fetchImpl,
    now
  })

  assert.equal(analyticsCalls, 2)
  assert.equal(snapshot.status, 'partial')
  assert.equal(snapshot.dataCutoff, '2026-07-12')
  assert.equal(snapshot.coverage.realtime, false)
  assert.equal(snapshot.coverage.urlInspection, 'sampled-partial')
  assert.equal(snapshot.coverage.inspectionRequested, 2)
  assert.equal(snapshot.coverage.inspectionCompleted, 1)
  assert.equal(snapshot.errors[0].category, 'quota-exhausted')
  assert.doesNotMatch(JSON.stringify(snapshot), /not-exported|PRIVATE KEY|collector@example/u)
})

test('Search Console permission failure is represented as blocked evidence, never empty success', async () => {
  const snapshot = await collectSearchConsole({
    siteUrl: site,
    startDate: '2026-07-01',
    endDate: '2026-07-14',
    credential: credential(),
    fetchImpl: async url => url === 'https://oauth.example.invalid/token'
      ? response(200, { access_token: 'ephemeral' })
      : response(403, { error: 'permission denied' }),
    now
  })
  assert.equal(snapshot.status, 'blocked')
  assert.equal(snapshot.rows.length, 0)
  assert.ok(snapshot.errors.every(error => error.category === 'permission-denied'))
  assert.equal(snapshot.dataCutoff, null)
})

test('Search Console empty response remains explicit delayed evidence and cannot pass a release gate', async () => {
  const snapshot = await collectSearchConsole({
    siteUrl: site,
    startDate: '2026-07-01',
    endDate: '2026-07-14',
    credential: credential(),
    fetchImpl: async url => {
      if (url === 'https://oauth.example.invalid/token') return response(200, { access_token: 'ephemeral' })
      if (String(url).includes('/searchAnalytics/query')) return response(200, { rows: [] })
      if (String(url).endsWith('/sitemaps')) return response(200, { sitemap: [] })
      throw new Error(`unexpected URL ${url}`)
    },
    now
  })
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.dataCutoff, null)
  assert.equal(snapshot.coverage.realtime, false)
  assert.match(snapshot.limitations.join('\n'), /delayed|not a full-site index census/u)
  const gate = evaluateReleaseGate({
    searchConsole: snapshot,
    crawler: measurementFixture.crawler,
    report: { schema: inventoryReportSchema, status: 'ok' },
    registry: { schema: experimentRegistrySchema, experiments: [] },
    release: 'v1',
    commit: 'a'.repeat(40),
    now
  })
  assert.equal(gate.status, 'blocked')
  assert.match(gate.errors.join('\n'), /cutoff\/lag/u)
})

test('deleted or invalid Search Console credential degrades to blocked local evidence without API access', async () => {
  let called = false
  const snapshot = await collectSearchConsole({
    siteUrl: site,
    startDate: '2026-07-01',
    endDate: '2026-07-14',
    credential: {},
    fetchImpl: async () => { called = true; throw new Error('must not call') },
    now
  })
  assert.equal(called, false)
  assert.equal(snapshot.status, 'blocked')
  assert.equal(snapshot.rows.length, 0)
  assert.equal(snapshot.coverage.realtime, false)
})

test('live URL inventory follows same-origin sitemap and records canonical, AOT, redirect and internal links', async () => {
  const fetchImpl = async url => {
    if (url === 'https://fsus.blog/sitemap.xml') {
      return new Response('<?xml version="1.0"?><urlset><url><loc>https://fsus.blog/article/1-old</loc><lastmod>2026-07-10</lastmod></url></urlset>', { status: 200 })
    }
    if (url === 'https://fsus.blog/article/1-old') {
      return {
        ok: true,
        status: 200,
        url: 'https://fsus.blog/article/1',
        headers: new Headers({ 'content-type': 'text/html', 'x-fsus-public-aot-source': 'server-ssr', 'x-fsus-public-aot-state': 'ready' }),
        async text() { return '<html><head><link rel="canonical" href="https://fsus.blog/article/1"></head><body><a href="/article/1-old">old</a></body></html>' }
      }
    }
    throw new Error(`unexpected URL ${url}`)
  }
  const inventory = await collectUrlInventory({ siteUrl: site, fetchImpl })
  assert.equal(inventory.source, 'live-sitemap-and-public-html-probe')
  assert.equal(inventory.urls[0].canonicalUrl, 'https://fsus.blog/article/1')
  assert.equal(inventory.urls[0].redirectSource, 'https://fsus.blog/article/1-old')
  assert.equal(inventory.urls[0].aotSource, 'server-ssr')
  assert.deepEqual(inventory.urls[0].internalLinks, ['https://fsus.blog/article/1-old'])
  assert.equal(inventory.urls[0].soft404, false)
})

test('crawler import requires UA plus reverse/forward DNS, caches DNS and removes raw IP', async () => {
  let reverseCalls = 0
  let lookupCalls = 0
  const resolver = {
    async reverse(ip) {
      reverseCalls += 1
      if (ip === '203.0.113.10') return ['crawl-203-0-113-10.googlebot.com']
      throw new Error('PTR unavailable')
    },
    async lookup() {
      lookupCalls += 1
      return [{ address: '203.0.113.10', family: 4 }]
    }
  }
  const base = {
    timestamp: '2026-07-14T10:00:00Z', url: '/article/1?email=user@example.com', status: 200, method: 'GET',
    responseSource: 'public-aot', latencyMs: 12, bytes: 4096, release: 'v1', commit: 'a'.repeat(40)
  }
  const snapshot = await importCrawlerEvents([
    { ...base, ip: '203.0.113.10', userAgent: 'Googlebot/2.1' },
    { ...base, url: '/article/1?page=2', canonicalUrl: '/article/1?page=2', ip: '203.0.113.10', userAgent: 'Googlebot/2.1' },
    { ...base, ip: '203.0.113.11', userAgent: 'Googlebot/2.1' },
    { ...base, ip: '203.0.113.10', userAgent: 'ordinary browser' }
  ], { resolver, ipHashKey: Buffer.alloc(32, 7), siteUrl: site, now })

  assert.equal(snapshot.coverage.verifiedEvents, 2)
  assert.equal(snapshot.coverage.rejectedEvents, 2)
  assert.equal(reverseCalls, 2)
  assert.equal(lookupCalls, 1)
  assert.equal(snapshot.events[0].ipHash.length, 64)
  assert.doesNotMatch(JSON.stringify(snapshot), /203\.0\.113\./u)
  assert.doesNotMatch(JSON.stringify(snapshot), /user@example/u)
  assert.match(snapshot.events[0].url, /email=sha256-/u)
  assert.equal(snapshot.events[0].canonicalUrl, 'https://fsus.blog/article/1')
  assert.equal(snapshot.events[0].requestCanonical, false)
  assert.equal(snapshot.events[1].canonicalUrl, 'https://fsus.blog/article/1?page=2')
  assert.equal(snapshot.events[1].requestCanonical, true)
  assert.match(snapshot.events[1].url, /page=sha256-/u)
  assert.equal(snapshot.rejectedByReason['dns-verification-failed'], 1)
  assert.equal(snapshot.rejectedByReason['user-agent-not-googlebot'], 1)
  await assert.rejects(importCrawlerEvents([], { resolver, ipHashKey: Buffer.alloc(8), siteUrl: site, now }), /at least 32 bytes/u)
  const malformed = await importCrawlerEvents([{ ...base, timestamp: 'not-a-date', ip: '203.0.113.10', userAgent: 'Googlebot/2.1' }], { resolver, ipHashKey: Buffer.alloc(32, 7), siteUrl: site, now })
  assert.deepEqual(malformed.rejectedByReason, { 'event-fields-invalid': 1 })
})

function snapshots() {
  return structuredClone({ searchConsole: measurementFixture.searchConsole, crawler: measurementFixture.crawler })
}

test('URL inventory distinguishes crawl, index, canonical, impression and AOT anomalies', () => {
  const { searchConsole, crawler } = snapshots()
  const report = buildInventoryReport({
    inventory: structuredClone(measurementFixture.inventory),
    searchConsole,
    crawler,
    experiments: [],
    now
  })
  assert.equal(report.schema, inventoryReportSchema)
  assert.equal(report.urls.length, 2)
  assert.equal(report.freshness.realtime, false)
  assert.equal(report.sitemaps.length, 0)
  assert.deepEqual(report.urls[0].states, ['canonical-conflict', 'no-clicks'])
  assert.equal(report.urls[0].inventoryEntries, 2)
  assert.deepEqual(report.urls[0].redirectSources, ['https://fsus.blog/article/1-old'])
  assert.deepEqual(report.urls[0].sitemapSources, ['https://fsus.blog/sitemap.xml'])
  assert.equal(report.urls[0].aotState, 'ready')
  assert.deepEqual(report.urls[0].searchPerformance, { rows: 1, firstDate: '2026-07-12', lastDate: '2026-07-12', impressions: 4, clicks: 0, ctr: 0, averagePosition: 8 })
  assert.ok(report.urls[1].states.includes('not-crawled'))
  assert.ok(report.urls[1].states.includes('not-indexed'))
  const codes = new Set(report.diagnostics.map(item => item.code))
  for (const code of ['crawl-200-soft-404', 'canonical-conflict', 'sitemap-without-crawl', 'crawler-aot-cold-or-503-exposure', 'lastmod-after-last-crawl', 'crawler-invalid-or-extra-path', 'crawler-noncanonical-or-parameter-path']) assert.ok(codes.has(code), code)
  assert.equal(report.crawlerBreakdown['v1@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:200:public-aot'], 2)
  assert.match(report.causality.statement, /not declared ranking factors/u)
})

test('experiment governance blocks invalid definitions and withholds benefit conclusion before window', () => {
  const registry = {
    schema: experimentRegistrySchema,
    experiments: [{
      id: 'seo-canonical-a', hypothesis: 'canonical convergence improves indexed coverage', design: 'matched-control',
      cohort: { urls: ['/article/1'], controlUrls: ['/article/2'] }, release: 'v1', commit: 'a'.repeat(40),
      startDate: '2026-07-10', primaryMetric: 'indexed coverage', guardrails: ['dwell completion'],
      minimumObservationDays: 14, rollbackCondition: 'crawler 5xx > 1%',
      confounders: ['algorithm updates', 'seasonality', 'content volume', 'site outages']
    }]
  }
  const result = validateExperimentRegistry(registry, { now })
  assert.equal(result.status, 'ok')
  assert.equal(result.experiments[0].observation.mature, false)
  assert.equal(result.experiments[0].observation.conclusion, 'insufficient-observation-window')
  assert.equal(validateExperimentRegistry({ schema: experimentRegistrySchema, experiments: [{ id: 'bad' }] }, { now }).status, 'blocked')
  const noControls = structuredClone(registry)
  noControls.experiments[0].cohort.controlUrls = []
  assert.match(validateExperimentRegistry(noControls, { now }).errors.join('\n'), /controlUrls/u)
  const rankingClaim = structuredClone(registry)
  rankingClaim.experiments[0].primaryMetric = 'dwell completion ranking weight'
  assert.match(validateExperimentRegistry(rankingClaim, { now }).errors.join('\n'), /must not use dwell\/completion/u)
  const missingConfounders = structuredClone(registry)
  missingConfounders.experiments[0].confounders = ['seasonality']
  assert.match(validateExperimentRegistry(missingConfounders, { now }).errors.join('\n'), /algorithm updates|content volume|site outages/u)
})

test('release gate fails closed for unavailable external evidence and rejects PII/credentials', () => {
  const { searchConsole, crawler } = snapshots()
  const report = { schema: inventoryReportSchema, status: 'ok' }
  const registry = { schema: experimentRegistrySchema, experiments: [] }
  const passing = evaluateReleaseGate({ searchConsole, crawler, report, registry, release: 'v1', commit: 'a'.repeat(40), now })
  assert.equal(passing.status, 'ok')

  const blocked = evaluateReleaseGate({ searchConsole: { ...searchConsole, status: 'blocked', dataCutoff: null }, crawler, report, registry, release: 'v1', commit: 'a'.repeat(40), now })
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.errors.join('\n'), /blocked or unavailable|cutoff/u)
  const rawIpCrawler = { ...crawler, privacy: { ...crawler.privacy, rawIpRetained: true } }
  assert.match(evaluateReleaseGate({ searchConsole, crawler: rawIpCrawler, report, registry, release: 'v1', commit: 'a'.repeat(40), now }).errors.join('\n'), /privacy\/status/u)
  assert.ok(scanEvidenceForSecrets({ accessToken: 'secret', ip: '203.0.113.1', nested: { private_key: 'x', credentials: 'y' } }).length >= 4)
  assert.deepEqual(scanEvidenceForSecrets(measurementFixture), [])
  const missingExperiment = evaluateReleaseGate({ searchConsole, crawler, report, registry, release: 'v1', commit: 'a'.repeat(40), seoChanged: true, now })
  assert.equal(missingExperiment.status, 'blocked')
  assert.match(missingExperiment.errors.join('\n'), /requires a commit\/release-bound experiment/u)
  const invalidFlag = evaluateReleaseGate({ searchConsole, crawler, report, registry, release: 'v1', commit: 'a'.repeat(40), seoChanged: 'false', now })
  assert.match(invalidFlag.errors.join('\n'), /must be boolean/u)
})

test('evidence writer tightens an existing artifact to owner-only permissions', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-seo-'))
  const file = path.join(directory, 'evidence.json')
  try {
    writeFileSync(file, '{}\n', { mode: 0o644 })
    writeJson(file, { status: 'ok' })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { status: 'ok' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
