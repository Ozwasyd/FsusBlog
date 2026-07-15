#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateZkLocalReview } from '../security/zk-local-review.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))

const paths = {
  circuit: resolveInputPath(
    process.env.FSUSBLOG_ZK_CIRCUIT_MANIFEST,
    'security/zk/comment-v2-circuit.manifest.json'
  ),
  tamper: resolveInputPath(
    process.env.FSUSBLOG_ZK_TAMPER_MANIFEST,
    'security/zk/comment-v2-tamper-cases.manifest.json'
  ),
  setup: resolveInputPath(
    process.env.FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST,
    'security/zk/comment-v2-trusted-setup.manifest.json'
  ),
  config: resolveInputPath(
    process.env.FSUSBLOG_ZK_VERIFYING_KEY_CONFIG_MANIFEST,
    'config/zk/anonymous-comment-v2-verifying-key.manifest.json'
  ),
  feasibility: resolveInputPath(
    process.env.FSUSBLOG_ZK_FEASIBILITY_MANIFEST,
    'security/zk/comment-v2-feasibility.manifest.json'
  ),
  localReview: resolveInputPath(
    process.env.FSUSBLOG_ZK_LOCAL_REVIEW_MANIFEST,
    'security/zk/comment-v2-local-review.manifest.json'
  )
}

const outputPath = resolveOutputPath(
  process.env.FSUSBLOG_ZK_MANIFEST_CHECK_OUT,
  '.tmp/security/zk-comment-v2-manifest.json'
)

const expected = {
  circuitId: 'fsus.anonymous.comment.v3',
  layoutVersion: 4,
  actionContext: 'comment.create',
  proofSystem: 'Groth16',
  credentialScheme: 'circuit-native-credential-v2',
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
    'circuit_native_issuer_signature',
    'issuer_signature_public_key',
    'credential_opening',
    'credential_membership_proof',
    'revocation_non_membership_witness',
    'signed_credential_level',
    'signed_reputation_bucket',
    'policy_comparison_witness'
  ],
  requiredAssertions: [
    'valid_circuit_native_credential',
    'current_credential_root',
    'revocation_non_membership',
    'qualification_policy',
    'nullifier_prf_binding',
    'credential_bucket_legality',
    'identity_non_disclosure',
    'presentation_unlinkability'
  ],
  requiredTamperCases: [
    'tamper-issuer-signature',
    'tamper-credential-root',
    'tamper-credential-opening',
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
  requiredNegativeInvariants: [
    'tamper-nullifier-scope-root-revocation-reject'
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
    'source-and-r1cs',
    'missing-production-artifact'
  ],
  productionReadyCircuitStatuses: [
    'production-ready',
    'verified-production-artifacts'
  ],
  feasibilityStatus: 'resolved',
  selectedCandidate: 'circuit-native-credential-v2',
  dependencyPolicy: {
    backendRuntime: '.NET 10',
    jsonParser: 'System.Text.Json',
    forbiddenPackages: [
      'Nethereum.ZkProofs',
      'Newtonsoft.Json'
    ],
    requiredDecision: 'rejected-transitive-high-vulnerability',
    mclVersion: '1.0.5',
    requiredMclRuntimeAssets: [
      ['linux-x64', 'runtimes/linux-x64/native/libmcl.so'],
      ['linux-arm64', 'runtimes/linux-arm64/native/libmcl.so'],
      ['osx-x64', 'runtimes/osx-x64/native/libmcl.dylib'],
      ['osx-arm64', 'runtimes/osx-arm64/native/libmcl.dylib'],
      ['win-x64', 'runtimes/win-x64/native/mcl.dll'],
      ['win-arm64', 'runtimes/win-arm64/native/mcl.dll']
    ]
  },
  handoffConsumers: [
    '#552 trusted setup ceremony artifacts',
    '#553 browser wasm prover bundle',
    '#555 native verifier / prover cross-stack fixture'
  ],
  retiredHandoffConsumerIssues: [
    '#545',
    '#546'
  ]
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
  failures.push(`[zk-comment-v2-manifest] ${message}`)
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

function checkHandoffConsumers(label, value) {
  const consumers = asArray(value).map((item) => String(item).trim()).filter(Boolean)
  hasAll(label, consumers, expected.handoffConsumers)
  const joined = consumers.join('\n')
  for (const retired of expected.retiredHandoffConsumerIssues) {
    if (joined.includes(retired)) {
      fail(`${label} references retired issue ${retired}`)
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
  const hasSourceAndR1cs = status === 'source-and-r1cs'

  if (circuit.production_usable === false && !isFailClosed) {
    fail('circuit.artifact_status must be an explicit fail-closed status while production_usable=false')
  }

  if (hasSourceAndR1cs || isProductionReady) {
    const source = circuit.r1cs_source ?? circuit.source ?? {}
    const r1cs = setup.artifacts?.r1cs ?? {}
    const sourceReady = checkRealFileHash('circuit.r1cs_source', source.path, source.sha256)
    const r1csReady = checkRealFileHash('setup.artifacts.r1cs', r1cs.path, r1cs.sha256)
    if (r1csReady && circuit.artifact_hashes?.r1cs_sha256 !== r1cs.sha256) {
      fail('circuit.artifact_hashes.r1cs_sha256 must match setup.artifacts.r1cs.sha256')
    }
    const groth16R1cs = setup.artifacts?.groth16_r1cs ?? {}
    if (!isBlank(groth16R1cs.sha256)) {
      checkRealFileHash('setup.artifacts.groth16_r1cs', groth16R1cs.path, groth16R1cs.sha256)
      if (circuit.artifact_hashes?.groth16_r1cs_sha256 !== groth16R1cs.sha256) {
        fail('circuit.artifact_hashes.groth16_r1cs_sha256 must match setup.artifacts.groth16_r1cs.sha256')
      }
    }

    if (isProductionReady && (!sourceReady || !r1csReady)) {
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
  if (publicInputs.length !== expected.requiredPublicInputs.length) {
    fail('circuit.public_inputs must contain the exact v4 unlinkable public-input set')
  }
  hasAll('circuit.private_witness', privateWitness, expected.requiredPrivateWitness)
  hasAll('circuit.security_assertions', assertionIds, expected.requiredAssertions)
  hasNoForbiddenIdentity('circuit.public_inputs', publicInputs)
  hasNoForbiddenIdentity('circuit.private_witness', privateWitness)

  const forbiddenPresentationFields = asArray(circuit.forbidden_public_presentation_fields)
    .map((item) => String(item).trim())
    .filter(Boolean)
  hasAll('circuit.forbidden_public_presentation_fields', forbiddenPresentationFields, [
    'credential_commitment',
    'revocation_handle',
    'issuer_audit_id',
    'credential_leaf_index',
    'stable_witness_hash',
    'stable_presentation_key'
  ])
  for (const field of forbiddenPresentationFields) {
    if (publicInputs.includes(field)) {
      fail(`circuit.public_inputs exposes stable presentation field ${field}`)
    }
  }

  const unlinkability = circuit.transcript_unlinkability ?? {}
  if (Number(unlinkability.sample_scope_count) < 100) {
    fail('circuit.transcript_unlinkability.sample_scope_count must be at least 100')
  }
  for (const key of ['same_scope_nullifier_stable', 'different_scope_nullifier_unique', 'complete_wire_transcript_checked']) {
    if (unlinkability[key] !== true) {
      fail(`circuit.transcript_unlinkability.${key} must be true`)
    }
  }
  if (!Array.isArray(unlinkability.credential_specific_stable_fields_allowed) ||
      unlinkability.credential_specific_stable_fields_allowed.length !== 0) {
    fail('circuit.transcript_unlinkability must allow no credential-specific stable fields')
  }

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
  if (circuit.production_usable === true && !expected.productionReadyCircuitStatuses.includes(String(circuit.artifact_status ?? '').trim())) {
    fail('circuit manifest can be production_usable=true only with a production-ready artifact status')
  }
}

function checkCircuitSource(source) {
  equals('source.circuit_id', source.circuit_id, expected.circuitId)
  equals('source.public_input_layout_version', source.public_input_layout_version, expected.layoutVersion)
  const sourcePublicInputs = asArray(source.public_inputs).map((item) => String(item).trim()).filter(Boolean)
  hasAll('source.public_inputs', sourcePublicInputs, expected.requiredPublicInputs)
  if (sourcePublicInputs.length !== expected.requiredPublicInputs.length || sourcePublicInputs.includes('credential_commitment')) {
    fail('source.public_inputs must use the exact v4 unlinkable public-input set')
  }
  const revocation = source.primitives?.revocation_non_membership ?? {}
  const shape = revocation.witness_shape ?? {}
  if (Number(shape.path_depth) !== 128) {
    fail('source.revocation_non_membership.witness_shape.path_depth must be 128')
  }
  const circuitFields = asArray(shape.circuit_fields).join('\n')
  for (const token of ['leafKey', 'siblingHashes[0..127]']) {
    if (!circuitFields.includes(token)) {
      fail(`source.revocation_non_membership.witness_shape.circuit_fields missing ${token}`)
    }
  }
  if (shape.witness_hash_role !== 'fixture_integrity_only') {
    fail('source.revocation_non_membership.witness_hash_role must be fixture_integrity_only')
  }
  if (shape.witness_hash_circuit_input !== false) {
    fail('source.revocation_non_membership.witness_hash_circuit_input must be false')
  }
  if (shape.sibling_digest_algorithm !== 'mimc7-bn254.v1') {
    fail('source.revocation_non_membership.sibling_digest_algorithm must be mimc7-bn254.v1')
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
  const casesById = new Map(cases.map((entry) => [String(entry?.id ?? '').trim(), entry]))

  const negativeInvariantIdPattern = /^tamper-[a-z0-9]+(?:-[a-z0-9]+)*-reject$/u
  const negativeInvariants = asArray(tamper.negative_invariants)
  const negativeInvariantIds = negativeInvariants.map((entry) => String(entry?.id ?? '').trim()).filter(Boolean)
  hasAll('tamper.negative_invariants', negativeInvariantIds, expected.requiredNegativeInvariants)
  for (const entry of negativeInvariants) {
    const invariantId = String(entry?.id ?? '').trim()
    if (!negativeInvariantIdPattern.test(invariantId)) {
      fail(`tamper negative invariant id ${invariantId || '<missing>'} must use tamper-*-reject naming`)
    }

    const referencedCases = asArray(entry?.tamper_cases).map((item) => String(item).trim()).filter(Boolean)
    if (referencedCases.length === 0) {
      fail(`tamper negative invariant ${invariantId || '<missing>'} must reference at least one tamper case`)
    }
    for (const caseId of referencedCases) {
      const tamperCase = casesById.get(caseId)
      if (!tamperCase) {
        fail(`tamper negative invariant ${invariantId || '<missing>'} references missing tamper case ${caseId}`)
        continue
      }
      if (tamperCase.expected !== 'reject') {
        fail(`tamper negative invariant ${invariantId || '<missing>'} references non-reject tamper case ${caseId}`)
      }
    }
  }

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
  equals('setup.circuit_manifest_path', setup.circuit_manifest_path, 'security/zk/comment-v2-circuit.manifest.json')
  equals('setup.circuit_manifest_sha256', setup.circuit_manifest_sha256, circuitHash)
  equals(
    'setup.local_cryptographic_review_manifest',
    setup.local_cryptographic_review_manifest,
    'security/zk/comment-v2-local-review.manifest.json')

  const setupProductionUsable = setup.production_usable === true
  if (!setupProductionUsable && setup.production_usable !== false) {
    fail('setup.production_usable must be a boolean')
  }
  if (setupProductionUsable && setup.ceremony_status !== 'verified') {
    fail('setup.ceremony_status must be verified when production_usable=true')
  }
  if (!setupProductionUsable && !['not-run', 'placeholder_not_trusted_setup'].includes(setup.ceremony_status)) {
    fail('setup.ceremony_status must be not-run or placeholder_not_trusted_setup while production_usable=false')
  }
  if (!setupProductionUsable && String(setup.fail_closed_reason ?? '').trim().length === 0) {
    fail('setup.fail_closed_reason must be set while production_usable=false')
  }

  assertNoPlaceholder('setup.verifying_key_hash', setup.verifying_key_hash)
  if (setupProductionUsable && !isSha256Hex(setup.verifying_key_hash)) {
    fail('setup.verifying_key_hash must be a 64-character SHA-256 hex digest when production_usable=true')
  } else if (!isBlank(setup.verifying_key_hash) && !isSha256Hex(setup.verifying_key_hash)) {
    fail('setup.verifying_key_hash must be empty or a 64-character SHA-256 hex digest when production_usable=false')
  }

  const runtimeBinding = asArray(setup.hash_binding?.runtime_binding)
  hasAll('setup.hash_binding.runtime_binding', runtimeBinding, [
    'circuit_id',
    'public_input_layout_version',
    'verifying_key_hash'
  ])

  for (const phase of ['phase1', 'phase2']) {
    const expectedStatus = setupProductionUsable
      ? 'verified'
      : setup.ceremony_status === 'placeholder_not_trusted_setup'
        ? 'placeholder'
        : 'required'
    if (setup[phase]?.status !== expectedStatus) {
      fail(`setup.${phase}.status must be ${expectedStatus}`)
    }
    if (Number(setup[phase]?.minimum_contributions) < 3) {
      fail(`setup.${phase}.minimum_contributions must be at least 3`)
    }
    if (String(setup[phase]?.transcript_path ?? '').trim().length === 0) {
      fail(`setup.${phase}.transcript_path is required`)
    }
    assertNoPlaceholder(`setup.${phase}.transcript_sha256`, setup[phase]?.transcript_sha256)
    if (setupProductionUsable && !isSha256Hex(setup[phase]?.transcript_sha256)) {
      fail(`setup.${phase}.transcript_sha256 must be set when production_usable=true`)
    } else if (!isBlank(setup[phase]?.transcript_sha256) && !isSha256Hex(setup[phase]?.transcript_sha256)) {
      fail(`setup.${phase}.transcript_sha256 must be a 64-character SHA-256 hex digest`)
    }
    if (String(setup[phase]?.verification_command ?? '').trim().length === 0) {
      fail(`setup.${phase}.verification_command is required`)
    }
  }

  const artifacts = setup.artifacts ?? {}
  for (const key of ['r1cs', 'groth16_r1cs', 'proving_key', 'verifying_key', 'verifying_key_json', 'wasm_prover_bundle']) {
    const artifact = artifacts[key] ?? {}
    const expectedStatus = setupProductionUsable
      ? 'required'
      : setup.ceremony_status === 'placeholder_not_trusted_setup'
        ? 'placeholder'
        : 'required'
    if (artifact.status !== expectedStatus) {
      fail(`setup.artifacts.${key}.status must be ${expectedStatus}`)
    }
    if (String(artifact.path ?? '').trim().length === 0) {
      fail(`setup.artifacts.${key}.path is required`)
    }
    assertNoPlaceholder(`setup.artifacts.${key}.sha256`, artifact.sha256)
    if (!isBlank(artifact.sha256)) {
      if (!isSha256Hex(artifact.sha256)) {
        fail(`setup.artifacts.${key}.sha256 must be a 64-character SHA-256 hex digest`)
        continue
      }
      const artifactPath = resolveRepoPath(artifact.path)
      if (!fs.existsSync(artifactPath)) {
        if (setupProductionUsable || artifact.status !== 'placeholder') {
          fail(`setup.artifacts.${key}.sha256 is set but file is missing: ${artifact.path}`)
        }
      } else if (sha256File(artifactPath) !== artifact.sha256) {
        fail(`setup.artifacts.${key}.sha256 does not match ${artifact.path}`)
      }
    }
    if (setupProductionUsable && !isSha256Hex(artifact.sha256)) {
      fail(`setup.artifacts.${key}.sha256 must be set when production_usable=true`)
    }
  }
  if (setupProductionUsable && setup.artifacts?.verifying_key?.sha256 !== setup.verifying_key_hash) {
    fail('setup.verifying_key_hash must match setup.artifacts.verifying_key.sha256')
  }
  checkGroth16R1csBoundary(setup)

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

  checkHandoffConsumers('setup.handoff_consumers', setup.handoff_consumers)
}

function checkGroth16R1csBoundary(setup) {
  const artifacts = setup.artifacts ?? {}
  const deterministicIr = artifacts.r1cs ?? {}
  const groth16R1cs = artifacts.groth16_r1cs ?? {}
  const deterministicIrPath = String(deterministicIr.path ?? '').trim()
  const groth16R1csPath = String(groth16R1cs.path ?? '').trim()
  const phase2Command = String(setup.phase2?.verification_command ?? '').trim()

  if (deterministicIr.format !== 'fsusblog.zk.r1cs-ir.v1') {
    fail('setup.artifacts.r1cs.format must be fsusblog.zk.r1cs-ir.v1')
  }
  if (deterministicIr.ceremony_input !== false) {
    fail('setup.artifacts.r1cs.ceremony_input must be false for deterministic R1CS IR')
  }
  if (groth16R1cs.format !== 'rank1cs-binary') {
    fail('setup.artifacts.groth16_r1cs.format must be rank1cs-binary')
  }
  if (groth16R1cs.ceremony_input !== true) {
    fail('setup.artifacts.groth16_r1cs.ceremony_input must be true')
  }
  if (deterministicIrPath.length > 0 && phase2Command.includes(deterministicIrPath)) {
    fail('setup.phase2.verification_command must not use deterministic R1CS IR as Groth16 ceremony input')
  }
  if (groth16R1csPath.length > 0 && !phase2Command.includes(groth16R1csPath)) {
    fail('setup.phase2.verification_command must reference setup.artifacts.groth16_r1cs.path')
  }
}

function checkConfig(config, setup) {
  equals('config.schema', config.schema, 'fsusblog.zk.verifying-key-config.v1')
  equals('config.circuit_id', config.circuit_id, expected.circuitId)
  equals('config.public_input_layout_version', config.public_input_layout_version, expected.layoutVersion)
  equals('config.trusted_setup_manifest', config.trusted_setup_manifest, 'security/zk/comment-v2-trusted-setup.manifest.json')
  equals('config.circuit_manifest', config.circuit_manifest, 'security/zk/comment-v2-circuit.manifest.json')
  equals(
    'config.local_cryptographic_review_manifest',
    config.local_cryptographic_review_manifest,
    'security/zk/comment-v2-local-review.manifest.json')
  equals('config.verifying_key_path', config.verifying_key_path, setup.artifacts?.verifying_key?.path)

  const setupProductionUsable = setup.production_usable === true
  if (config.production_usable !== setupProductionUsable) {
    fail('config.production_usable must match setup.production_usable')
  }
  assertNoPlaceholder('config.verifying_key_hash', config.verifying_key_hash)
  if (setupProductionUsable && !isSha256Hex(config.verifying_key_hash)) {
    fail('config.verifying_key_hash must be a 64-character SHA-256 hex digest when production_usable=true')
  } else if (!isBlank(config.verifying_key_hash) && !isSha256Hex(config.verifying_key_hash)) {
    fail('config.verifying_key_hash must be empty or a 64-character SHA-256 hex digest when production_usable=false')
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

  checkHandoffConsumers('config.handoff_consumers', config.handoff_consumers)
}

function findCandidate(feasibility, id) {
  return asArray(feasibility.candidates).find((entry) => entry?.id === id) ?? {}
}

function checkFeasibility(feasibility, circuit) {
  equals('feasibility.schema', feasibility.schema, 'fsusblog.zk.comment-v2-feasibility.v1')
  equals('feasibility.circuit_id', feasibility.circuit_id, expected.circuitId)
  equals('feasibility.public_input_layout_version', feasibility.public_input_layout_version, expected.layoutVersion)

  const status = String(feasibility.status ?? '').trim()
  if (status !== expected.feasibilityStatus) {
    fail(`feasibility.status must be ${expected.feasibilityStatus} after the comment.v2 design decision`)
  }
  if (String(feasibility.selected_candidate ?? '').trim() !== expected.selectedCandidate) {
    fail(`feasibility.selected_candidate must be ${expected.selectedCandidate}`)
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
  equals('feasibility.current_boundary.credential_scheme', boundary.credential_scheme, expected.credentialScheme)
  equals('feasibility.current_boundary.credential_curve', boundary.credential_curve, 'bn254')
  equals('feasibility.current_boundary.groth16_curve', boundary.groth16_curve, 'bn254')
  equals('feasibility.current_boundary.proof_system', boundary.proof_system, expected.proofSystem)
  if (Number(boundary.wasm_prover_p95_ms_max) > 3000 || Number(boundary.wasm_prover_p95_ms_max) <= 0) {
    fail('feasibility.current_boundary.wasm_prover_p95_ms_max must stay in the committed 1..3000 budget')
  }

  checkDependencyPolicy(feasibility.dependency_policy)

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
  equals('feasibility.split_proof.decision', splitProof.decision, 'rejected-no-compatibility-layer')
  hasAll('feasibility.split_proof.required_binding_proofs', asArray(splitProof.required_binding_proofs), [
    'same hidden credential secret is committed in the BBS proof and Groth16 proof',
    'issuer public key hash, credential epoch, credential level and reputation bucket match both proof systems',
    'revocation handle derives from the same committed credential material'
  ])

  const nativeCredential = findCandidate(feasibility, 'circuit-native-credential-v2')
  equals('feasibility.circuit_native_credential.decision', nativeCredential.decision, 'selected')
  equals('feasibility.circuit_native_credential.credential_curve', nativeCredential.credential_curve, 'bn254')
  if (Number(nativeCredential.performance?.constraints_estimate) > 250000) {
    fail('feasibility.circuit_native_credential.performance.constraints_estimate must stay within the comment.v2 budget')
  }
  if (Number(nativeCredential.performance?.proving_key_bytes_estimate) > 256000000) {
    fail('feasibility.circuit_native_credential.performance.proving_key_bytes_estimate must stay within the comment.v2 budget')
  }
}

function checkDependencyPolicy(policy) {
  const normalized = policy ?? {}
  equals('feasibility.dependency_policy.backend_runtime', normalized.backend_runtime, expected.dependencyPolicy.backendRuntime)
  equals('feasibility.dependency_policy.json_parser', normalized.json_parser, expected.dependencyPolicy.jsonParser)

  const policyJson = JSON.stringify(normalized)
  for (const packageName of expected.dependencyPolicy.forbiddenPackages) {
    if (!policyJson.includes(packageName)) {
      fail(`privacy-zk dependency policy forbids ${packageName}, but feasibility.dependency_policy does not record it`)
    }
  }

  if (!policyJson.includes(expected.dependencyPolicy.requiredDecision)) {
    fail(`privacy-zk dependency policy forbids Nethereum.ZkProofs* without ${expected.dependencyPolicy.requiredDecision}`)
  }

  const rules = asArray(normalized.implementation_rules).join('\n')
  for (const token of ['System.Text.Json', 'Nethereum.ZkProofs', 'Newtonsoft.Json']) {
    if (!rules.includes(token)) {
      fail(`privacy-zk dependency policy forbids missing implementation rule token ${token}`)
    }
  }

  const mcl = asArray(normalized.evaluated_candidates).find((entry) => entry?.name === 'Nethermind.MclBindings') ?? {}
  if (mcl.decision !== 'selected-for-backend-verifier-kernel') {
    fail('Nethermind.MclBindings must remain selected for the backend verifier kernel')
  }
  const mclLicense = String(mcl.license ?? '')
  if (!mclLicense.includes('MIT') || !mclLicense.includes('BSD-3-Clause')) {
    fail('Nethermind.MclBindings license must record MIT and BSD-3-Clause boundaries')
  }
  equals('feasibility.dependency_policy.mcl.version', mcl.version, expected.dependencyPolicy.mclVersion)

  const runtimeAssetGate = mcl.runtime_asset_gate ?? {}
  equals('feasibility.dependency_policy.mcl.runtime_asset_gate.package', runtimeAssetGate.package, 'Nethermind.MclBindings')
  equals(
    'feasibility.dependency_policy.mcl.runtime_asset_gate.package_version',
    runtimeAssetGate.package_version,
    expected.dependencyPolicy.mclVersion
  )
  const mainstreamRids = asArray(runtimeAssetGate.mainstream_server_rids)
  const requiredRids = expected.dependencyPolicy.requiredMclRuntimeAssets.map(([rid]) => rid)
  hasAll('feasibility.dependency_policy.mcl.runtime_asset_gate.mainstream_server_rids', mainstreamRids, requiredRids)
  const assetMap = new Map(asArray(runtimeAssetGate.required_assets).map((entry) => [entry?.rid, entry?.path]))
  for (const [rid, assetPath] of expected.dependencyPolicy.requiredMclRuntimeAssets) {
    if (assetMap.get(rid) !== assetPath) {
      fail(`Nethermind.MclBindings runtime asset gate must include ${rid} -> ${assetPath}`)
    }
  }
  if (!String(runtimeAssetGate.asset_check_command ?? '').includes('check-mcl-platform-assets.mjs')) {
    fail('Nethermind.MclBindings runtime asset gate must record check-mcl-platform-assets.mjs')
  }
  if (!String(runtimeAssetGate.unsupported_runtime_note ?? '').includes('linux-musl')) {
    fail('Nethermind.MclBindings runtime asset gate must explicitly call out linux-musl/alpine as unsupported')
  }
}

function writeEvidence(status, feasibilityStatus, selectedCandidate, localReviewStatus) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(
    outputPath,
    `${JSON.stringify({
      schema: 'fsusblog.zk.comment-v2-manifest-check.v1',
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
        feasibility: relative(paths.feasibility),
        local_cryptographic_review: relative(paths.localReview)
      },
      feasibility_status: feasibilityStatus,
      selected_candidate: selectedCandidate,
      local_cryptographic_review_status: localReviewStatus
    }, null, 2)}\n`
  )
}

const circuit = readJson(paths.circuit)
const rawCircuitSourcePath = String(circuit.r1cs_source?.path ?? '').trim()
const circuitSourcePath = rawCircuitSourcePath.length > 0 ? resolveRepoPath(rawCircuitSourcePath) : ''
const circuitSource = circuitSourcePath.length > 0 && fs.existsSync(circuitSourcePath) ? readJson(circuitSourcePath) : {}
const tamper = readJson(paths.tamper)
const setup = readJson(paths.setup)
const config = readJson(paths.config)
const feasibility = readJson(paths.feasibility)
const circuitHash = fs.existsSync(paths.circuit) ? sha256File(paths.circuit) : ''
const localReview = validateZkLocalReview({
  root,
  manifestPath: paths.localReview,
  requireComplete: true
})

checkCircuit(circuit, setup)
checkCircuitSource(circuitSource)
checkTamperManifest(tamper)
checkSetup(setup, circuitHash)
checkConfig(config, setup)
checkFeasibility(feasibility, circuit)
for (const error of localReview.errors) {
  fail(`local cryptographic review: ${error}`)
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

writeEvidence(
  'ok',
  String(feasibility.status ?? '').trim(),
  String(feasibility.selected_candidate ?? '').trim(),
  localReview.status)
console.log(`[zk-comment-v2-manifest] ok evidence=${relative(outputPath)}`)
