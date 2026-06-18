#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'))
const matrixFile = process.env.FSUSBLOG_MATRIX_FILE
  ? path.resolve(root, process.env.FSUSBLOG_MATRIX_FILE)
  : path.join(root, 'tests/matrix.yml')
const schemaFile = path.join(root, 'tests/matrix.schema.json')
const coverageRegistryFile = path.join(root, 'tests/coverage-registry.json')
const preflightLogFile = path.join(root, '.tmp/gate-logs/preflight.json')
const summaryStages = ['setup', 'restore', 'install', 'bootstrap', 'test', 'artifact', 'summary']
const coverageAssertionTypes = ['static', 'unit', 'integration', 'runtime', 'browser', 'perf', 'fuzz', 'mutation']
const runtimeLikeCoverageAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation'])
const cadenceValues = ['pr', 'push', 'nightly', 'release-manual']
const requiredForValues = ['fast', 'production', 'release-final', 'none']
const aliases = new Map([
  ['coverage', 'coverage-gate'],
  ['frontend-fast', 'frontend-fast-summary'],
  ['backend-qps-runtime', 'backend-qps'],
  ['endpoint-depth-matrix-generate', 'endpoint-depth'],
  ['endpoint-depth-runtime-smoke', 'endpoint-depth'],
  ['endpoint-depth-runtime-full', 'endpoint-depth']
])
const frontendFastSplitIds = [
  'frontend-build',
  'frontend-unit-shard',
  'frontend-runtime-contracts',
  'frontend-static-governance',
  'frontend-fast-summary'
]
const frontendFastExecutableSplitIds = frontendFastSplitIds.filter((tierId) => tierId !== 'frontend-fast-summary')

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
  'maxParallel',
  'requiresBootstrap',
  'requiresNode',
  'requiresDotnet',
  'requiresPlaywright',
  'cacheProfile',
  'timeoutMinutes',
  'shardable',
  'defaultShards',
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

function parseValue(raw) {
  const value = String(raw ?? '').trim()
  if (value === '[]') return []
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((item) => parseValue(item))
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseMatrix(text) {
  const matrix = { tiers: [] }
  let current = null
  let inTiers = false

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '')
    if (!withoutComment.trim()) continue

    const topMatch = withoutComment.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (topMatch && !rawLine.startsWith(' ')) {
      const [, key, value] = topMatch
      if (key === 'tiers') {
        inTiers = true
        current = null
        continue
      }
      matrix[key] = parseValue(value)
      continue
    }

    if (!inTiers) continue

    const itemMatch = withoutComment.match(/^\s{2}-\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (itemMatch) {
      current = {}
      matrix.tiers.push(current)
      current[itemMatch[1]] = parseValue(itemMatch[2])
      continue
    }

    const fieldMatch = withoutComment.match(/^\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
    if (fieldMatch && current) {
      current[fieldMatch[1]] = parseValue(fieldMatch[2])
    }
  }

  return matrix
}

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

function normalizeTierId(id) {
  return aliases.get(id) ?? id
}

function playwrightWorkersForTier(tier) {
  return tier.requiresPlaywright === 'none' ? null : Number(tier.playwrightWorkers)
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
    if (typeof entry.description !== 'string' || entry.description.length === 0) errors.push(`coverage ${coverageId}.description missing`)
    if (typeof entry.owner !== 'string' || entry.owner.length === 0) errors.push(`coverage ${coverageId}.owner missing`)
    if (!['low', 'medium', 'high', 'critical'].includes(entry.risk)) errors.push(`coverage ${coverageId}.risk invalid: ${entry.risk}`)
    if (!coverageAssertionTypes.includes(entry.assertionType)) errors.push(`coverage ${coverageId}.assertionType invalid: ${entry.assertionType}`)
    if (typeof entry.failClosedRule !== 'string' || entry.failClosedRule.length === 0) errors.push(`coverage ${coverageId}.failClosedRule missing`)
    if (typeof entry.minimumRequirement !== 'string' || entry.minimumRequirement.length === 0) errors.push(`coverage ${coverageId}.minimumRequirement missing`)
    if (!Array.isArray(entry.evidencePaths) || entry.evidencePaths.length === 0) {
      errors.push(`coverage ${coverageId}.evidencePaths must be non-empty`)
      continue
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
    if (Number(unitShard.defaultShards) < 2) errors.push('frontend-unit-shard.defaultShards must be at least 2')
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
    for (const field of ['timeoutMinutes', 'defaultShards', 'maxParallel']) {
      if (typeof tier[field] !== 'number' || tier[field] < 1) errors.push(`${tier.id}.${field} must be a positive number`)
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
    if (tier.requiresPlaywright !== 'none') {
      if (!('playwrightWorkers' in tier)) {
        errors.push(`${tier.id}.playwrightWorkers is required when requiresPlaywright=${tier.requiresPlaywright}`)
      } else if (!Number.isInteger(tier.playwrightWorkers) || tier.playwrightWorkers < 1) {
        errors.push(`${tier.id}.playwrightWorkers must be a positive integer`)
      }
    } else if ('playwrightWorkers' in tier && (!Number.isInteger(tier.playwrightWorkers) || tier.playwrightWorkers < 1)) {
      errors.push(`${tier.id}.playwrightWorkers must be a positive integer`)
    }
    if (tier.parallelizable === false && Number(tier.maxParallel) !== 1) {
      errors.push(`${tier.id} is not parallelizable but maxParallel is ${tier.maxParallel}`)
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
    if (tier.shardable === false && Number(tier.defaultShards) !== 1) {
      errors.push(`${tier.id} is not shardable but defaultShards is ${tier.defaultShards}`)
    }
  }

  errors.push(...validateFrontendFastSplit(matrix, byId))
  errors.push(...validateCoverageRegistry(matrix))

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

function namespaceFor(tier, shard) {
  if (process.env.FSUSBLOG_TEST_NAMESPACE) return namespaceSlug(process.env.FSUSBLOG_TEST_NAMESPACE)
  const runId = process.env.GITHUB_RUN_ID || 'local'
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '0'
  const job = process.env.MATRIX_JOB || tier.ciJob || tier.id
  const shardValue = shard ?? process.env.MATRIX_SHARD ?? '0'
  return namespaceSlug(`${runId}-${attempt}-${job}-${shardValue}`)
}

function namespaceSlug(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-')
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

function parseRunOptions(args) {
  const options = { planOnly: false, shard: null, noDeps: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--no-deps') options.noDeps = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else throw new Error(`unknown run option: ${arg}`)
  }
  return options
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

function frontendFastGroupEvidence(tier) {
  if (tier.id !== 'frontend-fast' && !frontendFastExecutableSplitIds.includes(tier.id)) return null
  const summaryFile = path.join(root, '.tmp/frontend/frontend-fast-groups.json')
  const jsonlFile = path.join(root, '.tmp/frontend/frontend-fast-groups.jsonl')
  try {
    if (fs.existsSync(summaryFile)) {
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      return {
        groupDurationsMs: summary.groupDurationsMs ?? {},
        groupResults: summary.groups ?? []
      }
    }
    if (fs.existsSync(jsonlFile)) {
      const groups = fs.readFileSync(jsonlFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      return {
        groupDurationsMs: Object.fromEntries(groups.map((item) => [item.group, Number(item.durationMs) || 0])),
        groupResults: groups
      }
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
  const existing = readExistingJobSummary(jobId)
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
    generatedAt: new Date().toISOString(),
    ...(groupEvidence ?? {})
  }
  const outFile = jobSummaryPath(jobId)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
}

function emitTierReproductionHint(tier, options) {
  console.error(`[matrix:${tier.id}] To reproduce tier locally: ${tierReproductionCommand(tier, options)}`)
  console.error(`[matrix:${tier.id}] To reproduce CI job locally: ${ciJobReproductionCommand(tier.ciJob)}`)
}

function runTier(matrix, tierId, args) {
  const options = parseRunOptions(args)
  const all = options.noDeps ? [tierMap(matrix).get(normalizeTierId(tierId))] : planTier(matrix, tierId)
  if (all.some((tier) => !tier)) throw new Error(`unknown tier: ${tierId}`)

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
  const runNamespace = namespaceFor(target, options.shard)

  for (const tier of all) {
    const startedAt = Date.now()
    const namespaceEnv = loadNamespaceEnv(runNamespace)
    const env = {
      ...process.env,
      ...namespaceEnv,
      CURRENT_TIER: tier.id,
      MATRIX_JOB: tier.ciJob,
      FSUSBLOG_TEST_NAMESPACE: runNamespace
    }
    const playwrightWorkers = playwrightWorkersForTier(tier)
    if (playwrightWorkers !== null) {
      env.FSUSBLOG_PLAYWRIGHT_WORKERS = String(playwrightWorkers)
    }
    if (options.shard) {
      const [index, total] = options.shard.split('/')
      env.MATRIX_SHARD = options.shard
      env.FSUSBLOG_TEST_SHARD_INDEX = index
      env.FSUSBLOG_TEST_SHARD_TOTAL = total
      if (tier.requiresPlaywright !== 'none') {
        env.FSUSBLOG_PLAYWRIGHT_SHARD_ARG = `--shard=${index}/${total}`
      }
    }

    emitTierReproductionHint(tier, options)
    console.error(`[matrix:${tier.id}] ${tier.command}`)
    const result = spawnSync(tier.command, {
      cwd: root,
      env,
      shell: true,
      stdio: 'inherit'
    })
    if (result.status !== 0) {
      writeJobSummary(matrix, tier, 'failure', startedAt, {
        failureStage: stageForTier(tier),
        rootCause: `${tier.command} exited ${result.status ?? 1}`
      })
      process.exit(result.status ?? 1)
    }
    writeJobSummary(matrix, tier, 'success', startedAt)
  }
}

function parseCiJobOptions(args) {
  const options = { planOnly: false, shard: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--plan-only') options.planOnly = true
    else if (arg === '--shard') options.shard = args[++index]
    else if (arg.startsWith('--shard=')) options.shard = arg.slice('--shard='.length)
    else throw new Error(`unknown ci-job option: ${arg}`)
  }
  return options
}

function parseCiJobMatrixOptions(args) {
  const options = { outFile: null, githubOutputFile: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--out') options.outFile = args[++index]
    else if (arg.startsWith('--out=')) options.outFile = arg.slice('--out='.length)
    else if (arg === '--github-output') options.githubOutputFile = args[++index]
    else if (arg.startsWith('--github-output=')) options.githubOutputFile = arg.slice('--github-output='.length)
    else throw new Error(`unknown ci-job-matrix option: ${arg}`)
  }
  return options
}

function ciJobTiers(matrix, jobId) {
  return matrix.tiers.filter((tier) => tier.ciJob === jobId && tier.localOnly !== true && tier.nightlyOnly !== true && tier.manualOnly !== true)
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

function buildCiJobMatrix(matrix, jobId) {
  const tiers = ciJobTiers(matrix, jobId)
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)

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
      playwright_workers: playwrightWorkersForTier(tier) ?? 1,
      timeout_minutes: tier.timeoutMinutes,
      artifact_name: `${jobId}-${tier.id}`
    })
  }

  return {
    include
  }
}

function ciJobMatrix(matrix, jobId, args) {
  const options = parseCiJobMatrixOptions(args)
  const payload = buildCiJobMatrix(matrix, jobId)
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
  const tiers = ciJobTiers(matrix, jobId)
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  console.log(`To reproduce GitHub Actions job "${jobId}" locally:`)
  console.log(`  ${ciJobReproductionCommand(jobId, matrix)}`)
  console.log(`  execution mode: ${ciJobExecutionMode(matrix, jobId)}`)
  console.log(`  scheduler: ${ciJobSchedulerMode(tiers)} (max ${ciJobMaxParallel(tiers)}, debug fallback: FSUSBLOG_CI_JOB_SERIAL=1)`)
  console.log('')
  for (const tier of tiers) {
    const shard = tier.shardable ? ` --shard 1/${tier.defaultShards}` : ''
    console.log(`- ${tier.id}: ${tierReproductionCommand(tier, { noDeps: true })}${shard}`)
    console.log(`  matrix command: ${tier.command}`)
  }
}

function runCiJobSerial(matrix, tiers, options) {
  for (const tier of tiers) {
    const runArgs = ['--no-deps']
    if (options.shard && tier.shardable) runArgs.push('--shard', options.shard)
    runTier(matrix, tier.id, runArgs)
  }
}

function ciJobChildArgs(tier, options) {
  const args = [path.join(root, 'tools/run-test-matrix.mjs'), 'ci-tier', tier.id, '--no-deps']
  if (options.shard && tier.shardable) args.push('--shard', options.shard)
  return args
}

function stopActiveCiJobChildren(activeEntries) {
  for (const { child, tier } of activeEntries) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    console.error(`[matrix:ci-job] stopping ${tier.id} after sibling failure`)
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 5000)
    timer.unref?.()
  }
}

async function runCiJobScheduled(matrix, jobId, tiers, options) {
  const pending = [...tiers]
  const completed = new Set()
  const tierIds = new Set(tiers.map((tier) => tier.id))
  const active = new Map()
  const jobMaxParallel = ciJobMaxParallel(tiers)
  let firstFailure = null

  console.error(`[matrix:ci-job:${jobId}] scheduler=parallel max=${jobMaxParallel}`)

  return await new Promise((resolve) => {
    const finishIfReady = () => {
      if ((pending.length === 0 || firstFailure) && active.size === 0) {
        resolve(firstFailure?.status ?? 0)
      }
    }

    const startTier = (tier) => {
      const env = {
        ...process.env,
        FSUSBLOG_CI_JOB_ID: `${jobId}-${tier.id}`,
        FSUSBLOG_CI_JOB_SCHEDULER: 'parallel'
      }
      const child = spawn(process.execPath, ciJobChildArgs(tier, options), {
        cwd: root,
        env,
        stdio: 'inherit'
      })
      active.set(tier.id, { child, tier })
      console.error(`[matrix:ci-job:${jobId}] started ${tier.id} pid=${child.pid}`)
      child.on('error', (error) => {
        active.delete(tier.id)
        if (!firstFailure) {
          firstFailure = { status: 1, tier: tier.id, signal: null }
          console.error(`[matrix:ci-job:${jobId}] ${tier.id} failed to start: ${error.message}`)
          stopActiveCiJobChildren([...active.values()])
        }
        schedule()
      })
      child.on('exit', (code, signal) => {
        active.delete(tier.id)
        if (code === 0 && !signal) {
          completed.add(tier.id)
          console.error(`[matrix:ci-job:${jobId}] completed ${tier.id}`)
        } else if (!firstFailure) {
          firstFailure = {
            status: code ?? 1,
            tier: tier.id,
            signal
          }
          console.error(`[matrix:ci-job:${jobId}] ${tier.id} failed status=${code ?? 'signal'} signal=${signal ?? 'none'}`)
          stopActiveCiJobChildren([...active.values()])
        }
        schedule()
      })
    }

    const schedule = () => {
      if (firstFailure) {
        finishIfReady()
        return
      }

      let started = false
      while (active.size < jobMaxParallel) {
        const activeEntries = [...active.values()]
        const nextIndex = pending.findIndex((tier) => {
          const dependenciesDone = internalCiJobDependencies(tier, tierIds).every((dependencyId) => completed.has(dependencyId))
          return dependenciesDone && canStartCiJobTier(tier, activeEntries, jobMaxParallel)
        })
        if (nextIndex < 0) break
        const [tier] = pending.splice(nextIndex, 1)
        startTier(tier)
        started = true
      }

      if (!started && active.size === 0 && pending.length > 0) {
        firstFailure = { status: 1, tier: pending[0].id, signal: null }
        console.error(`[matrix:ci-job:${jobId}] no runnable tiers remain; check dependencies and resource metadata`)
      }
      finishIfReady()
    }

    schedule()
  })
}

async function runCiJob(matrix, jobId, args) {
  const options = parseCiJobOptions(args)
  const tiers = ciJobTiers(matrix, jobId)
  if (tiers.length === 0) throw new Error(`unknown CI job or no required tiers: ${jobId}`)
  if (options.planOnly) {
    printCiJobPlan(matrix, jobId)
    return
  }

  if (process.env.FSUSBLOG_CI_JOB_SERIAL === '1' || ciJobSchedulerMode(tiers) === 'serial') {
    if (process.env.FSUSBLOG_CI_JOB_SERIAL === '1') console.error(`[matrix:ci-job:${jobId}] scheduler=serial forced by FSUSBLOG_CI_JOB_SERIAL=1`)
    runCiJobSerial(matrix, tiers, options)
    return
  }

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
  const tiers = ciJobTiers(matrix, jobId)
  const shardSummaryIds = []
  for (const tier of tiers) {
    const totalShards = tier.shardable ? Number(tier.defaultShards) || 1 : 1
    if (totalShards <= 1) continue
    for (let index = 1; index <= totalShards; index += 1) {
      shardSummaryIds.push(`${jobId}-${shardId(index, totalShards)}`)
    }
  }
  if (shardSummaryIds.length > 0) return shardSummaryIds
  if (jobId !== 'fast-backend') return [jobId]
  return tiers.map((tier) => `${jobId}-${tier.id}`)
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
    for (const tier of ciJobTiers(matrix, jobId)) addTierPaths(tier)
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
  const normalized = String(rel ?? '').trim().replace(/^['"]|['"]$/g, '').replaceAll('/', path.sep)
  if (!normalized) return false
  const direct = path.join(root, normalized)
  if (fs.existsSync(direct)) return true

  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  const suffix = `${path.sep}${normalized}`
  return findFiles(downloadedRoot, (candidate) => candidate.endsWith(suffix) || candidate.includes(suffix)).length > 0
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
      tier.parallelizable ? 'parallel' : 'serial',
      tier.shardable ? `shardable:${tier.defaultShards}` : 'single'
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
  const jobs = new Map()
  for (const tier of matrix.tiers) {
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
    '| Tier | CI job | Local command | Phase | Risk | Cadence | Required for | Resource | Cost | Max parallel | PW workers | Bootstrap | Node | .NET | Playwright | Cache | Depends on | Services | Shards | Timeout | Artifacts | Evidence |',
    '|---|---|---|---:|---|---|---|---|---|---:|---:|---|---|---|---|---|---|---|---:|---:|---|---|'
  ]
  for (const tier of matrix.tiers) {
    lines.push([
      `\`${tier.id}\``,
      `\`${tier.ciJob}\``,
      `\`./tools/test.sh ci-tier ${tier.id}\``,
      String(tier.phase),
      tier.risk,
      tier.cadence,
      tier.requiredFor,
      tier.resourceClass,
      tier.cost,
      String(tier.maxParallel),
      playwrightWorkersForTier(tier) === null ? '-' : String(playwrightWorkersForTier(tier)),
      tier.requiresBootstrap,
      tier.requiresNode ? 'yes' : 'no',
      tier.requiresDotnet ? 'yes' : 'no',
      tier.requiresPlaywright,
      tier.cacheProfile,
      tier.dependsOn.length > 0 ? tier.dependsOn.map((id) => `\`${id}\``).join(', ') : '-',
      tier.services.length > 0 ? tier.services.join(', ') : '-',
      tier.shardable ? String(tier.defaultShards) : '1',
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
  const plan = {
    schema: 'fsusblog.release-evidence.test-plan.v1',
    generatedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    namespace: process.env.FSUSBLOG_TEST_NAMESPACE ?? null,
    tiers: matrix.tiers.map((tier) => ({
      id: tier.id,
      ciJob: tier.ciJob,
      command: tier.command,
      dependsOn: tier.dependsOn,
      timeoutMinutes: tier.timeoutMinutes,
      phase: tier.phase,
      cost: tier.cost,
      resourceClass: tier.resourceClass,
      maxParallel: tier.maxParallel,
      requiresBootstrap: tier.requiresBootstrap,
      requiresNode: tier.requiresNode,
      requiresDotnet: tier.requiresDotnet,
      requiresPlaywright: tier.requiresPlaywright,
      playwrightWorkers: playwrightWorkersForTier(tier),
      cacheProfile: tier.cacheProfile,
      shardable: tier.shardable,
      defaultShards: tier.defaultShards,
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
  node tools/run-test-matrix.mjs run <tier> [--plan-only] [--no-deps] [--shard i/n]
  node tools/run-test-matrix.mjs ci-tier <tier> [--plan-only] [--no-deps] [--shard i/n]
  node tools/run-test-matrix.mjs ci-job <job> [--plan-only] [--shard i/n]
  node tools/run-test-matrix.mjs ci-job-matrix <job> [--out file] [--github-output file]
  node tools/run-test-matrix.mjs aggregate <job> [--dry-run] [--out file] [--github-needs json]
  node tools/run-test-matrix.mjs ci-fast [--plan-only]
  node tools/run-test-matrix.mjs ci-production [--plan-only]
  node tools/run-test-matrix.mjs ci-release-final [--plan-only]
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
    printPlan(planTier(matrix, args[0]))
    return
  }
  if (command === 'run') {
    runTier(matrix, args[0], args.slice(1))
    return
  }
  if (command === 'ci-tier') {
    runTier(matrix, args[0], args.slice(1))
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
    runTier(matrix, 'fast', args)
    return
  }
  if (command === 'ci-production') {
    runTier(matrix, 'production', args)
    return
  }
  if (command === 'ci-release-final') {
    runTier(matrix, 'release-final', args)
    return
  }
  if (command === 'ci-plan') {
    ciPlan(matrix, optionValue(args, 'format', 'json'), optionValue(args, 'out'))
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
  process.exit(1)
}
