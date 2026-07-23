import assert from 'node:assert/strict'
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
const v5SourcePath = path.join(root, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
const v5SourceSha = '8a7ff2f645ce611434fe82118921f277cb1eca5c2533f0cc8e11d2836f560d9d'

test('repository layout owns all handwritten ZK circuit source under src/zk/circuits', () => {
  const result = checkRepositorySourceLayout({ root, policyFile: policyPath })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.languageOwnershipBindingCount, 2)
  assert.equal(result.circuitSourceCount, 1)
  assert.equal(result.bindingCount, 1)
  assert.equal(existsSync(path.join(root, 'circuits')), false, 'top-level circuits directory must not exist')
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
  assert.ok(validatePolicy(missingSource).some((error) => error.includes('only the active v5 source identity')))

  const missingBinding = structuredClone(policy)
  missingBinding.zk.jsonSourceBindings.pop()
  assert.ok(validatePolicy(missingBinding).some((error) => error.includes('only the active v5 circuit manifest')))
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

test('repository preserves the active v5 circuit source identity and semantics', () => {
  const v5 = readJson(v5SourcePath)
  assert.equal(v5.schema, 'fsusblog.zk.anonymous-comment-circuit.v2')
  assert.equal(v5.circuit_id, 'fsus.anonymous.comment.v5')
  assert.equal(v5.public_input_layout_version, 6)
  assert.equal(v5.proof_system, 'Groth16')
  assert.equal(v5.curve, 'bn254')
})

test('active circuit manifest binds the canonical source and remains fail closed', () => {
  const v5Manifest = readJson(path.join(root, 'security/zk/contracts/comment-v5-circuit.manifest.json'))
  assert.equal(v5Manifest.source, 'src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json')
  assert.equal(v5Manifest.source_sha256, v5SourceSha)
  assert.equal(v5Manifest.artifact_status, 'source-only')
  assert.equal(v5Manifest.production_usable, false)
})

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}
