import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..', '..')
const checker = path.join(root, 'tools/security/check-anonymous-eligibility-privacy.mjs')

test('anonymous eligibility privacy contract and aggregate evidence pass', () => {
  const result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('aggregate fixture rejects exact attributes and member identifiers', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fsus-anonymity-evidence-'))
  try {
    const evidence = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/evidence/anonymous-eligibility-anonymity-set.json'), 'utf8'))
    evidence.sample.memberIds = ['forbidden']
    const file = path.join(directory, 'evidence.json')
    writeFileSync(file, JSON.stringify(evidence))
    const result = spawnSync(process.execPath, [checker, '--evidence', file], { cwd: root, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /sensitive field/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
