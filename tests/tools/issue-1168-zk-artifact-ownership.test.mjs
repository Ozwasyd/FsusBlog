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
  drifted.circuit_id = 'fsus.anonymous.comment.invalid'
  drifted.public_input_layout_version = 0
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

test('checker rejects retired paths, encoded identities, compound key extensions and read failures across the tree', () => {
  const retiredPath = ['nested/', 'comment', '_', 'v', '2', '/layout', '4', '/fixture.json'].join('')
  const retiredLayoutPath = ['nested/comment-', 'v', '3', '-layout', '4', '/fixture.json'].join('')
  const retiredIdentity = ['fsus.anonymous.comment.', 'v', '3'].join('')
  const retiredLayout = ['{"public_input_layout_version": ', String(2 + 2), '}'].join('')
  const encodedMagic = ['FSG16', 'VK1'].join('')
  const utf16Be = Buffer.from(retiredLayout, 'utf16le')
  utf16Be.swap16()
  const files = [
    ...trackedFiles,
    retiredPath,
    retiredLayoutPath,
    'nested/operator.pk.bin',
    'nested/nul-prefix.bin',
    'nested/utf16le.bin',
    'nested/utf16be.bin',
    'nested/base64.txt',
    'nested/magic.bin',
    'nested/unreadable.txt'
  ]
  const content = new Map([
    [retiredPath, Buffer.from('{}')],
    [retiredLayoutPath, Buffer.from('{}')],
    ['nested/operator.pk.bin', Buffer.from('not-a-key')],
    ['nested/nul-prefix.bin', Buffer.concat([Buffer.from([0]), Buffer.from(retiredIdentity)])],
    ['nested/utf16le.bin', Buffer.from(retiredIdentity, 'utf16le')],
    ['nested/utf16be.bin', utf16Be],
    ['nested/base64.txt', Buffer.from(Buffer.from(retiredIdentity).toString('base64'))],
    ['nested/magic.bin', Buffer.from(`${encodedMagic}\0payload`)]
  ])
  const errors = validateZkArtifactOwnership({
    root,
    manifest,
    trackedFiles: files,
    readTrackedFile: (file) => {
      if (file === 'nested/unreadable.txt') throw new Error('mutation read denied')
      return content.get(file) ?? readFileSync(path.join(root, file))
    }
  })
  assert.ok(errors.filter((error) => error.includes('retired proving-system path')).length >= 2)
  assert.ok(errors.some((error) => error.includes('operator.pk.bin') && error.includes('cryptographic artifact')))
  for (const file of ['nul-prefix.bin', 'utf16le.bin', 'utf16be.bin', 'base64.txt']) {
    assert.ok(errors.some((error) => error.includes(file) && error.includes('retired proving-system identity')), file)
  }
  assert.ok(errors.some((error) => error.includes('magic.bin') && error.includes('encoded proving artifact')))
  assert.ok(errors.some((error) => error.includes('unreadable.txt') && error.includes('fail-closed')))
})
