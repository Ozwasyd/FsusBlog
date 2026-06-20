#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))

const paths = {
  circuit: resolveInputPath(
    process.env.FSUSBLOG_ZK_CIRCUIT_MANIFEST,
    'security/zk/comment-v1-circuit.manifest.json'
  ),
  tamper: resolveInputPath(
    process.env.FSUSBLOG_ZK_TAMPER_MANIFEST,
    'security/zk/comment-v1-tamper-cases.manifest.json'
  ),
  setup: resolveInputPath(
    process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST,
    'security/zk/comment-v1-trusted-setup.manifest.json'
  ),
  config: resolveInputPath(
    process.env.FSUSBLOG_ZK_VERIFYING_KEY_CONFIG_MANIFEST,
    'config/zk/anonymous-comment-v1-verifying-key.manifest.json'
  ),
  feasibility: resolveInputPath(
    process.env.FSUSBLOG_ZK_FEASIBILITY_MANIFEST,
    'security/zk/comment-v1-feasibility.manifest.json'
  )
}

const outputPath = resolveOutputPath(
  process.env.FSUSBLOG_ZK_MANIFEST_CHECK_OUT,
  '.tmp/security/zk-comment-v1-manifest.json'
)

const expected = {
  circuitId: 'fsus.anonymous.comment.v1',
  layoutVersion: 2,
  actionContext: 'comment.create',
  proofSystem: 'Groth16',
  credentialScheme: 'BBS+',
  requiredPublicInputs: [
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
  ],
  requiredPrivateWitness: [
    'credential_secret',
    'bbs_plus_issuer_signature',
    'credential_opening',
    'credential_membership_proof',
    'revocation_non_membership_witness',
    'signed_credential_level',
    'signed_reputation_bucket',
    'policy_comparison_witness'
  ],
  requiredAssertions: [
    'valid_bbs_credential',
    'current_credential_root',
    'revocation_non_membership',
    'qualification_policy',
    'nullifier_prf_binding',
    'credential_bucket_legality',
    'identity_non_disclosure'
  ],
  requiredTamperCases: [
    'tamper-issuer-signature',
    'tamper-credential-root',
    'tamper-revocation-root',
    'tamper-policy-hash',
    'tamper-nullifier-hash',
    'tamper-scope',
    'tamper-action-context',
    'tamper-credential-level',
    'tamper-reputation-bucket',
    'tamper-credential-epoch',
    'tamper-layout-version',
    'tamper-verifying-key-hash',
    'inject-user-id-public-input',
    'inject-username-private-witness'
  ],
  forbiddenIdentityNames: [
    'userid',
    'user_id',
    'username',
    'public_handle',
    'account_id',
    'session_id',
    'client_ip',
    'device_fingerprint',
    'cookie',
    'authorization'
  ],
  placeholderHashes: [
    'vk-sha256',
    'placeholder',
    'todo',
    'tbd'
  ],
  failClosedCircuitStatuses: [
    'contract-only',
    'missing-production-artifact'
  ],
  productionReadyCircuitStatuses: [
    'production-ready',
    'verified-production-artifacts'
  ],
  unresolvedFeasibilityStatus: 'blocked-pending-design-decision'
}

const failures = []

function resolveInputPath(value, fallback) {
  if (value && value.trim().length > 0) {
    return path.isAbsolute(value) ? value : path.join(root, value)
  }

  return path.join(root, fallback)
}

function resolveOutputPath(value, fallback) {
  if (value && value.trim().length > 0) {
    return path.isAbsolute(value) ? value : path.join(root, value)
  }

  return path.join(root, fallback)
}

function fail(message) {
  failures.push(`[zk-comment-v1-manifest] ${message}`)
}

function readJson(file) {
  if (!fs.existsSync(file)) {
    fail(`missing manifest ${relative(file)}`)
    return {}
  }

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`invalid JSON ${relative(file)}: ${error.message}`)
    return {}
  }
}

function relative(file) {
  const rel = path.relative(root, file)
  return rel.startsWith('..') ? file : rel.replaceAll(path.sep, '/')
}

function resolveRepoPath(file) {
  return path.isAbsolute(file) ? file : path.join(root, file)
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function names(list) {
  return asArray(list).map((entry) => String(entry?.name ?? '').trim()).filter(Boolean)
}

function hasAll(label, actual, required) {
  const actualSet = new Set(actual)
  for (const item of required) {
    if (!actualSet.has(item)) {
      fail(`${label} missing ${item}`)
    }
  }
}

function hasNoForbiddenIdentity(label, actual) {
  for (const item of actual) {
    const normalized = item.toLowerCase()
    if (expected.forbiddenIdentityNames.includes(normalized)) {
      fail(`${label} contains forbidden identity field ${item}`)
    }
  }
}

function equals(label, actual, expectedValue) {
  if (actual !== expectedValue) {
    fail(`${label} expected ${expectedValue}, got ${actual}`)
  }
}

function isBlank(value) {
  return String(value ?? '').trim().length === 0
}

function isPlaceholder(value) {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized.length > 0 && expected.placeholderHashes.some((token) => normalized.includes(token))
}

function assertNoPlaceholder(label, value) {
  if (isPlaceholder(value)) {
    fail(`${label} uses placeholder hash ${value}`)
  }
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/i.test(String(value ?? '').trim())
}

function checkRealFileHash(label, filePath, hash) {
  let ok = true
  const normalizedPath = String(filePath ?? '').trim()
  const normalizedHash = String(hash ?? '').trim()

  if (isBlank(normalizedPath)) {
    fail(`${label}.path is required for production-ready circuit artifacts`)
    ok = false
  }
  if (isBlank(normalizedHash)) {
    fail(`${label}.sha256 is required for production-ready circuit artifacts`)
    ok = false
  } else {
    assertNoPlaceholder(`${label}.sha256`, normalizedHash)
    if (!isSha256Hex(normalizedHash)) {
      fail(`${label}.sha256 must be a 64-character SHA-256 hex digest`)
      ok = false
    }
  }

  if (!ok) {
    return false
  }

  const resolved = resolveRepoPath(normalizedPath)
  if (!fs.existsSync(resolved)) {
    fail(`${label}.sha256 is set but file is missing: ${normalizedPath}`)
    return false
  }
  if (sha256File(resolved) !== normalizedHash) {
    fail(`${label}.sha256 does not match ${normalizedPath}`)
    return false
  }

  return true
}

function checkCircuitArtifactStatus(circuit, setup) {
  const status = String(circuit.artifact_status ?? '').trim()
  const isFailClosed = expected.failClosedCircuitStatuses.includes(status)
  const isProductionReady = expected.productionReadyCircuitStatuses.includes(status)

  if (circuit.production_usable === false && !isFailClosed) {
    fail('circuit.artifact_status must be an explicit fail-closed status while production_usable=false')
  }

  if (isProductionReady) {
    const source = circuit.r1cs_source ?? circuit.source ?? {}
    const r1cs = setup.artifacts?.r1cs ?? {}
    const sourceReady = checkRealFileHash('circuit.r1cs_source', source.path, source.sha256)
    const r1csReady = checkRealFileHash('setup.artifacts.r1cs', r1cs.path, r1cs.sha256)

    if (!sourceReady || !r1csReady) {
      fail('circuit.artifact_status cannot claim production-ready without real R1CS source and artifact hashes')
    }
  }
}

function checkCircuit(circuit, setup) {
  equals('circuit.schema', circuit.schema, 'fsusblog.zk.circuit-manifest.v1')
  equals('circuit.circuit_id', circuit.circuit_id, expected.circuitId)
  equals('circuit.public_input_layout_version', circuit.public_input_layout_version, expected.layoutVersion)
  equals('circuit.proof_system', circuit.proof_system, expected.proofSystem)
  equals('circuit.credential_scheme', circuit.credential_scheme, expected.credentialScheme)
  equals('circuit.action_context', circuit.action_context, expected.actionContext)
  checkCircuitArtifactStatus(circuit, setup)

  const publicInputs = names(circuit.public_inputs)
  const privateWitness = names(circuit.private_witness)
  const assertionIds = asArray(circuit.security_assertions)
    .map((entry) => String(entry?.id ?? '').trim())
    .filter(Boolean)

  hasAll('circuit.public_inputs', publicInputs, expected.requiredPublicInputs)
  hasAll('circuit.private_witness', privateWitness, expected.requiredPrivateWitness)
  hasAll('circuit.security_assertions', assertionIds, expected.requiredAssertions)
  hasNoForbiddenIdentity('circuit.public_inputs', publicInputs)
  hasNoForbiddenIdentity('circuit.private_witness', privateWitness)

  const forbidden = asArray(circuit.forbidden_identity_fields).map((item) => String(item).trim())
  hasAll('circuit.forbidden_identity_fields', forbidden, [
    'userId',
    'user_id',
    'username',
    'public_handle',
    'account_id',
    'session_id'
  ])

  const prf = circuit.nullifier_prf ?? {}
  equals('circuit.nullifier_prf.algorithm', prf.algorithm, 'poseidon')
  hasAll('circuit.nullifier_prf.binds', asArray(prf.binds), [
    'credential_secret',
    'action_context',
    'scope'
  ])
  if (prf.stable_for_same_secret_and_scope !== true) {
    fail('circuit.nullifier_prf must be stable for the same secret and scope')
  }
  if (prf.unlinkable_across_scope !== true) {
    fail('circuit.nullifier_prf must be unlinkable across scope')
  }

  const budgets = circuit.budgets ?? {}
  if (Number(budgets.proof_bytes_max) > 1024 || Number(budgets.proof_bytes_max) <= 0) {
    fail('circuit.budgets.proof_bytes_max must be in 1..1024')
  }
  if (Number(budgets.wasm_prover_p95_ms_max) > 3000 || Number(budgets.wasm_prover_p95_ms_max) <= 0) {
    fail('circuit.budgets.wasm_prover_p95_ms_max must be in 1..3000')
  }
  if (circuit.production_usable !== false) {
    fail('circuit manifest must stay production_usable=false until real Groth16 artifacts land')
  }
}

function checkTamperManifest(tamper) {
  equals('tamper.schema', tamper.schema, 'fsusblog.zk.tamper-cases.v1')
  equals('tamper.circuit_id', tamper.circuit_id, expected.circuitId)
  equals('tamper.public_input_layout_version', tamper.public_input_layout_version, expected.layoutVersion)

  if (tamper.valid_case?.expected !== 'accept') {
    fail('tamper.valid_case must be an accepting baseline')
  }

  const validCoverage = asArray(tamper.valid_case?.covers)
  hasAll('tamper.valid_case.covers', validCoverage, expected.requiredAssertions)

  const cases = asArray(tamper.tamper_cases)
  const caseIds = cases.map((entry) => String(entry?.id ?? '').trim()).filter(Boolean)
  hasAll('tamper.tamper_cases', caseIds, expected.requiredTamperCases)

  const rejectCoverage = new Set()
  for (const entry of cases) {
    if (entry?.expected !== 'reject') {
      fail(`tamper case ${entry?.id ?? '<missing>'} must reject`)
    }
    if (asArray(entry?.mutates).length === 0) {
      fail(`tamper case ${entry?.id ?? '<missing>'} must declare mutated fields`)
    }
    for (const covered of asArray(entry?.covers)) {
      rejectCoverage.add(String(covered))
    }
  }

  for (const assertion of expected.requiredAssertions) {
    if (!rejectCoverage.has(assertion)) {
      fail(`tamper cases do not reject assertion ${assertion}`)
    }
  }
}

function checkSetup(setup, circuitHash) {
  equals('setup.schema', setup.schema, 'fsusblog.zk.trusted-setup-manifest.v1')
  equals('setup.circuit_id', setup.circuit_id, expected.circuitId)
  equals('setup.public_input_layout_version', setup.public_input_layout_version, expected.layoutVersion)
  equals('setup.circuit_manifest_path', setup.circuit_manifest_path, 'security/zk/comment-v1-circuit.manifest.json')
  equals('setup.circuit_manifest_sha256', setup.circuit_manifest_sha256, circuitHash)

  if (setup.production_usable !== false) {
    fail('setup.production_usable must remain false until pk/vk/transcripts are committed and hashed')
  }
  if (setup.ceremony_status !== 'not-run') {
    fail('setup.ceremony_status must be not-run for the current fail-closed manifest')
  }

  assertNoPlaceholder('setup.verifying_key_hash', setup.verifying_key_hash)
  if (!isBlank(setup.verifying_key_hash)) {
    fail('setup.verifying_key_hash must remain empty while production_usable=false')
  }

  const runtimeBinding = asArray(setup.hash_binding?.runtime_binding)
  hasAll('setup.hash_binding.runtime_binding', runtimeBinding, [
    'circuit_id',
    'public_input_layout_version',
    'verifying_key_hash'
  ])

  for (const phase of ['phase1', 'phase2']) {
    if (setup[phase]?.status !== 'required') {
      fail(`setup.${phase}.status must be required`)
    }
    if (String(setup[phase]?.verification_command ?? '').trim().length === 0) {
      fail(`setup.${phase}.verification_command is required`)
    }
  }

  const artifacts = setup.artifacts ?? {}
  for (const key of ['r1cs', 'proving_key', 'verifying_key', 'verifying_key_json', 'wasm_prover_bundle']) {
    const artifact = artifacts[key] ?? {}
    if (artifact.status !== 'required') {
      fail(`setup.artifacts.${key}.status must be required`)
    }
    if (String(artifact.path ?? '').trim().length === 0) {
      fail(`setup.artifacts.${key}.path is required`)
    }
    if (!isBlank(artifact.sha256)) {
      const artifactPath = path.join(root, artifact.path)
      if (!fs.existsSync(artifactPath)) {
        fail(`setup.artifacts.${key}.sha256 is set but file is missing: ${artifact.path}`)
      } else if (sha256File(artifactPath) !== artifact.sha256) {
        fail(`setup.artifacts.${key}.sha256 does not match ${artifact.path}`)
      }
    }
  }

  const upgradeRules = asArray(setup.public_input_layout_upgrade_rules).join('\n')
  for (const token of ['name change', 'order change', 'encoding change', 'semantic change', 'new circuit-specific Groth16 ceremony']) {
    if (!upgradeRules.includes(token)) {
      fail(`setup.public_input_layout_upgrade_rules missing ${token}`)
    }
  }

  const transcriptChecks = asArray(setup.transcript_consistency_checks).join('\n')
  for (const token of ['phase1 transcript SHA-256', 'phase2 transcript SHA-256', 'final proving key SHA-256', 'canonical verifying key bytes SHA-256', 'verifying key hash matches']) {
    if (!transcriptChecks.includes(token)) {
      fail(`setup.transcript_consistency_checks missing ${token}`)
    }
  }
}

function checkConfig(config, setup) {
  equals('config.schema', config.schema, 'fsusblog.zk.verifying-key-config.v1')
  equals('config.circuit_id', config.circuit_id, expected.circuitId)
  equals('config.public_input_layout_version', config.public_input_layout_version, expected.layoutVersion)
  equals('config.trusted_setup_manifest', config.trusted_setup_manifest, 'security/zk/comment-v1-trusted-setup.manifest.json')
  equals('config.circuit_manifest', config.circuit_manifest, 'security/zk/comment-v1-circuit.manifest.json')
  equals('config.verifying_key_path', config.verifying_key_path, setup.artifacts?.verifying_key?.path)

  if (config.production_usable !== false) {
    fail('config.production_usable must remain false until trusted setup is complete')
  }
  assertNoPlaceholder('config.verifying_key_hash', config.verifying_key_hash)
  if (!isBlank(config.verifying_key_hash)) {
    fail('config.verifying_key_hash must remain empty while production_usable=false')
  }
  if (config.verifying_key_hash !== setup.verifying_key_hash) {
    fail('config.verifying_key_hash must match setup.verifying_key_hash')
  }

  const runtimeKeys = config.runtime_config_keys ?? {}
  for (const key of [
    'zkProdVerifyingKeyHash',
    'zkVerifierVerifyingKeyHash',
    'zkVerifierCircuitId',
    'zkVerifierPublicInputLayoutVersion'
  ]) {
    if (String(runtimeKeys[key] ?? '').trim().length === 0) {
      fail(`config.runtime_config_keys.${key} is required`)
    }
  }
}

function findCandidate(feasibility, id) {
  return asArray(feasibility.candidates).find((entry) => entry?.id === id) ?? {}
}

function checkFeasibility(feasibility, circuit) {
  equals('feasibility.schema', feasibility.schema, 'fsusblog.zk.comment-v1-feasibility.v1')
  equals('feasibility.circuit_id', feasibility.circuit_id, expected.circuitId)
  equals('feasibility.public_input_layout_version', feasibility.public_input_layout_version, expected.layoutVersion)

  const status = String(feasibility.status ?? '').trim()
  if (circuit.production_usable === false && status !== expected.unresolvedFeasibilityStatus) {
    fail(`feasibility.status must be ${expected.unresolvedFeasibilityStatus} while circuit production_usable=false`)
  }

  const isProductionReady = expected.productionReadyCircuitStatuses.includes(String(circuit.artifact_status ?? '').trim())
  if (isProductionReady) {
    const gate = feasibility.production_ready_gate ?? {}
    if (status !== gate.requires_status) {
      fail('production-ready circuit requires a resolved feasibility decision')
    }
    if (gate.requires_selected_candidate === true && isBlank(feasibility.selected_candidate)) {
      fail('production-ready circuit requires feasibility.selected_candidate')
    }
  }

  const boundary = feasibility.current_boundary ?? {}
  equals('feasibility.current_boundary.credential_curve', boundary.credential_curve, 'BLS12-381')
  equals('feasibility.current_boundary.groth16_curve', boundary.groth16_curve, 'bn254')
  equals('feasibility.current_boundary.proof_system', boundary.proof_system, expected.proofSystem)
  if (Number(boundary.wasm_prover_p95_ms_max) > 3000 || Number(boundary.wasm_prover_p95_ms_max) <= 0) {
    fail('feasibility.current_boundary.wasm_prover_p95_ms_max must stay in the committed 1..3000 budget')
  }

  const inCircuitBls = findCandidate(feasibility, 'in-circuit-bls12-381-bbs-on-bn254')
  equals('feasibility.in_circuit_bls.decision', inCircuitBls.decision, 'rejected-for-current-performance-budget')
  if (Number(inCircuitBls.performance?.constraints_estimate) < 19000000) {
    fail('feasibility.in_circuit_bls.performance.constraints_estimate must record the large-circuit blocker')
  }
  if (Number(inCircuitBls.performance?.proving_key_bytes_estimate) < 12000000000) {
    fail('feasibility.in_circuit_bls.performance.proving_key_bytes_estimate must record the proving-key blocker')
  }
  if (!String(inCircuitBls.license_boundary?.reference_license ?? '').includes('GPL-3.0')) {
    fail('feasibility.in_circuit_bls.license_boundary.reference_license must record GPL-3.0 reference-only status')
  }

  const splitProof = findCandidate(feasibility, 'split-bbs-proof-bound-to-circuit-native-proof')
  equals('feasibility.split_proof.decision', splitProof.decision, 'pending-design-decision')
  hasAll('feasibility.split_proof.required_binding_proofs', asArray(splitProof.required_binding_proofs), [
    'same hidden credential secret is committed in the BBS proof and Groth16 proof',
    'issuer public key hash, credential epoch, credential level and reputation bucket match both proof systems',
    'revocation handle derives from the same committed credential material'
  ])

  const nativeCredential = findCandidate(feasibility, 'circuit-native-credential-v2')
  equals('feasibility.circuit_native_credential.decision', nativeCredential.decision, 'pending-design-decision')
}

function writeEvidence(status, feasibilityStatus) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      schema: 'fsusblog.zk.comment-v1-manifest-check.v1',
      status,
      circuit_id: expected.circuitId,
      public_input_layout_version: expected.layoutVersion,
      checked_at_utc: new Date().toISOString(),
      host: os.hostname(),
      manifests: {
        circuit: relative(paths.circuit),
        tamper: relative(paths.tamper),
        trusted_setup: relative(paths.setup),
        verifying_key_config: relative(paths.config),
        feasibility: relative(paths.feasibility)
      },
      feasibility_status: feasibilityStatus
    }, null, 2)}\n`
  )
}

const circuit = readJson(paths.circuit)
const tamper = readJson(paths.tamper)
const setup = readJson(paths.setup)
const config = readJson(paths.config)
const feasibility = readJson(paths.feasibility)
const circuitHash = fs.existsSync(paths.circuit) ? sha256File(paths.circuit) : ''

checkCircuit(circuit, setup)
checkTamperManifest(tamper)
checkSetup(setup, circuitHash)
checkConfig(config, setup)
checkFeasibility(feasibility, circuit)

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

writeEvidence('ok', String(feasibility.status ?? '').trim())
console.log(`[zk-comment-v1-manifest] ok evidence=${relative(outputPath)}`)
