import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildLegacyRealDumpMembership,
  buildLegacyRealDumpOutcome,
  legacyRealDumpContract,
  parseLegacyRealDumpTrx,
  validateLegacyRealDumpPreflight,
  validateLegacyRealDumpRuntimeEvidence
} from '../../tools/test/legacy-real-dump-contract.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const sourceSha = '1'.repeat(40)
const postgresImage = 'postgres:18-alpine'
const postgresImageId = `sha256:${'2'.repeat(64)}`

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-real-dump-contract-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const dumpPath = path.join(directory, 'legacy.pgcustom')
  fs.writeFileSync(dumpPath, 'representative custom dump bytes')
  const dumpSha256 = crypto.createHash('sha256').update(fs.readFileSync(dumpPath)).digest('hex')
  return {
    dumpPath,
    dumpSha256,
    env: {
      FSUS_ENABLE_LEGACY_DUMP_TESTS: '1',
      FSUS_LEGACY_20260517_DUMP: dumpPath,
      FSUS_LEGACY_20260517_DUMP_SHA256: dumpSha256,
      FSUSBLOG_TEST_SOURCE_COMMIT: sourceSha,
      FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE: postgresImage,
      FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE_ID: postgresImageId
    }
  }
}

function runtimeEvidence(overrides = {}) {
  return {
    schema: 'fsusblog.legacy-20260517-real-dump-runtime-evidence.v1',
    producerId: legacyRealDumpContract.producerId,
    testId: legacyRealDumpContract.canonicalTestId,
    fullyQualifiedName: legacyRealDumpContract.fullyQualifiedName,
    sourceSha,
    dumpSha256: '3'.repeat(64),
    postgres: {
      imageReference: postgresImage,
      imageId: postgresImageId,
      serverVersion: '18.0'
    },
    restoreCompleted: true,
    migrationExecutionCount: 2,
    postconditionsVerified: true,
    legacyCounts: { Articles: 1 },
    ...overrides
  }
}

function trx(rows) {
  return `<?xml version="1.0"?><TestRun><Results>${rows.join('')}</Results><ResultSummary outcome="Completed"><Counters total="${rows.length}" executed="${rows.length}" /></ResultSummary></TestRun>`
}

function trxRow({ name = legacyRealDumpContract.fullyQualifiedName, outcome = 'Passed', evidence = runtimeEvidence() } = {}) {
  const output = evidence === null
    ? ''
    : `<Output><StdOut>${legacyRealDumpContract.runtimeEvidencePrefix}${JSON.stringify(evidence).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</StdOut></Output>`
  return `<UnitTestResult testName="${name}" outcome="${outcome}">${output}</UnitTestResult>`
}

test('ordinary integration is not-selected and the contract allows one dedicated owner', () => {
  assert.equal(buildLegacyRealDumpMembership('integration').result, 'not-selected')
  assert.equal(buildLegacyRealDumpMembership(legacyRealDumpContract.producerId).result, 'planned')
  assert.throws(() => buildLegacyRealDumpMembership('second-owner'), /unsupported/u)

  const suite = fs.readFileSync(path.join(root, 'tools/test/lanes/_suite-support.sh'), 'utf8')
  assert.match(suite, /Category=Integration&Fixture!=Legacy20260517RealDump/u)
})

test('preflight binds enable, readable dump, source, digest and PostgreSQL image identity', (t) => {
  const value = fixture(t)
  const identity = validateLegacyRealDumpPreflight({
    env: value.env,
    repositoryRoot: root,
    currentSourceSha: sourceSha,
    inspectImage: () => postgresImageId
  })
  assert.equal(identity.dumpSha256, value.dumpSha256)
  assert.equal(identity.sourceSha, sourceSha)
  assert.equal(identity.postgresImageId, postgresImageId)
})

test('preflight fails closed for missing enable, missing path, wrong file, and identity drift', (t) => {
  const value = fixture(t)
  const invoke = (env, inspectImage = () => postgresImageId, current = sourceSha, status = '') => () =>
    validateLegacyRealDumpPreflight({
      env,
      repositoryRoot: root,
      currentSourceSha: current,
      currentWorktreeStatus: status,
      inspectImage
    })

  assert.throws(invoke({ ...value.env, FSUS_ENABLE_LEGACY_DUMP_TESTS: '' }), /must equal 1/u)
  assert.throws(invoke({ ...value.env, FSUS_LEGACY_20260517_DUMP: path.join(path.dirname(value.dumpPath), 'missing') }), /missing or unreadable/u)
  assert.throws(invoke({ ...value.env, FSUS_LEGACY_20260517_DUMP: path.dirname(value.dumpPath) }), /regular file/u)
  assert.throws(invoke({ ...value.env, FSUS_LEGACY_20260517_DUMP_SHA256: '4'.repeat(64) }), /dump identity mismatch/u)
  assert.throws(invoke({ ...value.env, FSUSBLOG_TEST_SOURCE_COMMIT: '5'.repeat(40) }), /source SHA drifted/u)
  assert.throws(invoke(value.env, () => postgresImageId, sourceSha, ' M tracked.cs'), /clean tracked worktree/u)
  assert.throws(invoke(value.env, () => `sha256:${'6'.repeat(64)}`), /PostgreSQL image identity mismatch/u)
})

test('TRX requires one exact test and rejects a forged Passed row without execution evidence', () => {
  assert.throws(() => parseLegacyRealDumpTrx(trx([])), /exactly one/u)
  assert.throws(() => parseLegacyRealDumpTrx(trx([trxRow(), trxRow()])), /exactly one/u)
  assert.throws(
    () => parseLegacyRealDumpTrx(trx([trxRow({ name: 'FsusBlog.Server.Tests.Other.Test' })])),
    /unexpected test ID/u
  )
  assert.throws(() => parseLegacyRealDumpTrx(trx([trxRow({ evidence: null })])), /runtime evidence/u)
})

test('restore or migration failure remains an executed failed semantic outcome', () => {
  const parsed = parseLegacyRealDumpTrx(trx([trxRow({ outcome: 'Failed', evidence: null })]))
  const outcome = buildLegacyRealDumpOutcome({
    identity: { sourceSha, dumpSha256: '3'.repeat(64), postgresImage, postgresImageId },
    result: parsed
  })
  assert.deepEqual(outcome.execution.executedTestIds, [legacyRealDumpContract.canonicalTestId])
  assert.deepEqual(outcome.execution.failedTestIds, [legacyRealDumpContract.canonicalTestId])
  assert.equal(outcome.execution.outcome, 'failed')
})

test('Passed runtime evidence binds restore, two migrations, postconditions and all identities', () => {
  const expected = { sourceSha, dumpSha256: '3'.repeat(64), postgresImage, postgresImageId }
  assert.equal(validateLegacyRealDumpRuntimeEvidence(runtimeEvidence(), expected).migrationExecutionCount, 2)
  assert.throws(
    () => validateLegacyRealDumpRuntimeEvidence(runtimeEvidence({ migrationExecutionCount: 1 }), expected),
    /double-migration/u
  )
  assert.throws(
    () => validateLegacyRealDumpRuntimeEvidence(runtimeEvidence({ sourceSha: '7'.repeat(40) }), expected),
    /source SHA drifted/u
  )
  assert.throws(
    () => validateLegacyRealDumpRuntimeEvidence(runtimeEvidence({ dumpSha256: '8'.repeat(64) }), expected),
    /dump identity drifted/u
  )
  assert.throws(
    () => validateLegacyRealDumpRuntimeEvidence(runtimeEvidence({ postgres: { imageReference: postgresImage, imageId: postgresImageId, serverVersion: '' } }), expected),
    /PostgreSQL identity drifted/u
  )
})

test('the compatibility verifier delegates to the only dotnet producer', () => {
  const producer = fs.readFileSync(path.join(root, 'tools/test/run-legacy-real-dump-producer.mjs'), 'utf8')
  const verifier = fs.readFileSync(path.join(root, 'tools/db/verify-legacy-upgrade-20260517.sh'), 'utf8')
  assert.equal((producer.match(/'dotnet'/gu) ?? []).length, 1)
  assert.doesNotMatch(verifier, /dotnet test/u)
  assert.match(verifier, /node tools\/test\/run-legacy-real-dump-producer\.mjs/u)
})
