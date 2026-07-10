import assert from 'node:assert/strict'
import test from 'node:test'

import { buildMixedWindowPlan } from '../../tools/test/run-mixed-performance-window.mjs'

test('mixed performance window preserves every minimum duration and QPS cohort', () => {
  const plan = buildMixedWindowPlan()
  assert.equal(plan.durationMs, 60_000)
  assert.equal(plan.cohorts.baseline.minimumDurationMs, 30_000)
  assert.equal(plan.cohorts.peak.minimumDurationMs, 60_000)
  assert.equal(plan.cohorts.burst.minimumDurationMs, 15_000)
  assert.equal(plan.cohorts.notification.minimumDurationMs, 30_000)
  assert.equal(plan.cohorts.qps.modes.length, 13)
  assert.equal(new Set(plan.cohorts.qps.modes).size, 13)
})
