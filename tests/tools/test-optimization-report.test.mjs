import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildOptimizationSnapshot,
  buildOptimizationReport,
  renderOptimizationMarkdown
} from '../../tools/test/optimization-report.mjs'
import { snapshotGitWorktree } from '../../tools/test-matrix/scheduler.mjs'
import { compactRetentionBaseline } from '../../tools/test-retention/audit.mjs'

function emptyAudit() {
  const sourceState = { commit: 'a'.repeat(40), worktreeFingerprint: 'b'.repeat(64) }
  return {
    schema: 'fsusblog.test-retention-audit.v2',
    snapshotRole: 'before-test-reduction',
    generatedAt: '2026-07-10T03:00:01Z',
    sourceState,
    producer: {
      runId: 'production-fresh',
      generatedAt: '2026-07-10T03:00:01Z',
      sourceState
    },
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 },
    catalogSnapshot: {
      matrixTierIds: [],
      productionRequiredTierIds: [],
      matrixArtifactPaths: [],
      matrixEvidencePaths: [],
      coverageIds: [],
      requirementIds: [],
      releaseEvidencePaths: [],
      sourceDigests: {}
    },
    replacementManifestBaseline: {
      deletedTestIds: [],
      assertionBeforeTargets: [],
      tierFromIds: []
    },
    testRecords: [],
    reviewCandidates: [],
    candidateReviews: []
  }
}

test('optimization report compares a source-free compact baseline with a raw after audit', () => {
  const beforeAudit = {
    ...emptyAudit(),
    testRecords: [{
      id: 'node-test:tests/example.test.mjs#keeps-behavior',
      path: 'tests/example.test.mjs',
      framework: 'node-test',
      assertionTargets: ['assert.equal(observed, expected)'],
      coverageIds: ['behavior-coverage'],
      tierIds: ['static-governance'],
      tierInvocationCount: 1,
      timing: { samples: 0, p50Ms: null, p95Ms: null },
      failureHistory: { runs: 0, failures: 0, lastFailureAt: null },
      riskTags: ['release'],
      uniqueEvidence: true
    }],
    retainedEvidence: {
      coverageIds: ['behavior-coverage'],
      uniqueAssertionTargetCount: 1,
      testRecordCount: 1
    }
  }
  const optimizationEvidence = {
    coverageBaselinePath: 'tests/test-optimization-coverage-baseline.json',
    coverage: {
      backend: { summary: { linecoverage: 80, branchcoverage: 60 } },
      frontend: { summary: { linecoverage: 70, branchcoverage: 50 } },
      merged: { summary: { linecoverage: 75, branchcoverage: 55 } }
    },
    criticalMutationSlice: {
      evidenceMode: 'scope-identity',
      testIds: ['node-test:tests/example.test.mjs#keeps-behavior'],
      scopeIds: ['release-mutation-critical-slice']
    }
  }
  const compactBefore = compactRetentionBaseline(beforeAudit, { optimizationEvidence })
  const after = {
    ...beforeAudit,
    snapshotRole: undefined,
    optimizationEvidence
  }

  const report = buildOptimizationReport({
    before: compactBefore,
    after,
    checkpoints: [],
    viewportSummaries: []
  })

  assert.equal(report.deletionSafety.status, 'not-applicable')
  assert.equal(report.retainedCoverage.status, 'same')
  assert.deepEqual(report.retainedCoverage.missingTestIds, [])
  assert.deepEqual(report.retainedCoverage.missingAssertionTargets, [])
})

function coverageSnapshots(overrides = {}) {
  const before = {
    backend: { summary: { linecoverage: 80, branchcoverage: 60 } },
    frontend: { summary: { linecoverage: 70, branchcoverage: 65 } },
    merged: { summary: { linecoverage: 75, branchcoverage: 62 } }
  }
  const after = {
    backend: { summary: { linecoverage: 81, branchcoverage: 61 } },
    frontend: { summary: { linecoverage: 71, branchcoverage: 66 } },
    merged: { summary: { linecoverage: 76, branchcoverage: 63 } }
  }
  return {
    before: { ...before, ...(overrides.before ?? {}) },
    after: { ...after, ...(overrides.after ?? {}) }
  }
}

function mutationSnapshots(overrides = {}) {
  const sourceState = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  return {
    before: {
      score: 82,
      scope: ['Algorithms/AedsEncoder.cs'],
      mutantCount: 100,
      ...(overrides.before ?? {})
    },
    after: {
      schema: 'fsusblog.stryker-authority.v1',
      status: 'success',
      tierId: 'release-mutation-critical-slice',
      sliceId: 'release-mutation-critical-slice',
      score: 100,
      scope: ['Algorithms/AedsEncoder.cs'],
      mutantCount: 45,
      executedMutants: 45,
      statuses: { killed: 45 },
      thresholds: { break: 70, high: 85, low: 70 },
      rawReport: { path: '.tmp/mutation/backend-critical/reports/backend-mutation-critical.json', sha256: 'e'.repeat(64) },
      config: { path: 'stryker-critical-config.json', sha256: 'f'.repeat(64) },
      producer: {
        runId: 'mutation-fresh',
        sourceState,
        generatedAt: '2026-07-10T02:30:00Z'
      },
      ...(overrides.after ?? {})
    }
  }
}

function finalCheckpoints({ integrationMs = 200_000, staticMs = 15_000, boundariesMs = 1_100_000 } = {}) {
  const sourceState = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  return [
    {
      runId: 'production-fresh',
      targetTierId: 'production',
      mode: 'fresh',
      status: 'success',
      sourceState,
      budgetMs: 300_000,
      startedAt: '2026-07-10T02:55:00Z',
      finishedAt: '2026-07-10T03:00:00Z',
      updatedAt: '2026-07-10T03:00:00Z',
      tiers: {
        production: { durationMs: 1, status: 'success' },
        integration: { durationMs: integrationMs, status: 'success' },
        'static-governance': { durationMs: staticMs, status: 'success' }
      }
    },
    {
      runId: 'boundaries-fresh',
      targetTierId: 'ux-viewport-boundaries',
      mode: 'fresh',
      status: 'success',
      sourceState,
      finishedAt: '2026-07-10T02:00:00Z',
      updatedAt: '2026-07-10T02:00:00Z',
      tiers: {
        'ux-viewport-boundaries': { durationMs: boundariesMs, status: 'success' }
      }
    },
    {
      runId: 'mutation-fresh',
      targetTierId: 'release-mutation-critical-slice',
      mode: 'fresh',
      status: 'success',
      sourceState,
      finishedAt: '2026-07-10T02:30:00Z',
      updatedAt: '2026-07-10T02:30:00Z',
      tiers: {
        'release-mutation-critical-slice': { durationMs: 300_000, status: 'success', reused: false }
      }
    }
  ]
}

function projectedProductionCheckpoint() {
  const sourceState = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  const executedTierIds = [
    'integration',
    'security-authenticated-dast',
    'static-governance',
    ...Array.from({ length: 74 }, (_, index) => `logical-${String(index + 1).padStart(2, '0')}`)
  ]
  const logicalTierIds = [...executedTierIds].sort()
  const entries = Object.fromEntries(logicalTierIds.map((tierId) => {
    return [tierId, {
      tierId,
      evidenceKind: 'executed',
      physicalBundleId: ['integration', 'security-authenticated-dast'].includes(tierId)
        ? 'runtime-browser'
        : tierId === 'static-governance' ? 'frontend-tests' : 'build-static',
      status: 'success',
      executionSource: 'fresh',
      durationMs: tierId === 'integration' ? 200_000 : tierId === 'static-governance' ? 15_000 : 1,
      testIds: [`test:${tierId}`],
      artifactDigests: { [`.tmp/local-production/${tierId}.log`]: `sha256:${'b'.repeat(64)}` }
    }]
  }))
  return {
    runId: 'production-fresh',
    targetTierId: 'production',
    mode: 'fresh',
    status: 'success',
    sourceState,
    budgetMs: 300_000,
    startedAt: '2026-07-10T02:55:00Z',
    finishedAt: '2026-07-10T03:00:00Z',
    updatedAt: '2026-07-10T03:00:00Z',
    tiers: {
      'local-production-build-static': { durationMs: 50_000, status: 'success' },
      'local-production-backend-tests': { durationMs: 100_000, status: 'success' },
      'local-production-frontend-tests': { durationMs: 90_000, status: 'success' },
      'local-production-runtime-browser': { durationMs: 80_000, status: 'success' },
      'local-production-performance-evidence': { durationMs: 70_000, status: 'success' }
    },
    logicalTierProjection: {
      schema: 'fsusblog.local-profile-projection.v1',
      profileId: 'production',
      runId: 'production-fresh',
      sourceState,
      executionSource: 'fresh',
      status: 'success',
      logicalTierCount: 77,
      executedTierCount: 77,
      summaryOnlyTierCount: 0,
      logicalTierIds,
      entries
    }
  }
}

test('optimization report proves retained coverage and sorts tier and test timings', () => {
  const report = buildOptimizationReport({
    before: {
      retainedEvidence: {
        coverageIds: ['A', 'B'],
        uniqueAssertionTargetCount: 10,
        testRecordCount: 100
      },
      testRecords: [{
        id: 'baseline',
        framework: 'vitest',
        tierIds: ['release-mutation-critical-slice'],
        riskTags: ['mutation'],
        assertionTargets: ['expect(contract).toHold()']
      }]
    },
    after: {
      retainedEvidence: {
        coverageIds: ['A', 'B', 'C'],
        uniqueAssertionTargetCount: 12,
        testRecordCount: 102
      },
      candidateReviews: [{ decision: 'retain' }],
      replaceableCandidates: [],
      testRecords: [
        {
          id: 'baseline',
          framework: 'vitest',
          tierIds: ['release-mutation-critical-slice'],
          riskTags: ['mutation'],
          assertionTargets: ['expect(contract).toHold()'],
          timing: { samples: 0, p50Ms: null, p95Ms: null }
        },
        { id: 'slow', path: 'slow.test.ts', timing: { samples: 3, p50Ms: 90, p95Ms: 200 } },
        { id: 'fast', path: 'fast.test.ts', timing: { samples: 2, p50Ms: 10, p95Ms: 20 } }
      ]
    },
    checkpoints: [{
      runId: 'fresh-1',
      mode: 'fresh',
      targetTierId: 'production',
      status: 'success',
      completed: {
        fast: { durationMs: 1_000, status: 'success' },
        integration: { durationMs: 200_000, status: 'success' },
        'ux-viewport-boundaries': { durationMs: 1_100_000, status: 'success' },
        'static-governance': { durationMs: 15_000, status: 'success' }
      }
    }],
    viewportSummaries: [{
      mode: 'boundaries',
      caseCount: 6468,
      navigationCount: 924,
      groupCount: 66,
      status: 'success'
    }]
  })

  assert.equal(report.retainedCoverage.status, 'stronger')
  assert.deepEqual(report.retainedCoverage.addedCoverageIds, ['C'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingTierIds, [])
  assert.deepEqual(report.retainedCoverage.dimensions.retainedRiskTags, ['mutation'])
  assert.equal(report.matrixEvidence.boundaries.caseCount, 6468)
  assert.deepEqual(report.performanceBudgets.map((item) => [item.id, item.status]), [
    ['ux-viewport-boundaries', 'pass'],
    ['integration', 'pass'],
    ['static-governance', 'pass']
  ])
  assert.equal(report.tierDurations[0].id, 'ux-viewport-boundaries')
  assert.equal(report.topSlowTests[0].id, 'slow')
  assert.match(renderOptimizationMarkdown(report), /Retained coverage: stronger/u)
})

test('optimization report fails closed when baseline test ids or assertion targets disappear', () => {
  const report = buildOptimizationReport({
    before: {
      retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [{
        id: 'baseline-unique',
        assertionTargets: ['expect(permission).toBeDenied()']
      }],
      reviewCandidates: []
    },
    after: {
      retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
      testRecords: [
        { id: 'new-weak-1', assertionTargets: ['expect(true).toBe(true)'], timing: { samples: 0 } },
        { id: 'new-weak-2', assertionTargets: ['expect(1).toBe(1)'], timing: { samples: 0 } }
      ],
      reviewCandidates: [],
      candidateReviews: []
    },
    checkpoints: [],
    viewportSummaries: []
  })

  assert.equal(report.retainedCoverage.status, 'weaker')
  assert.deepEqual(report.retainedCoverage.missingTestIds, ['baseline-unique'])
  assert.deepEqual(report.retainedCoverage.missingAssertionTargets, ['expect(permission).toBeDenied()'])
  assert.equal(report.deletionSafety.status, 'fail')
  assert.deepEqual(report.deletionSafety.undeclaredTestIds, ['baseline-unique'])
})

test('optimization report fails closed when matrix artifacts, release evidence, or requirements disappear', () => {
  const before = {
    ...emptyAudit(),
    catalogSnapshot: {
      matrixTierIds: ['production', 'release-evidence'],
      productionRequiredTierIds: ['production', 'release-evidence'],
      matrixArtifactPaths: ['.tmp/release-evidence', '.tmp/runtime/production.json'],
      matrixEvidencePaths: ['.tmp/release-evidence/manifest.json'],
      coverageIds: ['release-evidence-manifest'],
      requirementIds: ['BACKEND-TRACEABILITY'],
      releaseEvidencePaths: ['.tmp/release-evidence', '.tmp/release-evidence/manifest.json'],
      sourceDigests: { matrix: 'sha256:before' }
    }
  }
  const after = {
    ...emptyAudit(),
    catalogSnapshot: {
      matrixTierIds: ['production'],
      productionRequiredTierIds: ['production'],
      matrixArtifactPaths: ['.tmp/runtime/production.json'],
      matrixEvidencePaths: [],
      coverageIds: [],
      requirementIds: [],
      releaseEvidencePaths: [],
      sourceDigests: { matrix: 'sha256:after' }
    }
  }

  const report = buildOptimizationReport({ before, after })

  assert.equal(report.retainedCoverage.status, 'weaker')
  assert.deepEqual(report.retainedCoverage.dimensions.missingTierIds, ['release-evidence'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingProductionRequiredTierIds, ['release-evidence'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingMatrixArtifactPaths, ['.tmp/release-evidence'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingMatrixEvidencePaths, ['.tmp/release-evidence/manifest.json'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingRequirementIds, ['BACKEND-TRACEABILITY'])
  assert.deepEqual(report.retainedCoverage.dimensions.missingReleaseEvidencePaths, [
    '.tmp/release-evidence',
    '.tmp/release-evidence/manifest.json'
  ])
})

test('optimization report separates declarations from an older baseline campaign', () => {
  const before = {
    ...emptyAudit(),
    testRecords: [{ id: 'current-test', assertionTargets: ['current assertion'] }],
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    replacementManifestBaseline: {
      deletedTestIds: ['historically-deleted-test'],
      assertionBeforeTargets: ['current assertion'],
      tierFromIds: []
    }
  }
  const after = {
    ...before,
    deletedTests: [{
      id: 'historically-deleted-test',
      path: 'tests/old.test.ts',
      replacementTestIds: ['current-test'],
      reason: 'deleted before this campaign baseline'
    }],
    assertionReplacements: [{
      before: 'current assertion',
      replacementTestIds: ['current-test'],
      after: ['current assertion'],
      reason: 'replaced before this campaign baseline'
    }]
  }

  const report = buildOptimizationReport({ before, after })

  assert.equal(report.deletionSafety.status, 'not-applicable')
  assert.deepEqual(report.deletionSafety.historicalDeclarationIds, ['historically-deleted-test'])
  assert.equal(report.deletionSafety.invalidDeclarations.length, 0)
  assert.equal(report.assertionReplacementSafety.status, 'not-applicable')
  assert.deepEqual(report.assertionReplacementSafety.historicalBeforeTargets, ['current assertion'])
  assert.equal(report.assertionReplacementSafety.invalidDeclarations.length, 0)
})

test('final authority requires a source-bound before snapshot', () => {
  const before = { ...emptyAudit(), snapshotRole: undefined }
  const report = buildOptimizationReport({
    before,
    after: emptyAudit(),
    checkpoints: finalCheckpoints(),
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(report.baselineAuthority.status, 'fail')
  assert.ok(report.finalAuthority.errors.some((error) => /before snapshot role/u.test(error)))
})

test('optimization report accepts an explicit live tier replacement with retained coverage', () => {
  const report = buildOptimizationReport({
    before: {
      retainedEvidence: { coverageIds: ['backend-fault-race-readiness'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [{ id: 'same-test', tierIds: ['backend-chaos'], assertionTargets: ['race behavior'] }]
    },
    after: {
      retainedEvidence: { coverageIds: ['backend-fault-race-readiness'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [{ id: 'same-test', tierIds: ['backend-concurrency'], assertionTargets: ['race behavior'] }],
      tierReplacements: [{
        from: 'backend-chaos',
        to: 'backend-concurrency',
        coverageIds: ['backend-fault-race-readiness'],
        reason: 'same Category=Concurrency behavior and evidence'
      }],
      reviewCandidates: [],
      candidateReviews: []
    },
    checkpoints: [],
    viewportSummaries: []
  })

  assert.deepEqual(report.retainedCoverage.dimensions.missingTierIds, [])
  assert.deepEqual(report.retainedCoverage.dimensions.replacedTierIds.map(({ from, to }) => [from, to]), [
    ['backend-chaos', 'backend-concurrency']
  ])
  assert.equal(report.retainedCoverage.status, 'same')
})

test('production-membership replacement cannot authorize standalone tier deletion or coverage loss', () => {
  const canaryTier = 'standalone-audit-tier'
  const replacementTier = 'ux-viewport-plan-progress'
  const canaryCoverage = 'standalone-audit-coverage'
  const replacementCoverage = 'ux-viewport-plan-progress'
  const canaryArtifact = '.tmp/release-evidence/standalone-audit.json'
  const replacementArtifact = '.tmp/ux/viewport-plan-progress.json'
  const canaryRecord = {
    id: 'canary-governance-proof',
    tierIds: [canaryTier],
    coverageIds: [canaryCoverage],
    assertionTargets: ['historical parity remains fail closed']
  }
  const replacementRecord = {
    id: 'plan-progress-proof',
    tierIds: [replacementTier],
    coverageIds: [replacementCoverage],
    assertionTargets: ['plan progress remains executable']
  }
  const membershipReplacement = {
    from: canaryTier,
    to: replacementTier,
    scope: 'production-membership',
    coverageIds: [replacementCoverage],
    catalogReplacements: {
      productionRequiredTierIds: [{ from: canaryTier, to: replacementTier }]
    },
    reason: 'membership-only replacement retains the source tier while production executes the target tier'
  }
  const before = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: [canaryCoverage], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [canaryRecord],
    catalogSnapshot: {
      ...emptyAudit().catalogSnapshot,
      matrixTierIds: [canaryTier],
      productionRequiredTierIds: [canaryTier],
      matrixArtifactPaths: [canaryArtifact],
      matrixEvidencePaths: [canaryArtifact],
      coverageIds: [canaryCoverage],
      releaseEvidencePaths: [canaryArtifact]
    }
  }
  const after = {
    ...before,
    retainedEvidence: { coverageIds: [canaryCoverage, replacementCoverage], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
    testRecords: [canaryRecord, replacementRecord],
    catalogSnapshot: {
      ...before.catalogSnapshot,
      matrixTierIds: [canaryTier, replacementTier],
      productionRequiredTierIds: [replacementTier],
      matrixArtifactPaths: [canaryArtifact, replacementArtifact],
      matrixEvidencePaths: [canaryArtifact, replacementArtifact],
      coverageIds: [canaryCoverage, replacementCoverage],
      releaseEvidencePaths: [canaryArtifact]
    },
    tierReplacements: [membershipReplacement]
  }

  const report = buildOptimizationReport({ before, after })
  assert.notEqual(report.retainedCoverage.status, 'weaker', JSON.stringify(report.retainedCoverage))
  assert.deepEqual(report.retainedCoverage.dimensions.invalidTierReplacements, [])
  assert.deepEqual(report.retainedCoverage.dimensions.missingTierIds, [])
  assert.deepEqual(report.retainedCoverage.dimensions.missingProductionRequiredTierIds, [])
  assert.deepEqual(report.retainedCoverage.dimensions.replacedTierIds, [{
    from: canaryTier,
    to: replacementTier,
    scope: 'production-membership',
    coverageIds: [replacementCoverage],
    reason: membershipReplacement.reason
  }])

  const deletedCanary = buildOptimizationReport({
    before,
    after: {
      ...after,
      retainedEvidence: { coverageIds: [replacementCoverage], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [replacementRecord],
      catalogSnapshot: {
        ...after.catalogSnapshot,
        matrixTierIds: [replacementTier],
        matrixArtifactPaths: [replacementArtifact],
        matrixEvidencePaths: [replacementArtifact],
        coverageIds: [replacementCoverage],
        releaseEvidencePaths: []
      }
    }
  })
  assert.equal(deletedCanary.retainedCoverage.status, 'weaker')
  assert.deepEqual(deletedCanary.retainedCoverage.dimensions.missingTierIds, [canaryTier])
  assert.ok(deletedCanary.retainedCoverage.dimensions.invalidTierReplacements[0].reasons.some((reason) => /not retained as a standalone tier/u.test(reason)))

  const removedCanaryCoverage = buildOptimizationReport({
    before,
    after: {
      ...after,
      retainedEvidence: { coverageIds: [replacementCoverage], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
      testRecords: [{ ...canaryRecord, coverageIds: [] }, replacementRecord],
      catalogSnapshot: {
        ...after.catalogSnapshot,
        coverageIds: [replacementCoverage]
      }
    }
  })
  assert.equal(removedCanaryCoverage.retainedCoverage.status, 'weaker')
  assert.deepEqual(removedCanaryCoverage.retainedCoverage.missingCoverageIds, [canaryCoverage])
  assert.deepEqual(removedCanaryCoverage.retainedCoverage.dimensions.missingCatalogCoverageIds, [canaryCoverage])
})

test('optimization report rejects malformed replacement scopes and catalog mappings even without audit normalization', () => {
  const before = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: ['old-coverage'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'old-proof', tierIds: ['old-tier'], assertionTargets: ['old behavior'] }],
    catalogSnapshot: {
      ...emptyAudit().catalogSnapshot,
      matrixTierIds: ['old-tier'],
      productionRequiredTierIds: ['old-tier'],
      coverageIds: ['old-coverage']
    }
  }
  const afterBase = {
    ...before,
    retainedEvidence: { coverageIds: ['old-coverage', 'new-coverage'], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
    testRecords: [
      { id: 'old-proof', tierIds: ['old-tier'], assertionTargets: ['old behavior'] },
      { id: 'new-proof', tierIds: ['new-tier'], assertionTargets: ['new behavior'] }
    ],
    catalogSnapshot: {
      ...before.catalogSnapshot,
      matrixTierIds: ['old-tier', 'new-tier'],
      productionRequiredTierIds: ['new-tier'],
      coverageIds: ['old-coverage', 'new-coverage']
    }
  }
  const valid = {
    from: 'old-tier',
    to: 'new-tier',
    scope: 'production-membership',
    coverageIds: ['new-coverage'],
    catalogReplacements: {
      productionRequiredTierIds: [{ from: 'old-tier', to: 'new-tier' }]
    },
    reason: 'membership-only replacement'
  }
  const malformed = [
    { ...valid, scope: 'production-only' },
    { ...valid, catalogReplacements: { productionRequiredTierIds: [] } },
    {
      ...valid,
      catalogReplacements: {
        productionRequiredTierIds: valid.catalogReplacements.productionRequiredTierIds,
        coverageIds: [{ from: 'old-coverage', to: 'new-coverage' }]
      }
    },
    {
      ...valid,
      scope: 'tier',
      catalogReplacements: {
        coverageIds: [
          { from: 'old-coverage', to: 'new-coverage' },
          { from: 'old-coverage', to: 'another-coverage' }
        ]
      }
    }
  ]

  for (const replacement of malformed) {
    const report = buildOptimizationReport({
      before,
      after: { ...afterBase, tierReplacements: [replacement] }
    })
    assert.equal(report.retainedCoverage.status, 'weaker', JSON.stringify(report.retainedCoverage))
    assert.equal(report.retainedCoverage.dimensions.invalidTierReplacements.length, 1)
  }
})

test('tier replacement explicitly maps every removed production catalog dimension', () => {
  const canaryArtifact = '.tmp/release-evidence/retired-viewport-audit.json'
  const boundaryArtifact = '.tmp/ux/viewport-boundaries.json'
  const before = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: ['retired-viewport-coverage', 'ux-viewport-boundary'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'viewport-proof', tierIds: ['retired-viewport-tier'], assertionTargets: ['viewport behavior'] }],
    catalogSnapshot: {
      ...emptyAudit().catalogSnapshot,
      matrixTierIds: ['retired-viewport-tier', 'ux-viewport-boundaries'],
      productionRequiredTierIds: ['retired-viewport-tier'],
      matrixArtifactPaths: [canaryArtifact, boundaryArtifact],
      matrixEvidencePaths: [canaryArtifact, boundaryArtifact],
      coverageIds: ['retired-viewport-coverage', 'ux-viewport-boundary'],
      releaseEvidencePaths: [canaryArtifact, boundaryArtifact]
    }
  }
  const after = {
    ...before,
    retainedEvidence: { coverageIds: ['ux-viewport-boundary'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'viewport-proof', tierIds: ['ux-viewport-boundaries'], assertionTargets: ['viewport behavior'] }],
    catalogSnapshot: {
      ...before.catalogSnapshot,
      matrixTierIds: ['ux-viewport-boundaries'],
      productionRequiredTierIds: ['ux-viewport-boundaries'],
      matrixArtifactPaths: [boundaryArtifact],
      matrixEvidencePaths: [boundaryArtifact],
      coverageIds: ['ux-viewport-boundary'],
      releaseEvidencePaths: [boundaryArtifact]
    },
    tierReplacements: [{
      from: 'retired-viewport-tier',
      to: 'ux-viewport-boundaries',
      coverageIds: ['ux-viewport-boundary'],
      reason: 'boundaries retains the executable viewport behavior without claiming unavailable historical parity',
      catalogReplacements: {
        productionRequiredTierIds: [{ from: 'retired-viewport-tier', to: 'ux-viewport-boundaries' }],
        coverageIds: [{ from: 'retired-viewport-coverage', to: 'ux-viewport-boundary' }],
        matrixArtifactPaths: [{ from: canaryArtifact, to: boundaryArtifact }],
        matrixEvidencePaths: [{ from: canaryArtifact, to: boundaryArtifact }],
        releaseEvidencePaths: [{ from: canaryArtifact, to: boundaryArtifact }]
      }
    }]
  }

  const report = buildOptimizationReport({ before, after })
  assert.equal(report.retainedCoverage.status, 'same', JSON.stringify(report.retainedCoverage))
  assert.deepEqual(report.retainedCoverage.missingCoverageIds, [])
  assert.deepEqual(report.retainedCoverage.dimensions.missingProductionRequiredTierIds, [])
  assert.equal(report.retainedCoverage.dimensions.replacedCatalogDimensions.length, 5)

  const undeclared = buildOptimizationReport({
    before,
    after: { ...after, tierReplacements: [{ ...after.tierReplacements[0], catalogReplacements: {} }] }
  })
  assert.equal(undeclared.retainedCoverage.status, 'weaker')
  assert.ok(undeclared.retainedCoverage.dimensions.missingMatrixArtifactPaths.includes(canaryArtifact))
})

test('optimization report accepts an explicit deletion only with a live replacement and preserved assertions', () => {
  const baseline = {
    retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'old', assertionTargets: ['expect(contract).toHold()'] }],
    reviewCandidates: ['old.test.ts']
  }
  const after = {
    retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'replacement', assertionTargets: ['expect(contract).toHold()'], timing: { samples: 0 } }],
    reviewCandidates: [],
    candidateReviews: [],
    deletedTests: [{
      id: 'old',
      path: 'old.test.ts',
      replacementTestIds: ['replacement'],
      reason: 'exact semantic replacement'
    }]
  }

  const report = buildOptimizationReport({ before: baseline, after, checkpoints: [], viewportSummaries: [] })

  assert.equal(report.retainedCoverage.status, 'same')
  assert.deepEqual(report.retainedCoverage.missingTestIds, [])
  assert.equal(report.deletionSafety.status, 'pass')
  assert.equal(report.deletionSafety.deletedTests[0].replacementTestIds[0], 'replacement')
})

test('optimization report binds removed assertions to an explicitly declared deleted test', () => {
  const baseline = {
    retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'old-meta-test', assertionTargets: ['expect(sourceText).toContain(privateShape)'] }]
  }
  const after = {
    retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [{ id: 'behavior-owner', assertionTargets: ['expect(runtimeBehavior).toHold()'], timing: { samples: 0 } }],
    deletedTests: [{
      id: 'old-meta-test',
      path: 'old-meta.test.ts',
      replacementTestIds: ['behavior-owner'],
      reason: 'the executable behavior owner replaces the private source-shape assertion'
    }],
    reviewCandidates: [],
    candidateReviews: []
  }

  const report = buildOptimizationReport({ before: baseline, after, checkpoints: [], viewportSummaries: [] })

  assert.equal(report.retainedCoverage.status, 'same')
  assert.deepEqual(report.retainedCoverage.missingAssertionTargets, [])
  assert.deepEqual(report.retainedCoverage.assertionsCoveredByDeletedTests, [
    'expect(sourceText).toContain(privateShape)'
  ])

  const undeclared = buildOptimizationReport({
    before: baseline,
    after: { ...after, deletedTests: [] },
    checkpoints: [],
    viewportSummaries: []
  })
  assert.equal(undeclared.retainedCoverage.status, 'weaker')
  assert.deepEqual(undeclared.retainedCoverage.missingAssertionTargets, [
    'expect(sourceText).toContain(privateShape)'
  ])
})

test('optimization report accepts a declared assertion strengthening backed by a live test', () => {
  const report = buildOptimizationReport({
    before: {
      retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [{ id: 'same-test', assertionTargets: ['expect(oldContract).toHold()'] }]
    },
    after: {
      retainedEvidence: { coverageIds: ['A'], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: [{ id: 'same-test', assertionTargets: ['expect(newContract).toHold()'], timing: { samples: 0 } }],
      assertionReplacements: [{
        before: 'expect(oldContract).toHold()',
        replacementTestIds: ['same-test'],
        after: ['expect(newContract).toHold()'],
        reason: 'new contract is stricter'
      }],
      reviewCandidates: [],
      candidateReviews: []
    },
    checkpoints: [],
    viewportSummaries: []
  })

  assert.equal(report.retainedCoverage.status, 'same')
  assert.deepEqual(report.retainedCoverage.missingAssertionTargets, [])
  assert.equal(report.assertionReplacementSafety.status, 'pass')
})

test('optimization report recomputes candidate review completeness from test-level evidence', () => {
  const report = buildOptimizationReport({
    before: { retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 }, testRecords: [] },
    after: {
      retainedEvidence: {
        coverageIds: [],
        uniqueAssertionTargetCount: 1,
        testRecordCount: 1,
        reviewedCandidateCount: 1,
        unreviewedCandidateCount: 0
      },
      testRecords: [{ id: 'candidate-test', assertionTargets: ['behavior'], timing: { samples: 0 } }],
      reviewCandidates: ['candidate.test.ts'],
      candidateReviews: [{
        path: 'candidate.test.ts',
        decision: 'retain',
        reviewed: true,
        testIds: ['candidate-test'],
        tests: []
      }]
    },
    checkpoints: [],
    viewportSummaries: []
  })

  assert.equal(report.retentionReview.reviewedCandidates, 0)
  assert.equal(report.retentionReview.unreviewedCandidates, 1)
  assert.deepEqual(report.retentionReview.incompleteCandidates, ['candidate.test.ts'])
})

test('optimization report does not claim missing performance evidence passed', () => {
  const report = buildOptimizationReport({
    before: { retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 } },
    after: { retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 }, testRecords: [] },
    checkpoints: [],
    viewportSummaries: []
  })

  assert.ok(report.performanceBudgets.every((item) => item.status === 'not-measured'))
  assert.equal(report.authoritativeFreshRun, null)
})

test('optimization report consumes the scheduler checkpoint tier schema', () => {
  const report = buildOptimizationReport({
    before: { retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 1, testRecordCount: 1 } },
    after: {
      retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
      testRecords: []
    },
    checkpoints: [{
      schema: 'fsusblog.test-matrix.checkpoint.v1',
      runId: 'production-fresh',
      targetTierId: 'production',
      mode: 'fresh',
      status: 'success',
      tiers: {
        integration: { durationMs: 42_000, status: 'success', inputFingerprint: 'integration-input' },
        'static-governance': { durationMs: 9_000, status: 'success', inputFingerprint: 'static-input' }
      }
    }],
    viewportSummaries: [{
      mode: 'boundaries',
      status: 'ok',
      plannedCaseCount: 6468,
      plannedNavigationCount: 924,
      plannedRouteThemeGroupCount: 66,
      completedRouteThemeGroupCount: 66,
      failedRouteThemeGroupCount: 0
    }]
  })

  assert.equal(report.authoritativeFreshRun.runId, 'production-fresh')
  assert.equal(report.authoritativeFreshRun.target, 'production')
  assert.deepEqual(report.tierDurations.map((entry) => entry.id), ['integration', 'static-governance'])
  assert.equal(report.performanceBudgets.find((entry) => entry.id === 'integration').status, 'pass')
  assert.deepEqual(report.matrixEvidence.boundaries, {
    status: 'ok',
    caseCount: 6468,
    navigationCount: 924,
    groupCount: 66,
    completedGroupCount: 66,
    failedGroupCount: 0
  })
})

test('optimization report prefers the latest fresh production checkpoint over focused runs', () => {
  const base = {
    schema: 'fsusblog.test-retention-audit.v2',
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 },
    testRecords: [],
    reviewCandidates: [],
    candidateReviews: []
  }
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: [
      {
        runId: 'production-proof',
        mode: 'fresh',
        targetTierId: 'production',
        status: 'success',
        updatedAt: '2026-07-10T01:00:00Z',
        tiers: { production: { durationMs: 100, status: 'success' } }
      },
      {
        runId: 'later-focused',
        mode: 'fresh',
        targetTierId: 'backend-unit',
        status: 'success',
        updatedAt: '2026-07-10T02:00:00Z',
        tiers: { 'backend-unit': { durationMs: 10, status: 'success' } }
      }
    ],
    viewportSummaries: []
  })

  assert.equal(report.authoritativeFreshRun.runId, 'production-proof')
  assert.deepEqual(report.tierDurations.map((entry) => entry.id), ['production'])
})

test('optimization report observes production duration without enforcing the former five-minute target', () => {
  const base = {
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 0, testRecordCount: 0 },
    testRecords: []
  }
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: [{
      runId: 'production-over-budget',
      targetTierId: 'production',
      mode: 'fresh',
      status: 'success',
      budgetMs: 300_000,
      startedAt: '2026-07-12T00:00:00.000Z',
      finishedAt: '2026-07-12T00:05:00.001Z',
      tiers: {}
    }]
  })

  assert.equal(report.productionWallClock.status, 'pass')
  assert.equal(report.productionWallClock.durationMs, 300_001)
  assert.equal(report.productionWallClock.enforced, false)
  assert.equal(report.authoritativeFreshRun.durationStatus, 'pass')
  assert.deepEqual(report.productionWallClock.errors, [])
})

test('optimization report CLI refuses to manufacture a proof without the baseline audit', () => {
  const token = `${process.pid}-${Date.now()}`
  const after = `.tmp/test-retention-after-${token}.json`
  const missingBefore = `.tmp/test-retention-missing-${token}.json`
  const out = `.tmp/test-retention-report-${token}.json`
  const markdown = `.tmp/test-retention-report-${token}.md`
  mkdirSync('.tmp', { recursive: true })
  writeFileSync(after, `${JSON.stringify({
    schema: 'fsusblog.test-retention-audit.v2',
    retainedEvidence: {},
    testRecords: [],
    reviewCandidates: [],
    candidateReviews: []
  })}\n`)

  try {
    const result = spawnSync(process.execPath, [
      'tools/test/optimization-report.mjs',
      '--before', missingBefore,
      '--after', after,
      '--out', out,
      '--markdown', markdown
    ], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /authoritative --before path must be tests\/test-retention-before\.json/u)
  } finally {
    for (const file of [after, out, markdown]) rmSync(file, { force: true })
  }
})

test('optimization snapshot schema requires all three line and branch coverage scopes', () => {
  const schema = JSON.parse(readFileSync('tests/test-optimization-snapshot.schema.json', 'utf8'))
  assert.equal(schema.properties.schema.const, 'fsusblog.test-optimization-snapshot.v1')
  assert.deepEqual(schema.properties.coverage.required, ['backend', 'frontend', 'merged'])
  for (const id of schema.properties.coverage.required) {
    assert.equal(schema.properties.coverage.properties[id].$ref, '#/$defs/coverageSummary')
  }
  assert.deepEqual(schema.$defs.coverageSummary.properties.summary.required, ['linecoverage', 'branchcoverage'])
})

test('tracked optimization baseline uses the authoritative snapshot schema', () => {
  const baseline = JSON.parse(readFileSync(path.join(path.resolve('.'), 'tests/test-optimization-coverage-baseline.json'), 'utf8'))
  assert.equal(baseline.schema, 'fsusblog.test-optimization-snapshot.v1')
  for (const id of ['backend', 'frontend', 'merged']) {
    assert.equal(typeof baseline.coverage[id].summary.linecoverage, 'number')
    assert.equal(typeof baseline.coverage[id].summary.branchcoverage, 'number')
  }
})

test('optimization snapshot capture rejects incomplete coverage and preserves optional mutation evidence', () => {
  const coverage = coverageSnapshots().before
  const snapshot = buildOptimizationSnapshot({
    coverage,
    criticalMutationSlice: mutationSnapshots().before,
    capturedAt: '2026-07-10T00:00:00.000Z'
  })
  assert.equal(snapshot.schema, 'fsusblog.test-optimization-snapshot.v1')
  assert.equal(snapshot.coverage.backend.summary.linecoverage, 80)
  assert.equal(snapshot.criticalMutationSlice.score, 82)
  assert.throws(
    () => buildOptimizationSnapshot({ coverage: { backend: coverage.backend } }),
    /cannot capture incomplete coverage snapshot/u
  )
})

test('final authority requires a successful production fresh checkpoint and never falls back to focused runs', () => {
  const base = emptyAudit()
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: [{
      runId: 'focused-fresh',
      targetTierId: 'backend-unit',
      mode: 'fresh',
      status: 'success',
      tiers: {
        integration: { durationMs: 1, status: 'success' },
        'static-governance': { durationMs: 1, status: 'success' },
        'ux-viewport-boundaries': { durationMs: 1, status: 'success' }
      }
    }],
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(report.authoritativeFreshRun, null)
  assert.equal(report.finalAuthority.status, 'fail')
  assert.ok(report.finalAuthority.errors.some((error) => /successful production fresh checkpoint/u.test(error)))
})

test('final authority requires every performance budget to be measured, successful, and within limit', () => {
  const base = emptyAudit()
  const missingBoundaries = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints().slice(0, 1),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(missingBoundaries.performanceBudgets.find((item) => item.id === 'ux-viewport-boundaries').status, 'not-measured')
  assert.equal(missingBoundaries.finalAuthority.status, 'fail')

  const overBudget = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints({ integrationMs: 240_001 }),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(overBudget.performanceBudgets.find((item) => item.id === 'integration').status, 'fail')
  assert.ok(overBudget.finalAuthority.errors.some((error) => /integration.*budget/u.test(error)))
})

test('performance budget fallback only accepts a successful fresh checkpoint targeting that budget tier', () => {
  const base = emptyAudit()
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: [
      ...finalCheckpoints().slice(0, 1),
      {
        runId: 'unrelated-with-boundary-entry',
        targetTierId: 'backend-unit',
        mode: 'fresh',
        status: 'success',
        updatedAt: '2026-07-10T05:00:00Z',
        tiers: { 'ux-viewport-boundaries': { durationMs: 1, status: 'success' } }
      },
      {
        runId: 'failed-boundary-run',
        targetTierId: 'ux-viewport-boundaries',
        mode: 'fresh',
        status: 'failure',
        updatedAt: '2026-07-10T04:00:00Z',
        tiers: { 'ux-viewport-boundaries': { durationMs: 1, status: 'success' } }
      }
    ],
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  const boundary = report.performanceBudgets.find((item) => item.id === 'ux-viewport-boundaries')
  assert.equal(boundary.status, 'not-measured')
  assert.equal(boundary.checkpointRunId, null)
  assert.equal(report.finalAuthority.status, 'fail')
})

test('final authority compares backend, frontend, and merged line and branch snapshots without regressions', () => {
  const base = emptyAudit()
  const passing = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(passing.coverageMetrics.status, 'pass')
  assert.equal(passing.finalAuthority.status, 'pass', JSON.stringify(passing.finalAuthority))

  const regressed = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots({
      after: { frontend: { summary: { linecoverage: 71, branchcoverage: 64.99 } } }
    }),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(regressed.coverageMetrics.status, 'fail')
  assert.equal(regressed.coverageMetrics.dimensions.frontend.status, 'fail')
  assert.ok(regressed.finalAuthority.errors.some((error) => /frontend.*branch coverage regressed/u.test(error)))

  const missing = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: { before: {}, after: {} },
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(missing.coverageMetrics.status, 'not-measured')
  assert.equal(missing.finalAuthority.status, 'fail')
})

test('physical production checkpoints require an exact source-bound 77-tier logical projection', () => {
  const production = projectedProductionCheckpoint()
  const audit = {
    ...emptyAudit(),
    catalogSnapshot: {
      ...emptyAudit().catalogSnapshot,
      productionRequiredTierIds: production.logicalTierProjection.logicalTierIds
    }
  }
  const supporting = finalCheckpoints().slice(1)
  const missingProjection = buildOptimizationReport({
    before: audit,
    after: audit,
    checkpoints: [{ ...production, logicalTierProjection: undefined }, ...supporting],
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(missingProjection.logicalProjection.status, 'fail')
  assert.equal(missingProjection.finalAuthority.status, 'fail')

  const projected = buildOptimizationReport({
    before: audit,
    after: audit,
    checkpoints: [production, ...supporting],
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })
  assert.equal(projected.logicalProjection.status, 'pass')
  assert.equal(projected.performanceBudgets.find((item) => item.id === 'integration').checkpointRunId, 'production-fresh')
  assert.equal(projected.performanceBudgets.find((item) => item.id === 'static-governance').status, 'pass')
  assert.equal(projected.finalAuthority.status, 'pass', JSON.stringify(projected.finalAuthority))
})

test('final authority requires a non-regressing critical mutation slice with retained scope', () => {
  const deletedRecord = {
    id: 'deleted-test',
    tierIds: ['backend-mutation', 'release-mutation-critical-slice'],
    assertionTargets: ['critical behavior']
  }
  const replacementRecord = {
    id: 'replacement-test',
    tierIds: ['backend-mutation', 'release-mutation-critical-slice'],
    assertionTargets: ['critical behavior']
  }
  const base = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [deletedRecord]
  }
  const afterDeletion = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 1, testRecordCount: 1 },
    testRecords: [replacementRecord],
    deletedCandidates: [],
    deletedTests: [{
      id: deletedRecord.id,
      replacementTestIds: [replacementRecord.id],
      reason: 'replacement retains the same critical behavior'
    }]
  }
  const regressed = buildOptimizationReport({
    before: base,
    after: afterDeletion,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots({
      before: { score: 82, scope: ['src/core/**', 'src/backend/Infrastructure/Auth/**'], mutantCount: 100 },
      after: { score: 81.9, scope: ['src/core/**'], mutantCount: 90 }
    }),
    finalAuthority: true
  })
  assert.equal(regressed.criticalMutationSlice.actualDeletionCount, 1)
  assert.equal(regressed.criticalMutationSlice.status, 'fail')
  assert.deepEqual(regressed.criticalMutationSlice.missingScope, ['src/backend/Infrastructure/Auth/**'])
  assert.ok(regressed.finalAuthority.errors.some((error) => /critical mutation slice/u.test(error)))

  const missing = buildOptimizationReport({
    before: base,
    after: afterDeletion,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: null,
    finalAuthority: true
  })
  assert.equal(missing.criticalMutationSlice.status, 'not-measured')
  assert.equal(missing.finalAuthority.status, 'fail')
})

test('out-of-scope replacements require a source-bound executed critical mutation slice', () => {
  const criticalRecord = {
    id: 'shell:tools/test/legacy-test.sh',
    tierIds: ['backend-mutation', 'release-mutation-critical-slice'],
    assertionTargets: ['behavior:legacy-test.sh']
  }
  const removedUiRecord = { id: 'vitest:old-ui-test', tierIds: ['frontend-unit-shard'], assertionTargets: ['mobile behavior'] }
  const replacementUiRecord = { id: 'vitest:new-ui-test', tierIds: ['frontend-unit-shard'], assertionTargets: ['mobile behavior'] }
  const before = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
    testRecords: [criticalRecord, removedUiRecord]
  }
  const after = {
    ...emptyAudit(),
    retainedEvidence: { coverageIds: [], uniqueAssertionTargetCount: 2, testRecordCount: 2 },
    testRecords: [criticalRecord, replacementUiRecord],
    deletedTests: [{
      id: removedUiRecord.id,
      replacementTestIds: [replacementUiRecord.id],
      reason: 'strictly stronger UI contract'
    }]
  }
  const report = buildOptimizationReport({
    before,
    after,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(report.criticalMutationSlice.status, 'pass')
  assert.equal(report.criticalMutationSlice.evidenceMode, 'executed-current-slice')
  assert.equal(report.criticalMutationSlice.actualDeletionCount, 1)
  assert.equal(report.criticalMutationSlice.criticalDeletionCount, 0)
  assert.deepEqual(report.criticalMutationSlice.outOfScopeDeletionIds, [removedUiRecord.id])
  assert.equal(report.finalAuthority.status, 'pass')
})

test('zero actual deletions still require a source-bound executed critical mutation slice', () => {
  const criticalRecord = {
    id: 'shell:tools/test/legacy-test.sh',
    tierIds: ['backend-mutation', 'release-mutation-critical-slice'],
    assertionTargets: ['behavior:legacy-test.sh']
  }
  const before = { ...emptyAudit(), testRecords: [criticalRecord] }
  const after = { ...emptyAudit(), testRecords: [criticalRecord], deletedCandidates: [] }
  const report = buildOptimizationReport({
    before,
    after,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(report.criticalMutationSlice.status, 'pass')
  assert.equal(report.criticalMutationSlice.evidenceMode, 'executed-current-slice')
  assert.deepEqual(report.criticalMutationSlice.before.testIds, ['shell:tools/test/legacy-test.sh'])
  assert.equal(report.finalAuthority.status, 'pass')

  const missing = buildOptimizationReport({
    before,
    after,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: null,
    finalAuthority: true
  })
  assert.equal(missing.criticalMutationSlice.status, 'not-measured')
  assert.equal(missing.finalAuthority.status, 'fail')
})

test('final mutation authority rejects a mismatched run or source even with a passing score', () => {
  const base = emptyAudit()
  const wrongRun = mutationSnapshots({
    after: {
      producer: {
        ...mutationSnapshots().after.producer,
        runId: 'unrelated-mutation-run'
      }
    }
  })
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: wrongRun,
    finalAuthority: true
  })
  assert.equal(report.mutationAuthority.status, 'fail')
  assert.ok(report.mutationAuthority.errors.some((error) => /run id/u.test(error)))
  assert.equal(report.finalAuthority.status, 'fail')
})

test('final authority binds checkpoints, coverage, and retention audit to one source state', () => {
  const sourceState = { commit: 'c'.repeat(40), worktreeFingerprint: 'd'.repeat(64) }
  const addProducer = (coverage) => Object.fromEntries(Object.entries(coverage).map(([id, summary]) => [id, {
    ...summary,
    producer: { runId: 'production-fresh', sourceCommit: sourceState.commit, sourceFingerprint: sourceState.worktreeFingerprint }
  }]))
  const checkpoints = finalCheckpoints().map((checkpoint) => ({ ...checkpoint, sourceState }))
  const audit = {
    ...emptyAudit(),
    sourceState,
    producer: {
      runId: 'production-fresh',
      generatedAt: '2026-07-10T03:00:01Z',
      sourceState
    }
  }
  const matching = buildOptimizationReport({
    before: audit,
    after: audit,
    checkpoints,
    viewportSummaries: [],
    coverageSnapshots: { before: coverageSnapshots().before, after: addProducer(coverageSnapshots().after) },
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true,
    currentSourceState: sourceState
  })
  assert.equal(matching.sourceAuthority.status, 'pass')
  assert.equal(matching.finalAuthority.status, 'pass')

  const stale = buildOptimizationReport({
    before: audit,
    after: audit,
    checkpoints: checkpoints.map((checkpoint) => ({
      ...checkpoint,
      sourceState: { ...sourceState, worktreeFingerprint: 'stale' }
    })),
    viewportSummaries: [],
    coverageSnapshots: { before: coverageSnapshots().before, after: addProducer(coverageSnapshots().after) },
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true,
    currentSourceState: sourceState
  })
  assert.equal(stale.sourceAuthority.status, 'fail')
  assert.equal(stale.finalAuthority.status, 'fail')
})

test('final authority rejects retention evidence from another run or generated before production completed', () => {
  const wrongRunAudit = {
    ...emptyAudit(),
    producer: {
      ...emptyAudit().producer,
      runId: 'unrelated-run'
    }
  }
  const wrongRun = buildOptimizationReport({
    before: emptyAudit(),
    after: wrongRunAudit,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(wrongRun.retentionAuditAuthority.status, 'fail')
  assert.ok(wrongRun.finalAuthority.errors.some((error) => /retention audit run unrelated-run does not match authoritative run production-fresh/u.test(error)))

  const earlyAudit = {
    ...emptyAudit(),
    generatedAt: '2026-07-10T02:59:59Z',
    producer: {
      ...emptyAudit().producer,
      generatedAt: '2026-07-10T02:59:59Z'
    }
  }
  const early = buildOptimizationReport({
    before: emptyAudit(),
    after: earlyAudit,
    checkpoints: finalCheckpoints(),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(early.retentionAuditAuthority.status, 'fail')
  assert.ok(early.finalAuthority.errors.some((error) => /retention audit was generated before production checkpoint completed/u.test(error)))

  const missingFinish = buildOptimizationReport({
    before: emptyAudit(),
    after: emptyAudit(),
    checkpoints: finalCheckpoints().map((checkpoint) => (
      checkpoint.targetTierId === 'production'
        ? { ...checkpoint, finishedAt: undefined }
        : checkpoint
    )),
    viewportSummaries: [],
    coverageSnapshots: coverageSnapshots(),
    mutationSnapshots: mutationSnapshots(),
    finalAuthority: true
  })

  assert.equal(missingFinish.retentionAuditAuthority.status, 'fail')
  assert.ok(missingFinish.finalAuthority.errors.some((error) => /production checkpoint finishedAt is missing or invalid/u.test(error)))
})

test('historical report construction remains compatible but explicitly marks missing final evidence', () => {
  const base = emptyAudit()
  const report = buildOptimizationReport({
    before: base,
    after: base,
    checkpoints: [],
    viewportSummaries: []
  })

  assert.equal(report.coverageMetrics.status, 'not-measured')
  assert.equal(report.criticalMutationSlice.status, 'not-measured')
  assert.equal(report.finalAuthority.required, false)
  assert.equal(report.finalAuthority.status, 'compatibility')
})

test('optimization report CLI rejects a focused-only checkpoint even when every other proof is present', async () => {
  const token = `${process.pid}-${Date.now()}-focused`
  const files = Object.fromEntries([
    'forgedBefore', 'after', 'baselineSnapshot', 'currentSnapshot', 'checkpoint', 'mutationCheckpoint',
    'mutationEvidence', 'rawReport', 'mutationConfig', 'out', 'markdown'
  ].map((name) => [name, `.tmp/test-optimization-${name}-${token}.json`]))
  files.markdown = `.tmp/test-optimization-${token}.md`
  mkdirSync('.tmp', { recursive: true })
  const worktree = await snapshotGitWorktree(path.resolve('.'))
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve('.'), encoding: 'utf8' }).stdout.trim()
  const sourceState = { commit, worktreeFingerprint: worktree.fingerprint }
  const base = {
    ...emptyAudit(),
    snapshotRole: undefined,
    generatedAt: '2026-07-10T03:00:01Z',
    sourceState,
    producer: {
      runId: 'production-final',
      generatedAt: '2026-07-10T03:00:01Z',
      sourceState
    }
  }
  const beforeEvidence = {
    schema: 'fsusblog.test-optimization-snapshot.v1',
    coverage: coverageSnapshots().before,
    criticalMutationSlice: mutationSnapshots().before
  }
  const afterCoverage = Object.fromEntries(Object.entries(coverageSnapshots().after).map(([id, summary]) => [id, {
    ...summary,
    producer: {
      runId: 'production-final',
      sourceCommit: commit,
      sourceFingerprint: worktree.fingerprint
    }
  }]))
  const afterEvidence = {
    schema: 'fsusblog.test-optimization-snapshot.v1',
    coverage: afterCoverage,
    criticalMutationSlice: mutationSnapshots().after
  }
  const focusedCheckpoint = {
    runId: 'focused-only',
    targetTierId: 'backend-unit',
    mode: 'fresh',
    status: 'success',
    finishedAt: '2026-07-10T03:00:00Z',
    sourceState,
    tiers: Object.fromEntries(finalCheckpoints().flatMap((checkpoint) => Object.entries(checkpoint.tiers)))
  }
  writeFileSync(files.forgedBefore, `${JSON.stringify(base)}\n`)
  writeFileSync(files.after, `${JSON.stringify(base)}\n`)
  writeFileSync(files.baselineSnapshot, `${JSON.stringify(beforeEvidence)}\n`)
  writeFileSync(files.currentSnapshot, `${JSON.stringify(afterEvidence)}\n`)
  writeFileSync(files.checkpoint, `${JSON.stringify(focusedCheckpoint)}\n`)
  writeFileSync(files.rawReport, '{}\n')
  writeFileSync(files.mutationConfig, '{}\n')
  const mutationEvidence = {
    ...mutationSnapshots().after,
    rawReport: {
      path: files.rawReport,
      sha256: createHash('sha256').update(readFileSync(files.rawReport)).digest('hex')
    },
    config: {
      path: files.mutationConfig,
      sha256: createHash('sha256').update(readFileSync(files.mutationConfig)).digest('hex')
    },
    producer: {
      ...mutationSnapshots().after.producer,
      sourceState
    }
  }
  writeFileSync(files.mutationEvidence, `${JSON.stringify(mutationEvidence)}\n`)
  writeFileSync(files.mutationCheckpoint, `${JSON.stringify({
    ...finalCheckpoints()[2],
    sourceState
  })}\n`)

  try {
    const forged = spawnSync(process.execPath, [
      'tools/test/optimization-report.mjs',
      '--before', files.forgedBefore,
      '--after', files.after,
      '--checkpoint', files.checkpoint,
      '--out', files.out,
      '--markdown', files.markdown
    ], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.notEqual(forged.status, 0)
    assert.match(forged.stderr, /authoritative --before path must be tests\/test-retention-before\.json/u)

    const result = spawnSync(process.execPath, [
      'tools/test/optimization-report.mjs',
      '--before', 'tests/test-retention-before.json',
      '--after', files.after,
      '--baseline-snapshot', files.baselineSnapshot,
      '--current-snapshot', files.currentSnapshot,
      '--checkpoint', files.checkpoint,
      '--checkpoint', files.mutationCheckpoint,
      '--mutation-evidence', files.mutationEvidence,
      '--out', files.out,
      '--markdown', files.markdown
    ], { cwd: path.resolve('.'), encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    const report = JSON.parse(readFileSync(files.out, 'utf8'))
    assert.equal(report.finalAuthority.status, 'fail')
    assert.equal(report.authoritativeFreshRun, null)
    assert.ok(report.finalAuthority.errors.includes('successful production fresh checkpoint is required'))
  } finally {
    for (const file of Object.values(files)) rmSync(file, { force: true })
  }
})
