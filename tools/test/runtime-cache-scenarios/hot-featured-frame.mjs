import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

const families = Object.freeze({
  hot: 'article-hot-frame',
  featured: 'article-featured-frame'
})

function requireAdminHeaders(value) {
  const entries = Object.entries(value ?? {})
  if (entries.length !== 1 || !['Authorization', 'Cookie'].includes(entries[0][0])) {
    throw new Error('hot-featured-frame requires exactly one Authorization or Cookie admin header')
  }
  const [name, raw] = entries[0]
  const header = String(raw ?? '').trim()
  if (!header || /[\0\r\n]/u.test(header) || (name === 'Authorization' && !header.startsWith('Bearer '))) {
    throw new Error('hot-featured-frame admin header is invalid')
  }
  return { [name]: header }
}

function readPrivateAdminHeader(file) {
  const resolved = String(file ?? '').trim()
  if (!resolved) return null
  const stat = fs.statSync(resolved)
  if (!stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o777)) {
    throw new Error('hot-featured-frame admin header file must be a private regular file')
  }
  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  if (lines.length !== 1) throw new Error('hot-featured-frame admin header file must contain exactly one line')
  const separator = lines[0].indexOf(':')
  if (separator < 1) throw new Error('hot-featured-frame admin header file line is invalid')
  return requireAdminHeaders({
    [lines[0].slice(0, separator).trim()]: lines[0].slice(separator + 1).trim()
  })
}

async function acquireLocalAdminCookie(options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const secret = String(options.localAuthFixtureSecret ?? process.env.FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET ?? '').trim()
  if (!secret) {
    throw new Error('hot-featured-frame requires an admin header or FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET')
  }
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 15000
  const timer = setTimeout(() => controller.abort(new Error(`admin fixture request timed out after ${timeoutMs}ms`)), timeoutMs)
  let response
  try {
    response = await fetchImpl(`${options.baseUrl}/api/local/auth-fixture/admin?redirect=/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'X-Fsus-Local-Auth-Fixture-Secret': secret },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
  if (response.status < 300 || response.status >= 400) {
    const detail = (await response.text()).trim().slice(0, 512)
    throw new Error(`admin fixture endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []
  const cookies = setCookies.map((value) => value.split(';', 1)[0]).filter(Boolean)
  if (!cookies.some((value) => /^(?:__Host-)?AdminAccessToken=/u.test(value)) ||
      !cookies.some((value) => /^(?:__Host-)?AdminSessionId=/u.test(value))) {
    throw new Error('admin fixture endpoint did not issue the required admin cookies')
  }
  return requireAdminHeaders({ Cookie: cookies.join('; ') })
}

async function resolveAdminHeaders(options) {
  if (options.adminHeaders) return requireAdminHeaders(options.adminHeaders)
  const fromFile = readPrivateAdminHeader(
    options.adminHeaderFile ?? process.env.FSUSBLOG_RUNTIME_CACHE_ADMIN_HEADER_FILE)
  return fromFile ?? acquireLocalAdminCookie(options)
}

function requestSpecs(count, kind, headers) {
  const size = kind === 'hot' ? 49 : 9
  return Array.from({ length: count }, () => ({
    method: 'GET',
    path: `/api/binary/admin/article/${kind}?size=${size}`,
    subcaseId: kind,
    parityGroup: `admin-${kind}-whole-frame`,
    headers
  }))
}

function summarizeFamily(requests, family) {
  const allEvents = requests.flatMap((request) => request.cacheEvents
    .map((event) => ({ request, event })))
  const events = allEvents
    .filter(({ event }) => event.family === family)
  const builds = allEvents.filter(({ event }) => event.outcome === 'built')
  const published = events.filter(({ event }) => event.outcome === 'published')
  const identityDigests = [...new Set(builds.map(({ event }) => event.identityDigest))]
  const atomicPublishers = published.filter(({ request }) =>
    request.redisCommands.some((command) => command.category === 'atomic-script'))
  return {
    buildCount: builds.length,
    identityCount: identityDigests.length,
    publicationCount: published.length,
    atomicPublisherCount: atomicPublishers.length,
    databaseCommandCount: requests.reduce((sum, request) => sum + request.dbCommands.length, 0),
    anonymousL0Count: requests.filter((request) => request.layerSource === 'l0-allow').length
  }
}

export async function produceHotFeaturedFrameReceipt(options) {
  const { scenario } = options
  if (scenario.requests < 2 || scenario.requests % 2 !== 0) {
    throw new Error('hot-featured-frame request count must be a positive even number')
  }
  const adminHeaders = await resolveAdminHeaders(options)
  const perIdentity = scenario.requests / 2
  const produce = options.produceMeasuredScenarioReceipt ?? produceMeasuredScenarioReceipt

  return produce(options, {
    warmup: async () => [],
    sample: async ({ collect }) => {
      const hotSpecs = requestSpecs(perIdentity, 'hot', adminHeaders)
      const hot = await mapConcurrent(hotSpecs, scenario.concurrency, (spec, index) => collect(spec, index))
      const featuredSpecs = requestSpecs(perIdentity, 'featured', adminHeaders)
      const featured = await mapConcurrent(featuredSpecs, scenario.concurrency, (spec, index) =>
        collect(spec, hot.length + index))
      const requests = [...hot, ...featured]
      const hotSummary = summarizeFamily(hot, families.hot)
      const featuredSummary = summarizeFamily(featured, families.featured)
      const first = requests[0]
      return {
        requests,
        assertionResults: [
          exactAssertionResult(
            'same-identity-build',
            { hotIdentityCount: 1, featuredIdentityCount: 1, anonymousL0Count: 0 },
            {
              hotIdentityCount: hotSummary.identityCount,
              featuredIdentityCount: featuredSummary.identityCount,
              anonymousL0Count: hotSummary.anonymousL0Count + featuredSummary.anonymousL0Count
            },
            first),
          exactAssertionResult(
            'rebuild-count',
            scenario.requirements.rebuildCountBySubcase,
            { hot: hotSummary.buildCount, featured: featuredSummary.buildCount },
            first),
          exactAssertionResult(
            'db-command-budget',
            { hotWithinBudget: true, featuredWithinBudget: true },
            {
              hotWithinBudget: hotSummary.databaseCommandCount <= scenario.requirements.dbCommandsMaxPerIdentity,
              featuredWithinBudget: featuredSummary.databaseCommandCount <= scenario.requirements.dbCommandsMaxPerIdentity
            },
            first),
          exactAssertionResult(
            'atomic-redis-publication',
            {
              hotPublicationCount: 1,
              featuredPublicationCount: 1,
              hotAtomicPublisherCount: 1,
              featuredAtomicPublisherCount: 1
            },
            {
              hotPublicationCount: hotSummary.publicationCount,
              featuredPublicationCount: featuredSummary.publicationCount,
              hotAtomicPublisherCount: hotSummary.atomicPublisherCount,
              featuredAtomicPublisherCount: featuredSummary.atomicPublisherCount
            },
            first)
        ],
        parameters: {
          routes: ['/api/binary/admin/article/hot', '/api/binary/admin/article/featured'],
          sizes: { hot: 49, featured: 9 },
          requestsPerIdentity: perIdentity,
          observedDatabaseCommands: {
            hot: hotSummary.databaseCommandCount,
            featured: featuredSummary.databaseCommandCount
          }
        }
      }
    }
  })
}
