import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const checker = path.join(root, 'tools/ci/check-job-summaries.mjs')
const jobSchema = 'fsusblog.ci.job-result.v1'
const buildVerificationSchema = 'fsusblog.ci-production-build-verification.v1'
const stages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']

function validJobSummary(overrides = {}) {
  return {
    schema: jobSchema,
    jobId: 'frontend-static-governance',
    status: 'success',
    tierIds: ['frontend-static-governance'],
    localReproduction: './tools/test.sh frontend-static-governance',
    commit: 'a'.repeat(40),
    runId: '42',
    attempt: 1,
    artifacts: [],
    durationMs: 10,
    stageDurationsMs: Object.fromEntries(stages.map(stage => [stage, 0])),
    ...overrides
  }
}

function validBuildVerification(overrides = {}) {
  return {
    schema: buildVerificationSchema,
    status: 'success',
    receipt: 'receipt.json',
    receiptContentDigest: `sha256:${'b'.repeat(64)}`,
    sourceState: {
      commit: 'c'.repeat(40),
      worktreeFingerprint: 'd'.repeat(64)
    },
    producer: {
      workflow: 'Quality Gate',
      runId: '42',
      runAttempt: 1,
      job: 'production-build-artifacts'
    },
    toolchain: { node: 'v24', dotnet: '10' },
    expectedToolchain: null,
    inputCount: 24,
    inputsVerifiedAgainstCheckout: true,
    artifactCount: 100,
    artifactBytes: 2048,
    transferDurationMs: 50,
    verifiedAt: '2026-07-18T00:00:00.000Z',
    durationMs: 100,
    errors: [],
    materialized: ['backend/FsusBlog.Server.dll'],
    ...overrides
  }
}

function runChecker(t, documents) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-job-summary-check-'))
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
  const fixtureChecker = path.join(fixture, 'tools/ci/check-job-summaries.mjs')
  fs.mkdirSync(path.dirname(fixtureChecker), { recursive: true })
  fs.copyFileSync(checker, fixtureChecker)
  const jobs = path.join(fixture, '.tmp/release-evidence/jobs')
  fs.mkdirSync(jobs, { recursive: true })
  documents.forEach((document, index) => {
    fs.writeFileSync(path.join(jobs, `evidence-${index}.json`), `${JSON.stringify(document, null, 2)}\n`)
  })
  return spawnSync(process.execPath, [fixtureChecker], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 10_000
  })
}

test('job summary checker validates only job-result records and classifies legal colocated evidence', t => {
  const result = runChecker(t, [validJobSummary(), validBuildVerification()])

  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /summaries=1 auxiliary=1/u)
  assert.match(result.stdout, /fsusblog\.ci-production-build-verification\.v1:1/u)
})

test('job summary checker fails closed for unknown or lookalike schemas', async t => {
  await t.test('unknown schema', subtest => {
    const result = runChecker(subtest, [{ schema: 'fsusblog.unknown-evidence.v1', status: 'success' }])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unsupported evidence schema in job summary directory/u)
  })

  await t.test('job schema lookalike', subtest => {
    const result = runChecker(subtest, [validJobSummary({ schema: 'fsusblog.ci.job-result.v1-copy' })])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /unsupported evidence schema in job summary directory/u)
  })

  await t.test('missing schema', subtest => {
    const { schema: _schema, ...document } = validJobSummary()
    const result = runChecker(subtest, [document])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /schema is required/u)
  })
})

test('known auxiliary schema is not job-summary validated and cannot masquerade as one', async t => {
  await t.test('auxiliary fields remain owned by their producer contract', subtest => {
    const result = runChecker(subtest, [{ schema: buildVerificationSchema, status: 'failure', errors: ['fixture'] }])
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /summaries=0 auxiliary=1/u)
  })

  await t.test('job identity fields on auxiliary evidence', subtest => {
    const result = runChecker(subtest, [validBuildVerification({
      jobId: 'frontend-static-governance',
      tierIds: ['frontend-static-governance']
    })])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot declare job summary field jobId/u)
    assert.match(result.stderr, /cannot declare job summary field tierIds/u)
  })
})
