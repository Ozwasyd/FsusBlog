import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  checkRepositorySourceLayout,
  validatePolicy,
  validateRepositoryFileBoundary,
  validateRootDirectoryInventory
} from '../../tools/check-repository-source-layout.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const policyPath = path.join(root, 'tests/governance/repository-source-layout.json')
const policy = readJson(policyPath)
const v2SourcePath = path.join(root, 'src/zk/circuits/anonymous-comment-v2/comment_v2.circuit.json')
const v5SourcePath = path.join(root, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
const v2SourceSha = '5b4ef7c9f7e21290ea5e7a9095a9e80be6f9e6b7ef082900eba34b82dae103f6'
const v5SourceSha = 'cdf5510a8df3feddf1ad1c5e760085d38bf7829ce0de813bff196e45acf69278'

test('repository layout owns all handwritten ZK circuit source under src/zk/circuits', () => {
  const result = checkRepositorySourceLayout({ root, policyFile: policyPath })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.circuitSourceCount, 2)
  assert.equal(result.bindingCount, 3)
  assert.equal(existsSync(path.join(root, 'circuits')), false, 'top-level circuits directory must not exist')
  assert.equal(existsSync(v2SourcePath), true)
  assert.equal(existsSync(v5SourcePath), true)
  assert.match(
    readFileSync(path.join(root, 'tools/test/lanes/privacy-zk-comment-matrix.sh'), 'utf8'),
    /tools\/check-repository-source-layout\.mjs/u,
    'the privacy ZK matrix must fail closed on repository source-layout drift'
  )
})

test('layout policy rejects undeclared source roots and unreasoned source exceptions', () => {
  assert.deepEqual(validatePolicy(policy), [])
  assert.deepEqual(
    validateRootDirectoryInventory(policy, ['src', 'tools', 'rogue-circuit-language']),
    ['undeclared top-level directory rogue-circuit-language; handwritten source belongs under src or requires an architectural exception']
  )

  const invalid = structuredClone(policy)
  invalid.rootDirectories.push({ path: 'shader-source', classification: 'source-exception' })
  assert.ok(validatePolicy(invalid).some((error) => error.includes('requires architecturalException')))

  const disguisedSource = structuredClone(policy)
  disguisedSource.rootDirectories.push({ path: 'rogue-circuits', classification: 'documentation' })
  assert.ok(validatePolicy(disguisedSource).some((error) => error.includes('requires architecturalException')))

  const unknownClassification = structuredClone(policy)
  unknownClassification.rootDirectories.push({
    path: 'future-root',
    classification: 'banana',
    architecturalException: 'test-only explicit exception'
  })
  assert.ok(validatePolicy(unknownClassification).some((error) => error.includes('unsupported classification banana')))

  const missingSource = structuredClone(policy)
  missingSource.zk.circuitSources.pop()
  assert.ok(validatePolicy(missingSource).some((error) => error.includes('exact v2 and v5 source identities')))

  const missingBinding = structuredClone(policy)
  missingBinding.zk.jsonSourceBindings.pop()
  assert.ok(validatePolicy(missingBinding).some((error) => error.includes('must cover the canonical v2 manifest')))
})

test('canonical repository files reject symlink and non-regular-file ownership escapes', (t) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'fsusblog-source-layout-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const outsideFile = path.join(fixtureRoot, 'outside.json')
  const ownedRoot = path.join(fixtureRoot, 'repo')
  mkdirSync(path.join(ownedRoot, 'src'), { recursive: true })
  writeFileSync(outsideFile, '{}\n')
  symlinkSync(outsideFile, path.join(ownedRoot, 'src', 'escaped.json'))
  mkdirSync(path.join(ownedRoot, 'src', 'directory.json'))

  assert.ok(validateRepositoryFileBoundary(ownedRoot, 'src/escaped.json').some((error) => error.includes('symbolic link')))
  assert.ok(validateRepositoryFileBoundary(ownedRoot, 'src/directory.json').some((error) => error.includes('regular file')))
})

test('path-only migration preserves both circuit source byte hashes and semantics', () => {
  assert.equal(sha256File(v2SourcePath), v2SourceSha)
  assert.equal(sha256File(v5SourcePath), v5SourceSha)

  const v2 = readJson(v2SourcePath)
  assert.equal(v2.schema, 'fsusblog.zk.comment-v2-circuit-source.v1')
  assert.equal(v2.circuit_id, 'fsus.anonymous.comment.v3')
  assert.equal(v2.public_input_layout_version, 4)
  assert.equal(v2.proof_system, 'Groth16')
  assert.equal(v2.curve, 'bn254')
  assert.equal(v2.metrics.estimated_constraints, 125920)

  const v5 = readJson(v5SourcePath)
  assert.equal(v5.schema, 'fsusblog.zk.anonymous-comment-circuit.v2')
  assert.equal(v5.circuit_id, 'fsus.anonymous.comment.v5')
  assert.equal(v5.public_input_layout_version, 6)
  assert.equal(v5.proof_system, 'Groth16')
  assert.equal(v5.curve, 'bn254')
})

test('regenerated R1CS and manifests bind the canonical source path without changing readiness', () => {
  const circuit = readJson(path.join(root, 'security/zk/comment-v2-circuit.manifest.json'))
  const setup = readJson(path.join(root, 'security/zk/comment-v2-trusted-setup.manifest.json'))
  const r1csPath = path.join(root, 'artifacts/zk/comment-v2/comment_v2.r1cs')
  const groth16Path = path.join(root, 'artifacts/zk/comment-v2/comment_v2_groth16.r1cs')
  const r1cs = readJson(r1csPath)
  const groth16 = readGroth16Payload(groth16Path)

  assert.equal(r1cs.source_path, 'src/zk/circuits/anonymous-comment-v2/comment_v2.circuit.json')
  assert.equal(groth16.source_path, r1cs.source_path)
  assert.equal(r1cs.source_sha256, v2SourceSha)
  assert.equal(groth16.source_sha256, v2SourceSha)
  assert.equal(circuit.r1cs_source.path, r1cs.source_path)
  assert.equal(circuit.r1cs_source.sha256, v2SourceSha)
  assert.equal(circuit.artifact_hashes.r1cs_sha256, sha256File(r1csPath))
  assert.equal(circuit.artifact_hashes.groth16_r1cs_sha256, sha256File(groth16Path))
  assert.equal(setup.artifacts.r1cs.sha256, sha256File(r1csPath))
  assert.equal(setup.artifacts.groth16_r1cs.sha256, sha256File(groth16Path))

  assert.equal(circuit.production_usable, false)
  assert.equal(circuit.artifact_status, 'source-and-r1cs')
  assert.equal(setup.production_usable, false)
  assert.equal(setup.ceremony_status, 'not-run')

  const v5Manifest = readJson(path.join(root, 'security/zk/comment-v5-circuit.manifest.json'))
  assert.equal(v5Manifest.source, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
  assert.equal(v5Manifest.source_sha256, v5SourceSha)
  assert.equal(v5Manifest.artifact_status, 'source-only')
  assert.equal(v5Manifest.production_usable, false)
})

function readGroth16Payload(file) {
  const bytes = readFileSync(file)
  assert.equal(bytes.subarray(0, 10).toString('ascii'), 'FSG16R1CS1')
  const payloadLength = bytes.readUInt32LE(16)
  assert.equal(bytes.length, 32 + payloadLength)
  return JSON.parse(bytes.subarray(32).toString('utf8'))
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}
