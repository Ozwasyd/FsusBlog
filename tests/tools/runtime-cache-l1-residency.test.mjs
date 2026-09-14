import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildL1ResidencySpecs,
  produceL1ResidencyReceipt
} from '../../tools/test/runtime-cache-scenarios/l1-residency.mjs'

const digest = (value) => `sha256:${value.toString(16).padStart(64, '0')}`
const baseUrls = ['http://127.0.0.1:5201', 'http://127.0.0.1:5202']

function snapshot(index, after) {
  const nodeId = `node-${index + 1}`
  const policy = (policyId) => ({
    policyId,
    maxEntries: 16,
    maxLogicalBytes: 4096,
    maxCapacityBytes: 8192,
    entries: after ? 16 : 0,
    logicalBytes: after ? 1024 : 0,
    capacityBytes: after ? 4096 : 0,
    capacityEvictions: after ? 9 : 0,
    invalidatedEvictions: 0,
    contendedLockWaitTicks: after ? 20 + index : 10 + index
  })
  return {
    node: {
      nodeId,
      processId: 4201 + index,
      runtimeScope: 'runtime-cache-tests',
      topologyDigest: digest(1),
      topologyNodeIds: ['node-1', 'node-2']
    },
    policies: [policy('SystemPage'), policy('SystemCompliance')]
  }
}

test('builds exactly 100000 unique writes across two nodes and two policies', () => {
  const specs = buildL1ResidencySpecs(100_000, 'l1-cardinality', baseUrls)
  assert.equal(specs.length, 100_000)
  assert.equal(new Set(specs.map((spec) => spec.path)).size, 100_000)
  assert.deepEqual(new Set(specs.map((spec) => spec.baseUrl)), new Set(baseUrls))
  assert.deepEqual(new Set(specs.map((spec) => spec.policyId)), new Set(['SystemPage', 'SystemCompliance']))
  assert.equal(specs.filter((spec) => spec.subcaseId === 'unique-keys-100000').length, 90_000)
  assert.equal(specs.filter((spec) => spec.subcaseId === 'global-lock-tail').length, 10_000)
  assert.ok(specs.every((spec) => Buffer.isBuffer(spec.body) && spec.body.length === 64))
})

test('derives key cardinality and bounded residency from request-bound raw evidence', async () => {
  const requestCount = 40
  let after = false
  const scenarioApi = {
    snapshot: async (baseUrl) => snapshot(baseUrls.indexOf(baseUrl), after),
    cleanup: async () => ({ durableRowsBefore: 0, durableRowsAfter: 0 })
  }
  const fakeProducer = async (_options, plan) => {
    await plan.warmup({ runId: 'l1-runtime-test' })
    after = true
    const collect = async (spec, index) => ({
      id: `request-${index + 1}`,
      subcaseId: spec.subcaseId,
      method: spec.method,
      path: spec.path,
      status: 200,
      payloadDigest: digest(99),
      parityGroup: spec.parityGroup,
      layerSource: 'redis',
      latencyMs: spec.subcaseId === 'global-lock-tail' ? 4 : 2,
      allocatedBytes: 64,
      redisCommands: [{ verb: 'SET', category: 'write', source: 'stackexchange-redis-profiler' }],
      redisFailureEvents: [],
      cacheEvents: [{ family: 'l1-residency', identityDigest: digest(index + 2), outcome: 'published' }],
      dbCommands: []
    })
    return plan.sample({ collect, runId: 'l1-runtime-test' })
  }

  const measured = await produceL1ResidencyReceipt({
    scenario: {
      id: 'l1-residency',
      requests: requestCount,
      concurrency: 8,
      requirements: { uniqueKeys: requestCount }
    },
    identity: { runtime: { processId: 4201 } },
    secret: 'not-emitted',
    nodeBaseUrls: baseUrls,
    scenarioApi,
    produceMeasuredScenarioReceipt: fakeProducer
  })

  assert.equal(measured.requests.length, requestCount)
  assert.ok(measured.assertionResults.every((item) => item.assertion.status === 'passed'))
  assert.equal(measured.parameters.uniquePublishedIdentityDigests, requestCount)
  assert.equal(measured.parameters.residency.after.length, 4)
  assert.ok(measured.parameters.residency.after.every((item) => item.entries <= item.maxEntries))
  const capacity = measured.assertionResults.find((item) => item.assertion.id === 'capacity-budget').assertion.actual
  assert.equal(capacity.redisPublishedRequests, requestCount)
  assert.equal(capacity.requestBoundUniqueIdentityDigests, requestCount)
})

test('fails capacity evidence when a request has no real Redis SET command', async () => {
  const requestCount = 10
  let after = false
  const scenarioApi = { snapshot: async (baseUrl) => snapshot(baseUrls.indexOf(baseUrl), after) }
  const fakeProducer = async (_options, plan) => {
    await plan.warmup({ runId: 'l1-missing-redis' })
    after = true
    const collect = async (spec, index) => ({
      id: `request-${index}`,
      subcaseId: spec.subcaseId,
      method: spec.method,
      path: spec.path,
      status: 200,
      payloadDigest: digest(98),
      parityGroup: spec.parityGroup,
      layerSource: 'redis',
      latencyMs: 1,
      allocatedBytes: 1,
      redisCommands: index === 0 ? [] : [{ verb: 'SET', category: 'write' }],
      cacheEvents: [{ family: 'l1-residency', identityDigest: digest(index + 10), outcome: 'published' }],
      dbCommands: []
    })
    return plan.sample({ collect, runId: 'l1-missing-redis' })
  }

  const measured = await produceL1ResidencyReceipt({
    scenario: { id: 'l1-residency', requests: requestCount, concurrency: 2, requirements: { uniqueKeys: requestCount } },
    identity: { runtime: { processId: 4201 } },
    secret: 'not-emitted',
    nodeBaseUrls: baseUrls,
    scenarioApi,
    produceMeasuredScenarioReceipt: fakeProducer
  })
  const capacity = measured.assertionResults.find((item) => item.assertion.id === 'capacity-budget').assertion
  assert.equal(capacity.status, 'failed')
  assert.equal(capacity.actual.redisPublishedRequests, requestCount - 1)
  assert.equal(capacity.actual.contractSatisfied, false)
})
