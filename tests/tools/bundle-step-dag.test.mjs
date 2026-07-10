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
