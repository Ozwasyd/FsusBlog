import assert from 'node:assert/strict'
import test from 'node:test'

import { integrityProofCommand } from '../../tools/integrity/proof-command.mjs'

test('local production integrity proof reuses the completed backend build', () => {
  const local = integrityProofCommand({ FSUSBLOG_LOCAL_PROFILE: 'production' })
  const ordinary = integrityProofCommand({})

  assert.ok(local.includes('--no-build'))
  assert.ok(local.includes('--no-restore'))
  assert.equal(ordinary.includes('--no-build'), false)
  assert.equal(ordinary.includes('--no-restore'), false)
})
