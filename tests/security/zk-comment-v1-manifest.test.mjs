import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const checker = 'tools/crypto/check-zk-comment-v1-manifests.mjs'
const circuitPath = 'security/zk/comment-v1-circuit.manifest.json'
const tamperPath = 'security/zk/comment-v1-tamper-cases.manifest.json'

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
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
    out: path.join(dir, 'evidence.json')
  }

  const documents = {
    circuit: readJson(circuitPath),
    tamper: readJson(tamperPath)
  }
  mutator(documents)

  writeFileSync(files.circuit, `${JSON.stringify(documents.circuit, null, 2)}\n`)
  writeFileSync(files.tamper, `${JSON.stringify(documents.tamper, null, 2)}\n`)

  const result = runChecker({
    FSUSBLOG_ZK_CIRCUIT_MANIFEST: files.circuit,
    FSUSBLOG_ZK_TAMPER_MANIFEST: files.tamper,
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

test('checker fails if a required tamper case is removed', () => {
  const result = withTempManifests((documents) => {
    documents.tamper.tamper_cases = documents.tamper.tamper_cases.filter(
      (entry) => entry.id !== 'tamper-nullifier-hash')
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /tamper.tamper_cases missing tamper-nullifier-hash/)
})
