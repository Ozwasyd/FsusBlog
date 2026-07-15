import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const laneSource = fs.readFileSync(path.join(repositoryRoot, 'tools/test/lanes/perception-v2-test-matrix.sh'), 'utf8')
const projectionSource = laneSource.match(/<<'NODE'\n([\s\S]*?)\nNODE/u)?.[1]
const runId = 'perception-union-fixture'
const canonicalTests = [
  'CommentCreateFlow_FailsClosedForWrongAnswerExpiredReplayAndBindingMismatch',
  'CommentCreateFlow_IssueRenderVerifyProofResume_WritesReleaseEvidence'
]

assert.ok(projectionSource, 'local Perception union projection source must be extractable')

function sha256(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function trx(outcomes = ['Passed', 'Passed']) {
  const definitions = canonicalTests.map((method, index) => `
    <UnitTest id="test-${index}">
      <TestMethod className="FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests" name="${method}" />
    </UnitTest>`).join('')
  const results = canonicalTests.map((method, index) => `
    <UnitTestResult testId="test-${index}" testName="${method}" outcome="${outcomes[index]}" />`).join('')
  return `<TestRun><TestDefinitions>${definitions}</TestDefinitions><Results>${results}</Results></TestRun>\n`
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-perception-union-'))
  const trxFile = path.join(root, '.tmp/test-results/backend/production/shard-0.trx')
  const summaryFile = path.join(root, '.tmp/test-results/backend/production/summary.json')
  const dll = path.join(root, 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll')
  fs.mkdirSync(path.dirname(trxFile), { recursive: true })
  fs.mkdirSync(path.dirname(dll), { recursive: true })
  fs.writeFileSync(trxFile, trx())
  fs.writeFileSync(dll, 'current backend test assembly')
  writeJson(summaryFile, {
    schema: 'fsusblog.backend-production-shards.v2',
    status: 'success',
    partitions: [{ id: 0, trx: '.tmp/test-results/backend/production/shard-0.trx' }],
    producer: { runId, sourceCommit: 'commit', sourceFingerprint: 'fingerprint' }
  })
  writeJson(path.join(root, `.tmp/test-runs/${runId}/backend-tests-ready.json`), {
    schema: 'fsusblog.local-production.backend-tests-ready.v1',
    status: 'success',
    schedulerRunId: runId,
    testDll: {
      path: 'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
      digest: `sha256:${'a'.repeat(64)}`,
      contentDigest: sha256(dll),
      artifactRef: `artifact:${'b'.repeat(64)}`
    }
  })
  return { root, trxFile, summaryFile, dll }
}

function project(root) {
  return spawnSync(process.execPath, ['--input-type=module', '-', root], {
    encoding: 'utf8',
    env: { ...process.env, FSUSBLOG_TEST_RUN_ID: runId },
    input: projectionSource
  })
}

test('Perception projection binds exact passed union results to run, DLL, summary and TRX digests', (t) => {
  const current = fixture()
  t.after(() => fs.rmSync(current.root, { recursive: true, force: true }))

  const result = project(current.root)
  assert.equal(result.status, 0, result.stderr)
  const projection = JSON.parse(fs.readFileSync(path.join(
    current.root,
    '.tmp/test-results/backend/production/perception-v2-union-projection.json'
  ), 'utf8'))
  assert.equal(projection.schema, 'fsusblog.perception-v2.union-projection.v1')
  assert.equal(projection.producer.runId, runId)
  assert.equal(projection.testDll.digest, sha256(current.dll))
  assert.equal(projection.unionSummary.digest, sha256(current.summaryFile))
  assert.deepEqual(projection.trxFiles, [{
    path: '.tmp/test-results/backend/production/shard-0.trx',
    digest: sha256(current.trxFile)
  }])
  assert.deepEqual(projection.tests.map(({ id, outcome }) => ({ id, outcome })), canonicalTests
    .map((method) => ({
      id: `FsusBlog.Server.Tests.Unit.PerceptionChallengeV2E2eTests.${method}`,
      outcome: 'Passed'
    }))
    .sort((left, right) => left.id.localeCompare(right.id)))
})

test('Perception projection fails closed for stale runs, DLL drift, empty matches and non-passing outcomes', (t) => {
  const cases = [
    ['stale run', (current) => {
      const summary = JSON.parse(fs.readFileSync(current.summaryFile, 'utf8'))
      summary.producer.runId = 'stale-run'
      writeJson(current.summaryFile, summary)
    }, /summary runId mismatch/u],
    ['DLL drift', (current) => fs.appendFileSync(current.dll, 'tampered'), /tests-ready marker is not bound/u],
    ['empty matches', (current) => fs.writeFileSync(current.trxFile, '<TestRun />\n'), /contains no PerceptionChallengeV2E2eTests/u],
    ['failed result', (current) => fs.writeFileSync(current.trxFile, trx(['Failed', 'Passed'])), /contains non-passing Perception results/u]
  ]

  for (const [name, mutate, expected] of cases) {
    const current = fixture()
    t.after(() => fs.rmSync(current.root, { recursive: true, force: true }))
    mutate(current)
    const result = project(current.root)
    assert.notEqual(result.status, 0, `${name} unexpectedly passed`)
    assert.match(result.stderr, expected)
  }
})
