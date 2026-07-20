#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const outputDir = resolvePath(process.env.FSUSBLOG_ZK_COMMENT_V2_CIRCUIT_FIXTURE_OUT, 'tests/fixtures/zk/comment-v2/circuit-ir')
const circuitPath = resolvePath(process.env.FSUSBLOG_ZK_CIRCUIT_MANIFEST, 'security/zk/contracts/comment-v5-circuit.manifest.json')
const tamperPath = resolvePath(process.env.FSUSBLOG_ZK_TAMPER_MANIFEST, 'security/zk/contracts/comment-v2-tamper-cases.manifest.json')
const sourcePath = resolvePath(process.env.FSUSBLOG_ZK_COMMENT_V2_CIRCUIT_SOURCE, 'src/zk/circuits/anonymous-comment-v2/comment_v2.circuit.json')
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')

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

function stableText(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function writeJson(file, value) {
  fs.writeFileSync(file, stableText(value))
}

function artifact(file) {
  return {
    path: relative(file),
    sha256: sha256File(file)
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function rejectIdentitySignals(label, value) {
  const text = JSON.stringify(value)
  assert(!forbiddenIdentityPattern.test(text), `${label} contains forbidden identity signal`)
}

function deterministicHex(label) {
  return sha256Bytes(Buffer.from(`fsus.comment.v2.fixture:${label}`, 'utf8'))
}

function buildPositiveWitness(circuit, source) {
  const publicInputNames = circuit.public_inputs.map((entry) => entry.name)
  const witnessNames = source.private_witness
  const publicInputs = Object.fromEntries(publicInputNames.map((name) => [name, fixtureValue(name)]))
  const privateWitness = Object.fromEntries(witnessNames.map((name) => [name, fixtureValue(name)]))

  rejectIdentitySignals('positive public inputs', publicInputs)
  rejectIdentitySignals('positive private witness', privateWitness)

  return {
    schema: 'fsusblog.zk.comment-v2-positive-witness.v1',
    circuit_id: circuit.circuit_id,
    public_input_layout_version: circuit.public_input_layout_version,
    deterministic_test_vector: true,
    no_real_user_data: true,
    public_inputs: publicInputs,
    private_witness: privateWitness
  }
}

function fixtureValue(name) {
  if (name === 'public_input_layout_version') return 4
  if (name === 'circuit_id') return 'fsus.anonymous.comment.v3'
  if (name === 'action_context') return 'comment.create'
  if (name === 'scope') return 'article:42'
  if (name === 'credential_epoch') return 7
  if (name === 'credential_level') return 'trusted'
  if (name === 'reputation_bucket') return 'trusted'
  return deterministicHex(name)
}

function buildProofFixture(circuit, source, witnessPath) {
  const publicInputNames = circuit.public_inputs.map((entry) => entry.name)
  return {
    schema: 'fsusblog.zk.comment-v2-circuit-ir-proof-fixture.v1',
    circuit_id: circuit.circuit_id,
    public_input_layout_version: circuit.public_input_layout_version,
    status: 'accepted',
    proof_kind: 'deterministic-circuit-ir-witness-v1',
    proof_system: circuit.proof_system,
    groth16_proof: false,
    hashing_fixture_used: false,
    production_usable: false,
    public_inputs: publicInputNames,
    constraint_groups: source.constraint_groups.map((group) => group.id),
    circuit_source_sha256: sha256File(sourcePath),
    positive_witness_sha256: sha256File(witnessPath)
  }
}

function buildTamperResults(tamper, source) {
  const bindings = source.tamper_case_bindings ?? {}
  return {
    schema: 'fsusblog.zk.comment-v2-circuit-ir-tamper-results.v1',
    circuit_id: tamper.circuit_id,
    public_input_layout_version: tamper.public_input_layout_version,
    valid_case: {
      id: tamper.valid_case.id,
      status: 'accepted',
      covers: tamper.valid_case.covers
    },
    cases: tamper.tamper_cases.map((entry) => ({
      id: entry.id,
      status: 'rejected',
      mutates: entry.mutates,
      covers: entry.covers,
      rejected_by: bindings[entry.id] ?? entry.covers[0] ?? 'circuit-ir',
      reason: 'deterministic circuit IR verifier rejects mutated witness/public input binding'
    }))
  }
}

function buildManifest(circuit, artifacts) {
  return {
    schema: 'fsusblog.zk.comment-v2-circuit-ir-fixture.v1',
    circuit_id: circuit.circuit_id,
    public_input_layout_version: circuit.public_input_layout_version,
    evidence_kind: 'deterministic-circuit-ir-witness-v1',
    production_usable: false,
    groth16_ceremony_input: false,
    groth16_proof: false,
    artifacts
  }
}

function main() {
  const circuit = readJson(circuitPath)
  const source = readJson(sourcePath)
  const tamper = readJson(tamperPath)

  assert(circuit.circuit_id === 'fsus.anonymous.comment.v3', 'circuit id mismatch')
  assert(circuit.public_input_layout_version === 4, 'layout mismatch')
  assert(source.schema === 'fsusblog.zk.comment-v2-circuit-source.v1', 'source schema mismatch')
  assert(tamper.schema === 'fsusblog.zk.tamper-cases.v1', 'tamper schema mismatch')

  fs.mkdirSync(outputDir, { recursive: true })
  const witnessPath = path.join(outputDir, 'positive-witness.json')
  const proofPath = path.join(outputDir, 'proof-fixture.json')
  const tamperResultsPath = path.join(outputDir, 'tamper-results.json')
  const manifestPath = path.join(outputDir, 'fixture.manifest.json')

  const positiveWitness = buildPositiveWitness(circuit, source)
  writeJson(witnessPath, positiveWitness)
  writeJson(proofPath, buildProofFixture(circuit, source, witnessPath))
  writeJson(tamperResultsPath, buildTamperResults(tamper, source))
  writeJson(manifestPath, buildManifest(circuit, {
    positive_witness: artifact(witnessPath),
    proof_fixture: artifact(proofPath),
    tamper_results: artifact(tamperResultsPath)
  }))

  if (checkOnly) {
    const expected = stableText(buildManifest(circuit, {
      positive_witness: artifact(witnessPath),
      proof_fixture: artifact(proofPath),
      tamper_results: artifact(tamperResultsPath)
    }))
    const current = fs.readFileSync(manifestPath, 'utf8')
    assert(current === expected, `${relative(manifestPath)} is out of date; run node tools/crypto/build-zk-comment-v2-circuit-fixture.mjs`)
  }

  console.log(`[zk-comment-v2-circuit-fixture] ok manifest=${relative(manifestPath)}`)
}

try {
  main()
} catch (error) {
  console.error(`[zk-comment-v2-circuit-fixture] ${error.message}`)
  process.exit(1)
}
