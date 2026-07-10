#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { snapshotGitWorktree } from '../test-matrix/scheduler.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const budgetDefinitions = [
  { id: 'ux-viewport-boundaries', maxDurationMs: 20 * 60_000 },
  { id: 'integration', maxDurationMs: 4 * 60_000 },
  { id: 'static-governance', maxDurationMs: 20_000 }
]

function recordIds(audit) {
  return new Set((audit?.testRecords ?? []).map((record) => record?.id).filter(Boolean))
}

function assertionTargetIds(audit) {
  return new Set((audit?.testRecords ?? []).flatMap((record) => record?.assertionTargets ?? []).filter(Boolean))
}

function recordDimensionIds(audit, field) {
  return new Set((audit?.testRecords ?? []).flatMap((record) => (
    field === 'framework' ? [record?.framework] : record?.[field] ?? []
  )).filter(Boolean))
}

function retainedDimensionProof(before, after) {
  const beforeFrameworks = recordDimensionIds(before, 'framework')
  const afterFrameworks = recordDimensionIds(after, 'framework')
  const beforeRiskTags = recordDimensionIds(before, 'riskTags')
  const afterRiskTags = recordDimensionIds(after, 'riskTags')
  const beforeTierIds = recordDimensionIds(before, 'tierIds')
  const afterTierIds = recordDimensionIds(after, 'tierIds')
  const tierReplacements = new Map((after?.tierReplacements ?? []).map((entry) => [entry.from, entry]))
  const replacedTierIds = [...beforeTierIds]
    .filter((id) => !afterTierIds.has(id) && afterTierIds.has(tierReplacements.get(id)?.to))
    .map((id) => ({
      from: id,
      to: tierReplacements.get(id).to,
      coverageIds: tierReplacements.get(id).coverageIds,
      reason: tierReplacements.get(id).reason
    }))
    .sort((left, right) => left.from.localeCompare(right.from))
  const replacedFromIds = new Set(replacedTierIds.map((entry) => entry.from))
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
    replacedTierIds
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

function mutationScopeFromAudit(audit) {
  const tierIds = new Set()
  const testIds = []
  for (const record of audit?.testRecords ?? []) {
    const mutationTierIds = (record?.tierIds ?? []).filter((id) => (
      id === 'backend-mutation' || id === 'release-mutation-critical-slice'
    ))
    if (mutationTierIds.length === 0) continue
    testIds.push(record.id)
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
    mutantCount: Number.isFinite(mutantCountCandidate) ? mutantCountCandidate : mutants.length
  }
}

function criticalMutationProof(beforeAudit, afterAudit, snapshots) {
  const beforeTestIds = recordIds(beforeAudit)
  const afterTestIds = recordIds(afterAudit)
  const actualDeletions = [...beforeTestIds].filter((id) => !afterTestIds.has(id)).sort()
  const beforeIdentity = mutationScopeFromAudit(beforeAudit)
  const afterIdentity = mutationScopeFromAudit(afterAudit)
  const criticalTestIds = new Set(beforeIdentity.testIds)
  const criticalDeletions = actualDeletions.filter((id) => criticalTestIds.has(id))

  if (criticalDeletions.length === 0 && beforeIdentity.testIds.length > 0 && beforeIdentity.scopeIds.length > 0) {
    const missingTestIds = beforeIdentity.testIds.filter((id) => !afterIdentity.testIds.includes(id))
    const addedTestIds = afterIdentity.testIds.filter((id) => !beforeIdentity.testIds.includes(id))
    const missingScope = beforeIdentity.scopeIds.filter((id) => !afterIdentity.scopeIds.includes(id))
    const addedScope = afterIdentity.scopeIds.filter((id) => !beforeIdentity.scopeIds.includes(id))
    const exact = missingTestIds.length === 0 && addedTestIds.length === 0 && missingScope.length === 0 && addedScope.length === 0
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
  const beforeIds = recordIds(before)
  const afterIds = recordIds(after)
  const removedTestIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort()
  const declarations = new Map((after?.deletedTests ?? [])
    .filter((entry) => entry?.id)
    .map((entry) => [entry.id, entry]))
  const invalidDeclarations = []
  const validDeletedTestIds = []

  for (const id of removedTestIds) {
    const declaration = declarations.get(id)
    if (!declaration) continue
    const replacements = [...new Set(declaration.replacementTestIds ?? [])]
    const missingReplacementTestIds = replacements.filter((replacement) => !afterIds.has(replacement))
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
    if (!beforeIds.has(id) || afterIds.has(id)) {
      invalidDeclarations.push({
        id,
        reasons: [!beforeIds.has(id) ? 'test id did not exist in baseline' : 'test id still exists after the claimed deletion'],
        replacementTestIds: [...new Set(declaration.replacementTestIds ?? [])]
      })
    }
  }

  const undeclaredTestIds = removedTestIds.filter((id) => !declarations.has(id))
  const status = removedTestIds.length === 0 && declarations.size === 0
    ? 'not-applicable'
    : undeclaredTestIds.length === 0 && invalidDeclarations.length === 0 ? 'pass' : 'fail'

  return {
    status,
    removedTestIds,
    validDeletedTestIds: validDeletedTestIds.sort(),
    undeclaredTestIds,
    invalidDeclarations,
    deletedTests: [...declarations.values()].sort((left, right) => left.id.localeCompare(right.id))
  }
}

function assertionReplacementProof(before, after) {
  const beforeTargets = assertionTargetIds(before)
  const afterTargets = assertionTargetIds(after)
  const afterTestIds = recordIds(after)
  const declarations = after?.assertionReplacements ?? []
  const validBeforeTargets = []
  const invalidDeclarations = []
  for (const declaration of declarations) {
    const reasons = []
    const replacements = [...new Set(declaration?.replacementTestIds ?? [])]
    const afterAssertionTargets = [...new Set(declaration?.after ?? [])]
    if (!beforeTargets.has(declaration?.before)) reasons.push('before assertion target did not exist in baseline')
    if (afterTargets.has(declaration?.before)) reasons.push('before assertion target still exists after the claimed replacement')
    if (!String(declaration?.reason ?? '').trim()) reasons.push('reason is empty')
    if (replacements.length === 0) reasons.push('replacementTestIds is empty')
    const missingReplacementTestIds = replacements.filter((id) => !afterTestIds.has(id))
    if (missingReplacementTestIds.length > 0) reasons.push(`replacement tests are missing: ${missingReplacementTestIds.join(', ')}`)
    if (afterAssertionTargets.length === 0) reasons.push('after assertion targets are empty')
    const missingAfterTargets = afterAssertionTargets.filter((target) => !afterTargets.has(target))
    if (missingAfterTargets.length > 0) reasons.push(`replacement assertion targets are missing: ${missingAfterTargets.join(', ')}`)
    if (reasons.length > 0) invalidDeclarations.push({ before: declaration?.before ?? null, reasons })
    else validBeforeTargets.push(declaration.before)
  }
  return {
    status: declarations.length === 0 ? 'not-applicable' : invalidDeclarations.length === 0 ? 'pass' : 'fail',
    validBeforeTargets: [...new Set(validBeforeTargets)].sort(),
    invalidDeclarations,
    replacements: declarations
  }
}

function coverageProof(before, after, deletionSafety, assertionReplacementSafety) {
  const beforeIds = new Set(before?.retainedEvidence?.coverageIds ?? [])
  const afterIds = new Set(after?.retainedEvidence?.coverageIds ?? [])
  const missingCoverageIds = [...beforeIds].filter((id) => !afterIds.has(id)).sort()
  const addedCoverageIds = [...afterIds].filter((id) => !beforeIds.has(id)).sort()
  const beforeTestIds = recordIds(before)
  const afterTestIds = recordIds(after)
  const authorizedDeletedIds = new Set(deletionSafety.validDeletedTestIds)
  const missingTestIds = [...beforeTestIds]
    .filter((id) => !afterTestIds.has(id) && !authorizedDeletedIds.has(id))
    .sort()
  const addedTestIds = [...afterTestIds].filter((id) => !beforeTestIds.has(id)).sort()
  const beforeAssertionTargets = assertionTargetIds(before)
  const afterAssertionTargets = assertionTargetIds(after)
  const authorizedAssertionReplacements = new Set(assertionReplacementSafety.validBeforeTargets)
  const missingAssertionTargets = [...beforeAssertionTargets]
    .filter((target) => !afterAssertionTargets.has(target) && !authorizedAssertionReplacements.has(target))
    .sort()
  const addedAssertionTargets = [...afterAssertionTargets].filter((target) => !beforeAssertionTargets.has(target)).sort()
  const beforeTargets = Number(before?.retainedEvidence?.uniqueAssertionTargetCount ?? 0)
  const afterTargets = Number(after?.retainedEvidence?.uniqueAssertionTargetCount ?? 0)
  const beforeTests = Number(before?.retainedEvidence?.testRecordCount ?? 0)
  const afterTests = Number(after?.retainedEvidence?.testRecordCount ?? 0)
  const dimensions = retainedDimensionProof(before, after)
  const notWeaker = missingCoverageIds.length === 0
    && missingTestIds.length === 0
    && missingAssertionTargets.length === 0
    && deletionSafety.status !== 'fail'
    && assertionReplacementSafety.status !== 'fail'
    && dimensions.missingFrameworks.length === 0
    && dimensions.missingRiskTags.length === 0
    && dimensions.missingTierIds.length === 0
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
  return Object.entries(checkpoint?.tiers ?? checkpoint?.completed ?? {})
    .map(([id, value]) => ({
      id,
      durationMs: Number(value?.durationMs ?? 0),
      status: value?.status ?? 'success',
      fingerprint: value?.fingerprint ?? value?.inputFingerprint ?? null,
      log: value?.log ?? value?.logFile ?? null
    }))
    .filter((entry) => Number.isFinite(entry.durationMs) && entry.durationMs >= 0)
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
  retentionAuditAuthority,
  sourceAuthority
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
  if (retentionAuditAuthority.status === 'fail') errors.push(...retentionAuditAuthority.errors)
  if (sourceAuthority.status === 'fail') errors.push(...sourceAuthority.errors)
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
  })
  const retention = retentionReview(after)
  const budgets = performanceBudgets(checkpoints, authoritative)
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
    retentionAuditAuthority,
    sourceAuthority
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
    retentionAuditAuthority,
    sourceAuthority,
    retainedCoverage,
    coverageMetrics,
    criticalMutationSlice,
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
    before: '.tmp/release-evidence/test-retention-before.json',
    after: '.tmp/release-evidence/test-retention-audit.json',
    baselineSnapshot: 'tests/test-optimization-coverage-baseline.json',
    currentSnapshot: null,
    checkpoints: [],
    captureSnapshot: null,
    out: '.tmp/release-evidence/test-optimization-report.json',
    markdown: '.tmp/release-evidence/test-optimization-report.md'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!['--before', '--after', '--baseline-snapshot', '--current-snapshot', '--checkpoint', '--capture-snapshot', '--out', '--markdown'].includes(arg)) {
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
  const before = readJson(options.before)
  const after = readJson(options.after)
  if (!before) throw new Error(`missing baseline retention audit: ${options.before}`)
  if (!after) throw new Error(`missing retention audit: ${options.after}`)
  if (before.schema !== 'fsusblog.test-retention-audit.v2') {
    throw new Error(`unsupported baseline retention audit schema: ${before.schema ?? 'missing'}`)
  }
  if (after.schema !== 'fsusblog.test-retention-audit.v2') {
    throw new Error(`unsupported retention audit schema: ${after.schema ?? 'missing'}`)
  }
  const baselineSnapshot = readOptimizationSnapshot(options.baselineSnapshot, { optional: true })
    ?? (before.optimizationEvidence ? {
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
      after: currentSnapshot?.criticalMutationSlice
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
