import { createHash, createHmac, createSign } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const searchConsoleSnapshotSchema = 'fsusblog.seo.search-console-snapshot.v1'
export const crawlerSnapshotSchema = 'fsusblog.seo.verified-crawler-snapshot.v1'
export const urlInventoryInputSchema = 'fsusblog.seo.url-inventory-input.v1'
export const inventoryReportSchema = 'fsusblog.seo.url-inventory-report.v1'
export const experimentRegistrySchema = 'fsusblog.seo.experiment-registry.v1'
export const releaseGateSchema = 'fsusblog.seo.release-gate.v1'

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function canonicalUrl(value, siteUrl) {
  const site = new URL(siteUrl)
  const url = new URL(value, site)
  if (url.origin !== site.origin || url.username || url.password) {
    throw new Error(`URL must stay on the configured Search Console origin: ${value}`)
  }
  url.hash = ''
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '')
  return url.href
}

function decodeXml(value) {
  return value.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'")
}

function sitemapEntries(xml, source) {
  return [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]+)<\/lastmod>)?[\s\S]*?<\/url>/giu)]
    .map(match => ({ loc: decodeXml(match[1].trim()), lastmod: match[2]?.trim() ?? null, sitemapSource: source }))
}

function sitemapChildren(xml) {
  return [...xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/giu)]
    .map(match => decodeXml(match[1].trim()))
}

function htmlAttribute(html, pattern) {
  return html.match(pattern)?.[1]?.trim() ?? null
}

export async function collectUrlInventory({ siteUrl, fetchImpl = fetch, maxUrls = 100_000, maxSitemaps = 100, concurrency = Math.max(1, Math.min(8, os.availableParallelism())) }) {
  const root = canonicalUrl('/sitemap.xml', siteUrl)
  const pending = [root]
  const seenSitemaps = new Set()
  const entries = []
  while (pending.length > 0) {
    const sitemapUrl = canonicalUrl(pending.shift(), siteUrl)
    if (seenSitemaps.has(sitemapUrl)) continue
    if (seenSitemaps.size >= maxSitemaps) throw new Error(`sitemap count exceeds ${maxSitemaps}`)
    seenSitemaps.add(sitemapUrl)
    const response = await fetchImpl(sitemapUrl, { headers: { accept: 'application/xml,text/xml' }, redirect: 'error' })
    if (!response.ok) throw new Error(`sitemap fetch failed: HTTP ${response.status}`)
    const xml = await response.text()
    if (Buffer.byteLength(xml) > 20 * 1024 * 1024) throw new Error('sitemap response exceeds 20 MiB')
    for (const child of sitemapChildren(xml)) pending.push(canonicalUrl(child, siteUrl))
    entries.push(...sitemapEntries(xml, sitemapUrl))
    if (entries.length > maxUrls) throw new Error(`sitemap URL count exceeds ${maxUrls}`)
  }

  const urls = new Array(entries.length)
  let nextIndex = 0
  async function probeWorker() {
    while (nextIndex < entries.length) {
      const index = nextIndex++
      const entry = entries[index]
      const requestedUrl = canonicalUrl(entry.loc, siteUrl)
      const response = await fetchImpl(requestedUrl, {
        headers: { accept: 'text/html', 'user-agent': 'FsusBlogSeoInventory/1.0' },
        redirect: 'follow'
      })
      const finalUrl = canonicalUrl(response.url || requestedUrl, siteUrl)
      const contentType = response.headers.get('content-type') ?? ''
      const html = /text\/html/iu.test(contentType) ? await response.text() : ''
      const declaredCanonical = htmlAttribute(html, /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/iu)
        ?? htmlAttribute(html, /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/iu)
      const robots = `${response.headers.get('x-robots-tag') ?? ''} ${htmlAttribute(html, /<meta\b[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/iu) ?? ''}`.toLowerCase()
      const internalLinks = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["']/giu)]
        .map(match => {
          try { return canonicalUrl(match[1], siteUrl) } catch { return null }
        })
        .filter(Boolean)
      urls[index] = {
        canonicalUrl: declaredCanonical ? canonicalUrl(declaredCanonical, siteUrl) : finalUrl,
        sitemapIncluded: true,
        sitemapSource: entry.sitemapSource,
        lastmod: entry.lastmod,
        declaredCanonical: declaredCanonical ? canonicalUrl(declaredCanonical, siteUrl) : null,
        expectedIndexable: !robots.includes('noindex'),
        aotSource: response.headers.get('x-fsus-public-aot-source') ?? 'unknown',
        aotState: response.headers.get('x-fsus-public-aot-state') ?? 'unknown',
        responseStatus: response.status,
        redirectSource: finalUrl !== requestedUrl ? requestedUrl : null,
        finalUrl,
        internalLinks: [...new Set(internalLinks)],
        soft404: response.status === 200 && (!declaredCanonical || robots.includes('noindex') || /(?:404|not found|页面不存在)/iu.test(html.slice(0, 16_384)))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(entries.length, Math.max(1, concurrency)) }, () => probeWorker()))
  return {
    schema: urlInventoryInputSchema,
    generatedAt: new Date().toISOString(),
    source: 'live-sitemap-and-public-html-probe',
    site: new URL(siteUrl).origin,
    sitemapSources: [...seenSitemaps],
    urls
  }
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url')
}

export async function obtainSearchConsoleToken(credential, { fetchImpl = fetch, now = new Date() } = {}) {
  if (!credential?.client_email || !credential?.private_key || !credential?.token_uri) {
    throw new Error('Search Console credential must contain client_email, private_key and token_uri')
  }
  const issuedAt = Math.floor(now.getTime() / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: credential.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: credential.token_uri,
    iat: issuedAt,
    exp: issuedAt + 3600
  }))
  const unsigned = `${header}.${claims}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  const assertion = `${unsigned}.${signer.sign(credential.private_key).toString('base64url')}`
  const response = await fetchImpl(credential.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body.access_token !== 'string') {
    throw new Error(`Search Console OAuth failed with HTTP ${response.status}`)
  }
  return body.access_token
}

async function googleJson(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers
    }
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(`Search Console API ${response.status}`)
    error.status = response.status
    error.retryAfter = response.headers?.get?.('retry-after') ?? null
    throw error
  }
  return body
}

export async function collectSearchConsole({
  siteUrl,
  startDate,
  endDate,
  credential,
  inspectionUrls = [],
  inspectionLimit = 25,
  rowLimit = 25_000,
  fetchImpl = fetch,
  now = new Date()
}) {
  const generatedAt = now.toISOString()
  const errors = []
  let token
  try {
    token = await obtainSearchConsoleToken(credential, { fetchImpl, now })
  } catch (error) {
    return blockedSearchConsoleSnapshot({ siteUrl, startDate, endDate, generatedAt, reason: error.message })
  }

  const rows = []
  let startRow = 0
  try {
    while (true) {
      const page = await googleJson(
        fetchImpl,
        `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({
            startDate,
            endDate,
            dimensions: ['date', 'page', 'query', 'device', 'country'],
            rowLimit,
            startRow,
            dataState: 'final'
          })
        }
      )
      const pageRows = Array.isArray(page.rows) ? page.rows : []
      rows.push(...pageRows.map(row => ({
        date: row.keys?.[0] ?? null,
        page: row.keys?.[1] ?? null,
        query: row.keys?.[2] ?? null,
        device: row.keys?.[3] ?? null,
        country: row.keys?.[4] ?? null,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? null
      })))
      if (pageRows.length < rowLimit) break
      startRow += pageRows.length
    }
  } catch (error) {
    errors.push({ source: 'search-analytics', category: classifyGoogleError(error), retryAfter: error.retryAfter ?? null })
  }

  let sitemaps = []
  try {
    const body = await googleJson(
      fetchImpl,
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
      token
    )
    sitemaps = (body.sitemap ?? []).map(item => ({
      path: item.path,
      lastSubmitted: item.lastSubmitted ?? null,
      isPending: item.isPending ?? null,
      isSitemapsIndex: item.isSitemapsIndex ?? null,
      lastDownloaded: item.lastDownloaded ?? null,
      warnings: Number(item.warnings ?? 0),
      errors: Number(item.errors ?? 0),
      contents: item.contents ?? []
    }))
  } catch (error) {
    errors.push({ source: 'sitemaps', category: classifyGoogleError(error), retryAfter: error.retryAfter ?? null })
  }

  const inspections = []
  const sampled = [...new Set(inspectionUrls)].slice(0, Math.max(0, inspectionLimit))
  for (const inspectionUrl of sampled) {
    try {
      const body = await googleJson(
        fetchImpl,
        'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
        token,
        {
          method: 'POST',
          body: JSON.stringify({ inspectionUrl: canonicalUrl(inspectionUrl, siteUrl), siteUrl })
        }
      )
      const result = body.inspectionResult?.indexStatusResult ?? {}
      inspections.push({
        inspectionUrl: canonicalUrl(inspectionUrl, siteUrl),
        coverageState: result.coverageState ?? null,
        verdict: result.verdict ?? null,
        robotsTxtState: result.robotsTxtState ?? null,
        indexingState: result.indexingState ?? null,
        pageFetchState: result.pageFetchState ?? null,
        googleCanonical: result.googleCanonical ?? null,
        userCanonical: result.userCanonical ?? null,
        lastCrawlTime: result.lastCrawlTime ?? null
      })
    } catch (error) {
      errors.push({ source: 'url-inspection', category: classifyGoogleError(error), retryAfter: error.retryAfter ?? null })
      if (error.status === 429 || error.status === 403) break
    }
  }

  const dataCutoff = rows.map(row => row.date).filter(Boolean).sort().at(-1) ?? null
  const status = errors.length === 0 ? 'ok' : (rows.length > 0 || sitemaps.length > 0 || inspections.length > 0 ? 'partial' : 'blocked')
  return {
    schema: searchConsoleSnapshotSchema,
    status,
    source: 'google-search-console-api',
    generatedAt,
    dataCutoff,
    requestedWindow: { startDate, endDate },
    site: new URL(siteUrl).origin,
    coverage: {
      searchAnalytics: errors.every(error => error.source !== 'search-analytics') ? 'complete-for-api-response' : 'partial',
      sitemaps: errors.every(error => error.source !== 'sitemaps') ? 'complete-for-api-response' : 'partial',
      urlInspection: sampled.length === 0 ? 'not-requested' : inspections.length === sampled.length ? 'sampled-complete' : 'sampled-partial',
      inspectionRequested: sampled.length,
      inspectionCompleted: inspections.length,
      lagAware: true,
      realtime: false
    },
    rows,
    sitemaps,
    inspections,
    errors,
    limitations: [
      'Search Console data is delayed and may be aggregated or omitted by Google.',
      'URL inspection is quota-sampled and is not a full-site index census.',
      'CTR and position are observations, not standalone ranking factors.'
    ]
  }
}

export function blockedSearchConsoleSnapshot({ siteUrl, startDate, endDate, generatedAt = new Date().toISOString(), reason }) {
  return {
    schema: searchConsoleSnapshotSchema,
    status: 'blocked',
    source: 'google-search-console-api',
    generatedAt,
    dataCutoff: null,
    requestedWindow: { startDate, endDate },
    site: siteUrl ? new URL(siteUrl).origin : null,
    coverage: {
      searchAnalytics: 'unavailable',
      sitemaps: 'unavailable',
      urlInspection: 'unavailable',
      inspectionRequested: 0,
      inspectionCompleted: 0,
      lagAware: true,
      realtime: false
    },
    rows: [],
    sitemaps: [],
    inspections: [],
    errors: [{ source: 'collector', category: 'credentials-or-access-unavailable', detail: String(reason ?? 'unavailable') }],
    limitations: ['No external Search Console result was fabricated. Import is fail-closed.']
  }
}

function classifyGoogleError(error) {
  if (error?.status === 429) return 'quota-exhausted'
  if (error?.status === 401 || error?.status === 403) return 'permission-denied'
  return 'api-unavailable'
}

function allowedGoogleHostname(hostname) {
  const value = hostname.toLowerCase().replace(/\.$/u, '')
  return value.endsWith('.googlebot.com') || value.endsWith('.google.com')
}

function privacySafeObservedUrl(value, siteUrl) {
  const url = new URL(canonicalUrl(value, siteUrl))
  for (const [key, item] of [...url.searchParams.entries()]) {
    url.searchParams.set(key, `sha256-${sha256(item).slice(0, 16)}`)
  }
  return url.href
}

function publicCanonicalIdentity(value, siteUrl) {
  const url = new URL(canonicalUrl(value, siteUrl))
  const pageValues = url.searchParams.getAll('page')
  url.search = ''
  if (pageValues.length === 1 && /^[1-9]\d*$/u.test(pageValues[0]) && pageValues[0] !== '1') {
    url.searchParams.set('page', pageValues[0])
  }
  return url.href
}

export async function verifyCrawlerEvent(event, {
  resolver,
  ipHashKey,
  siteUrl,
  cache = new Map()
}) {
  const userAgent = String(event.userAgent ?? '')
  if (!/Googlebot|Google-InspectionTool/u.test(userAgent)) {
    return { verified: false, reason: 'user-agent-not-googlebot' }
  }
  const timestampMs = Date.parse(event.timestamp)
  const status = Number(event.status)
  const latencyMs = Number(event.latencyMs ?? 0)
  const bytes = Number(event.bytes ?? 0)
  let rawUrl
  try { rawUrl = canonicalUrl(event.url, siteUrl) } catch { return { verified: false, reason: 'event-url-invalid' } }
  if (!Number.isFinite(timestampMs) || !Number.isInteger(status) || status < 100 || status > 599 || !Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(bytes) || bytes < 0) {
    return { verified: false, reason: 'event-fields-invalid' }
  }
  const ip = String(event.ip ?? '').trim()
  if (!ip) return { verified: false, reason: 'ip-missing' }
  let verification = cache.get(ip)
  if (!verification) {
    try {
      const reverseNames = await resolver.reverse(ip)
      const hostname = reverseNames.find(allowedGoogleHostname)
      if (!hostname) {
        verification = { verified: false, reason: 'reverse-dns-domain-mismatch' }
      } else {
        const forward = await resolver.lookup(hostname, { all: true })
        const matched = forward.some(item => item.address === ip)
        verification = matched
          ? { verified: true, hostnameHash: sha256(hostname.toLowerCase()) }
          : { verified: false, reason: 'forward-dns-ip-mismatch' }
      }
    } catch {
      verification = { verified: false, reason: 'dns-verification-failed' }
    }
    cache.set(ip, verification)
  }
  if (!verification.verified) return verification
  if (!ipHashKey || Buffer.byteLength(ipHashKey) < 32) throw new Error('crawler IP hash key must be at least 32 bytes')
  const url = privacySafeObservedUrl(rawUrl, siteUrl)
  const canonicalIdentity = publicCanonicalIdentity(event.canonicalUrl ?? rawUrl, siteUrl)
  return {
    verified: true,
    event: {
      timestamp: new Date(timestampMs).toISOString(),
      url,
      canonicalUrl: canonicalIdentity,
      requestCanonical: canonicalUrl(rawUrl, siteUrl) === canonicalIdentity,
      redirectSource: event.redirectSource ? privacySafeObservedUrl(event.redirectSource, siteUrl) : null,
      status,
      method: String(event.method ?? 'GET').toUpperCase(),
      responseSource: String(event.responseSource ?? 'unknown'),
      latencyMs,
      bytes,
      release: String(event.release ?? ''),
      commit: String(event.commit ?? ''),
      crawler: /Google-InspectionTool/u.test(userAgent) ? 'google-inspection-tool' : 'googlebot',
      ipHash: createHmac('sha256', ipHashKey).update(ip).digest('hex'),
      hostnameHash: verification.hostnameHash
    }
  }
}

export async function importCrawlerEvents(events, options) {
  if (!options.ipHashKey || Buffer.byteLength(options.ipHashKey) < 32) throw new Error('crawler IP hash key must be at least 32 bytes')
  const accepted = []
  const rejected = new Map()
  const cache = options.cache ?? new Map()
  for (const event of events) {
    const result = await verifyCrawlerEvent(event, { ...options, cache })
    if (result.verified) accepted.push(result.event)
    else rejected.set(result.reason, (rejected.get(result.reason) ?? 0) + 1)
  }
  return {
    schema: crawlerSnapshotSchema,
    status: 'ok',
    source: 'verified-production-access-log',
    generatedAt: (options.now ?? new Date()).toISOString(),
    coverage: { inputEvents: events.length, verifiedEvents: accepted.length, rejectedEvents: events.length - accepted.length },
    events: accepted,
    rejectedByReason: Object.fromEntries([...rejected.entries()].sort()),
    privacy: { rawIpRetained: false, userIdentityCollected: false, verification: 'user-agent-plus-reverse-and-forward-dns' }
  }
}

function sameCanonical(left, right, siteUrl) {
  if (!left || !right) return false
  try { return canonicalUrl(left, siteUrl) === canonicalUrl(right, siteUrl) } catch { return false }
}

export function buildInventoryReport({ inventory, searchConsole, crawler, experiments = [], now = new Date() }) {
  if (inventory?.schema !== urlInventoryInputSchema || searchConsole?.schema !== searchConsoleSnapshotSchema || crawler?.schema !== crawlerSnapshotSchema) {
    throw new Error('inventory report requires schema-valid URL inventory, Search Console and crawler snapshots')
  }
  const siteUrl = inventory.site
  const inventoryByCanonical = new Map()
  for (const item of inventory.urls) {
    const identity = canonicalUrl(item.canonicalUrl, siteUrl)
    const group = inventoryByCanonical.get(identity) ?? []
    group.push(item)
    inventoryByCanonical.set(identity, group)
  }
  const rows = [...inventoryByCanonical.entries()].map(([identity, items]) => {
    const item = items.find(candidate => !candidate.redirectSource && sameCanonical(candidate.declaredCanonical, identity, siteUrl)) ?? items[0]
    const performance = searchConsole.rows.filter(row => sameCanonical(row.page, identity, siteUrl))
    const crawlEvents = crawler.events.filter(event => sameCanonical(event.canonicalUrl, identity, siteUrl))
    const inspection = searchConsole.inspections.find(entry => sameCanonical(entry.inspectionUrl, identity, siteUrl)) ?? null
    const impressions = performance.reduce((sum, row) => sum + Number(row.impressions ?? 0), 0)
    const clicks = performance.reduce((sum, row) => sum + Number(row.clicks ?? 0), 0)
    const positionedImpressions = performance.reduce((sum, row) => row.position != null && Number.isFinite(Number(row.position)) ? sum + Number(row.impressions ?? 0) : sum, 0)
    const weightedPosition = performance.reduce((sum, row) => {
      const position = Number(row.position)
      return row.position != null && Number.isFinite(position) ? sum + position * Number(row.impressions ?? 0) : sum
    }, 0)
    const performanceDates = performance.map(row => row.date).filter(Boolean).sort()
    const lastCrawl = [inspection?.lastCrawlTime, ...crawlEvents.map(event => event.timestamp)].filter(Boolean).sort().at(-1) ?? null
    const canonicalConflict = Boolean(inspection?.googleCanonical)
      && !sameCanonical(inspection.googleCanonical, item.declaredCanonical ?? identity, siteUrl)
    const coverageState = String(inspection?.coverageState ?? '').toLowerCase()
    const indexed = inspection
      ? inspection.verdict === 'PASS'
        ? true
        : /not indexed|excluded|error|blocked/u.test(coverageState) || ['FAIL', 'NEUTRAL'].includes(inspection.verdict)
          ? false
          : /indexed/u.test(coverageState)
            ? true
            : null
      : null
    const states = []
    if (!lastCrawl) states.push('not-crawled')
    if (item.expectedIndexable && indexed === false) states.push('not-indexed')
    if (canonicalConflict) states.push('canonical-conflict')
    if (indexed === true && impressions === 0) states.push('no-impressions')
    if (impressions > 0 && clicks === 0) states.push('no-clicks')
    return {
      canonicalUrl: identity,
      inventoryEntries: items.length,
      sitemapIncluded: items.some(candidate => candidate.sitemapIncluded === true),
      sitemapSources: [...new Set(items.map(candidate => candidate.sitemapSource).filter(Boolean).map(source => canonicalUrl(source, siteUrl)))].sort(),
      sitemapLastmod: items.map(candidate => candidate.lastmod).filter(Boolean).sort().at(-1) ?? null,
      redirectSources: [...new Set(items.map(candidate => candidate.redirectSource).filter(Boolean).map(source => canonicalUrl(source, siteUrl)))].sort(),
      lastGooglebotCrawl: lastCrawl,
      latestCrawlerStatus: crawlEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)?.status ?? null,
      aotSource: item.aotSource ?? null,
      aotState: item.aotState ?? null,
      firstResponseStatus: item.responseStatus ?? null,
      soft404Detected: items.some(candidate => candidate.soft404 === true),
      expectedIndexable: item.expectedIndexable === true,
      declaredCanonical: item.declaredCanonical ? canonicalUrl(item.declaredCanonical, siteUrl) : null,
      googleCanonical: inspection?.googleCanonical ?? null,
      indexCoverageState: inspection?.coverageState ?? null,
      indexed,
      impressions,
      clicks,
      searchPerformance: {
        rows: performance.length,
        firstDate: performanceDates[0] ?? null,
        lastDate: performanceDates.at(-1) ?? null,
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        averagePosition: positionedImpressions > 0 ? weightedPosition / positionedImpressions : null
      },
      states
    }
  })

  const diagnostics = []
  const redirectSources = new Set(inventory.urls.map(item => item.redirectSource).filter(Boolean).map(value => canonicalUrl(value, siteUrl)))
  for (const row of rows) {
    if (row.sitemapIncluded && !row.lastGooglebotCrawl) diagnostics.push({ code: 'sitemap-without-crawl', url: row.canonicalUrl })
    if (row.latestCrawlerStatus === 200 && row.soft404Detected) diagnostics.push({ code: 'crawl-200-soft-404', url: row.canonicalUrl })
    if (row.states.includes('canonical-conflict')) diagnostics.push({ code: 'canonical-conflict', url: row.canonicalUrl })
    if (row.aotSource === 'cold-fallback' || row.firstResponseStatus === 503) diagnostics.push({ code: 'crawler-aot-cold-or-503-exposure', url: row.canonicalUrl })
    if (row.sitemapLastmod && row.lastGooglebotCrawl && new Date(row.sitemapLastmod) > new Date(row.lastGooglebotCrawl)) diagnostics.push({ code: 'lastmod-after-last-crawl', url: row.canonicalUrl })
    if (row.indexed && row.impressions === 0) diagnostics.push({ code: 'discovered-indexed-without-impressions', url: row.canonicalUrl })
  }
  for (const item of inventory.urls) {
    if (item.redirectSource && !sameCanonical(item.finalUrl, item.declaredCanonical, siteUrl)) diagnostics.push({ code: 'redirect-canonical-inconsistent', url: item.redirectSource })
    for (const link of item.internalLinks ?? []) {
      if (redirectSources.has(canonicalUrl(link, siteUrl))) diagnostics.push({ code: 'internal-link-targets-redirect', url: item.canonicalUrl, target: link })
    }
  }
  const inventorySet = new Set(rows.map(row => row.canonicalUrl))
  const crawlerPathDiagnostics = new Map()
  for (const event of crawler.events) {
    const code = !inventorySet.has(event.canonicalUrl)
      ? 'crawler-invalid-or-extra-path'
      : event.requestCanonical === false || (event.requestCanonical == null && !sameCanonical(event.url, event.canonicalUrl, siteUrl))
        ? 'crawler-noncanonical-or-parameter-path'
        : null
    if (!code) continue
    const key = `${code}\u0000${event.url}`
    const current = crawlerPathDiagnostics.get(key) ?? { code, url: event.url, count: 0, releases: new Set() }
    current.count += 1
    current.releases.add(`${event.release || 'unknown'}@${event.commit || 'unknown'}`)
    crawlerPathDiagnostics.set(key, current)
  }
  diagnostics.push(...[...crawlerPathDiagnostics.values()].map(item => ({
    code: item.code,
    url: item.url,
    count: item.count,
    releases: [...item.releases].sort()
  })))

  const experimentResults = validateExperimentRegistry({ schema: experimentRegistrySchema, experiments }, { now })
  const crawlerBreakdown = {}
  for (const event of crawler.events) {
    const key = `${event.release || 'unknown'}@${event.commit || 'unknown'}:${event.status ?? 'unknown'}:${event.responseSource ?? 'unknown'}`
    crawlerBreakdown[key] = (crawlerBreakdown[key] ?? 0) + 1
  }
  return {
    schema: inventoryReportSchema,
    status: searchConsole.status === 'blocked' || crawler.status !== 'ok' || crawler.privacy?.rawIpRetained !== false || experimentResults.status === 'blocked' ? 'blocked' : 'ok',
    generatedAt: now.toISOString(),
    dataCutoff: searchConsole.dataCutoff,
    freshness: {
      realtime: false,
      statement: `Search Console coverage ends at ${searchConsole.dataCutoff ?? 'unavailable'} and must not be presented as live data.`
    },
    coverage: {
      searchConsole: searchConsole.status,
      searchConsoleDetails: searchConsole.coverage,
      crawler: crawler.coverage,
      urlInventory: rows.length
    },
    causality: {
      statement: 'Metrics describe observed association only; CTR, position, dwell and completion are not declared ranking factors.',
      benefitLayers: ['technical-correctness', 'crawl-index', 'impressions-clicks', 'business-conversion']
    },
    sitemaps: searchConsole.sitemaps,
    crawlerBreakdown,
    urls: rows,
    diagnostics,
    experiments: experimentResults.experiments,
    errors: [...searchConsole.errors, ...experimentResults.errors]
  }
}

export function validateExperimentRegistry(registry, { now = new Date() } = {}) {
  const errors = []
  if (registry?.schema !== experimentRegistrySchema || !Array.isArray(registry.experiments)) {
    return { status: 'blocked', errors: ['experiment registry schema is invalid'], experiments: [] }
  }
  const seen = new Set()
  const experiments = registry.experiments.map((experiment, index) => {
    const prefix = `experiments[${index}]`
    for (const field of ['id', 'hypothesis', 'release', 'commit', 'startDate', 'primaryMetric', 'rollbackCondition']) {
      if (!String(experiment?.[field] ?? '').trim()) errors.push(`${prefix}.${field} is required`)
    }
    if (!/^[0-9a-f]{40}$/iu.test(String(experiment.commit ?? ''))) errors.push(`${prefix}.commit must be a full commit SHA`)
    if (!Array.isArray(experiment.cohort?.urls) || experiment.cohort.urls.length === 0) errors.push(`${prefix}.cohort.urls must be non-empty`)
    if (experiment.design === 'matched-control' && (!Array.isArray(experiment.cohort?.controlUrls) || experiment.cohort.controlUrls.length === 0)) errors.push(`${prefix}.cohort.controlUrls must be non-empty for matched-control`)
    if (experiment.design === 'matched-control' && experiment.cohort?.urls?.some(url => experiment.cohort?.controlUrls?.includes(url))) errors.push(`${prefix}.cohort control URLs must not overlap affected URLs`)
    if (!Array.isArray(experiment.guardrails) || experiment.guardrails.length === 0) errors.push(`${prefix}.guardrails must be non-empty`)
    if (!Array.isArray(experiment.confounders) || experiment.confounders.length === 0) errors.push(`${prefix}.confounders must record algorithm, seasonality, content volume and outages`)
    const confounders = Array.isArray(experiment.confounders) ? experiment.confounders.join(' ').toLowerCase() : ''
    for (const [name, pattern] of [
      ['algorithm updates', /algorithm|算法/u],
      ['seasonality', /season|季节/u],
      ['content volume', /content[^\n]*(?:volume|publish)|发布量|内容量/u],
      ['site outages', /outage|incident|故障/u]
    ]) {
      if (!pattern.test(confounders)) errors.push(`${prefix}.confounders must include ${name}`)
    }
    if (!Number.isInteger(experiment.minimumObservationDays) || experiment.minimumObservationDays < 1) errors.push(`${prefix}.minimumObservationDays must be a positive integer`)
    if (!['url-cohort', 'time-series', 'matched-control'].includes(experiment.design)) errors.push(`${prefix}.design must be url-cohort, time-series or matched-control`)
    if (/dwell|completion/iu.test(String(experiment.primaryMetric ?? ''))) errors.push(`${prefix}.primaryMetric must not use dwell/completion as a ranking outcome`)
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(experiment.startDate ?? '')) || !Number.isFinite(Date.parse(`${experiment.startDate}T00:00:00Z`))) errors.push(`${prefix}.startDate must be YYYY-MM-DD`)
    if (seen.has(experiment.id)) errors.push(`${prefix}.id must be unique`)
    seen.add(experiment.id)
    const elapsedDays = Number.isFinite(Date.parse(experiment.startDate))
      ? Math.floor((now.getTime() - Date.parse(experiment.startDate)) / 86_400_000)
      : -1
    return {
      ...experiment,
      observation: {
        elapsedDays,
        minimumDays: experiment.minimumObservationDays,
        mature: elapsedDays >= experiment.minimumObservationDays,
        conclusion: elapsedDays >= experiment.minimumObservationDays ? 'eligible-for-reviewed-association' : 'insufficient-observation-window'
      }
    }
  })
  return { status: errors.length === 0 ? 'ok' : 'blocked', errors, experiments }
}

export function scanEvidenceForSecrets(value) {
  const errors = []
  function visit(node, pointer) {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, `${pointer}/${index}`))
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      const next = `${pointer}/${key}`
      if (/password|secret|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|assertion|cookie|client[_-]?email/iu.test(key)) errors.push(`${next} is a forbidden secret field`)
      if (/^(ip|remoteIp|clientIp)$/iu.test(key)) errors.push(`${next} is a forbidden raw IP field`)
      if (typeof child === 'string' && /-----BEGIN (?:RSA )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]+/u.test(child)) errors.push(`${next} contains credential material`)
      visit(child, next)
    }
  }
  visit(value, '')
  return errors
}

export function evaluateReleaseGate({ searchConsole, crawler, report, registry, release, commit, seoChanged = false, now = new Date() }) {
  const errors = []
  if (typeof seoChanged !== 'boolean') errors.push('seoChanged must be boolean')
  if (searchConsole?.schema !== searchConsoleSnapshotSchema || searchConsole.source !== 'google-search-console-api') errors.push('Search Console evidence schema/source is invalid')
  if (!['ok', 'partial'].includes(searchConsole?.status)) errors.push('Search Console evidence is blocked or unavailable')
  if (!searchConsole?.generatedAt || !searchConsole?.dataCutoff || searchConsole?.coverage?.realtime !== false) errors.push('Search Console cutoff/lag metadata is incomplete')
  if (crawler?.schema !== crawlerSnapshotSchema || crawler.source !== 'verified-production-access-log') errors.push('verified crawler evidence is missing')
  if (crawler?.status !== 'ok' || crawler?.privacy?.rawIpRetained !== false) errors.push('verified crawler evidence privacy/status is invalid')
  if (report?.schema !== inventoryReportSchema || report.status !== 'ok') errors.push('URL inventory report is not ready')
  const experimentValidation = validateExperimentRegistry(registry, { now })
  errors.push(...experimentValidation.errors)
  const matching = experimentValidation.experiments.filter(item => item.release === release || item.commit === commit)
  if (matching.some(item => item.release !== release || item.commit !== commit)) errors.push('SEO experiment release/commit binding is inconsistent')
  if (seoChanged && matching.length === 0) errors.push('SEO-changing release requires a commit/release-bound experiment entry')
  errors.push(...scanEvidenceForSecrets({ searchConsole, crawler, report, registry }))
  return {
    schema: releaseGateSchema,
    status: errors.length === 0 ? 'ok' : 'blocked',
    checkedAt: now.toISOString(),
    release,
    commit,
    seoChanged,
    dataCutoff: searchConsole?.dataCutoff ?? null,
    coverage: searchConsole?.coverage ?? null,
    experiments: matching.map(item => ({ id: item.id, observation: item.observation })),
    errors
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

export function writeJson(file, value) {
  const target = path.resolve(file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(target, 0o600)
}
