import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = 'tools/crypto/check-zk-comment-v1-manifests.mjs'
const circuitPath = 'security/zk/comment-v1-circuit.manifest.json'
const tamperPath = 'security/zk/comment-v1-tamper-cases.manifest.json'
const setupPath = 'security/zk/comment-v1-trusted-setup.manifest.json'
const configPath = 'config/zk/anonymous-comment-v1-verifying-key.manifest.json'
const feasibilityPath = 'security/zk/comment-v1-feasibility.manifest.json'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
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
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-comment-v1-'))
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

test('comment v1 zk manifests pass the static contract checker', () => {
  const result = runChecker()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[zk-comment-v1-manifest] ok/)
})

test('comment v1 feasibility manifest records the unresolved BLS12-in-bn254 production blocker', () => {
  const feasibility = readJson(feasibilityPath)

  assert.equal(feasibility.schema, 'fsusblog.zk.comment-v1-feasibility.v1')
  assert.equal(feasibility.circuit_id, 'fsus.anonymous.comment.v1')
  assert.equal(feasibility.status, 'blocked-pending-design-decision')
  assert.equal(feasibility.current_boundary.credential_curve, 'BLS12-381')
  assert.equal(feasibility.current_boundary.groth16_curve, 'bn254')

  const inCircuitBls = feasibility.candidates.find((entry) => entry.id === 'in-circuit-bls12-381-bbs-on-bn254')
  assert.equal(inCircuitBls.decision, 'rejected-for-current-performance-budget')
  assert.ok(inCircuitBls.performance.constraints_estimate >= 19_000_000)
  assert.ok(inCircuitBls.performance.proving_key_bytes_estimate >= 12_000_000_000)
  assert.match(inCircuitBls.license_boundary.reference_license, /GPL-3.0/)
})

test('checker evidence includes the feasibility manifest and unresolved design status', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-comment-v1-evidence-'))
  const out = path.join(dir, 'evidence.json')
  const result = runChecker({
    FSUSBLOG_ZK_MANIFEST_CHECK_OUT: out
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const evidence = readJson(out)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.manifests.feasibility, feasibilityPath)
  assert.equal(evidence.feasibility_status, 'blocked-pending-design-decision')
})

test('comment v1 circuit contract has required public inputs, witness and no identity fields', () => {
  const circuit = readJson(circuitPath)
  const publicInputs = circuit.public_inputs.map((entry) => entry.name)
  const privateWitness = circuit.private_witness.map((entry) => entry.name)

  assert.deepEqual(new Set(publicInputs), new Set([
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
  ]))
  assert.ok(privateWitness.includes('credential_secret'))
  assert.ok(privateWitness.includes('bbs_plus_issuer_signature'))
  assert.ok(privateWitness.includes('credential_membership_proof'))
  assert.ok(privateWitness.includes('revocation_non_membership_witness'))

  const combinedNames = [...publicInputs, ...privateWitness].join('\n')
  assert.doesNotMatch(combinedNames, /userId|user_id|username|public_handle|account_id|session_id/)
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

test('checker fails if circuit claims production-ready without real R1CS source and artifact hashes', () => {
  const result = withTempManifests((documents) => {
    documents.circuit.artifact_status = 'production-ready'
    documents.setup.circuit_manifest_sha256 = manifestHash(documents.circuit)
  })

  assert.notEqual(result.status, 0)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /cannot claim production-ready without real R1CS source and artifact hashes/
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
