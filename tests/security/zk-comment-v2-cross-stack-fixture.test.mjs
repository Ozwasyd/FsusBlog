import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const fixtureManifestPath = path.join(repoRoot, 'tests/fixtures/zk/comment-v2/mcl-pairing/fixture.manifest.json')

test('comment v2 MCL pairing fixture materializes verifier, proof, public inputs and tamper artifacts', () => {
  assert.ok(existsSync(fixtureManifestPath), 'comment.v2 MCL pairing fixture manifest must exist')
  const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8'))

  assert.equal(manifest.schema, 'fsusblog.zk.comment-v2-cross-stack-fixture.v1')
  assert.equal(manifest.circuit_id, 'fsus.anonymous.comment.v2')
  assert.equal(manifest.public_input_layout_version, 3)
  assert.equal(manifest.evidence_kind, 'mcl-groth16-pairing-equation')
  assert.equal(manifest.backend_verifier, 'managed:mcl')
  assert.equal(manifest.hashing_fixture_used, false)
  assert.equal(manifest.production_usable, false)
  assert.equal(manifest.performance?.native_verifier_p99_ms_max, 50)

  for (const key of ['verifying_key', 'proof', 'public_inputs', 'tamper_cases']) {
    const artifact = manifest.artifacts?.[key]
    assert.ok(artifact?.path, `artifact ${key} path is required`)
    assert.match(artifact.sha256 ?? '', /^[a-f0-9]{64}$/u, `artifact ${key} sha256 is required`)
    const artifactPath = path.join(repoRoot, artifact.path)
    assert.ok(existsSync(artifactPath), `artifact ${key} must exist at ${artifact.path}`)
    assert.equal(sha256File(artifactPath), artifact.sha256, `artifact ${key} sha256 mismatch`)
  }

  const tamperCases = JSON.parse(readFileSync(path.join(repoRoot, manifest.artifacts.tamper_cases.path), 'utf8'))
  const ids = new Set(tamperCases.cases.map((entry) => entry.id))
  for (const id of [
    'tamper-proof-byte',
    'tamper-nullifier-hash',
    'tamper-scope',
    'tamper-credential-root',
    'tamper-revocation-root',
    'tamper-issuer-public-key-hash',
    'tamper-verifying-key-hash'
  ]) {
    assert.ok(ids.has(id), `tamper case ${id} is required`)
  }
})

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}
