import assert from 'node:assert/strict'
import test from 'node:test'

import { executeLimitedWave } from '../../tools/test/bundles/wave-runner.mjs'

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
