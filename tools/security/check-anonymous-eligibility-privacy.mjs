import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { assertEvidenceClassification } from '../operations/evidence-classification.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const evidenceArg = process.argv.indexOf('--evidence')
const evidencePath = path.resolve(root, evidenceArg >= 0 ? process.argv[evidenceArg + 1] : 'tests/fixtures/evidence/anonymous-eligibility-anonymity-set.json')
const errors = []

const circuit = readJson('src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
const manifest = readJson('security/zk/comment-v5-circuit.manifest.json')
const setup = readJson('security/zk/comment-v5-trusted-setup.manifest.json')
const tamper = readJson('security/zk/comment-v5-tamper-cases.manifest.json')
const evidence = assertEvidenceClassification(
  JSON.parse(readFileSync(evidencePath, 'utf8')),
  'fixture',
  'anonymous eligibility aggregate fixture'
)
const intersection = readJson('tests/fixtures/security/anonymous-comment-intersection.json')

const expectedPublicInputs = [
  'action_context', 'scope', 'circuit_id', 'verifying_key_hash',
  'public_input_layout_version', 'nullifier_hash', 'credential_root',
  'revocation_root', 'issuer_public_key_hash', 'policy_hash', 'is_eligible',
  'may_comment', 'rate_class', 'requires_moderation'
]
const forbiddenExactFields = /^(?:credentialLevel|credential_level|credentialEpoch|credential_epoch|reputationBucket|reputation_bucket|accountAgeBucket|account_age_bucket|memberIds|member_ids)$/u

expect(circuit.circuit_id === 'fsus.anonymous.comment.v5', 'circuit id must be v5')
expect(circuit.public_input_layout_version === 6, 'public input layout must be 6')
expect(JSON.stringify(circuit.public_inputs) === JSON.stringify(expectedPublicInputs), 'circuit public inputs must be the canonical minimal predicate layout')
expect(JSON.stringify(manifest.public_inputs) === JSON.stringify(expectedPublicInputs), 'manifest public inputs must match the circuit')
expect(Array.isArray(circuit.private_witness) && circuit.private_witness.includes('signed_credential_level') && circuit.private_witness.includes('signed_reputation_bucket') && circuit.private_witness.includes('signed_account_age'), 'exact signed attributes must remain private witnesses')
expect(circuit.forbidden_public_inputs?.includes('credential_epoch') && circuit.forbidden_public_inputs?.includes('credential_level'), 'exact attributes must be explicitly forbidden as public inputs')
expect(setup.ceremony_status === 'not-run' && setup.production_usable === false && setup.verifying_key_hash === '', 'unrun setup must remain fail closed')
expect(manifest.production_usable === false && manifest.minimum_production_anonymity_set_size === 20, 'manifest must require k >= 20 and remain non-production')
expect(tamper.tamper_cases?.some(item => item.id === 'tamper-layout-5' && item.expected === 'reject'), 'legacy layout tamper case is required')
for (const id of ['tamper-is-eligible', 'tamper-may-comment', 'tamper-rate-class', 'tamper-requires-moderation']) {
  expect(tamper.tamper_cases?.some(item => item.id === id && item.expected === 'reject'), `${id} rejection is required`)
}
expect(evidence.fixtureState === 'aggregate-sample-not-production-attestation', 'aggregate fixture must not claim production attestation')
expect(evidence.minimumRequired >= 20, 'fixture minimum must be at least 20')
expect(Number.isInteger(evidence.sample?.minimumSize) && Number.isInteger(evidence.sample?.medianSize), 'fixture must contain only aggregate minimum and median sizes')
expect(evidence.sample.minimumSize >= evidence.minimumRequired, 'fixture minimum is below policy')
expect(intersection.expected?.rareClassPublished === false && intersection.expected?.memberIntersectionPossible === false, 'intersection fixture must prevent rare-class membership intersection')
checkNoSensitiveEvidence(evidence)

for (const relative of [
  'src/frontend/src/api/authoring.ts',
  'src/frontend/src/services/notificationStreamTypes.ts',
  'src/backend/Models/Dtos/AuthoringDtos.cs'
]) {
  const text = readFileSync(path.join(root, relative), 'utf8')
  expect(!/(?:credentialLevel|reputationBucket|accountAgeBucket)/u.test(text), `${relative} exposes an exact anonymous attribute`)
}
const responseContracts = readFileSync(path.join(root, 'src/shared/Contracts/Outputs/ServerResponseContracts.cs'), 'utf8')
const readModels = readFileSync(path.join(root, 'src/core/Mapping/Models/ReadModels.cs'), 'utf8')
for (const [contractName, source] of [
  ['AnonymousCommentTicketRequestCoreModel', readModels],
  ['AnonymousCommentTicketResponseCoreModel', readModels],
  ['AnonymousCommentCreateRequestCoreModel', readModels],
  ['CommentAuthorViewDto', responseContracts],
  ['RecentCommentStatItemDto', responseContracts]
]) {
  const declaration = source.match(new RegExp(`(?:record struct|record) ${contractName}\\([\\s\\S]*?\\);`, 'u'))?.[0] ?? ''
  expect(declaration.length > 0, `${contractName} declaration is missing`)
  expect(!/(?:CredentialEpoch|CredentialLevel|ReputationBucket|AccountAgeBucket)/u.test(declaration), `${contractName} exposes an exact anonymous attribute`)
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`anonymous-eligibility-privacy: ${error}\n`)
  process.exit(1)
}
process.stdout.write('anonymous-eligibility-privacy: ok\n')

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
}

function expect(condition, message) {
  if (!condition) errors.push(message)
}

function checkNoSensitiveEvidence(value, segments = []) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => checkNoSensitiveEvidence(child, [...segments, String(index)]))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenExactFields.test(key)) errors.push(`fixture evidence contains sensitive field: ${[...segments, key].join('.')}`)
    checkNoSensitiveEvidence(child, [...segments, key])
  }
}
