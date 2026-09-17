import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildGovernancePolicyInventory,
  buildGovernanceSuitePlan,
  governanceOwner,
  serializeGovernanceSuitePlan
} from '../../tools/test/governance-suite-plan.mjs'

test('canonical governance suites assign every file exactly once', () => {
  const files = [
    '/repo/tests/tools/test-lifecycle-governance.test.mjs',
    '/repo/tests/tools/test-matrix-scheduler.test.mjs',
    '/repo/tests/tools/test-evidence-receipt-schema.test.mjs',
    '/repo/tests/tools/security-domain-layout.test.mjs',
    '/repo/tests/tools/release-rollout-state.test.mjs',
    '/repo/tests/tools/configuration-layout.test.mjs'
  ]
  const plan = buildGovernanceSuitePlan(files)
  assert.equal(plan.length, 6)
  assert.deepEqual(plan.flatMap((suite) => suite.files).sort(), files.sort())
})

test('high-value job summary and privacy checks retain distinct policy owners', () => {
  assert.equal(governanceOwner('tests/tools/check-job-summaries.test.mjs').id, 'source-layout-naming')
  assert.equal(governanceOwner('tests/tools/privacy-zk-contract.test.mjs').id, 'privacy-security')
  assert.equal(governanceOwner('tests/tools/release-evidence-model.test.mjs').id, 'artifact-receipt-evidence')
})

test('policy inventory keeps test IDs, negative invariants, coverage and release tiers', () => {
  const inventory = buildGovernancePolicyInventory([{
    id: 'node-test:security#rejects-tamper',
    path: 'tests/tools/security-matrix-catalog.test.mjs',
    framework: 'node-test',
    assertionTargets: ['negative:tampered-manifest'],
    coverageIds: ['security-matrix'],
    tierIds: ['release-final']
  }])
  assert.deepEqual(inventory[0], {
    testId: 'node-test:security#rejects-tamper',
    path: 'tests/tools/security-matrix-catalog.test.mjs',
    framework: 'node-test',
    policyOwner: 'privacy-security',
    invariants: ['negative:tampered-manifest'],
    coverageIds: ['security-matrix'],
    tierIds: ['release-final']
  })
})

test('duplicate physical files fail before execution', () => {
  assert.throws(() => buildGovernanceSuitePlan(['tests/tools/a.test.mjs', 'tests/tools/a.test.mjs']), /duplicate/u)
})

test('governance suite evidence is source-bound and repository-relative', () => {
  const root = '/workspace/FsusBlog'
  const suites = buildGovernanceSuitePlan([
    `${root}/tests/tools/check-job-summaries.test.mjs`,
    `${root}/tests/tools/security-contract.test.mjs`
  ])
  const source = { commit: 'abc123', worktreeFingerprint: 'def456' }
  const evidence = serializeGovernanceSuitePlan(root, suites, source)

  assert.deepEqual(evidence.source, source)
  assert.equal(evidence.counts.files, 2)
  assert.ok(evidence.suites.flatMap((suite) => suite.files).every((file) => file.startsWith('tests/')))
  assert.ok(evidence.suites.flatMap((suite) => suite.files).every((file) => !file.includes(root)))
})
