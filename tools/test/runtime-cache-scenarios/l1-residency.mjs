import {
  mapConcurrent,
  produceMeasuredScenarioReceipt,
  takeRuntimeSnapshot
} from '../run-runtime-cache-evidence.mjs'
import {
  assertRedisNamespaceRemoved,
  createScenarioApi,
  evidenceAssertion,
  percentile,
  policySnapshot,
  resolveTwoNodeBaseUrls
} from './runtime-scenario-support.mjs'

const policies = ['SystemPage', 'SystemCompliance']
const redisStorageWriteVerbs = new Set(['SET', 'SETEX', 'PSETEX'])

export function buildL1ResidencySpecs(requestCount, runId, baseUrls) {
  if (!Number.isInteger(requestCount) || requestCount < 2) throw new Error('l1-residency requires at least two requests')
  const tailStart = Math.max(1, Math.floor(requestCount * 0.9))
  const body = Buffer.alloc(64, 0x5a)
  return Array.from({ length: requestCount }, (_, index) => ({
    baseUrl: baseUrls[index % baseUrls.length],
    nodeIndex: index % baseUrls.length,
    policyId: policies[index % policies.length],
    method: 'PUT',
    path: `/_fsus/testing/runtime-cache/scenarios/l1/${encodeURIComponent(runId)}/${index + 1}`,
    body,
    contentType: 'application/octet-stream',
    subcaseId: index < tailStart ? 'unique-keys-100000' : 'global-lock-tail',
    parityGroup: index < tailStart ? 'l1-unique-key-admission' : 'l1-global-lock-tail',
    headers: {}
  }))
}

function compactPolicy(snapshot, policyId) {
  const policy = policySnapshot(snapshot, policyId)
  return {
    nodeId: snapshot.node.nodeId,
    processId: snapshot.node.processId,
    policyId,
    maxEntries: policy.maxEntries,
    maxLogicalBytes: policy.maxLogicalBytes,
    maxCapacityBytes: policy.maxCapacityBytes,
    entries: policy.entries,
    logicalBytes: policy.logicalBytes,
    capacityBytes: policy.capacityBytes,
    capacityEvictions: policy.capacityEvictions,
    contendedLockWaitTicks: policy.contendedLockWaitTicks
  }
}

function residencyEvidence(snapshots) {
  return snapshots.flatMap((snapshot) => policies.map((policyId) => compactPolicy(snapshot, policyId)))
    .sort((left, right) => `${left.nodeId}:${left.policyId}`.localeCompare(`${right.nodeId}:${right.policyId}`))
}

function validateTwoNodeSnapshots(snapshots, primaryProcessId) {
  const processIds = snapshots.map((snapshot) => snapshot.node.processId)
  if (new Set(processIds).size !== 2 || processIds[0] !== primaryProcessId) {
    throw new Error('l1-residency snapshots do not bind two distinct Kestrel processes')
  }
  const nodeIds = snapshots.map((snapshot) => snapshot.node.nodeId).sort()
  if (snapshots.some((snapshot) => snapshot.node.topologyDigest !== snapshots[0].node.topologyDigest ||
    JSON.stringify([...snapshot.node.topologyNodeIds].sort()) !== JSON.stringify(nodeIds))) {
    throw new Error('l1-residency snapshots do not bind one two-node topology manifest')
  }
}

function uniquePublishedKeys(requests) {
  const identities = new Set()
  for (const request of requests) {
    for (const event of request.cacheEvents ?? []) {
      if (event.family === 'l1-residency' && event.outcome === 'published') identities.add(event.identityDigest)
    }
  }
  return identities.size
}

function tailEvidence(requests, before, after) {
  const baseline = requests.filter((request) => request.subcaseId === 'unique-keys-100000').map((request) => request.latencyMs)
  const tail = requests.filter((request) => request.subcaseId === 'global-lock-tail').map((request) => request.latencyMs)
  const baselineP99 = percentile(baseline, 99)
  const tailP50 = percentile(tail, 50)
  const tailP99 = percentile(tail, 99)
  const p99LimitMs = Math.max(50, baselineP99 * 4)
  const beforeTicks = before.reduce((sum, item) => sum + item.contendedLockWaitTicks, 0)
  const afterTicks = after.reduce((sum, item) => sum + item.contendedLockWaitTicks, 0)
  return {
    baselineRequestCount: baseline.length,
    tailRequestCount: tail.length,
    baselineP99Ms: baselineP99,
    tailP50Ms: tailP50,
    tailP99Ms: tailP99,
    p99LimitMs,
    contendedLockWaitTicksDelta: Math.max(0, afterTicks - beforeTicks)
  }
}

export async function produceL1ResidencyReceipt(options) {
  const { scenario, identity, secret } = options
  const baseUrls = resolveTwoNodeBaseUrls(options)
  const api = createScenarioApi(options)
  const producer = options.produceMeasuredScenarioReceipt ?? produceMeasuredScenarioReceipt
  let beforeSnapshots

  const collectCleanup = async (context) => {
    const results = await Promise.all(baseUrls.map((baseUrl, index) => api.cleanup(baseUrl, {
      scenario: 'l1-residency',
      runId: context.runId,
      articleId: 0,
      eventId: null,
      keyCount: scenario.requirements.uniqueKeys,
      deleteDurable: false,
      deleteShared: index === 0
    })))
    const scan = options.scanRedisNamespace ?? assertRedisNamespaceRemoved
    const namespaceRemoved = await scan(identity, context.runId)
    const after = await takeRuntimeSnapshot({ fetchImpl: options.fetchImpl ?? globalThis.fetch, baseUrl: baseUrls[0], secret, timeoutMs: options.timeoutMs ?? 15000 })
    return {
      status: namespaceRemoved ? 'passed' : 'failed',
      namespaceRemoved,
      activeKeyedEntries: after.activeKeyedEntries,
      durableRowsBefore: results.reduce((sum, item) => sum + item.durableRowsBefore, 0),
      durableRowsAfter: results.reduce((sum, item) => sum + item.durableRowsAfter, 0),
      checkedAt: new Date().toISOString()
    }
  }

  return producer({ ...options, collectCleanup }, {
    warmup: async () => {
      beforeSnapshots = await Promise.all(baseUrls.map((baseUrl) => api.snapshot(baseUrl)))
      validateTwoNodeSnapshots(beforeSnapshots, identity.runtime.processId)
      return []
    },
    sample: async ({ collect, runId }) => {
      if (!beforeSnapshots) throw new Error('l1-residency warmup snapshot is missing')
      const specs = buildL1ResidencySpecs(scenario.requests, runId, baseUrls)
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index))
      const afterSnapshots = await Promise.all(baseUrls.map((baseUrl) => api.snapshot(baseUrl)))
      validateTwoNodeSnapshots(afterSnapshots, identity.runtime.processId)
      const before = residencyEvidence(beforeSnapshots)
      const after = residencyEvidence(afterSnapshots)
      const uniqueKeys = uniquePublishedKeys(requests)
      const redisPublishedRequests = requests.filter((request) =>
        request.redisCommands.some((command) => redisStorageWriteVerbs.has(command.verb))).length
      const logicalWithinBudget = after.every((item) => item.logicalBytes <= item.maxLogicalBytes)
      const capacityWithinBudget = after.every((item) => item.capacityBytes <= item.maxCapacityBytes && item.entries <= item.maxEntries) &&
        after.reduce((sum, item) => sum + item.entries, 0) > 0 &&
        after.reduce((sum, item) => sum + item.capacityEvictions, 0) > 0 &&
        redisPublishedRequests === scenario.requests && uniqueKeys === scenario.requirements.uniqueKeys
      const logicalEvidence = {
        policies: after.map((item) => ({ nodeId: item.nodeId, policyId: item.policyId, bytes: item.logicalBytes, budgetBytes: item.maxLogicalBytes }))
      }
      const capacityEvidence = {
        policies: after.map((item) => ({
          nodeId: item.nodeId,
          policyId: item.policyId,
          entries: item.entries,
          entryBudget: item.maxEntries,
          bytes: item.capacityBytes,
          budgetBytes: item.maxCapacityBytes,
          capacityEvictions: item.capacityEvictions
        })),
        requestCount: scenario.requests,
        redisPublishedRequests,
        requestBoundUniqueIdentityDigests: uniqueKeys
      }
      const tail = tailEvidence(requests, before, after)
      const noGlobalLockTail = tail.tailP99Ms <= tail.p99LimitMs
      return {
        requests,
        assertionResults: [
          {
            assertion: {
              id: 'unique-key-count',
              status: uniqueKeys === scenario.requirements.uniqueKeys ? 'passed' : 'failed',
              expected: scenario.requirements.uniqueKeys,
              actual: uniqueKeys
            },
            firstRequest: requests.find((request) => !(request.cacheEvents ?? []).some((event) => event.family === 'l1-residency' && event.outcome === 'published')) ?? requests[0]
          },
          evidenceAssertion('logical-budget', logicalWithinBudget, logicalEvidence, requests[0]),
          evidenceAssertion('capacity-budget', capacityWithinBudget, capacityEvidence, requests[0]),
          evidenceAssertion('no-global-lock-tail', noGlobalLockTail, tail, requests.find((request) => request.subcaseId === 'global-lock-tail') ?? requests[0])
        ],
        parameters: {
          nodeIdentities: afterSnapshots.map((snapshot) => snapshot.node),
          uniquePublishedIdentityDigests: uniqueKeys,
          residency: { before, after },
          tail
        }
      }
    }
  })
}
