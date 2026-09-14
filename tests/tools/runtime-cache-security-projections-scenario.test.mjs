import assert from 'node:assert/strict'
import test from 'node:test'

import { securityProjectionScenarioInternals } from '../../tools/test/runtime-cache-scenarios/security-projections.mjs'

test('security projection scenario requires bounded logical and backing residency for every projection', () => {
  const residency = {
    account: { entries: 4, maxEntries: 4, logicalBytes: 64, maxLogicalBytes: 64, capacityBytes: 96, maxCapacityBytes: 96 },
    ban: { entries: 3, maxEntries: 4, logicalBytes: 48, maxLogicalBytes: 64, capacityBytes: 48, maxCapacityBytes: 64 },
    admin: { entries: 2, maxEntries: 4, logicalBytes: 32, maxLogicalBytes: 64, capacityBytes: 32, maxCapacityBytes: 64 },
    admission: { entries: 1, maxEntries: 4, logicalBytes: 16, maxLogicalBytes: 64, capacityBytes: 24, maxCapacityBytes: 64 }
  }
  assert.equal(securityProjectionScenarioInternals.bounded(residency), true)
  assert.equal(securityProjectionScenarioInternals.bounded({
    ...residency,
    admission: { ...residency.admission, capacityBytes: 65 }
  }), false)
})

test('security projection convergence is generation-bound and fail-closed for the revoked admin token', () => {
  const snapshot = {
    baseline: { initialAccountGeneration: 10, initialBanGeneration: 20, initialAdminGeneration: 30 },
    account: { outcome: 'Present', generation: 11 },
    ban: { status: 'Banned', generation: 21 },
    admin: { reason: 'admin_session_revoked', source: 'local-projection', generation: 31 }
  }
  assert.equal(securityProjectionScenarioInternals.converged(snapshot), true)
  assert.equal(securityProjectionScenarioInternals.converged({
    ...snapshot,
    admin: { ...snapshot.admin, source: 'database' }
  }), false)
})

test('security projection requests trust only request-bound raw hit events for their family', () => {
  const request = {
    subcaseId: 'account-hot',
    path: '/_fsus/testing/runtime-cache/scenarios/security-projections/run/hot/account?ordinal=1',
    cacheEvents: [{ family: 'security-account-projection', identityDigest: `sha256:${'a'.repeat(64)}`, outcome: 'hit', sequence: 1, elapsedMilliseconds: 0.2 }]
  }
  assert.equal(securityProjectionScenarioInternals.cacheHitEvidence(request), true)
  assert.equal(securityProjectionScenarioInternals.cacheHitEvidence({
    ...request,
    cacheEvents: [{ ...request.cacheEvents[0], outcome: 'built' }]
  }), false)
  assert.deepEqual(securityProjectionScenarioInternals.parseNodes('["node-b","node-a"]'), ['node-a', 'node-b'])
})

test('security projection durable convergence requires all three complete rows and exact node acknowledgements', () => {
  const complete = (kind) => ({
    kind,
    state: 'complete',
    requiredNodeIds: '["node-a","node-b"]',
    ackedNodeIds: '["node-b","node-a"]'
  })
  const rows = [
    complete('account_state_projection_mutation'),
    complete('ban_state_projection'),
    complete('admin_session_projection_mutation')
  ]
  assert.equal(securityProjectionScenarioInternals.durableConverged(rows), true)
  assert.equal(securityProjectionScenarioInternals.durableConverged([
    ...rows.slice(0, 2),
    { ...rows[2], ackedNodeIds: '["node-a"]' }
  ]), false)
})
