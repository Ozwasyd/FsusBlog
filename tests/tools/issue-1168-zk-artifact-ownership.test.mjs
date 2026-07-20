import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { validateZkArtifactOwnership } from '../../tools/crypto/check-zk-artifact-ownership.mjs'

const root = path.resolve(import.meta.dirname, '..', '..')
const manifest = JSON.parse(readFileSync(
  path.join(root, 'security/zk/provenance/artifact-ownership.manifest.json'), 'utf8'))
const trackedFiles = ['artifacts/zk/comment-v5/README.md']

test('canonical ZK artifact ownership is v5 layout-6 only', () => {
  assert.deepEqual(validateZkArtifactOwnership({ root }), [])
})

test('checker rejects identity drift and tracked ceremony artifacts together', () => {
  const drifted = structuredClone(manifest)
  drifted.circuit_id = 'fsus.anonymous.comment.v4'
  drifted.public_input_layout_version = 5
  const provingKeyPath = drifted.external_artifacts
    .find((entry) => entry.manifest_field === 'artifacts.proving_key.path').path
  const errors = validateZkArtifactOwnership({
    root,
    manifest: drifted,
    trackedFiles: [...trackedFiles, provingKeyPath]
  })
  assert.ok(errors.some((error) => error.includes('circuit_id must equal fsus.anonymous.comment.v5')))
  assert.ok(errors.some((error) => error.includes('public_input_layout_version must equal 6')))
  assert.ok(errors.some((error) => error.includes('external ceremony or delivery artifact must not be Git-tracked')))
})

test('checker rejects external ownership drift from the trusted setup manifest', () => {
  const drifted = structuredClone(manifest)
  drifted.external_artifacts = drifted.external_artifacts.filter(
    (entry) => entry.manifest_field !== 'artifacts.wasm_prover_bundle.path')
  const errors = validateZkArtifactOwnership({ root, manifest: drifted, trackedFiles })
  assert.ok(errors.some((error) => error.includes('artifacts.wasm_prover_bundle.path')))
  assert.ok(errors.some((error) => error.includes('exactly match')))
})
