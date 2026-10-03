import assert from 'node:assert/strict'
import test from 'node:test'

import { produceReleaseDeploymentObservation } from '../../tools/fact-extractors/post-runtime/release-deployment.mjs'
import {
  canonicalAuthorityBundleSchema,
  currentSchemaAuthorityReference,
  releaseReadinessAuthorityBundleSchema,
  requireCurrentSchemaReceiptReference
} from '../../tools/test-evidence/release-authority-bundle-contract.mjs'

test('release/deployment producer requires its exact two canonical class receipts', () =>
{
  assert.throws(() => produceReleaseDeploymentObservation({
    candidatePlan: {}, acceptedClaimsReceipt: {}, classReceipts: []
  }), /candidate plan schema\/status mismatch/u)
})

test('release authority v2 requires an explicit native receipt reference, not pre-runtime provenance', () =>
{
  const reference = {
    path: '.tmp/run-3662/current-schema-receipt.json',
    fileDigest: `sha256:${'a'.repeat(64)}`,
    contentDigest: `sha256:${'b'.repeat(64)}`,
    schema: 'fsusblog.current-schema-receipt.v1'
  }
  assert.deepEqual(requireCurrentSchemaReceiptReference(reference), reference)
  assert.equal(releaseReadinessAuthorityBundleSchema, 'fsusblog.release-identity-readiness-authority-bundle.v2')
  assert.equal(canonicalAuthorityBundleSchema, 'fsusblog.blue-green-containment-authority-bundle.v2')
  for (const invalid of [undefined, null, {},
    { ...reference, schema: 'fsusblog.runtime-role-observation.v3' },
    { ...reference, contentDigest: reference.fileDigest },
    { ...reference, fileDigest: 'a'.repeat(64) },
    { ...reference, path: '.tmp/../receipt.json' },
    { ...reference, path: '.tmp/history/receipt.json' },
    { ...reference, nativeQualification: true }])
  {
    assert.throws(() => requireCurrentSchemaReceiptReference(invalid), /explicit current-schema receipt/u)
  }
})

test('release authority does not qualify when the original native verification owner is absent', () =>
{
  for (const preRuntime of [undefined, {}, { runtimeRole: { claimEligible: true } },
    { currentSchemaContract: { fixtureOnly: true, nativeQualification: false } }])
  {
    assert.throws(() => currentSchemaAuthorityReference(preRuntime), /native verification owner is unavailable/u)
  }
})
