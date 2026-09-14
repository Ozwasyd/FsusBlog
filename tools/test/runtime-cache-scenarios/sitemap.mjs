import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt,
  takeRuntimeSnapshot
} from '../run-runtime-cache-evidence.mjs'

function requestSpec(runId, phase, index, subcaseId) {
  return {
    method: 'GET',
    path: `/sitemap.xml?runtime-cache-evidence=${encodeURIComponent(`${runId}-${phase}-${index + 1}`)}`,
    subcaseId,
    parityGroup: 'sitemap-current-generation',
    headers: { Accept: 'application/xml' }
  }
}

export async function produceSitemapReceipt(options) {
  const { scenario, baseUrl, secret } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000
  const snapshotContext = { fetchImpl, baseUrl, secret, timeoutMs }
  let afterWarmup

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, (_, index) => ({
        method: 'GET',
        path: `/api/binary/system/seo?runtime-cache-evidence=${encodeURIComponent(`${runId}-sitemap-warmup-${index + 1}`)}`,
        subcaseId: 'l1-hit',
        parityGroup: 'sitemap-warmup',
        headers: {}
      }))
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
      afterWarmup = await takeRuntimeSnapshot(snapshotContext)
      return requests
    },
    sample: async ({ collect, runId }) => {
      if (!afterWarmup) throw new Error('sitemap warmup snapshot is missing')
      const burstSpecs = Array.from({ length: 100 }, (_, index) =>
        requestSpec(runId, 'sample', index, 'same-generation-100'))
      const burst = await mapConcurrent(burstSpecs, scenario.concurrency, (spec, index) => collect(spec, index))
      const afterBurst = await takeRuntimeSnapshot(snapshotContext)
      const l1 = await collect(requestSpec(runId, 'l1', 0, 'l1-hit'), 100)
      const requests = [...burst, l1]
      const afterSample = await takeRuntimeSnapshot(snapshotContext)
      const l1Requests = requests.filter((request) => request.subcaseId === 'l1-hit')
      const zeroCommands = {
        redis: l1Requests.reduce((sum, request) => sum + request.redisCommands.length, 0),
        database: l1Requests.reduce((sum, request) => sum + request.dbCommands.length, 0),
        layers: [...new Set(l1Requests.map((request) => request.layerSource))].sort()
      }
      const generation = {
        generationStable: afterBurst.sitemap.generation === afterSample.sitemap.generation,
        burstBuildDelta: afterBurst.sitemap.buildCount - afterWarmup.sitemap.buildCount,
        l1BuildDelta: afterSample.sitemap.buildCount - afterBurst.sitemap.buildCount,
        artifactCount: afterSample.sitemap.artifactCount
      }
      const rebuildCounts = { 'same-generation-100': burst.flatMap((request) => request.cacheEvents).filter((event) => event.outcome === 'built').length }
      return {
        requests,
        assertionResults: [
          exactAssertionResult('l1-zero-commands', { redis: 0, database: 0, layers: ['l1-object'] }, zeroCommands, requests[0]),
          exactAssertionResult('same-generation-build', { generationStable: true, burstBuildDelta: 1, l1BuildDelta: 0, artifactCount: 1 }, generation, burst[0]),
          exactAssertionResult('rebuild-count', scenario.requirements.rebuildCountBySubcase, rebuildCounts, requests[0])
        ],
        parameters: {
          route: '/sitemap.xml',
          afterWarmupSitemap: afterWarmup.sitemap,
          afterBurstSitemap: afterBurst.sitemap,
          afterSampleSitemap: afterSample.sitemap
        }
      }
    }
  })
}
