#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const sourcePath = resolvePath(process.env.FSUSBLOG_ZK_COMMENT_V2_CIRCUIT_SOURCE, 'src/zk/circuits/anonymous-comment-v2/comment_v2.circuit.json')
const outputPath = resolvePath(process.env.FSUSBLOG_ZK_COMMENT_V2_R1CS_OUT, 'artifacts/zk/comment-v2/comment_v2.r1cs')
const groth16OutputPath = resolvePath(process.env.FSUSBLOG_ZK_COMMENT_V2_GROTH16_R1CS_OUT, 'artifacts/zk/comment-v2/comment_v2_groth16.r1cs')
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

const requiredPublicInputs = [
  'public_input_layout_version',
  'circuit_id',
  'action_context',
  'scope',
  'nullifier_hash',
  'credential_root',
  'revocation_root',
  'credential_epoch',
  'credential_level',
  'reputation_bucket',
  'issuer_public_key_hash',
  'policy_hash',
  'verifying_key_hash'
]

const requiredPrivateWitness = [
  'credential_secret',
  'circuit_native_issuer_signature',
  'issuer_signature_public_key',
  'credential_opening',
  'credential_membership_proof',
  'revocation_non_membership_witness',
  'signed_credential_level',
  'signed_reputation_bucket',
  'policy_comparison_witness'
]

const requiredAssertions = [
  'valid_circuit_native_credential',
  'current_credential_root',
  'revocation_non_membership',
  'qualification_policy',
  'nullifier_prf_binding',
  'credential_bucket_legality',
  'identity_non_disclosure',
  'presentation_unlinkability'
]

const forbiddenIdentityPattern = /(?:userId|user_id|username|public_handle|account_id|session_id|client_ip|device_fingerprint|cookie|authorization)/iu

function resolvePath(value, fallback) {
  const candidate = value && value.trim().length > 0 ? value.trim() : fallback
  return path.isAbsolute(candidate) ? candidate : path.join(root, candidate)
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file))
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  }
  return value
}

function stringifyStable(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function includesAll(label, actual, required) {
  const actualSet = new Set(actual)
  for (const item of required) {
    assert(actualSet.has(item), `${label} missing ${item}`)
  }
}

function rejectIdentitySignals(label, values) {
  for (const value of values) {
    assert(!forbiddenIdentityPattern.test(String(value)), `${label} contains forbidden identity signal ${value}`)
  }
}

function normalizeGroups(groups) {
  return groups.map((group, index) => {
    const id = String(group.id ?? '').trim()
    const count = Number(group.constraint_count)
    assert(id.length > 0, `constraint_groups[${index}].id is required`)
    assert(Number.isSafeInteger(count) && count >= 0, `constraint_groups[${index}].constraint_count must be a non-negative integer`)
    assert(String(group.rank1_template ?? '').trim().length > 0, `constraint_groups[${index}].rank1_template is required`)
    return {
      id,
      covers: [...(Array.isArray(group.covers) ? group.covers : [])].sort(),
      constraint_count: count,
      rank1_template: String(group.rank1_template),
      checks: Array.isArray(group.checks) ? [...group.checks] : []
    }
  })
}

function validateSource(source) {
  assert(source.schema === 'fsusblog.zk.comment-v2-circuit-source.v1', 'source schema mismatch')
  assert(source.circuit_id === 'fsus.anonymous.comment.v3', 'source circuit_id mismatch')
  assert(source.public_input_layout_version === 4, 'source public_input_layout_version mismatch')
  assert(source.proof_system === 'Groth16', 'source proof_system must be Groth16')
  assert(source.curve === 'bn254', 'source curve must be bn254')
  assert(source.credential_scheme === 'circuit-native-credential-v2', 'source credential_scheme mismatch')

  const publicInputs = Array.isArray(source.public_inputs) ? source.public_inputs : []
  const privateWitness = Array.isArray(source.private_witness) ? source.private_witness : []
  includesAll('source.public_inputs', publicInputs, requiredPublicInputs)
  includesAll('source.private_witness', privateWitness, requiredPrivateWitness)
  rejectIdentitySignals('source.public_inputs', publicInputs)
  rejectIdentitySignals('source.private_witness', privateWitness)

  const groups = normalizeGroups(Array.isArray(source.constraint_groups) ? source.constraint_groups : [])
  assert(groups.length > 0, 'source.constraint_groups is required')
  const coverage = new Set(groups.flatMap((group) => group.covers))
  for (const assertion of requiredAssertions) {
    assert(coverage.has(assertion), `constraint_groups do not cover ${assertion}`)
  }
  validateRevocationWitnessShape(source)

  const estimatedConstraints = Number(source.metrics?.estimated_constraints)
  assert(Number.isSafeInteger(estimatedConstraints) && estimatedConstraints > 0, 'metrics.estimated_constraints is required')
  assert(estimatedConstraints <= 250000, 'metrics.estimated_constraints exceeds comment.v2 budget')

  return { publicInputs, privateWitness, groups, estimatedConstraints }
}

function validateRevocationWitnessShape(source) {
  const shape = source.primitives?.revocation_non_membership?.witness_shape ?? {}
  assert(shape.path_depth === 128, 'revocation_non_membership.witness_shape.path_depth must be 128')
  assert(
    JSON.stringify(shape.circuit_fields ?? []) === JSON.stringify(['leafKey', 'siblingHashes[0..127]']),
    'revocation_non_membership.witness_shape.circuit_fields must bind leafKey and 128 siblings')
  assert(shape.witness_hash_role === 'fixture_integrity_only', 'revocation_non_membership.witness_hash_role must be fixture_integrity_only')
  assert(shape.witness_hash_circuit_input === false, 'revocation_non_membership.witness_hash_circuit_input must be false')
  assert(shape.sibling_digest_algorithm === 'mimc7-bn254.v1', 'revocation_non_membership.sibling_digest_algorithm must be mimc7-bn254.v1')
}

function buildArtifact(source, sourceSha256, normalized) {
  const assertionCoverage = Object.fromEntries(requiredAssertions.map((assertion) => [
    assertion,
    normalized.groups
      .filter((group) => group.covers.includes(assertion))
      .map((group) => group.id)
  ]))

  return {
    schema: 'fsusblog.zk.r1cs-ir.v1',
    generated_by: 'tools/crypto/build-zk-comment-v2-r1cs.mjs',
    source_path: relative(sourcePath),
    source_sha256: sourceSha256,
    circuit_id: source.circuit_id,
    public_input_layout_version: source.public_input_layout_version,
    proof_system: source.proof_system,
    curve: source.curve,
    field_modulus: source.field_modulus,
    credential_scheme: source.credential_scheme,
    public_inputs: normalized.publicInputs,
    private_witness: normalized.privateWitness,
    constraint_count: normalized.groups.reduce((sum, group) => sum + group.constraint_count, 0),
    estimated_constraints: normalized.estimatedConstraints,
    constraint_groups: normalized.groups,
    assertion_coverage: assertionCoverage,
    primitives: source.primitives,
    domain_separators: source.domain_separators,
    tamper_case_bindings: source.tamper_case_bindings,
    production_usable: false,
    trusted_setup_required: true
  }
}

function buildGroth16R1cs(source, sourceSha256, normalized) {
  const payload = Buffer.from(stringifyStable({
    schema: 'fsusblog.zk.groth16-r1cs-binary.v1',
    generated_by: 'tools/crypto/build-zk-comment-v2-r1cs.mjs',
    source_path: relative(sourcePath),
    source_sha256: sourceSha256,
    circuit_id: source.circuit_id,
    public_input_layout_version: source.public_input_layout_version,
    proof_system: source.proof_system,
    curve: source.curve,
    field_modulus: source.field_modulus,
    public_inputs: normalized.publicInputs,
    private_witness: normalized.privateWitness,
    constraint_count: normalized.groups.reduce((sum, group) => sum + group.constraint_count, 0),
    constraint_groups: normalized.groups.map((group) => ({
      id: group.id,
      rank1_template: group.rank1_template,
      constraint_count: group.constraint_count
    })),
    production_usable: false,
    trusted_setup_required: true
  }), 'utf8')
  const header = Buffer.alloc(32)
  header.write('FSG16R1CS1', 0, 'ascii')
  header.writeUInt32LE(1, 12)
  header.writeUInt32LE(payload.length, 16)
  header.writeUInt32LE(normalized.publicInputs.length, 20)
  header.writeUInt32LE(normalized.privateWitness.length, 24)
  header.writeUInt32LE(normalized.groups.length, 28)
  return Buffer.concat([header, payload])
}

function main() {
  const source = readJson(sourcePath)
  const normalized = validateSource(source)
  const sourceBytes = fs.readFileSync(sourcePath)
  const sourceSha256 = sha256Bytes(sourceBytes)
  const artifactText = stringifyStable(buildArtifact(source, sourceSha256, normalized))
  const groth16R1cs = buildGroth16R1cs(source, sourceSha256, normalized)

  if (checkOnly) {
    assert(fs.existsSync(outputPath), `missing generated R1CS artifact ${relative(outputPath)}`)
    assert(fs.existsSync(groth16OutputPath), `missing generated Groth16 R1CS artifact ${relative(groth16OutputPath)}`)
    const current = fs.readFileSync(outputPath, 'utf8')
    assert(current === artifactText, `${relative(outputPath)} is out of date; run node tools/crypto/build-zk-comment-v2-r1cs.mjs`)
    const currentGroth16 = fs.readFileSync(groth16OutputPath)
    assert(currentGroth16.equals(groth16R1cs), `${relative(groth16OutputPath)} is out of date; run node tools/crypto/build-zk-comment-v2-r1cs.mjs`)
    console.log(`[zk-comment-v2-r1cs] ok ${relative(outputPath)} sha256=${sha256File(outputPath)} groth16=${sha256File(groth16OutputPath)}`)
    return
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, artifactText)
  fs.mkdirSync(path.dirname(groth16OutputPath), { recursive: true })
  fs.writeFileSync(groth16OutputPath, groth16R1cs)
  console.log(`[zk-comment-v2-r1cs] wrote ${relative(outputPath)} sha256=${sha256File(outputPath)} groth16=${sha256File(groth16OutputPath)}`)
}

try {
  main()
} catch (error) {
  console.error(`[zk-comment-v2-r1cs] ${error.message}`)
  process.exit(1)
}
