import assert from 'node:assert/strict'
import test from 'node:test'

import { runRuntimeOrderEquivalence, validateRuntimeOrderEquivalenceReceipt } from '../../tools/test-runtime/order-equivalence.mjs'
import { captureRuntimeStateSnapshot } from '../../tools/test-runtime/state-snapshot.mjs'
import { digest, noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const steps = [
  { id: 'root', dependsOn: [] },
  { id: 'left', dependsOn: ['root'] },
  { id: 'right', dependsOn: ['root'] },
  { id: 'join', dependsOn: ['left', 'right'] }
]
const base = runtimeIdentity({ sessionId: 'unused' })
const authority = {
  catalogDigest: base.catalogDigest,
  accessedDomains: ['fixture.public-content'],
  observerBindings: { 'fixture.public-content': { domain: 'fixture.public-content', observerId: 'state', observerVersion: 'v1' } },
  steps: Object.fromEntries(steps.map((step) => [step.id, {
    stepId: step.id,
    reads: ['fixture.public-content'],
    writes: [],
    creates: [],
    deletes: [],
    invalidates: [],
    resetBefore: [],
    resetAfter: []
  }]))
}
const observer = {
  observerId: 'state', version: 'v1',
  async observe({ context }) { return { status: 'observed', semantic: context.semantic, sideEffects: noSideEffects() } }
}

function harness({ diverge = null } = {}) {
  return {
    async createSession({ plan }) { return { identity: { ...base, sessionId: `session-${plan.planId}` } } },
    async executePlan({ plan, session }) {
      const semantic = diverge === plan.kind ? { state: 'different' } : { state: 'same' }
      const captured = await captureRuntimeStateSnapshot({
        authority,
        identity: session.identity,
        boundary: 'after-runtime',
        observers: [observer],
        context: { semantic }
      })
      return {
        status: 'success',
        identity: session.identity,
        executedStepIds: plan.orderedStepIds,
        executedAssertionIds: ['assert-a', 'assert-b'],
        outcomes: { 'assert-a': 'passed', 'assert-b': 'passed' },
        postconditions: { final: 'satisfied' },
        terminalClass: 'success',
        finalSnapshot: captured.snapshot,
        finalFragments: captured.fragments,
        boundarySnapshots: [
          await captureRuntimeStateSnapshot({
            authority,
            identity: session.identity,
            boundary: 'before-runtime',
            observers: [observer],
            context: { semantic }
          }),
          captured
        ],
        resetReceipts: [],
        processRefs: [`process-${plan.planId}`],
        lifecycleRefs: [`lifecycle-${plan.planId}`],
        overlaps: plan.concurrencyCap > 1 ? [{ left: 'left', right: 'right', provenNonConflicting: true }] : [],
        attemptFailures: []
      }
    }
  }
}

test('order equivalence executes all canonical/reverse/shuffle plans and caps with real independent sessions', async () => {
  const receipt = await runRuntimeOrderEquivalence({
    steps,
    maxConcurrency: 4,
    immutableIdentity: base,
    runtimeStepCatalogDigest: digest('runtime-steps'),
    authority,
    ...harness()
  })
  assert.equal(receipt.status, 'equivalent')
  assert.equal(receipt.requiredPlanCount, 24)
  assert.equal(receipt.executedPlanCount, 22)
  assert.equal(receipt.deduplicatedPlanCount, 2)
  assert.equal(validateRuntimeOrderEquivalenceReceipt(receipt, { sourceCommit: base.sourceCommit, sourceFingerprint: base.sourceFingerprint }), true)
})

test('order equivalence fails closed on reverse-ready semantic drift without retry', async () => {
  await assert.rejects(runRuntimeOrderEquivalence({
    steps,
    maxConcurrency: 2,
    immutableIdentity: base,
    runtimeStepCatalogDigest: digest('runtime-steps'),
    authority,
    ...harness({ diverge: 'reverse-ready' })
  }), (error) => error.code === 'runtime-state-order-dependent' && /diverged/.test(error.message))
})
