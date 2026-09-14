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
  const beforeWarmup = await takeRuntimeSnapshot(snapshotContext)
  let afterWarmup

  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = Array.from({ length: scenario.warmupRequests }, (_, index) =>
        requestSpec(runId, 'warmup', index, 'l1-hit'))
      const first = specs.length === 0 ? [] : [await collect(specs[0], 0, 'warmup')]
      const remaining = await mapConcurrent(specs.slice(1), scenario.concurrency, (spec, index) =>
        collect(spec, index + 1, 'warmup'))
      afterWarmup = await takeRuntimeSnapshot(snapshotContext)
      return [...first, ...remaining]
    },
    sample: async ({ collect, runId }) => {
      if (!afterWarmup) throw new Error('sitemap warmup snapshot is missing')
      const specs = Array.from({ length: scenario.requests }, (_, index) =>
        requestSpec(runId, 'sample', index, index === 0 ? 'l1-hit' : 'same-generation-100'))
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index))
      const afterSample = await takeRuntimeSnapshot(snapshotContext)
      const zeroCommands = {
        redis: requests.reduce((sum, request) => sum + request.redisCommands.length, 0),
        database: requests.reduce((sum, request) => sum + request.dbCommands.length, 0),
        layers: [...new Set(requests.map((request) => request.layerSource))].sort()
      }
      const generation = {
        generationStable: afterWarmup.sitemap.generation === afterSample.sitemap.generation,
        sampleBuildDelta: afterSample.sitemap.buildCount - afterWarmup.sitemap.buildCount,
        artifactCount: afterSample.sitemap.artifactCount
      }
      const rebuildCounts = {
        'same-generation-100': afterWarmup.sitemap.buildCount - beforeWarmup.sitemap.buildCount
      }
      return {
        requests,
        assertionResults: [
          exactAssertionResult('l1-zero-commands', { redis: 0, database: 0, layers: ['l1-object'] }, zeroCommands, requests[0]),
          exactAssertionResult('same-generation-build', { generationStable: true, sampleBuildDelta: 0, artifactCount: 1 }, generation, requests[0]),
          exactAssertionResult('rebuild-count', scenario.requirements.rebuildCountBySubcase, rebuildCounts, requests[0])
        ],
        parameters: {
          route: '/sitemap.xml',
          beforeWarmupSitemap: beforeWarmup.sitemap,
          afterWarmupSitemap: afterWarmup.sitemap,
          afterSampleSitemap: afterSample.sitemap
        }
      }
    }
  })
}
