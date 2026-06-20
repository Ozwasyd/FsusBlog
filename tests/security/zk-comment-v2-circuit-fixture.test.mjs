import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const fixtureManifestPath = path.join(repoRoot, 'tests/fixtures/zk/comment-v2/circuit-ir/fixture.manifest.json')
const tamperManifestPath = path.join(repoRoot, 'security/zk/comment-v2-tamper-cases.manifest.json')

test('comment v2 circuit IR fixture materializes positive witness and rejects every tamper case', () => {
  assert.ok(existsSync(fixtureManifestPath), 'comment.v2 circuit IR fixture manifest must exist')
  const manifest = readJson(fixtureManifestPath)
  const tamperManifest = readJson(tamperManifestPath)

  assert.equal(manifest.schema, 'fsusblog.zk.comment-v2-circuit-ir-fixture.v1')
  assert.equal(manifest.circuit_id, 'fsus.anonymous.comment.v2')
  assert.equal(manifest.public_input_layout_version, 3)
  assert.equal(manifest.evidence_kind, 'deterministic-circuit-ir-witness-v1')
  assert.equal(manifest.production_usable, false)
  assert.equal(manifest.groth16_ceremony_input, false)
  assert.equal(manifest.groth16_proof, false)

  for (const key of ['positive_witness', 'proof_fixture', 'tamper_results']) {
    const artifact = manifest.artifacts?.[key]
    assert.ok(artifact?.path, `artifact ${key} path is required`)
    assert.match(artifact.sha256 ?? '', /^[a-f0-9]{64}$/u, `artifact ${key} sha256 is required`)
    const artifactPath = path.join(repoRoot, artifact.path)
    assert.ok(existsSync(artifactPath), `artifact ${key} must exist at ${artifact.path}`)
    assert.equal(sha256File(artifactPath), artifact.sha256, `artifact ${key} sha256 mismatch`)
  }

  const proofFixture = readArtifact(manifest, 'proof_fixture')
  assert.equal(proofFixture.status, 'accepted')
  assert.equal(proofFixture.hashing_fixture_used, false)
  assert.equal(proofFixture.groth16_proof, false)
  assert.deepEqual(proofFixture.public_inputs, [
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
  ])

  const tamperResults = readArtifact(manifest, 'tamper_results')
  const rejectedIds = new Set(tamperResults.cases.filter((entry) => entry.status === 'rejected').map((entry) => entry.id))
  for (const tamperCase of tamperManifest.tamper_cases) {
    assert.ok(rejectedIds.has(tamperCase.id), `${tamperCase.id} must be rejected by the circuit IR fixture`)
  }
})

function readArtifact(manifest, key) {
  return readJson(path.join(repoRoot, manifest.artifacts[key].path))
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
