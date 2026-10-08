import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertEvidenceClassification } from '../operations/evidence-classification.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const errors = []
const requireText = (file, ...needles) => {
  const text = read(file)
  for (const needle of needles) if (!text.includes(needle)) errors.push(`${file}: missing ${needle}`)
  return text
}
const forbidText = (file, ...needles) => {
  const text = read(file)
  for (const needle of needles) if (text.includes(needle)) errors.push(`${file}: forbidden ${needle}`)
}

const endpoint = requireText(
  'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs',
  'credential_specific_revocation_witness_retired',
  'AnonymousCredentialRevocationArtifactKinds.Full',
  'AnonymousCredentialRevocationArtifactKinds.Delta',
  'public, max-age=31536000, immutable')
if (!/MapPost\("\/anonymous-credential\/revocation-witness", static \(IAedsEncoder aeds\)/.test(endpoint)) {
  errors.push('retired endpoint must not receive HttpContext, body binder, query, or credential parameters')
}
forbidText(
  'src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs',
  'TryDecodeAnonymousCredentialRevocationWitness',
  'RevocationHandleHash')

requireText(
  'src/backend/Services/Security/AnonymousCredentialRevocationArtifactService.cs',
  'public-snapshot-delta.v1',
  'ComputeContentHash',
  'WithDistributionMetadata',
  'MaxRevocationArtifactBytes')
forbidText(
  'src/backend/Services/Security/AnonymousCredentialRevocationArtifactService.cs',
  'AccountId', 'UserId', 'CredentialCommitment', 'HttpContext')

requireText(
  'src/frontend/src/api/comment.ts',
  'getAnonymousCredentialRevocationArtifact',
  "binary_get_anonymous_credential_revocation_full",
  "binary_get_anonymous_credential_revocation_delta")
forbidText(
  'src/frontend/src/api/comment.ts',
  'AnonymousCredentialRevocationWitnessRequest',
  'revocationHandleHash')

requireText(
  'src/frontend/src/privacy/commentPrivacyRevocationLocal.ts',
  'comment_privacy_revocation_content_hash_invalid',
  'comment_privacy_revocation_signature_invalid',
  'comment_privacy_revocation_rollback_detected',
  'comment_privacy_revocation_cpu_budget_exceeded')
const worker = requireText(
  'src/frontend/src/workers/privacy/commentPrivacy.worker.ts',
  'buildRevocationWitness',
  'zeroizeCommentPrivacyBytes(revocationHandleHash)')
for (const forbidden of ['console.', 'emitTelemetry', 'emitRumMetric']) {
  if (worker.includes(forbidden)) errors.push(`privacy worker leaks through ${forbidden}`)
}

const transcriptTest = requireText(
  'tests/frontend/unit/api/comment.test.ts',
  'same bodyless public artifact transcript for every credential',
  'requestOptions?.body).toBeUndefined()',
  "credentialPolicy).toBe('omit')")
for (const forbidden of ['credentialCommitment', 'revocationHandleHash', 'leafKey', 'stableId']) {
  const testBlock = transcriptTest.slice(transcriptTest.indexOf('same bodyless public artifact transcript'))
  if (testBlock.slice(0, 1800).includes(forbidden)) errors.push(`transcript fixture contains ${forbidden}`)
}

for (const file of [
  'docs/api/design.md',
  'docs/api/contracts.md',
  'docs/security/anonymous-revocation-distribution-threat-model.md',
  'docs/security/anonymous-revocation-distribution-runbook.md',
  'security/matrices/privacy-zk-comment.yml',
  'security/zk/contracts/comment-v5-circuit.manifest.json',
  'security/evidence-contracts/public-revocation-distribution.json'
]) requireText(file, 'revocation')

const attestation = assertEvidenceClassification(
  JSON.parse(read('security/evidence-contracts/public-revocation-distribution.json')),
  'implementation-attestation',
  'public revocation distribution attestation'
)
if (attestation.implementationStatus !== 'implemented-focused-validation-required') {
  errors.push('public revocation distribution attestation must remain focused-only')
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log('[public-revocation-distribution] contract ok')
