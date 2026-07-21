import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const checker = path.join(root, 'tools/security/check-zk-comment-v5-unlinkability.mjs')

test('100-scope complete wire transcripts contain no stable credential identifier', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fsus-zk-unlinkable-'))
  const output = path.join(dir, 'evidence.json')
  const result = spawnSync(process.execPath, [checker, '--out', output], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(evidence.status, 'ok')
  assert.equal(evidence.sampled_scopes, 100)
  assert.equal(evidence.same_scope_nullifier_stable, true)
  assert.equal(evidence.different_scope_nullifiers_unique, true)
  assert.equal(evidence.complete_wire_transcripts_unique, true)
  assert.deepEqual(evidence.credential_specific_stable_fields, [])
  assert.equal(evidence.legacy_layout_rejected, true)
  assert.equal(evidence.production_usable, false)
})

test('gate rejects a credential commitment reintroduced into public inputs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fsus-zk-linkable-'))
  const manifest = JSON.parse(readFileSync(path.join(root, 'security/zk/contracts/comment-v5-circuit.manifest.json'), 'utf8'))
  manifest.public_inputs.splice(5, 0, {
    name: 'credential_commitment',
    type: 'field',
    constraint: 'reintroduced linkable identifier'
  })
  const manifestPath = path.join(dir, 'manifest.json')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const result = spawnSync(process.execPath, [checker, '--out', path.join(dir, 'evidence.json')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_ZK_UNLINKABILITY_MANIFEST: manifestPath }
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /credential_commitment|exact unlinkable layout 6 order/u)
})
