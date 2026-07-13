import {
  compactRetentionKey,
  decodeCompactRetentionIndex,
  isCompactRetentionBaseline
} from '../test-retention/audit.mjs'

const fixturePathPatterns = [
  /^tests\/backend\/Fixtures\//u,
  /^tests\/fixtures\//u,
  /^tests\/frontend\/fixtures\//u
]

function normalizeRepoPath(value) {
  return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '')
}

function isFixtureTarget(target) {
  const normalized = normalizeRepoPath(target)
  return fixturePathPatterns.some((pattern) => pattern.test(normalized))
}

function classifySourceTarget(target) {
  const normalized = normalizeRepoPath(target)
  if (/^tests\/(?:backend\/(?:Unit|Integration)|frontend\/(?:unit|e2e)|tools)\//u.test(normalized)) {
    return 'test-source-read'
  }
  if (/^(?:docs\/|README(?:\.|$))|\.md$/iu.test(normalized)) {
    return 'documentation-source-read'
  }
  if (/^(?:\.github\/|tests\/matrix\.yml$|tests\/coverage-|security\/.*matrix)|(?:workflow|matrix)\.(?:ya?ml|json)$/iu.test(normalized)) {
    return 'workflow-matrix-source-read'
  }
  return 'production-source-read'
}

function lineAndColumn(source, index) {
  const before = source.slice(0, Math.max(0, index))
  const lines = before.split('\n')
  return { line: lines.length, column: lines.at(-1).length + 1 }
}

function sameSourceState(left, right) {
  return String(left?.commit ?? '') === String(right?.commit ?? '')
    && String(left?.worktreeFingerprint ?? '') === String(right?.worktreeFingerprint ?? '')
}

function stringLiterals(source) {
  const values = []
  const regex = /(?:@\$|\$@|@|\$)?"([^"\r\n]*)"|'([^'\r\n]*)'/gu
  let match
  while ((match = regex.exec(source)) !== null) {
    values.push(match[1] ?? match[2] ?? '')
  }
  return values
}

function likelyRepoTarget(values) {
  const normalizedValues = values.map(normalizeRepoPath)
  const repositoryRoots = new Set([
    '.github',
    'benchmarks',
    'deploy',
    'docs',
    'ops',
    'security',
    'src',
    'tests',
    'tools'
  ])
  for (let index = 0; index < normalizedValues.length; index += 1) {
    const value = normalizedValues[index]
    const rootSegment = value.split('/')[0]
    if (!repositoryRoots.has(rootSegment)) continue
    if (value.includes('/')) return value
    const segments = [value]
    for (let cursor = index + 1; cursor < Math.min(normalizedValues.length, index + 16); cursor += 1) {
      const segment = normalizedValues[cursor]
      if (!segment || /[\s<>:$(){}]/u.test(segment)) break
      segments.push(segment)
      if (/\.[A-Za-z0-9]+$/u.test(segment)) return segments.join('/')
    }
  }
  return values.find((value) => {
    const normalized = normalizeRepoPath(value)
    return normalized.includes('/')
      || /\.(?:cs|ts|tsx|vue|mjs|js|json|ya?ml|md|sh|sql|csproj|slnx)$/iu.test(normalized)
  }) ?? null
}

function fieldValue(document, field) {
  return String(field ?? '').split('.').filter(Boolean)
    .reduce((value, segment) => value?.[segment], document)
}

export function scanBackendSourceLocking(source, filePath = '<memory>') {
  const violations = []
  const seen = new Set()
  const add = (index, rule, target, message) => {
    const { line, column } = lineAndColumn(source, index)
    const key = `${line}:${column}:${rule}:${target ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ path: filePath, line, column, rule, target, message })
  }

  const rootReader = /\bBackendTestPaths\.ReadAllTextFromRoot\s*\(/gu
  let match
  while ((match = rootReader.exec(source)) !== null) {
    const window = source.slice(match.index, Math.min(source.length, match.index + 600))
    const target = likelyRepoTarget(stringLiterals(window))
    if (target && isFixtureTarget(target)) continue
    add(
      match.index,
      target ? classifySourceTarget(target) : 'generic-repo-source-reader',
      target,
      target
        ? `replace repository source read ${target} with behavior, serialization, persistence, or one static owner`
        : 'generic repository source reader hides the asserted target'
    )
  }

  const namedReader = /\b(?:ReadSource|ReadRepoFile|ReadProductionFile)\s*\(/gu
  while ((match = namedReader.exec(source)) !== null) {
    const window = source.slice(match.index, Math.min(source.length, match.index + 600))
    const target = likelyRepoTarget(stringLiterals(window))
    if (target && isFixtureTarget(target)) continue
    add(
      match.index,
      'source-reader-helper',
      target,
      'source-reader helper is not executable behavior evidence'
    )
  }

  const fileReader = /\bFile\.ReadAllText(?:Async)?\s*\(/gu
  while ((match = fileReader.exec(source)) !== null) {
    const start = Math.max(0, match.index - 320)
    const forward = source.slice(match.index, Math.min(source.length, match.index + 320))
    const backward = source.slice(start, match.index)
    const window = `${backward}${forward}`
    const target = likelyRepoTarget(stringLiterals(forward))
      ?? likelyRepoTarget(stringLiterals(backward).reverse())
    const repositoryRooted = window.includes('BackendTestPaths.RepositoryRoot')
      || window.includes('BackendTestPaths.PathFromRoot')
      || window.includes('BackendTestPaths.FromRoot')
    if (!repositoryRooted && !target) continue
    if (repositoryRooted
      && /BackendTestPaths\.FromRoot\s*\([^)]*"tests"[^)]*"(?:backend"[^)]*)?[Ff]ixtures"/su.test(backward)) {
      continue
    }
    if (repositoryRooted
      && /Path\.Combine\s*\(\s*"tests"\s*,\s*"fixtures"/su.test(backward)
      && /BackendTestPaths\.FromRoot\s*\(\s*relativePath\s*\)/su.test(backward)) {
      continue
    }
    if (target && isFixtureTarget(target)) continue
    if (!repositoryRooted && target && !/^(?:src|docs|tests|tools|\.github|benchmarks|deploy|ops|security)\//u.test(normalizeRepoPath(target))) {
      continue
    }
    add(
      match.index,
      target ? classifySourceTarget(target) : 'repository-root-file-read',
      target,
      'repository-root file reads must move to executable behavior or one static governance owner'
    )
  }

  return violations.sort((left, right) => left.line - right.line || left.column - right.column)
}

export function verifySourceLockingFixtures(positiveSource, negativeSource) {
  const positive = scanBackendSourceLocking(positiveSource, 'positive.fixture.cs.txt')
  const negative = scanBackendSourceLocking(negativeSource, 'negative.fixture.cs.txt')
  const negativeRules = new Set(negative.map((violation) => violation.rule))
  const requiredRules = [
    'production-source-read',
    'documentation-source-read',
    'test-source-read',
    'source-reader-helper'
  ]
  const errors = []
  if (positive.length > 0) {
    errors.push(`positive source-locking fixture produced ${positive.length} violation(s)`)
  }
  for (const rule of requiredRules) {
    if (!negativeRules.has(rule)) errors.push(`negative source-locking fixture did not trigger ${rule}`)
  }
  return { positive, negative, errors }
}

export function normalizeReplacementEntries(manifest, source = '<manifest>') {
  const errors = []
  const entries = []
  if (!manifest || !Array.isArray(manifest.deletedTests)) {
    return { entries, errors: [`${source}: deletedTests must be an array`] }
  }
  if (Object.hasOwn(manifest, 'expectedDeletedTestIds')) {
    if (!Number.isInteger(manifest.expectedDeletedTestIds) || manifest.expectedDeletedTestIds < 0) {
      errors.push(`${source}: expectedDeletedTestIds must be a non-negative integer`)
    } else if (manifest.expectedDeletedTestIds !== manifest.deletedTests.length) {
      errors.push(
        `${source}: expectedDeletedTestIds is ${manifest.expectedDeletedTestIds}, found ${manifest.deletedTests.length}`
      )
    }
  }

  for (const [index, raw] of manifest.deletedTests.entries()) {
    const id = String(raw?.id ?? '').trim()
    const path = String(raw?.path ?? '').trim()
    const replacementTestIds = Array.isArray(raw?.replacementTestIds)
      ? raw.replacementTestIds.map((value) => String(value).trim()).filter(Boolean)
      : []
    if (!id) errors.push(`${source}: deletedTests[${index}] has no id`)
    if (!path) errors.push(`${source}: deletedTests[${index}] has no path`)
    if (!String(raw?.reason ?? '').trim()) errors.push(`${source}: ${id || `deletedTests[${index}]`} has no reason`)
    if (replacementTestIds.length === 0) errors.push(`${source}: ${id || `deletedTests[${index}]`} has no replacementTestIds`)
    if (new Set(replacementTestIds).size !== replacementTestIds.length) {
      errors.push(`${source}: ${id} repeats a replacement test ID`)
    }
    if (replacementTestIds.includes(id)) errors.push(`${source}: ${id} replaces itself`)
    if (!id) continue
    entries.push({
      id,
      path,
      replacementTestIds,
      reason: String(raw?.reason ?? '').trim(),
      source
    })
  }
  return { entries, errors }
}

export function mergeReplacementEntries(manifests) {
  const merged = new Map()
  const errors = []
  const conflicts = []
  for (const descriptor of manifests) {
    const normalized = normalizeReplacementEntries(descriptor.manifest, descriptor.source)
    errors.push(...normalized.errors)
    for (const entry of normalized.entries) {
      const existing = merged.get(entry.id)
      if (!existing) {
        merged.set(entry.id, entry)
        continue
      }
      const left = [...existing.replacementTestIds].sort()
      const right = [...entry.replacementTestIds].sort()
      if (JSON.stringify(left) !== JSON.stringify(right) || existing.path !== entry.path) {
        conflicts.push({ id: entry.id, firstSource: existing.source, secondSource: entry.source })
        errors.push(`${entry.id}: conflicting replacement declarations in ${existing.source} and ${entry.source}`)
      }
    }
  }
  return { entries: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)), conflicts, errors }
}

export function expandPathReplacementPlan(beforeRecords, plan, source = '<path-plan>') {
  const recordsByPath = new Map()
  for (const record of beforeRecords) {
    const records = recordsByPath.get(record.path) ?? []
    records.push(record)
    recordsByPath.set(record.path, records)
  }
  const entries = []
  const errors = []
  for (const migration of plan.wholeFileMigrations ?? []) {
    const records = recordsByPath.get(migration.path) ?? []
    if (records.length !== migration.expectedRecords) {
      errors.push(`${source}: ${migration.path} expected ${migration.expectedRecords} records, found ${records.length}`)
    }
    const replacementTestIds = plan.replacementOwners?.[migration.replacementOwner] ?? []
    for (const record of records) {
      entries.push({
        id: record.id,
        path: migration.path,
        replacementTestIds,
        reason: migration.reason ?? '',
        source
      })
    }
  }
  const recordsById = new Map(beforeRecords.map((record) => [record.id, record]))
  for (const migration of plan.selectiveTestMigrations ?? []) {
    const record = recordsById.get(migration.deletedTestId)
    if (!record) {
      errors.push(`${source}: selective deletion is absent from baseline: ${migration.deletedTestId}`)
      continue
    }
    entries.push({
      id: record.id,
      path: record.path,
      replacementTestIds: plan.replacementOwners?.[migration.replacementOwner] ?? [],
      reason: migration.reason ?? '',
      source
    })
  }
  return { entries, errors }
}

export function auditRetentionRecords({
  beforeRecords,
  afterRecords = null,
  replacements,
  pathExists = null,
  preBaselineDeletionIds = []
}) {
  const errors = []
  const beforeById = new Map(beforeRecords.map((record) => [record.id, record]))
  const afterById = afterRecords ? new Map(afterRecords.map((record) => [record.id, record])) : null
  const replacementById = new Map(replacements.map((entry) => [entry.id, entry]))
  const preBaselineIds = new Set(preBaselineDeletionIds)
  const deletedRecords = afterById
    ? beforeRecords.filter((record) => !afterById.has(record.id))
    : typeof pathExists === 'function'
      ? beforeRecords.filter((record) => !pathExists(record.path))
      : []

  const missingDeletionMappings = deletedRecords
    .filter((record) => !replacementById.has(record.id))
    .map((record) => ({ id: record.id, path: record.path }))
  for (const missing of missingDeletionMappings) {
    errors.push(`${missing.id}: deleted without a replacement declaration`)
  }

  const unknownDeletionDeclarations = replacements
    .filter((entry) => !beforeById.has(entry.id) && !preBaselineIds.has(entry.id))
    .map((entry) => ({ id: entry.id, source: entry.source }))
  for (const unknown of unknownDeletionDeclarations) {
    errors.push(`${unknown.id}: replacement declaration does not resolve in the before snapshot`)
  }

  const mismatchedDeletionPaths = replacements
    .filter((entry) => beforeById.has(entry.id) && beforeById.get(entry.id).path !== entry.path)
    .map((entry) => ({
      id: entry.id,
      declaredPath: entry.path,
      baselinePath: beforeById.get(entry.id).path,
      source: entry.source
    }))
  for (const mismatch of mismatchedDeletionPaths) {
    errors.push(
      `${mismatch.id}: declaration path ${mismatch.declaredPath} does not match baseline path ${mismatch.baselinePath}`
    )
  }

  const missingReplacementTargets = []
  if (afterById) {
    for (const record of deletedRecords) {
      const declaration = replacementById.get(record.id)
      if (!declaration) continue
      for (const replacementId of declaration.replacementTestIds) {
        if (!afterById.has(replacementId)) {
          missingReplacementTargets.push({ deletedTestId: record.id, replacementTestId: replacementId })
          errors.push(`${record.id}: replacement target is absent from after snapshot: ${replacementId}`)
        }
      }
    }
  }

  return {
    deletedRecords,
    missingDeletionMappings,
    unknownDeletionDeclarations,
    mismatchedDeletionPaths,
    missingReplacementTargets,
    errors
  }
}

export function auditCompactRetentionRecords({
  beforeSnapshot,
  afterRecords = null,
  replacements,
  preBaselineDeletionIds = []
}) {
  if (!isCompactRetentionBaseline(beforeSnapshot)) {
    throw new Error('compact retention audit requires fsusblog.test-retention-baseline.v3')
  }
  const errors = []
  const beforeKeys = new Set(decodeCompactRetentionIndex(
    beforeSnapshot.testIndex,
    'before snapshot test index'
  ))
  const pathKeys = decodeCompactRetentionIndex(beforeSnapshot.pathIndex, 'before snapshot path index')
  const testKeys = decodeCompactRetentionIndex(beforeSnapshot.testIndex, 'before snapshot test index')
  const baselinePathByTestKey = new Map(beforeSnapshot.assertionIndex.owners.map(([testIndex, pathIndex]) => [
    testKeys[testIndex],
    pathKeys[pathIndex]
  ]))
  const afterByKey = afterRecords
    ? new Map(afterRecords.filter((record) => record?.id).map((record) => [compactRetentionKey(record.id), record]))
    : null
  const replacementByKey = new Map(replacements.map((entry) => [compactRetentionKey(entry.id), entry]))
  const preBaselineKeys = new Set(preBaselineDeletionIds.map((value) => (
    /^[A-Za-z0-9_-]{22}$/u.test(String(value)) ? String(value) : compactRetentionKey(value)
  )))
  const deletedKeys = afterByKey
    ? [...beforeKeys].filter((key) => !afterByKey.has(key)).sort()
    : []

  const missingDeletionMappings = deletedKeys
    .filter((key) => !replacementByKey.has(key))
    .map((key) => ({ idHash: key }))
  for (const missing of missingDeletionMappings) {
    errors.push(`${missing.idHash}: deleted without a replacement declaration`)
  }

  const unknownDeletionDeclarations = replacements
    .filter((entry) => {
      const key = compactRetentionKey(entry.id)
      return !beforeKeys.has(key) && !preBaselineKeys.has(key)
    })
    .map((entry) => ({ id: entry.id, source: entry.source }))
  for (const unknown of unknownDeletionDeclarations) {
    errors.push(`${unknown.id}: replacement declaration does not resolve in the compact before snapshot`)
  }

  const mismatchedDeletionPaths = replacements
    .filter((entry) => {
      const key = compactRetentionKey(entry.id)
      const baselinePathKey = baselinePathByTestKey.get(key)
      return baselinePathKey && baselinePathKey !== compactRetentionKey(entry.path)
    })
    .map((entry) => ({ id: entry.id, declaredPath: entry.path, source: entry.source }))
  for (const mismatch of mismatchedDeletionPaths) {
    errors.push(`${mismatch.id}: declaration path ${mismatch.declaredPath} does not match compact baseline path binding`)
  }

  const missingReplacementTargets = []
  if (afterByKey) {
    for (const key of deletedKeys) {
      const declaration = replacementByKey.get(key)
      if (!declaration) continue
      for (const replacementId of declaration.replacementTestIds) {
        if (!afterByKey.has(compactRetentionKey(replacementId))) {
          missingReplacementTargets.push({ deletedTestId: declaration.id, replacementTestId: replacementId })
          errors.push(`${declaration.id}: replacement target is absent from after snapshot: ${replacementId}`)
        }
      }
    }
  }

  return {
    deletedRecords: deletedKeys.map((idHash) => ({ idHash })),
    missingDeletionMappings,
    unknownDeletionDeclarations,
    mismatchedDeletionPaths,
    missingReplacementTargets,
    errors
  }
}

export function validateAfterSnapshotAuthority(beforeSnapshot, afterSnapshot, { required = false } = {}) {
  if (!afterSnapshot) {
    return required ? ['final convergence requires an after retention snapshot'] : []
  }

  const errors = []
  const producer = afterSnapshot.producer
  const rootSourceState = afterSnapshot.sourceState
  const producerSourceState = producer?.sourceState

  if (afterSnapshot.schema !== 'fsusblog.test-retention-audit.v2') {
    errors.push('after retention snapshot schema is missing or unsupported')
  }
  if (afterSnapshot.snapshotRole === 'before-test-reduction') {
    errors.push('after retention snapshot cannot reuse the before-test-reduction snapshot')
  }
  if (!producer || !String(producer.runId ?? '').trim()) {
    errors.push('after retention snapshot producer run id is missing')
  }
  if (!Number.isFinite(Date.parse(producer?.generatedAt ?? ''))) {
    errors.push('after retention snapshot producer generatedAt is missing or invalid')
  }
  if (String(afterSnapshot.generatedAt ?? '') !== String(producer?.generatedAt ?? '')) {
    errors.push('after retention snapshot root and producer generatedAt values do not match')
  }
  if (!/^[0-9a-f]{40}$/u.test(String(rootSourceState?.commit ?? ''))
    || !/^[0-9a-f]{64}$/u.test(String(rootSourceState?.worktreeFingerprint ?? ''))) {
    errors.push('after retention snapshot root source binding is missing or invalid')
  }
  if (!sameSourceState(rootSourceState, producerSourceState)) {
    errors.push('after retention snapshot root and producer source states do not match')
  }
  if (sameSourceState(beforeSnapshot?.sourceState, rootSourceState)) {
    errors.push('after retention snapshot still points at the authoritative before source state')
  }

  return errors
}

export function validateEvidenceContract(document, contract, source = contract?.path ?? '<evidence>') {
  const errors = []
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return [`${source}: evidence must be a JSON object`]
  }
  for (const assertion of contract?.assertions ?? []) {
    const actual = fieldValue(document, assertion.field)
    if (Object.hasOwn(assertion, 'equals') && actual !== assertion.equals) {
      errors.push(`${source}: ${assertion.field} must equal ${JSON.stringify(assertion.equals)}, found ${JSON.stringify(actual)}`)
    }
    if (Array.isArray(assertion.oneOf) && !assertion.oneOf.includes(actual)) {
      errors.push(`${source}: ${assertion.field} must be one of ${JSON.stringify(assertion.oneOf)}, found ${JSON.stringify(actual)}`)
    }
    if (assertion.nonEmpty === true && !String(actual ?? '').trim()) {
      errors.push(`${source}: ${assertion.field} must be non-empty`)
    }
    if (assertion.finiteNumber === true && (typeof actual !== 'number' || !Number.isFinite(actual))) {
      errors.push(`${source}: ${assertion.field} must be a finite number`)
    }
  }
  return errors
}

export function buildChildIssueStatusEvidence(issues, {
  repository,
  capturedAt = new Date().toISOString()
} = {}) {
  const expectedIssueNumbers = Array.from({ length: 19 }, (_, index) => 1032 + index)
  const byNumber = new Map((issues ?? [])
    .filter((issue) => Number.isInteger(Number(issue?.number)))
    .map((issue) => [Number(issue.number), issue]))
  const records = expectedIssueNumbers
    .filter((number) => byNumber.has(number))
    .map((number) => {
      const issue = byNumber.get(number)
      return {
        number,
        state: String(issue.state ?? '').toUpperCase(),
        closedAt: issue.closedAt ?? issue.closed_at ?? null,
        url: issue.url ?? issue.html_url ?? null
      }
    })
  const missingIssueNumbers = expectedIssueNumbers.filter((number) => !byNumber.has(number))
  const openIssueNumbers = records.filter((issue) => issue.state !== 'CLOSED').map((issue) => issue.number)
  return {
    schema: 'fsusblog.issue-1051-child-status.v1',
    status: missingIssueNumbers.length === 0 && openIssueNumbers.length === 0 ? 'closed' : 'blocked',
    repository: String(repository ?? '').trim() || null,
    capturedAt,
    expectedIssueNumbers,
    issueCount: records.length,
    issues: records,
    missingIssueNumbers,
    openIssueNumbers
  }
}

export function validateChildIssueStatusEvidence(evidence) {
  const errors = []
  const expected = Array.from({ length: 19 }, (_, index) => 1032 + index)
  const records = Array.isArray(evidence?.issues) ? evidence.issues : []
  const actual = records.map((issue) => Number(issue?.number))
  const unique = new Set(actual)
  if (evidence?.schema !== 'fsusblog.issue-1051-child-status.v1') {
    errors.push('child issue evidence schema is missing or unsupported')
  }
  if (!String(evidence?.repository ?? '').trim()) errors.push('child issue evidence repository is missing')
  if (!Number.isFinite(Date.parse(evidence?.capturedAt ?? ''))) errors.push('child issue evidence capturedAt is missing or invalid')
  if (records.length !== expected.length || unique.size !== expected.length
    || expected.some((number) => !unique.has(number))) {
    errors.push('child issue evidence must contain every issue from #1032 through #1050 exactly once')
  }
  for (const issue of records) {
    if (String(issue?.state ?? '').toUpperCase() !== 'CLOSED') {
      errors.push(`child issue #${issue?.number ?? 'unknown'} is not closed`)
    }
    if (!Number.isFinite(Date.parse(issue?.closedAt ?? ''))) {
      errors.push(`child issue #${issue?.number ?? 'unknown'} has no valid closedAt timestamp`)
    }
    if (!String(issue?.url ?? '').trim()) errors.push(`child issue #${issue?.number ?? 'unknown'} has no URL`)
  }
  if (evidence?.status !== 'closed') errors.push('child issue evidence status is not closed')
  return errors
}

export function validateConvergencePlan(plan) {
  const errors = []
  const expected = Array.from({ length: 19 }, (_, index) => 1032 + index)
  const expectedSet = new Set(expected)
  const stages = Array.isArray(plan?.stages) ? plan.stages : []
  if (stages.length !== 4 || stages.some((stage, index) => stage?.order !== index)) {
    errors.push('convergence plan must declare exact stage orders 0 through 3')
  }
  const seenIssues = new Map()
  let previousStage = -1
  for (const stage of stages) {
    if (!Number.isInteger(stage.order) || stage.order <= previousStage) {
      errors.push(`stage order must be strictly increasing: ${stage.order}`)
    }
    previousStage = stage.order
    if (!Array.isArray(stage.issues)) {
      errors.push(`stage ${stage.order} issues must be an array`)
      continue
    }
    for (const issue of stage.issues) {
      if (seenIssues.has(issue)) errors.push(`issue #${issue} appears in more than one stage`)
      if (!expectedSet.has(issue)) errors.push(`unexpected child issue #${issue} appears in convergence stages`)
      seenIssues.set(issue, stage.order)
    }
  }
  for (const [rawIssue, dependencies] of Object.entries(plan?.issueDependencies ?? {})) {
    const issue = Number(rawIssue)
    if (!seenIssues.has(issue) && issue !== plan.trackingIssue) errors.push(`dependency owner #${issue} is absent from stages`)
    if (!Array.isArray(dependencies)) {
      errors.push(`issue #${issue} dependencies must be an array`)
      continue
    }
    for (const dependency of dependencies) {
      if (!seenIssues.has(dependency)) {
        errors.push(`issue #${issue} depends on missing issue #${dependency}`)
        continue
      }
      if (seenIssues.has(issue) && seenIssues.get(dependency) >= seenIssues.get(issue)) {
        errors.push(`issue #${issue} depends on non-earlier issue #${dependency}`)
      }
    }
  }
  for (const issue of expected) {
    if (!seenIssues.has(issue)) errors.push(`convergence plan misses issue #${issue}`)
  }
  const trackingDependencies = Array.isArray(plan?.issueDependencies?.[plan?.trackingIssue])
    ? plan.issueDependencies[plan.trackingIssue]
    : []
  const trackingSet = new Set(trackingDependencies)
  if (plan?.trackingIssue !== 1051) errors.push('convergence plan tracking issue must be #1051')
  if (trackingDependencies.length !== expected.length || trackingSet.size !== expected.length
    || expected.some((issue) => !trackingSet.has(issue))) {
    errors.push('tracking issue #1051 must depend on every issue from #1032 through #1050 exactly once')
  }
  const requiredEvidence = new Set(plan?.finalEvidencePaths ?? [])
  if (!Array.isArray(plan?.finalEvidencePaths)
    || requiredEvidence.size !== plan.finalEvidencePaths.length) {
    errors.push('final evidence paths must be a unique array')
  }
  const contractPaths = (plan?.finalEvidenceContracts ?? []).map((contract) => contract?.path)
  if (new Set(contractPaths).size !== contractPaths.length) {
    errors.push('final evidence contracts must have unique paths')
  }
  for (const path of contractPaths) {
    if (!requiredEvidence.has(path)) errors.push(`final evidence contract is not required: ${path}`)
  }
  const sourceOwners = plan?.sourceLockingOwners ?? {}
  if (sourceOwners.backend !== 'tools/check-test-suite-convergence.mjs'
    || sourceOwners.frontend !== 'tests/frontend/checks/static/check-frontend-test-governance.mjs'
    || new Set(Object.values(sourceOwners)).size !== 2) {
    errors.push('source-locking rules must retain exactly one distinct backend and frontend owner')
  }
  return errors
}
