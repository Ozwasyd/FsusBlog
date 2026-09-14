import { execFileSync } from 'node:child_process'

import {
  exactAssertionResult,
  mapConcurrent,
  produceMeasuredScenarioReceipt
} from '../run-runtime-cache-evidence.mjs'

export const REDIS_FAULT_PROBES = Object.freeze([
  { id: 'security-atomic', operationClass: 'SecurityAtomic', failAction: 'fail-closed' },
  { id: 'coordination-lease', operationClass: 'CoordinationLease', failAction: 'deny-origin-without-lease' },
  { id: 'content-cache-read', operationClass: 'ContentCacheRead', failAction: 'bounded-origin-gate' },
  { id: 'content-cache-write', operationClass: 'ContentCacheWrite', failAction: 'return-result-degraded' },
  { id: 'optional-projection', operationClass: 'OptionalProjection', failAction: 'use-local-or-base-value' },
  { id: 'distributed-delivery', operationClass: 'DistributedDelivery', failAction: 'record-degraded-and-replay' },
  { id: 'background-maintenance', operationClass: 'BackgroundMaintenance', failAction: 'defer-maintenance' },
  { id: 'content-cache-read', operationClass: 'ContentCacheRead', failAction: 'bounded-origin-gate' }
])

const latencyBySubcase = new Map([
  ['latency-5ms', 5],
  ['latency-50ms', 50],
  ['latency-500ms', 500],
  ['latency-15000ms', 15000]
])
const failClosedActions = new Set(['fail-closed', 'deny-origin-without-lease'])
const failOpenActions = new Set([
  'bounded-origin-gate',
  'return-result-degraded',
  'use-local-or-base-value',
  'record-degraded-and-replay',
  'defer-maintenance'
])

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runDocker(arguments_) {
  return execFileSync('docker', arguments_, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function createDockerRedisFaultController({
  container,
  execute = runDocker,
  wait = sleep,
  recoverySettleMs = 5250
}) {
  if (typeof container !== 'string' || container.length === 0) throw new Error('Redis container identity is required')

  const redis = (...arguments_) => execute(['exec', '-i', container, 'redis-cli', ...arguments_])
  const awaitReady = async () => {
    let lastError
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (redis('PING') === 'PONG') return
      } catch (error) {
        lastError = error
      }
      await wait(50)
    }
    throw new Error(`Redis did not recover after fault injection: ${lastError?.message ?? 'PING unavailable'}`)
  }

  return {
    async inject(subcaseId) {
      if (latencyBySubcase.has(subcaseId)) {
        const milliseconds = latencyBySubcase.get(subcaseId)
        redis('CLIENT', 'PAUSE', String(milliseconds), 'ALL')
        return
      }
      if (subcaseId === 'disconnect') {
        redis('CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes')
        return
      }
      if (subcaseId !== 'recovery') throw new Error(`unsupported Redis fault subcase: ${subcaseId}`)
      await awaitReady()
      await wait(recoverySettleMs)
      await awaitReady()
    },

    async clear(subcaseId) {
      if (latencyBySubcase.has(subcaseId)) {
        redis('CLIENT', 'UNPAUSE')
        await awaitReady()
      } else if (subcaseId === 'disconnect') {
        await awaitReady()
      }
    }
  }
}

function classificationForFailAction(failAction) {
  if (failClosedActions.has(failAction)) return 'fail-closed'
  if (failOpenActions.has(failAction)) return 'fail-open'
  throw new Error(`unsupported Redis fail action: ${failAction}`)
}

export function classifyRedisFaultRequest(request, probe) {
  const failures = request.redisFailureEvents
  if (!Array.isArray(failures) || !Array.isArray(request.redisCommands)) {
    throw new Error(`request ${request.id} lacks request-bound Redis evidence`)
  }

  if (failures.length === 0) {
    if (request.layerSource !== 'redis' || !request.redisCommands.some((command) => command.verb === 'PING')) {
      throw new Error(`request ${request.id} has neither a Redis failure event nor an observed PING`)
    }
    return 'recovered'
  }

  const classifications = new Set()
  for (const event of failures) {
    if (event.source !== 'redis-operation-executor' || event.operationClass !== probe.operationClass || event.failAction !== probe.failAction) {
      throw new Error(`request ${request.id} Redis failure contract does not match ${probe.id}`)
    }
    classifications.add(classificationForFailAction(event.failAction))
  }
  if (classifications.size !== 1) throw new Error(`request ${request.id} contains conflicting Redis failure classifications`)
  const classification = [...classifications][0]
  if (request.layerSource !== classification) {
    throw new Error(`request ${request.id} layer ${request.layerSource} does not match ${classification}`)
  }
  return classification
}

function requestSpec(runId, phase, index, subcaseId, probe) {
  return {
    method: 'GET',
    path: `/_fsus/testing/runtime-cache/redis-fault/${probe.id}?runtime-cache-evidence=${encodeURIComponent(`${runId}-${phase}-${index + 1}`)}`,
    subcaseId,
    parityGroup: `redis-fault-${subcaseId}-${probe.id}`,
    headers: {}
  }
}

function timelineClassification(request) {
  const firstFailure = request.redisFailureEvents?.[0]
  if (firstFailure) {
    try {
      return classificationForFailAction(firstFailure.failAction)
    } catch {
      // Keep the failure receipt schema-valid; the strict assertion still fails below.
    }
  }
  if (request.redisCommands?.some((command) => command.verb === 'PING')) return 'recovered'
  if (['fail-open', 'fail-closed'].includes(request.layerSource)) return request.layerSource
  return 'recovered'
}

function evaluateRequests(requests, probes) {
  return requests.map((request, index) => {
    try {
      return { request, valid: true, classification: classifyRedisFaultRequest(request, probes[index]) }
    } catch (error) {
      return { request, valid: false, classification: timelineClassification(request), error: error.message }
    }
  })
}

export async function runRedisFaultClassesSample({ scenario, collect, controller, runId }) {
  if (scenario.requests !== scenario.subcases.length * REDIS_FAULT_PROBES.length) {
    throw new Error('redis-fault-classes requires exactly eight requests per fault subcase')
  }

  const startedAt = performance.now()
  const requests = []
  const evaluations = []
  const faultTimeline = []
  let ordinal = 0
  for (const subcaseId of scenario.subcases) {
    const injectedAt = performance.now() - startedAt
    await controller.inject(subcaseId)
    let batch
    try {
      const specs = REDIS_FAULT_PROBES.map((probe, index) => requestSpec(runId, 'sample', index, subcaseId, probe))
      batch = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, ordinal + index))
    } finally {
      if (subcaseId !== 'recovery') await controller.clear(subcaseId)
    }
    const batchEvaluations = evaluateRequests(batch, REDIS_FAULT_PROBES)
    requests.push(...batch)
    evaluations.push(...batchEvaluations)
    ordinal += batch.length

    if (subcaseId !== 'recovery') {
      faultTimeline.push({
        atMs: injectedAt,
        kind: subcaseId,
        state: 'injected',
        classification: batchEvaluations[0].classification,
        requestId: batch[0].id,
        subcaseId
      })
    }
    for (const evaluation of batchEvaluations) {
      faultTimeline.push({
        atMs: performance.now() - startedAt,
        kind: subcaseId,
        state: 'observed',
        classification: evaluation.classification,
        requestId: evaluation.request.id,
        subcaseId
      })
    }
  }

  const invalid = evaluations.filter((item) => !item.valid)
  const observedClasses = [...new Set(evaluations.flatMap((item) =>
    item.request.redisFailureEvents.map((event) => event.operationClass)))]
    .sort()
  const expectedClasses = [...new Set(REDIS_FAULT_PROBES.map((probe) => probe.operationClass))].sort()
  const recovery = evaluations.filter((item) => item.request.subcaseId === 'recovery')
  const classificationBySubcase = Object.fromEntries(scenario.subcases.map((subcaseId) => [
    subcaseId,
    evaluations.filter((item) => item.request.subcaseId === subcaseId)
      .reduce((counts, item) => ({ ...counts, [item.classification]: (counts[item.classification] ?? 0) + 1 }), {})
  ]))
  return {
    requests,
    assertionResults: [
      exactAssertionResult(
        'fault-contract-classification',
        { qualifiedRequests: scenario.requests, operationClasses: expectedClasses },
        { qualifiedRequests: scenario.requests - invalid.length, operationClasses: observedClasses },
        invalid[0]?.request ?? requests[0]),
      exactAssertionResult(
        'recovery',
        { recoveredRequests: REDIS_FAULT_PROBES.length },
        { recoveredRequests: recovery.filter((item) => item.valid && item.classification === 'recovered').length },
        recovery.find((item) => !item.valid || item.classification !== 'recovered')?.request ?? recovery[0].request)
    ],
    faultTimeline,
    parameters: {
      operationClasses: expectedClasses,
      latencyMilliseconds: [...latencyBySubcase.values()],
      classificationBySubcase
    }
  }
}

export async function produceRedisFaultClassesReceipt(options) {
  const { scenario, identity } = options
  const controller = options.redisFaultController ?? createDockerRedisFaultController({ container: identity.redisContainer })
  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect, runId }) => {
      const specs = REDIS_FAULT_PROBES.slice(0, scenario.warmupRequests)
        .map((probe, index) => requestSpec(runId, 'warmup', index, 'recovery', probe))
      return mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
    },
    sample: ({ collect, runId }) => runRedisFaultClassesSample({ scenario, collect, controller, runId })
  })
}
