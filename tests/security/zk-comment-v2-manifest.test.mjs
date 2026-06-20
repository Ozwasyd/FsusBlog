import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = 'tools/crypto/check-zk-comment-v2-manifests.mjs'
const builder = 'tools/crypto/build-zk-comment-v2-r1cs.mjs'
const circuitPath = 'security/zk/comment-v2-circuit.manifest.json'
const tamperPath = 'security/zk/comment-v2-tamper-cases.manifest.json'
const setupPath = 'security/zk/comment-v2-trusted-setup.manifest.json'
const configPath = 'config/zk/anonymous-comment-v2-verifying-key.manifest.json'
const feasibilityPath = 'security/zk/comment-v2-feasibility.manifest.json'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function manifestHash(document) {
  return createHash('sha256').update(`${JSON.stringify(document, null, 2)}\n`).digest('hex')
}

function runChecker(env = {}) {
  return spawnSync(process.execPath, [checker], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  })
}

function withTempManifests(mutator) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-comment-v2-'))
  const files = {
    circuit: path.join(dir, 'circuit.json'),
    tamper: path.join(dir, 'tamper.json'),
    setup: path.join(dir, 'setup.json'),
    config: path.join(dir, 'config.json'),
    feasibility: path.join(dir, 'feasibility.json'),
    out: path.join(dir, 'evidence.json')
  }

  const documents = {
    circuit: readJson(circuitPath),
    tamper: readJson(tamperPath),
    setup: readJson(setupPath),
    config: readJson(configPath),
    feasibility: readJson(feasibilityPath)
  }
  mutator(documents)

  writeFileSync(files.circuit, `${JSON.stringify(documents.circuit, null, 2)}\n`)
  writeFileSync(files.tamper, `${JSON.stringify(documents.tamper, null, 2)}\n`)
  writeFileSync(files.setup, `${JSON.stringify(documents.setup, null, 2)}\n`)
  writeFileSync(files.config, `${JSON.stringify(documents.config, null, 2)}\n`)
  writeFileSync(files.feasibility, `${JSON.stringify(documents.feasibility, null, 2)}\n`)

  const result = runChecker({
    FSUSBLOG_ZK_CIRCUIT_MANIFEST: files.circuit,
    FSUSBLOG_ZK_TAMPER_MANIFEST: files.tamper,
    FSUSBLOG_ZK_TRUSTED_SETUP_MANIFEST: files.setup,
    FSUSBLOG_ZK_VERIFYING_KEY_CONFIG_MANIFEST: files.config,
    FSUSBLOG_ZK_FEASIBILITY_MANIFEST: files.feasibility,
    FSUSBLOG_ZK_MANIFEST_CHECK_OUT: files.out
  })

  rmSync(dir, { recursive: true, force: true })
  return result
}

test('comment v2 zk manifests pass the static contract checker', () => {
  const result = runChecker()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[zk-comment-v2-manifest] ok/)
})

test('comment v2 feasibility manifest records the selected circuit-native credential boundary', () => {
  const feasibility = readJson(feasibilityPath)

  assert.equal(feasibility.schema, 'fsusblog.zk.comment-v2-feasibility.v1')
  assert.equal(feasibility.circuit_id, 'fsus.anonymous.comment.v2')
  assert.equal(feasibility.status, 'resolved')
  assert.equal(feasibility.selected_candidate, 'circuit-native-credential-v2')
  assert.equal(feasibility.current_boundary.credential_scheme, 'circuit-native-credential-v2')
  assert.equal(feasibility.current_boundary.groth16_curve, 'bn254')

  const inCircuitBls = feasibility.candidates.find((entry) => entry.id === 'in-circuit-bls12-381-bbs-on-bn254')
  assert.equal(inCircuitBls.decision, 'rejected-for-current-performance-budget')
  assert.ok(inCircuitBls.performance.constraints_estimate >= 19_000_000)
  assert.ok(inCircuitBls.performance.proving_key_bytes_estimate >= 12_000_000_000)
  assert.match(inCircuitBls.license_boundary.reference_license, /GPL-3.0/)

  const selected = feasibility.candidates.find((entry) => entry.id === 'circuit-native-credential-v2')
  assert.equal(selected.decision, 'selected')
  assert.equal(selected.credential_curve, 'bn254')
  assert.ok(selected.performance.constraints_estimate <= 250_000)
  assert.ok(selected.performance.proving_key_bytes_estimate <= 256_000_000)
})

test('checker evidence includes the feasibility manifest and selected design status', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-comment-v2-evidence-'))
  const out = path.join(dir, 'evidence.json')
  const result = runChecker({
    FSUSBLOG_ZK_MANIFEST_CHECK_OUT: out
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const evidence = readJson(out)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.manifests.feasibility, feasibilityPath)
  assert.equal(evidence.feasibility_status, 'resolved')
  assert.equal(evidence.selected_candidate, 'circuit-native-credential-v2')
})

test('checker fails if privacy ZK dependency policy permits third-party JSON parser packages', () => {
  const result = withTempManifests((documents) => {
    documents.feasibility.dependency_policy.json_parser = 'Newtonsoft.Json'
    documents.feasibility.dependency_policy.implementation_rules = [
      'parse trusted setup and verifying key JSON with Newtonsoft.Json'
    ]
    documents.feasibility.dependency_policy.forbidden_packages = []
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /System\.Text\.Json|privacy-zk dependency policy forbids/)
})

test('comment v2 circuit contract has required public inputs, witness and no identity fields', () => {
  const circuit = readJson(circuitPath)
  const publicInputs = circuit.public_inputs.map((entry) => entry.name)
  const privateWitness = circuit.private_witness.map((entry) => entry.name)

  assert.deepEqual(new Set(publicInputs), new Set([
    'public_input_layout_version',
    'circuit_id',
    'action_context',
    'scope',
    'nullifier_hash',
    'credential_commitment',
    'credential_root',
    'revocation_root',
    'credential_epoch',
    'credential_level',
    'reputation_bucket',
    'issuer_public_key_hash',
    'policy_hash',
    'verifying_key_hash'
  ]))
  assert.ok(privateWitness.includes('credential_secret'))
  assert.ok(privateWitness.includes('circuit_native_issuer_signature'))
  assert.ok(privateWitness.includes('issuer_signature_public_key'))
  assert.ok(privateWitness.includes('credential_membership_proof'))
  assert.ok(privateWitness.includes('revocation_non_membership_witness'))

  const combinedNames = [...publicInputs, ...privateWitness].join('\n')
  assert.doesNotMatch(combinedNames, /userId|user_id|username|public_handle|account_id|session_id/)
})

test('comment v2 circuit source and generated R1CS artifact are hash-bound', () => {
  const circuit = readJson(circuitPath)
  const setup = readJson(setupPath)
  const source = circuit.r1cs_source ?? {}
  const r1cs = setup.artifacts?.r1cs ?? {}
  const groth16R1cs = setup.artifacts?.groth16_r1cs ?? {}

  assert.equal(circuit.artifact_status, 'source-and-r1cs')
  assert.ok(source.path, 'circuit.r1cs_source.path is required')
  assert.ok(source.sha256, 'circuit.r1cs_source.sha256 is required')
  assert.ok(r1cs.path, 'setup.artifacts.r1cs.path is required')
  assert.ok(r1cs.sha256, 'setup.artifacts.r1cs.sha256 is required')
  assert.equal(r1cs.format, 'fsusblog.zk.r1cs-ir.v1')
  assert.equal(r1cs.ceremony_input, false)
  assert.equal(groth16R1cs.format, 'rank1cs-binary')
  assert.equal(groth16R1cs.ceremony_input, true)
  assert.ok(groth16R1cs.path, 'setup.artifacts.groth16_r1cs.path is required')
  assert.equal(groth16R1cs.sha256, '')
  assert.match(setup.phase2.verification_command, /comment_v2_groth16\.r1cs/)
  assert.doesNotMatch(setup.phase2.verification_command, /comment_v2\.r1cs/)

  assert.ok(existsSync(source.path), `${source.path} must exist`)
  assert.ok(existsSync(r1cs.path), `${r1cs.path} must exist`)
  assert.equal(sha256File(source.path), source.sha256)
  assert.equal(sha256File(r1cs.path), r1cs.sha256)
  assert.equal(r1cs.sha256, circuit.artifact_hashes?.r1cs_sha256)

  const sourceDocument = readJson(source.path)
  assert.equal(sourceDocument.schema, 'fsusblog.zk.comment-v2-circuit-source.v1')
  assert.equal(sourceDocument.circuit_id, 'fsus.anonymous.comment.v2')
  assert.equal(sourceDocument.public_input_layout_version, 3)
  assert.equal(sourceDocument.proof_system, 'Groth16')
  assert.equal(sourceDocument.curve, 'bn254')

  const result = spawnSync(process.execPath, [builder, '--check'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('comment v2 revocation witness shape keeps fixture hash outside circuit inputs', () => {
  const circuit = readJson(circuitPath)
  const sourceDocument = readJson(circuit.r1cs_source.path)
  const witnessShape = sourceDocument.primitives.revocation_non_membership.witness_shape ?? {}

  assert.equal(witnessShape.path_depth, 128)
  assert.deepEqual(witnessShape.circuit_fields, [
    'leafKey',
    'siblingHashes[0..127]'
  ])
  assert.equal(witnessShape.witness_hash_role, 'fixture_integrity_only')
  assert.equal(witnessShape.witness_hash_circuit_input, false)
})

test('comment v2 handoff consumers point to the active unversioned issue set', () => {
  const setup = readJson(setupPath)
  const config = readJson(configPath)
  const handoff = [...setup.handoff_consumers, ...config.handoff_consumers].join('\n')

  assert.match(handoff, /#552/)
  assert.match(handoff, /#553/)
  assert.match(handoff, /#555/)
  assert.doesNotMatch(handoff, /#545|#546/)
})

test('tamper manifest rejects every security assertion', () => {
  const circuit = readJson(circuitPath)
  const tamper = readJson(tamperPath)
  const assertionIds = circuit.security_assertions.map((entry) => entry.id)
  const rejectCoverage = new Set(tamper.tamper_cases.flatMap((entry) => entry.covers))

  for (const assertionId of assertionIds) {
    assert.ok(rejectCoverage.has(assertionId), `${assertionId} lacks a rejecting tamper case`)
  }
})

test('checker fails if identity fields are injected into public inputs', () => {
  const result = withTempManifests((documents) => {
    documents.circuit.public_inputs.push({
      name: 'userId',
      type: 'u64',
      constraint: 'forbidden identity injection'
    })
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /forbidden identity field userId/)
})

test('checker fails if verifying key hash uses a placeholder token', () => {
  const result = withTempManifests((documents) => {
    documents.setup.verifying_key_hash = 'vk-sha256'
    documents.config.verifying_key_hash = 'vk-sha256'
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /placeholder hash vk-sha256/)
})

test('checker fails if production usable is claimed without real setup artifacts', () => {
  const result = withTempManifests((documents) => {
    documents.setup.production_usable = true
    documents.config.production_usable = true
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /production_usable must remain false/)
})

test('checker fails if phase2 ceremony uses the deterministic R1CS IR artifact', () => {
  const result = withTempManifests((documents) => {
    documents.setup.phase2.verification_command =
      'snarkjs zkey verify artifacts/zk/comment-v2/comment_v2.r1cs artifacts/zk/comment-v2/phase1/powers_of_tau_final.ptau artifacts/zk/comment-v2/comment_v2_final.zkey'
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /must not use deterministic R1CS IR/)
})

test('checker fails if circuit claims production-ready without real R1CS source and artifact hashes', () => {
  const result = withTempManifests((documents) => {
    documents.circuit.artifact_status = 'production-ready'
    documents.setup.circuit_manifest_sha256 = manifestHash(documents.circuit)
  })

  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /circuit\.artifact_status must be an explicit fail-closed status/
  )
})

test('checker fails if circuit omits explicit fail-closed artifact status', () => {
  const result = withTempManifests((documents) => {
    delete documents.circuit.artifact_status
    documents.setup.circuit_manifest_sha256 = manifestHash(documents.circuit)
  })

  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /circuit\.artifact_status must be an explicit fail-closed status/
  )
})

test('checker fails if trusted setup hash drifts from the circuit manifest', () => {
  const result = withTempManifests((documents) => {
    documents.circuit.public_inputs[0].constraint = 'tampered layout discriminator'
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /setup\.circuit_manifest_sha256 expected/)
})

test('checker fails if trusted setup contribution thresholds are weakened', () => {
  const result = withTempManifests((documents) => {
    documents.setup.phase1.minimum_contributions = 2
    documents.setup.phase2.minimum_contributions = 1
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /setup\.phase1\.minimum_contributions must be at least 3/)
  assert.match(`${result.stdout}\n${result.stderr}`, /setup\.phase2\.minimum_contributions must be at least 3/)
})

test('checker fails if trusted setup transcript or artifact hashes use placeholders', () => {
  const result = withTempManifests((documents) => {
    documents.setup.phase1.transcript_sha256 = 'TODO'
    documents.setup.artifacts.proving_key.sha256 = 'placeholder'
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /setup\.phase1\.transcript_sha256 uses placeholder hash TODO/)
  assert.match(`${result.stdout}\n${result.stderr}`, /setup\.artifacts\.proving_key\.sha256 uses placeholder hash placeholder/)
})
