import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveZeroAuthProbeWorkers,
  runZeroAuthProbeQueue,
} from '../frontend/checks/runtime/zero-auth-probe-matrix.mjs'

test('zero-auth browser scenarios use the live orchestration grant without exceeding task count', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'zero-auth-live',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/zero-auth-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'runtime',
    FSUSBLOG_STEP_CPU_BUDGET: '1',
    FSUSBLOG_STEP_MEMORY_GIB: '2',
  }
  const document = JSON.stringify({
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'zero-auth-live',
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 },
    grants: { runtime: { cpuUnits: 2, memoryGiB: 4 } },
  })
  assert.equal(resolveZeroAuthProbeWorkers({
    env,
    taskCount: 9,
    cpuCount: 8,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 7,
    readGrantFile: () => document,
  }), 2)
  assert.equal(resolveZeroAuthProbeWorkers({
    env,
    taskCount: 1,
    cpuCount: 8,
    freeMemoryBytes: 4 * 1024 ** 3,
    totalMemoryBytes: 8 * 1024 ** 3,
    load1: 7,
    readGrantFile: () => document,
  }), 1)
})

test('zero-auth queue is bounded, ordered, and attempts every independent scenario', async () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({ id: `scenario-${index}` }))
  let active = 0
  let peak = 0
  const attempted = []
  const results = await runZeroAuthProbeQueue(tasks, 2, async (task, index) => {
    active += 1
    peak = Math.max(peak, active)
    attempted.push(task.id)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return index
  })

  assert.equal(peak, 2)
  assert.deepEqual(new Set(attempted), new Set(tasks.map((task) => task.id)))
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6])
})

test('zero-auth queue aggregates all scenario failures after the complete queue runs', async () => {
  const attempted = []
  await assert.rejects(
    runZeroAuthProbeQueue([
      { id: 'first' },
      { id: 'middle' },
      { id: 'last' },
    ], 2, async (task) => {
      attempted.push(task.id)
      if (task.id !== 'middle') throw new Error(`failed-${task.id}`)
      return task.id
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.match(error.message, /first, last/u)
      return true
    },
  )
  assert.deepEqual(new Set(attempted), new Set(['first', 'middle', 'last']))
})
