import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REDIS_FAULT_PROBES,
  classifyRedisFaultRequest,
  createDockerRedisFaultController,
  runRedisFaultClassesSample
} from '../../tools/test/runtime-cache-scenarios/redis-fault-classes.mjs'

const subcases = [
  'latency-5ms',
  'latency-50ms',
  'latency-500ms',
  'latency-15000ms',
  'disconnect',
  'recovery'
]

function scenario() {
  return {
    id: 'redis-fault-classes',
    subcases,
    requests: 48,
    concurrency: 4,
    warmupRequests: 8,
    requiredAssertions: ['fault-contract-classification', 'recovery'],
    requirements: { faults: subcases }
  }
}

function observedRequest(spec, ordinal) {
  const probeId = /\/redis-fault\/([^?]+)/u.exec(spec.path)[1]
  const probe = REDIS_FAULT_PROBES.find((item) => item.id === probeId)
  const recovers = ['latency-5ms', 'latency-50ms', 'recovery'].includes(spec.subcaseId)
  const failClosed = ['fail-closed', 'deny-origin-without-lease'].includes(probe.failAction)
  return {
    id: `fault-request-${ordinal + 1}`,
    subcaseId: spec.subcaseId,
    status: recovers ? 200 : 503,
    layerSource: recovers ? 'redis' : failClosed ? 'fail-closed' : 'fail-open',
    redisCommands: recovers ? [{ verb: 'PING', category: 'other', source: 'stackexchange-redis-profiler' }] : [],
    redisFailureEvents: recovers ? [] : [{
      sequence: 1,
      elapsedMilliseconds: 100,
      operationClass: probe.operationClass,
      failureKind: spec.subcaseId === 'disconnect' ? 'ConnectionUnavailable' : 'CommandTimeout',
      failAction: probe.failAction,
      source: 'redis-operation-executor'
    }],
    cacheEvents: [],
    dbCommands: [],
    latencyMs: 1,
    allocatedBytes: 0
  }
}

test('Redis fault handler executes every exact fault and classifies only request-bound Redis evidence', async () => {
  const actions = []
  const controller = {
    inject: async (subcaseId) => actions.push(['inject', subcaseId]),
    clear: async (subcaseId) => actions.push(['clear', subcaseId])
  }
  const result = await runRedisFaultClassesSample({
    scenario: scenario(),
    runId: 'fault-run',
    controller,
    collect: async (spec, ordinal) => observedRequest(spec, ordinal)
  })

  assert.equal(result.requests.length, 48)
  assert.deepEqual(actions.filter(([action]) => action === 'inject').map(([, subcaseId]) => subcaseId), subcases)
  assert.deepEqual(actions.filter(([action]) => action === 'clear').map(([, subcaseId]) => subcaseId), subcases.slice(0, -1))
  assert.deepEqual(result.assertionResults.map((item) => item.assertion.status), ['passed', 'passed'])
  assert.deepEqual(result.parameters.latencyMilliseconds, [5, 50, 500, 15000])
  for (const subcaseId of subcases.slice(0, -1)) {
    const states = new Set(result.faultTimeline.filter((item) => item.kind === subcaseId).map((item) => item.state))
    assert.deepEqual(states, new Set(['injected', 'observed']))
  }
  assert.equal(result.faultTimeline.filter((item) => item.kind === 'recovery' && item.state === 'observed').length, 8)
})

test('Redis classification ignores HTTP status and rejects a mismatched fail action', () => {
  const recovered = observedRequest({
    path: '/_fsus/testing/runtime-cache/redis-fault/security-atomic',
    subcaseId: 'recovery'
  }, 0)
  recovered.status = 503
  assert.equal(classifyRedisFaultRequest(recovered, REDIS_FAULT_PROBES[0]), 'recovered')

  const failed = observedRequest({
    path: '/_fsus/testing/runtime-cache/redis-fault/security-atomic',
    subcaseId: 'disconnect'
  }, 1)
  failed.redisFailureEvents[0].failAction = 'bounded-origin-gate'
  assert.throws(
    () => classifyRedisFaultRequest(failed, REDIS_FAULT_PROBES[0]),
    /does not match security-atomic/u)
})

test('Docker fault controller issues exact pause, disconnect, unpause, restart and recovery commands', async () => {
  const calls = []
  const waits = []
  const controller = createDockerRedisFaultController({
    container: 'redis-evidence',
    execute: (arguments_) => {
      calls.push(arguments_)
      return arguments_.at(-1) === 'PING' ? 'PONG' : ''
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    recoverySettleMs: 0
  })

  for (const milliseconds of [5, 50, 500, 15000]) {
    const subcaseId = `latency-${milliseconds}ms`
    await controller.inject(subcaseId)
    await controller.clear(subcaseId)
  }
  await controller.inject('disconnect')
  await controller.clear('disconnect')
  await controller.inject('recovery')

  const pauses = calls.filter((arguments_) => arguments_.includes('PAUSE')).map((arguments_) => Number(arguments_.at(-2)))
  assert.deepEqual(pauses, [5, 50, 500, 15000])
  assert.equal(calls.filter((arguments_) => arguments_.includes('UNPAUSE')).length, 4)
  assert.ok(calls.some((arguments_) => arguments_.join(' ') === 'stop --time 1 redis-evidence'))
  assert.ok(calls.some((arguments_) => arguments_.join(' ') === 'start redis-evidence'))
  assert.ok(calls.filter((arguments_) => arguments_.at(-1) === 'PING').length >= 6)
  assert.deepEqual(waits, [0])
})
