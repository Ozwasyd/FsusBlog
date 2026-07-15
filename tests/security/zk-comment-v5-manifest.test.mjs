import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const checker = path.join(root, 'tools/security/check-zk-comment-v5-manifests.mjs')

function run(env = {}) {
  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

test('active v5 manifest set is source-only, fail-closed and cross-stack aligned', () => {
  const result = run()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /active layout-6 source/)
})

test('active v5 manifest gate rejects reintroduced exact credential attributes', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsus-zk-v5-manifest-'))
  try {
    const source = JSON.parse(readFileSync(path.join(root, 'circuits/anonymous-comment-v5/comment_v5.circuit.json'), 'utf8'))
    source.public_inputs.push('credential_level')
    const sourcePath = path.join(directory, 'comment-v5-source.json')
    writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`)
    const result = run({ FSUSBLOG_ZK_V5_CIRCUIT_SOURCE: sourcePath })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /source\.public_inputs must use the exact layout-6 order/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
