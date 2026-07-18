import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateZkArtifactOwnership } from '../../tools/crypto/check-zk-artifact-ownership.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const manifestPath = path.join(root, 'security/zk/artifact-ownership.manifest.json')
const canonicalManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const canonicalTrackedFiles = canonicalManifest.tracked_artifacts.map((artifact) => artifact.path)
const temporaryRoots = []

test.after(() => {
  for (const directory of temporaryRoots) rmSync(directory, { recursive: true, force: true })
})

test('canonical ZK artifact ownership is identity-correct and complete', () => {
  assert.deepEqual(validateZkArtifactOwnership({ root }), [])
})

test('checker reports hash drift and mixed package identity together', () => {
  const manifest = structuredClone(canonicalManifest)
  manifest.tracked_artifacts[0].sha256 = '0'.repeat(64)
  manifest.tracked_artifacts[1].circuit_id = 'fsus.anonymous.comment.v2'
  manifest.tracked_artifacts[1].public_input_layout_version = 3

  const errors = validateZkArtifactOwnership({ root, manifest, trackedFiles: canonicalTrackedFiles })
  assert.ok(errors.some((error) => error.includes('SHA-256 mismatch')))
  assert.ok(errors.some((error) => error.includes('circuit_id must equal fsus.anonymous.comment.v3')))
  assert.ok(errors.some((error) => error.includes('artifact package mixes identities')))
})

test('checker rejects unowned and Git-tracked ceremony binaries in one run', () => {
  const trackedFiles = [
    ...canonicalTrackedFiles,
    'artifacts/zk/unowned/rogue.bin',
    'artifacts/zk/comment-v3-layout4/keys/comment_v3_final.fsg16pk'
  ]
  const errors = validateZkArtifactOwnership({
    root,
    manifest: structuredClone(canonicalManifest),
    trackedFiles
  })

  assert.ok(errors.some((error) => error.includes('tracked cryptographic binary has no owner: artifacts/zk/unowned/rogue.bin')))
  assert.ok(errors.some((error) => error.includes('external ceremony or delivery artifact must not be Git-tracked')))
})

test('checker rejects active manifests that select retired artifacts', () => {
  const fixture = createFixture()
  const configPath = path.join(fixture.root, 'config/zk/anonymous-comment-v2-verifying-key.manifest.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.verifying_key_path = 'artifacts/zk/comment-v2/comment_v2_verifying_key.bin'
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

  const errors = validateZkArtifactOwnership({
    root: fixture.root,
    manifest: fixture.manifest,
    trackedFiles: canonicalTrackedFiles
  })
  assert.ok(errors.some((error) => error.includes('active manifest selects retired artifact')))
})

test('checker rejects reintroduced deleted v2 layout3 material', () => {
  const fixture = createFixture()
  const retiredPath = fixture.manifest.retired_artifacts[0].original_path
  const absolutePath = path.join(fixture.root, retiredPath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, 'retired key material\n')

  const errors = validateZkArtifactOwnership({
    root: fixture.root,
    manifest: fixture.manifest,
    trackedFiles: [...canonicalTrackedFiles, retiredPath]
  })
  assert.ok(errors.some((error) => error.includes('forbidden mixed-identity artifact root exists')))
  assert.ok(errors.some((error) => error.includes('retired artifact must remain deleted')))
})

function createFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-artifact-ownership-'))
  temporaryRoots.push(directory)
  const manifest = structuredClone(canonicalManifest)
  const requiredPaths = new Set([
    ...manifest.tracked_artifacts.flatMap((artifact) => [
      artifact.path,
      artifact.owner,
      artifact.generator,
      ...artifact.consumers
    ]),
    ...manifest.active_manifests,
    ...manifest.active_consumers.map((consumer) => consumer.path)
  ])
  for (const relativePath of requiredPaths) copy(relativePath, directory)
  const targetManifest = path.join(directory, 'security/zk/artifact-ownership.manifest.json')
  mkdirSync(path.dirname(targetManifest), { recursive: true })
  writeFileSync(targetManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return { root: directory, manifest }
}

function copy(relativePath, destinationRoot) {
  const source = path.join(root, relativePath)
  const destination = path.join(destinationRoot, relativePath)
  mkdirSync(path.dirname(destination), { recursive: true })
  copyFileSync(source, destination)
}
