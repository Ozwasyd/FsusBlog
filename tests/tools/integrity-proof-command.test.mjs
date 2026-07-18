import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { integrityProofCommand } from '../../tools/integrity/proof-command.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('local production integrity proof reuses the completed backend build', () => {
  const local = integrityProofCommand({ FSUSBLOG_LOCAL_PROFILE: 'production' })
  const ordinary = integrityProofCommand({})

  for (const command of [local, ordinary]) {
    assert.deepEqual(command.slice(0, 6), [
      'test',
      'tests/backend/FsusBlog.Server.Tests.csproj',
      '--configuration',
      'Debug',
      '--no-build',
      '--no-restore'
    ])
    assert.equal(command.includes('Release'), false)
  }
})

test('integrity proof lane prepares the shared Debug producer before verification', () => {
  const lane = fs.readFileSync(path.join(root, 'tools/test/lanes/integrity-proof-verification.sh'), 'utf8')
  const producer = lane.indexOf('FSUSBLOG_BACKEND_TEST_CONFIGURATION=Debug EnsureBackendFilteredBuild')
  const verifier = lane.indexOf('verify-proof-fixtures.mjs')

  assert.match(lane, /source .*\/_legacy\.sh/u)
  assert.ok(producer >= 0, 'integrity proof lane must prepare the shared Debug build')
  assert.ok(verifier > producer, 'integrity proof verifier must run after the shared Debug producer')
})
