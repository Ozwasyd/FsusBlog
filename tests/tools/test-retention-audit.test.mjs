import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  auditTestRecords,
  compactRetentionBaseline,
  extractTestRecords,
  inferTierIdsForFile,
  isTestInventoryPath,
  normalizeReplacementManifest,
  percentile,
  reviewCandidateFiles,
  retentionSourceState,
  vitestHistoryEntries,
  vitestTestId,
  xunitMethodHistoryId,
  xunitTrxHistoryEntries
} from '../../tools/test-retention/audit.mjs'

test('full repository inventory includes node test suites outside frontend and backend folders', () => {
  assert.equal(isTestInventoryPath('tests/tools/test-matrix-scheduler.test.mjs'), true)
  assert.equal(isTestInventoryPath('tests/security/privacy-zk-prod-smoke.test.mjs'), true)
  assert.equal(isTestInventoryPath('tests/frontend/e2e/ux/viewport-boundaries.spec.ts'), true)
  assert.equal(isTestInventoryPath('docs/testing.md'), false)
})

test('tier invocation inference accounts for ordinary, coverage, specialized, and viewport lanes', () => {
  assert.deepEqual(
    inferTierIdsForFile('tests/frontend/unit/api/article.test.ts', ''),
    ['coverage-frontend', 'frontend-unit-shard']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/frontend/property/aeds.property.test.ts', ''),
    ['frontend-property-model-perf']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Integration/SchemaMigrationIntegrationTests.cs', '[Trait("Category", "Integration")]'),
    ['integration']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/BackendConcurrencyModelTests.cs', '[Trait("Category", "Concurrency")]'),
    ['backend-concurrency', 'backend-nightly']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/BackendPropertyTests.cs', '[Trait("Category", "Property")]'),
    ['backend-nightly', 'backend-property']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/BackendAuthStateMachineTests.cs', '[Trait("Category", "SecurityStateMachine")]'),
    ['backend-auth-state-machine', 'backend-nightly']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Integration/BackendApiContractTests.cs', '[Trait("Category", "ApiIntegration")]'),
    ['backend-api-integration', 'backend-nightly']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/BackendGoldenContractTests.cs', '[Trait("Category", "GoldenContract")]'),
    ['backend-golden', 'backend-nightly']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/NativeGroth16ZkProofBackendTests.cs', '[Trait("Category", "Performance")]'),
    ['backend-nightly', 'backend-perf']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/backend/Unit/ZkCommentV2CrossStackFixtureTests.cs', '[Trait("Category", "Performance")]'),
    ['privacy-zk-comment-matrix']
  )
  assert.deepEqual(
    inferTierIdsForFile('tests/frontend/e2e/ux/viewport-boundaries.spec.ts', ''),
    ['ux-viewport-boundaries', 'ux-viewport-smoke', 'ux-viewport-visual']
  )
})

test('extractTestRecords creates stable xUnit and Vitest test ids with assertion targets', () => {
  const xunit = extractTestRecords('tests/backend/Unit/ExampleTests.cs', `
public sealed class ExampleTests
{
    [Fact]
    public void RejectsEmptyToken() => Assert.Throws<InvalidOperationException>(() => Parse(""));
}
`)
  const vitest = extractTestRecords('tests/frontend/unit/example.test.ts', `
describe('token parser', () => {
  test('rejects empty token', () => {
    expect(() => parseToken('')).toThrow('empty')
  })
})
`)

  assert.equal(xunit[0].framework, 'xunit')
  assert.match(xunit[0].id, /^xunit:tests\/backend\/Unit\/ExampleTests\.cs#ExampleTests\.RejectsEmptyToken$/)
  assert.ok(xunit[0].assertionTargets.some((target) => target.includes('Throws')))
  assert.equal(vitest[0].framework, 'vitest')
  assert.match(vitest[0].id, /^vitest:tests\/frontend\/unit\/example\.test\.ts#rejects-empty-token-/)
  assert.equal(vitest[0].id, vitestTestId('tests/frontend/unit/example.test.ts', 'rejects empty token', 1))
  assert.ok(vitest[0].assertionTargets.some((target) => target.includes('toThrow')))
})

test('extractTestRecords retains every distinct assertion target in a large test body', () => {
  const assertions = Array.from({ length: 20 }, (_, index) => `expect(subject.value${index}).toBe(${index})`).join('\n')
  const [record] = extractTestRecords(
    'tests/frontend/unit/large-contract.test.ts',
    `test('checks the complete contract', () => {\n${assertions}\n})`
  )

  assert.equal(record.assertionTargets.length, 20)
  assert.ok(record.assertionTargets.some((target) => target.includes('subject.value19')))
})

test('extractTestRecords gives xUnit collection and fixture support files auditable test ids', () => {
  const records = extractTestRecords('tests/backend/Fixtures/PostgresCollection.cs', `
[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
`)

  assert.equal(records.length, 1)
  assert.equal(records[0].id, 'xunit-support:tests/backend/Fixtures/PostgresCollection.cs')
  assert.equal(records[0].framework, 'xunit-support')
  assert.deepEqual(records[0].assertionTargets, ['behavior:PostgresCollection.cs'])
})

test('risk classification scans the full test body before permitting replacement', () => {
  const records = extractTestRecords('tests/frontend/unit/example.test.ts', `
test('neutral title', () => {
  const padding = '${'x'.repeat(2500)}'
  expect(padding.length).toBeGreaterThan(0)
  expect(permission).toBeDenied()
})
`)

  assert.ok(records[0].riskTags.includes('security'))
})

test('vitestHistoryEntries maps JSON reporter assertions to stable test ids', () => {
  const history = vitestHistoryEntries('/repo', {
    testResults: [{
      name: '/repo/tests/frontend/unit/example.test.ts',
      assertionResults: [
        { title: 'rejects empty token', status: 'failed', duration: 12.5 },
        { title: 'accepts signed token', status: 'passed', duration: 4 }
      ]
    }]
  })

  assert.deepEqual(history, [
    {
      id: vitestTestId('tests/frontend/unit/example.test.ts', 'rejects empty token', 1),
      path: 'tests/frontend/unit/example.test.ts',
      durationMs: 12.5,
      failed: true
    },
    {
      id: vitestTestId('tests/frontend/unit/example.test.ts', 'accepts signed token', 1),
      path: 'tests/frontend/unit/example.test.ts',
      durationMs: 4,
      failed: false
    }
  ])
})

test('xunitTrxHistoryEntries maps UnitTestResult rows to stable Class.Method ids', () => {
  const history = xunitTrxHistoryEntries(`<?xml version="1.0" encoding="utf-8"?>
<TestRun>
  <Results>
    <UnitTestResult testId="failed-id" testName="display value" outcome="Failed" duration="00:00:01.2505000" endTime="2026-07-10T04:05:06.0000000Z" />
    <UnitTestResult testId="passed-id" testName="fallback name" outcome="Passed" duration="00:00:00.0040000" />
  </Results>
  <TestDefinitions>
    <UnitTest name="display value" id="failed-id">
      <TestMethod className="FsusBlog.Server.Tests.Unit.ExampleTests" name="RejectsEmptyToken" />
    </UnitTest>
    <UnitTest name="fallback name" id="passed-id">
      <TestMethod className="FsusBlog.Server.Tests.Unit.OuterTests+NestedTests" name="AcceptsSignedToken" />
    </UnitTest>
  </TestDefinitions>
</TestRun>`)

  assert.deepEqual(history, [
    {
      id: xunitMethodHistoryId('FsusBlog.Server.Tests.Unit.ExampleTests', 'RejectsEmptyToken'),
      durationMs: 1250.5,
      failed: true,
      at: '2026-07-10T04:05:06.0000000Z'
    },
    {
      id: xunitMethodHistoryId('FsusBlog.Server.Tests.Unit.OuterTests+NestedTests', 'AcceptsSignedToken'),
      durationMs: 4,
      failed: false,
      at: null
    }
  ])
})

test('auditTestRecords folds xUnit method history into p50, p95, and failure history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-xunit-history-'))
  const file = 'tests/backend/Unit/ExampleTests.cs'
  await mkdir(path.join(root, path.dirname(file)), { recursive: true })
  await writeFile(path.join(root, file), `
public sealed class ExampleTests
{
    [Fact]
    public void RejectsEmptyToken() => Assert.True(true);
}
`)
  const historyId = xunitMethodHistoryId('FsusBlog.Server.Tests.Unit.ExampleTests', 'RejectsEmptyToken')
  const records = await auditTestRecords({
    root,
    files: [file],
    fileMetadata: new Map([[file, { coverageIds: [], tierIds: ['backend-unit'] }]]),
    timingHistory: new Map([[historyId, [5, 15, 100]]]),
    failureHistory: new Map([[historyId, [
      { failed: false, at: '2026-07-08T00:00:00Z' },
      { failed: true, at: '2026-07-09T00:00:00Z' },
      { failed: false, at: '2026-07-10T00:00:00Z' }
    ]]])
  })

  assert.deepEqual(records[0].timing, { samples: 3, p50Ms: 15, p95Ms: 100 })
  assert.deepEqual(records[0].failureHistory, {
    runs: 3,
    failures: 1,
    lastFailureAt: '2026-07-09T00:00:00Z'
  })
})

test('retentionSourceState binds evidence to commit and excludes ignored .tmp files', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-source-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'retention@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Retention Test'], { cwd: repo })
  await writeFile(path.join(repo, '.gitignore'), '.tmp/\n')
  await writeFile(path.join(repo, 'tracked.txt'), 'tracked\n')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo })

  const clean = await retentionSourceState(repo)
  await mkdir(path.join(repo, '.tmp'), { recursive: true })
  await writeFile(path.join(repo, '.tmp/result.json'), '{}\n')
  const withIgnoredArtifact = await retentionSourceState(repo)

  assert.match(clean.commit, /^[0-9a-f]{40}$/u)
  assert.match(clean.worktreeFingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(withIgnoredArtifact, clean)
})

test('retention audit CLI records scheduler or explicit production run identity in producer metadata', () => {
  const output = `.tmp/test-retention-producer-${process.pid}-${Date.now()}.json`
  const baselineOutput = `.tmp/test-retention-before-${process.pid}-${Date.now()}.json`
  const environmentOutput = `.tmp/test-retention-producer-env-${process.pid}-${Date.now()}.json`
  try {
    execFileSync(process.execPath, [
      'tools/check-test-retention.mjs',
      '--out', output,
      '--run-id', 'production-final'
    ], {
      cwd: path.resolve('.'),
      env: { ...process.env, FSUSBLOG_TEST_RUN_ID: 'ignored-environment-run' },
      encoding: 'utf8'
    })
    const audit = JSON.parse(readFileSync(output, 'utf8'))

    assert.equal(audit.producer.runId, 'production-final')
    assert.equal(audit.producer.generatedAt, audit.generatedAt)
    assert.deepEqual(audit.producer.sourceState, audit.sourceState)
    assert.match(audit.producer.sourceState.commit, /^[0-9a-f]{40}$/u)
    assert.match(audit.producer.sourceState.worktreeFingerprint, /^[0-9a-f]{64}$/u)
    assert.ok(audit.catalogSnapshot.matrixTierIds.includes('production'))
    assert.ok(audit.catalogSnapshot.productionRequiredTierIds.includes('production'))
    assert.ok(audit.catalogSnapshot.productionRequiredTierIds.includes('static-governance'))
    assert.ok(audit.catalogSnapshot.matrixArtifactPaths.includes('.tmp/release-evidence'))
    assert.ok(audit.catalogSnapshot.matrixEvidencePaths.includes('.tmp/release-evidence/test-retention-audit.json'))
    assert.ok(audit.catalogSnapshot.requirementIds.includes('BACKEND-TRACEABILITY'))
    assert.ok(audit.catalogSnapshot.releaseEvidencePaths.some((item) => item.startsWith('.tmp/release-evidence')))

    const baseline = JSON.parse(readFileSync('tests/test-retention-before.json', 'utf8'))
    assert.equal(baseline.snapshotRole, 'before-test-reduction')
    assert.equal(baseline.sourceState.commit, 'df337d2bef3df65447637fc715e73a1436e76a5f')
    assert.match(baseline.sourceState.worktreeFingerprint, /^[0-9a-f]{64}$/u)
    assert.ok(baseline.catalogSnapshot.productionRequiredTierIds.includes('production'))
    assert.ok(baseline.testRecords.length > 0)
    assert.equal(baseline.files, undefined)
    assert.deepEqual(Object.keys(baseline.optimizationEvidence.coverage).sort(), ['backend', 'frontend', 'merged'])
    assert.equal(baseline.optimizationEvidence.criticalMutationSlice.evidenceMode, 'scope-identity')
    assert.ok(baseline.optimizationEvidence.criticalMutationSlice.testIds.length > 0)
    assert.equal(baseline.replacementManifestBaseline.deletedTestIds.length, 5)
    assert.equal(baseline.replacementManifestBaseline.assertionBeforeTargets.length, 10)

    assert.throws(() => execFileSync(process.execPath, [
      'tools/check-test-retention.mjs',
      '--out', baselineOutput,
      '--capture-before', baselineOutput,
      '--run-id', 'forged-after-deletion-before'
    ], {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }), (error) => {
      assert.match(String(error.stderr), /authoritative before snapshot already exists/u)
      return true
    })

    execFileSync(process.execPath, [
      'tools/check-test-retention.mjs',
      '--out', environmentOutput
    ], {
      cwd: path.resolve('.'),
      env: { ...process.env, FSUSBLOG_TEST_RUN_ID: 'scheduler-production-run' },
      encoding: 'utf8'
    })
    assert.equal(JSON.parse(readFileSync(environmentOutput, 'utf8')).producer.runId, 'scheduler-production-run')
  } finally {
    rmSync(output, { force: true })
    rmSync(baselineOutput, { force: true })
    rmSync(environmentOutput, { force: true })
  }
})

test('compact before snapshot preserves deletion evidence and rejects an unbound audit', () => {
  const sourceState = {
    commit: 'a'.repeat(40),
    worktreeFingerprint: 'b'.repeat(64)
  }
  const audit = {
    schema: 'fsusblog.test-retention-audit.v2',
    generatedAt: '2026-07-10T03:00:01.000Z',
    sourceState,
    producer: { runId: 'before-run', generatedAt: '2026-07-10T03:00:01.000Z', sourceState },
    policy: { automaticDeletion: false },
    files: [{ path: 'tests/example.test.mjs' }],
    testRecords: [{
      id: 'node-test:tests/example.test.mjs#keeps-contract',
      path: 'tests/example.test.mjs',
      framework: 'node-test',
      assertionTargets: ['assert.equal(value, 1)'],
      coverageIds: ['contract-id'],
      tierIds: ['static-governance'],
      invocationCount: 1,
      tierInvocationCount: 1,
      timing: { samples: 2, p50Ms: 4, p95Ms: 6 },
      failureHistory: { runs: 2, failures: 0, lastFailureAt: null },
      riskTags: ['release'],
      replacementTestIds: [],
      uniqueEvidence: true,
      equivalentTo: null
    }],
    retainedEvidence: { coverageIds: ['contract-id'], testRecordCount: 1, uniqueAssertionTargetCount: 1 },
    deletedTests: [{ id: 'historically-deleted-test' }],
    assertionReplacements: [{ before: 'historical assertion' }],
    tierReplacements: [{ from: 'historical-tier' }],
    catalogSnapshot: {
      matrixTierIds: ['static-governance'],
      productionRequiredTierIds: ['static-governance'],
      matrixArtifactPaths: ['.tmp/release-evidence/test-retention-audit.json'],
      matrixEvidencePaths: ['.tmp/release-evidence/test-retention-audit.json'],
      coverageIds: ['contract-id'],
      requirementIds: ['BACKEND-TRACEABILITY'],
      releaseEvidencePaths: ['.tmp/release-evidence/test-retention-audit.json'],
      sourceDigests: { matrix: 'sha256:matrix' }
    }
  }
  const optimizationEvidence = {
    coverage: {
      backend: { summary: { linecoverage: 80, branchcoverage: 60 } },
      frontend: { summary: { linecoverage: 70, branchcoverage: 50 } },
      merged: { summary: { linecoverage: 75, branchcoverage: 55 } }
    },
    criticalMutationSlice: {
      evidenceMode: 'scope-identity',
      testIds: ['node-test:tests/example.test.mjs#keeps-contract'],
      scopeIds: ['release-mutation-critical-slice']
    }
  }

  const baseline = compactRetentionBaseline(audit, { optimizationEvidence })

  assert.equal(baseline.snapshotRole, 'before-test-reduction')
  assert.deepEqual(baseline.sourceState, sourceState)
  assert.deepEqual(baseline.testRecords, audit.testRecords)
  assert.deepEqual(baseline.catalogSnapshot, audit.catalogSnapshot)
  assert.deepEqual(baseline.optimizationEvidence, optimizationEvidence)
  assert.deepEqual(baseline.replacementManifestBaseline, {
    deletedTestIds: ['historically-deleted-test'],
    assertionBeforeTargets: ['historical assertion'],
    tierFromIds: ['historical-tier']
  })
  assert.equal(baseline.files, undefined)
  assert.throws(
    () => compactRetentionBaseline({ ...audit, sourceState: null }, { optimizationEvidence }),
    /source state/u
  )
})

test('percentile reports p50 and p95 from timing history', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([10, 20, 30, 40], 50), 20)
  assert.equal(percentile([10, 20, 30, 40], 95), 40)
})

test('reviewCandidateFiles retains unique evidence and only permits exact safe replacement', () => {
  const records = [
    {
      id: 'vitest:tests/frontend/unit/a.test.ts#unique-a',
      path: 'tests/frontend/unit/a.test.ts',
      framework: 'vitest',
      assertionTargets: ['expect(value).toBe(1)'],
      coverageIds: ['COV-A'],
      riskTags: [],
      uniqueEvidence: true
    },
    {
      id: 'vitest:tests/frontend/unit/b.test.ts#duplicate-b',
      path: 'tests/frontend/unit/b.test.ts',
      framework: 'vitest',
      assertionTargets: ['expect(value).toBe(1)'],
      coverageIds: ['COV-A'],
      riskTags: [],
      uniqueEvidence: false,
      equivalentTo: 'vitest:tests/frontend/unit/a.test.ts#unique-a'
    },
    {
      id: 'xunit:tests/backend/Unit/AuthTests.cs#AuthTests.Replay',
      path: 'tests/backend/Unit/AuthTests.cs',
      framework: 'xunit',
      assertionTargets: ['Assert.False(replay)'],
      coverageIds: ['AUTH'],
      riskTags: ['security'],
      uniqueEvidence: false,
      equivalentTo: 'xunit:tests/backend/Unit/OtherAuthTests.cs#OtherAuthTests.Replay'
    }
  ]

  const reviews = reviewCandidateFiles([
    'tests/frontend/unit/a.test.ts',
    'tests/frontend/unit/b.test.ts',
    'tests/backend/Unit/AuthTests.cs'
  ], records)

  assert.equal(reviews.find((item) => item.path.endsWith('/a.test.ts')).decision, 'retain')
  assert.equal(reviews.find((item) => item.path.endsWith('/b.test.ts')).decision, 'replaceable')
  assert.deepEqual(reviews.find((item) => item.path.endsWith('/b.test.ts')).replacementTestIds, [
    'vitest:tests/frontend/unit/a.test.ts#unique-a'
  ])
  assert.equal(reviews.find((item) => item.path.endsWith('/AuthTests.cs')).decision, 'retain')
  assert.deepEqual(
    Object.keys(reviews.find((item) => item.path.endsWith('/b.test.ts')).tests[0]).sort(),
    [
      'assertionTargets',
      'coverageIds',
      'failureHistory',
      'framework',
      'id',
      'replacementTestIds',
      'tierIds',
      'tierInvocationCount',
      'timing',
      'uniqueEvidence'
    ]
  )
})

test('auditTestRecords emits required timing, failure, coverage, invocation, and replacement fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-'))
  await mkdir(path.join(root, 'tests/frontend/unit'), { recursive: true })
  await writeFile(path.join(root, 'tests/frontend/unit/example.test.ts'), `
test('keeps protocol version', () => {
  expect(protocol.version).toBe(2)
})
`)

  const result = await auditTestRecords({
    root,
    files: ['tests/frontend/unit/example.test.ts'],
    fileMetadata: new Map([
      ['tests/frontend/unit/example.test.ts', {
        coverageIds: ['AEDS-V2'],
        tierIds: ['frontend-unit', 'coverage-frontend']
      }]
    ]),
    timingHistory: new Map(),
    failureHistory: new Map()
  })

  assert.equal(result.length, 1)
  assert.deepEqual(Object.keys(result[0]).sort(), [
    'assertionTargets',
    'coverageIds',
    'equivalentTo',
    'failureHistory',
    'framework',
    'id',
    'invocationCount',
    'path',
    'replacementTestIds',
    'riskTags',
    'tierIds',
    'tierInvocationCount',
    'timing',
    'uniqueEvidence'
  ])
  assert.deepEqual(result[0].timing, { samples: 0, p50Ms: null, p95Ms: null })
  assert.deepEqual(result[0].failureHistory, { runs: 0, failures: 0, lastFailureAt: null })
  assert.equal(result[0].invocationCount, 2)
  assert.equal(result[0].tierInvocationCount, 2)
})

test('xUnit tier invocation inference is per test method instead of the first trait in a file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-xunit-tier-'))
  await mkdir(path.join(root, 'tests/backend/Unit'), { recursive: true })
  const file = 'tests/backend/Unit/MixedCategoryTests.cs'
  await writeFile(path.join(root, file), `
public sealed class MixedCategoryTests
{
    [Fact]
    public void Ordinary() { Assert.True(true); }

    [Fact]
    [Trait("Category", "Concurrency")]
    public void Concurrent() { Assert.True(true); }
}
`)
  const records = await auditTestRecords({
    root,
    files: [file],
    fileMetadata: new Map([[file, { coverageIds: ['backend-unit'], tierIds: ['backend-concurrency'] }]]),
    timingHistory: new Map(),
    failureHistory: new Map()
  })

  assert.deepEqual(records.find((record) => record.id.endsWith('.Ordinary')).tierIds, ['backend-unit', 'coverage-backend'])
  assert.deepEqual(records.find((record) => record.id.endsWith('.Concurrent')).tierIds, ['backend-concurrency', 'backend-nightly'])
})

test('candidate replacement prefers retained evidence over a lexically earlier review candidate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-canonical-'))
  await mkdir(path.join(root, 'tests/frontend/unit'), { recursive: true })
  const body = `test('same behavior', () => { expect(value).toBe(1) })\n`
  await writeFile(path.join(root, 'tests/frontend/unit/a-candidate.test.ts'), body)
  await writeFile(path.join(root, 'tests/frontend/unit/z-protected.test.ts'), body)

  const records = await auditTestRecords({
    root,
    files: [
      'tests/frontend/unit/a-candidate.test.ts',
      'tests/frontend/unit/z-protected.test.ts'
    ],
    fileMetadata: new Map([
      ['tests/frontend/unit/a-candidate.test.ts', {
        coverageIds: ['COV-A'],
        tierIds: ['frontend-unit'],
        retentionClass: 'review-candidate'
      }],
      ['tests/frontend/unit/z-protected.test.ts', {
        coverageIds: ['COV-A'],
        tierIds: ['frontend-unit'],
        retentionClass: 'must-keep'
      }]
    ]),
    timingHistory: new Map(),
    failureHistory: new Map()
  })
  const reviews = reviewCandidateFiles(['tests/frontend/unit/a-candidate.test.ts'], records)

  assert.equal(reviews[0].decision, 'replaceable')
  assert.deepEqual(reviews[0].replacementTestIds, [records.find((item) => item.path.endsWith('z-protected.test.ts')).id])
  assert.equal(reviews[0].tests[0].uniqueEvidence, false)
})

test('semantic replacement does not collapse distinct URL assertions as line comments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-retention-url-'))
  await mkdir(path.join(root, 'tests/frontend/unit'), { recursive: true })
  await writeFile(path.join(root, 'tests/frontend/unit/a.test.ts'), `test('same name', () => { expect(url).toBe('https://a.example') })`)
  await writeFile(path.join(root, 'tests/frontend/unit/b.test.ts'), `test('same name', () => { expect(url).toBe('https://b.example') })`)
  const metadata = new Map([
    ['tests/frontend/unit/a.test.ts', { coverageIds: ['URL'], retentionClass: 'must-keep' }],
    ['tests/frontend/unit/b.test.ts', { coverageIds: ['URL'], retentionClass: 'review-candidate' }]
  ])
  const records = await auditTestRecords({
    root,
    files: [...metadata.keys()],
    fileMetadata: metadata,
    timingHistory: new Map(),
    failureHistory: new Map()
  })

  assert.equal(reviewCandidateFiles(['tests/frontend/unit/b.test.ts'], records)[0].decision, 'retain')
})

test('replacement manifest requires live replacement tests and assertion targets', () => {
  const currentRecords = [{
    id: 'replacement-test',
    assertionTargets: ['expect(newContract).toHold()'],
    tierIds: ['backend-concurrency'],
    coverageIds: ['backend-fault-race-readiness']
  }]
  const normalized = normalizeReplacementManifest({
    schema: 'fsusblog.test-retention-replacements.v1',
    deletedTests: [{
      id: 'old-test',
      path: 'old.test.ts',
      replacementTestIds: ['replacement-test'],
      reason: 'merged into the stronger contract test'
    }],
    assertionReplacements: [{
      before: 'expect(oldContract).toHold()',
      replacementTestIds: ['replacement-test'],
      after: ['expect(newContract).toHold()'],
      reason: 'contract was intentionally strengthened'
    }],
    tierReplacements: [{
      from: 'backend-chaos',
      to: 'backend-concurrency',
      coverageIds: ['backend-fault-race-readiness'],
      reason: 'the replacement executes the same race/fault selection'
    }]
  }, currentRecords)

  assert.equal(normalized.deletedTests[0].id, 'old-test')
  assert.equal(normalized.assertionReplacements[0].before, 'expect(oldContract).toHold()')
  assert.equal(normalized.tierReplacements[0].to, 'backend-concurrency')
  assert.throws(
    () => normalizeReplacementManifest({
      schema: 'fsusblog.test-retention-replacements.v1',
      tierReplacements: [{
        from: 'backend-chaos',
        to: 'missing-tier',
        coverageIds: ['backend-fault-race-readiness'],
        reason: 'invalid replacement'
      }]
    }, currentRecords),
    /missing replacement tier/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      schema: 'fsusblog.test-retention-replacements.v1',
      deletedTests: [{ id: 'old', path: 'old.test.ts', replacementTestIds: ['missing'], reason: 'nope' }]
    }, currentRecords),
    /missing replacement test/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      schema: 'fsusblog.test-retention-replacements.v1',
      assertionReplacements: [{
        before: 'old',
        replacementTestIds: ['replacement-test'],
        after: ['missing target'],
        reason: 'nope'
      }]
    }, currentRecords),
    /missing replacement assertion target/u
  )
  assert.throws(
    () => normalizeReplacementManifest({ schema: 'unknown', deletedTests: [] }, currentRecords),
    /replacement manifest schema/u
  )
})

test('tier replacement requires a live target and valid catalog mappings', () => {
  const currentRecords = [
    {
      id: 'boundary-test',
      assertionTargets: ['current boundary behavior remains executable'],
      tierIds: ['ux-viewport-boundaries'],
      coverageIds: ['ux-viewport-boundary']
    }
  ]
  const replacement = {
    from: 'retired-viewport-tier',
    to: 'ux-viewport-boundaries',
    scope: 'tier',
    coverageIds: ['ux-viewport-boundary'],
    catalogReplacements: {
      productionRequiredTierIds: [{
        from: 'retired-viewport-tier',
        to: 'ux-viewport-boundaries'
      }],
      coverageIds: [{
        from: 'retired-viewport-coverage',
        to: 'ux-viewport-boundary'
      }]
    },
    reason: 'current boundary behavior replaces the retired viewport tier'
  }
  const manifest = {
    schema: 'fsusblog.test-retention-replacements.v1',
    tierReplacements: [replacement]
  }

  const normalized = normalizeReplacementManifest(manifest, currentRecords)
  assert.equal(normalized.tierReplacements[0].scope, 'tier')

  assert.throws(
    () => normalizeReplacementManifest({
      ...manifest,
      tierReplacements: [{ ...replacement, scope: 'production-only' }]
    }, currentRecords),
    /unsupported replacement scope/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      ...manifest,
      tierReplacements: [{
        ...replacement,
        catalogReplacements: { coverageIds: [] }
      }]
    }, currentRecords),
    /must not be empty/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      ...manifest,
      tierReplacements: [{
        ...replacement,
        catalogReplacements: {
          coverageIds: [
            { from: 'retired-viewport-coverage', to: 'ux-viewport-boundary' },
            { from: 'retired-viewport-coverage', to: 'another-coverage-id' }
          ]
        }
      }]
    }, currentRecords),
    /source is duplicated/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      ...manifest,
      tierReplacements: [{
        ...replacement,
        to: 'missing-tier'
      }]
    }, currentRecords),
    /missing replacement tier/u
  )
  assert.throws(
    () => normalizeReplacementManifest({
      ...manifest,
      tierReplacements: [{ ...replacement, coverageIds: ['missing-coverage'] }]
    }, currentRecords),
    /missing coverage id/u
  )
})
