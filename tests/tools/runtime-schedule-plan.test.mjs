import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createRequiredRuntimeSchedulePlans,
  createRuntimeSchedulePlan,
  fixedRuntimeShuffleSeeds,
  validateRuntimeSchedulePlan
} from '../../tools/test-runtime/schedule-plan.mjs'
import { digest } from './support/runtime-state-fixture.mjs'

const steps = [
  { id: 'root', dependsOn: [] },
  { id: 'left', dependsOn: ['root'] },
  { id: 'right', dependsOn: ['root'] },
  { id: 'join', dependsOn: ['left', 'right'] }
]
const options = {
  steps,
  maxConcurrency: 4,
  runtimeStepCatalogDigest: digest('steps'),
  stateCatalogDigest: digest('state'),
  clockDigest: digest('clock'),
  replayDigest: digest('replay'),
  envelopeDigest: digest('envelope')
}

test('schedule plans cover canonical, serial, reverse and five fixed shuffles across caps', () => {
  const plans = createRequiredRuntimeSchedulePlans(options)
  assert.equal(plans.filter((plan) => !plan.deduplicatedBy).length, 22)
  assert.deepEqual([...new Set(plans.filter((plan) => plan.kind === 'shuffled').map((plan) => plan.seed))], fixedRuntimeShuffleSeeds)
  for (const plan of plans.filter((entry) => !entry.deduplicatedBy)) validateRuntimeSchedulePlan(plan, { steps })
  assert.ok(plans.some((plan) => plan.deduplicatedBy && plan.concurrencyCap === 4))
})

test('schedule plan rejects unknown, duplicate, dependency-invalid and identity drift', () => {
  const plan = createRuntimeSchedulePlan({ ...options, kind: 'canonical', concurrencyCap: 2 })
  assert.throws(() => validateRuntimeSchedulePlan({ ...plan, orderedStepIds: ['root', 'left', 'left', 'join'] }, { steps }), /every production runtime step exactly once/)
  const reversed = { ...plan, orderedStepIds: ['left', 'root', 'right', 'join'] }
  assert.throws(() => validateRuntimeSchedulePlan(reversed, { steps }), /reverses dependency/)
  assert.throws(() => validateRuntimeSchedulePlan(plan, { steps, expected: { stateCatalogDigest: digest('drift') } }), /drifted/)
})
