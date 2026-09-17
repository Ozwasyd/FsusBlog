import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeLimitedWave,
  executeResourceAwareWave,
} from '../../tools/test/bundles/wave-runner.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('executeLimitedWave keeps independent work saturated without exceeding the worker cap', async () => {
  let active = 0
  let peak = 0
  const completed = []
  const steps = Array.from({ length: 11 }, (_, index) => ({ id: `step-${index}` }))

  await executeLimitedWave(steps, 3, async (step) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    completed.push(step.id)
    active -= 1
  })

  assert.equal(peak, 3)
  assert.deepEqual(
    completed.sort((left, right) => left.localeCompare(right, undefined, { numeric: true })),
    steps.map((step) => step.id)
  )
})

test('resource-aware wave waits for active capacity to be released before continuing', async () => {
  const firstRelease = deferred()
  const secondRelease = deferred()
  const started = []
  let activeCpu = 0
  let peakCpu = 0
  const steps = [
    { id: 'first', resources: { cpuUnits: 2, memoryGiB: 2 } },
    { id: 'second', resources: { cpuUnits: 2, memoryGiB: 2 } },
    { id: 'third', resources: { cpuUnits: 1, memoryGiB: 1 } },
  ]

  const execution = executeResourceAwareWave(
    steps,
    { maxParallel: 3, cpuUnits: 3, memoryGiB: 3 },
    async (step) => {
      started.push(step.id)
      activeCpu += step.resources.cpuUnits
      peakCpu = Math.max(peakCpu, activeCpu)
      if (step.id === 'first') await firstRelease.promise
      if (step.id === 'second') await secondRelease.promise
      activeCpu -= step.resources.cpuUnits
    }
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['first'])

  firstRelease.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['first', 'second', 'third'])

  secondRelease.resolve()
  await execution
  assert.equal(peakCpu, 3)
})

test('resource-aware wave rejects an oversized request before executing any step', async () => {
  const started = []

  await assert.rejects(
    executeResourceAwareWave(
      [
        { id: 'valid', resources: { cpuUnits: 1, memoryGiB: 1 } },
        { id: 'oversized', resources: { cpuUnits: 5, memoryGiB: 1 } },
      ],
      { maxParallel: 2, cpuUnits: 4, memoryGiB: 4 },
      async (step) => started.push(step.id)
    ),
    /step "oversized" requests 5 cpuUnits, exceeding wave capacity 4/
  )

  assert.deepEqual(started, [])
})

test('exclusive work drains active steps and blocks later work without starvation', async () => {
  const ordinaryOneRelease = deferred()
  const ordinaryTwoRelease = deferred()
  const exclusiveRelease = deferred()
  const started = []
  const active = new Set()
  const steps = [
    { id: 'ordinary-one', resources: { cpuUnits: 1, memoryGiB: 1 } },
    { id: 'ordinary-two', resources: { cpuUnits: 1, memoryGiB: 1 } },
    {
      id: 'exclusive',
      resources: { cpuUnits: 1, memoryGiB: 1, exclusiveResources: ['browser'] },
    },
    { id: 'later', resources: { cpuUnits: 1, memoryGiB: 1 } },
  ]

  const execution = executeResourceAwareWave(
    steps,
    {
      maxParallel: 3,
      cpuUnits: 3,
      memoryGiB: 3,
      exclusiveResources: ['browser'],
    },
    async (step) => {
      started.push(step.id)
      active.add(step.id)
      if (step.id === 'ordinary-one') await ordinaryOneRelease.promise
      if (step.id === 'ordinary-two') await ordinaryTwoRelease.promise
      if (step.id === 'exclusive') {
        assert.deepEqual([...active], ['exclusive'])
        await exclusiveRelease.promise
      }
      active.delete(step.id)
    }
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['ordinary-one', 'ordinary-two'])

  ordinaryOneRelease.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['ordinary-one', 'ordinary-two'])

  ordinaryTwoRelease.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['ordinary-one', 'ordinary-two', 'exclusive'])

  exclusiveRelease.resolve()
  await execution
  assert.deepEqual(started, ['ordinary-one', 'ordinary-two', 'exclusive', 'later'])
})

test('a failed step does not prevent admission of later independent steps', async () => {
  const peerRelease = deferred()
  const failure = new Error('expected failure')
  const started = []
  const steps = [
    { id: 'failing', resources: { cpuUnits: 1, memoryGiB: 1 } },
    { id: 'peer', resources: { cpuUnits: 1, memoryGiB: 1 } },
    { id: 'later', resources: { cpuUnits: 1, memoryGiB: 1 } },
  ]

  const execution = executeResourceAwareWave(
    steps,
    { maxParallel: 2, cpuUnits: 2, memoryGiB: 2 },
    async (step) => {
      started.push(step.id)
      if (step.id === 'failing') throw failure
      if (step.id === 'peer') await peerRelease.promise
    }
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['failing', 'peer', 'later'])
  peerRelease.resolve()

  await assert.rejects(execution, (error) => error === failure)
  assert.deepEqual(started, ['failing', 'peer', 'later'])
})

test('a wave executes every independent step and aggregates multiple failures', async () => {
  const started = []
  const first = new Error('first failure')
  const second = new Error('second failure')

  await assert.rejects(
    executeLimitedWave([
      { id: 'first' },
      { id: 'success' },
      { id: 'second' }
    ], 2, async (step) => {
      started.push(step.id)
      if (step.id === 'first') throw first
      if (step.id === 'second') throw second
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.match(error.message, /wave failed in 2 steps: first, second/u)
      assert.deepEqual(error.errors, [first, second])
      return true
    }
  )
  assert.deepEqual(started, ['first', 'success', 'second'])
})
