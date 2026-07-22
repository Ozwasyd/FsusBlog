import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditCompactRetentionRecords,
  auditRetentionRecords,
  buildChildIssueStatusEvidence,
  expandPathReplacementPlan,
  mergeReplacementEntries,
  scanBackendSourceLocking,
  validateReplacementChainAuthority,
  validateAfterSnapshotAuthority,
  validateChildIssueStatusEvidence,
  validateConvergencePlan,
  validateEvidenceContract,
  verifySourceLockingFixtures
} from '../../tools/test-convergence/audit.mjs'
import { compactRetentionBaseline } from '../../tools/test-retention/audit.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('matrix is the single current command and retention governance authority', () => {
  const matrix = parseMatrix(readFileSync(resolve(root, 'tests/matrix.yml'), 'utf8'))
  assert.equal(matrix.commandGroups['frontend-static-governance'].commands.length, 43)
  assert.equal(matrix.commandGroups['frontend-runtime-contracts'].commands.length, 7)
  assert.equal(matrix.governance.retention.replacementLedger, 'tests/test-retention-replacements.json')
  assert.deepEqual(matrix.governance.retention.postBaselines, ['tests/issue-1146-acceptance-baseline.json'])
  assert.equal(matrix.governance.retention.automaticDeletion, false)
  for (const retiredPath of [
    'tests/frontend/checks/static/manifest.json',
    'tests/frontend/checks/runtime/manifest.json',
    'tests/issue-1051-suite-convergence.json',
    'tests/frontend/checks/static/frontend-source-locking-migration-plan.mjs',
    'tests/issue-1146-retention-replacements.json'
  ]) {
    assert.equal(existsSync(resolve(root, retiredPath)), false, `${retiredPath} must stay retired`)
  }
})

test('backend source-locking owner accepts runtime artifacts and rejects production docs and test source', () => {
  const positive = readFileSync(
    resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-positive.fixture.cs.txt'),
    'utf8'
  )
  const negative = readFileSync(
    resolve(root, 'tests/tools/fixtures/test-suite-convergence/backend-source-lock-negative.fixture.cs.txt'),
    'utf8'
  )

  const audit = verifySourceLockingFixtures(positive, negative)

  assert.deepEqual(audit.errors, [])
  assert.equal(audit.positive.length, 0)
  assert.deepEqual(
    new Set(audit.negative.map((violation) => violation.rule)),
    new Set([
      'production-source-read',
      'documentation-source-read',
      'test-source-read',
      'source-reader-helper',
      'generic-repo-source-reader'
    ])
  )
})

test('backend source-locking owner does not mistake a temporary JSON artifact for repository source', () => {
  const source = `
    public void ReadsArtifact(string directory)
    {
        string json = File.ReadAllText(Path.Combine(directory, "summary.json"));
    }
  `

  assert.deepEqual(scanBackendSourceLocking(source, 'ArtifactBehaviorTests.cs'), [])
})

test('backend source-locking owner reconstructs segmented repository paths', () => {
  const source = `
    public void ReadsSource()
    {
        string text = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "backend",
            "Services",
            "ExampleService.cs"));
    }
  `

  const violations = scanBackendSourceLocking(source, 'SegmentedSourceTests.cs')

  assert.equal(violations.length, 1)
  assert.equal(violations[0].target, 'src/backend/Services/ExampleService.cs')
  assert.equal(violations[0].rule, 'production-source-read')
})

test('replacement merge accepts identical declarations and reports conflicting owners', () => {
  const base = {
    deletedTests: [{
      id: 'xunit:old#Old.Test',
      path: 'tests/backend/Unit/Old.cs',
      replacementTestIds: ['xunit:new#New.Test'],
      reason: 'behavior replacement'
    }]
  }
  const identical = structuredClone(base)
  const conflicting = structuredClone(base)
  conflicting.deletedTests[0].replacementTestIds = ['xunit:other#Other.Test']

  const clean = mergeReplacementEntries([
    { source: 'first.json', manifest: base },
    { source: 'second.json', manifest: identical }
  ])
  const conflict = mergeReplacementEntries([
    { source: 'first.json', manifest: base },
    { source: 'conflict.json', manifest: conflicting }
  ])

  assert.equal(clean.entries.length, 1)
  assert.deepEqual(clean.errors, [])
  assert.equal(conflict.conflicts.length, 1)
  assert.match(conflict.errors[0], /conflicting replacement declarations/u)
})

test('post-baseline replacements cannot introduce or retarget a deleted-ledger chain edge', () => {
  const historical = [{
    id: 'xunit:old#Old.A',
    path: 'tests/backend/Unit/Old.cs',
    replacementTestIds: ['xunit:old#Old.B']
  }, {
    id: 'xunit:old#Old.B',
    path: 'tests/backend/Unit/Old.cs',
    replacementTestIds: ['xunit:current#Current.Test']
  }]
  const authority = {
    edgeCount: 1,
    edgeSetSha256: 'd70448f45f8dbc973adfc8234581d6fdfe436fe4462eb872e50b249265ffed66'
  }

  assert.deepEqual(validateReplacementChainAuthority(historical, authority).errors, [])

  const appendedChain = [...historical, {
    id: 'xunit:newer#Newer.C',
    path: 'tests/backend/Unit/Newer.cs',
    replacementTestIds: ['xunit:old#Old.B']
  }]
  assert.match(
    validateReplacementChainAuthority(appendedChain, authority).errors[0],
    /outside the frozen historical chain authority/u
  )

  const coordinatedRetarget = structuredClone(historical)
  coordinatedRetarget[0].replacementTestIds = ['xunit:newer#Newer.C']
  coordinatedRetarget.push({
    id: 'xunit:newer#Newer.C',
    path: 'tests/backend/Unit/Newer.cs',
    replacementTestIds: ['xunit:current#Current.Test']
  })
  assert.match(
    validateReplacementChainAuthority(coordinatedRetarget, authority).errors[0],
    /outside the frozen historical chain authority/u
  )
})

test('issue-local replacement manifest count is exact', () => {
  const merged = mergeReplacementEntries([{
    source: 'issue-1050.json',
    manifest: {
      expectedDeletedTestIds: 2,
      deletedTests: [{
        id: 'xunit:old#Old.Test',
        path: 'tests/backend/Unit/Old.cs',
        replacementTestIds: ['xunit:new#New.Test'],
        reason: 'replace source assertion with behavior'
      }]
    }
  }])

  assert.ok(merged.errors.some((error) => error.includes('expectedDeletedTestIds is 2, found 1')))
})

test('retention audit reports every undeclared deletion and missing replacement target in one pass', () => {
  const beforeRecords = [
    { id: 'xunit:old#Old.One', path: 'tests/backend/Unit/Old.cs' },
    { id: 'xunit:old#Old.Two', path: 'tests/backend/Unit/Old.cs' },
    { id: 'xunit:keep#Keep.Test', path: 'tests/backend/Unit/Keep.cs' }
  ]
  const afterRecords = [
    { id: 'xunit:keep#Keep.Test', path: 'tests/backend/Unit/Keep.cs' },
    { id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }
  ]
  const replacements = [{
    id: 'xunit:old#Old.One',
    path: 'tests/backend/Unit/Old.cs',
    replacementTestIds: ['xunit:missing#Missing.Test'],
    source: 'issue.json'
  }]

  const audit = auditRetentionRecords({ beforeRecords, afterRecords, replacements })

  assert.deepEqual(audit.missingDeletionMappings, [
    { id: 'xunit:old#Old.Two', path: 'tests/backend/Unit/Old.cs' }
  ])
  assert.deepEqual(audit.missingReplacementTargets, [{
    deletedTestId: 'xunit:old#Old.One',
    replacementTestId: 'xunit:missing#Missing.Test'
  }])
  assert.equal(audit.errors.length, 2)
})

test('retention audit accepts a declared deletion whose replacement exists after convergence', () => {
  const beforeRecords = [{ id: 'xunit:old#Old.Test', path: 'tests/backend/Unit/Old.cs' }]
  const afterRecords = [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }]
  const replacements = [{
    id: 'xunit:old#Old.Test',
    path: 'tests/backend/Unit/Old.cs',
    replacementTestIds: ['xunit:new#New.Test'],
    source: 'issue.json'
  }]

  const audit = auditRetentionRecords({ beforeRecords, afterRecords, replacements })

  assert.deepEqual(audit.errors, [])
  assert.equal(audit.deletedRecords.length, 1)
})

test('compact retention audit resolves hashed deletions, replacement targets, and path bindings', () => {
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  const beforeSnapshot = compactRetentionBaseline({
    schema: 'fsusblog.test-retention-audit.v2',
    sourceState,
    testRecords: [{
      id: 'xunit:old#Old.Test',
      path: 'tests/backend/Unit/Old.cs',
      framework: 'xunit',
      assertionTargets: ['Assert.Equal(expected, actual)'],
      coverageIds: ['contract'],
      tierIds: ['backend-unit'],
      tierInvocationCount: 1,
      timing: { samples: 0, p50Ms: null, p95Ms: null },
      failureHistory: { runs: 0, failures: 0, lastFailureAt: null },
      riskTags: ['security']
    }],
    retainedEvidence: { coverageIds: ['contract'], testRecordCount: 1, uniqueAssertionTargetCount: 1 },
    catalogSnapshot: {
      matrixTierIds: ['backend-unit'],
      productionRequiredTierIds: ['backend-unit'],
      matrixArtifactPaths: [],
      matrixEvidencePaths: [],
      coverageIds: ['contract'],
      requirementIds: [],
      releaseEvidencePaths: [],
      sourceDigests: {}
    },
    replacementManifestBaseline: {
      deletedTestIds: [],
      assertionBeforeTargets: [],
      tierFromIds: []
    }
  }, {
    optimizationEvidence: {
      coverage: {
        backend: { summary: { linecoverage: 80, branchcoverage: 60 } },
        frontend: { summary: { linecoverage: 70, branchcoverage: 50 } },
        merged: { summary: { linecoverage: 75, branchcoverage: 55 } }
      },
      criticalMutationSlice: {
        evidenceMode: 'scope-identity',
        testIds: ['xunit:old#Old.Test'],
        scopeIds: ['release-mutation-critical-slice']
      }
    }
  })
  const replacement = {
    id: 'xunit:old#Old.Test',
    path: 'tests/backend/Unit/Old.cs',
    replacementTestIds: ['xunit:new#New.Test'],
    source: 'issue.json'
  }

  const accepted = auditCompactRetentionRecords({
    beforeSnapshot,
    afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
    replacements: [replacement]
  })
  const wrongPath = auditCompactRetentionRecords({
    beforeSnapshot,
    afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
    replacements: [{ ...replacement, path: 'tests/backend/Unit/Wrong.cs' }]
  })
  const postBaseline = {
    id: 'xunit:post-baseline#PostBaseline.Removed',
    path: 'tests/backend/Unit/PostBaseline.cs',
    replacementTestIds: ['xunit:new#New.Test'],
    source: 'issue-post-baseline.json'
  }
  const acceptedPostBaseline = auditCompactRetentionRecords({
    beforeSnapshot,
    afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
    replacements: [replacement, postBaseline],
    postBaselineDeletionIds: [postBaseline.id]
  })
  const rejectedUnknown = auditCompactRetentionRecords({
    beforeSnapshot,
    afterRecords: [{ id: 'xunit:new#New.Test', path: 'tests/backend/Unit/New.cs' }],
    replacements: [replacement, postBaseline]
  })

  assert.deepEqual(accepted.errors, [])
  assert.equal(accepted.deletedRecords.length, 1)
  assert.equal(wrongPath.mismatchedDeletionPaths.length, 1)
  assert.deepEqual(acceptedPostBaseline.unknownDeletionDeclarations, [])
  assert.deepEqual(rejectedUnknown.unknownDeletionDeclarations, [{
    id: postBaseline.id,
    source: postBaseline.source
  }])
})

test('retention audit inherits pre-baseline declarations but rejects a wrong baseline path', () => {
  const beforeRecords = [{ id: 'xunit:old#Old.Test', path: 'tests/backend/Unit/Old.cs' }]
  const replacements = [
    {
      id: 'xunit:old#Old.Test',
      path: 'tests/backend/Unit/Wrong.cs',
      replacementTestIds: ['xunit:new#New.Test'],
      source: 'issue.json'
    },
    {
      id: 'vitest:prebaseline#removed',
      path: 'tests/frontend/unit/Removed.test.ts',
      replacementTestIds: ['vitest:new#behavior'],
      source: 'baseline.json'
    }
  ]

  const audit = auditRetentionRecords({
    beforeRecords,
    replacements,
    preBaselineDeletionIds: ['vitest:prebaseline#removed']
  })

  assert.deepEqual(audit.unknownDeletionDeclarations, [])
  assert.deepEqual(audit.mismatchedDeletionPaths, [{
    id: 'xunit:old#Old.Test',
    declaredPath: 'tests/backend/Unit/Wrong.cs',
    baselinePath: 'tests/backend/Unit/Old.cs',
    source: 'issue.json'
  }])
})

test('final after snapshot must be independently run-bound and source-bound', () => {
  const before = {
    sourceState: {
      commit: '1'.repeat(40),
      worktreeFingerprint: '2'.repeat(64)
    }
  }
  const valid = {
    schema: 'fsusblog.test-retention-audit.v2',
    generatedAt: '2026-07-11T00:00:00.000Z',
    sourceState: {
      commit: '3'.repeat(40),
      worktreeFingerprint: '4'.repeat(64)
    },
    producer: {
      runId: 'production-fresh-20260711',
      generatedAt: '2026-07-11T00:00:00.000Z',
      sourceState: {
        commit: '3'.repeat(40),
        worktreeFingerprint: '4'.repeat(64)
      }
    }
  }
  const stale = structuredClone(valid)
  stale.snapshotRole = 'before-test-reduction'
  stale.sourceState = structuredClone(before.sourceState)
  stale.producer.sourceState = structuredClone(before.sourceState)
  stale.producer.runId = ''

  assert.deepEqual(validateAfterSnapshotAuthority(before, valid, { required: true }), [])
  const errors = validateAfterSnapshotAuthority(before, stale, { required: true })
  assert.ok(errors.some((error) => error.includes('cannot reuse')))
  assert.ok(errors.some((error) => error.includes('run id is missing')))
  assert.ok(errors.some((error) => error.includes('before source state')))
  assert.deepEqual(validateAfterSnapshotAuthority(before, null), [])
  assert.deepEqual(
    validateAfterSnapshotAuthority(before, null, { required: true }),
    ['final convergence requires an after retention snapshot']
  )
})

test('final evidence contracts report every invalid status field', () => {
  const errors = validateEvidenceContract(
    {
      schema: 'wrong.schema',
      status: 'blocked',
      producer: { runId: '' },
      summary: { linecoverage: 'not-a-number' }
    },
    {
      path: 'evidence.json',
      assertions: [
        { field: 'schema', equals: 'expected.schema' },
        { field: 'status', oneOf: ['ok', 'success'] },
        { field: 'producer.runId', nonEmpty: true },
        { field: 'summary.linecoverage', finiteNumber: true }
      ]
    }
  )

  assert.equal(errors.length, 4)
  assert.ok(errors.every((error) => error.startsWith('evidence.json:')))
})

test('child issue evidence requires the exact closed #1032 through #1050 set', () => {
  const issues = Array.from({ length: 19 }, (_, index) => ({
    number: 1032 + index,
    state: 'closed',
    closed_at: '2026-07-11T01:00:00.000Z',
    html_url: `https://github.com/example/repo/issues/${1032 + index}`
  }))
  const closed = buildChildIssueStatusEvidence(issues, {
    repository: 'example/repo',
    capturedAt: '2026-07-11T02:00:00.000Z'
  })
  const blocked = buildChildIssueStatusEvidence(
    issues.filter((issue) => issue.number !== 1040).map((issue) => (
      issue.number === 1041 ? { ...issue, state: 'open', closed_at: null } : issue
    )),
    { repository: 'example/repo', capturedAt: '2026-07-11T02:00:00.000Z' }
  )

  assert.equal(closed.status, 'closed')
  assert.deepEqual(validateChildIssueStatusEvidence(closed), [])
  const errors = validateChildIssueStatusEvidence(blocked)
  assert.ok(errors.some((error) => error.includes('every issue')))
  assert.ok(errors.some((error) => error.includes('#1041 is not closed')))
  assert.ok(errors.some((error) => error.includes('#1041 has no valid closedAt')))
})

test('path migration expansion emits every exact baseline test ID', () => {
  const beforeRecords = [
    { id: 'vitest:old#one', path: 'tests/frontend/unit/old.test.ts' },
    { id: 'vitest:old#two', path: 'tests/frontend/unit/old.test.ts' },
    { id: 'vitest:mixed#source-only', path: 'tests/frontend/unit/mixed.test.ts' }
  ]
  const expanded = expandPathReplacementPlan(beforeRecords, {
    replacementOwners: { behavior: ['vitest:new#behavior'] },
    wholeFileMigrations: [{
      path: 'tests/frontend/unit/old.test.ts',
      expectedRecords: 2,
      replacementOwner: 'behavior'
    }],
    selectiveTestMigrations: [{
      deletedTestId: 'vitest:mixed#source-only',
      replacementOwner: 'behavior'
    }]
  })

  assert.deepEqual(expanded.errors, [])
  assert.deepEqual(expanded.entries.map((entry) => entry.id), [
    'vitest:old#one',
    'vitest:old#two',
    'vitest:mixed#source-only'
  ])
  assert.ok(expanded.entries.every((entry) => entry.replacementTestIds[0] === 'vitest:new#behavior'))
})

test('convergence plan enforces all child issues exactly once and only earlier dependencies', () => {
  const validPlan = {
    trackingIssue: 1051,
    finalEvidencePaths: [],
    finalEvidenceContracts: [],
    sourceLockingOwners: {
      backend: 'tools/check-test-suite-convergence.mjs',
      frontend: 'tests/frontend/checks/static/check-frontend-test-governance.mjs'
    },
    stages: [
      { order: 0, issues: [1032] },
      { order: 1, issues: [1033, 1034, 1035, 1036] },
      { order: 2, issues: [1037, 1038, 1039, 1040, 1041, 1042] },
      { order: 3, issues: [1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050] }
    ],
    issueDependencies: {
      1033: [1032],
      1043: [1037],
      1051: Array.from({ length: 19 }, (_, index) => 1032 + index)
    }
  }
  const invalidPlan = structuredClone(validPlan)
  invalidPlan.stages[3].issues = invalidPlan.stages[3].issues.filter((issue) => issue !== 1050)
  invalidPlan.issueDependencies[1043] = [1049]
  invalidPlan.issueDependencies[1051] = invalidPlan.issueDependencies[1051].filter((issue) => issue !== 1050)

  assert.deepEqual(validateConvergencePlan(validPlan), [])
  assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('misses issue #1050')))
  assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('non-earlier issue #1049')))
  assert.ok(validateConvergencePlan(invalidPlan).some((error) => error.includes('must depend on every issue')))
})
