import assert from 'node:assert/strict'
import test from 'node:test'

import { executeStepDag } from '../../tools/test/bundles/step-dag.mjs'

test('executeStepDag starts a dependent step as soon as its own dependency completes', async () => {
  const events = []
  const steps = [
    { id: 'slow-build', dependsOn: [] },
    { id: 'frontend-build', dependsOn: [] },
    { id: 'sync-assets', dependsOn: ['frontend-build'] },
    { id: 'static-checks', dependsOn: ['sync-assets'] }
  ]

  await executeStepDag(steps, 2, async (step) => {
    events.push(`start:${step.id}`)
    await new Promise((resolve) => setTimeout(resolve, step.id === 'slow-build' ? 35 : 5))
    events.push(`done:${step.id}`)
  })

  assert.ok(events.indexOf('start:static-checks') < events.indexOf('done:slow-build'))
})

test('executeStepDag rejects a missing dependency before it starts work', async () => {
  await assert.rejects(
    () => executeStepDag([{ id: 'static-checks', dependsOn: ['missing'] }], 1, async () => {}),
    /unknown dependency/u
  )
})

test('executeStepDag continues independent branches and aggregates their failures', async () => {
  const started = []
  const first = new Error('backend failed')
  const second = new Error('frontend failed')
  const steps = [
    { id: 'backend', dependsOn: [] },
    { id: 'frontend', dependsOn: [] },
    { id: 'backend-summary', dependsOn: ['backend'] },
    { id: 'frontend-summary', dependsOn: ['frontend'] },
    { id: 'static', dependsOn: [] },
    { id: 'static-summary', dependsOn: ['static'] }
  ]

  await assert.rejects(
    executeStepDag(steps, 2, async (step) => {
      started.push(step.id)
      if (step.id === 'backend') throw first
      if (step.id === 'frontend') throw second
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /backend, frontend/u)
      assert.deepEqual(error.errors, [first, second])
      return true
    }
  )

  assert.ok(started.includes('static'))
  assert.ok(started.includes('static-summary'))
  assert.ok(!started.includes('backend-summary'))
  assert.ok(!started.includes('frontend-summary'))
})

test('executeStepDag admits dependency-ready work under CPU and memory capacity', async () => {
  const bootstrapRelease = deferred()
  const peerRelease = deferred()
  const started = []
  const execution = executeStepDag([
    { id: 'bootstrap', dependsOn: [], resources: { cpuUnits: 2, memoryGiB: 2 } },
    { id: 'peer', dependsOn: [], resources: { cpuUnits: 2, memoryGiB: 2 } },
    { id: 'runtime', dependsOn: ['bootstrap'], resources: { cpuUnits: 1, memoryGiB: 1 } }
  ], { maxParallel: 3, cpuUnits: 4, memoryGiB: 4 }, async (step) => {
    started.push(step.id)
    if (step.id === 'bootstrap') await bootstrapRelease.promise
    if (step.id === 'peer') await peerRelease.promise
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['bootstrap', 'peer'])
  bootstrapRelease.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['bootstrap', 'peer', 'runtime'])
  peerRelease.resolve()
  await execution
})

test('executeStepDag drains ordinary work before an exclusive measurement and blocks later work', async () => {
  const ordinaryRelease = deferred()
  const benchmarkRelease = deferred()
  const started = []
  const active = new Set()
  const execution = executeStepDag([
    { id: 'ordinary', dependsOn: [], resources: { cpuUnits: 1, memoryGiB: 1 } },
    { id: 'benchmark', dependsOn: [], resources: { cpuUnits: 1, memoryGiB: 1, exclusiveResources: ['benchmark-window'] } },
    { id: 'later', dependsOn: [], resources: { cpuUnits: 1, memoryGiB: 1 } }
  ], {
    maxParallel: 3,
    cpuUnits: 3,
    memoryGiB: 3,
    exclusiveResources: ['benchmark-window']
  }, async (step) => {
    started.push(step.id)
    active.add(step.id)
    if (step.id === 'ordinary') await ordinaryRelease.promise
    if (step.id === 'benchmark') {
      assert.deepEqual([...active], ['benchmark'])
      await benchmarkRelease.promise
    }
    active.delete(step.id)
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['ordinary'])
  ordinaryRelease.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['ordinary', 'benchmark'])
  benchmarkRelease.resolve()
  await execution
  assert.deepEqual(started, ['ordinary', 'benchmark', 'later'])
})

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}
