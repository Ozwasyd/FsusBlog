import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RuntimeResetBarrierManager,
  executeRuntimeResetBarrier,
  validateRuntimeResetBarrierReceipt
} from '../../tools/test-runtime/reset-barrier.mjs'
import { captureRuntimeStateSnapshot } from '../../tools/test-runtime/state-snapshot.mjs'
import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const reset = {
  producer: 'reset-db',
  producerCommand: 'reset-db',
  postcondition: 'empty',
  verifier: 'verifier',
  assertionId: 'db-empty',
  receiptSchema: 'fsusblog.runtime-reset-postcondition.v1'
}
const stateEntry = (stepId, values = {}) => ({
  stepId,
  stateAccess: 'declared',
  reads: [], writes: [], creates: [], deletes: [], invalidates: [], exclusiveStateDomains: [], commutativeWrites: [],
  resetBefore: [], resetAfter: [],
  ...values
})
const authority = {
  catalogDigest: identity.catalogDigest,
  accessedDomains: ['postgres.article'],
  observerBindings: { 'postgres.article': { domain: 'postgres.article', observerId: 'state', observerVersion: 'v1' } },
  steps: {
    'reset-db': stateEntry('reset-db', { writes: ['postgres.article'] }),
    consumer: stateEntry('consumer', { reads: ['postgres.article'], resetBefore: [reset] }),
    independent: stateEntry('independent', { reads: ['redis.cache.public'] })
  }
}
const observer = {
  observerId: 'state', version: 'v1',
  async observe() { return { status: 'observed', semantic: { rows: [] }, sideEffects: noSideEffects() } }
}
const capture = async ({ boundary, stepId, domains }) => captureRuntimeStateSnapshot({
  authority, identity, boundary, stepId, requiredDomains: domains, observers: [observer]
})

test('reset exit 0 does not release barrier until every real domain postcondition passes', async () => {
  const manager = new RuntimeResetBarrierManager({ authority, identity })
  await assert.rejects(executeRuntimeResetBarrier({
    manager,
    consumerStepId: 'consumer',
    phase: 'resetBefore',
    reset,
    captureSnapshot: capture,
    executeReset: async () => ({ exitCode: 0, signal: null, timedOut: false, cancelled: false, contentDigest: digest('process') }),
    verifyPostconditions: async () => [{ domain: 'postgres.article', status: 'mismatch', observationDigest: digest('not-empty') }]
  }), /remains closed/)
  assert.equal(manager.checkAdmission('consumer').admitted, false)
  assert.equal(manager.checkAdmission('independent').admitted, true)
})

test('successful observed postcondition atomically releases affected domains with generation receipt', async () => {
  const manager = new RuntimeResetBarrierManager({ authority, identity })
  const receipt = await executeRuntimeResetBarrier({
    manager,
    consumerStepId: 'consumer',
    phase: 'resetBefore',
    reset,
    captureSnapshot: capture,
    executeReset: async () => ({ exitCode: 0, signal: null, timedOut: false, cancelled: false, contentDigest: digest('process') }),
    verifyPostconditions: async () => [{ domain: 'postgres.article', status: 'satisfied', observationDigest: digest('empty') }]
  })
  assert.equal(receipt.status, 'released')
  assert.deepEqual(receipt.generations, [{ domain: 'postgres.article', generation: 1 }])
  assert.equal(validateRuntimeResetBarrierReceipt(receipt, { authority, identity }), true)
  assert.equal(manager.checkAdmission('consumer').admitted, true)
})
