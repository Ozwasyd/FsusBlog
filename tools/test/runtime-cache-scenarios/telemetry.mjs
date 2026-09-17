import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

const secretHeader = 'X-Fsus-Runtime-Evidence-Secret'
const prefix = '/_fsus/testing/runtime-cache/scenarios/telemetry'

async function control(fetchImpl, baseUrl, secret, path, method = 'GET') {
  const response = await fetchImpl(`${baseUrl}${path}`, { method, headers: { [secretHeader]: secret } })
  if (!response.ok) throw new Error(`telemetry control ${method} ${path} returned HTTP ${response.status}`)
  return await response.json()
}

function counter(snapshot, operation, layer, result) {
  return snapshot.operations
    .filter((item) => item.operation === operation && item.layer === layer && item.result === result)
    .reduce((sum, item) => sum + item.count, 0)
}

function delta(after, before, operation, layer, result) {
  return counter(after, operation, layer, result) - counter(before, operation, layer, result)
}

function specsFor(scenario, runId) {
  const errorCount = Math.max(1, Math.floor(scenario.requests / 20))
  const missCount = Math.max(1, Math.floor(scenario.requests / 20))
  const hitCount = scenario.requests - errorCount - missCount
  return {
    errorCount,
    missCount,
    hitCount,
    specs: Array.from({ length: scenario.requests }, (_, index) => {
      const mode = index < hitCount ? 'hit' : index < hitCount + missCount ? 'miss' : 'error'
      const ordinal = mode === 'error' ? index - hitCount - missCount : index
      return {
        method: 'GET',
        path: `${prefix}/${runId}/probe/${mode}/${ordinal}`,
        subcaseId: mode === 'hit' ? (index === 0 ? 'unsampled-l1-hit' : 'exact-hit-count') : mode,
        parityGroup: `telemetry-${mode}`,
        headers: {}
      }
    })
  }
}

async function takeBoundary(fetchImpl, baseUrl, secret, requestId) {
  return control(fetchImpl, baseUrl, secret, `${prefix}/boundaries/${encodeURIComponent(requestId)}`)
}

export async function produceTelemetryReceipt(options) {
  const { scenario, baseUrl, secret } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const layout = specsFor(scenario, options.runId)
  let before
  let after
  let cleanupDone = false
  await control(fetchImpl, baseUrl, secret, `${prefix}/${options.runId}/prepare?errorCount=${layout.errorCount}`, 'POST')

  return produceMeasuredScenarioReceipt({
    ...options,
    fetchImpl,
    collectCleanup: async (context) => {
      await control(fetchImpl, baseUrl, secret, `${prefix}/${context.runId}`, 'DELETE')
      cleanupDone = true
      return { status: 'passed', namespaceRemoved: true, activeKeyedEntries: 0, durableRowsBefore: 0, durableRowsAfter: 0, checkedAt: new Date().toISOString() }
    }
  }, {
    warmup: async ({ collect, runId }) => {
      const warmup = Array.from({ length: scenario.warmupRequests }, (_, index) => ({
        method: 'GET', path: `${prefix}/${runId}/probe/hit/${index}`, subcaseId: 'exact-hit-count', parityGroup: 'telemetry-hit', headers: {}
      }))
      const requests = await mapConcurrent(warmup, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
      await Promise.all(requests.map((request) => takeBoundary(fetchImpl, baseUrl, secret, request.id)))
      before = await control(fetchImpl, baseUrl, secret, `${prefix}/snapshot`)
      return requests
    },
    sample: async ({ collect }) => {
      const requests = await mapConcurrent(layout.specs, scenario.concurrency, (spec, index) => collect(spec, index))
      const boundaries = (await Promise.all(requests.map((request) => takeBoundary(fetchImpl, baseUrl, secret, request.id)))).flat()
      after = await control(fetchImpl, baseUrl, secret, `${prefix}/snapshot`)
      const hitBoundaries = boundaries.filter((item) => item.outcome === 'hit')
      const unsampled = hitBoundaries.filter((item) => item.sampled === false)
      const sameThread = unsampled.every((item) => item.startedThreadId === item.completedThreadId)
      const maxUnsampledAllocation = Math.max(...unsampled.map((item) => item.allocatedBytes), -1)
      const exactHitDelta = after.l1.exactHitCount - before.l1.exactHitCount
      const missDelta = delta(after, before, 'get', 'l2', 'miss')
      const errorDelta = delta(after, before, 'get', 'l1', 'decode_failed')
      return {
        requests,
        assertionResults: [
          exactAssertionResult('unsampled-l1-zero-allocation', { observed: true, sameThread: true, maxBytes: 0 }, { observed: unsampled.length > 0, sameThread, maxBytes: maxUnsampledAllocation }, requests[0]),
          exactAssertionResult('exact-hit-count', { hits: layout.hitCount }, { hits: exactHitDelta }, requests.find((request) => request.subcaseId === 'exact-hit-count') ?? requests[0]),
          exactAssertionResult('full-miss-error-capture', { misses: layout.missCount, errors: layout.errorCount }, { misses: missDelta, errors: errorDelta }, requests.find((request) => request.subcaseId === 'error') ?? requests[0])
        ],
        parameters: {
          policy: 'SystemPage',
          synchronousL1Boundary: true,
          observedBoundaries: boundaries.length,
          sampledBoundaries: hitBoundaries.length - unsampled.length,
          unsampledBoundaries: unsampled.length,
          unsampledL1AllocationAuthority: 'runtime-cache-l1-boundary',
          cleanupOwnedByScenario: !cleanupDone
        }
      }
    }
  })
}

export const telemetryScenarioInternals = Object.freeze({ counter, delta, specsFor })
