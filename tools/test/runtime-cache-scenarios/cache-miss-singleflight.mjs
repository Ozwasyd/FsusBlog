import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt,
  takeRuntimeSnapshot
} from '../run-runtime-cache-evidence.mjs'

const family = 'cache-miss-singleflight'
const routePrefix = '/_fsus/testing/runtime-cache/scenarios/cache-miss-singleflight'

function fixtureArticleId(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const ids = (fixture.entities ?? [])
    .filter((entity) => entity.producerId === 'public-content' && entity.kind === 'article')
    .map((entity) => Number.parseInt(entity.id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  const direct = Number.parseInt(fixture.articleId, 10)
  const articleId = ids[0] ?? direct
  if (!Number.isInteger(articleId) || articleId <= 0) {
    throw new Error('cache-miss-singleflight requires a current prepared public article fixture')
  }
  return articleId
}

function eventRows(requests) {
  return requests.flatMap((request) => request.cacheEvents
    .filter((event) => event.family === family)
    .map((event) => ({ requestId: request.id, ...event })))
}

export function deriveSingleFlightBurst(requests) {
  const events = eventRows(requests)
  const builds = events.filter((event) => event.outcome === 'built')
  const identityDigests = [...new Set(events.map((event) => event.identityDigest))]
  const databaseRequests = requests.filter((request) => request.dbCommands.length > 0)
  const databaseRequestIds = new Set(databaseRequests.map((request) => request.id))
  const payloadDigests = new Set(requests.map((request) => request.payloadDigest))
  const leader = builds[0]
  return {
    requestCount: requests.length,
    successfulRequests: requests.filter((request) => request.status >= 200 && request.status < 300).length,
    payloadDigestCount: payloadDigests.size,
    identityDigestCount: identityDigests.length,
    rebuildCount: builds.length,
    databaseRequestCount: databaseRequests.length,
    databaseCommandCount: databaseRequests.reduce((sum, request) => sum + request.dbCommands.length, 0),
    leaderDatabaseBound: leader !== undefined && databaseRequestIds.has(leader.requestId)
  }
}

function expectedBurst(count) {
  return {
    requestCount: count,
    successfulRequests: count,
    payloadDigestCount: 1,
    identityDigestCount: 1,
    rebuildCount: 1,
    databaseRequestCount: 1,
    databaseCommandCount: 1,
    leaderDatabaseBound: true
  }
}

async function resetColdKey({ fetchImpl, baseUrl, secret, articleId, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`singleflight reset timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetchImpl(`${baseUrl}${routePrefix}/${articleId}`, {
      method: 'DELETE',
      headers: { 'X-Fsus-Runtime-Evidence-Secret': secret },
      signal: controller.signal
    })
    if (response.status !== 204) {
      throw new Error(`cache-miss-singleflight reset returned HTTP ${response.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

function specs(articleId, runId, subcaseId, count) {
  return Array.from({ length: count }, (_, index) => ({
    method: 'GET',
    path: `${routePrefix}/${articleId}?run=${encodeURIComponent(runId)}&subcase=${subcaseId}&ordinal=${index + 1}`,
    subcaseId,
    parityGroup: `cache-miss-singleflight-${subcaseId}`,
    headers: {}
  }))
}

export async function produceCacheMissSingleFlightReceipt(options) {
  const { scenario, identity, baseUrl, secret } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000
  const articleId = fixtureArticleId(identity)
  const snapshotContext = { fetchImpl, baseUrl, secret, timeoutMs }

  return produceMeasuredScenarioReceipt(options, {
    warmup: async () => [],
    sample: async ({ collect, runId }) => {
      const bursts = []
      const snapshots = {}
      for (const [subcaseId, count] of [['same-key-100', 100], ['same-key-1000', 1000]]) {
        await resetColdKey({ fetchImpl, baseUrl, secret, articleId, timeoutMs })
        const requests = await mapConcurrent(
          specs(articleId, runId, subcaseId, count),
          count,
          (spec, index) => collect(spec, bursts.reduce((sum, burst) => sum + burst.requests.length, 0) + index))
        const snapshot = await takeRuntimeSnapshot(snapshotContext)
        bursts.push({ subcaseId, count, requests, derived: deriveSingleFlightBurst(requests) })
        snapshots[subcaseId] = snapshot
      }

      const requests = bursts.flatMap((burst) => burst.requests)
      const rebuildCounts = Object.fromEntries(bursts.map((burst) => [
        burst.subcaseId,
        burst.derived.rebuildCount
      ]))
      const finalActive = snapshots['same-key-1000'].activeKeyedEntries
      return {
        requests,
        assertionResults: [
          ...bursts.map((burst) => exactAssertionResult(
            burst.subcaseId,
            expectedBurst(burst.count),
            burst.derived,
            burst.requests[0])),
          exactAssertionResult(
            'rebuild-count',
            scenario.requirements.rebuildCountBySubcase,
            rebuildCounts,
            requests[0]),
          exactAssertionResult(
            'active-keyed-drained',
            { activeKeyedEntries: scenario.requirements.activeKeyedEntriesFinal },
            { activeKeyedEntries: finalActive },
            requests.at(-1))
        ],
        parameters: {
          route: `${routePrefix}/${articleId}`,
          articleId,
          burstConcurrency: { 'same-key-100': 100, 'same-key-1000': 1000 },
          snapshots
        }
      }
    }
  })
}
