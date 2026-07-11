#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { snapshotGitWorktree } from '../test-matrix/scheduler.mjs'
import {
  compactRetentionKey,
  decodeCompactRetentionIndex,
  isCompactRetentionBaseline,
  tierReplacementStructureErrors,
  validateCompactRetentionBaseline
} from '../test-retention/audit.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const authoritativeBeforePath = path.join(repoRoot, 'tests/test-retention-before.json')

const budgetDefinitions = [
  { id: 'ux-viewport-boundaries', maxDurationMs: 20 * 60_000 },
  { id: 'integration', maxDurationMs: 4 * 60_000 },
  { id: 'static-governance', maxDurationMs: 20_000 }
]

function recordIds(audit, hashed = isCompactRetentionBaseline(audit)) {
  if (isCompactRetentionBaseline(audit)) {
    return new Set(decodeCompactRetentionIndex(audit.testIndex, 'before snapshot test index'))
  }
  return new Set((audit?.testRecords ?? [])
    .map((record) => record?.id)
    .filter(Boolean)
    .map((id) => hashed ? compactRetentionKey(id) : id))
}

function assertionTargetIds(audit, hashed = isCompactRetentionBaseline(audit)) {
  if (isCompactRetentionBaseline(audit)) {
    return new Set(decodeCompactRetentionIndex(audit.assertionIndex, 'before snapshot assertion index'))
  }
  return new Set((audit?.testRecords ?? [])
    .flatMap((record) => record?.assertionTargets ?? [])
    .filter(Boolean)
    .map((target) => hashed ? compactRetentionKey(target) : target))
}

function recordDimensionIds(audit, field) {
  if (isCompactRetentionBaseline(audit)) {
    const compactField = field === 'framework' ? 'frameworks' : field
    return new Set((audit?.recordDimensions?.[compactField] ?? []).filter(Boolean))
  }
  return new Set((audit?.testRecords ?? []).flatMap((record) => (
    field === 'framework' ? [record?.framework] : record?.[field] ?? []
  )).filter(Boolean))
}

function compactBaselineIndexSet(index, label) {
  return new Set(decodeCompactRetentionIndex(index, label))
}

function assertionsOwnedByTests(audit, testKeys) {
  if (!isCompactRetentionBaseline(audit)) {
    const records = new Map((audit?.testRecords ?? [])
      .filter((record) => record?.id)
      .map((record) => [record.id, record]))
    return new Set([...testKeys].flatMap((id) => records.get(id)?.assertionTargets ?? []))
  }
  const testValues = decodeCompactRetentionIndex(audit.testIndex, 'before snapshot test index')
  const assertionValues = decodeCompactRetentionIndex(audit.assertionIndex, 'before snapshot assertion index')
  const selected = new Set(testKeys)
  const assertions = new Set()
  for (const [testIndex, , assertionIndexes] of audit.assertionIndex.owners) {
    if (!selected.has(testValues[testIndex])) continue
    for (const assertionIndex of assertionIndexes) assertions.add(assertionValues[assertionIndex])
  }
  return assertions
}

function catalogDimensionIds(audit, field) {
  return new Set((audit?.catalogSnapshot?.[field] ?? []).filter(Boolean))
}

function retainedDimensionProof(before, after) {
  const beforeFrameworks = recordDimensionIds(before, 'framework')
  const afterFrameworks = recordDimensionIds(after, 'framework')
  const beforeRiskTags = recordDimensionIds(before, 'riskTags')
  const afterRiskTags = recordDimensionIds(after, 'riskTags')
  const beforeTierIds = new Set([
    ...recordDimensionIds(before, 'tierIds'),
    ...catalogDimensionIds(before, 'matrixTierIds')
  ])
  const afterTierIds = new Set([
    ...recordDimensionIds(after, 'tierIds'),
    ...catalogDimensionIds(after, 'matrixTierIds')
  ])
  const catalogDimensions = [
    ['MatrixArtifactPaths', 'matrixArtifactPaths'],
    ['MatrixEvidencePaths', 'matrixEvidencePaths'],
    ['ProductionRequiredTierIds', 'productionRequiredTierIds'],
    ['CatalogCoverageIds', 'coverageIds'],
    ['RequirementIds', 'requirementIds'],
    ['RequirementProfileIds', 'requirementProfileIds'],
    ['RequirementEvidencePaths', 'requirementEvidencePaths'],
    ['ReleaseEvidencePaths', 'releaseEvidencePaths']
  ]
  const catalogFieldNames = new Set(catalogDimensions.map(([, field]) => field))
  const afterCatalogSets = new Map(catalogDimensions.map(([, field]) => [field, catalogDimensionIds(after, field)]))
  const beforeCatalogSets = new Map(catalogDimensions.map(([, field]) => [field, catalogDimensionIds(before, field)]))
  const afterCoverageIds = new Set([
    ...catalogDimensionIds(after, 'coverageIds'),
    ...(after?.retainedEvidence?.coverageIds ?? [])
  ])
  const authorizedCatalog = new Map(catalogDimensions.map(([, field]) => [field, new Set()]))
  const invalidTierReplacements = []
  const replacedTierIds = []
  const replacedCatalogDimensions = []
  const seenFrom = new Set()
  for (const replacement of after?.tierReplacements ?? []) {
    const from = String(replacement?.from ?? '')
    const to = String(replacement?.to ?? '')
    const replacementScope = String(replacement?.scope ?? 'tier')
    const reasons = [...tierReplacementStructureErrors(replacement)]
    if (!from || !beforeTierIds.has(from)) reasons.push('from tier did not exist in baseline')
    if (!to || !afterTierIds.has(to)) reasons.push('to tier is not retained after replacement')
    if (replacementScope === 'tier' && afterTierIds.has(from)) reasons.push('from tier still exists after replacement')
    if (replacementScope === 'production-membership') {
      const beforeProduction = beforeCatalogSets.get('productionRequiredTierIds')
      const afterProduction = afterCatalogSets.get('productionRequiredTierIds')
      if (!beforeProduction.has(from)) reasons.push('from tier was not production-required in baseline')
      if (afterProduction.has(from)) reasons.push('from tier is still production-required after replacement')
      if (!afterProduction.has(to)) reasons.push('to tier is not production-required after replacement')
      if (!afterTierIds.has(from)) reasons.push('from tier is not retained as a standalone tier after production-membership replacement')
    }
    if (!String(replacement?.reason ?? '').trim()) reasons.push('reason is empty')
    if (seenFrom.has(from)) reasons.push('from tier is declared more than once')
    seenFrom.add(from)
    const coverageIds = [...new Set(replacement?.coverageIds ?? [])]
    if (coverageIds.length === 0) reasons.push('coverageIds is empty')
    const missingReplacementCoverage = coverageIds.filter((id) => !afterCoverageIds.has(id))
    if (missingReplacementCoverage.length > 0) reasons.push(`replacement coverage ids are missing: ${missingReplacementCoverage.join(', ')}`)

    const pendingCatalog = []
    for (const [field, mappings] of Object.entries(replacement?.catalogReplacements ?? {})) {
      if (!catalogFieldNames.has(field)) {
        continue
      }
      if (!Array.isArray(mappings)) {
        continue
      }
      for (const mapping of mappings) {
        const catalogFrom = String(mapping?.from ?? '')
        const catalogTo = String(mapping?.to ?? '')
        if (!beforeCatalogSets.get(field).has(catalogFrom)) reasons.push(`${field} replacement source did not exist: ${catalogFrom || 'missing'}`)
        if (afterCatalogSets.get(field).has(catalogFrom)) reasons.push(`${field} replacement source still exists: ${catalogFrom}`)
        if (!afterCatalogSets.get(field).has(catalogTo)) reasons.push(`${field} replacement target is not retained: ${catalogTo || 'missing'}`)
        pendingCatalog.push({ field, from: catalogFrom, to: catalogTo })
      }
    }

    if (reasons.length > 0) {
      invalidTierReplacements.push({ from: from || null, to: to || null, reasons })
      continue
    }
    replacedTierIds.push({ from, to, scope: replacementScope, coverageIds, reason: replacement.reason })
    for (const mapping of pendingCatalog) {
      authorizedCatalog.get(mapping.field).add(mapping.from)
      replacedCatalogDimensions.push({ tierFrom: from, ...mapping })
    }
  }
  replacedTierIds.sort((left, right) => left.from.localeCompare(right.from))
  replacedCatalogDimensions.sort((left, right) => left.field.localeCompare(right.field) || left.from.localeCompare(right.from))
  const replacedFromIds = new Set(replacedTierIds.filter((entry) => entry.scope === 'tier').map((entry) => entry.from))
  const catalogProof = Object.fromEntries(catalogDimensions.flatMap(([label, field]) => {
    const beforeIds = catalogDimensionIds(before, field)
    const afterIds = catalogDimensionIds(after, field)
    return [
      [`missing${label}`, [...beforeIds].filter((id) => !afterIds.has(id) && !authorizedCatalog.get(field).has(id)).sort()],
      [`added${label}`, [...afterIds].filter((id) => !beforeIds.has(id)).sort()],
      [`retained${label}`, [...beforeIds].filter((id) => afterIds.has(id)).sort()]
    ]
  }))
  return {
    missingFrameworks: [...beforeFrameworks].filter((id) => !afterFrameworks.has(id)).sort(),
    addedFrameworks: [...afterFrameworks].filter((id) => !beforeFrameworks.has(id)).sort(),
    retainedFrameworks: [...beforeFrameworks].filter((id) => afterFrameworks.has(id)).sort(),
    missingRiskTags: [...beforeRiskTags].filter((id) => !afterRiskTags.has(id)).sort(),
    addedRiskTags: [...afterRiskTags].filter((id) => !beforeRiskTags.has(id)).sort(),
    retainedRiskTags: [...beforeRiskTags].filter((id) => afterRiskTags.has(id)).sort(),
    missingTierIds: [...beforeTierIds].filter((id) => !afterTierIds.has(id) && !replacedFromIds.has(id)).sort(),
    addedTierIds: [...afterTierIds].filter((id) => !beforeTierIds.has(id)).sort(),
    retainedTierIds: [...beforeTierIds].filter((id) => afterTierIds.has(id)).sort(),
    replacedTierIds,
    invalidTierReplacements,
    replacedCatalogDimensions,
    authorizedCatalogReplacementIds: Object.fromEntries([...authorizedCatalog].map(([field, ids]) => [field, [...ids].sort()])),
    ...catalogProof
  }
}

function coveragePercentage(snapshot, metric) {
  const summary = snapshot?.summary ?? snapshot
  const direct = Number(summary?.[`${metric}coverage`])
  if (Number.isFinite(direct)) return direct
  const pct = Number(summary?.[metric === 'line' ? 'lines' : 'branches']?.pct)
  if (Number.isFinite(pct)) return pct
  const totals = snapshot?.totals?.[metric === 'line' ? 'lines' : 'branches']
  const covered = Number(totals?.covered)
  const total = Number(totals?.total)
  return Number.isFinite(covered) && Number.isFinite(total) && total > 0
    ? (covered / total) * 100
    : null
}

function coverageMetricProof(snapshots) {
  const dimensions = {}
  const errors = []
  for (const id of ['backend', 'frontend', 'merged']) {
    const beforeSnapshot = snapshots?.before?.[id]
    const afterSnapshot = snapshots?.after?.[id]
    const before = {
      line: coveragePercentage(beforeSnapshot, 'line'),
      branch: coveragePercentage(beforeSnapshot, 'branch')
    }
    const after = {
      line: coveragePercentage(afterSnapshot, 'line'),
      branch: coveragePercentage(afterSnapshot, 'branch')
    }
    const dimensionErrors = []
    for (const metric of ['line', 'branch']) {
      if (!Number.isFinite(before[metric]) || !Number.isFinite(after[metric])) {
        dimensionErrors.push(`${id} ${metric} coverage snapshot is missing`)
      } else if (after[metric] + Number.EPSILON < before[metric]) {
        dimensionErrors.push(`${id} ${metric} coverage regressed from ${before[metric]} to ${after[metric]}`)
      }
    }
    const missing = dimensionErrors.some((error) => error.includes('snapshot is missing'))
    dimensions[id] = {
      status: dimensionErrors.length === 0 ? 'pass' : missing ? 'not-measured' : 'fail',
      before,
      after,
      delta: {
        line: Number.isFinite(before.line) && Number.isFinite(after.line) ? after.line - before.line : null,
        branch: Number.isFinite(before.branch) && Number.isFinite(after.branch) ? after.branch - before.branch : null
      },
      errors: dimensionErrors
    }
    errors.push(...dimensionErrors)
  }
  const statuses = Object.values(dimensions).map((dimension) => dimension.status)
  return {
    status: statuses.includes('fail') ? 'fail' : statuses.every((status) => status === 'pass') ? 'pass' : 'not-measured',
    dimensions,
    errors
  }
}

export function buildOptimizationSnapshot({
  coverage,
  criticalMutationSlice = null,
  capturedAt = new Date().toISOString()
}) {
  const proof = coverageMetricProof({ before: coverage, after: coverage })
  if (proof.status !== 'pass') {
    throw new Error(`cannot capture incomplete coverage snapshot: ${proof.errors.join('; ')}`)
  }
  const snapshot = {
    schema: 'fsusblog.test-optimization-snapshot.v1',
    capturedAt,
    coverage
  }
  if (criticalMutationSlice) snapshot.criticalMutationSlice = criticalMutationSlice
  return snapshot
}

function mutationScopeFromAudit(audit, hashed = isCompactRetentionBaseline(audit)) {
  if (isCompactRetentionBaseline(audit)) {
    return {
      testIds: decodeCompactRetentionIndex(
        audit?.optimizationEvidence?.criticalMutationSlice?.testIdIndex,
        'before snapshot critical mutation test index'
      ),
      scopeIds: [...new Set(audit?.optimizationEvidence?.criticalMutationSlice?.scopeIds ?? [])].sort()
    }
  }
  const tierIds = new Set()
  const testIds = []
  for (const record of audit?.testRecords ?? []) {
    const mutationTierIds = (record?.tierIds ?? []).filter((id) => (
      id === 'backend-mutation' || id === 'release-mutation-critical-slice'
    ))
    if (mutationTierIds.length === 0) continue
    testIds.push(hashed ? compactRetentionKey(record.id) : record.id)
    for (const id of mutationTierIds) tierIds.add(id)
  }
  return {
    testIds: [...new Set(testIds)].sort(),
    scopeIds: [...tierIds].sort()
  }
}

function flattenMutants(files) {
  return Object.values(files ?? {}).flatMap((file) => file?.mutants ?? [])
}

function mutationScore(snapshot) {
  for (const candidate of [
    snapshot?.score,
    snapshot?.mutationScore,
    snapshot?.summary?.score,
    snapshot?.summary?.mutationScore,
    snapshot?.metrics?.mutationScore
  ]) {
    const numeric = Number(candidate)
    if (Number.isFinite(numeric)) return numeric
  }
  const mutants = flattenMutants(snapshot?.files)
  const detected = mutants.filter((mutant) => /^(killed|timeout|runtimeerror)$/iu.test(String(mutant?.status))).length
  const missed = mutants.filter((mutant) => /^(survived|nocoverage)$/iu.test(String(mutant?.status))).length
  return detected + missed > 0 ? (detected / (detected + missed)) * 100 : null
}

function mutationScope(snapshot) {
  const scope = snapshot?.scope ?? snapshot?.mutate ?? snapshot?.criticalScope
  if (Array.isArray(scope)) return [...new Set(scope.map(String))].sort()
  return []
}

function normalizedMutationSnapshot(snapshot) {
  if (!snapshot) return null
  const mutants = flattenMutants(snapshot.files)
  const score = mutationScore(snapshot)
  const scope = mutationScope(snapshot)
  const mutantCountCandidate = Number(snapshot.mutantCount ?? snapshot.totalMutants)
  return {
    score,
    scope,
    sliceId: String(snapshot.sliceId ?? snapshot.criticalSliceId ?? ''),
    mutantCount: Number.isFinite(mutantCountCandidate) ? mutantCountCandidate : mutants.length,
    executedMutants: Number(snapshot.executedMutants ?? 0),
    schema: snapshot.schema ?? null,
    status: snapshot.status ?? null,
    tierId: snapshot.tierId ?? null,
    thresholds: snapshot.thresholds ?? null,
    rawReport: snapshot.rawReport ?? null,
    config: snapshot.config ?? null,
    producer: snapshot.producer ?? null
  }
}

function criticalMutationProof(beforeAudit, afterAudit, snapshots, finalAuthority = false) {
  const hashed = isCompactRetentionBaseline(beforeAudit)
  const beforeTestIds = recordIds(beforeAudit, hashed)
  const afterTestIds = recordIds(afterAudit, hashed)
  const actualDeletions = [...beforeTestIds].filter((id) => !afterTestIds.has(id)).sort()
  const beforeIdentity = mutationScopeFromAudit(beforeAudit, hashed)
  const afterIdentity = mutationScopeFromAudit(afterAudit, hashed)
  const criticalTestIds = new Set(beforeIdentity.testIds)
  const criticalDeletions = actualDeletions.filter((id) => criticalTestIds.has(id))

  if (criticalDeletions.length === 0 && beforeIdentity.testIds.length > 0 && beforeIdentity.scopeIds.length > 0) {
    const missingTestIds = beforeIdentity.testIds.filter((id) => !afterIdentity.testIds.includes(id))
    const addedTestIds = afterIdentity.testIds.filter((id) => !beforeIdentity.testIds.includes(id))
    const missingScope = beforeIdentity.scopeIds.filter((id) => !afterIdentity.scopeIds.includes(id))
    const addedScope = afterIdentity.scopeIds.filter((id) => !beforeIdentity.scopeIds.includes(id))
    const exact = missingTestIds.length === 0 && addedTestIds.length === 0 && missingScope.length === 0 && addedScope.length === 0
    if (!finalAuthority) {
      return {
        status: exact ? 'pass' : 'fail',
        evidenceMode: 'scope-identity',
        before: beforeIdentity,
        after: afterIdentity,
        missingTestIds,
        addedTestIds,
        missingScope,
        addedScope,
        actualDeletionCount: actualDeletions.length,
        criticalDeletionCount: 0,
        outOfScopeDeletionIds: actualDeletions,
        errors: exact ? [] : ['critical mutation slice test/scope ids changed without a critical-scope test deletion']
      }
    }

    const executed = normalizedMutationSnapshot(snapshots?.after)
    const errors = []
    if (!exact) errors.push('critical mutation slice test/scope ids changed without a critical-scope test deletion')
    if (!executed || !Number.isFinite(executed.score)) {
      errors.push('source-bound current critical mutation evidence is missing')
    } else {
      if (executed.schema !== 'fsusblog.stryker-authority.v1' || executed.status !== 'success') {
        errors.push('current critical mutation evidence schema/status is invalid')
      }
      if (executed.tierId !== 'release-mutation-critical-slice') {
        errors.push('current critical mutation evidence is bound to the wrong tier')
      }
      if (!Number.isFinite(executed.executedMutants) || executed.executedMutants <= 0) {
        errors.push('current critical mutation evidence executed no mutants')
      }
      if (executed.scope.length === 0) errors.push('current critical mutation scope is missing')
      const breakThreshold = Number(executed.thresholds?.break)
      if (!Number.isFinite(breakThreshold) || executed.score + Number.EPSILON < breakThreshold) {
        errors.push('current critical mutation score does not satisfy the configured break threshold')
      }
      if (!/^(?:sha256:)?[0-9a-f]{64}$/u.test(String(executed.rawReport?.sha256 ?? ''))
        || !/^(?:sha256:)?[0-9a-f]{64}$/u.test(String(executed.config?.sha256 ?? ''))) {
        errors.push('current critical mutation raw/config digests are missing')
      }
      const beforeScore = mutationScore(snapshots?.before)
      if (Number.isFinite(beforeScore)) {
        if (executed.score + Number.EPSILON < beforeScore) {
          errors.push(`critical mutation slice score regressed from ${beforeScore} to ${executed.score}`)
        }
      } else if (executed.score + Number.EPSILON < 100) {
        errors.push('critical mutation baseline score is missing and current score is not the non-regressing maximum')
      }
    }
    return {
      status: errors.length === 0 ? 'pass' : executed ? 'fail' : 'not-measured',
      evidenceMode: 'executed-current-slice',
      before: beforeIdentity,
      after: executed,
      missingTestIds,
      addedTestIds,
      missingScope,
      addedScope,
      actualDeletionCount: actualDeletions.length,
      criticalDeletionCount: 0,
      outOfScopeDeletionIds: actualDeletions,
      errors
    }
  }

  const before = normalizedMutationSnapshot(snapshots?.before)
  const after = normalizedMutationSnapshot(snapshots?.after)
  if (!before || !after || !Number.isFinite(before.score) || !Number.isFinite(after.score)) {
    return {
      status: 'not-measured',
      evidenceMode: 'mutation-score',
      before,
      after,
      missingScope: [],
      actualDeletionCount: actualDeletions.length,
      criticalDeletionCount: criticalDeletions.length,
      outOfScopeDeletionIds: actualDeletions.filter((id) => !criticalTestIds.has(id)),
      errors: ['critical mutation slice before/after score evidence is missing']
    }
  }

  const missingScope = before.scope.filter((id) => !after.scope.includes(id))
  const hasComparableScope = before.scope.length > 0 && after.scope.length > 0
  const hasMatchingSliceId = Boolean(before.sliceId) && before.sliceId === after.sliceId
  const errors = []
  if (after.score + Number.EPSILON < before.score) {
    errors.push(`critical mutation slice score regressed from ${before.score} to ${after.score}`)
  }
  if (!hasComparableScope && !hasMatchingSliceId) errors.push('critical mutation slice scope evidence is missing')
  if (missingScope.length > 0) errors.push(`critical mutation slice scope regressed: ${missingScope.join(', ')}`)
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    evidenceMode: 'mutation-score',
    before,
    after,
    missingScope,
    actualDeletionCount: actualDeletions.length,
    criticalDeletionCount: criticalDeletions.length,
    outOfScopeDeletionIds: actualDeletions.filter((id) => !criticalTestIds.has(id)),
    errors
  }
}

function deletionProof(before, after) {
  const hashed = isCompactRetentionBaseline(before)
  const beforeIds = recordIds(before, hashed)
  const afterIds = recordIds(after, hashed)
  const removedTestIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort()
  const declarations = new Map((after?.deletedTests ?? [])
    .filter((entry) => entry?.id)
    .map((entry) => [hashed ? compactRetentionKey(entry.id) : entry.id, entry]))
  const baselineDeclarationIds = hashed
    ? compactBaselineIndexSet(
        before?.replacementManifestBaseline?.deletedTestIndex,
        'before snapshot historical deletion index'
      )
    : new Set(before?.replacementManifestBaseline?.deletedTestIds ?? [])
  const invalidDeclarations = []
  const validDeletedTestIds = []
  const historicalDeclarationIds = []

  for (const id of removedTestIds) {
    const declaration = declarations.get(id)
    if (!declaration) continue
    const replacements = [...new Set(declaration.replacementTestIds ?? [])]
    const missingReplacementTestIds = replacements.filter((replacement) => (
      !afterIds.has(hashed ? compactRetentionKey(replacement) : replacement)
    ))
    const reasons = []
    if (replacements.length === 0) reasons.push('replacementTestIds is empty')
    if (missingReplacementTestIds.length > 0) reasons.push(`replacement tests are missing: ${missingReplacementTestIds.join(', ')}`)
    if (!String(declaration.reason ?? '').trim()) reasons.push('reason is empty')
    if (reasons.length > 0) {
      invalidDeclarations.push({ id, reasons, replacementTestIds: replacements })
    } else {
      validDeletedTestIds.push(id)
    }
  }

  for (const [id, declaration] of declarations) {
    if (baselineDeclarationIds.has(id) || (!beforeIds.has(id) && !afterIds.has(id))) {
      historicalDeclarationIds.push(id)
      continue
    }
    if (!beforeIds.has(id) || afterIds.has(id)) {
      invalidDeclarations.push({
        id: declaration.id,
        reasons: [!beforeIds.has(id) ? 'test id did not exist in baseline' : 'test id still exists after the claimed deletion'],
        replacementTestIds: [...new Set(declaration.replacementTestIds ?? [])]
      })
    }
  }

  const undeclaredTestIds = removedTestIds.filter((id) => !declarations.has(id))
  const activeDeclarationCount = declarations.size - historicalDeclarationIds.length
  const status = removedTestIds.length === 0 && activeDeclarationCount === 0
    ? 'not-applicable'
    : undeclaredTestIds.length === 0 && invalidDeclarations.length === 0 ? 'pass' : 'fail'

  return {
    status,
    removedTestIds,
    validDeletedTestIds: validDeletedTestIds.sort(),
    undeclaredTestIds,
    invalidDeclarations,
    historicalDeclarationIds: historicalDeclarationIds.sort(),
    deletedTests: [...declarations.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}

function assertionReplacementProof(before, after) {
  const hashed = isCompactRetentionBaseline(before)
  const beforeTargets = assertionTargetIds(before, hashed)
  const afterTargets = assertionTargetIds(after, hashed)
  const afterTestIds = recordIds(after, hashed)
  const declarations = after?.assertionReplacements ?? []
  const baselineBeforeTargets = hashed
    ? compactBaselineIndexSet(
        before?.replacementManifestBaseline?.assertionBeforeIndex,
        'before snapshot historical assertion index'
      )
    : new Set(before?.replacementManifestBaseline?.assertionBeforeTargets ?? [])
  const validBeforeTargets = []
  const invalidDeclarations = []
  const historicalBeforeTargets = []
  for (const declaration of declarations) {
    const beforeKey = hashed ? compactRetentionKey(declaration?.before) : declaration?.before
    if (baselineBeforeTargets.has(beforeKey)
      || (!beforeTargets.has(beforeKey) && !afterTargets.has(beforeKey))) {
      historicalBeforeTargets.push(beforeKey)
      continue
    }
    const reasons = []
    const replacements = [...new Set(declaration?.replacementTestIds ?? [])]
    const afterAssertionTargets = [...new Set(declaration?.after ?? [])]
    if (!beforeTargets.has(beforeKey)) reasons.push('before assertion target did not exist in baseline')
    if (afterTargets.has(beforeKey)) reasons.push('before assertion target still exists after the claimed replacement')
    if (!String(declaration?.reason ?? '').trim()) reasons.push('reason is empty')
    if (replacements.length === 0) reasons.push('replacementTestIds is empty')
    const missingReplacementTestIds = replacements.filter((id) => (
      !afterTestIds.has(hashed ? compactRetentionKey(id) : id)
    ))
    if (missingReplacementTestIds.length > 0) reasons.push(`replacement tests are missing: ${missingReplacementTestIds.join(', ')}`)
    if (afterAssertionTargets.length === 0) reasons.push('after assertion targets are empty')
    const missingAfterTargets = afterAssertionTargets.filter((target) => (
      !afterTargets.has(hashed ? compactRetentionKey(target) : target)
    ))
    if (missingAfterTargets.length > 0) reasons.push(`replacement assertion targets are missing: ${missingAfterTargets.join(', ')}`)
    if (reasons.length > 0) invalidDeclarations.push({ before: declaration?.before ?? null, reasons })
    else validBeforeTargets.push(beforeKey)
  }
  return {
    status: declarations.length === historicalBeforeTargets.length
      ? 'not-applicable'
      : invalidDeclarations.length === 0 ? 'pass' : 'fail',
    validBeforeTargets: [...new Set(validBeforeTargets)].sort(),
    invalidDeclarations,
    historicalBeforeTargets: [...new Set(historicalBeforeTargets)].sort(),
    replacements: declarations
  }
}

function coverageProof(before, after, deletionSafety, assertionReplacementSafety) {
  const beforeIds = new Set(before?.retainedEvidence?.coverageIds ?? [])
  const afterIds = new Set(after?.retainedEvidence?.coverageIds ?? [])
  const dimensions = retainedDimensionProof(before, after)
  const authorizedCoverageIds = new Set(dimensions.authorizedCatalogReplacementIds?.coverageIds ?? [])
  const missingCoverageIds = [...beforeIds].filter((id) => !afterIds.has(id) && !authorizedCoverageIds.has(id)).sort()
  const addedCoverageIds = [...afterIds].filter((id) => !beforeIds.has(id)).sort()
  const hashed = isCompactRetentionBaseline(before)
  const beforeTestIds = recordIds(before, hashed)
  const afterTestIds = recordIds(after, hashed)
  const authorizedDeletedIds = new Set(deletionSafety.validDeletedTestIds)
  const missingTestIds = [...beforeTestIds]
    .filter((id) => !afterTestIds.has(id) && !authorizedDeletedIds.has(id))
    .sort()
  const addedTestIds = [...afterTestIds].filter((id) => !beforeTestIds.has(id)).sort()
  const beforeAssertionTargets = assertionTargetIds(before, hashed)
  const afterAssertionTargets = assertionTargetIds(after, hashed)
  const authorizedAssertionReplacements = new Set(assertionReplacementSafety.validBeforeTargets)
  const assertionsCoveredByDeletedTests = assertionsOwnedByTests(before, authorizedDeletedIds)
  const missingAssertionTargets = [...beforeAssertionTargets]
    .filter((target) => !afterAssertionTargets.has(target)
      && !authorizedAssertionReplacements.has(target)
      && !assertionsCoveredByDeletedTests.has(target))
    .sort()
  const addedAssertionTargets = [...afterAssertionTargets].filter((target) => !beforeAssertionTargets.has(target)).sort()
  const beforeTargets = Number(before?.retainedEvidence?.uniqueAssertionTargetCount ?? 0)
  const afterTargets = Number(after?.retainedEvidence?.uniqueAssertionTargetCount ?? 0)
  const beforeTests = Number(before?.retainedEvidence?.testRecordCount ?? 0)
  const afterTests = Number(after?.retainedEvidence?.testRecordCount ?? 0)
  const notWeaker = missingCoverageIds.length === 0
    && missingTestIds.length === 0
    && missingAssertionTargets.length === 0
    && deletionSafety.status !== 'fail'
    && assertionReplacementSafety.status !== 'fail'
    && dimensions.missingFrameworks.length === 0
    && dimensions.missingRiskTags.length === 0
    && dimensions.missingTierIds.length === 0
    && dimensions.invalidTierReplacements.length === 0
    && dimensions.missingMatrixArtifactPaths.length === 0
    && dimensions.missingMatrixEvidencePaths.length === 0
    && dimensions.missingProductionRequiredTierIds.length === 0
    && dimensions.missingCatalogCoverageIds.length === 0
    && dimensions.missingRequirementIds.length === 0
    && dimensions.missingRequirementProfileIds.length === 0
    && dimensions.missingRequirementEvidencePaths.length === 0
    && dimensions.missingReleaseEvidencePaths.length === 0
    && afterTargets >= beforeTargets
    && afterTests + deletionSafety.validDeletedTestIds.length >= beforeTests
  const stronger = notWeaker && (addedCoverageIds.length > 0 || afterTargets > beforeTargets || afterTests > beforeTests)
  return {
    status: stronger ? 'stronger' : notWeaker ? 'same' : 'weaker',
    missingCoverageIds,
    addedCoverageIds,
    missingTestIds,
    addedTestIds,
    missingAssertionTargets,
    assertionsCoveredByDeletedTests: [...assertionsCoveredByDeletedTests].sort(),
    addedAssertionTargets,
    dimensions,
    before: { coverageIdCount: beforeIds.size, uniqueAssertionTargetCount: beforeTargets, testRecordCount: beforeTests },
    after: { coverageIdCount: afterIds.size, uniqueAssertionTargetCount: afterTargets, testRecordCount: afterTests }
  }
}

function completeCandidateReview(review) {
  if (!review || review.reviewed !== true) return false
  if (!['retain', 'replaceable'].includes(review.decision)) return false
  if (!String(review.path ?? '').trim() || !String(review.reason ?? '').trim()) return false
  if (!Array.isArray(review.testIds) || review.testIds.length === 0) return false
  if (!Array.isArray(review.tests) || review.tests.length !== review.testIds.length) return false
  if (review.decision === 'replaceable' && (!Array.isArray(review.replacementTestIds) || review.replacementTestIds.length === 0)) return false
  return review.tests.every((record) => (
    String(record?.id ?? '').trim()
    && String(record?.framework ?? '').trim()
    && Array.isArray(record?.tierIds)
    && Number.isInteger(record?.tierInvocationCount)
    && record.tierInvocationCount >= 0
    && Number.isInteger(record?.timing?.samples)
    && Object.hasOwn(record.timing, 'p50Ms')
    && Object.hasOwn(record.timing, 'p95Ms')
    && Array.isArray(record?.coverageIds)
    && Array.isArray(record?.assertionTargets)
    && record.assertionTargets.length > 0
    && Number.isInteger(record?.failureHistory?.runs)
    && Number.isInteger(record?.failureHistory?.failures)
    && Object.hasOwn(record.failureHistory, 'lastFailureAt')
    && typeof record?.uniqueEvidence === 'boolean'
    && Array.isArray(record?.replacementTestIds)
    && (record.uniqueEvidence || record.replacementTestIds.length > 0)
  ))
}

function retentionReview(after) {
  const reviews = after?.candidateReviews ?? []
  const candidatePaths = Array.isArray(after?.reviewCandidates)
    ? after.reviewCandidates
    : reviews.map((review) => review?.path).filter(Boolean)
  const reviewsByPath = new Map(reviews.map((review) => [review?.path, review]))
  const incompleteCandidates = [...new Set(candidatePaths)]
    .filter((candidate) => !completeCandidateReview(reviewsByPath.get(candidate)))
    .sort()
  return {
    reviewedCandidates: new Set(candidatePaths).size - incompleteCandidates.length,
    unreviewedCandidates: incompleteCandidates.length,
    incompleteCandidates,
    replaceableCandidates: after?.replaceableCandidates ?? [],
    deletedCandidates: after?.deletedCandidates ?? []
  }
}

function checkpointTimestamp(checkpoint) {
  return Date.parse(checkpoint?.updatedAt ?? checkpoint?.generatedAt ?? checkpoint?.startedAt ?? '') || 0
}

function freshCheckpoints(checkpoints) {
  return [...checkpoints]
    .filter((checkpoint) => checkpoint?.mode === 'fresh' || checkpoint?.fresh === true)
    .sort((left, right) => checkpointTimestamp(right) - checkpointTimestamp(left))
}

function isProductionCheckpoint(checkpoint) {
  return checkpointTarget(checkpoint) === 'production'
}

function checkpointTarget(checkpoint) {
  return checkpoint?.target ?? checkpoint?.targetTier ?? checkpoint?.targetTierId ?? null
}

function selectAuthoritativeCheckpoint(checkpoints, finalAuthority) {
  const fresh = freshCheckpoints(checkpoints)
  const production = fresh.find(isProductionCheckpoint) ?? null
  return finalAuthority ? production : production ?? fresh[0] ?? null
}

function completedEntries(checkpoint) {
  const projected = checkpoint?.logicalTierProjection?.entries
  const source = projected && typeof projected === 'object'
    ? projected
    : (checkpoint?.tiers ?? checkpoint?.completed ?? {})
  return Object.entries(source)
    .map(([id, value]) => ({
      id,
      durationMs: Number(value?.durationMs ?? 0),
      status: value?.status ?? 'success',
      evidenceKind: value?.evidenceKind ?? 'executed',
      reused: value?.reused === true,
      fingerprint: value?.fingerprint ?? value?.inputFingerprint ?? null,
      log: value?.log ?? value?.logFile ?? null
    }))
    .filter((entry) => entry.evidenceKind === 'executed' && Number.isFinite(entry.durationMs) && entry.durationMs >= 0)
}

function logicalProjectionProof({ required, authoritative, expectedTierIds }) {
  if (!required) return { required: false, status: 'compatibility', errors: [] }
  const physicalTierIds = Object.keys(authoritative?.tiers ?? {}).filter((id) => id.startsWith('local-production-'))
  if (physicalTierIds.length === 0) {
    return { required: false, status: 'compatibility', errors: [] }
  }
  const errors = []
  const projection = authoritative?.logicalTierProjection
  const entries = projection?.entries && typeof projection.entries === 'object' ? projection.entries : {}
  const entryIds = Object.keys(entries).sort()
  const declaredIds = Array.isArray(projection?.logicalTierIds) ? [...projection.logicalTierIds].sort() : []
  const expected = [...new Set(expectedTierIds ?? [])].sort()
  if (projection?.schema !== 'fsusblog.local-profile-projection.v1'
    || projection?.profileId !== 'production'
    || projection?.executionSource !== 'fresh'
    || projection?.status !== 'success') {
    errors.push('production logical tier projection schema/status is invalid')
  }
  if (String(projection?.runId ?? '') !== String(authoritative?.runId ?? '')) {
    errors.push('production logical tier projection run id does not match its checkpoint')
  }
  if (!sameSourceState(projection?.sourceState, authoritative?.sourceState)) {
    errors.push('production logical tier projection source state does not match its checkpoint')
  }
  if (Number(projection?.logicalTierCount) !== expected.length
    || expected.length !== 77
    || JSON.stringify(declaredIds) !== JSON.stringify(expected)
    || JSON.stringify(entryIds) !== JSON.stringify(expected)) {
    errors.push('production logical tier projection must cover the exact 77-tier closure once')
  }
  let executedTierCount = 0
  let summaryOnlyTierCount = 0
  for (const [tierId, entry] of Object.entries(entries)) {
    if (entry?.tierId !== tierId) errors.push(`${tierId} projection key/id mismatch`)
    if (entry?.evidenceKind === 'executed') {
      executedTierCount += 1
      if (entry.status !== 'success' || entry.executionSource !== 'fresh') errors.push(`${tierId} executed projection is not successful fresh evidence`)
      if (!Number.isFinite(Number(entry.durationMs)) || Number(entry.durationMs) < 0) errors.push(`${tierId} executed projection duration is invalid`)
      if (!String(entry.physicalBundleId ?? '')) errors.push(`${tierId} executed projection is missing its physical bundle`)
      if (!Array.isArray(entry.testIds) || entry.testIds.length === 0) errors.push(`${tierId} executed projection has no test ids`)
    } else if (entry?.evidenceKind === 'summary-only') {
      summaryOnlyTierCount += 1
      if (entry.status !== 'collected-blocked' || entry.executionSource !== 'external-environment') {
        errors.push(`${tierId} summary-only projection must remain explicit collected-blocked external evidence`)
      }
    } else {
      errors.push(`${tierId} projection evidenceKind is invalid`)
    }
    const digests = Object.values(entry?.artifactDigests ?? {})
    if (digests.length === 0 || digests.some((digest) => !/^sha256:[0-9a-f]{64}$/u.test(String(digest)))) {
      errors.push(`${tierId} projection artifact digests are missing or invalid`)
    }
  }
  if (executedTierCount !== 76
    || summaryOnlyTierCount !== 1
    || Number(projection?.executedTierCount) !== executedTierCount
    || Number(projection?.summaryOnlyTierCount) !== summaryOnlyTierCount) {
    errors.push('production logical tier projection must contain 76 executed and 1 summary-only tier')
  }
  return {
    required: true,
    status: errors.length === 0 ? 'pass' : 'fail',
    physicalTierIds,
    logicalTierCount: entryIds.length,
    executedTierCount,
    summaryOnlyTierCount,
    errors
  }
}

function performanceBudgets(checkpoints, authoritative) {
  const fresh = freshCheckpoints(checkpoints)
  const authoritativeEntries = new Map(
    authoritative?.status === 'success'
      ? completedEntries(authoritative).map((entry) => [entry.id, entry])
      : []
  )
  return budgetDefinitions.map((budget) => {
    const fallbackCheckpoint = fresh.find((checkpoint) => (
      checkpoint?.status === 'success'
      && checkpointTarget(checkpoint) === budget.id
      && completedEntries(checkpoint).some((entry) => entry.id === budget.id)
    ))
    const fallbackEntry = fallbackCheckpoint
      ? completedEntries(fallbackCheckpoint).find((entry) => entry.id === budget.id)
      : null
    const entry = authoritativeEntries.get(budget.id) ?? fallbackEntry
    const actualDurationMs = entry?.durationMs
    const measured = Number.isFinite(actualDurationMs)
    const successful = entry?.status === 'success'
    return {
      ...budget,
      actualDurationMs: actualDurationMs ?? null,
      tierStatus: entry?.status ?? null,
      checkpointRunId: authoritativeEntries.has(budget.id)
        ? authoritative?.runId ?? null
        : fallbackCheckpoint?.runId ?? null,
      status: !measured
        ? 'not-measured'
        : successful && actualDurationMs <= budget.maxDurationMs ? 'pass' : 'fail'
    }
  })
}

function sameSourceState(left, right) {
  return Boolean(left && right)
    && String(left.commit ?? '') === String(right.commit ?? '')
    && String(left.worktreeFingerprint ?? '') === String(right.worktreeFingerprint ?? '')
}

function mutationAuthorityProof({ required, evidence, checkpoints, currentSourceState }) {
  if (!required) return { required: false, status: 'compatibility', errors: [] }
  const errors = []
  const tierId = 'release-mutation-critical-slice'
  const checkpoint = freshCheckpoints(checkpoints).find((candidate) => checkpointTarget(candidate) === tierId)
  const tier = checkpoint?.tiers?.[tierId] ?? checkpoint?.completed?.[tierId]
  if (!checkpoint || checkpoint.status !== 'success') {
    errors.push('successful release-mutation-critical-slice fresh checkpoint is required')
  } else if (!tier || tier.status !== 'success' || tier.reused === true) {
    errors.push('release-mutation-critical-slice checkpoint must contain a non-reused successful tier result')
  }
  if (evidence?.schema !== 'fsusblog.stryker-authority.v1'
    || evidence?.status !== 'success'
    || evidence?.tierId !== tierId) {
    errors.push('source-bound Stryker authority evidence is missing or invalid')
  }
  const producer = evidence?.producer
  if (!producer || String(producer.runId ?? '') !== String(checkpoint?.runId ?? '')) {
    errors.push('Stryker authority run id does not match the mutation checkpoint')
  }
  if (!sameSourceState(producer?.sourceState, checkpoint?.sourceState)) {
    errors.push('Stryker authority source state does not match the mutation checkpoint')
  }
  if (currentSourceState && !sameSourceState(producer?.sourceState, currentSourceState)) {
    errors.push('Stryker authority was not produced from the current repository source state')
  }
  return {
    required: true,
    status: errors.length === 0 ? 'pass' : 'fail',
    checkpointRunId: checkpoint?.runId ?? null,
    producer: producer ?? null,
    errors
  }
}

function retentionAuditAuthorityProof({ required, authoritative, after }) {
  if (!required) return { required: false, status: 'compatibility', errors: [] }
  const errors = []
  const producer = after?.producer
  const authoritativeRunId = String(authoritative?.runId ?? '')
  const producerRunId = String(producer?.runId ?? '')
  const checkpointFinishedAt = authoritative?.finishedAt ?? null
  const auditGeneratedAt = producer?.generatedAt ?? null
  const checkpointFinishedTimestamp = Date.parse(checkpointFinishedAt ?? '')
  const auditGeneratedTimestamp = Date.parse(auditGeneratedAt ?? '')

  if (!producer) {
    errors.push('retention audit producer metadata is missing')
  } else if (!producerRunId) {
    errors.push('retention audit producer run id is missing')
  } else if (!authoritativeRunId || producerRunId !== authoritativeRunId) {
    errors.push(`retention audit run ${producerRunId} does not match authoritative run ${authoritativeRunId || 'missing'}`)
  }
  if (!Number.isFinite(checkpointFinishedTimestamp)) {
    errors.push('authoritative production checkpoint finishedAt is missing or invalid')
  }
  if (!Number.isFinite(auditGeneratedTimestamp)) {
    errors.push('retention audit producer generatedAt is missing or invalid')
  } else if (Number.isFinite(checkpointFinishedTimestamp) && auditGeneratedTimestamp < checkpointFinishedTimestamp) {
    errors.push('retention audit was generated before production checkpoint completed')
  }
  if (producer && String(after?.generatedAt ?? '') !== String(auditGeneratedAt ?? '')) {
    errors.push('retention audit root and producer generatedAt values do not match')
  }

  return {
    required: true,
    status: errors.length === 0 ? 'pass' : 'fail',
    runId: producer?.runId ?? null,
    generatedAt: auditGeneratedAt,
    checkpointFinishedAt,
    errors
  }
}

function baselineAuthorityProof({ required, before }) {
  if (!required) return { required: false, status: 'compatibility', errors: [] }
  const errors = []
  if (!isCompactRetentionBaseline(before) && before?.schema !== 'fsusblog.test-retention-audit.v2') {
    errors.push('before snapshot schema is missing or unsupported')
  }
  if (before?.snapshotRole !== 'before-test-reduction') {
    errors.push('before snapshot role must be before-test-reduction')
  }
  if (!/^[0-9a-f]{40}$/u.test(String(before?.sourceState?.commit ?? ''))) {
    errors.push('before snapshot commit binding is missing or invalid')
  }
  if (!/^[0-9a-f]{64}$/u.test(String(before?.sourceState?.worktreeFingerprint ?? ''))) {
    errors.push('before snapshot worktree fingerprint binding is missing or invalid')
  }
  if (isCompactRetentionBaseline(before)) {
    try {
      decodeCompactRetentionIndex(before?.testIndex, 'before snapshot test index')
      decodeCompactRetentionIndex(before?.assertionIndex, 'before snapshot assertion index')
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  } else if (!Number.isFinite(Date.parse(before?.generatedAt ?? ''))) {
    errors.push('before snapshot generatedAt is missing or invalid')
  }
  for (const field of [
    'matrixTierIds',
    'productionRequiredTierIds',
    'matrixArtifactPaths',
    'matrixEvidencePaths',
    'coverageIds',
    'requirementIds',
    'releaseEvidencePaths'
  ]) {
    if (!Array.isArray(before?.catalogSnapshot?.[field])) {
      errors.push(`before snapshot catalog ${field} is missing`)
    }
  }
  if (isCompactRetentionBaseline(before)) {
    for (const [field, label] of [
      ['deletedTestIndex', 'historical deletion index'],
      ['assertionBeforeIndex', 'historical assertion index']
    ]) {
      try {
        decodeCompactRetentionIndex(before?.replacementManifestBaseline?.[field], `before snapshot ${label}`)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (!Array.isArray(before?.replacementManifestBaseline?.tierFromIds)) {
      errors.push('before snapshot replacement manifest baseline tierFromIds is missing')
    }
  } else {
    for (const field of ['deletedTestIds', 'assertionBeforeTargets', 'tierFromIds']) {
      if (!Array.isArray(before?.replacementManifestBaseline?.[field])) {
        errors.push(`before snapshot replacement manifest baseline ${field} is missing`)
      }
    }
  }
  return {
    required: true,
    status: errors.length === 0 ? 'pass' : 'fail',
    sourceState: before?.sourceState ?? null,
    generatedAt: before?.generatedAt ?? null,
    errors
  }
}

function sourceAuthorityProof({ authoritative, checkpoints, budgets, coverageSnapshots, after, currentSourceState }) {
  if (!currentSourceState) return { status: 'not-measured', errors: [] }
  const errors = []
  const requiredRunIds = new Set([
    authoritative?.runId,
    ...budgets.map((budget) => budget.checkpointRunId)
  ].filter(Boolean))
  for (const runId of requiredRunIds) {
    const checkpoint = checkpoints.find((candidate) => candidate?.runId === runId)
    if (!sameSourceState(checkpoint?.sourceState, currentSourceState)) {
      errors.push(`checkpoint ${runId} does not match the current repository source state`)
    }
  }
  for (const id of ['backend', 'frontend', 'merged']) {
    const producer = coverageSnapshots?.after?.[id]?.producer
    if (!producer
      || String(producer.runId ?? '') !== String(authoritative?.runId ?? '')
      || String(producer.sourceCommit ?? '') !== String(currentSourceState.commit ?? '')
      || String(producer.sourceFingerprint ?? '') !== String(currentSourceState.worktreeFingerprint ?? '')) {
      errors.push(`${id} coverage was not produced from the authoritative repository source state`)
    }
  }
  if (!sameSourceState(after?.producer?.sourceState, currentSourceState)) {
    errors.push('retention audit was not produced from the authoritative repository source state')
  }
  if (!sameSourceState(after?.sourceState, after?.producer?.sourceState)) {
    errors.push('retention audit root and producer source states do not match')
  }
  return { status: errors.length === 0 ? 'pass' : 'fail', currentSourceState, errors }
}

function finalAuthorityProof({
  required,
  authoritative,
  budgets,
  coverageMetrics,
  criticalMutationSlice,
  retainedCoverage,
  deletionSafety,
  assertionReplacementSafety,
  retention,
  baselineAuthority,
  retentionAuditAuthority,
  sourceAuthority,
  mutationAuthority,
  logicalProjection
}) {
  if (!required) return { required: false, status: 'compatibility', errors: [] }
  const errors = []
  if (!authoritative || !isProductionCheckpoint(authoritative) || authoritative.status !== 'success') {
    errors.push('successful production fresh checkpoint is required')
  }
  for (const budget of budgets) {
    if (budget.status !== 'pass') errors.push(`${budget.id} performance budget is ${budget.status}`)
  }
  if (coverageMetrics.status !== 'pass') errors.push(...coverageMetrics.errors)
  if (criticalMutationSlice.status !== 'pass') errors.push(...criticalMutationSlice.errors)
  if (retainedCoverage.status === 'weaker') errors.push('retained test coverage is weaker than baseline')
  if (deletionSafety.status === 'fail') errors.push('test deletion safety proof failed')
  if (assertionReplacementSafety.status === 'fail') errors.push('assertion replacement safety proof failed')
  if (retention.unreviewedCandidates > 0) errors.push(`${retention.unreviewedCandidates} retention candidates remain unreviewed`)
  if (baselineAuthority.status === 'fail') errors.push(...baselineAuthority.errors)
  if (retentionAuditAuthority.status === 'fail') errors.push(...retentionAuditAuthority.errors)
  if (sourceAuthority.status === 'fail') errors.push(...sourceAuthority.errors)
  if (mutationAuthority.status === 'fail') errors.push(...mutationAuthority.errors)
  if (logicalProjection.status === 'fail') errors.push(...logicalProjection.errors)
  return { required: true, status: errors.length === 0 ? 'pass' : 'fail', errors: [...new Set(errors)] }
}

function viewportEvidence(summaries) {
  return Object.fromEntries(summaries.map((summary) => [summary.mode, {
    status: summary.status,
    caseCount: Number(summary.caseCount ?? summary.cases ?? summary.plannedCaseCount ?? 0),
    navigationCount: Number(summary.navigationCount ?? summary.navigations ?? summary.plannedNavigationCount ?? 0),
    groupCount: Number(summary.groupCount ?? summary.groups ?? summary.plannedRouteThemeGroupCount ?? 0),
    completedGroupCount: Number(summary.completedGroupCount ?? summary.completedGroups ?? summary.completedRouteThemeGroupCount ?? 0),
    failedGroupCount: Number(summary.failedGroupCount ?? summary.failedGroups ?? summary.failedRouteThemeGroupCount ?? 0)
  }]))
}

export function buildOptimizationReport({
  before,
  after,
  checkpoints = [],
  viewportSummaries = [],
  coverageSnapshots = null,
  mutationSnapshots = null,
  finalAuthority = false,
  currentSourceState = null
}) {
  const authoritative = selectAuthoritativeCheckpoint(checkpoints, finalAuthority)
  const deletionSafety = deletionProof(before, after)
  const assertionReplacementSafety = assertionReplacementProof(before, after)
  const retainedCoverage = coverageProof(before, after, deletionSafety, assertionReplacementSafety)
  const coverageMetrics = coverageMetricProof(coverageSnapshots ?? {
    before: before?.optimizationEvidence?.coverage ?? before?.retainedEvidence?.coverageSnapshots,
    after: after?.optimizationEvidence?.coverage ?? after?.retainedEvidence?.coverageSnapshots
  })
  const criticalMutationSlice = criticalMutationProof(before, after, mutationSnapshots ?? {
    before: before?.optimizationEvidence?.criticalMutationSlice,
    after: after?.optimizationEvidence?.criticalMutationSlice
  }, finalAuthority)
  const mutationAuthority = mutationAuthorityProof({
    required: finalAuthority,
    evidence: mutationSnapshots?.after ?? null,
    checkpoints,
    currentSourceState
  })
  const logicalProjection = logicalProjectionProof({
    required: finalAuthority,
    authoritative,
    expectedTierIds: after?.catalogSnapshot?.productionRequiredTierIds
      ?? before?.catalogSnapshot?.productionRequiredTierIds
      ?? []
  })
  const retention = retentionReview(after)
  const budgets = performanceBudgets(checkpoints, authoritative)
  const baselineAuthority = baselineAuthorityProof({ required: finalAuthority, before })
  const retentionAuditAuthority = retentionAuditAuthorityProof({
    required: finalAuthority,
    authoritative,
    after
  })
  const sourceAuthority = sourceAuthorityProof({
    authoritative,
    checkpoints,
    budgets,
    coverageSnapshots,
    after,
    currentSourceState
  })
  const authority = finalAuthorityProof({
    required: finalAuthority,
    authoritative,
    budgets,
    coverageMetrics,
    criticalMutationSlice,
    retainedCoverage,
    deletionSafety,
    assertionReplacementSafety,
    retention,
    baselineAuthority,
    retentionAuditAuthority,
    sourceAuthority,
    mutationAuthority,
    logicalProjection
  })
  const topSlowTests = (after?.testRecords ?? [])
    .filter((record) => Number(record?.timing?.p95Ms) >= 0 && Number(record?.timing?.samples) > 0)
    .map((record) => ({
      id: record.id,
      path: record.path,
      samples: Number(record.timing.samples),
      p50Ms: Number(record.timing.p50Ms),
      p95Ms: Number(record.timing.p95Ms)
    }))
    .sort((left, right) => right.p95Ms - left.p95Ms || left.id.localeCompare(right.id))
    .slice(0, 10)

  return {
    schema: 'fsusblog.test-optimization-report.v2',
    generatedAt: new Date().toISOString(),
    authoritativeFreshRun: authoritative ? {
      runId: authoritative.runId ?? null,
      target: authoritative.target ?? authoritative.targetTier ?? authoritative.targetTierId ?? null,
      status: authoritative.status ?? (authoritative.failedAt ? 'failure' : 'success'),
      checkpoint: authoritative.checkpointFile ?? null
    } : null,
    finalAuthority: authority,
    baselineAuthority,
    retentionAuditAuthority,
    sourceAuthority,
    retainedCoverage,
    coverageMetrics,
    criticalMutationSlice,
    mutationAuthority,
    logicalProjection,
    deletionSafety,
    assertionReplacementSafety,
    retentionReview: retention,
    matrixEvidence: viewportEvidence(viewportSummaries),
    performanceBudgets: budgets,
    tierDurations: completedEntries(authoritative).sort((left, right) => right.durationMs - left.durationMs || left.id.localeCompare(right.id)),
    topSlowTests
  }
}

function duration(value) {
  if (value === null || value === undefined) return 'not measured'
  return `${(Number(value) / 1000).toFixed(2)}s`
}

export function renderOptimizationMarkdown(report) {
  const lines = [
    '# Test Optimization Evidence',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Final authority: ${report.finalAuthority.status}`,
    ...report.finalAuthority.errors.map((error) => `- ${error}`),
    `Retention audit authority: ${report.retentionAuditAuthority.status}`,
    ...report.retentionAuditAuthority.errors.map((error) => `- ${error}`),
    `Source authority: ${report.sourceAuthority.status}`,
    ...report.sourceAuthority.errors.map((error) => `- ${error}`),
    `Mutation authority: ${report.mutationAuthority.status}`,
    ...report.mutationAuthority.errors.map((error) => `- ${error}`),
    `Production logical projection: ${report.logicalProjection.status}`,
    ...report.logicalProjection.errors.map((error) => `- ${error}`),
    '',
    `Retained coverage: ${report.retainedCoverage.status}`,
    `Reviewed candidates: ${report.retentionReview.reviewedCandidates}; unreviewed: ${report.retentionReview.unreviewedCandidates}`,
    `Deletion safety: ${report.deletionSafety.status}; removed tests: ${report.deletionSafety.removedTestIds.length}`,
    `Assertion replacement safety: ${report.assertionReplacementSafety.status}; declared replacements: ${report.assertionReplacementSafety.replacements.length}`,
    `Missing coverage IDs: ${report.retainedCoverage.missingCoverageIds.join(', ') || 'none'}`,
    `Missing baseline test IDs: ${report.retainedCoverage.missingTestIds.join(', ') || 'none'}`,
    `Missing assertion targets: ${report.retainedCoverage.missingAssertionTargets.length}`,
    `Missing framework/risk/tier dimensions: ${report.retainedCoverage.dimensions.missingFrameworks.length}/${report.retainedCoverage.dimensions.missingRiskTags.length}/${report.retainedCoverage.dimensions.missingTierIds.length}`,
    '',
    '## Executed coverage snapshots',
    '',
    '| Scope | Before line | After line | Before branch | After branch | Status |',
    '|---|---:|---:|---:|---:|---|',
    ...Object.entries(report.coverageMetrics.dimensions).map(([id, item]) => `| ${id} | ${item.before.line ?? 'not measured'} | ${item.after.line ?? 'not measured'} | ${item.before.branch ?? 'not measured'} | ${item.after.branch ?? 'not measured'} | ${item.status} |`),
    '',
    `Critical mutation slice: ${report.criticalMutationSlice.status} (${report.criticalMutationSlice.evidenceMode})`,
    ...report.criticalMutationSlice.errors.map((error) => `- ${error}`),
    '',
    '## Viewport matrix evidence',
    '',
    '| Mode | Cases | Navigations | Groups | Completed | Failed | Status |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...Object.entries(report.matrixEvidence).map(([mode, item]) => `| ${mode} | ${item.caseCount} | ${item.navigationCount} | ${item.groupCount} | ${item.completedGroupCount} | ${item.failedGroupCount} | ${item.status} |`),
    '',
    '## Performance budgets',
    '',
    '| Tier | Actual | Budget | Status |',
    '|---|---:|---:|---|',
    ...report.performanceBudgets.map((item) => `| ${item.id} | ${duration(item.actualDurationMs)} | ${duration(item.maxDurationMs)} | ${item.status} |`),
    '',
    '## Tier durations',
    '',
    '| Tier | Duration | Status |',
    '|---|---:|---|',
    ...report.tierDurations.map((item) => `| ${item.id} | ${duration(item.durationMs)} | ${item.status} |`),
    '',
    '## Top 10 slow tests',
    '',
    '| Test | p50 | p95 | Samples |',
    '|---|---:|---:|---:|',
    ...report.topSlowTests.map((item) => `| ${item.id} | ${duration(item.p50Ms)} | ${duration(item.p95Ms)} | ${item.samples} |`),
    ''
  ]
  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}

function parseArgs(argv) {
  const options = {
    before: 'tests/test-retention-before.json',
    after: '.tmp/release-evidence/test-retention-audit.json',
    baselineSnapshot: 'tests/test-optimization-coverage-baseline.json',
    currentSnapshot: null,
    checkpoints: [],
    mutationEvidence: null,
    captureSnapshot: null,
    out: '.tmp/release-evidence/test-optimization-report.json',
    markdown: '.tmp/release-evidence/test-optimization-report.md'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!['--before', '--after', '--baseline-snapshot', '--current-snapshot', '--checkpoint', '--mutation-evidence', '--capture-snapshot', '--out', '--markdown'].includes(arg)) {
      throw new Error(`unknown option: ${arg}`)
    }
    const value = argv[++index]
    if (!value) throw new Error(`missing value for option: ${arg}`)
    if (arg === '--checkpoint') options.checkpoints.push(value)
    else options[arg.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value
  }
  return options
}

function readJson(relative, fallback = null) {
  const absolute = path.resolve(repoRoot, relative)
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : fallback
}

function validateFileDigestBinding(binding, label) {
  const relative = String(binding?.path ?? '')
  const expected = String(binding?.sha256 ?? '').replace(/^sha256:/u, '')
  if (!relative || !/^[0-9a-f]{64}$/u.test(expected)) {
    throw new Error(`${label} path/digest binding is missing or invalid`)
  }
  const absolute = path.resolve(repoRoot, relative)
  const rel = path.relative(repoRoot, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !fs.existsSync(absolute)) {
    throw new Error(`${label} must resolve to an existing repository file`)
  }
  const actual = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
  if (actual !== expected) throw new Error(`${label} digest does not match current file content`)
}

function validateAuthoritativeBeforeSourceDigests(before) {
  const commit = String(before?.sourceState?.commit ?? '')
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error('authoritative before snapshot commit binding is missing or invalid')
  }
  const sources = {
    matrix: 'tests/matrix.yml',
    coverageRegistry: 'tests/coverage-registry.json',
    requirementCatalog: 'tests/backend/Fixtures/backend-test-requirements.json',
    optimizationCoverageBaseline: 'tests/test-optimization-coverage-baseline.json'
  }
  for (const [id, relative] of Object.entries(sources)) {
    const expected = String(before?.catalogSnapshot?.sourceDigests?.[id] ?? '')
    if (!/^sha256:[0-9a-f]{64}$/u.test(expected)) {
      throw new Error(`authoritative before snapshot source digest is missing for ${relative}`)
    }
    const source = spawnSync('git', ['show', `${commit}:${relative}`], {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024
    })
    if (source.status !== 0) throw new Error(`cannot resolve authoritative before source ${relative}`)
    const actual = `sha256:${createHash('sha256').update(source.stdout).digest('hex')}`
    if (actual !== expected) throw new Error(`authoritative before source digest mismatch for ${relative}`)
  }
}

function discoveredCheckpoints() {
  const runRoot = path.join(repoRoot, '.tmp/test-runs')
  if (!fs.existsSync(runRoot)) return []
  return fs.readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runRoot, entry.name, 'checkpoint.json'))
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => {
      try {
        return [{ ...JSON.parse(fs.readFileSync(file, 'utf8')), checkpointFile: path.relative(repoRoot, file) }]
      } catch {
        return []
      }
    })
}

function explicitCheckpoints(files) {
  return files.map((file) => {
    const payload = readJson(file)
    if (!payload) throw new Error(`missing checkpoint: ${file}`)
    return { ...payload, checkpointFile: file }
  })
}

function readOptimizationSnapshot(relative, { optional = false } = {}) {
  if (!relative) return null
  const payload = readJson(relative)
  if (!payload) {
    if (optional) return null
    throw new Error(`missing optimization snapshot: ${relative}`)
  }
  if (payload.schema && payload.schema !== 'fsusblog.test-optimization-snapshot.v1') {
    throw new Error(`unsupported optimization snapshot schema: ${payload.schema}`)
  }
  return {
    coverage: payload.coverage ?? payload.coverageSnapshots ?? null,
    criticalMutationSlice: payload.criticalMutationSlice ?? payload.mutation ?? null
  }
}

function standardCurrentSnapshot() {
  const coverage = {
    backend: readJson('.tmp/coverage/backend-merged/Summary.json'),
    frontend: readJson('.tmp/coverage/frontend/Summary.json'),
    merged: readJson('.tmp/coverage/merged/Summary.json')
  }
  const hasCoverage = Object.values(coverage).some(Boolean)
  return { coverage: hasCoverage ? coverage : null, criticalMutationSlice: null }
}

function viewportSummaries() {
  return ['smoke', 'visual', 'boundaries']
    .map((mode) => readJson(`.tmp/ux/viewport-${mode}.json`))
    .filter(Boolean)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.captureSnapshot) {
    const current = options.currentSnapshot
      ? readOptimizationSnapshot(options.currentSnapshot)
      : standardCurrentSnapshot()
    const snapshot = buildOptimizationSnapshot({
      coverage: current?.coverage,
      criticalMutationSlice: current?.criticalMutationSlice
    })
    const destination = path.resolve(repoRoot, options.captureSnapshot)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, `${JSON.stringify(snapshot, null, 2)}\n`)
    console.log(`[test-optimization] captured ${path.relative(repoRoot, destination)}`)
    return
  }
  if (path.resolve(repoRoot, options.before) !== authoritativeBeforePath) {
    throw new Error('authoritative --before path must be tests/test-retention-before.json')
  }
  const before = readJson(options.before)
  const after = readJson(options.after)
  if (!before) throw new Error(`missing baseline retention audit: ${options.before}`)
  if (!after) throw new Error(`missing retention audit: ${options.after}`)
  if (!isCompactRetentionBaseline(before) && before.schema !== 'fsusblog.test-retention-audit.v2') {
    throw new Error(`unsupported baseline retention audit schema: ${before.schema ?? 'missing'}`)
  }
  if (isCompactRetentionBaseline(before)) validateCompactRetentionBaseline(before)
  validateAuthoritativeBeforeSourceDigests(before)
  if (after.schema !== 'fsusblog.test-retention-audit.v2') {
    throw new Error(`unsupported retention audit schema: ${after.schema ?? 'missing'}`)
  }
  const baselineSnapshot = readOptimizationSnapshot(options.baselineSnapshot, { optional: true })
    ?? (before.optimizationEvidence && !isCompactRetentionBaseline(before) ? {
        coverage: before.optimizationEvidence.coverage ?? null,
        criticalMutationSlice: before.optimizationEvidence.criticalMutationSlice ?? null
      } : null)
  const currentSnapshot = options.currentSnapshot
    ? readOptimizationSnapshot(options.currentSnapshot)
    : after.optimizationEvidence
      ? {
          coverage: after.optimizationEvidence.coverage ?? null,
          criticalMutationSlice: after.optimizationEvidence.criticalMutationSlice ?? null
        }
      : standardCurrentSnapshot()
  const checkpointEvidence = options.checkpoints.length > 0
    ? explicitCheckpoints(options.checkpoints)
    : discoveredCheckpoints()
  if (options.checkpoints.length === 0) {
    throw new Error('final optimization authority requires explicit --checkpoint paths from this verification run')
  }
  if (!options.mutationEvidence) {
    throw new Error('final optimization authority requires explicit --mutation-evidence from this verification run')
  }
  const mutationEvidence = readJson(options.mutationEvidence)
  if (!mutationEvidence) throw new Error(`missing mutation authority evidence: ${options.mutationEvidence}`)
  validateFileDigestBinding(mutationEvidence.rawReport, 'Stryker raw report')
  validateFileDigestBinding(mutationEvidence.config, 'Stryker config')
  const worktree = await snapshotGitWorktree(repoRoot)
  const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  const currentSourceState = {
    commit: commitResult.status === 0 ? commitResult.stdout.trim() : null,
    worktreeFingerprint: worktree.fingerprint
  }
  const report = buildOptimizationReport({
    before,
    after,
    checkpoints: checkpointEvidence,
    viewportSummaries: viewportSummaries(),
    coverageSnapshots: {
      before: baselineSnapshot?.coverage,
      after: currentSnapshot?.coverage
    },
    mutationSnapshots: {
      before: baselineSnapshot?.criticalMutationSlice,
      after: mutationEvidence
    },
    finalAuthority: true,
    currentSourceState
  })
  const out = path.resolve(repoRoot, options.out)
  const markdown = path.resolve(repoRoot, options.markdown)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.mkdirSync(path.dirname(markdown), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  fs.writeFileSync(markdown, renderOptimizationMarkdown(report))
  console.log(`[test-optimization] wrote ${path.relative(repoRoot, out)} and ${path.relative(repoRoot, markdown)}`)
  if (report.finalAuthority.status !== 'pass') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
