import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

const relatedReadingFamily = 'related-reading'

function fixtureArticleIds(identity) {
  const fixture = JSON.parse(fs.readFileSync(identity.fixtureFile, 'utf8'))
  const ids = (fixture.entities ?? [])
    .filter((entity) => entity.producerId === 'public-content' && entity.kind === 'article')
    .map((entity) => Number.parseInt(entity.id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length < 2) throw new Error('related-reading requires at least two current prepared public articles')
  return ids
}

function spec(articleId, subcaseId) {
  return {
    method: 'GET',
    path: `/api/binary/article/${articleId}/related.aeds`,
    subcaseId,
    parityGroup: `related-reading-${articleId}`,
    headers: {}
  }
}

function builtCounts(requests, subcaseIds) {
  return Object.fromEntries(subcaseIds.map((subcaseId) => [
    subcaseId,
    requests.filter((request) => request.subcaseId === subcaseId)
      .flatMap((request) => request.cacheEvents)
      .filter((event) => event.family === relatedReadingFamily && event.outcome === 'built').length
  ]))
}

export async function produceRelatedReadingReceipt(options) {
  const { scenario, identity } = options
  const [coldArticleId, burstArticleId] = fixtureArticleIds(identity)

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, () => ({
        method: 'GET',
        path: '/api/binary/system/seo',
        subcaseId: 'cold',
        parityGroup: 'related-reading-warmup',
        headers: {}
      }))
      return mapConcurrent(specs, scenario.concurrency, (item, index) => collect(item, index, 'warmup'))
    },
    sample: async ({ collect }) => {
      const cold = await collect(spec(coldArticleId, 'cold'), 0)
      const burstSpecs = Array.from({ length: 100 }, () =>
        spec(burstArticleId, 'same-key-100'))
      const burst = await mapConcurrent(burstSpecs, scenario.concurrency, (item, index) => collect(item, index + 1))
      const hot = await collect(spec(burstArticleId, 'hot'), 101)
      const requests = [cold, ...burst, hot]
      const rebuildCounts = builtCounts(requests, Object.keys(scenario.requirements.rebuildCountBySubcase))
      const burstDigests = new Set(burst.map((request) => request.payloadDigest))
      const burstIdentities = new Set(burst
        .flatMap((request) => request.cacheEvents)
        .filter((event) => event.family === relatedReadingFamily)
        .map((event) => event.identityDigest))
      const coldDatabaseCommands = cold.dbCommands.length

      return {
        requests,
        assertionResults: [
          exactAssertionResult(
            'cold-db-budget',
            { withinBudget: true },
            { withinBudget: coldDatabaseCommands <= scenario.requirements.coldDbCommandsMax },
            cold),
          exactAssertionResult(
            'same-key-build',
            { onePayload: true, oneIdentity: true },
            { onePayload: burstDigests.size === 1, oneIdentity: burstIdentities.size === 1 },
            burst[0]),
          exactAssertionResult('rebuild-count', scenario.requirements.rebuildCountBySubcase, rebuildCounts, burst[0]),
          exactAssertionResult(
            'hot-direct-frame',
            { layer: 'l1-frame', redisCommands: 0, databaseCommands: 0 },
            { layer: hot.layerSource, redisCommands: hot.redisCommands.length, databaseCommands: hot.dbCommands.length },
            hot)
        ],
        parameters: {
          coldArticleId,
          burstArticleId,
          routeTemplate: '/api/binary/article/{articleId}/related.aeds'
        }
      }
    }
  })
}
