import assert from 'node:assert/strict'
import test from 'node:test'

import { executeWeightedStepDag } from '../../tools/test/bundles/bundle-steps.mjs'
import { createStateConflictPolicy, stateConflict } from '../../tools/test-runtime/state-conflict.mjs'
import { digest } from './support/runtime-state-fixture.mjs'

const entry = (stepId, values = {}) => ({
  stepId,
  stateAccess: 'declared',
  reads: [], writes: [], creates: [], deletes: [], invalidates: [], exclusiveStateDomains: [], commutativeWrites: [],
  ...values
})

test('stateConflict explains write/read, invalidation/topology and commutative proof rules', () => {
  assert.equal(stateConflict(entry('a', { writes: ['postgres.article'] }), entry('b', { reads: ['postgres.article'] })).conflicts[0].rule, 'mutating-access-overlap')
  assert.equal(stateConflict(entry('a', { invalidates: ['redis.cache.public'] }), entry('b', { reads: ['redis.cache.public'] })).conflicts[0].rule, 'generation-invalidate-overlap')
  assert.equal(stateConflict(entry('a', { writes: ['network.host-topology'] }), entry('b', { reads: ['network.host-topology'] })).conflicts[0].rule, 'topology-mutation-overlap')
  const commuteA = entry('a', { writes: ['postgres.audit'], commutativeWrites: [{ domain: 'postgres.audit', verifier: 'audit-proof' }] })
  const commuteB = entry('b', { writes: ['postgres.audit'], commutativeWrites: [{ domain: 'postgres.audit', verifier: 'audit-proof' }] })
  assert.equal(stateConflict(commuteA, commuteB, { verifiedProofs: new Set(['audit-proof']) }).conflict, false)
  assert.equal(stateConflict(commuteA, commuteB, { verifiedProofs: new Set() }).conflict, true)
})

test('production weighted DAG serializes state conflicts but preserves proven safe overlap', async () => {
  const authority = {
    catalogDigest: digest('catalog'),
    steps: {
      db: entry('db', { writes: ['postgres.article'] }),
      db2: entry('db2', { reads: ['postgres.article'] }),
      file: entry('file', { writes: ['fixture.public-content'] })
    }
  }
  const policy = createStateConflictPolicy(authority)
  const intervals = new Map()
  await executeWeightedStepDag([
    { id: 'db', dependsOn: [], resources: {} },
    { id: 'db2', dependsOn: [], resources: {} },
    { id: 'file', dependsOn: [], resources: {} }
  ], {
    maxParallel: 3,
    cpuUnits: 3,
    memoryGiB: 3,
    stateConflictPolicy: policy
  }, async (step) => {
    const started = Date.now()
    await new Promise((resolve) => setTimeout(resolve, 25))
    intervals.set(step.id, { started, ended: Date.now() })
  })
  assert.ok(intervals.get('db').ended <= intervals.get('db2').started || intervals.get('db2').ended <= intervals.get('db').started)
  assert.ok(intervals.get('file').started < intervals.get('db').ended)
})
