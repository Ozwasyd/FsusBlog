import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  hashResumeToken,
  normalizeQualificationArguments,
  parsePrivateEnvironmentFile
} from '../../tools/deployment/rehearsal-schema-qualification-probe.mjs'

test('qualification adapter accepts only explicit isolated operations and private environment input', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-schema-qualification-adapter-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const environment = path.join(directory, 'qualification.env')
  fs.writeFileSync(environment, 'DB_NAME=fsusblog_qualification\nDB_USER=fsusblog_test\n', { mode: 0o600 })

  const values = parsePrivateEnvironmentFile(environment)
  assert.equal(values.get('DB_NAME'), 'fsusblog_qualification')
  assert.equal(values.get('DB_USER'), 'fsusblog_test')
  assert.deepEqual(normalizeQualificationArguments([
    'checkpoint', '--database', 'migration-qualification-1031', '--env-file', environment,
    '--migration-id', '20260711-post-account-subject-hash-backfill'
  ]), {
    operation: 'checkpoint',
    database: 'migration-qualification-1031',
    'env-file': environment,
    'migration-id': '20260711-post-account-subject-hash-backfill'
  })
  assert.equal(normalizeQualificationArguments([
    'prepare-missing-expand', '--database', 'migration-qualification-1031', '--env-file', environment,
    '--migration-id', '20260711-pre-account-subject-hash-expand',
    '--contract-id', '20260629-post-audit-chain-tail-index'
  ]).operation, 'prepare-missing-expand')
  assert.match(hashResumeToken('secret-resume-token'), /^sha256:[0-9a-f]{64}$/u)
  assert.equal(hashResumeToken('secret-resume-token').includes('secret-resume-token'), false)
})

test('qualification adapter refuses production-like isolation ids, duplicate flags and weak file modes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-schema-qualification-boundary-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const environment = path.join(directory, 'qualification.env')
  fs.writeFileSync(environment, 'DB_NAME=unsafe\nDB_USER=unsafe\n', { mode: 0o644 })

  assert.throws(() => parsePrivateEnvironmentFile(environment), /mode 0400 or 0600/u)
  assert.throws(() => normalizeQualificationArguments([
    'checkpoint', '--database', 'production-primary', '--env-file', environment
  ]), /non-production/u)
  assert.throws(() => normalizeQualificationArguments([
    'checkpoint', '--database', 'qualification-1031', '--database', 'qualification-1032', '--env-file', environment
  ]), /duplicate argument/u)
})
