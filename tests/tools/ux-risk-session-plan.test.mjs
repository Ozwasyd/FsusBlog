import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildUxRiskSessionPlan } from '../../tools/ux/ux-risk-session-plan.mjs'

test('persistent UX session plan follows the scheduler lane prefix and fixture root', () => {
  const repoRoot = path.resolve('/workspace/fsusblog')
  const env = {
    FSUSBLOG_TEST_SESSION_PREFIX: 'Lane UX Risk 41F0F4C0',
    FSUSBLOG_FIXTURE_ROOT: '.tmp/runtime-browser/fixtures'
  }
  const plan = buildUxRiskSessionPlan(3, { env, repoRoot })

  assert.deepEqual(plan.sessionIds, [
    'lane-ux-risk-41f0f4c0-0',
    'lane-ux-risk-41f0f4c0-1',
    'lane-ux-risk-41f0f4c0-2'
  ])
  assert.deepEqual(plan.fixtureFiles, plan.sessionIds.map((sessionId) =>
    path.join(repoRoot, '.tmp/runtime-browser/fixtures/sessions', `${sessionId}.aeds`)))
  assert.equal(plan.bootstrapFixtureFile, plan.fixtureFiles[0])
})

test('persistent UX session plan rejects invalid capacity instead of inventing a slot', () => {
  for (const count of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => buildUxRiskSessionPlan(count),
      /session count must be a positive integer/u
    )
  }
})
