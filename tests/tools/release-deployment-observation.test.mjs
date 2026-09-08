import assert from 'node:assert/strict'
import test from 'node:test'

import { produceReleaseDeploymentObservation } from '../../tools/fact-extractors/post-runtime/release-deployment.mjs'

test('release/deployment producer requires its exact two canonical class receipts', () =>
{
  assert.throws(() => produceReleaseDeploymentObservation({
    candidatePlan: {}, acceptedClaimsReceipt: {}, classReceipts: []
  }), /candidate plan schema\/status mismatch/u)
})
