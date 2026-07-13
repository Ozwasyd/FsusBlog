#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  aggregateArtifactPathExists,
  applySupersedes,
  attachCheckpointEvidence,
  createRunId,
  findLatestRunId,
  markCheckpointWallClockTimeout,
  runDag,
  tierResourceUnits,
  validateSupersedesRules
} from './test-matrix/scheduler.mjs'
import {
  buildLocalProfileProjection,
  createLocalBundleTiers,
  localBundleSummaryPath,
  localProfileSystemResources,
  resolveLocalProfileResources,
  validateLocalBundleSummary,
  validateLocalProfileRunSummary,
  validateLocalProfiles
} from './test-matrix/local-profile.mjs'
import { parseMatrix } from './test-matrix/parse-matrix.mjs'
import { assertLocalProductionCapacity, cleanLocalProductionOutputs } from './test-matrix/fresh-production.mjs'
import { cleanupLocalRuntime, cleanupStaleLocalRuntimes } from './test-matrix/local-runtime-cleanup.mjs'
import { cleanupOrphanDotnetBuildServers } from './test-matrix/dotnet-build-server-cleanup.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const matrixFile = process.env.FSUSBLOG_MATRIX_FILE
  ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
  : path.join(root, 'tests/matrix.yml')
const schemaFile = path.join(root, 'tests/matrix.schema.json')
const coverageRegistryFile = process.env.FSUSBLOG_COVERAGE_REGISTRY_FILE
  ? path.resolve(root, process.env.FSUSBLOG_COVERAGE_REGISTRY_FILE)
  : path.join(root, 'tests/coverage-registry.json')
const preflightLogFile = path.join(root, '.tmp/gate-logs/preflight.json')
const prSmartGateSummaryFile = path.join(root, '.tmp/release-evidence/pr-smart-gate-summary.json')
const summaryStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']
const coverageAssertionTypes = ['static', 'unit', 'integration', 'runtime', 'browser', 'perf', 'fuzz', 'mutation']
const runtimeLikeCoverageAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation'])
const coverageTemplateDescriptionPattern = /^Coverage contract for\b/i
const genericCoverageMinimumRequirementPattern = /^(static|unit|integration|runtime|browser|perf|fuzz|mutation) evidence declared by tier\b/i
const cadenceValues = ['pr', 'push', 'nightly', 'release-manual']
const requiredForValues = ['fast', 'production', 'release-final', 'none']
const smartGateModeValues = ['always', 'conditional', 'full-only']
const retentionClassValues = ['must-keep', 'conditional', 'redundant-candidate', 'obsolete']
const executionVariantValues = ['ordinary', 'coverage', 'property', 'model', 'performance', 'runtime']
const uxViewportTierIds = new Set(['ux-viewport-smoke', 'ux-viewport-visual', 'ux-viewport-boundaries'])
const aliases = new Map([
  ['coverage', 'coverage-gate'],
  ['integrity-proof', 'integrity-proof-verification'],
  ['frontend-fast', 'frontend-fast-summary'],
  ['backend-qps-runtime', 'backend-qps'],
  ['endpoint-depth-matrix-generate', 'endpoint-depth'],
  ['endpoint-depth-runtime-smoke', 'endpoint-depth'],
  ['endpoint-depth-runtime-full', 'endpoint-depth']
])
const frontendFastSplitIds = [
  'frontend-build',
  'frontend-unit-shard',
  'frontend-property-model-perf',
  'frontend-runtime-contracts',
  'frontend-static-governance',
  'frontend-fast-summary'
]
const frontendFastExecutableSplitIds = frontendFastSplitIds.filter((tierId) => tierId !== 'frontend-fast-summary')
const summaryInvocationId = `${process.env.GITHUB_RUN_ID ?? 'local'}-${process.env.GITHUB_RUN_ATTEMPT ?? '0'}-${process.pid}-${Date.now()}`
const ciSummaryAuthorityId = process.env.GITHUB_RUN_ID && process.env.GITHUB_JOB
  ? `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}-${process.env.GITHUB_JOB}`
  : null

const requiredFields = [
  'id',
  'owner',
  'command',
  'dependsOn',
  'services',
  'parallelizable',
  'exclusiveResources',
  'phase',
  'cost',
  'resourceClass',
  'cpuWeight',
  'memoryWeight',
  'minCpuUnits',
  'requiresBootstrap',
  'requiresNode',
  'requiresDotnet',
  'requiresPlaywright',
  'cacheProfile',
  'timeoutMinutes',
  'shardable',
  'risk',
  'cadence',
  'requiredFor',
  'coverage',
  'artifacts',
  'evidence',
  'ciJob',
  'localOnly',
  'nightlyOnly'
]

function loadMatrix() {
  if (!fs.existsSync(matrixFile)) {
    throw new Error(`missing ${path.relative(root, matrixFile)}`)
  }
  return parseMatrix(fs.readFileSync(matrixFile, 'utf8'))
}

function loadCoverageRegistry() {
  if (!fs.existsSync(coverageRegistryFile)) {
    return { errors: ['missing tests/coverage-registry.json'], entries: new Map() }
  }
  try {
    const registry = JSON.parse(fs.readFileSync(coverageRegistryFile, 'utf8'))
    if (registry?.schema !== 'fsusblog.coverage-registry.v1') {
      return { errors: [`coverage registry schema must be fsusblog.coverage-registry.v1, got ${registry?.schema ?? 'missing'}`], entries: new Map() }
    }
    if (!Array.isArray(registry.entries)) {
      return { errors: ['coverage registry entries must be an array'], entries: new Map() }
    }
    return {
      errors: [],
      entries: new Map(registry.entries.map((entry) => [entry.id, entry]))
    }
  } catch (error) {
    return {
      errors: [`coverage registry is not valid JSON: ${error.message}`],
      entries: new Map()
    }
  }
}

function relativeToRoot(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/')
}

function tierMap(matrix) {
  return new Map(matrix.tiers.map((tier) => [tier.id, tier]))
}

function logicalTierSystemResources() {
  const cpuCount = Math.max(1, os.availableParallelism?.() ?? os.cpus().length)
  const load1 = process.platform === 'win32' ? 0 : Math.max(0, os.loadavg()[0])
  return {
    cpuCount,
    availableCpuUnits: cpuCount,
    availableMemoryGiB: Math.max(Number.EPSILON, os.freemem() / (1024 ** 3)),
    totalMemoryGiB: Math.max(Number.EPSILON, os.totalmem() / (1024 ** 3)),
    load1
  }
}

function dynamicShardCount(resources) {
  // A CI matrix and its later aggregate job run in different processes and at
  // different load levels.  Derive topology from stable machine capacity, not
  // momentary free memory, so both sides name the same shard artifacts while
  // admission-time CPU/memory grants can still react to live pressure.
  const memorySupportedCpu = Math.max(1, resources.totalMemoryGiB / 2)
  const machineCapacity = Math.max(1, Math.min(resources.availableCpuUnits, memorySupportedCpu))
  return Math.max(1, Math.min(
    Math.floor(resources.availableCpuUnits),
    Math.ceil(Math.sqrt(machineCapacity))
  ))
}

function resolveLogicalTierResources(tiers, resources = logicalTierSystemResources()) {
  const cpuBudget = Math.max(1, Math.floor(resources.availableCpuUnits))
  const memoryBudget = Math.max(Number.EPSILON, Number(resources.availableMemoryGiB))
  return tiers.map((tier) => {
    const hasExplicitFixtureGrant = Number.isFinite(Number(tier.cpuUnits)) && Number(tier.cpuUnits) > 0
      && Number.isFinite(Number(tier.memoryGiB)) && Number(tier.memoryGiB) > 0
    return {
      ...tier,
      // Explicit units are accepted only for isolated scheduler fixtures. The
      // repository matrix validator forbids them, so real logical tiers always
      // use admission-time dynamic grants.
      cpuUnits: hasExplicitFixtureGrant ? Number(tier.cpuUnits) : cpuBudget,
      memoryGiB: hasExplicitFixtureGrant ? Number(tier.memoryGiB) : memoryBudget,
      resourceGrantMode: hasExplicitFixtureGrant ? 'fixed' : 'dynamic',
      maxParallel: tier.parallelizable === true ? cpuBudget : 1,
      defaultShards: tier.shardable === true ? dynamicShardCount(resources) : 1,
      budgetMs: Number(tier.timeoutMinutes) * 60_000
    }
  })
}

function normalizeTierId(id) {
  return aliases.get(id) ?? id
}

function playwrightWorkersForTier(tier) {
  return tier.requiresPlaywright === 'none'
    ? null
    : Math.max(1, Math.floor(tierResourceUnits(tier).cpuUnits))
}

function pathExistsForCommand(command) {
  const [first] = String(command).split(/\s+/)
  if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first)) return true
  const rel = first.replace(/^\.\//, '')
  return fs.existsSync(path.join(root, rel))
}

function isExecutableCommand(command) {
  const [first] = String(command).split(/\s+/)
  if (!first || !/^(tools|tests|src|\.\/tools|\.\/tests|\.\/src)\//.test(first)) return true
  const rel = first.replace(/^\.\//, '')
  const filePath = path.join(root, rel)
  try {
    const stat = fs.statSync(filePath)
    if ((stat.mode & 0o111) !== 0) return true
    if (process.platform === 'win32') {
      if (/\.(?:sh|mjs|js)$/i.test(rel)) return true
      const head = fs.readFileSync(filePath, 'utf8').slice(0, 2)
      return head === '#!'
    }
    return false
  } catch {
    return false
  }
}

function isStaticOnlyEvidencePath(value) {
  const normalized = String(value ?? '').replaceAll(path.sep, '/')
  return normalized.startsWith('docs/')
    || normalized.endsWith('.md')
    || normalized.startsWith('tests/matrix')
    || normalized.startsWith('tests/coverage-registry')
    || normalized.startsWith('tests/backend/Fixtures/')
    || normalized.startsWith('tests/frontend/fixtures/')
    || normalized.startsWith('src/shared/Contracts/Validation/')
    || normalized.startsWith('src/frontend/src/generated/')
}

function unitTestEvidencePath(value) {
  const normalized = String(value ?? '').replaceAll(path.sep, '/')
  return /^tests\/backend\/Unit\/.+\.cs$/.test(normalized)
    || /^tests\/frontend\/unit\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /^tests\/frontend\/property\/.+\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
}

function validateCoverageRegistry(matrix) {
  const errors = []
  const { errors: registryErrors, entries } = loadCoverageRegistry()
  errors.push(...registryErrors)
  if (registryErrors.length > 0) return errors

  const coverageToTiers = new Map()
  for (const tier of matrix.tiers ?? []) {
    for (const coverageId of tier.coverage ?? []) {
      if (!coverageToTiers.has(coverageId)) coverageToTiers.set(coverageId, [])
      coverageToTiers.get(coverageId).push(tier)
    }
  }

  for (const [coverageId, tiers] of coverageToTiers.entries()) {
    const entry = entries.get(coverageId)
    if (!entry) {
      errors.push(`coverage ${coverageId} missing registry entry`)
      continue
    }

    if (entry.id !== coverageId) errors.push(`coverage ${coverageId} registry id mismatch`)
    const matrixTierIds = new Set(tiers.map((tier) => tier.id))
    if (!Array.isArray(entry.tierIds) || entry.tierIds.length === 0) {
      errors.push(`coverage ${coverageId}.tierIds must be non-empty`)
    } else {
      const registryTierIds = new Set(entry.tierIds)
      const duplicateTierIds = entry.tierIds.filter((tierId, index) => entry.tierIds.indexOf(tierId) !== index)
      if (duplicateTierIds.length > 0) {
        errors.push(`coverage ${coverageId}.tierIds contains duplicates: ${[...new Set(duplicateTierIds)].join(', ')}`)
      }
      for (const tierId of registryTierIds) {
        if (!(matrix.tiers ?? []).some((tier) => tier.id === tierId)) {
          errors.push(`coverage ${coverageId}.tierIds references unknown tier: ${tierId}`)
        }
      }
      if (!sameSet(registryTierIds, matrixTierIds)) {
        errors.push(`coverage ${coverageId}.tierIds must exactly match matrix covering tiers; registry=${[...registryTierIds].sort().join(',')} matrix=${[...matrixTierIds].sort().join(',')}`)
      }
    }
    if (typeof entry.description !== 'string' || entry.description.length === 0) {
      errors.push(`coverage ${coverageId}.description missing`)
    } else if (coverageTemplateDescriptionPattern.test(entry.description)) {
      errors.push(`coverage ${coverageId}.description must describe the covered behavior, not use the generic Coverage contract template`)
    }
    if (typeof entry.owner !== 'string' || entry.owner.length === 0) errors.push(`coverage ${coverageId}.owner missing`)
    if (!['low', 'medium', 'high', 'critical'].includes(entry.risk)) errors.push(`coverage ${coverageId}.risk invalid: ${entry.risk}`)
    if (!coverageAssertionTypes.includes(entry.assertionType)) errors.push(`coverage ${coverageId}.assertionType invalid: ${entry.assertionType}`)
    if (typeof entry.failClosedRule !== 'string' || entry.failClosedRule.length === 0) errors.push(`coverage ${coverageId}.failClosedRule missing`)
    if (typeof entry.minimumRequirement !== 'string' || entry.minimumRequirement.length === 0) {
      errors.push(`coverage ${coverageId}.minimumRequirement missing`)
    } else if (genericCoverageMinimumRequirementPattern.test(entry.minimumRequirement)) {
      errors.push(`coverage ${coverageId}.minimumRequirement must state the minimum assertion or evidence, not repeat the tier type`)
    }
    if (!Array.isArray(entry.evidencePaths) || entry.evidencePaths.length === 0) {
      errors.push(`coverage ${coverageId}.evidencePaths must be non-empty`)
      continue
    }

    if (entry.evidencePaths.every(unitTestEvidencePath) && entry.assertionType !== 'unit') {
      errors.push(`coverage ${coverageId}.assertionType must be unit because all evidence paths are unit/property test files`)
    }

    const declaredPaths = new Set(tiers.flatMap((tier) => [...(tier.evidence ?? []), ...(tier.artifacts ?? [])]))
    for (const evidencePath of entry.evidencePaths) {
      if (typeof evidencePath !== 'string' || evidencePath.length === 0) {
        errors.push(`coverage ${coverageId}.evidencePaths contains an invalid path`)
      } else if (!declaredPaths.has(evidencePath)) {
        errors.push(`coverage ${coverageId}.evidencePaths path is not declared by a covering tier: ${evidencePath}`)
      }
    }

    for (const tier of tiers) {
      const tierPaths = new Set([...(tier.evidence ?? []), ...(tier.artifacts ?? [])])
      if (!entry.evidencePaths.some((evidencePath) => tierPaths.has(evidencePath))) {
        errors.push(`coverage ${coverageId} has no registry evidence path for tier ${tier.id}`)
      }
    }

    if (runtimeLikeCoverageAssertionTypes.has(entry.assertionType) && entry.evidencePaths.every(isStaticOnlyEvidencePath)) {
      errors.push(`coverage ${coverageId} assertionType ${entry.assertionType} must not rely only on static docs/source evidence`)
    }
  }

  for (const coverageId of entries.keys()) {
    if (!coverageToTiers.has(coverageId)) errors.push(`coverage registry contains unused id: ${coverageId}`)
  }

  return errors
}

function sameSet(left, right) {
  if (left.size !== right.size) return false
  for (const item of left) {
    if (!right.has(item)) return false
  }
  return true
}

function validateFrontendFastSplit(matrix, byId) {
  const errors = []
  for (const tierId of frontendFastSplitIds) {
    if (!byId.has(tierId)) errors.push(`frontend fast split missing tier ${tierId}`)
  }

  if (byId.has('frontend-fast')) {
    errors.push('frontend-fast must stay split; use frontend-fast-summary alias instead of a monolithic tier')
  }

  const expectedCiJobs = new Map([
    ['frontend-build', 'frontend-build'],
    ['frontend-unit-shard', 'fast-frontend-unit'],
    ['frontend-property-model-perf', 'fast-frontend-unit'],
    ['frontend-runtime-contracts', 'frontend-runtime-contracts'],
    ['frontend-static-governance', 'frontend-static-governance'],
    ['frontend-fast-summary', 'fast-summary']
  ])
  for (const [tierId, ciJob] of expectedCiJobs.entries()) {
    const tier = byId.get(tierId)
    if (tier && tier.ciJob !== ciJob) errors.push(`${tierId}.ciJob must be ${ciJob}`)
  }

  const unitShard = byId.get('frontend-unit-shard')
  if (unitShard) {
    if (unitShard.shardable !== true) errors.push('frontend-unit-shard must be shardable')
    if ('defaultShards' in unitShard) errors.push('frontend-unit-shard.defaultShards must be machine-resolved')
  }

  for (const tierId of ['frontend-build', 'frontend-runtime-contracts', 'frontend-static-governance']) {
    const tier = byId.get(tierId)
    if (tier?.shardable === true) errors.push(`${tierId} must run once and must not be shardable`)
  }

  const summary = byId.get('frontend-fast-summary')
  if (summary) {
    const actual = new Set(summary.dependsOn ?? [])
    const expected = new Set(frontendFastExecutableSplitIds)
    if (!sameSet(actual, expected)) {
      errors.push(`frontend-fast-summary.dependsOn must be ${frontendFastExecutableSplitIds.join(',')}`)
    }
  }

  const fast = byId.get('fast')
  if (fast) {
    if ((fast.dependsOn ?? []).includes('frontend-fast')) {
      errors.push('fast must not depend on deprecated frontend-fast')
    }
    if (!(fast.dependsOn ?? []).includes('frontend-fast-summary')) {
      errors.push('fast must depend on frontend-fast-summary')
    }
  }

  return errors
}

function commandSourcePath(command) {
  return String(command ?? '')
    .split(/\s+/u)
    .map((token) => token.replace(/^['"]|['"]$/gu, ''))
    .find((token) => token.startsWith('tools/') && fs.existsSync(path.join(root, token))) ?? null
}

function cacheInputCoversSource(patternValue, sourcePath) {
  const pattern = String(patternValue).replace(/^\.\//u, '').replaceAll('\\', '/')
  if (pattern === sourcePath || (!pattern.includes('*') && sourcePath.startsWith(`${pattern.replace(/\/$/u, '')}/`))) return true
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${escaped}$`, 'u').test(sourcePath)
}

function validateMatrix(matrix) {
  const errors = []
  const ids = new Set()
  const byId = tierMap(matrix)

  function hasBootstrapDependencyPath(tierId, seen = new Set()) {
    if (seen.has(tierId)) return false
    seen.add(tierId)
    const tier = byId.get(tierId)
    for (const dep of tier?.dependsOn ?? []) {
      if (dep === 'bootstrap' || hasBootstrapDependencyPath(dep, seen)) return true
    }
    return false
  }

  if (matrix.version !== 'fsusblog-test-matrix-v2') {
    errors.push(`version must be fsusblog-test-matrix-v2, got ${matrix.version ?? 'missing'}`)
  }
  if (!fs.existsSync(schemaFile)) {
    errors.push('missing tests/matrix.schema.json')
  }
  if (!Array.isArray(matrix.tiers) || matrix.tiers.length === 0) {
    errors.push('tiers must be a non-empty list')
  }

  for (const tier of matrix.tiers) {
    if (!tier.id) {
      errors.push('tier missing id')
      continue
    }
    if (ids.has(tier.id)) errors.push(`duplicate tier id: ${tier.id}`)
    ids.add(tier.id)

    for (const field of requiredFields) {
      if (!(field in tier)) errors.push(`${tier.id} missing ${field}`)
    }
    for (const field of ['dependsOn', 'services', 'exclusiveResources', 'coverage', 'artifacts', 'evidence']) {
      if (!Array.isArray(tier[field])) errors.push(`${tier.id}.${field} must be an array`)
    }
    for (const field of ['supersedes', 'cacheInputs']) {
      if (field in tier && !Array.isArray(tier[field])) errors.push(`${tier.id}.${field} must be an array`)
    }
    const commandSource = commandSourcePath(tier.command)
    if ((tier.cacheInputs?.length ?? 0) > 0 && commandSource && !tier.cacheInputs.some((input) => cacheInputCoversSource(input, commandSource))) {
      errors.push(`${tier.id}.cacheInputs must cover command source ${commandSource}`)
    }
    for (const field of ['parallelizable', 'shardable', 'localOnly', 'nightlyOnly', 'requiresNode', 'requiresDotnet']) {
      if (typeof tier[field] !== 'boolean') errors.push(`${tier.id}.${field} must be boolean`)
    }
    if ('manualOnly' in tier && typeof tier.manualOnly !== 'boolean') {
      errors.push(`${tier.id}.manualOnly must be boolean`)
    }
    if ('selfBootstraps' in tier && typeof tier.selfBootstraps !== 'boolean') {
      errors.push(`${tier.id}.selfBootstraps must be boolean`)
    }
    if ('workflowBootstraps' in tier && typeof tier.workflowBootstraps !== 'boolean') {
      errors.push(`${tier.id}.workflowBootstraps must be boolean`)
    }
    if ('prDefault' in tier && typeof tier.prDefault !== 'boolean') {
      errors.push(`${tier.id}.prDefault must be boolean`)
    }
    for (const field of ['triggerPaths', 'triggerFiles', 'triggerCoverage']) {
      if (field in tier && !Array.isArray(tier[field])) errors.push(`${tier.id}.${field} must be an array`)
    }
    if ('triggerReason' in tier && typeof tier.triggerReason !== 'string') {
      errors.push(`${tier.id}.triggerReason must be string`)
    }
    if ('smartGateMode' in tier && !smartGateModeValues.includes(tier.smartGateMode)) {
      errors.push(`${tier.id}.smartGateMode is invalid: ${tier.smartGateMode}`)
    }
    if ('retentionClass' in tier && !retentionClassValues.includes(tier.retentionClass)) {
      errors.push(`${tier.id}.retentionClass is invalid: ${tier.retentionClass}`)
    }
    if (tier.smartGateMode === 'conditional') {
      if (typeof tier.triggerReason !== 'string' || tier.triggerReason.trim().length === 0) {
        errors.push(`${tier.id}.smartGateMode=conditional requires triggerReason`)
      }
      const triggerCount = (tier.triggerPaths?.length ?? 0) + (tier.triggerFiles?.length ?? 0) + (tier.triggerCoverage?.length ?? 0)
      if (triggerCount === 0 && tier.prDefault !== true) {
        errors.push(`${tier.id}.smartGateMode=conditional requires triggerPaths, triggerFiles, triggerCoverage, or prDefault=true`)
      }
    }
    if (typeof tier.timeoutMinutes !== 'number' || tier.timeoutMinutes < 1) {
      errors.push(`${tier.id}.timeoutMinutes must be a positive number`)
    }
    for (const field of ['cpuWeight', 'memoryWeight']) {
      if (typeof tier[field] !== 'number' || tier[field] <= 0) errors.push(`${tier.id}.${field} must be positive`)
    }
    if (!Number.isInteger(tier.minCpuUnits) || tier.minCpuUnits < 1) {
      errors.push(`${tier.id}.minCpuUnits must be a positive integer`)
    }
    for (const field of ['cpuUnits', 'memoryGiB']) {
      if (field in tier) errors.push(`${tier.id}.${field} is resolved at runtime and must not be declared`)
    }
    if ('executionKey' in tier && (typeof tier.executionKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tier.executionKey))) {
      errors.push(`${tier.id}.executionKey is invalid: ${tier.executionKey}`)
    }
    if ('executionVariant' in tier && !executionVariantValues.includes(tier.executionVariant)) {
      errors.push(`${tier.id}.executionVariant is invalid: ${tier.executionVariant}`)
    }
    if ((tier.supersedes?.length ?? 0) > 0 && !tier.executionKey) {
      errors.push(`${tier.id}.supersedes requires executionKey`)
    }
    for (const field of ['supersedes', 'cacheInputs']) {
      if (Array.isArray(tier[field]) && tier[field].some((value) => typeof value !== 'string' || value.length === 0)) {
        errors.push(`${tier.id}.${field} entries must be non-empty strings`)
      }
    }
    if (typeof tier.phase === 'number' && tier.phase < 0) errors.push(`${tier.id}.phase must be zero or greater`)
    if (!['low', 'medium', 'high', 'critical'].includes(tier.risk)) {
      errors.push(`${tier.id}.risk is invalid: ${tier.risk}`)
    }
    if (!cadenceValues.includes(tier.cadence)) {
      errors.push(`${tier.id}.cadence is invalid: ${tier.cadence}`)
    }
    if (!requiredForValues.includes(tier.requiredFor)) {
      errors.push(`${tier.id}.requiredFor is invalid: ${tier.requiredFor}`)
    }
    if (tier.manualOnly === true && tier.cadence !== 'release-manual') {
      errors.push(`${tier.id}.manualOnly requires cadence=release-manual`)
    }
    if (tier.manualOnly !== true && tier.cadence === 'release-manual') {
      errors.push(`${tier.id}.cadence=release-manual requires manualOnly=true`)
    }
    if (tier.nightlyOnly === true && tier.cadence !== 'nightly') {
      errors.push(`${tier.id}.nightlyOnly requires cadence=nightly`)
    }
    if (tier.nightlyOnly !== true && tier.cadence === 'nightly') {
      errors.push(`${tier.id}.cadence=nightly requires nightlyOnly=true`)
    }
    if (tier.localOnly === true && tier.requiredFor !== 'none') {
      errors.push(`${tier.id}.localOnly must use requiredFor=none`)
    }
    if (tier.manualOnly === true && tier.requiredFor === 'production') {
      errors.push(`${tier.id}.manualOnly must not be requiredFor=production`)
    }
    if ((tier.risk === 'high' || tier.risk === 'critical') && (tier.cadence === 'pr' || tier.cadence === 'push') && tier.localOnly !== true && tier.requiredFor === 'none') {
      errors.push(`${tier.id}.risk=${tier.risk} with cadence=${tier.cadence} needs requiredFor other than none`)
    }
    if (!['low', 'medium', 'high', 'very-high'].includes(tier.cost)) {
      errors.push(`${tier.id}.cost is invalid: ${tier.cost}`)
    }
    if (!['cpu', 'io', 'browser', 'network', 'benchmark', 'database'].includes(tier.resourceClass)) {
      errors.push(`${tier.id}.resourceClass is invalid: ${tier.resourceClass}`)
    }
    if (!['none', 'frontend', 'backend', 'full'].includes(tier.requiresBootstrap)) {
      errors.push(`${tier.id}.requiresBootstrap is invalid: ${tier.requiresBootstrap}`)
    }
    if (!['none', 'chromium', 'all'].includes(tier.requiresPlaywright)) {
      errors.push(`${tier.id}.requiresPlaywright is invalid: ${tier.requiresPlaywright}`)
    }
    if (!['none', 'frontend', 'backend', 'full'].includes(tier.cacheProfile)) {
      errors.push(`${tier.id}.cacheProfile is invalid: ${tier.cacheProfile}`)
    }
    const cacheNeedsFrontend = tier.cacheProfile === 'frontend' || tier.cacheProfile === 'full'
    const cacheNeedsBackend = tier.cacheProfile === 'backend' || tier.cacheProfile === 'full'
    if (cacheNeedsFrontend && tier.requiresNode !== true) {
      errors.push(`${tier.id}.cacheProfile ${tier.cacheProfile} requires requiresNode=true`)
    }
    if (cacheNeedsBackend && tier.requiresDotnet !== true) {
      errors.push(`${tier.id}.cacheProfile ${tier.cacheProfile} requires requiresDotnet=true`)
    }
    if (tier.requiresPlaywright !== 'none' && tier.requiresNode !== true) {
      errors.push(`${tier.id}.requiresPlaywright requires requiresNode=true`)
    }
    if ('playwrightWorkers' in tier) errors.push(`${tier.id}.playwrightWorkers is machine-resolved and must not be declared`)
    if (tier.parallelizable === false && tier.maxParallel !== 1) {
      errors.push(`${tier.id} is not parallelizable and must declare maxParallel=1`)
    }
    if (tier.parallelizable === false && tier.requiresPlaywright !== 'none'
      && (typeof tier.serialReason !== 'string' || tier.serialReason.trim().length === 0)) {
      errors.push(`${tier.id} serial Playwright execution requires serialReason`)
    }
    if (tier.parallelizable === true && 'maxParallel' in tier) {
      errors.push(`${tier.id}.maxParallel is machine-resolved and must be omitted when parallelizable=true`)
    }
    for (const dep of tier.dependsOn ?? []) {
      const depTier = byId.get(dep)
      if (!depTier) {
        errors.push(`${tier.id} depends on missing tier ${dep}`)
      } else if (typeof tier.phase === 'number' && typeof depTier.phase === 'number' && depTier.phase > tier.phase) {
        errors.push(`${tier.id} depends on ${dep} with later phase ${depTier.phase} > ${tier.phase}`)
      }
    }
    if (
      tier.requiresBootstrap !== 'none'
      && !hasBootstrapDependencyPath(tier.id)
      && tier.selfBootstraps !== true
      && tier.workflowBootstraps !== true
    ) {
      errors.push(`${tier.id}.requiresBootstrap=${tier.requiresBootstrap} needs dependency path to bootstrap, selfBootstraps=true, or workflowBootstraps=true`)
    }
    if (tier.requiresBootstrap === 'none' && (tier.selfBootstraps === true || tier.workflowBootstraps === true)) {
      errors.push(`${tier.id} declares bootstrap source metadata but requiresBootstrap=none`)
    }
    if (!pathExistsForCommand(tier.command)) {
      errors.push(`${tier.id} command path does not exist: ${tier.command}`)
    } else if (!isExecutableCommand(tier.command)) {
      errors.push(`${tier.id} command path is not executable: ${tier.command}`)
    }
    if (tier.shardable === false && tier.defaultShards !== 1) {
      errors.push(`${tier.id} is not shardable and must declare defaultShards=1`)
    }
    if (tier.shardable === true && 'defaultShards' in tier) {
      errors.push(`${tier.id}.defaultShards is machine-resolved and must be omitted when shardable=true`)
    }
  }

  errors.push(...validateFrontendFastSplit(matrix, byId))
  errors.push(...validateLocalProfiles(matrix.localProfiles, matrix.tiers))
  errors.push(...validateCoverageRegistry(matrix))
  errors.push(...validateSupersedesRules(matrix.tiers, loadCoverageRegistry().entries))

  const visiting = new Set()
  const visited = new Set()
  function visit(id, stack = []) {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      errors.push(`cycle detected: ${[...stack, id].join(' -> ')}`)
      return
    }
    visiting.add(id)
    const tier = byId.get(id)
    for (const dep of tier?.dependsOn ?? []) visit(dep, [...stack, id])
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)

  return errors
}

function planTier(matrix, requestedId) {
  const byId = tierMap(matrix)
  const targetId = normalizeTierId(requestedId)
  if (!byId.has(targetId)) throw new Error(`unknown tier: ${requestedId}`)

  const planned = []
  const visited = new Set()

  function visit(id) {
    if (visited.has(id)) return
    const tier = byId.get(id)
    if (!tier) throw new Error(`missing dependency: ${id}`)
    for (const dep of tier.dependsOn) visit(dep)
    visited.add(id)
    planned.push(tier)
  }

  visit(targetId)
  return planned
}

function printPlan(tiers) {
  for (const [index, tier] of tiers.entries()) {
    const deps = tier.dependsOn.length > 0 ? ` deps=${tier.dependsOn.join(',')}` : ''
    const shard = tier.shardable ? ` shards=${tier.defaultShards}` : ''
    console.log(`${index + 1}. ${tier.id} [job=${tier.ciJob} phase=${tier.phase} resource=${tier.resourceClass} cost=${tier.cost} timeout=${tier.timeoutMinutes}m risk=${tier.risk}${shard}]${deps}`)
    console.log(`   ${tier.command}`)
  }
}

function namespaceFor(tier, shard, schedulerRunId = null) {
  if (process.env.FSUSBLOG_TEST_NAMESPACE?.trim()) return namespaceSlug(process.env.FSUSBLOG_TEST_NAMESPACE)
  const githubRunId = process.env.GITHUB_RUN_ID
  const runId = githubRunId || schedulerRunId || 'local'
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '0'
  const job = process.env.MATRIX_JOB || tier.ciJob || tier.id
  const shardValue = shard ?? process.env.MATRIX_SHARD ?? '0'
  return namespaceSlug(`${runId}-${githubRunId ? attempt : 'fresh'}-${job}-${shardValue}`)
}

function namespaceSlug(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return !normalized || normalized === '.' || normalized === '..' ? 'local' : normalized
}

function loadNamespaceEnv(namespace) {
  const envFile = path.join(root, '.tmp/env', `${namespaceSlug(namespace)}.env`)
  if (!fs.existsSync(envFile)) return {}
  const values = {}
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match) continue
    values[match[1]] = match[2]
  }
  return values
}

function prepareNamespaceEnvironmentIfNeeded(tiers, namespace) {
  if (!tiers.some((tier) => tier.selfBootstraps === true)) return
  const envFile = path.join(root, '.tmp/env', `${namespaceSlug(namespace)}.env`)
  if (fs.existsSync(envFile)) return
  const result = spawnSync('bash', [path.join(root, 'tools/bootstrap-acceptance-env.sh'), '--prepare-env-only'], {
    cwd: root,
    env: { ...process.env, FSUSBLOG_TEST_NAMESPACE: namespace },
    encoding: 'utf8'
  })
  if (result.stdout) process.stderr.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`failed to prepare namespace environment for ${namespace}`)
}

function applyNamespaceBuildEnvironment(tier, env) {
  if (tier.id === 'frontend-build' && !env.VITE_API_BASE_URL && env.FSUSBLOG_DEBUG_BACKEND_URL) {
    env.VITE_API_BASE_URL = env.FSUSBLOG_DEBUG_BACKEND_URL
  }
  return env
}

function resourceEnvironmentForTier(tier, baseEnv = {}) {
  const { cpuUnits, memoryGiB } = tierResourceUnits(tier)
  const workerBudget = Math.max(1, Math.floor(cpuUnits))
  const cappedWorkerBudget = (name) => {
    const requested = Number.parseInt(String(baseEnv[name] ?? process.env[name] ?? ''), 10)
    return Number.isFinite(requested) && requested > 0 ? Math.min(workerBudget, requested) : workerBudget
  }
  const env = {
    FSUSBLOG_TIER_CPU_UNITS: String(cpuUnits),
    FSUSBLOG_TIER_MEMORY_GIB: String(memoryGiB),
    FSUSBLOG_VITEST_MAX_WORKERS: String(cappedWorkerBudget('FSUSBLOG_VITEST_MAX_WORKERS')),
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(cappedWorkerBudget('FSUSBLOG_COMMAND_MANIFEST_WORKERS')),
    FSUSBLOG_PLAYWRIGHT_WORKERS: String(cappedWorkerBudget('FSUSBLOG_PLAYWRIGHT_WORKERS'))
  }
  if (tier.physicalBundleId) {
    env.FSUSBLOG_BUNDLE_CPU_BUDGET = String(workerBudget)
    env.FSUSBLOG_BUNDLE_MEMORY_GIB = String(memoryGiB)
    if (Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0) {
      env.FSUSBLOG_BUNDLE_DEADLINE_MS = String(tier.budgetMs)
    }
  }
  if (Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0) {
    env.FSUSBLOG_TIER_DEADLINE_MS = String(tier.budgetMs)
  }
  return env
}

function cleanupSensitiveFixtures(namespace, namespaceEnv = {}) {
  const configuredRoot = namespaceEnv.FSUSBLOG_FIXTURE_ROOT ?? process.env.FSUSBLOG_FIXTURE_ROOT
  const evidenceFile = path.join(root, '.tmp/release-evidence/sensitive-fixture-cleanup.json')
  ensureOutputDirectory(evidenceFile)
  if (configuredRoot) {
    fs.writeFileSync(evidenceFile, `${JSON.stringify({
      schema: 'fsusblog.sensitive-fixture-cleanup.v1',
      status: 'external-root-skipped',
      namespace,
      reason: 'FSUSBLOG_FIXTURE_ROOT is externally managed',
      generatedAt: new Date().toISOString()
    }, null, 2)}\n`)
    return
  }

  const fixtureRoot = path.join(root, '.tmp/fixtures', namespaceSlug(namespace))
  const authDirectory = path.join(fixtureRoot, 'auth')
  const existed = fs.existsSync(authDirectory)
  fs.rmSync(authDirectory, { recursive: true, force: true })
  fs.writeFileSync(evidenceFile, `${JSON.stringify({
    schema: 'fsusblog.sensitive-fixture-cleanup.v1',
    status: 'ok',
    namespace,
    removedAuthDirectory: existed,
    generatedAt: new Date().toISOString()
  }, null, 2)}\n`)
}

function parseRunOptions(args) {
  const options = { planOnly: false, shard: null, noDeps: false, resume: false, fresh: false, maxParallel: null, logicalDag: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--no-deps') options.noDeps = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else if (arg === '--resume') options.resume = true
    else if (arg === '--fresh') options.fresh = true
    else if (arg === '--logical-dag') options.logicalDag = true
    else if (arg === '--max-parallel') options.maxParallel = Number(args[++index])
    else if (arg.startsWith('--max-parallel=')) options.maxParallel = Number(arg.slice('--max-parallel='.length))
    else throw new Error(`unknown run option: ${arg}`)
  }
  normalizeSchedulerOptions(options)
  return options
}

function normalizeSchedulerOptions(options) {
  if (options.resume && options.fresh) throw new Error('--resume and --fresh are mutually exclusive')
  if (options.maxParallel !== null && (!Number.isInteger(options.maxParallel) || options.maxParallel < 1)) {
    throw new Error('--max-parallel must be a positive integer')
  }
  if (process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true') {
    if (options.resume) console.error('[matrix] CI forces --fresh; ignoring --resume')
    options.resume = false
    options.fresh = true
  } else if (!options.resume && !options.fresh) {
    options.fresh = true
  }
}

function schedulerRunIdentity(targetTierId, options) {
  const runsRoot = path.join(root, '.tmp/test-runs')
  const explicitRunId = process.env.FSUSBLOG_TEST_RUN_ID
  const resumedRunId = options.resume && !explicitRunId ? findLatestRunId(runsRoot, targetTierId) : null
  return {
    runsRoot,
    runId: explicitRunId || resumedRunId || createRunId(targetTierId)
  }
}

function schedulerRunIsActive(runId) {
  const lockPath = path.join(root, '.tmp/test-runs/.locks', `${runId}.lock`)
  const ownerFile = path.join(lockPath, 'owner.json')
  if (!fs.existsSync(lockPath)) return false
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    const pid = Number(owner.pid)
    if (!Number.isInteger(pid) || pid <= 0) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < 30_000
    } catch {
      return true
    }
  }
}

function applyUxViewportResumeEnvironment(env, tier, resume) {
  if (!uxViewportTierIds.has(tier.id)) return env
  if (resume) env.FSUSBLOG_UX_VIEWPORT_RESUME = '1'
  else env.FSUSBLOG_UX_VIEWPORT_RESUME = '0'
  return env
}

function tierReproductionCommand(tier, options = {}) {
  const args = [`./tools/test.sh ci-tier ${tier.id}`]
  if (options.noDeps) args.push('--no-deps')
  if (options.shard) args.push(`--shard ${options.shard}`)
  return args.join(' ')
}

function ciJobReproductionCommand(jobId, matrix = null) {
  if (matrix && ciJobExecutionMode(matrix, jobId) === 'aggregate') {
    return `node tools/run-test-matrix.mjs aggregate ${jobId}`
  }
  return `./tools/test.sh ci-job ${jobId}`
}

function jobSummaryPath(jobId) {
  return path.join(root, '.tmp/release-evidence/jobs', `${jobId}.json`)
}

function readExistingJobSummary(jobId) {
  const file = jobSummaryPath(jobId)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function stageForTier(tier, details = {}) {
  if (details.stage) return details.stage
  if (tier.id === 'validate-matrix') return 'setup'
  if (tier.id === 'bootstrap' || String(tier.command).includes('bootstrap-acceptance-env')) return 'bootstrap'
  if (tier.id === 'release-evidence' || tier.id === 'release-closeout' || tier.id === 'release-final') return 'artifact'
  if (tier.id === 'production') return 'summary'
  return 'test'
}

function matrixShardId(value) {
  const match = String(value ?? '').match(/^(\d+)\/(\d+)$/)
  return match ? `${match[1]}-of-${match[2]}` : null
}

function shardId(index, total) {
  return `${index}-of-${total}`
}

function safeMatrixValue(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/^-+|-+$/g, '')
}

function summaryJobIdForTier(tier, details = {}) {
  if (details.jobId) return details.jobId

  const explicitJobId = safeMatrixValue(process.env.FSUSBLOG_CI_JOB_ID)
  if (explicitJobId) return explicitJobId

  const parts = [tier.ciJob]
  const browser = tier.requiresPlaywright === 'all' ? safeMatrixValue(process.env.FSUSBLOG_PLAYWRIGHT_BROWSERS) : ''
  const shard = matrixShardId(process.env.MATRIX_SHARD)
  if (browser && !browser.includes('-') && !browser.includes(',')) parts.push(browser)
  if (shard) parts.push(shard)
  return parts.filter(Boolean).join('-')
}

function mergeStageDurations(existing, stage, durationMs) {
  const durations = Object.fromEntries(summaryStages.map((name) => [name, Number(existing?.stageDurationsMs?.[name] ?? 0)]))
  if (summaryStages.includes(stage)) {
    durations[stage] += Math.max(0, durationMs)
  }
  return durations
}

function frontendFastTimingFiles(tierId) {
  const slug = safeMatrixValue(tierId) || 'frontend-fast'
  return {
    summaryFile: path.join(root, '.tmp/frontend/timings', `${slug}.json`),
    jsonlFile: path.join(root, '.tmp/frontend/timings', `${slug}.jsonl`)
  }
}

function readFrontendFastGroupEvidence(tierId) {
  const { summaryFile, jsonlFile } = frontendFastTimingFiles(tierId)
  if (fs.existsSync(summaryFile)) {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    return summary.groups ?? []
  }
  if (fs.existsSync(jsonlFile)) {
    return fs.readFileSync(jsonlFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return []
}

function frontendFastGroupEvidence(tier) {
  if (tier.id !== 'frontend-fast' && tier.id !== 'frontend-fast-summary' && !frontendFastExecutableSplitIds.includes(tier.id)) return null
  try {
    const tierIds = frontendFastExecutableSplitIds.includes(tier.id)
      ? [tier.id]
      : frontendFastExecutableSplitIds
    const groups = tierIds.flatMap((tierId) => readFrontendFastGroupEvidence(tierId).map((group) => ({ ...group, tierId })))
    return {
      groupDurationsMs: Object.fromEntries(groups.map((item) => [`${item.tierId}:${item.group}`, Number(item.durationMs) || 0])),
      groupResults: groups
    }
  } catch (error) {
    return {
      groupDurationsMs: {},
      groupResults: [],
      groupDurationError: error.message
    }
  }
  return null
}

function writeJobSummary(matrix, tier, status, startedAt, details = {}) {
  const jobId = summaryJobIdForTier(tier, details)
  const schedulerRunId = ciSummaryAuthorityId ?? details.schedulerRunId ?? summaryInvocationId
  const existingCandidate = readExistingJobSummary(jobId)
  const existing = existingCandidate?.schedulerRunId === schedulerRunId ? existingCandidate : null
  const jobTiers = matrix.tiers
    .filter((item) => item.ciJob === tier.ciJob && item.localOnly !== true && item.nightlyOnly !== true && item.manualOnly !== true)
    .map((item) => item.id)
  const knownTierIds = new Set(matrix.tiers.map((item) => item.id))
  const existingTierIds = (existing?.tierIds ?? []).filter((id) => knownTierIds.has(id))
  const tierIds = [...new Set([...existingTierIds, ...jobTiers.filter((id) => id === tier.id), tier.id])].filter(Boolean)
  const artifacts = [...new Set([
    ...(existing?.artifacts ?? []),
    ...(tier.artifacts ?? []),
    ...(tier.evidence ?? []).filter((item) => String(item).startsWith('.tmp/'))
  ])].sort()
  const playwrightWorkers = playwrightWorkersForTier(tier)
  const deltaMs = Math.max(0, Date.now() - startedAt)
  const durationMs = Math.max(0, Number(existing?.durationMs ?? 0)) + deltaMs
  const stage = stageForTier(tier, details)
  const groupEvidence = frontendFastGroupEvidence(tier)
  const summary = {
    schema: 'fsusblog.ci.job-result.v1',
    jobId,
    ciJob: tier.ciJob,
    tierIds,
    status,
    failureStage: status === 'success' ? null : (details.failureStage ?? stage),
    rootCause: status === 'success' ? null : (details.rootCause ?? `${tier.id} exited non-zero`),
    durationMs,
    stageDurationsMs: mergeStageDurations(existing, stage, deltaMs),
    playwrightWorkers,
    artifacts,
    localReproduction: details.localReproduction ?? ciJobReproductionCommand(tier.ciJob, matrix),
    commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? '0',
    schedulerRunId,
    physicalBundleId: details.physicalBundleId ?? existing?.physicalBundleId ?? null,
    executionSource: details.executionSource ?? existing?.executionSource ?? 'fresh',
    testIds: [...new Set([...(existing?.testIds ?? []), ...(details.testIds ?? [])])].sort(),
    artifactDigests: {
      ...(existing?.artifactDigests ?? {}),
      ...(details.artifactDigests ?? {})
    },
    generatedAt: new Date().toISOString(),
    ...(groupEvidence ?? {})
  }
  const outFile = jobSummaryPath(jobId)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
}

function isCiEnvironment() {
  return process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true'
}

function shouldUseLocalProfile(matrix, tierId, options) {
  const targetTierId = normalizeTierId(tierId)
  return !isCiEnvironment()
    && options.logicalDag !== true
    && options.noDeps !== true
    && Boolean(matrix.localProfiles?.[targetTierId])
}

function fileDigest(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function writeSummaryOnlyEvidence(profileId, profile, runId, sourceState) {
  const evidence = {}
  for (const tierId of profile.summaryOnly ?? []) {
    const outFile = path.join(root, `.tmp/local-${profileId}/summary-only/${tierId}.json`)
    const payload = {
      schema: 'fsusblog.local-production.summary-only.v1',
      tierId,
      status: 'collected-blocked',
      executionSource: 'external-environment',
      schedulerRunId: runId,
      sourceState,
      generatedAt: new Date().toISOString()
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`)
    evidence[tierId] = {
      ...payload,
      evidencePath: relativeToRoot(outFile),
      artifactDigest: fileDigest(outFile)
    }
  }
  return evidence
}

function projectLocalBundleSummaries(matrix, profileId, profile, runId, completedTierIds) {
  const byId = tierMap(matrix)
  const projected = []
  const bundleSummaries = {}
  for (const bundle of profile.bundles) {
    const physicalTierId = `local-${profileId}-${bundle.id}`
    if (!completedTierIds.has(physicalTierId)) continue
    const summaryFile = path.join(root, localBundleSummaryPath(profileId, bundle.id))
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    const errors = validateLocalBundleSummary(summary, bundle, { expectedRunId: runId })
    if (errors.length > 0) throw new Error(`${bundle.id} bundle evidence invalid: ${errors.join('; ')}`)
    bundleSummaries[bundle.id] = summary
    for (const tierId of bundle.members) {
      const tier = byId.get(tierId)
      const member = summary.members[tierId]
      const startedAt = Date.now() - Math.max(0, Number(member.durationMs) || 0)
      writeJobSummary(matrix, tier, 'success', startedAt, {
        schedulerRunId: runId,
        physicalBundleId: bundle.id,
        executionSource: 'fresh',
        testIds: member.testIds,
        artifactDigests: member.artifactDigests
      })
      projected.push(tierId)
    }
  }
  return { projectedTierIds: projected, bundleSummaries }
}

async function runLocalProfile(matrix, profileId, options) {
  if (options.resume) throw new Error(`local ${profileId} profile is fresh-only; use --logical-dag --resume for diagnostics`)
  const wallClockStartedAtMs = Number(process.env.FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS ?? Date.now())
  if (!Number.isFinite(wallClockStartedAtMs) || wallClockStartedAtMs <= 0 || wallClockStartedAtMs > Date.now()) {
    throw new Error('FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS must be a valid epoch timestamp that is not in the future')
  }
  const profile = matrix.localProfiles[profileId]
  const staleCleanup = options.planOnly ? null : cleanupStaleLocalRuntimes({
    root,
    discoverUntracked: true,
    legacyContainerMinimumAgeMs: profile.budgetMs * 2,
    orphanTerminationGraceMs: Math.ceil(profile.budgetMs / 100)
  })
  const dotnetBuildServerPreflightPids = options.planOnly ? [] : cleanupOrphanDotnetBuildServers({
    root,
    currentRunId: process.env.FSUSBLOG_TEST_RUN_ID ?? '',
    currentNamespace: process.env.FSUSBLOG_TEST_NAMESPACE ?? '',
    includeCurrentBinding: false,
    includeInactiveProductionRuns: true,
    isRunActive: schedulerRunIsActive,
    terminationGraceMs: Math.ceil(profile.budgetMs / 100)
  })
  const detectedResources = localProfileSystemResources(profile, {
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
    availableMemoryGiB: os.freemem() / (1024 ** 3),
    load1: process.platform === 'win32' ? 0 : os.loadavg()[0]
  })
  const resolvedProfile = resolveLocalProfileResources(profile, detectedResources)
  const launchParallelism = Math.min(options.maxParallel ?? detectedResources.launchParallelism, detectedResources.launchParallelism)
  const physicalTiers = createLocalBundleTiers(profileId, resolvedProfile, { maxParallel: launchParallelism })
  for (const bundle of resolvedProfile.bundles) {
    console.error(`[matrix:${profileId}] resolved bundle=${bundle.id} cpu=${bundle.cpuUnits} memory=${bundle.memoryGiB.toFixed(2)}GiB deadline=${bundle.budgetMs}ms stepMaxParallel=${bundle.stepMaxParallel}`)
  }
  if (options.planOnly) {
    printPlan(physicalTiers.map((tier) => ({
      ...tier,
      ciJob: `local-${profileId}`,
      timeoutMinutes: Number.isFinite(Number(tier.budgetMs)) ? Math.ceil(tier.budgetMs / 60_000) : 'observe-only',
      risk: 'critical',
      shardable: false,
      defaultShards: 1
    })))
    return
  }

  console.error(`[matrix:${profileId}] stale runtime cleanup namespaces=${staleCleanup.namespaces.length} processes=${staleCleanup.terminatedPids.length} containers=${staleCleanup.removedContainers.length} dotnetBuildServers=${dotnetBuildServerPreflightPids.length}`)
  cleanLocalProductionOutputs(root)
  const capacity = assertLocalProductionCapacity({ root })
  console.error(`[matrix:${profileId}] capacity preflight=${capacity.measurements.map(({ directory, availableBytes }) => `${directory}:${(availableBytes / (1024 ** 3)).toFixed(1)}GiB`).join(',')}`)
  console.error(`[matrix:${profileId}] dynamic resources cpu=${detectedResources.availableCpuUnits}/${detectedResources.cpuCount} memory=${detectedResources.availableMemoryGiB.toFixed(1)}GiB reserve=${detectedResources.memoryReserveGiB.toFixed(1)}GiB load1=${detectedResources.load1.toFixed(2)} launchParallelism=${launchParallelism}`)
  const target = physicalTiers.at(-1)
  target.selfBootstraps = true
  const { runsRoot, runId } = schedulerRunIdentity(profileId, { ...options, fresh: true, resume: false })
  const runNamespace = namespaceFor({ id: profileId, ciJob: `local-${profileId}` }, null, runId)
  prepareNamespaceEnvironmentIfNeeded(physicalTiers, runNamespace)

  let result
  try {
    result = await runDag({
      tiers: physicalTiers,
      root,
      runsRoot,
      runId,
      targetTierId: profileId,
      mode: 'fresh',
      resume: false,
      maxParallel: launchParallelism,
      wallClockBudgetMs: profile.enforceBudget === false ? null : profile.budgetMs,
      wallClockStartedAtMs,
      collectFailures: true,
      systemResources: detectedResources,
      teeOutput: true,
      envForTier(tier) {
        const env = applyNamespaceBuildEnvironment(tier, {
          ...loadNamespaceEnv(runNamespace),
          CURRENT_TIER: tier.id,
          MATRIX_JOB: `local-${profileId}`,
          FSUSBLOG_TEST_NAMESPACE: runNamespace,
          FSUSBLOG_TEST_RUN_ID: runId,
          FSUSBLOG_LOCAL_PROFILE: profileId,
          FSUSBLOG_PHYSICAL_BUNDLE_ID: tier.physicalBundleId,
          FSUSBLOG_DOTNET_BUILD_PARALLELISM: 'auto',
          FSUSBLOG_BACKEND_COVERAGE_LINE_THRESHOLD: '80.3998',
          FSUSBLOG_BACKEND_COVERAGE_BRANCH_THRESHOLD: '59.4028',
          FSUSBLOG_FRONTEND_COVERAGE_LINE_THRESHOLD: '27.78',
          FSUSBLOG_FRONTEND_COVERAGE_BRANCH_THRESHOLD: '23.48',
          FSUSBLOG_COVERAGE_LINE_THRESHOLD: '43.6405',
          FSUSBLOG_COVERAGE_BRANCH_THRESHOLD: '31.7961'
        })
        Object.assign(env, resourceEnvironmentForTier(tier, env))
        return env
      },
      onTierStart(tier) {
        const budgetLabel = Number.isFinite(Number(tier.budgetMs)) ? `${tier.budgetMs}ms` : 'observe-only'
        console.error(`[matrix:${profileId}] bundle=${tier.physicalBundleId} budget=${budgetLabel} command=${tier.command}`)
      }
    })

    let projectedTierIds = []
    const completedTierIds = new Set(result.checkpoint.completedTiers ?? [])
    if (result.status === 'success') {
      try {
        const expectedRevision = result.checkpoint.revision
        const buildProjectionEvidence = (lockedCheckpoint) => {
          const lockedCompletedTierIds = new Set(lockedCheckpoint.completedTiers ?? [])
          const projectionInput = projectLocalBundleSummaries(matrix, profileId, profile, runId, lockedCompletedTierIds)
          const summaryOnlyEvidence = writeSummaryOnlyEvidence(profileId, profile, runId, result.checkpoint.sourceState)
          const logicalTierProjection = buildLocalProfileProjection({
            profileId,
            profile,
            tiers: matrix.tiers,
            checkpoint: lockedCheckpoint,
            bundleSummaries: projectionInput.bundleSummaries,
            summaryOnlyEvidence
          })
          return { logicalTierProjection }
        }
        result.checkpoint = await attachCheckpointEvidence(
          result.checkpointPath,
          runId,
          buildProjectionEvidence,
          { root, expectedRevision }
        )
        projectedTierIds = result.checkpoint.logicalTierProjection.logicalTierIds
      } catch (error) {
        result.status = 'failure'
        result.failure = { tierId: profileId, exitCode: 1, reason: error.message }
      }
    }
    const ungeneratedTierIds = profile.bundles
      .filter((bundle) => !completedTierIds.has(`local-${profileId}-${bundle.id}`))
      .flatMap((bundle) => bundle.members)
    const summaryFile = path.join(root, `.tmp/local-${profileId}/summary.json`)
    fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
    const summary = {
      schema: 'fsusblog.local-production.run.v1',
      status: result.status,
      executionSource: 'fresh',
      schedulerRunId: runId,
      budgetMs: profile.budgetMs,
      durationMs: Math.max(0, Date.now() - wallClockStartedAtMs),
      physicalBundles: physicalTiers.map((tier) => ({
        id: tier.physicalBundleId,
        status: result.checkpoint.tiers?.[tier.id]?.status ?? 'not-run',
        durationMs: result.checkpoint.tiers?.[tier.id]?.durationMs ?? 0
      })),
      projectedTierIds,
      summaryOnlyTierIds: profile.summaryOnly ?? [],
      ungeneratedTierIds,
      failure: result.failure ?? null,
      failures: result.checkpoint.failures ?? (result.failure ? [result.failure] : []),
      generatedAt: new Date().toISOString()
    }
    const summaryDurationErrors = validateLocalProfileRunSummary(summary, profile)
    if (summaryDurationErrors.length > 0 && summary.status === 'success') {
      summary.status = 'failure'
      summary.failure = { tierId: profileId, exitCode: 124, reason: summaryDurationErrors.join('; ') }
      result.status = 'failure'
      result.failure = summary.failure
    }
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)

    console.error(`[matrix:${profileId}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)} summary=${relativeToRoot(summaryFile)}`)
  } finally {
    cleanupSensitiveFixtures(runNamespace, loadNamespaceEnv(runNamespace))
    const cleanup = cleanupLocalRuntime({ root, namespace: runNamespace })
    // Every managed bundle has settled before this finally block. Reclaim build
    // servers here so a cancelled compiler cannot steal CPU from the next fresh
    // run; doing this inside a bundle would race sibling dotnet processes.
    const buildServerShutdown = spawnSync('dotnet', ['build-server', 'shutdown'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5_000
    })
    const dotnetBuildServerPostflightPids = cleanupOrphanDotnetBuildServers({
      root,
      currentRunId: runId,
      currentNamespace: runNamespace,
      includeCurrentBinding: true,
      includeInactiveProductionRuns: false,
      isRunActive: schedulerRunIsActive,
      terminationGraceMs: Math.ceil(profile.budgetMs / 100)
    })
    const cleanupFile = path.join(root, `.tmp/local-${profileId}/runtime-cleanup.json`)
    fs.mkdirSync(path.dirname(cleanupFile), { recursive: true })
    fs.writeFileSync(cleanupFile, `${JSON.stringify({
      ...cleanup,
      dotnetBuildServer: {
        status: buildServerShutdown.status,
        signal: buildServerShutdown.signal,
        error: buildServerShutdown.error?.message ?? null,
        preflightOrphanPids: dotnetBuildServerPreflightPids,
        postflightOrphanPids: dotnetBuildServerPostflightPids
      },
      generatedAt: new Date().toISOString()
    }, null, 2)}\n`)
    console.error(`[matrix:${profileId}] runtime cleanup=${relativeToRoot(cleanupFile)} containers=${cleanup.removedContainers.length}`)
  }

  const completedAtMs = Date.now()
  const fullScriptDurationMs = Math.max(0, completedAtMs - wallClockStartedAtMs)
  const summaryFile = path.join(root, `.tmp/local-${profileId}/summary.json`)
  if (profile.enforceBudget !== false && fullScriptDurationMs > profile.budgetMs) {
    const wallClockFailure = {
      tierId: profileId,
      exitCode: 124,
      signal: null,
      reason: `full ./tools/test.sh ${profileId} wall-clock budget exceeded (${fullScriptDurationMs}/${profile.budgetMs}ms)`,
      changedPaths: []
    }
    result.checkpoint = markCheckpointWallClockTimeout(
      result.checkpointPath,
      wallClockFailure,
      new Date(completedAtMs).toISOString())
    result.status = 'failure'
    result.failure ??= wallClockFailure
  }
  if (fs.existsSync(summaryFile)) {
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
    summary.durationMs = fullScriptDurationMs
    summary.status = result.status
    summary.failure = result.failure ?? null
    summary.failures = result.checkpoint.failures ?? (result.failure ? [result.failure] : [])
    summary.generatedAt = new Date(completedAtMs).toISOString()
    fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  }

  if (result.status !== 'success') {
    const failures = result.checkpoint.failures?.length > 0
      ? result.checkpoint.failures
      : [result.failure ?? { tierId: profileId, reason: 'local profile failed' }]
    console.error(`[matrix:${profileId}] ${failures.length} independent failure(s) collected`)
    for (const failure of failures) {
      console.error(`[matrix:${failure.tierId ?? profileId}] ${failure.reason ?? 'local profile failed'}`)
    }
    process.exit(Number(result.failure?.exitCode) || 1)
  }
}

function resetFreshJobSummaries(entries) {
  for (const [tier, details] of entries) {
    const jobId = summaryJobIdForTier(tier, details)
    const existing = readExistingJobSummary(jobId)
    if (ciSummaryAuthorityId && existing?.schedulerRunId === ciSummaryAuthorityId) continue
    fs.rmSync(jobSummaryPath(jobId), { force: true })
  }
}

function emitTierReproductionHint(tier, options) {
  console.error(`[matrix:${tier.id}] To reproduce tier locally: ${tierReproductionCommand(tier, options)}`)
  console.error(`[matrix:${tier.id}] To reproduce CI job locally: ${ciJobReproductionCommand(tier.ciJob)}`)
}

async function runTier(matrix, tierId, args) {
  const options = parseRunOptions(args)
  if (shouldUseLocalProfile(matrix, tierId, options)) {
    await runLocalProfile(matrix, normalizeTierId(tierId), options)
    return
  }
  const declaredTiers = options.noDeps ? [tierMap(matrix).get(normalizeTierId(tierId))] : planTier(matrix, tierId)
  if (declaredTiers.some((tier) => !tier)) throw new Error(`unknown tier: ${tierId}`)
  const systemResources = logicalTierSystemResources()
  const all = resolveLogicalTierResources(declaredTiers, systemResources)

  if (options.shard) {
    const target = all[all.length - 1]
    if (!target.shardable) throw new Error(`${target.id} is not shardable`)
    if (!/^\d+\/\d+$/.test(options.shard)) throw new Error('--shard must use i/n format')
  }

  if (options.planOnly) {
    printPlan(all)
    return
  }

  const target = all[all.length - 1]
  const targetTierId = normalizeTierId(tierId)
  const { runsRoot, runId } = schedulerRunIdentity(targetTierId, options)
  const runNamespace = namespaceFor(target, options.shard, runId)
  prepareNamespaceEnvironmentIfNeeded(all, runNamespace)
  if (options.fresh) resetFreshJobSummaries(all.map((tier) => [tier, {}]))
  const result = await runDag({
    tiers: all,
    root,
    runsRoot,
    runId,
    targetTierId,
    mode: options.resume ? 'resume' : 'fresh',
    resume: options.resume,
    supersedesUniverse: matrix.tiers,
    coverageRegistry: loadCoverageRegistry().entries,
    maxParallel: Math.min(options.maxParallel ?? systemResources.availableCpuUnits, systemResources.availableCpuUnits),
    systemResources,
    teeOutput: true,
    envForTier(tier) {
      const namespaceEnv = loadNamespaceEnv(runNamespace)
      const env = applyNamespaceBuildEnvironment(tier, {
        ...namespaceEnv,
        CURRENT_TIER: tier.id,
        MATRIX_JOB: tier.ciJob,
        FSUSBLOG_TEST_NAMESPACE: runNamespace,
        FSUSBLOG_TEST_RUN_ID: runId
      })
      Object.assign(env, resourceEnvironmentForTier(tier, env))
      applyUxViewportResumeEnvironment(env, tier, options.resume)
      if (options.shard) {
        const [index, total] = options.shard.split('/')
        env.MATRIX_SHARD = options.shard
        env.FSUSBLOG_TEST_SHARD_INDEX = index
        env.FSUSBLOG_TEST_SHARD_TOTAL = total
        if (tier.requiresPlaywright !== 'none') env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`
      }
      return env
    },
    onTierStart(tier) {
      emitTierReproductionHint(tier, options)
      console.error(`[matrix:${tier.id}] ${tier.command}`)
    },
    onTierReused(tier) {
      console.error(`[matrix:${tier.id}] reused successful checkpoint from ${runId}`)
    },
    onTierComplete(tier, tierResult) {
      const startedAt = Date.now() - tierResult.durationMs
      if (tierResult.status === 'success') {
        writeJobSummary(matrix, tier, 'success', startedAt, { schedulerRunId: runId })
      } else {
        writeJobSummary(matrix, tier, 'failure', startedAt, {
          schedulerRunId: runId,
          failureStage: stageForTier(tier),
          rootCause: tierResult.reason
        })
      }
    }
  })

  console.error(`[matrix:${target.id}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`)
  if (options.fresh && new Set(['production', 'release-final']).has(targetTierId)) {
    cleanupSensitiveFixtures(runNamespace, loadNamespaceEnv(runNamespace))
    console.error(`[matrix:${target.id}] removed namespaced auth fixture cache`)
  }
  if (result.status !== 'success') {
    const exitCode = Number(result.failure?.exitCode) || 1
    console.error(`[matrix:${result.failure?.tierId ?? target.id}] ${result.failure?.reason ?? 'scheduler failed'}`)
    process.exit(exitCode)
  }
}

function parseCiJobOptions(args) {
  const options = { planOnly: false, shard: null, resume: false, fresh: false, maxParallel: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else if (arg === '--resume') options.resume = true
    else if (arg === '--fresh') options.fresh = true
    else if (arg === '--max-parallel') options.maxParallel = Number(args[++index])
    else if (arg.startsWith('--max-parallel=')) options.maxParallel = Number(arg.slice('--max-parallel='.length))
    else throw new Error(`unknown ci-job option: ${arg}`)
  }
  normalizeSchedulerOptions(options)
  return options
}

function parseCiJobMatrixOptions(args) {
  const options = { outFile: null, githubOutputFile: null, prPlanFile: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out') options.outFile = args[++index]
    else if (arg.startsWith('--out=')) options.outFile = arg.slice('--out='.length)
    else if (arg === '--github-output') options.githubOutputFile = args[++index]
    else if (arg.startsWith('--github-output=')) options.githubOutputFile = arg.slice('--github-output='.length)
    else if (arg === '--pr-plan') options.prPlanFile = args[++index]
    else if (arg.startsWith('--pr-plan=')) options.prPlanFile = arg.slice('--pr-plan='.length)
    else throw new Error(`unknown ci-job-matrix option: ${arg}`)
  }
  return options
}

function ciJobTiers(matrix, jobId) {
  return matrix.tiers.filter((tier) => tier.ciJob === jobId && tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true)
}

function effectiveCiJobTiers(matrix, jobId) {
  return applySupersedes(ciJobTiers(matrix, jobId))
}

function ciJobExecutionMode(matrix, jobId) {
  const tiers = ciJobTiers(matrix, jobId)
  if (
    jobId === 'fast-summary'
    &&
    tiers.length > 0
    && tiers.every((tier) => String(tier.command).startsWith('tools/test/lanes/noop.sh '))
    && tiers.some((tier) => (tier.dependsOn?.length ?? 0) > 0)
  ) {
    return 'aggregate'
  }
  return 'test'
}

function hasIntersection(left, right) {
  const rightSet = new Set(right ?? [])
  return (left ?? []).some((item) => rightSet.has(item))
}

function ciJobMaxParallel(tiers) {
  return Math.max(1, ...tiers.map((tier) => Number(tier.maxParallel) || 1))
}

function internalCiJobDependencies(tier, tierIds) {
  return (tier.dependsOn ?? []).filter((dependencyId) => tierIds.has(dependencyId))
}

function activeResourceClassCount(active, resourceClass) {
  return active.filter((entry) => entry.tier.resourceClass === resourceClass).length
}

function canRunTogether(candidate, activeTier, active) {
  if (candidate.parallelizable !== true || activeTier.parallelizable !== true) return false
  if (hasIntersection(candidate.exclusiveResources, activeTier.exclusiveResources)) return false
  if ((candidate.services?.length ?? 0) > 0 && (activeTier.services?.length ?? 0) > 0 && hasIntersection(candidate.services, activeTier.services)) return false
  if (candidate.resourceClass === activeTier.resourceClass) {
    const sameClassActive = activeResourceClassCount(active, candidate.resourceClass)
    if (sameClassActive >= Number(candidate.maxParallel || 1)) return false
    if (sameClassActive >= Number(activeTier.maxParallel || 1)) return false
  }
  return true
}

function canStartCiJobTier(candidate, activeEntries, jobMaxParallel) {
  if (activeEntries.length >= jobMaxParallel) return false
  return activeEntries.every((entry) => canRunTogether(candidate, entry.tier, activeEntries))
}

function ciJobHasParallelWave(tiers) {
  const pending = [...tiers]
  const completed = new Set()
  const tierIds = new Set(tiers.map((tier) => tier.id))
  let sawParallelWave = false

  while (pending.length > 0) {
    const active = []
    for (const tier of [...pending]) {
      const dependenciesDone = internalCiJobDependencies(tier, tierIds).every((dependencyId) => completed.has(dependencyId))
      if (dependenciesDone && canStartCiJobTier(tier, active, ciJobMaxParallel(tiers))) {
        active.push({ tier })
      }
    }
    if (active.length === 0) return sawParallelWave
    if (active.length > 1) sawParallelWave = true
    for (const { tier } of active) {
      const index = pending.findIndex((item) => item.id === tier.id)
      if (index >= 0) pending.splice(index, 1)
      completed.add(tier.id)
    }
  }

  return sawParallelWave
}

function ciJobSchedulerMode(tiers) {
  return ciJobHasParallelWave(tiers) ? 'parallel' : 'serial'
}

function loadSelectedTierIds(prPlanFile) {
  if (!prPlanFile) return null
  const abs = path.resolve(root, prPlanFile)
  if (!fs.existsSync(abs)) throw new Error(`PR smart gate plan does not exist: ${relativeToRoot(abs)}`)
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'))
  return new Set(plan.selectedTierIds ?? plan.selectedTiers?.map((tier) => tier.id) ?? [])
}

function buildCiJobMatrix(matrix, jobId, selectedTierIds = null, allowEmpty = false) {
  const declaredTiers = applySupersedes(ciJobTiers(matrix, jobId)
    .filter((tier) => selectedTierIds === null || selectedTierIds.has(tier.id)))
  const systemResources = logicalTierSystemResources()
  const tiers = resolveLogicalTierResources(declaredTiers, systemResources)
  if (tiers.length === 0) {
    if (allowEmpty) return { resource_resolution: systemResources, include: [] }
    throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  }

  const include = []
  for (const tier of tiers) {
    const totalShards = tier.shardable ? Number(tier.defaultShards) || 1 : 1
    if (totalShards > 1) {
      for (let index = 1; index <= totalShards; index += 1) {
        const shard = `${index}/${totalShards}`
        const shardLabel = shardId(index, totalShards)
        include.push({
          tier: tier.id,
          ci_job: tier.ciJob,
          shard,
          shard_id: shardLabel,
          resource_class: tier.resourceClass,
          max_parallel: tier.maxParallel,
          cpu_units: tier.cpuUnits,
          memory_gib: tier.memoryGiB,
          cpu_weight: tier.cpuWeight,
          memory_weight: tier.memoryWeight,
          min_cpu_units: tier.minCpuUnits,
          playwright_workers: playwrightWorkersForTier(tier) ?? 1,
          timeout_minutes: tier.timeoutMinutes,
          artifact_name: `${jobId}-${shardLabel}`
        })
      }
      continue
    }

    include.push({
      tier: tier.id,
      ci_job: tier.ciJob,
      shard: '',
      shard_id: tier.id,
      resource_class: tier.resourceClass,
      max_parallel: tier.maxParallel,
      cpu_units: tier.cpuUnits,
      memory_gib: tier.memoryGiB,
      cpu_weight: tier.cpuWeight,
      memory_weight: tier.memoryWeight,
      min_cpu_units: tier.minCpuUnits,
      playwright_workers: playwrightWorkersForTier(tier) ?? 1,
      timeout_minutes: tier.timeoutMinutes,
      artifact_name: `${jobId}-${tier.id}`
    })
  }

  return {
    resource_resolution: {
      ...systemResources,
      defaultShards: dynamicShardCount(systemResources)
    },
    include
  }
}

function ciJobMatrix(matrix, jobId, args) {
  const options = parseCiJobMatrixOptions(args)
  const payload = buildCiJobMatrix(matrix, jobId, loadSelectedTierIds(options.prPlanFile))
  const maxParallel = Math.max(...payload.include.map((entry) => Number(entry.max_parallel || 1)))

  if (options.githubOutputFile) {
    const abs = path.resolve(root, options.githubOutputFile)
    ensureOutputDirectory(abs)
    fs.appendFileSync(abs, `matrix=${JSON.stringify(payload)}\n`)
    fs.appendFileSync(abs, `max_parallel=${maxParallel}\n`)
    console.log(`[matrix:ci-job-matrix] wrote ${relativeToRoot(abs)} for ${jobId}`)
    return
  }

  const text = `${JSON.stringify({
    job: jobId,
    max_parallel: maxParallel,
    matrix: payload
  }, null, 2)}\n`
  writeTextOutput(text, options.outFile, 'matrix:ci-job-matrix')
}

function printCiJobPlan(matrix, jobId) {
  const declaredTiers = ciJobTiers(matrix, jobId)
  const tiers = resolveLogicalTierResources(applySupersedes(declaredTiers))
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  console.log(`To reproduce GitHub Actions job "${jobId}" locally:`)
  console.log(`  ${ciJobReproductionCommand(jobId, matrix)}`)
  console.log(`  execution mode: ${ciJobExecutionMode(matrix, jobId)}`)
  console.log(`  scheduler: ${ciJobSchedulerMode(tiers)} (max ${ciJobMaxParallel(tiers)}, debug fallback: FSUSBLOG_CI_JOB_SERIAL=1)`)
  const effectiveIds = new Set(tiers.map((tier) => tier.id))
  for (const tier of declaredTiers.filter((tier) => !effectiveIds.has(tier.id))) {
    const replacement = declaredTiers.find((candidate) => (candidate.supersedes ?? []).includes(tier.id))
    console.log(`  superseded: ${tier.id} -> ${replacement?.id ?? 'replacement tier'}`)
  }
  console.log('')
  for (const tier of tiers) {
    const shard = tier.shardable ? ` --shard 1/${tier.defaultShards}` : ''
    console.log(`- ${tier.id}: ${tierReproductionCommand(tier, { noDeps: true })}${shard}`)
    console.log(`  matrix command: ${tier.command}`)
  }
}

async function runCiJobScheduled(matrix, jobId, tiers, options) {
  const targetTierId = `ci-job/${jobId}`
  const { runsRoot, runId } = schedulerRunIdentity(targetTierId, options)
  const schedulerMode = options.forceSerial ? 'serial' : 'parallel'
  const dynamicMaximum = Math.min(ciJobMaxParallel(tiers), options.systemResources.availableCpuUnits)
  const maxParallel = options.forceSerial ? 1 : Math.min(options.maxParallel ?? dynamicMaximum, dynamicMaximum)
  console.error(`[matrix:ci-job:${jobId}] scheduler=${schedulerMode} max=${maxParallel}`)
  const bootstrapTier = tiers.find((tier) => tier.selfBootstraps === true)
  if (bootstrapTier) prepareNamespaceEnvironmentIfNeeded(tiers, namespaceFor(bootstrapTier, options.shard, runId))
  if (options.fresh) {
    resetFreshJobSummaries(tiers.map((tier) => [tier, {
      jobId: options.forceSerial ? jobId : `${jobId}-${tier.id}`
    }]))
  }

  const result = await runDag({
    tiers,
    root,
    runsRoot,
    runId,
    targetTierId,
    mode: options.resume ? 'resume' : 'fresh',
    resume: options.resume,
    supersedesUniverse: matrix.tiers,
    coverageRegistry: loadCoverageRegistry().entries,
    maxParallel,
    systemResources: options.systemResources,
    teeOutput: true,
    envForTier(tier) {
      const runNamespace = namespaceFor(tier, options.shard, runId)
      const env = applyNamespaceBuildEnvironment(tier, {
        ...loadNamespaceEnv(runNamespace),
        CURRENT_TIER: tier.id,
        MATRIX_JOB: tier.ciJob,
        FSUSBLOG_TEST_NAMESPACE: runNamespace,
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_CI_JOB_ID: options.forceSerial ? jobId : `${jobId}-${tier.id}`,
        FSUSBLOG_CI_JOB_SCHEDULER: schedulerMode
      })
      Object.assign(env, resourceEnvironmentForTier(tier, env))
      applyUxViewportResumeEnvironment(env, tier, options.resume)
      if (options.shard && tier.shardable) {
        const [index, total] = options.shard.split('/')
        env.MATRIX_SHARD = options.shard
        env.FSUSBLOG_TEST_SHARD_INDEX = index
        env.FSUSBLOG_TEST_SHARD_TOTAL = total
        if (tier.requiresPlaywright !== 'none') env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`
      }
      return env
    },
    onTierStart(tier) {
      emitTierReproductionHint(tier, { noDeps: true, shard: options.shard })
      console.error(`[matrix:ci-job:${jobId}] started ${tier.id}: ${tier.command}`)
    },
    onTierReused(tier) {
      console.error(`[matrix:ci-job:${jobId}] reused ${tier.id} from ${runId}`)
    },
    onTierComplete(tier, tierResult) {
      const startedAt = Date.now() - tierResult.durationMs
      const success = tierResult.status === 'success'
      writeJobSummary(matrix, tier, success ? 'success' : 'failure', startedAt, {
        jobId: options.forceSerial ? jobId : `${jobId}-${tier.id}`,
        schedulerRunId: runId,
        failureStage: success ? null : stageForTier(tier),
        rootCause: success ? null : tierResult.reason
      })
      console.error(`[matrix:ci-job:${jobId}] ${tier.id} ${tierResult.status}`)
    }
  })
  console.error(`[matrix:ci-job:${jobId}] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`)
  return result.status === 'success' ? 0 : (Number(result.failure?.exitCode) || 1)
}

async function runCiJob(matrix, jobId, args) {
  const options = parseCiJobOptions(args)
  const declaredTiers = effectiveCiJobTiers(matrix, jobId)
  if (declaredTiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  if (options.shard && !/^\d+\/\d+$/.test(options.shard)) throw new Error('--shard must use i/n format')
  if (options.planOnly) {
    printCiJobPlan(matrix, jobId)
    return
  }

  options.systemResources = logicalTierSystemResources()
  const tiers = resolveLogicalTierResources(declaredTiers, options.systemResources)
  options.forceSerial = process.env.FSUSBLOG_CI_JOB_SERIAL === '1' || ciJobSchedulerMode(tiers) === 'serial'
  if (process.env.FSUSBLOG_CI_JOB_SERIAL === '1') console.error(`[matrix:ci-job:${jobId}] scheduler=serial forced by FSUSBLOG_CI_JOB_SERIAL=1`)
  const status = await runCiJobScheduled(matrix, jobId, tiers, options)
  if (status !== 0) process.exit(status)
}

function parseAggregateOptions(args) {
  const options = { dryRun: false, outFile: null, githubNeedsJson: process.env.QUALITY_GATE_NEEDS_JSON ?? null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--out') options.outFile = args[++index]
    else if (arg.startsWith('--out=')) options.outFile = arg.slice('--out='.length)
    else if (arg === '--github-needs') options.githubNeedsJson = args[++index]
    else if (arg.startsWith('--github-needs=')) options.githubNeedsJson = arg.slice('--github-needs='.length)
    else throw new Error(`unknown aggregate option: ${arg}`)
  }
  return options
}

function generatedMatrixSummaryIds(matrix, jobId) {
  const tiers = resolveLogicalTierResources(effectiveCiJobTiers(matrix, jobId))
  const shardSummaryIds = []
  const unshardedTierSummaryIds = []
  for (const tier of tiers) {
    const totalShards = tier.shardable ? Number(tier.defaultShards) || 1 : 1
    if (totalShards <= 1) {
      unshardedTierSummaryIds.push(`${jobId}-${tier.id}`)
      continue
    }
    for (let index = 1; index <= totalShards; index += 1) {
      shardSummaryIds.push(`${jobId}-${shardId(index, totalShards)}`)
    }
  }
  if (new Set(['fast-backend', 'fast-frontend-unit']).has(jobId)) {
    return ciJobSchedulerMode(tiers) === 'parallel'
      ? [...shardSummaryIds, ...unshardedTierSummaryIds]
      : [jobId]
  }
  if (shardSummaryIds.length > 0) return shardSummaryIds
  return [jobId]
}

function aggregateDependencyJobs(matrix, summaryTiers, jobId) {
  const byId = tierMap(matrix)
  const jobs = new Set()
  for (const tier of summaryTiers) {
    for (const dependencyId of tier.dependsOn ?? []) {
      const dependency = byId.get(dependencyId)
      if (!dependency) throw new Error(`${tier.id} depends on missing tier ${dependencyId}`)
      if (dependency.ciJob === jobId) continue
      jobs.add(dependency.ciJob)
    }
  }
  return [...jobs].sort()
}

function aggregateRequiredPaths(matrix, dependencyJobs, summaryTiers) {
  const paths = new Set()
  const addTierPaths = (tier) => {
    for (const artifact of tier.artifacts ?? []) paths.add(artifact)
    for (const evidence of tier.evidence ?? []) paths.add(evidence)
  }
  for (const tier of summaryTiers) addTierPaths(tier)
  for (const jobId of dependencyJobs) {
    for (const tier of effectiveCiJobTiers(matrix, jobId)) addTierPaths(tier)
  }
  return [...paths].filter(requiresAggregateArtifact).sort()
}

function requiresAggregateArtifact(value) {
  const normalized = String(value ?? '').trim().replace(/^['"]|['"]$/g, '')
  return normalized.startsWith('.tmp/')
    || normalized.startsWith('src/frontend/coverage')
    || normalized.startsWith('src/frontend/test-results/')
    || normalized.startsWith('src/frontend/playwright-report')
    || normalized.startsWith('BenchmarkDotNet.Artifacts/')
}

function buildAggregatePlan(matrix, jobId) {
  const summaryTiers = ciJobTiers(matrix, jobId)
  if (summaryTiers.length === 0) throw new Error(`unknown aggregate CI job: ${jobId}`)
  if (ciJobExecutionMode(matrix, jobId) !== 'aggregate') throw new Error(`${jobId} is not an artifact-only aggregate job`)

  const dependencyJobs = aggregateDependencyJobs(matrix, summaryTiers, jobId)
  return {
    schema: 'fsusblog.ci.aggregate-plan.v1',
    jobId,
    tierIds: summaryTiers.map((tier) => tier.id),
    artifactOnly: true,
    executesTestCommands: false,
    dependencyJobs,
    requiredJobSummaries: dependencyJobs.flatMap((dependencyJob) => generatedMatrixSummaryIds(matrix, dependencyJob)).sort(),
    requiredArtifactPaths: aggregateRequiredPaths(matrix, dependencyJobs, summaryTiers),
    localReproduction: `node tools/run-test-matrix.mjs aggregate ${jobId}`
  }
}

function findFiles(dir, predicate, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) findFiles(file, predicate, results)
    else if (predicate(file)) results.push(file)
  }
  return results
}

function loadJobSummaries() {
  const summaries = new Map()
  const roots = [
    path.join(root, '.tmp/release-evidence/jobs'),
    path.join(root, '.tmp/downloaded-artifacts')
  ]
  for (const searchRoot of roots) {
    for (const file of findFiles(searchRoot, (candidate) => candidate.endsWith('.json') && candidate.includes(`${path.sep}jobs${path.sep}`))) {
      try {
        const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (summary.schema !== 'fsusblog.ci.job-result.v1') continue
        summaries.set(summary.jobId, { summary, file })
        if (summary.ciJob && !summaries.has(summary.ciJob)) summaries.set(summary.ciJob, { summary, file })
      } catch {
        // Ignore unrelated JSON artifacts.
      }
    }
  }
  return summaries
}

function aggregatePathExists(rel) {
  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  return aggregateArtifactPathExists({ root, downloadedRoot, declaration: rel })
}

function githubNeedsErrors(rawNeedsJson, dependencyJobs) {
  if (!rawNeedsJson) return []
  let needs = null
  try {
    needs = JSON.parse(rawNeedsJson)
  } catch (error) {
    return [`QUALITY_GATE_NEEDS_JSON is not valid JSON: ${error.message}`]
  }

  const errors = []
  for (const jobId of dependencyJobs) {
    const result = needs?.[jobId]?.result
    if (result && result !== 'success') errors.push(`${jobId} completed with result=${result}`)
  }
  return errors
}

function aggregateCiJob(matrix, jobId, args) {
  const options = parseAggregateOptions(args)
  const plan = buildAggregatePlan(matrix, jobId)

  if (options.dryRun) {
    writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, options.outFile, 'matrix:aggregate')
    return
  }

  const startedAt = Date.now()
  const summaryTier = ciJobTiers(matrix, jobId)[0]
  const errors = githubNeedsErrors(options.githubNeedsJson, plan.dependencyJobs)
  const summaries = loadJobSummaries()

  console.log(`[matrix:aggregate] ${jobId} is artifact-only; no test commands will be executed`)
  console.log(`[matrix:aggregate] dependency jobs: ${plan.dependencyJobs.join(', ')}`)
  console.log(`[matrix:aggregate] required job summaries: ${plan.requiredJobSummaries.join(', ')}`)

  for (const summaryId of plan.requiredJobSummaries) {
    const match = summaries.get(summaryId)
    if (!match) {
      errors.push(`missing job summary artifact: ${summaryId}`)
      continue
    }
    if (match.summary.status !== 'success') {
      errors.push(`${summaryId} status=${match.summary.status}`)
    }
  }

  for (const requiredPath of plan.requiredArtifactPaths) {
    if (!aggregatePathExists(requiredPath)) errors.push(`missing aggregate artifact path: ${requiredPath}`)
  }

  if (errors.length > 0) {
    writeJobSummary(matrix, summaryTier, 'failure', startedAt, {
      stage: 'summary',
      failureStage: 'summary',
      rootCause: errors[0],
      localReproduction: plan.localReproduction
    })
    for (const error of errors) console.error(`[matrix:aggregate] ${error}`)
    process.exit(1)
  }

  writeJobSummary(matrix, summaryTier, 'success', startedAt, {
    stage: 'summary',
    localReproduction: plan.localReproduction
  })
  console.log(`[matrix:aggregate] ok (${plan.requiredJobSummaries.length} job summaries, ${plan.requiredArtifactPaths.length} artifact paths)`)
}

function listTiers(matrix) {
  for (const tier of matrix.tiers) {
    const tags = [
      `job=${tier.ciJob}`,
      `risk=${tier.risk}`,
      `cadence=${tier.cadence}`,
      `requiredFor=${tier.requiredFor}`,
      tier.parallelizable ? 'parallel:machine' : 'serial',
      tier.shardable ? 'shardable:machine' : 'single'
    ]
    console.log(`${tier.id}\t${tags.join(' ')}`)
  }
}

function ensureOutputDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function writeTextOutput(text, outFile, label) {
  if (!outFile) {
    process.stdout.write(text)
    return
  }

  const abs = path.resolve(root, outFile)
  ensureOutputDirectory(abs)
  fs.writeFileSync(abs, text)
  console.log(`[${label}] wrote ${relativeToRoot(abs)}`)
}

function buildCiPlan(matrix, format) {
  const combineCacheProfile = (left, right) => {
    const frontend = left === 'frontend' || left === 'full' || right === 'frontend' || right === 'full'
    const backend = left === 'backend' || left === 'full' || right === 'backend' || right === 'full'
    return frontend && backend ? 'full' : frontend ? 'frontend' : backend ? 'backend' : 'none'
  }
  const resolvedById = new Map()
  const declaredByJob = new Map()
  for (const tier of matrix.tiers) declaredByJob.set(tier.ciJob, [...(declaredByJob.get(tier.ciJob) ?? []), tier])
  for (const tiers of declaredByJob.values()) {
    for (const tier of resolveLogicalTierResources(tiers)) resolvedById.set(tier.id, tier)
  }
  const jobs = new Map()
  for (const declaredTier of matrix.tiers) {
    const tier = resolvedById.get(declaredTier.id)
    const job = jobs.get(tier.ciJob) ?? {
      id: tier.ciJob,
      tiers: [],
      timeoutMinutes: 0,
      needs: new Set(),
      artifacts: new Set(),
      evidence: new Set(),
      requiresNode: false,
      requiresDotnet: false,
      requiresPlaywright: 'none',
      playwrightWorkerValues: new Set(),
      cacheProfile: 'none'
    }
    job.tiers.push(tier.id)
    job.timeoutMinutes = Math.max(job.timeoutMinutes, tier.timeoutMinutes)
    job.phase = Math.max(job.phase ?? 0, tier.phase)
    job.maxParallel = Math.max(job.maxParallel ?? 1, tier.maxParallel)
    job.requiresNode = job.requiresNode || tier.requiresNode
    job.requiresDotnet = job.requiresDotnet || tier.requiresDotnet
    if (tier.requiresPlaywright === 'all') job.requiresPlaywright = 'all'
    else if (tier.requiresPlaywright === 'chromium' && job.requiresPlaywright === 'none') job.requiresPlaywright = 'chromium'
    const playwrightWorkers = playwrightWorkersForTier(tier)
    if (playwrightWorkers !== null) job.playwrightWorkerValues.add(playwrightWorkers)
    job.cacheProfile = combineCacheProfile(job.cacheProfile, tier.cacheProfile)
    for (const artifact of tier.artifacts) job.artifacts.add(artifact)
    for (const evidence of tier.evidence) job.evidence.add(evidence)
    jobs.set(tier.ciJob, job)
  }
  const byId = tierMap(matrix)
  for (const tier of matrix.tiers) {
    const job = jobs.get(tier.ciJob)
    for (const dep of tier.dependsOn) {
      const depJob = byId.get(dep)?.ciJob
      if (depJob && depJob !== tier.ciJob) job.needs.add(depJob)
    }
  }
  return {
    format,
    generatedAt: new Date().toISOString(),
    jobs: [...jobs.values()].map((job) => ({
      id: job.id,
      tiers: job.tiers,
      timeoutMinutes: job.timeoutMinutes,
      phase: job.phase ?? 0,
      maxParallel: job.maxParallel ?? 1,
      requiresNode: job.requiresNode,
      requiresDotnet: job.requiresDotnet,
      requiresPlaywright: job.requiresPlaywright,
      playwrightWorkers: [...job.playwrightWorkerValues].sort((left, right) => left - right),
      cacheProfile: job.cacheProfile,
      needs: [...job.needs].sort(),
      artifacts: [...job.artifacts].sort(),
      evidence: [...job.evidence].sort()
    })).sort((a, b) => a.id.localeCompare(b.id))
  }
}

function parsePrSmartGateOptions(args) {
  const options = {
    outFile: null,
    githubOutputFile: null,
    changedFilesFile: null,
    baseRef: process.env.FSUSBLOG_BASE_REF ?? process.env.GITHUB_BASE_REF ?? 'origin/master',
    eventName: process.env.GITHUB_EVENT_NAME ?? 'local',
    full: process.env.FSUSBLOG_SMART_GATE_FULL === '1'
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out') options.outFile = args[++index]
    else if (arg.startsWith('--out=')) options.outFile = arg.slice('--out='.length)
    else if (arg === '--github-output') options.githubOutputFile = args[++index]
    else if (arg.startsWith('--github-output=')) options.githubOutputFile = arg.slice('--github-output='.length)
    else if (arg === '--changed-files') options.changedFilesFile = args[++index]
    else if (arg.startsWith('--changed-files=')) options.changedFilesFile = arg.slice('--changed-files='.length)
    else if (arg === '--base-ref') options.baseRef = args[++index]
    else if (arg.startsWith('--base-ref=')) options.baseRef = arg.slice('--base-ref='.length)
    else if (arg === '--event-name') options.eventName = args[++index]
    else if (arg.startsWith('--event-name=')) options.eventName = arg.slice('--event-name='.length)
    else if (arg === '--full') options.full = true
    else if (arg === '--plan-only') options.planOnly = true
    else throw new Error(`unknown PR smart gate option: ${arg}`)
  }
  return options
}

function readChangedFiles(options) {
  if (options.changedFilesFile) {
    const abs = path.resolve(root, options.changedFilesFile)
    if (!fs.existsSync(abs)) throw new Error(`changed files input does not exist: ${relativeToRoot(abs)}`)
    return fs.readFileSync(abs, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
  }

  const baseRef = options.baseRef || 'origin/master'
  const diff = git(['diff', '--name-only', `${baseRef}...HEAD`])
    ?? git(['diff', '--name-only', `${baseRef}`])
    ?? git(['diff', '--name-only', 'HEAD~1..HEAD'])
    ?? ''
  return diff.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort()
}

function wildcardToRegExp(pattern) {
  const escaped = String(pattern)
    .replaceAll(path.sep, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'u')
}

function matchesPathPattern(file, pattern) {
  const normalizedFile = String(file).replaceAll(path.sep, '/')
  const normalizedPattern = String(pattern).replaceAll(path.sep, '/')
  if (normalizedPattern.includes('*')) return wildcardToRegExp(normalizedPattern).test(normalizedFile)
  if (normalizedPattern.endsWith('/')) return normalizedFile.startsWith(normalizedPattern)
  return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`)
}

function tierSmartGateMode(tier) {
  if (tier.smartGateMode) return tier.smartGateMode
  if (tier.prDefault === true || tier.requiredFor === 'fast') return 'always'
  if (
    tier.localOnly === true
    || tier.nightlyOnly === true
    || tier.manualOnly === true
    || tier.cadence === 'nightly'
    || tier.cadence === 'release-manual'
    || tier.requiredFor === 'production'
    || tier.requiredFor === 'release-final'
  ) {
    return 'full-only'
  }
  return 'conditional'
}

function tierTriggerMatches(tier, changedFiles) {
  const changed = changedFiles ?? []
  const triggerFiles = tier.triggerFiles ?? []
  const triggerPaths = tier.triggerPaths ?? []
  if (triggerFiles.length > 0 && changed.some((file) => triggerFiles.includes(file))) return true
  if (triggerPaths.length > 0 && changed.some((file) => triggerPaths.some((pattern) => matchesPathPattern(file, pattern)))) return true
  if ((tier.triggerCoverage?.length ?? 0) > 0 && changed.some((file) => matchesPathPattern(file, 'tests/coverage-registry.json') || matchesPathPattern(file, 'tests/matrix.yml'))) return true
  return false
}

function isFullSmartGateMode(options) {
  return options.full === true
    || options.eventName === 'push'
    || options.eventName === 'workflow_dispatch'
    || process.env.FSUSBLOG_RELEASE_FINAL === '1'
}

function retentionReport(matrix) {
  const byClass = new Map()
  for (const tier of matrix.tiers) {
    const retentionClass = tier.retentionClass ?? (
      tier.requiredFor === 'release-final' || tier.risk === 'critical' ? 'must-keep' : 'conditional'
    )
    const bucket = byClass.get(retentionClass) ?? []
    bucket.push(tier.id)
    byClass.set(retentionClass, bucket)
  }
  return {
    schema: 'fsusblog.test-retention-report.v1',
    classes: Object.fromEntries([...byClass.entries()].sort(([left], [right]) => left.localeCompare(right))),
    redundantCandidateCount: byClass.get('redundant-candidate')?.length ?? 0,
    obsoleteCount: byClass.get('obsolete')?.length ?? 0
  }
}

function buildPrSmartGatePlan(matrix, options) {
  const changedFiles = readChangedFiles(options)
  const fullMode = isFullSmartGateMode(options)
  const selectedTiers = []
  const skippedTiers = []

  for (const tier of matrix.tiers) {
    const mode = tierSmartGateMode(tier)
    let selected = false
    let reason = ''

    if (fullMode) {
      selected = true
      reason = 'full gate requested by push/workflow_dispatch/release-final'
    } else if (mode === 'full-only') {
      selected = false
      reason = tier.triggerReason || 'full-only lane skipped for ordinary PR'
    } else if (mode === 'always' || tier.prDefault === true) {
      selected = true
      reason = tier.triggerReason || 'PR default lane'
    } else if (tierTriggerMatches(tier, changedFiles)) {
      selected = true
      reason = tier.triggerReason || 'changed files matched trigger metadata'
    } else {
      selected = false
      reason = tier.triggerReason || 'changed files did not match trigger metadata'
    }

    const entry = {
      id: tier.id,
      ciJob: tier.ciJob,
      smartGateMode: mode,
      prDefault: tier.prDefault === true,
      retentionClass: tier.retentionClass ?? null,
      triggerReason: tier.triggerReason ?? null,
      reason
    }
    if (selected) selectedTiers.push(entry)
    else skippedTiers.push(entry)
  }

  const selectedTierIds = new Set(selectedTiers.map((tier) => tier.id))
  const selectedJobs = [...new Set(selectedTiers.map((tier) => tier.ciJob))].sort()
  const skippedJobs = [...new Set(skippedTiers.map((tier) => tier.ciJob).filter((job) => !selectedJobs.includes(job)))].sort()

  return {
    schema: 'fsusblog.pr-smart-gate.v1',
    generatedAt: new Date().toISOString(),
    fullMode,
    eventName: options.eventName,
    baseRef: options.baseRef,
    changedFiles,
    selectedTiers,
    skippedTiers,
    selectedTierIds: [...selectedTierIds].sort(),
    selectedJobs,
    skippedJobs,
    retentionReport: retentionReport(matrix)
  }
}

function normalizedOutputName(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_')
}

function writePrSmartGateOutputs(matrix, plan, githubOutputFile) {
  if (!githubOutputFile) return
  const abs = path.resolve(root, githubOutputFile)
  ensureOutputDirectory(abs)
  const selectedJobs = new Set(plan.selectedJobs)
  const selectedTierIds = new Set(plan.selectedTierIds)
  const lines = [
    `pr_smart_gate_summary=${relativeToRoot(prSmartGateSummaryFile)}`,
    `selected_jobs_json=${JSON.stringify(plan.selectedJobs)}`,
    `skipped_jobs_json=${JSON.stringify(plan.skippedJobs)}`
  ]
  const allJobs = new Set([...plan.selectedJobs, ...plan.skippedJobs])
  for (const job of [...allJobs].sort()) {
    lines.push(`${normalizedOutputName(job)}=${selectedJobs.has(job) ? 'true' : 'false'}`)
    const payload = buildCiJobMatrix(matrix, job, selectedTierIds, true)
    const maxParallel = payload.include.length === 0
      ? 1
      : Math.max(...payload.include.map((entry) => Number(entry.max_parallel || 1)))
    lines.push(`${normalizedOutputName(job)}_matrix=${JSON.stringify(payload)}`)
    lines.push(`${normalizedOutputName(job)}_max_parallel=${maxParallel}`)
  }
  fs.appendFileSync(abs, `${lines.join('\n')}\n`)
}

function ciPrPlan(matrix, args) {
  const options = parsePrSmartGateOptions(args)
  const plan = buildPrSmartGatePlan(matrix, options)
  const defaultOut = options.outFile ?? prSmartGateSummaryFile
  writeTextOutput(`${JSON.stringify(plan, null, 2)}\n`, defaultOut, 'matrix:ci-pr-plan')
  fs.mkdirSync(path.dirname(prSmartGateSummaryFile), { recursive: true })
  fs.writeFileSync(prSmartGateSummaryFile, `${JSON.stringify(plan, null, 2)}\n`)
  writePrSmartGateOutputs(matrix, plan, options.githubOutputFile)
}

async function ciPrSmart(matrix, args) {
  const options = parsePrSmartGateOptions(args)
  const plan = buildPrSmartGatePlan(matrix, options)
  if (options.planOnly === true) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  const byId = tierMap(matrix)
  const declaredTiers = plan.selectedTierIds.map((tierId) => byId.get(tierId)).filter(Boolean)
  if (declaredTiers.length === 0) return
  const systemResources = logicalTierSystemResources()
  const tiers = resolveLogicalTierResources(declaredTiers, systemResources)
  const targetTierId = 'ci-pr-smart'
  const schedulerOptions = { resume: false }
  const { runsRoot, runId } = schedulerRunIdentity(targetTierId, schedulerOptions)
  const runNamespace = namespaceFor({ ciJob: targetTierId, id: targetTierId }, null, runId)
  prepareNamespaceEnvironmentIfNeeded(tiers, runNamespace)
  resetFreshJobSummaries(tiers.map((tier) => [tier, {}]))
  const result = await runDag({
    tiers,
    root,
    runsRoot,
    runId,
    targetTierId,
    mode: 'fresh',
    resume: false,
    supersedesUniverse: matrix.tiers,
    coverageRegistry: loadCoverageRegistry().entries,
    maxParallel: systemResources.availableCpuUnits,
    systemResources,
    teeOutput: true,
    envForTier(tier) {
      const env = applyNamespaceBuildEnvironment(tier, {
        ...loadNamespaceEnv(runNamespace),
        CURRENT_TIER: tier.id,
        MATRIX_JOB: tier.ciJob,
        FSUSBLOG_TEST_NAMESPACE: runNamespace,
        FSUSBLOG_TEST_RUN_ID: runId,
        FSUSBLOG_CI_JOB_ID: tier.ciJob,
        FSUSBLOG_CI_JOB_SCHEDULER: 'dag'
      })
      Object.assign(env, resourceEnvironmentForTier(tier, env))
      applyUxViewportResumeEnvironment(env, tier, false)
      return env
    },
    onTierStart(tier) {
      emitTierReproductionHint(tier, { noDeps: true })
      console.error(`[matrix:ci-pr-smart] started ${tier.id}: ${tier.command}`)
    },
    onTierComplete(tier, tierResult) {
      const startedAt = Date.now() - tierResult.durationMs
      const success = tierResult.status === 'success'
      writeJobSummary(matrix, tier, success ? 'success' : 'failure', startedAt, {
        schedulerRunId: runId,
        failureStage: success ? null : stageForTier(tier),
        rootCause: success ? null : tierResult.reason
      })
      console.error(`[matrix:ci-pr-smart] ${tier.id} ${tierResult.status}`)
    }
  })
  console.error(`[matrix:ci-pr-smart] run=${result.runId} checkpoint=${relativeToRoot(result.checkpointPath)}`)
  if (result.status !== 'success') {
    process.exit(Number(result.failure?.exitCode) || 1)
  }
}

function ciPlan(matrix, format, outFile) {
  writeTextOutput(`${JSON.stringify(buildCiPlan(matrix, format), null, 2)}\n`, outFile, 'matrix:ci-plan')
}

function docs(matrix, outFile) {
  const lines = [
    '# Generated Test Matrix',
    '',
    '<!-- generated by tools/run-test-matrix.mjs docs; do not edit by hand -->',
    '',
    `Version: \`${matrix.version}\``,
    '',
    '| Tier | CI job | Local command | Phase | Risk | Cadence | Required for | Smart gate | PR default | Retention | Trigger reason | Resource weights | Cost | Parallelism | PW workers | Bootstrap | Node | .NET | Playwright | Cache | Depends on | Services | Sharding | Timeout | Artifacts | Evidence |',
    '|---|---|---|---:|---|---|---|---|---|---|---|---|---|---:|---:|---|---|---|---|---|---|---|---:|---:|---|---|'
  ]
  for (const tier of resolveLogicalTierResources(matrix.tiers)) {
    lines.push([
      `\`${tier.id}\``,
      `\`${tier.ciJob}\``,
      `\`./tools/test.sh ci-tier ${tier.id}\``,
      String(tier.phase),
      tier.risk,
      tier.cadence,
      tier.requiredFor,
      tierSmartGateMode(tier),
      tier.prDefault === true ? 'yes' : 'no',
      tier.retentionClass ?? '-',
      tier.triggerReason ?? '-',
      `${tier.resourceClass} cpu=${tier.cpuWeight} memory=${tier.memoryWeight} minCpu=${tier.minCpuUnits}`,
      tier.cost,
      tier.parallelizable ? 'machine' : 'serial',
      playwrightWorkersForTier(tier) === null ? '-' : String(playwrightWorkersForTier(tier)),
      tier.requiresBootstrap,
      tier.requiresNode ? 'yes' : 'no',
      tier.requiresDotnet ? 'yes' : 'no',
      tier.requiresPlaywright,
      tier.cacheProfile,
      tier.dependsOn.length > 0 ? tier.dependsOn.map((id) => `\`${id}\``).join(', ') : '-',
      tier.services.length > 0 ? tier.services.join(', ') : '-',
      tier.shardable ? 'machine' : 'single',
      `${tier.timeoutMinutes}m`,
      tier.artifacts.length > 0 ? tier.artifacts.map((item) => `\`${item}\``).join('<br>') : '-',
      tier.evidence.length > 0 ? tier.evidence.map((item) => `\`${item}\``).join('<br>') : '-'
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
  }
  const jobs = new Map()
  for (const tier of matrix.tiers.filter((item) => item.localOnly !== true && item.nightlyOnly !== true && item.manualOnly !== true)) {
    const job = jobs.get(tier.ciJob) ?? []
    job.push(tier.id)
    jobs.set(tier.ciJob, job)
  }
  lines.push('')
  lines.push('## CI Job Reproduction Commands')
  lines.push('')
  lines.push('| CI job | Execution | Local reproduction command | Matrix tiers |')
  lines.push('|---|---|---|---|')
  for (const [jobId, tiers] of [...jobs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| \`${jobId}\` | \`${ciJobExecutionMode(matrix, jobId)}\` | \`${ciJobReproductionCommand(jobId, matrix)}\` | ${tiers.map((id) => `\`${id}\``).join(', ')} |`)
  }
  lines.push('')
  const text = `${lines.join('\n').replace(/\n+$/u, '')}\n`
  writeTextOutput(text, outFile, 'matrix:docs')
}

function evidencePlan(matrix, outFile) {
  const resolvedTiers = resolveLogicalTierResources(matrix.tiers)
  const plan = {
    schema: 'fsusblog.release-evidence.test-plan.v1',
    generatedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE ?? null,
    tiers: resolvedTiers.map((tier) => ({
      id: tier.id,
      ciJob: tier.ciJob,
      command: tier.command,
      dependsOn: tier.dependsOn,
      timeoutMinutes: tier.timeoutMinutes,
      phase: tier.phase,
      cost: tier.cost,
      resourceClass: tier.resourceClass,
      cpuWeight: tier.cpuWeight,
      memoryWeight: tier.memoryWeight,
      minCpuUnits: tier.minCpuUnits,
      parallelism: tier.parallelizable ? 'machine' : 'serial',
      requiresBootstrap: tier.requiresBootstrap,
      requiresNode: tier.requiresNode,
      requiresDotnet: tier.requiresDotnet,
      requiresPlaywright: tier.requiresPlaywright,
      playwrightWorkers: playwrightWorkersForTier(tier),
      cacheProfile: tier.cacheProfile,
      shardable: tier.shardable,
      sharding: tier.shardable ? 'machine' : 'single',
      artifacts: tier.artifacts,
      evidence: tier.evidence,
      risk: tier.risk,
      cadence: tier.cadence,
      requiredFor: tier.requiredFor,
      localOnly: tier.localOnly,
      nightlyOnly: tier.nightlyOnly,
      manualOnly: tier.manualOnly === true
    }))
  }
  const abs = path.resolve(root, outFile ?? '.tmp/release-evidence/test-plan.json')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(plan, null, 2)}\n`)
  console.log(`[matrix:evidence] wrote ${path.relative(root, abs)}`)
}

function preflight(matrix) {
  const checkedDirectories = [
    '.tmp',
    '.tmp/release-evidence',
    '.tmp/gate-logs',
    '.tmp/env',
    '.tmp/docs'
  ]
  const checkedFiles = [
    'tests/matrix.yml',
    'tests/matrix.schema.json',
    'tests/coverage-registry.json',
    '.github/workflows/quality-gate.yml',
    'tools/run-test-matrix.mjs',
    'tools/check-workflow-matrix-sync.mjs',
    'tools/test.sh',
    'tools/ci/check-flaky-registry.mjs',
    'tools/ci/check-flaky-evidence.mjs',
    'tools/ci/run-flaky-governed.mjs',
    'tests/flaky.yml'
  ]
  const errors = []

  for (const rel of checkedDirectories) {
    const abs = path.join(root, rel)
    try {
      fs.mkdirSync(abs, { recursive: true })
      fs.accessSync(abs, fs.constants.W_OK)
    } catch (error) {
      errors.push(`${rel} is not writable: ${error.message}`)
    }
  }

  for (const rel of checkedFiles) {
    if (!fs.existsSync(path.join(root, rel))) {
      errors.push(`missing required file: ${rel}`)
    }
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
    errors.push(`Node.js 20 or newer is required, got ${process.versions.node}`)
  }

  const gitRoot = git(['rev-parse', '--show-toplevel'])
  if (!gitRoot) {
    errors.push('git metadata is unavailable; run from a checked-out repository')
  } else if (path.resolve(gitRoot) !== root) {
    errors.push(`git root mismatch: expected ${root}, got ${gitRoot}`)
  }

  for (const matrixError of validateMatrix(matrix)) {
    errors.push(`matrix validation: ${matrixError}`)
  }

  const writeChecks = [
    '.tmp/ci-plan.json',
    '.tmp/release-evidence/test-plan.json',
    '.tmp/gate-logs/preflight.json'
  ]
  for (const rel of writeChecks) {
    const abs = path.join(root, rel)
    try {
      ensureOutputDirectory(abs)
      const probe = `${abs}.write-check`
      fs.writeFileSync(probe, 'ok\n')
      fs.unlinkSync(probe)
    } catch (error) {
      errors.push(`cannot write ${rel}: ${error.message}`)
    }
  }

  const log = {
    schema: 'fsusblog.ci-preflight.v1',
    generatedAt: new Date().toISOString(),
    ok: errors.length === 0,
    node: process.versions.node,
    gitHead: git(['rev-parse', 'HEAD']),
    checkedDirectories,
    checkedFiles,
    writeChecks,
    errors
  }

  try {
    ensureOutputDirectory(preflightLogFile)
    fs.writeFileSync(preflightLogFile, `${JSON.stringify(log, null, 2)}\n`)
  } catch (error) {
    errors.push(`cannot write ${relativeToRoot(preflightLogFile)}: ${error.message}`)
  }

  if (errors.length > 0) {
    writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'failure', Date.now(), {
      failureStage: 'setup',
      stage: 'setup',
      rootCause: errors[0],
      jobId: 'validate-matrix'
    })
    for (const error of errors) console.error(`[matrix:preflight] ${error}`)
    process.exit(1)
  }

  // The preflight tier declares the authoritative test plan as its evidence.
  // Generate it only after validation succeeds so a clean checkout cannot
  // report a successful tier with a missing output.
  evidencePlan(matrix, '.tmp/release-evidence/test-plan.json')

  writeJobSummary(matrix, tierMap(matrix).get('validate-matrix'), 'success', Date.now(), {
    failureStage: null,
    rootCause: null,
    stage: 'setup',
    jobId: 'validate-matrix'
  })
  console.log(`[matrix:preflight] ok (${checkedDirectories.length} directories, ${checkedFiles.length} files)`)
  console.log(`[matrix:preflight] wrote ${relativeToRoot(preflightLogFile)}`)
  console.log('[matrix:preflight] To reproduce locally: ./tools/test.sh ci-tier validate-matrix')
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function usage() {
  console.log(`Usage:
  node tools/run-test-matrix.mjs validate
  node tools/run-test-matrix.mjs preflight
  node tools/run-test-matrix.mjs list
  node tools/run-test-matrix.mjs plan <tier>
  node tools/run-test-matrix.mjs run <tier> [--plan-only] [--no-deps] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-tier <tier> [--plan-only] [--no-deps] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-job <job> [--plan-only] [--shard i/n] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-job-matrix <job> [--out file] [--github-output file] [--pr-plan file]
  node tools/run-test-matrix.mjs aggregate <job> [--dry-run] [--out file] [--github-needs json]
  node tools/run-test-matrix.mjs ci-fast [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-production [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-release-final [--plan-only] [--fresh|--resume] [--max-parallel n]
  node tools/run-test-matrix.mjs ci-pr-plan [--changed-files file] [--base-ref ref] [--out .tmp/pr-plan.json] [--github-output file]
  node tools/run-test-matrix.mjs ci-pr-smart [--changed-files file] [--base-ref ref] [--full] [--plan-only]
  node tools/run-test-matrix.mjs ci-plan [--format github-actions] [--out .tmp/ci-plan.json]
  node tools/run-test-matrix.mjs docs [--out docs/testing.generated.md]
  node tools/run-test-matrix.mjs evidence-plan [--out .tmp/release-evidence/test-plan.json]

Compatibility:
  ./tools/test.sh <tier> delegates to "run <tier>".
  "./tools/test.sh production --plan-only" prints the DAG without executing it.
  "./tools/test.sh production" is the production-ci-gate: release evidence may be schema-valid collected-blocked.
  "./tools/test.sh release-closeout" is the release-closeout-gate: it requires check-release-evidence-manifest.mjs --require-ok.
  "./tools/test.sh release-final" is the final publish credential: no skip, no collected-blocked, strict coverage, strict shards, artifact-bound evidence.
`)
}

function optionValue(args, name, fallback = null) {
  const flag = `--${name}`
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return fallback
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }

  const matrix = loadMatrix()
  if (command === 'validate') {
    const errors = validateMatrix(matrix)
    if (errors.length > 0) {
      for (const error of errors) console.error(`[matrix] ${error}`)
      process.exit(1)
    }
    console.log(`[matrix] ok (${matrix.tiers.length} tiers)`)
    return
  }
  if (command === 'preflight') {
    preflight(matrix)
    return
  }
  if (command === 'list') {
    listTiers(matrix)
    return
  }
  if (command === 'plan') {
    printPlan(resolveLogicalTierResources(planTier(matrix, args[0])))
    return
  }
  if (command === 'run') {
    await runTier(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-tier') {
    await runTier(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-job') {
    await runCiJob(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-job-matrix') {
    ciJobMatrix(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'aggregate') {
    aggregateCiJob(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-fast') {
    await runTier(matrix, 'fast', args)
    return
  }
  if (command === 'ci-production') {
    await runTier(matrix, 'production', args)
    return
  }
  if (command === 'ci-release-final') {
    await runTier(matrix, 'release-final', args)
    return
  }
  if (command === 'ci-plan') {
    ciPlan(matrix, optionValue(args, 'format', 'json'), optionValue(args, 'out'))
    return
  }
  if (command === 'ci-pr-plan') {
    ciPrPlan(matrix, args)
    return
  }
  if (command === 'ci-pr-smart') {
    await ciPrSmart(matrix, args)
    return
  }
  if (command === 'docs') {
    docs(matrix, optionValue(args, 'out'))
    return
  }
  if (command === 'evidence-plan') {
    evidencePlan(matrix, optionValue(args, 'out'))
    return
  }

  throw new Error(`unknown command: ${command}`)
}

try {
  await main()
} catch (error) {
  console.error(`[matrix] ${error.message}`)
  if (process.env.FSUSBLOG_MATRIX_DEBUG_STACK === '1' && error?.stack) console.error(error.stack)
  process.exit(1)
}
