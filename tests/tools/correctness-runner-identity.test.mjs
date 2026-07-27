import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runner = path.join(root, 'tools/test/run-deterministic-command.mjs')

function invoke({ args = [], env = {} } = {}) {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runner-')), 'spawned')
  const result = spawnSync(process.execPath, [runner,
    '--key', 'identity-contract',
    ...args,
    '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return { result, marker, spawned: fs.existsSync(marker) }
}

for (const [name, env] of [
  ['run ID', { FSUSBLOG_TEST_SOURCE_COMMIT: 'abc', FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'def' }],
  ['source commit', { FSUSBLOG_TEST_RUN_ID: 'run-1', FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'def' }],
  ['source fingerprint', { FSUSBLOG_TEST_RUN_ID: 'run-1', FSUSBLOG_TEST_SOURCE_COMMIT: 'abc' }],
  ['producer ID', { FSUSBLOG_TEST_RUN_ID: 'run-1', FSUSBLOG_TEST_SOURCE_COMMIT: 'abc', FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'def' }]
]) {
  test(`correctness missing ${name} rejects before child spawn`, () => {
    const args = ['--execution-class', 'correctness']
    if (name !== 'producer ID') args.push('--producer-id', 'identity-contract')
    const { result, spawned } = invoke({ args, env })
    assert.notEqual(result.status, 0)
    assert.equal(spawned, false)
    assert.match(result.stderr, /contract\.missing-run-identity/u)
  })
}

test('undeclared execution class rejects before child spawn', () => {
  const { result, spawned } = invoke({ env: { FSUSBLOG_TEST_RUN_ID: 'run-1' } })
  assert.notEqual(result.status, 0)
  assert.equal(spawned, false)
  assert.match(result.stderr, /contract\.missing-run-identity/u)
})

test('explicit diagnostic allows direct execution but is unqualified', () => {
  const { result, spawned } = invoke({ args: ['--execution-class', 'diagnostic'] })
  assert.equal(result.status, 0)
  assert.equal(spawned, true)
  assert.match(result.stdout, /qualificationEligible=false/u)
})

test('diagnostic cannot emit a correctness projection', () => {
  const { result, spawned } = invoke({ args: ['--execution-class', 'diagnostic', '--projection-directory', '.tmp/identity-contract'] })
  assert.notEqual(result.status, 0)
  assert.equal(spawned, false)
  assert.match(result.stderr, /cannot publish a correctness projection/u)
})

test('correctness does not derive a local or timestamp run identity', () => {
  const { result, spawned } = invoke({
    args: ['--execution-class', 'correctness', '--producer-id', 'identity-contract'],
    env: { FSUSBLOG_TEST_SOURCE_COMMIT: 'abc', FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'def', FSUSBLOG_TEST_NAMESPACE: 'local' }
  })
  assert.notEqual(result.status, 0)
  assert.equal(spawned, false)
  assert.match(result.stderr, /schedulerRunId/u)
})
