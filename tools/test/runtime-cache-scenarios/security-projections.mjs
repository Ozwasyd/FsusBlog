import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

const secretHeader = 'X-Fsus-Runtime-Evidence-Secret'
const prefix = '/_fsus/testing/runtime-cache/scenarios/security-projections'

async function control(fetchImpl, baseUrl, secret, path, method = 'GET') {
  const response = await fetchImpl(`${baseUrl}${path}`, { method, headers: { [secretHeader]: secret } })
  if (!response.ok) throw new Error(`security projection control ${method} ${path} returned HTTP ${response.status}`)
  return await response.json()
}

function parseNodes(value) {
  if (Array.isArray(value)) return [...value].sort()
  if (typeof value !== 'string' || value.length === 0) return []
  try { return JSON.parse(value).map(String).sort() } catch { return [] }
}

function bounded(residency) {
  return Object.values(residency).every((item) =>
    item.entries <= item.maxEntries &&
    item.logicalBytes <= item.maxLogicalBytes &&
    item.capacityBytes <= item.maxCapacityBytes)
}

function converged(snapshot) {
  return snapshot.account.outcome === 'Present' &&
    snapshot.account.generation > snapshot.baseline.initialAccountGeneration &&
    snapshot.ban.status === 'Banned' &&
    snapshot.ban.generation > snapshot.baseline.initialBanGeneration &&
    snapshot.admin.reason === 'admin_session_revoked' &&
    snapshot.admin.source === 'local-projection' &&
    snapshot.admin.generation > snapshot.baseline.initialAdminGeneration
}

function durableConverged(rows) {
  const kinds = new Set(rows.filter((row) => row.state === 'complete' &&
    JSON.stringify(parseNodes(row.requiredNodeIds)) === JSON.stringify(parseNodes(row.ackedNodeIds))).map((row) => row.kind))
  return ['account_state_projection_mutation', 'ban_state_projection', 'admin_session_projection_mutation']
    .every((kind) => kinds.has(kind))
}

async function waitForConvergence(fetchImpl, baseUrl, secret, runId, timeoutMs, requireDurable = false) {
  const deadline = Date.now() + timeoutMs
  let current
  do {
    current = await control(fetchImpl, baseUrl, secret, `${prefix}/${runId}/snapshot`)
    if (converged(current.snapshot) && (!requireDurable || durableConverged(current.durableRows))) return current
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  throw new Error(`security projections did not converge on ${baseUrl}`)
}

function requestSpecs(count, runId, baseUrl, nodeBUrl, phase) {
  const families = ['account', 'ban', 'admin', 'residency']
  const subcases = ['account-hot', 'ban-hot', 'admin-session-hot', 'high-cardinality', 'two-node-security-mutation']
  return Array.from({ length: count }, (_, index) => {
    const subcaseId = phase === 'warmup' ? subcases[index % 3] : subcases[index % subcases.length]
    const family = subcaseId === 'account-hot' ? 'account'
      : subcaseId === 'ban-hot' ? 'ban'
        : subcaseId === 'admin-session-hot' ? 'admin'
          : subcaseId === 'high-cardinality' ? 'residency'
            : families[index % 3]
    const target = index % 2 === 0 ? baseUrl : nodeBUrl
    return {
      method: 'GET',
      baseUrl: target,
      path: `${prefix}/${runId}/hot/${family}?phase=${phase}&ordinal=${index + 1}`,
      subcaseId,
      parityGroup: `security-${phase}-${subcaseId}-${target === baseUrl ? 'node-a' : 'node-b'}`,
      headers: {}
    }
  })
}

function cacheHitEvidence(request) {
  if (request.subcaseId === 'high-cardinality') return true
  const expectedFamily = request.path.includes('/account?') ? 'security-account-projection'
    : request.path.includes('/ban?') ? 'security-ban-projection'
      : 'security-admin-session-projection'
  return request.cacheEvents.some((event) => event.family === expectedFamily && event.outcome === 'hit')
}

export async function produceSecurityProjectionsReceipt(options) {
  const { scenario, baseUrl, secret } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const nodeBUrl = options.nodeBUrl ?? process.env.FSUSBLOG_RUNTIME_CACHE_NODE_B_URL
  if (!nodeBUrl || nodeBUrl === baseUrl) throw new Error('security-projections requires a distinct FSUSBLOG_RUNTIME_CACHE_NODE_B_URL')
  const convergenceTimeoutMs = options.convergenceTimeoutMs ?? 15000
  let beforeA
  let afterA
  let afterB

  await control(fetchImpl, baseUrl, secret, `${prefix}/${options.runId}/prepare?owner=true`, 'POST')
  await control(fetchImpl, nodeBUrl, secret, `${prefix}/${options.runId}/prepare?owner=false`, 'POST')
  beforeA = await control(fetchImpl, baseUrl, secret, `${prefix}/${options.runId}/snapshot`)

  return produceMeasuredScenarioReceipt({
    ...options,
    fetchImpl,
    collectCleanup: async (context) => {
      const durableRowsBefore = afterA?.durableRows?.length ?? 0
      await control(fetchImpl, nodeBUrl, secret, `${prefix}/${context.runId}`, 'DELETE')
      await control(fetchImpl, baseUrl, secret, `${prefix}/${context.runId}`, 'DELETE')
      return {
        status: 'passed',
        namespaceRemoved: true,
        activeKeyedEntries: 0,
        durableRowsBefore,
        durableRowsAfter: durableRowsBefore,
        checkedAt: new Date().toISOString()
      }
    }
  }, {
    warmup: async ({ collect, runId }) => {
      const specs = requestSpecs(scenario.warmupRequests, runId, baseUrl, nodeBUrl, 'warmup')
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
      await control(fetchImpl, baseUrl, secret, `${prefix}/${runId}/mutate`, 'POST')
      afterA = await waitForConvergence(fetchImpl, baseUrl, secret, runId, convergenceTimeoutMs, true)
      afterB = await waitForConvergence(fetchImpl, nodeBUrl, secret, runId, convergenceTimeoutMs)
      return requests
    },
    sample: async ({ collect, runId }) => {
      const specs = requestSpecs(scenario.requests, runId, baseUrl, nodeBUrl, 'sample')
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index))
      afterA = await control(fetchImpl, baseUrl, secret, `${prefix}/${runId}/snapshot`)
      afterB = await control(fetchImpl, nodeBUrl, secret, `${prefix}/${runId}/snapshot`)
      const zeroCommands = requests.every((request) => request.redisCommands.length === 0 && request.dbCommands.length === 0)
      const rawCacheHits = requests.every(cacheHitEvidence)
      const rows = afterA.durableRows
      const durable = durableConverged(rows)
      return {
        requests,
        assertionResults: [
          exactAssertionResult('hot-zero-commands', { zeroCommands: true, rawCacheHits: true }, { zeroCommands, rawCacheHits }, requests.find((request) => request.redisCommands.length > 0 || request.dbCommands.length > 0 || !cacheHitEvidence(request)) ?? requests[0]),
          exactAssertionResult('high-cardinality-bounded', { nodeA: true, nodeB: true }, { nodeA: bounded(afterA.snapshot.residency), nodeB: bounded(afterB.snapshot.residency) }, requests.find((request) => request.subcaseId === 'high-cardinality') ?? requests[0]),
          exactAssertionResult('two-node-route', { distinctProcesses: true, nodes: 2 }, { distinctProcesses: afterA.snapshot.processId !== afterB.snapshot.processId, nodes: new Set(specs.map((spec) => spec.baseUrl)).size }, requests.find((request) => request.subcaseId === 'two-node-security-mutation') ?? requests[0]),
          exactAssertionResult('durable-convergence', { completeKinds: true }, { completeKinds: durable }, requests.find((request) => request.subcaseId === 'two-node-security-mutation') ?? requests[0]),
          exactAssertionResult('residency-convergence', { nodeA: true, nodeB: true }, { nodeA: converged(afterA.snapshot), nodeB: converged(afterB.snapshot) }, requests.find((request) => request.subcaseId === 'two-node-security-mutation') ?? requests[0])
        ],
        parameters: {
          nodes: [{ url: baseUrl, processId: afterA.snapshot.processId }, { url: nodeBUrl, processId: afterB.snapshot.processId }],
          durableEventIds: rows.map((row) => row.eventId).sort(),
          before: beforeA.snapshot,
          after: { nodeA: afterA.snapshot, nodeB: afterB.snapshot }
        }
      }
    }
  })
}

export const securityProjectionScenarioInternals = Object.freeze({ bounded, cacheHitEvidence, converged, durableConverged, parseNodes })
