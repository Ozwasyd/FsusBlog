import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const legacy = path.join(root, 'tools/test/legacy-test.sh')

test('controlled filtered-lane dry-run writes stable lane TRX files and passing result content', (t) => {
  const trxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-trx-'))
  t.after(() => fs.rmSync(trxRoot, { recursive: true, force: true }))
  const result = spawnSync('bash', [
    legacy,
    'backend-trx-contract-dry-run',
    'backend-unit',
    'backend-property',
    'coverage-backend'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, FSUSBLOG_BACKEND_TRX_DIR: trxRoot }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.signal, null)
  assert.equal(result.stderr, '')
  assert.deepEqual(fs.readdirSync(trxRoot).sort(), [
    'backend-property.trx',
    'backend-unit.trx',
    'coverage-backend.trx'
  ])
  const manifest = JSON.parse(result.stdout.trim())
  assert.equal(manifest.schema, 'fsusblog.backend-trx-dry-run.v1')
  assert.equal(manifest.status, 'dry-run')
  assert.deepEqual(manifest.lanes, ['backend-unit', 'backend-property', 'coverage-backend'])

  for (const lane of manifest.lanes) {
    const trx = fs.readFileSync(path.join(trxRoot, `${lane}.trx`), 'utf8')
    assert.match(trx, /<TestRun\b/u)
    assert.match(trx, /<UnitTestResult testName="BackendTrxContractDryRun" outcome="Passed"/u)
    assert.match(trx, /<Counters total="1" executed="1" passed="1" failed="0"/u)
  }
})
