import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const verifier = 'tools/verify-zk-privacy-matrix.mjs'
const matrixPath = 'security/matrices/privacy-zk-comment.yml'
const tamperPath = 'security/zk/contracts/comment-v2-tamper-cases.manifest.json'

function runVerifier(args = []) {
  return spawnSync(process.execPath, [verifier, ...args], {
    encoding: 'utf8'
  })
}

test('zk privacy matrix verifier accepts the repository manifests', () => {
  const result = runVerifier()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /\[zk-privacy-matrix] ok/)
})

test('zk privacy matrix verifier fails when required negative invariant lacks a manifest mapping', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-matrix-'))
  try {
    const matrix = path.join(dir, 'matrix.yml')
    const tamper = path.join(dir, 'tamper.json')
    const manifest = JSON.parse(readFileSync(tamperPath, 'utf8'))
    manifest.negative_invariants = manifest.negative_invariants.filter(
      (entry) => entry.id !== 'tamper-nullifier-scope-root-revocation-reject'
    )

    writeFileSync(matrix, readFileSync(matrixPath, 'utf8'))
    writeFileSync(tamper, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runVerifier(['--matrix', matrix, '--tamper', tamper])
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /tamper-nullifier-scope-root-revocation-reject/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('zk privacy matrix verifier fails when a negative invariant references a missing tamper case', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fsusblog-zk-matrix-'))
  try {
    const matrix = path.join(dir, 'matrix.yml')
    const tamper = path.join(dir, 'tamper.json')
    const manifest = JSON.parse(readFileSync(tamperPath, 'utf8'))
    const invariant = manifest.negative_invariants.find(
      (entry) => entry.id === 'tamper-nullifier-scope-root-revocation-reject'
    )
    invariant.tamper_cases = ['tamper-missing-case']

    writeFileSync(matrix, readFileSync(matrixPath, 'utf8'))
    writeFileSync(tamper, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runVerifier(['--matrix', matrix, '--tamper', tamper])
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /tamper-missing-case/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
