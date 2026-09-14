import { createHash } from 'node:crypto'
import fs from 'node:fs'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt,
  takeRuntimeSnapshot
} from '../run-runtime-cache-evidence.mjs'
import {
  assertRedisNamespaceRemoved,
  createScenarioApi,
  policySnapshot,
  resolveTwoNodeBaseUrls
} from './runtime-scenario-support.mjs'

const commentPolicy = 'CommentCursorFrame'
const unrelatedPolicy = 'SystemPage'

function fixtureArticleId(options) {
  if (Number.isInteger(options.articleId) && options.articleId > 0) return options.articleId
  const fixture = JSON.parse(fs.readFileSync(options.identity.fixtureFile, 'utf8'))
  const ids = (fixture.entities ?? [])
    .filter((entity) => entity.producerId === 'public-content' && entity.kind === 'article')
    .map((entity) => Number.parseInt(entity.id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  const direct = Number.parseInt(fixture.articleId, 10)
  const articleId = ids[0] ?? direct
  if (!Number.isInteger(articleId) || articleId <= 0) {
    throw new Error('distributed-invalidation requires a current prepared public article fixture')
  }
  return articleId
}

function eventIdFor(runId) {
  return `runtime-cache-${createHash('sha256').update(runId).digest('hex').slice(0, 32)}`
}

function nodeIdentity(snapshot) {
  const node = snapshot?.node
  if (!node || typeof node.nodeId !== 'string' || node.nodeId.length === 0 || !Number.isInteger(node.processId) || node.processId <= 0) {
    throw new Error('distributed-invalidation node identity is incomplete')
  }
  if (!Array.isArray(node.topologyNodeIds) || node.topologyNodeIds.length !== 2 || typeof node.topologyDigest !== 'string') {
    throw new Error('distributed-invalidation requires a two-node topology snapshot')
  }
  return {
    nodeId: node.nodeId,
    processId: node.processId,
    runtimeScope: node.runtimeScope,
    topologyDigest: node.topologyDigest,
    topologyNodeIds: [...node.topologyNodeIds].sort()
  }
}

function compactResidency(snapshot, policyId) {
  const policy = policySnapshot(snapshot, policyId)
  return {
    nodeId: snapshot.node.nodeId,
    policyId,
    entries: policy.entries,
    logicalBytes: policy.logicalBytes,
    capacityBytes: policy.capacityBytes,
    invalidatedEvictions: policy.invalidatedEvictions
  }
}

function compactDurable(snapshot) {
  const durable = snapshot?.durable
  if (!durable?.obligation) return null
  return {
    eventId: durable.obligation.eventId,
    kind: durable.obligation.kind,
    sourceNodeId: durable.obligation.sourceNodeId,
    state: durable.obligation.state,
    publishStatus: durable.obligation.publishStatus,
    transportStatus: durable.obligation.transportStatus,
    payloadDigest: durable.obligation.payloadDigest,
    requiredNodeIds: [...durable.obligation.requiredNodeIds].sort(),
    ackedNodeIds: [...durable.obligation.ackedNodeIds].sort(),
    inboxes: [...durable.inboxes]
      .map((item) => ({
        targetNodeId: item.targetNodeId,
        applyState: item.applyState,
        payloadDigest: item.payloadDigest,
        appliedGeneration: item.appliedGeneration
      }))
      .sort((left, right) => left.targetNodeId.localeCompare(right.targetNodeId))
  }
}

function convergenceComplete(snapshots, eventId) {
  const identities = snapshots.map(nodeIdentity)
  const nodeIds = identities.map((item) => item.nodeId).sort()
  const durable = compactDurable(snapshots[0])
  return new Set(identities.map((item) => item.processId)).size === 2 &&
    identities.every((item) => JSON.stringify(item.topologyNodeIds) === JSON.stringify(nodeIds)) &&
    durable?.eventId === eventId && durable.state === 'complete' &&
    JSON.stringify(durable.requiredNodeIds) === JSON.stringify(nodeIds) &&
    JSON.stringify(durable.ackedNodeIds) === JSON.stringify(nodeIds) &&
    durable.inboxes.some((item) => item.targetNodeId !== durable.sourceNodeId && item.applyState === 'applied')
}

async function waitForConvergence(api, baseUrls, eventId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const timeline = []
  do {
    const snapshots = await Promise.all(baseUrls.map((baseUrl) => api.snapshot(baseUrl, eventId)))
    timeline.push(snapshots.map((snapshot) => ({
      nodeId: snapshot.node.nodeId,
      processId: snapshot.node.processId,
      hotReadState: snapshot.publicHotRead.state,
      earlyDataPlaneState: snapshot.publicHotRead.earlyDataPlaneState,
      durableState: snapshot.durable?.obligation?.state ?? 'missing'
    })))
    if (convergenceComplete(snapshots, eventId)) return { snapshots, timeline }
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  throw new Error(`distributed invalidation did not durably converge for ${eventId}`)
}

function routeSpecs(count, articleId, baseUrls, phase) {
  const subcases = ['unrelated-policy-residency', 'public-hot-read-ready', 'two-node-convergence']
  return Array.from({ length: count }, (_, index) => ({
    baseUrl: baseUrls[index % baseUrls.length],
    nodeIndex: index % baseUrls.length,
    method: 'GET',
    path: `/api/binary/article/${articleId}.aeds?runtime-cache-evidence=${phase}-${index + 1}`,
    subcaseId: subcases[index % subcases.length],
    parityGroup: 'distributed-route-convergence',
    headers: {}
  }))
}

function routeEvidence(measured) {
  return measured.map(({ request, nodeId }) => ({
    requestId: request.id,
    nodeId,
    status: request.status,
    payloadDigest: request.payloadDigest,
    layerSource: request.layerSource
  }))
}

export async function produceDistributedInvalidationReceipt(options) {
  const { scenario, identity, secret } = options
  const baseUrls = resolveTwoNodeBaseUrls(options)
  const articleId = fixtureArticleId(options)
  const api = createScenarioApi(options)
  const producer = options.produceMeasuredScenarioReceipt ?? produceMeasuredScenarioReceipt
  let beforeSnapshots
  let cleanupContext
  let eventId

  const collectCleanup = async (context) => {
    const results = await Promise.all(baseUrls.map((baseUrl, index) => api.cleanup(baseUrl, {
      scenario: 'distributed-invalidation',
      runId: context.runId,
      articleId,
      eventId,
      keyCount: 0,
      deleteDurable: index === 0,
      deleteShared: index === 0
    })))
    const scan = options.scanRedisNamespace ?? assertRedisNamespaceRemoved
    const namespaceRemoved = await scan(identity, context.runId)
    const after = await takeRuntimeSnapshot({ fetchImpl: options.fetchImpl ?? globalThis.fetch, baseUrl: baseUrls[0], secret, timeoutMs: options.timeoutMs ?? 15000 })
    return {
      status: namespaceRemoved && results.every((item) => item.durableRowsAfter === 0) ? 'passed' : 'failed',
      namespaceRemoved,
      activeKeyedEntries: after.activeKeyedEntries,
      durableRowsBefore: results.reduce((sum, item) => sum + item.durableRowsBefore, 0),
      durableRowsAfter: results.reduce((sum, item) => sum + item.durableRowsAfter, 0),
      checkedAt: new Date().toISOString()
    }
  }

  return producer({ ...options, collectCleanup }, {
    warmup: async ({ collect, runId }) => {
      cleanupContext = runId
      eventId = eventIdFor(runId)
      await Promise.all(baseUrls.map((baseUrl) => api.prepareDistributed(baseUrl, { runId, articleId })))
      const specs = routeSpecs(scenario.warmupRequests, articleId, baseUrls, 'warmup')
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
      beforeSnapshots = await Promise.all(baseUrls.map((baseUrl) => api.snapshot(baseUrl)))
      return requests
    },
    sample: async ({ collect, runId }) => {
      if (!beforeSnapshots || cleanupContext !== runId) throw new Error('distributed-invalidation warmup state is missing')
      if (!eventId) throw new Error('distributed-invalidation event identity is missing')
      const sourceIdentity = nodeIdentity(beforeSnapshots[0])
      if (sourceIdentity.processId !== identity.runtime.processId) {
        throw new Error('distributed-invalidation source node does not match the receipt Kestrel identity')
      }
      const triggerSpec = {
        baseUrl: baseUrls[0],
        method: 'POST',
        path: '/_fsus/testing/runtime-cache/scenarios/distributed/trigger',
        body: JSON.stringify({ runId, articleId, eventId }),
        contentType: 'application/json',
        subcaseId: 'comment-mutation',
        parityGroup: 'distributed-comment-mutation',
        headers: {}
      }
      const trigger = await collect(triggerSpec, 0)
      const { snapshots: afterSnapshots, timeline } = await waitForConvergence(
        api,
        baseUrls,
        eventId,
        options.convergenceTimeoutMs ?? 15000)
      const specs = routeSpecs(scenario.requests - 1, articleId, baseUrls, 'sample')
      const routeRequests = await mapConcurrent(specs, scenario.concurrency, async (spec, index) => ({
        request: await collect(spec, index + 1),
        nodeId: afterSnapshots[spec.nodeIndex].node.nodeId
      }))
      const requests = [trigger, ...routeRequests.map((item) => item.request)]
      const nodeIds = afterSnapshots.map((snapshot) => snapshot.node.nodeId).sort()
      const unrelatedBefore = beforeSnapshots.map((snapshot) => compactResidency(snapshot, unrelatedPolicy))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      const unrelatedAfter = afterSnapshots.map((snapshot) => compactResidency(snapshot, unrelatedPolicy))
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
      const targetBefore = compactResidency(beforeSnapshots[1], commentPolicy)
      const targetAfter = compactResidency(afterSnapshots[1], commentPolicy)
      const durable = compactDurable(afterSnapshots[0])
      const targetInbox = durable?.inboxes.find((item) => item.targetNodeId === beforeSnapshots[1].node.nodeId)
      const expectedDurable = {
        eventId,
        kind: 'comment_mutation',
        sourceNodeId: beforeSnapshots[0].node.nodeId,
        state: 'complete',
        publishStatus: 'Published',
        transportStatus: 'Delivered',
        payloadDigest: durable?.payloadDigest,
        requiredNodeIds: nodeIds,
        ackedNodeIds: nodeIds,
        inboxes: [{
          targetNodeId: beforeSnapshots[1].node.nodeId,
          applyState: 'applied',
          payloadDigest: durable?.payloadDigest,
          appliedGeneration: targetInbox?.appliedGeneration
        }]
      }
      const routeActual = routeEvidence(routeRequests)
      const referenceDigest = routeActual[0]?.payloadDigest
      const routeExpected = routeActual.map((item) => ({ ...item, status: 200, payloadDigest: referenceDigest }))
      const readyActual = timeline.flat().map((item) => ({
        nodeId: item.nodeId,
        processId: item.processId,
        hotReadState: item.hotReadState,
        earlyDataPlaneState: item.earlyDataPlaneState
      }))
      const readyExpected = readyActual.map((item) => ({ ...item, hotReadState: 'Ready', earlyDataPlaneState: 'ready' }))
      const residencyExpected = {
        nodeId: targetBefore.nodeId,
        policyId: commentPolicy,
        entriesBefore: targetBefore.entries,
        entriesAfter: Math.max(0, targetBefore.entries - 1),
        invalidatedEvictionsBefore: targetBefore.invalidatedEvictions,
        invalidatedEvictionsAfter: targetBefore.invalidatedEvictions + 1
      }
      const residencyActual = {
        nodeId: targetAfter.nodeId,
        policyId: commentPolicy,
        entriesBefore: targetBefore.entries,
        entriesAfter: targetAfter.entries,
        invalidatedEvictionsBefore: targetBefore.invalidatedEvictions,
        invalidatedEvictionsAfter: targetAfter.invalidatedEvictions
      }
      return {
        requests,
        assertionResults: [
          exactAssertionResult('unrelated-policy-residency', unrelatedBefore, unrelatedAfter, trigger),
          exactAssertionResult('public-hot-read-ready', readyExpected, readyActual, trigger),
          exactAssertionResult('two-node-route', routeExpected, routeActual, routeRequests[0]?.request ?? trigger),
          exactAssertionResult('durable-convergence', expectedDurable, durable, trigger),
          exactAssertionResult('residency-convergence', residencyExpected, residencyActual, trigger)
        ],
        parameters: {
          articleId,
          eventId,
          nodeIdentities: afterSnapshots.map(nodeIdentity),
          durable,
          convergenceTimeline: timeline,
          unrelatedResidency: { before: unrelatedBefore, after: unrelatedAfter },
          targetResidency: { before: targetBefore, after: targetAfter },
          routeEvidence: routeActual
        }
      }
    }
  })
}
