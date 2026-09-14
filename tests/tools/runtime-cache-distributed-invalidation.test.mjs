import assert from 'node:assert/strict'
import test from 'node:test'

import { produceDistributedInvalidationReceipt } from '../../tools/test/runtime-cache-scenarios/distributed-invalidation.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`
const baseUrls = ['http://127.0.0.1:5101', 'http://127.0.0.1:5102']

function policy(policyId, entries, invalidatedEvictions) {
  return {
    policyId,
    maxEntries: 1024,
    maxLogicalBytes: 8_388_608,
    maxCapacityBytes: 8_388_608,
    entries,
    logicalBytes: entries * 64,
    capacityBytes: entries * 256,
    capacityEvictions: 0,
    invalidatedEvictions,
    contendedLockWaitTicks: 0
  }
}

function snapshot(index, triggered, eventId) {
  const nodeId = `node-${index + 1}`
  return {
    node: {
      nodeId,
      processId: 4101 + index,
      runtimeScope: 'runtime-cache-tests',
      topologyDigest: digest('a'),
      topologyNodeIds: ['node-1', 'node-2']
    },
    policies: [
      policy('CommentCursorFrame', triggered && index === 1 ? 4 : 5, triggered && index === 1 ? 11 : 10),
      policy('SystemPage', 3, 2)
    ],
    publicHotRead: {
      state: 'Ready',
      earlyDataPlaneState: 'ready',
      version: 7
    },
    durable: triggered
      ? {
          obligation: {
            eventId,
            kind: 'comment_mutation',
            sourceNodeId: 'node-1',
            state: 'complete',
            publishStatus: 'Published',
            transportStatus: 'Delivered',
            payloadDigest: digest('b'),
            requiredNodeIds: ['node-1', 'node-2'],
            ackedNodeIds: ['node-1', 'node-2']
          },
          inboxes: [{
            targetNodeId: 'node-2',
            applyState: 'applied',
            payloadDigest: digest('b'),
            appliedGeneration: 19
          }]
        }
      : null
  }
}

function observed(spec, index) {
  const trigger = spec.method === 'POST'
  return {
    id: `request-${index + 1}`,
    subcaseId: spec.subcaseId,
    method: spec.method,
    path: spec.path,
    status: 200,
    payloadDigest: trigger ? digest('c') : digest('d'),
    parityGroup: spec.parityGroup,
    layerSource: trigger ? 'database+redis' : 'l0-allow',
    latencyMs: index + 1,
    allocatedBytes: 128,
    redisCommands: trigger ? [{ verb: 'PUBLISH', category: 'write', source: 'stackexchange-redis-profiler' }] : [],
    redisFailureEvents: [],
    cacheEvents: trigger ? [{ family: 'distributed-invalidation', identityDigest: digest('e'), outcome: 'published' }] : [],
    dbCommands: trigger ? [{ fingerprint: digest('f'), source: 'npgsql-interceptor' }] : []
  }
}

test('derives durable and route convergence from two-node snapshots and measured requests', async () => {
  let triggered = false
  let eventId
  const scenarioApi = {
    prepareDistributed: async () => ({ prepared: true }),
    snapshot: async (baseUrl) => snapshot(baseUrls.indexOf(baseUrl), triggered, eventId),
    cleanup: async () => ({ durableRowsBefore: 0, durableRowsAfter: 0 })
  }
  const fakeProducer = async (_options, plan) => {
    const collect = async (spec, index) => {
      if (spec.method === 'POST') {
        eventId = JSON.parse(spec.body).eventId
        triggered = true
      }
      return observed(spec, index)
    }
    await plan.warmup({ collect, runId: 'distributed-test-run' })
    return plan.sample({ collect, runId: 'distributed-test-run' })
  }

  const measured = await produceDistributedInvalidationReceipt({
    scenario: {
      id: 'distributed-invalidation',
      requests: 8,
      warmupRequests: 2,
      concurrency: 2,
      subcases: ['comment-mutation', 'unrelated-policy-residency', 'public-hot-read-ready', 'two-node-convergence']
    },
    identity: { runtime: { processId: 4101 } },
    secret: 'not-emitted',
    runId: 'distributed-test-run',
    articleId: 42,
    nodeBaseUrls: baseUrls,
    scenarioApi,
    produceMeasuredScenarioReceipt: fakeProducer
  })

  assert.equal(measured.requests.length, 8)
  assert.ok(measured.assertionResults.every((item) => item.assertion.status === 'passed'))
  assert.equal(measured.parameters.durable.state, 'complete')
  assert.deepEqual(measured.parameters.durable.ackedNodeIds, ['node-1', 'node-2'])
  assert.equal(measured.parameters.targetResidency.before.entries, 5)
  assert.equal(measured.parameters.targetResidency.after.entries, 4)
  assert.equal(measured.parameters.routeEvidence.length, 7)
  assert.ok(eventId.startsWith('runtime-cache-'))
})

test('rejects snapshots that do not prove two distinct Kestrel processes', async () => {
  const scenarioApi = {
    prepareDistributed: async () => ({ prepared: true }),
    snapshot: async () => ({
      ...snapshot(0, false),
      node: { ...snapshot(0, false).node, nodeId: 'same-node', topologyNodeIds: ['same-node'] }
    })
  }
  const fakeProducer = async (_options, plan) => {
    const collect = async (spec, index) => observed(spec, index)
    await plan.warmup({ collect, runId: 'distributed-invalid-topology' })
    return plan.sample({ collect, runId: 'distributed-invalid-topology' })
  }

  await assert.rejects(() => produceDistributedInvalidationReceipt({
    scenario: { id: 'distributed-invalidation', requests: 4, warmupRequests: 2, concurrency: 2 },
    identity: { runtime: { processId: 4101 } },
    secret: 'not-emitted',
    articleId: 42,
    nodeBaseUrls: baseUrls,
    scenarioApi,
    produceMeasuredScenarioReceipt: fakeProducer
  }), /two-node topology snapshot|durably converge/u)
})
