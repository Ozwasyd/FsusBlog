import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'

import { createAsyncLogPipeline } from './async-log-pipeline.mjs'
import {
  readAndValidateArtifactDigestTable,
  validateArtifactRefs
} from './artifact-digest-table.mjs'
import { RunEvidenceObjectStore } from './content-addressed-evidence-store.mjs'
import {
  artifactSubstitutionBindingDigest,
  resolveRunBoundArtifactDeclaration
} from './local-profile.mjs'
import { createProductionResourceEnforcer } from './production-resource-enforcement.mjs'
import {
  createResidentLeaseHandoff,
  readResidentLeaseDocument,
  reconcileResidentLeaseInventory,
  validateResidentLeaseHandoff,
  validateResidentLeaseInventory,
  writeResidentLeaseDocument
} from './resident-resource-leases.mjs'
import {
  createLinuxProcessTreeCollector,
  createWaitLedger,
  prioritySchemas,
  rankReadyTiers,
  resolveResourceSampleIntervalMs,
  startupAdmissionOrder
} from './scheduler-admission-support.mjs'

const checkpointSchema = 'fsusblog.test-matrix.checkpoint.v1'
const runtimeCleanupAttemptLedgerSchema = 'fsusblog.production-fresh.runtime-cleanup-attempt-ledger.v1'
const protectedSupersedesPattern = /(^|[^a-z])(property|model|perf|performance|benchmark|runtime)([^a-z]|$)/i
const protectedAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation'])
const protectedExecutionVariants = new Set(['property', 'model', 'performance', 'runtime'])
const fingerprintEnvironmentPrefixes = ['FSUSBLOG_', 'PLAYWRIGHT_', 'MATRIX_', 'VITE_']
const fingerprintEnvironmentKeys = new Set(['CI', 'NODE_ENV', 'DOTNET_ROOT'])
const orchestrationOnlyFingerprintEnvironmentKeys = new Set([
  'FSUSBLOG_TEST_INVOCATION_STARTED_AT_MS',
  'FSUSBLOG_TEST_EXECUTION_SOURCE',
  'FSUSBLOG_TIER_CPU_UNITS',
  'FSUSBLOG_TIER_MEMORY_GIB',
  'FSUSBLOG_BUNDLE_CPU_BUDGET',
  'FSUSBLOG_BUNDLE_MEMORY_GIB',
  'FSUSBLOG_VITEST_MAX_WORKERS',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_PLAYWRIGHT_WORKERS',
  'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE',
  'FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID',
  'FSUSBLOG_CGROUP_BUNDLE_PATH',
  'FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX',
  'FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES',
  'FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES',
  'FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX'
])
const checkpointPersistence = new Map()
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

function fingerprint(value) {
  const serialized = JSON.stringify(stableValue(value))
  return sha256(serialized === undefined ? 'undefined' : serialized)
}

function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function registryEntry(coverageRegistry, coverageId) {
  if (coverageRegistry instanceof Map) return coverageRegistry.get(coverageId)
  if (Array.isArray(coverageRegistry)) return coverageRegistry.find((entry) => entry?.id === coverageId)
  return coverageRegistry?.[coverageId]
}

export function validateSupersedesRules(tiers, coverageRegistry = new Map()) {
  const errors = []
  const byId = new Map(tiers.map((tier) => [tier.id, tier]))
  const claimed = new Map()
  const edges = new Map()

  for (const replacement of tiers) {
    if (!Array.isArray(replacement.supersedes)) continue
    for (const targetId of replacement.supersedes) {
      const targets = edges.get(replacement.id) ?? []
      targets.push(targetId)
      edges.set(replacement.id, targets)
      const target = byId.get(targetId)
      if (!target) {
        errors.push(`${replacement.id}.supersedes references missing tier ${targetId}`)
        continue
      }
      if (targetId === replacement.id) {
        errors.push(`${replacement.id} must not supersede itself`)
        continue
      }
      if (claimed.has(targetId)) {
        errors.push(`${targetId} is superseded by both ${claimed.get(targetId)} and ${replacement.id}`)
      } else {
        claimed.set(targetId, replacement.id)
      }
      if (!replacement.executionKey || !target.executionKey || replacement.executionKey !== target.executionKey) {
        errors.push(`${replacement.id} may supersede ${targetId} only when both tiers use the same executionKey`)
      }
      if (replacement.executionVariant !== 'coverage' || target.executionVariant !== 'ordinary') {
        errors.push(`${replacement.id} may supersede ${targetId} only with executionVariant=coverage replacing executionVariant=ordinary`)
      }

      const replacementCoverage = new Set(replacement.coverage ?? [])
      const targetCoverage = new Set(target.coverage ?? [])
      const coversTarget = [...targetCoverage].every((coverageId) => replacementCoverage.has(coverageId))
      if (targetCoverage.size === 0 || !coversTarget) {
        errors.push(`${replacement.id} may supersede ${targetId} only when target coverage is a non-empty subset of replacement coverage`)
      }
      const missingCoverageMetadata = [...targetCoverage].filter((coverageId) => !registryEntry(coverageRegistry, coverageId))
      if (missingCoverageMetadata.length > 0) {
        errors.push(`${replacement.id} cannot validate ${targetId} without coverage registry metadata for ${missingCoverageMetadata.join(',')}`)
      }

      const protectedText = [
        target.id,
        target.executionKey,
        target.command,
        ...(target.coverage ?? [])
      ].filter(Boolean).join(' ')
      const protectedByRegistry = [...targetCoverage].some((coverageId) => {
        const assertionType = registryEntry(coverageRegistry, coverageId)?.assertionType
        return assertionType && assertionType !== 'unit'
      })
      if (
        target.resourceClass === 'benchmark'
        || protectedExecutionVariants.has(target.executionVariant)
        || protectedSupersedesPattern.test(protectedText)
        || protectedByRegistry
        || [...targetCoverage].some((coverageId) => protectedAssertionTypes.has(registryEntry(coverageRegistry, coverageId)?.assertionType))
      ) {
        errors.push(`${replacement.id} must not supersede protected property/model/perf/runtime tier ${targetId}`)
      }
    }
  }

  const visiting = new Set()
  const visited = new Set()
  const visit = (tierId, stack = []) => {
    if (visited.has(tierId)) return
    if (visiting.has(tierId)) {
      errors.push(`supersedes cycle detected: ${[...stack, tierId].join(' -> ')}`)
      return
    }
    visiting.add(tierId)
    for (const targetId of edges.get(tierId) ?? []) visit(targetId, [...stack, tierId])
    visiting.delete(tierId)
    visited.add(tierId)
  }
  for (const tierId of edges.keys()) visit(tierId)

  const supersededIds = new Set([...edges.values()].flat())
  for (const tierId of edges.keys()) {
    if (supersededIds.has(tierId)) errors.push(`supersedes chain is ambiguous at tier ${tierId}`)
  }

  return errors
}

export function applySupersedes(tiers) {
  const selectedIds = new Set(tiers.map((tier) => tier.id))
  const replacementByTarget = new Map()
  for (const replacement of tiers) {
    for (const targetId of replacement.supersedes ?? []) {
      if (selectedIds.has(targetId)) replacementByTarget.set(targetId, replacement.id)
    }
  }

  const resolveReplacement = (tierId) => {
    const seen = new Set()
    let current = tierId
    while (replacementByTarget.has(current) && !seen.has(current)) {
      seen.add(current)
      current = replacementByTarget.get(current)
    }
    return current
  }

  return tiers
    .filter((tier) => !replacementByTarget.has(tier.id))
    .map((tier) => {
      const field = 'executionDependsOn' in tier ? 'executionDependsOn' : 'dependsOn'
      return {
        ...tier,
        [field]: [...new Set(tierExecutionDependencies(tier)
          .map(resolveReplacement)
          .filter((dependencyId) => dependencyId !== tier.id))]
      }
    })
}

function tierExecutionDependencies(tier) {
  return tier?.executionDependsOn ?? tier?.dependsOn ?? []
}

function worktreePaths(root) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024
  })
  if (result.status !== 0) return []
  return result.stdout.toString('utf8').split('\0').filter(Boolean).sort()
}

function dirtyWorktreeEntries(root) {
  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024
  })
  if (result.status !== 0) return new Map()
  const records = result.stdout.toString('utf8').split('\0')
  const entries = new Map()
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!record) continue
    const status = record.slice(0, 2)
    const relativePath = record.slice(3).replaceAll(path.sep, '/')
    const renamed = status.includes('R') || status.includes('C')
    const originalPath = renamed ? records[++index]?.replaceAll(path.sep, '/') ?? null : null
    entries.set(relativePath, { status, originalPath })
  }
  return entries
}

function gitIndexEntries(root) {
  const result = spawnSync('git', ['ls-files', '--stage', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024
  })
  if (result.status !== 0) return new Map()
  const entries = new Map()
  for (const record of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/)
    if (!match) continue
    const [, mode, objectId, stage, rawPath] = match
    const relativePath = rawPath.replaceAll(path.sep, '/')
    const values = entries.get(relativePath) ?? []
    values.push(`${mode}:${objectId}:${stage}`)
    entries.set(relativePath, values)
  }
  return new Map([...entries].map(([relativePath, values]) => [relativePath, values.sort().join('|')]))
}

function pathContentFingerprint(root, relativePath) {
  const absolutePath = path.join(root, relativePath)
  try {
    const stat = fs.lstatSync(absolutePath)
    if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(absolutePath))}`
    if (stat.isFile()) return `file:${sha256(fs.readFileSync(absolutePath))}`
    if (stat.isDirectory()) return 'directory'
    return `other:${stat.mode}`
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    throw error
  }
}

export async function snapshotGitWorktree(root) {
  const dirtyEntries = dirtyWorktreeEntries(root)
  const indexEntries = gitIndexEntries(root)
  let hashedPathCount = 0
  const entries = {}
  for (const [relativePath, statusEntry] of [...dirtyEntries].sort(([left], [right]) => left.localeCompare(right))) {
    const absolutePath = path.join(root, relativePath)
    let mode = null
    let content = 'missing'
    try {
      const stat = fs.lstatSync(absolutePath)
      mode = stat.mode
      content = pathContentFingerprint(root, relativePath)
      if (stat.isFile() || stat.isSymbolicLink()) hashedPathCount += 1
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    entries[relativePath] = {
      status: statusEntry.status,
      originalPath: statusEntry.originalPath,
      mode,
      index: indexEntries.get(relativePath) ?? null,
      content
    }
  }
  return { entries, fingerprint: fingerprint(entries), hashedPathCount }
}

export async function snapshotSourceState(root) {
  const snapshot = await snapshotGitWorktree(root)
  return {
    commit: gitHead(root),
    worktreeFingerprint: snapshot.fingerprint
  }
}

function changedSnapshotPaths(before, after) {
  const beforeEntries = before?.entries ?? {}
  const afterEntries = after?.entries ?? {}
  const paths = new Set([...Object.keys(beforeEntries), ...Object.keys(afterEntries)])
  return [...paths].filter((item) => fingerprint(beforeEntries[item]) !== fingerprint(afterEntries[item])).sort()
}

function wildcardPattern(value) {
  const normalized = value.replaceAll('\\', '/')
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
    } else if (character === '*') {
      source += '[^/]*'
    } else if (character === '?') {
      source += '[^/]'
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

function hasWildcard(value) {
  return value.includes('*') || value.includes('?')
}

function walkOutputPaths(rootDirectory) {
  const paths = []
  const visit = (absolutePath) => {
    let stat
    try {
      stat = fs.lstatSync(absolutePath)
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    paths.push(absolutePath)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return
    for (const name of fs.readdirSync(absolutePath).sort()) visit(path.join(absolutePath, name))
  }
  visit(rootDirectory)
  return paths
}

function outputPathFingerprint(absolutePath) {
  const stat = fs.lstatSync(absolutePath)
  if (stat.isSymbolicLink()) return `symlink:${sha256(fs.readlinkSync(absolutePath))}`
  if (stat.isFile()) return `file:${stat.mode}:${stat.size}:${sha256(fs.readFileSync(absolutePath))}`
  if (!stat.isDirectory()) return `other:${stat.mode}:${stat.size}`
  const entries = fs.readdirSync(absolutePath).sort().map((name) => [name, outputPathFingerprint(path.join(absolutePath, name))])
  return `directory:${fingerprint(entries)}`
}

function wildcardSearchRoot(root, pattern) {
  const wildcardIndex = pattern.search(/[?*]/u)
  const prefix = wildcardIndex < 0 ? pattern : pattern.slice(0, wildcardIndex)
  const directoryPrefix = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix)
  const absolutePath = path.resolve(root, directoryPrefix === '.' ? '' : directoryPrefix)
  return absolutePath.startsWith(`${root}${path.sep}`) || absolutePath === root ? absolutePath : root
}

export function aggregateArtifactPathExists({ root: rootValue, downloadedRoot: downloadedRootValue, declaration }) {
  const root = path.resolve(rootValue)
  const downloadedRoot = path.resolve(downloadedRootValue)
  const normalized = String(declaration ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//u, '')
    .replaceAll('\\', '/')
  if (!normalized || path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) return false

  const direct = path.resolve(root, normalized)
  if (direct.startsWith(`${root}${path.sep}`) || direct === root) {
    if (!hasWildcard(normalized) && fs.existsSync(direct)) return true
    if (hasWildcard(normalized)) {
      const matcher = wildcardPattern(normalized)
      const searchRoot = wildcardSearchRoot(root, normalized)
      if (fs.existsSync(searchRoot) && walkOutputPaths(searchRoot).some((candidate) => (
        matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/'))
      ))) return true
    }
  }

  if (!fs.existsSync(downloadedRoot)) return false
  const downloadedPaths = walkOutputPaths(downloadedRoot)
    .map((candidate) => path.relative(downloadedRoot, candidate).replaceAll(path.sep, '/'))
  if (hasWildcard(normalized)) {
    const suffixMatcher = wildcardPattern(`**/${normalized}`)
    return downloadedPaths.some((candidate) => suffixMatcher.test(candidate))
  }
  return downloadedPaths.some((candidate) => candidate === normalized || candidate.endsWith(`/${normalized}`))
}

export function snapshotTierOutputs(rootValue, tier, env = process.env) {
  const root = path.resolve(rootValue)
  const declarations = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])].map(String))].sort()
  const entries = {}
  let reusable = true
  for (const declaration of declarations) {
    const normalized = declaration.replace(/^\.\//u, '').replaceAll('\\', '/')
    const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env)
    const matcher = wildcardPattern(resolvedDeclaration)
    const absoluteDeclaration = path.resolve(root, resolvedDeclaration)
    if (!absoluteDeclaration.startsWith(`${root}${path.sep}`) && absoluteDeclaration !== root) {
      entries[normalized] = 'outside-root'
      reusable = false
      continue
    }
    if (!hasWildcard(resolvedDeclaration)) {
      if (!fs.existsSync(absoluteDeclaration)) {
        entries[normalized] = 'missing'
        reusable = false
      } else {
        entries[normalized] = outputPathFingerprint(absoluteDeclaration)
      }
      continue
    }

    const searchRoot = wildcardSearchRoot(root, resolvedDeclaration)
    const matches = fs.existsSync(searchRoot)
      ? walkOutputPaths(searchRoot)
        .map((absolutePath) => path.relative(root, absolutePath).replaceAll(path.sep, '/'))
        .filter((relativePath) => matcher.test(relativePath))
        .sort()
      : []
    if (matches.length === 0) {
      entries[normalized] = 'missing-wildcard'
      reusable = false
    } else {
      entries[normalized] = matches.map((relativePath) => [relativePath, outputPathFingerprint(path.join(root, relativePath))])
    }
  }
  return { entries, fingerprint: fingerprint(entries), reusable }
}

function generatedOutputDeclaration(value) {
  const normalized = String(value ?? '').replace(/^\.\//u, '').replaceAll('\\', '/')
  return normalized.startsWith('.tmp/')
    || normalized.startsWith('src/frontend/test-results/')
    || normalized.startsWith('src/frontend/playwright-report/')
    || normalized.startsWith('src/frontend/coverage/')
}

function declarationPrefix(value) {
  const normalized = String(value ?? '').replace(/^\.\//u, '').replaceAll('\\', '/')
  const wildcardIndex = normalized.search(/[?*]/u)
  return (wildcardIndex < 0 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/$/u, '')
}

function declarationsOverlap(left, right) {
  const leftPrefix = declarationPrefix(left)
  const rightPrefix = declarationPrefix(right)
  return leftPrefix === rightPrefix
    || leftPrefix.startsWith(`${rightPrefix}/`)
    || rightPrefix.startsWith(`${leftPrefix}/`)
}

function ownedGeneratedDeclarations(tier, byId) {
  if (/tools\/test\/lanes\/noop\.sh\b/u.test(String(tier.command))) return []
  const dependencyDeclarations = []
  const visitedDependencies = new Set([tier.id])
  const collectDependencyDeclarations = (dependencyId) => {
    if (visitedDependencies.has(dependencyId)) return
    visitedDependencies.add(dependencyId)
    const dependency = byId.get(dependencyId)
    if (!dependency) return
    dependencyDeclarations.push(...(dependency.artifacts ?? []), ...(dependency.evidence ?? []))
    for (const ancestorId of tierExecutionDependencies(dependency)) collectDependencyDeclarations(ancestorId)
  }
  for (const dependencyId of tierExecutionDependencies(tier)) collectDependencyDeclarations(dependencyId)
  const candidates = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])])]
    .filter(generatedOutputDeclaration)
    .filter((declaration) => !dependencyDeclarations.some((dependency) => declarationsOverlap(declaration, dependency)))
  return candidates.filter((declaration) => {
    if (hasWildcard(String(declaration))) return true
    const prefix = declarationPrefix(declaration)
    return !candidates.some((other) => other !== declaration && declarationPrefix(other).startsWith(`${prefix}/`))
  })
}

function outputProvenance(root, declarations, env = process.env) {
  const entries = {}
  for (const declaration of declarations) {
    const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/')
    const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env)
    const matcher = wildcardPattern(resolvedDeclaration)
    const absolute = path.resolve(root, resolvedDeclaration)
    const matches = hasWildcard(resolvedDeclaration)
      ? (fs.existsSync(wildcardSearchRoot(root, resolvedDeclaration))
          ? walkOutputPaths(wildcardSearchRoot(root, resolvedDeclaration)).filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
          : [])
      : (fs.existsSync(absolute) ? [absolute] : [])
    for (const candidate of matches.sort()) {
      const relativePath = path.relative(root, candidate).replaceAll(path.sep, '/')
      const stat = fs.lstatSync(candidate)
      entries[relativePath] = {
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        fingerprint: outputPathFingerprint(candidate)
      }
    }
  }
  return { entries, fingerprint: fingerprint(entries) }
}

function cleanFreshOwnedFiles(root, declarations, env = process.env) {
  for (const declaration of declarations) {
    const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/')
    const resolvedDeclaration = resolveRunBoundArtifactDeclaration(root, normalized, env)
    if (hasWildcard(resolvedDeclaration)) {
      const searchRoot = wildcardSearchRoot(root, resolvedDeclaration)
      if (!fs.existsSync(searchRoot)) continue
      const matcher = wildcardPattern(resolvedDeclaration)
      const matches = walkOutputPaths(searchRoot)
        .filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
        .sort((left, right) => right.length - left.length)
      for (const candidate of matches) fs.rmSync(candidate, { recursive: true, force: true })
      continue
    }
    const absolute = path.resolve(root, resolvedDeclaration)
    if (fs.existsSync(absolute)) fs.rmSync(absolute, { recursive: true, force: true })
  }
}

function cacheInputEntries(root, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return {}
  const candidates = worktreePaths(root)
  const entries = {}
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern).replace(/^\.\//, '').replaceAll('\\', '/')
    const absolutePath = path.resolve(root, pattern)
    if (!pattern.includes('*') && !pattern.includes('?') && fs.existsSync(absolutePath)) {
      const stat = fs.statSync(absolutePath)
      if (stat.isDirectory()) {
        const prefix = `${pattern.replace(/\/$/, '')}/`
        for (const candidate of candidates.filter((item) => item.startsWith(prefix))) {
          entries[candidate] = pathContentFingerprint(root, candidate)
        }
      } else {
        entries[pattern] = pathContentFingerprint(root, pattern)
      }
      continue
    }
    const matcher = wildcardPattern(pattern)
    const matches = candidates.filter((candidate) => matcher.test(candidate))
    if (matches.length === 0) entries[pattern] = 'missing'
    for (const candidate of matches) entries[candidate] = pathContentFingerprint(root, candidate)
  }
  return entries
}

function repositoryInputFingerprint(root) {
  const entries = {}
  for (const relativePath of worktreePaths(root)) entries[relativePath] = pathContentFingerprint(root, relativePath)
  return fingerprint(entries)
}

function commandInputPath(command) {
  const tokens = String(command ?? '').match(/(?:"[^"]*"|'[^']*'|\S+)/gu)?.map((token) => token.replace(/^['"]|['"]$/gu, '')) ?? []
  return tokens.find((token, index) => (
    index === 0
      ? /^(?:\.\/)?(?:tools|tests|src)\//u.test(token)
      : /^(?:\.\/)?(?:tools|tests|src)\/.*\.(?:mjs|js|sh|ts)$/u.test(token)
  ))?.replace(/^\.\//u, '') ?? null
}

export function effectiveCacheInputs(tier) {
  const hasDeclaredInputs = (tier.cacheInputs?.length ?? 0) > 0
  const inputs = new Set((tier.cacheInputs ?? []).map(String))
  inputs.add('tests/matrix.yml')
  inputs.add('tests/coverage-registry.json')
  const commandPath = commandInputPath(tier.command)
  if (commandPath) inputs.add(commandPath)
  if (!hasDeclaredInputs) {
    for (const value of [...(tier.triggerPaths ?? []), ...(tier.triggerFiles ?? [])]) inputs.add(String(value))
  }

  if (tier.id === 'coverage-frontend' || String(tier.id).startsWith('frontend-')) {
    for (const value of ['src/frontend/package.json', 'tests/frontend', 'src/frontend/vitest*.config.ts', 'src/frontend/vitest.shared.mjs']) inputs.add(value)
  }

  const dependencyOnlyAggregate = tierExecutionDependencies(tier).length > 0 && /tools\/test\/lanes\/noop\.sh\b/u.test(String(tier.command))
  if (!hasDeclaredInputs && !dependencyOnlyAggregate && (tier.triggerPaths?.length ?? 0) === 0 && (tier.triggerFiles?.length ?? 0) === 0) {
    inputs.add('tools')
    const backend = tier.requiresDotnet === true || tier.owner === 'ServerContractAgent' || ['backend', 'full'].includes(tier.cacheProfile)
    const frontend = tier.requiresNode === true || tier.owner === 'InteropGlueAgent' || ['frontend', 'full'].includes(tier.cacheProfile)
    if (backend) {
      for (const value of ['Directory.Build.props', 'FsusBlog.slnx', 'global.json', 'src/backend', 'src/core', 'src/shared', 'tests/backend']) inputs.add(value)
    }
    if (frontend) {
      for (const value of ['src/frontend/package.json', 'src/frontend/package-lock.json', 'src/frontend/src', 'tests/frontend']) inputs.add(value)
    }
    if (/governance|evidence|security|privacy|perception|release|quality/u.test(String(tier.id))) {
      for (const value of ['.github', 'docs', 'security']) inputs.add(value)
    }
  }
  return [...inputs].sort()
}

function fingerprintEnvironment(env) {
  return Object.fromEntries(Object.entries(env ?? {})
    .filter(([key]) => !['FSUSBLOG_TEST_SOURCE_COMMIT', 'FSUSBLOG_TEST_SOURCE_FINGERPRINT'].includes(key))
    .filter(([key]) => !orchestrationOnlyFingerprintEnvironmentKeys.has(key))
    .filter(([key]) => fingerprintEnvironmentKeys.has(key) || fingerprintEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, String(value)]))
}

export function tierInputFingerprint(tier, root, context = {}) {
  const declaredCacheInputs = effectiveCacheInputs(tier)
  return fingerprint({
    executionKey: tier.executionKey ?? tier.id,
    command: tier.command,
    cacheInputs: declaredCacheInputs,
    inputs: declaredCacheInputs.length > 0
      ? cacheInputEntries(root, declaredCacheInputs)
      : { conservativeRepositoryFingerprint: context.repositoryFingerprint ?? repositoryInputFingerprint(root) },
    runtime: {
      environment: fingerprintEnvironment(context.env ?? process.env),
      platform: context.platform ?? process.platform,
      arch: context.arch ?? process.arch,
      nodeVersion: context.nodeVersion ?? process.version
    }
  })
}

function normalizeExecutionResult(value) {
  if (typeof value === 'number') return { code: value, signal: null }
  return {
    code: value?.code ?? value?.status ?? 0,
    signal: value?.signal ?? null,
    error: value?.error ?? null
  }
}

function signalProcessTree(child, signal) {
  if (!child) return
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      // The process-group leader (the shell created by spawn(..., { shell: true }))
      // can exit on SIGTERM while a descendant keeps the inherited output pipes
      // open.  The group remains addressable after its leader exits, so always
      // signal the saved pgid instead of treating the leader exit as tree exit.
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error.code !== 'ESRCH' && child.exitCode === null && child.signalCode === null) child.kill(signal)
      return
    }
  }

  if (child.exitCode === null && child.signalCode === null) child.kill(signal)
}

function beginSubprocess(tier, { root, env, outputPipeline, terminationGraceMs, suspendForAttach = false }) {
  const suspendedEntry = suspendForAttach && process.platform !== 'win32'
  const child = suspendedEntry
    ? spawn('/bin/bash', ['-c', 'kill -STOP $$; exec /bin/bash -lc "$1"', 'fsusblog-cgroup-entry', tier.command], {
        cwd: root,
        env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    : spawn(tier.command, {
    cwd: root,
    env,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
      })
  outputPipeline.attach(child.stdout, 'stdout')
  outputPipeline.attach(child.stderr, 'stderr')

  let settled = false
  let budgetExpired = false
  let terminationStarted = false
  const tierBudgetMs = Number.isFinite(Number(tier.budgetMs)) && Number(tier.budgetMs) > 0
    ? Number(tier.budgetMs)
    : null
  let budgetTimer = null
  let escalationTimer = null
  let forcedSettleTimer = null
  let resolvePromise = null

  const closePipes = () => {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.destroy()
    }
  }
  const settle = (result) => {
    if (settled) return
    settled = true
    if (budgetTimer) clearTimeout(budgetTimer)
    if (escalationTimer) clearTimeout(escalationTimer)
    if (forcedSettleTimer) clearTimeout(forcedSettleTimer)
    resolvePromise(result)
  }
  const timeoutResult = () => ({
    code: 124,
    signal: null,
    error: new Error(`bundle budget exceeded (${tierBudgetMs}ms)`)
  })
  const beginTermination = () => {
    if (settled || terminationStarted) return
    terminationStarted = true
    signalProcessTree(child, 'SIGTERM')
    escalationTimer = setTimeout(() => {
      // Do not rely on ChildProcess.close here: a descendant may have survived
      // the shell and still own its inherited stdout/stderr descriptors.
      signalProcessTree(child, 'SIGKILL')
      closePipes()
      const pipeCloseGraceMs = Math.max(25, Math.min(250, terminationGraceMs || 25))
      forcedSettleTimer = setTimeout(() => {
        settle({
          ...(budgetExpired ? timeoutResult() : { code: 1, signal: 'SIGKILL' }),
          logComplete: false,
          logTruncationReason: 'forced-pipe-close-after-sigkill'
        })
      }, pipeCloseGraceMs)
    }, terminationGraceMs)
  }
  const promise = new Promise((resolve) => {
    resolvePromise = resolve
    child.once('error', (error) => {
      closePipes()
      settle({ code: 1, signal: null, error })
    })
    child.once('close', (code, signal) => {
      settle(budgetExpired ? timeoutResult() : { code: code ?? 1, signal })
    })
    if (tierBudgetMs !== null) {
      budgetTimer = setTimeout(() => {
        if (settled) return
        budgetExpired = true
        beginTermination()
      }, tierBudgetMs)
      budgetTimer.unref?.()
    }
  })

  return {
    child,
    promise,
    resume() {
      if (suspendedEntry) child.kill('SIGCONT')
    },
    terminate() {
      beginTermination()
    }
  }
}

function defaultSystemResources() {
  return {
    cpuCount: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    availableMemoryGiB: os.freemem() / (1024 ** 3),
    load1: process.platform === 'win32' ? 0 : os.loadavg()[0]
  }
}

function resourceBudget(resources) {
  const cpuCount = Math.max(1, Number(resources.cpuCount) || 1)
  const load1 = Math.max(0, Number(resources.load1) || 0)
  const explicitCpuUnits = Number(resources.availableCpuUnits)
  return {
    cpuUnits: Number.isFinite(explicitCpuUnits) && explicitCpuUnits > 0
      ? Math.min(cpuCount, explicitCpuUnits)
      : Math.max(1, cpuCount - Math.ceil(load1)),
    memoryGiB: Math.max(0.1, Number(resources.availableMemoryGiB) || 0.1)
  }
}

export function tierResourceUnits(tier) {
  const cpuUnits = Number(tier.cpuUnits)
  const memoryGiB = Number(tier.memoryGiB)
  if (!Number.isFinite(cpuUnits) || cpuUnits <= 0 || !Number.isFinite(memoryGiB) || memoryGiB <= 0) {
    throw new Error(`tier ${tier.id ?? '<unknown>'} has no resolved resource grant`)
  }
  return {
    cpuUnits,
    memoryGiB
  }
}

function activeUsage(activeEntries) {
  return {
    cpuUnits: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).cpuUnits, 0),
    memoryGiB: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).memoryGiB, 0)
  }
}

function criticalPath(tiers, tierResults) {
  const selectedIds = new Set(tiers.map((tier) => tier.id))
  const paths = new Map()
  for (const tier of tiers) {
    const dependencies = tierExecutionDependencies(tier).filter((dependencyId) => selectedIds.has(dependencyId))
    const longestDependency = dependencies
      .map((dependencyId) => paths.get(dependencyId) ?? { durationMs: 0, tierIds: [] })
      .sort((left, right) => right.durationMs - left.durationMs)[0] ?? { durationMs: 0, tierIds: [] }
    paths.set(tier.id, {
      durationMs: longestDependency.durationMs + Math.max(0, Number(tierResults[tier.id]?.durationMs) || 0),
      tierIds: [...longestDependency.tierIds, tier.id]
    })
  }
  return [...paths.values()].sort((left, right) => right.durationMs - left.durationMs)[0] ?? {
    durationMs: 0,
    tierIds: []
  }
}

function intersects(left, right) {
  const rightSet = new Set(right ?? [])
  return (left ?? []).some((item) => rightSet.has(item))
}

function canShareAdmission(tier, admittedEntries, maxParallel) {
  if (admittedEntries.length >= maxParallel) return false
  if (admittedEntries.length > 0 && tier.parallelizable !== true) return false
  if (admittedEntries.some((entry) => entry.tier.parallelizable !== true)) return false
  if (admittedEntries.some((entry) => intersects(tier.exclusiveResources, entry.tier.exclusiveResources))) return false
  if (admittedEntries.some((entry) => (
    (tier.services?.length ?? 0) > 0
    && (entry.tier.services?.length ?? 0) > 0
    && intersects(tier.services, entry.tier.services)
  ))) return false

  const sameClass = admittedEntries.filter((entry) => entry.tier.resourceClass === tier.resourceClass)
  if (sameClass.length >= Math.max(1, Number(tier.maxParallel) || 1)) return false
  if (sameClass.some((entry) => sameClass.length >= Math.max(1, Number(entry.tier.maxParallel) || 1))) return false
  return true
}

function startupMinCpuUnits(tier) {
  return Math.max(1, Math.floor(Number(tier.startupMinCpuUnits ?? tier.minCpuUnits) || 1))
}

function steadyMinCpuUnits(tier) {
  return Math.max(1, Math.floor(Number(tier.minCpuUnits) || 1))
}

function startupMemoryWeight(tier) {
  return Number(tier.startupMemoryWeight ?? tier.memoryWeight)
}

function weightedIntegerAllocation(
  tiers,
  totalUnits,
  minimumForTier = (tier) => tier.minCpuUnits,
  weightForTier = (tier) => tier.cpuWeight
) {
  const minimums = tiers.map((tier) => Math.max(1, Math.floor(Number(minimumForTier(tier)) || 1)))
  const minimumTotal = minimums.reduce((total, value) => total + value, 0)
  if (minimumTotal > totalUnits) return null
  const weights = tiers.map((tier) => Math.max(Number.EPSILON, Number(weightForTier(tier)) || 1))
  const weightTotal = weights.reduce((total, value) => total + value, 0)
  const quotas = weights.map((weight) => totalUnits * weight / weightTotal)
  const values = quotas.map((quota, index) => Math.max(minimums[index], Math.floor(quota)))
  let allocated = values.reduce((total, value) => total + value, 0)
  while (allocated < totalUnits) {
    let selected = 0
    for (let index = 1; index < values.length; index += 1) {
      if (quotas[index] - values[index] > quotas[selected] - values[selected]) selected = index
    }
    values[selected] += 1
    allocated += 1
  }
  while (allocated > totalUnits) {
    let selected = -1
    for (let index = 0; index < values.length; index += 1) {
      if (values[index] <= minimums[index]) continue
      if (selected < 0 || values[index] - quotas[index] > values[selected] - quotas[selected]) selected = index
    }
    if (selected < 0) return null
    values[selected] -= 1
    allocated -= 1
  }
  return new Map(tiers.map((tier, index) => [tier.id, values[index]]))
}

function startupIntegerAllocation(tiers, totalUnits) {
  const startupMinimums = new Map(tiers.map((tier) => [tier.id, startupMinCpuUnits(tier)]))
  let remaining = totalUnits - [...startupMinimums.values()].reduce((total, value) => total + value, 0)
  if (remaining < 0) return null
  for (const tier of [...tiers].sort(startupAdmissionOrder)) {
    const steadyMinimum = Math.max(1, Math.floor(Number(tier.minCpuUnits) || 1))
    const deficit = Math.max(0, steadyMinimum - startupMinimums.get(tier.id))
    const addition = Math.min(remaining, deficit)
    startupMinimums.set(tier.id, startupMinimums.get(tier.id) + addition)
    remaining -= addition
    if (remaining === 0) break
  }
  return weightedIntegerAllocation(
    tiers,
    totalUnits,
    (tier) => startupMinimums.get(tier.id),
    (tier) => tier.cpuWeight
  )
}

function tierPhase(tier) {
  const value = Number(tier.phase)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function applyCheckpointPatch(state, payload) {
  let result = structuredClone(state)
  for (const operation of payload?.operations ?? []) {
    const segments = operation.path
    if (!Array.isArray(segments)) throw new Error('scheduler checkpoint patch path must be an array')
    if (segments.length === 0) {
      if (operation.kind !== 'set') throw new Error('scheduler checkpoint root patch must use set')
      result = structuredClone(operation.value)
      continue
    }
    let parent = result
    for (const segment of segments.slice(0, -1)) {
      if (!parent || typeof parent !== 'object') throw new Error('scheduler checkpoint patch traverses a non-object')
      parent = parent[segment]
    }
    const key = segments.at(-1)
    if (operation.kind === 'set') parent[key] = structuredClone(operation.value)
    else if (operation.kind === 'delete') delete parent[key]
    else if (operation.kind === 'append') {
      if (!Array.isArray(parent[key])) throw new Error('scheduler checkpoint append target must be an array')
      parent[key].push(...structuredClone(operation.values))
    } else {
      throw new Error(`unsupported scheduler checkpoint patch operation: ${operation.kind}`)
    }
  }
  return result
}

function readCheckpoint(checkpointFile) {
  let compatibilityCheckpoint = null
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    compatibilityCheckpoint = checkpoint?.schema === checkpointSchema ? checkpoint : null
  } catch {
    // A compact checkpoint may still recover the compatibility projection.
  }
  const storeRoot = path.join(path.dirname(checkpointFile), 'evidence-store')
  if (!fs.existsSync(storeRoot)) return compatibilityCheckpoint
  let identity = compatibilityCheckpoint
  if (!identity) {
    const compactFile = path.join(storeRoot, 'checkpoints', `${path.basename(path.dirname(checkpointFile))}.json`)
    if (!fs.existsSync(compactFile)) return null
    identity = JSON.parse(fs.readFileSync(compactFile, 'utf8'))
  }
  const store = new RunEvidenceObjectStore({
    root: storeRoot,
    runId: identity.runId,
    sourceState: identity.sourceState
  })
  const recovered = store.recover(applyCheckpointPatch)
  const recoveredCheckpoint = recovered.state?.schema === checkpointSchema ? recovered.state : null
  if (compatibilityCheckpoint
    && (!recoveredCheckpoint
      || Number(compatibilityCheckpoint.revision) >= Number(recoveredCheckpoint.revision))) {
    return compatibilityCheckpoint
  }
  return recoveredCheckpoint
}

function resumeTierCandidates(previous, tierIds) {
  const candidates = {}
  if (!previous) return candidates

  const retainSuccessful = (tierId, value, fallbackSourceState) => {
    if (!tierIds.has(tierId)) return
    const candidate = value?.schema === 'fsusblog.test-matrix.resume-candidate.v1'
      ? value
      : {
          schema: 'fsusblog.test-matrix.resume-candidate.v1',
          sourceState: value?.reuseSourceState ?? fallbackSourceState ?? null,
          tierResult: value
        }
    if (candidate.tierResult?.status === 'success') candidates[tierId] = candidate
    else delete candidates[tierId]
  }

  for (const [tierId, candidate] of Object.entries(previous.resumeCandidates ?? {})) {
    retainSuccessful(tierId, candidate, previous.sourceState)
  }
  // Results recorded by the most recent attempt are newer than carried
  // candidates. A failure/cancellation therefore retires any older candidate
  // for the same tier instead of allowing a later resume to hide that result.
  for (const [tierId, result] of Object.entries(previous.tiers ?? {})) {
    retainSuccessful(tierId, result, previous.sourceState)
  }
  return candidates
}

function checkpointPatch(before, after) {
  const operations = []
  const visit = (left, right, currentPath) => {
    if (Object.is(left, right)) return
    if (Array.isArray(left) && Array.isArray(right)) {
      const prefixMatches = left.length <= right.length
        && left.every((value, index) => JSON.stringify(stableValue(value)) === JSON.stringify(stableValue(right[index])))
      if (prefixMatches) {
        if (right.length > left.length) {
          operations.push({ kind: 'append', path: currentPath, values: right.slice(left.length) })
        }
        return
      }
      operations.push({ kind: 'set', path: currentPath, value: right })
      return
    }
    const leftObject = left && typeof left === 'object'
    const rightObject = right && typeof right === 'object'
    if (!leftObject || !rightObject || Array.isArray(left) || Array.isArray(right)) {
      operations.push({ kind: 'set', path: currentPath, value: right })
      return
    }
    for (const key of Object.keys(left)) {
      if (!Object.hasOwn(right, key)) operations.push({ kind: 'delete', path: [...currentPath, key] })
    }
    for (const key of Object.keys(right)) {
      if (!Object.hasOwn(left, key)) operations.push({ kind: 'set', path: [...currentPath, key], value: right[key] })
      else visit(left[key], right[key], [...currentPath, key])
    }
  }
  visit(before, after, [])
  return { operations }
}

function schedulerPersistence(checkpointFile, checkpoint) {
  const key = path.resolve(checkpointFile)
  let persistence = checkpointPersistence.get(key)
  if (persistence
    && (!fs.existsSync(persistence.store.root)
      || persistence.store.runId !== checkpoint.runId
      || !sameCheckpointSource(persistence.store.sourceState, checkpoint.sourceState))) {
    checkpointPersistence.delete(key)
    persistence = null
  }
  if (!persistence) {
    const store = new RunEvidenceObjectStore({
      root: path.join(path.dirname(checkpointFile), 'evidence-store'),
      runId: checkpoint.runId,
      sourceState: checkpoint.sourceState
    })
    let previous = null
    try {
      previous = store.recover(applyCheckpointPatch).state
    } catch (error) {
      if (fs.existsSync(path.join(store.checkpointsDirectory, `${checkpoint.runId}.json`))) throw error
    }
    persistence = {
      store,
      previous,
      compatibilityWrites: fs.existsSync(checkpointFile) ? 1 : 0,
      compatibilityBytesWritten: fs.existsSync(checkpointFile) ? fs.statSync(checkpointFile).size : 0
    }
    checkpointPersistence.set(key, persistence)
  }
  return persistence
}

function writeCheckpoint(checkpointFile, checkpoint, {
  boundary = false,
  stage = null,
  eventType = 'scheduler-state-updated',
  tier = null,
  step = null
} = {}) {
  checkpoint.revision = Math.max(0, Number(checkpoint.revision) || 0) + 1
  checkpoint.updatedAt = new Date().toISOString()
  checkpoint.completedTiers = Object.entries(checkpoint.tiers)
    .filter(([, value]) => value.status === 'success')
    .map(([tierId]) => tierId)
    .sort()
  const persistence = schedulerPersistence(checkpointFile, checkpoint)
  const patch = checkpointPatch(persistence.previous, checkpoint)
  const event = persistence.store.appendJournalEvent({
    eventType,
    tier,
    step,
    status: checkpoint.status,
    payload: patch
  })
  persistence.previous = structuredClone(checkpoint)
  if (!boundary) return
  persistence.store.writeCompactCheckpoint({
    stage: stage ?? (checkpoint.status === 'running' ? 'run-start' : 'run-complete'),
    state: checkpoint,
    lastSequence: event.sequence,
    retention: {
      activeRun: checkpoint.status === 'running',
      releaseBinding: checkpoint.status === 'success'
    }
  })
  const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`
  const temporaryFile = `${checkpointFile}.next-${process.pid}`
  fs.writeFileSync(temporaryFile, serialized)
  fs.renameSync(temporaryFile, checkpointFile)
  persistence.compatibilityWrites += 1
  persistence.compatibilityBytesWritten += Buffer.byteLength(serialized)
  if (checkpoint.status !== 'running') {
    const metrics = {
      ...persistence.store.metrics(),
      schedulerCompatibilityCheckpointWrites: persistence.compatibilityWrites,
      schedulerCompatibilityCheckpointBytesWritten: persistence.compatibilityBytesWritten
    }
    const metricsFile = path.join(path.dirname(checkpointFile), 'evidence-storage-metrics.json')
    const metricsTemporary = `${metricsFile}.next-${process.pid}`
    fs.writeFileSync(metricsTemporary, `${JSON.stringify(metrics, null, 2)}\n`)
    fs.renameSync(metricsTemporary, metricsFile)
  }
}

export function markCheckpointWallClockTimeout(checkpointFile, failure, finishedAt = new Date().toISOString()) {
  const checkpoint = readCheckpoint(checkpointFile)
  if (!checkpoint) throw new Error(`cannot mark missing scheduler checkpoint timed out: ${checkpointFile}`)
  checkpoint.status = 'failure'
  checkpoint.timedOut = true
  checkpoint.failure ??= failure
  checkpoint.failurePoint ??= failure.tierId ?? checkpoint.targetTierId
  if (!(checkpoint.failures ?? []).some((entry) => (
    entry?.tierId === failure.tierId && entry?.reason === failure.reason
  ))) {
    checkpoint.failures = [...(checkpoint.failures ?? []), failure]
  }
  checkpoint.finishedAt = finishedAt
  writeCheckpoint(checkpointFile, checkpoint, {
    boundary: true,
    stage: 'wall-clock-timeout',
    eventType: 'run-timed-out',
    tier: failure.tierId ?? checkpoint.targetTierId,
    step: 'scheduler'
  })
  return checkpoint
}

function createEarlyFailureCheckpoint(expectedRunId, failure, options) {
  if (typeof options?.targetTierId !== 'string' || !options.targetTierId) {
    throw new Error('early scheduler checkpoint requires targetTierId')
  }
  if (typeof options?.sourceState?.commit !== 'string'
    || typeof options?.sourceState?.worktreeFingerprint !== 'string') {
    throw new Error('early scheduler checkpoint requires sourceState')
  }
  const startedAt = options.startedAt ?? new Date().toISOString()
  return {
    schema: checkpointSchema,
    runId: expectedRunId,
    targetTierId: options.targetTierId,
    mode: options.mode ?? 'fresh',
    authoritative: (options.mode ?? 'fresh') === 'fresh',
    status: 'failure',
    startedAt,
    updatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    sourceState: structuredClone(options.sourceState),
    ...(options.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
    completedTiers: [],
    tiers: {},
    failure,
    failurePoint: failure.tierId ?? options.targetTierId,
    failures: [failure]
  }
}

function appendCheckpointFailure(checkpoint, failure) {
  checkpoint.status = 'failure'
  checkpoint.failure ??= failure
  checkpoint.failurePoint ??= failure.tierId ?? checkpoint.targetTierId
  checkpoint.failures ??= []
  if (!checkpoint.failures.some((entry) => (
    entry?.tierId === failure.tierId && entry?.reason === failure.reason
  ))) {
    checkpoint.failures.push(failure)
  }
  checkpoint.finishedAt = new Date().toISOString()
}

function readOrCreateFailureCheckpoint(checkpointFile, expectedRunId, failure, options) {
  const checkpoint = readCheckpoint(checkpointFile)
  if (checkpoint) {
    if (checkpoint.runId !== expectedRunId) {
      throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFile}`)
    }
    return checkpoint
  }
  if (failure === null) {
    throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFile}`)
  }
  fs.mkdirSync(path.dirname(checkpointFile), { recursive: true })
  return createEarlyFailureCheckpoint(expectedRunId, failure, options)
}

export function recordCheckpointFailure(checkpointFileValue, expectedRunId, failure, options = {}) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runDirectory = path.dirname(checkpointFile)
  const runsRoot = path.dirname(runDirectory)
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    const checkpoint = readOrCreateFailureCheckpoint(
      checkpointFile,
      expectedRunId,
      failure,
      options)
    appendCheckpointFailure(checkpoint, failure)
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: options.stage ?? 'run-failed',
      eventType: options.eventType ?? 'run-failed',
      tier: failure.tierId ?? checkpoint.targetTierId,
      step: options.step ?? 'scheduler'
    })
    return checkpoint
  } finally {
    releaseLock()
  }
}

export function recordCheckpointRuntimeCleanup(
  checkpointFileValue,
  expectedRunId,
  runtimeCleanup,
  failure = null,
  options = {}
) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runDirectory = path.dirname(checkpointFile)
  const runsRoot = path.dirname(runDirectory)
  const phases = Object.entries(runtimeCleanup ?? {})
  if (phases.length === 0 || phases.some(([phase, evidence]) => (
    !['preflight', 'postflight'].includes(phase)
    || typeof evidence?.path !== 'string'
    || !evidence.path
    || !['complete', 'blocked'].includes(evidence.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(evidence.digest ?? ''))
  ))) {
    throw new Error('checkpoint runtime cleanup evidence is invalid')
  }
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    const checkpoint = readOrCreateFailureCheckpoint(
      checkpointFile,
      expectedRunId,
      failure,
      options)
    for (const [phase, evidence] of phases) {
      if (checkpoint.runtimeCleanup?.[phase]?.status === 'blocked'
        && evidence.status === 'complete') {
        throw new Error(`checkpoint runtime cleanup ${phase} cannot upgrade blocked evidence`)
      }
    }
    checkpoint.runtimeCleanup = structuredClone(runtimeCleanup)
    if (failure !== null) {
      appendCheckpointFailure(checkpoint, failure)
    }
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: failure === null ? 'runtime-cleanup-recorded' : 'runtime-cleanup-blocked',
      eventType: failure === null ? 'runtime-cleanup-recorded' : 'runtime-cleanup-blocked',
      tier: checkpoint.targetTierId,
      step: 'runtime-cleanup'
    })
    return checkpoint
  } finally {
    releaseLock()
  }
}

function runtimeCleanupAttemptLedger(checkpoint, {
  expectedRunId,
  targetTierId,
  schedulerRunId,
  invocationId,
  repositoryRoot
}) {
  if (!checkpoint
    || checkpoint.runId !== expectedRunId
    || checkpoint.targetTierId !== targetTierId) {
    throw new Error('runtime cleanup attempt ledger checkpoint identity is invalid')
  }
  const ledger = checkpoint.runtimeCleanupAttemptLedger
  if (!ledger
    || ledger.schema !== runtimeCleanupAttemptLedgerSchema
    || ledger.schedulerRunId !== schedulerRunId
    || ledger.invocationId !== invocationId
    || ledger.repositoryRoot !== repositoryRoot
    || !['complete', 'blocked'].includes(ledger.status)
    || !Array.isArray(ledger.attempts)) {
    throw new Error('runtime cleanup attempt ledger identity is invalid')
  }
  if (ledger.attempts.some((attempt) => (
    !/^[a-f0-9]{32}$/u.test(String(attempt?.attemptId ?? ''))
    || attempt.phase !== 'preflight'
    || !['complete', 'blocked'].includes(attempt.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt.digest ?? ''))
    || typeof attempt.receiptFile !== 'string'
    || !path.isAbsolute(attempt.receiptFile)
  ))) {
    throw new Error('runtime cleanup attempt ledger contains invalid evidence')
  }
  if (new Set(ledger.attempts.map((attempt) => attempt.attemptId)).size !== ledger.attempts.length) {
    throw new Error('runtime cleanup attempt ledger contains duplicate attempts')
  }
  const blockedAttempts = ledger.attempts.filter((attempt) => attempt.status === 'blocked')
  if ((ledger.status === 'blocked') !== (blockedAttempts.length > 0)
    || (ledger.status === 'blocked'
      && ledger.blockedAttemptId !== blockedAttempts[0].attemptId)
    || (ledger.status === 'complete' && ledger.blockedAttemptId !== null)) {
    throw new Error('runtime cleanup attempt ledger sealed status is invalid')
  }
  return ledger
}

export function readRuntimeCleanupAttemptLedger(
  checkpointFileValue,
  expectedRunId,
  identity
) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runsRoot = path.dirname(path.dirname(checkpointFile))
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    const checkpoint = readCheckpoint(checkpointFile)
    if (!checkpoint) {
      return {
        schema: runtimeCleanupAttemptLedgerSchema,
        schedulerRunId: identity.schedulerRunId,
        invocationId: identity.invocationId,
        repositoryRoot: identity.repositoryRoot,
        status: 'complete',
        blockedAttemptId: null,
        attempts: [],
        checkpointRevision: 0
      }
    }
    const ledger = runtimeCleanupAttemptLedger(checkpoint, {
      expectedRunId,
      ...identity
    })
    return {
      ...structuredClone(ledger),
      checkpointRevision: checkpoint.revision
    }
  } finally {
    releaseLock()
  }
}

export function recordRuntimeCleanupAttempt(
  checkpointFileValue,
  expectedRunId,
  identity,
  attempt
) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runsRoot = path.dirname(path.dirname(checkpointFile))
  if (typeof identity?.targetTierId !== 'string' || !identity.targetTierId
    || typeof identity?.schedulerRunId !== 'string' || !identity.schedulerRunId
    || typeof identity?.invocationId !== 'string' || !identity.invocationId
    || typeof identity?.repositoryRoot !== 'string' || !path.isAbsolute(identity.repositoryRoot)
    || typeof identity?.sourceState?.commit !== 'string'
    || typeof identity?.sourceState?.worktreeFingerprint !== 'string') {
    throw new Error('runtime cleanup attempt ledger identity is incomplete')
  }
  if (!/^[a-f0-9]{32}$/u.test(String(attempt?.attemptId ?? ''))
    || attempt.phase !== 'preflight'
    || !['complete', 'blocked'].includes(attempt.status)
    || !/^sha256:[a-f0-9]{64}$/u.test(String(attempt.digest ?? ''))
    || typeof attempt.receiptFile !== 'string'
    || !path.isAbsolute(attempt.receiptFile)) {
    throw new Error('runtime cleanup attempt evidence is invalid')
  }
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    let checkpoint = readCheckpoint(checkpointFile)
    if (!checkpoint) {
      const startedAt = attempt.startedAt ?? new Date().toISOString()
      checkpoint = {
        schema: checkpointSchema,
        runId: expectedRunId,
        targetTierId: identity.targetTierId,
        mode: 'fresh',
        authoritative: true,
        status: 'running',
        startedAt,
        updatedAt: startedAt,
        sourceState: structuredClone(identity.sourceState),
        completedTiers: [],
        tiers: {},
        failure: null,
        failures: [],
        runtimeCleanupAttemptLedger: {
          schema: runtimeCleanupAttemptLedgerSchema,
          schedulerRunId: identity.schedulerRunId,
          invocationId: identity.invocationId,
          repositoryRoot: identity.repositoryRoot,
          status: 'complete',
          blockedAttemptId: null,
          attempts: []
        }
      }
      fs.mkdirSync(path.dirname(checkpointFile), { recursive: true })
    }
    const ledger = runtimeCleanupAttemptLedger(checkpoint, {
      expectedRunId,
      ...identity
    })
    const duplicate = ledger.attempts.find((entry) => entry.attemptId === attempt.attemptId)
    if (duplicate) {
      if (JSON.stringify(stableValue(duplicate)) !== JSON.stringify(stableValue(attempt))) {
        throw new Error(`runtime cleanup attempt ${attempt.attemptId} was already sealed with different evidence`)
      }
      return {
        ...structuredClone(ledger),
        checkpointRevision: checkpoint.revision
      }
    }
    ledger.attempts.push(structuredClone(attempt))
    const blockedAttempt = ledger.attempts.find((entry) => entry.status === 'blocked') ?? null
    ledger.status = blockedAttempt ? 'blocked' : 'complete'
    ledger.blockedAttemptId = blockedAttempt?.attemptId ?? null
    checkpoint.status = blockedAttempt ? 'failure' : 'success'
    checkpoint.finishedAt = attempt.finishedAt ?? new Date().toISOString()
    if (blockedAttempt) {
      checkpoint.failure = {
        tierId: identity.targetTierId,
        exitCode: 1,
        reason: `Production Fresh runtime cleanup attempt ${blockedAttempt.attemptId} is blocked`
      }
      checkpoint.failurePoint = identity.targetTierId
      checkpoint.failures = [checkpoint.failure]
    } else {
      checkpoint.failure = null
      delete checkpoint.failurePoint
      checkpoint.failures = []
    }
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: blockedAttempt
        ? 'runtime-cleanup-attempt-blocked'
        : 'runtime-cleanup-attempt-complete',
      eventType: 'runtime-cleanup-attempt-sealed',
      tier: identity.targetTierId,
      step: 'runtime-cleanup'
    })
    return {
      ...structuredClone(ledger),
      checkpointRevision: checkpoint.revision
    }
  } finally {
    releaseLock()
  }
}

export function recordCheckpointResidentLeaseCleanup(
  checkpointFileValue,
  expectedRunId,
  updateCheckpoint
) {
  if (typeof updateCheckpoint !== 'function') {
    throw new Error('resident lease cleanup checkpoint update must be a function')
  }
  const checkpointFile = path.resolve(checkpointFileValue)
  const runsRoot = path.dirname(path.dirname(checkpointFile))
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    const checkpoint = readCheckpoint(checkpointFile)
    if (!checkpoint || checkpoint.runId !== expectedRunId) {
      throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFileValue}`)
    }
    const sourceState = structuredClone(checkpoint.sourceState)
    const updated = updateCheckpoint(checkpoint) ?? checkpoint
    if (updated !== checkpoint
      || updated.runId !== expectedRunId
      || updated.schema !== checkpointSchema
      || !sameCheckpointSource(updated.sourceState, sourceState)) {
      throw new Error('resident lease cleanup may only mutate the locked scheduler checkpoint')
    }
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: 'resident-lease-cleanup-recorded',
      eventType: 'resident-lease-cleanup-recorded',
      tier: checkpoint.targetTierId,
      step: 'resident-resource-leases'
    })
    return checkpoint
  } finally {
    releaseLock()
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sameCheckpointSource(left, right) {
  return String(left?.commit ?? '') === String(right?.commit ?? '')
    && String(left?.worktreeFingerprint ?? '') === String(right?.worktreeFingerprint ?? '')
}

function bundleSummaryOutput(checkpoint, root, bundleId) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(String(bundleId ?? ''))) {
    throw new Error(`logicalTierProjection physicalBundleId is invalid: ${String(bundleId)}`)
  }
  const physicalTierId = `local-${checkpoint.targetTierId}-${bundleId}`
  const physical = checkpoint.tiers?.[physicalTierId]
  if (physical?.status !== 'success' || physical?.reused !== false) {
    throw new Error(`logicalTierProjection physical bundle ${physicalTierId} must be fresh and successful`)
  }
  const summaryPath = `.tmp/local-${checkpoint.targetTierId}/${bundleId}/summary.json`
  const recordedDigest = physical.outputs?.[summaryPath]
  if (typeof recordedDigest !== 'string' || !recordedDigest.startsWith('file:')) {
    throw new Error(`checkpoint output has no recorded digest for ${summaryPath}`)
  }
  const absoluteSummary = path.resolve(root, summaryPath)
  if (!absoluteSummary.startsWith(`${root}${path.sep}`) || !fs.existsSync(absoluteSummary)) {
    throw new Error(`checkpoint bundle summary is missing: ${summaryPath}`)
  }
  const currentDigest = outputPathFingerprint(absoluteSummary)
  if (recordedDigest !== currentDigest) {
    throw new Error(`checkpoint output digest does not match current bundle summary: ${summaryPath}`)
  }
  let summary
  try {
    summary = JSON.parse(fs.readFileSync(absoluteSummary, 'utf8'))
  } catch (error) {
    throw new Error(`checkpoint bundle summary is invalid JSON: ${summaryPath} (${error.message})`)
  }
  if (!plainObject(summary) || !plainObject(summary.members)) {
    throw new Error(`checkpoint bundle summary has no member evidence: ${summaryPath}`)
  }
  return { physicalTierId, summaryPath, summary }
}

function validateCheckpointBundleSummaries(checkpoint, root) {
  const prefix = `local-${checkpoint.targetTierId}-`
  const physicalTierIds = Object.keys(checkpoint.tiers ?? {})
    .filter((tierId) => tierId.startsWith(prefix))
    .sort()
  if (physicalTierIds.length === 0) {
    throw new Error(`checkpoint ${checkpoint.runId} has no local physical bundle tiers`)
  }
  for (const physicalTierId of physicalTierIds) {
    bundleSummaryOutput(checkpoint, root, physicalTierId.slice(prefix.length))
  }
}

function sameSortedStrings(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}

function validateArtifactSubstitutionProofs(entry, tierId, artifactTable = null) {
  if (!plainObject(entry.artifactSubstitutionProofs)) {
    throw new Error(`logicalTierProjection entry ${tierId} artifactSubstitutionProofs must be an object`)
  }
  if (!Array.isArray(entry.matrixRuntimePaths)
    || entry.matrixRuntimePaths.some((declaration) => typeof declaration !== 'string' || !declaration.trim())
    || new Set(entry.matrixRuntimePaths).size !== entry.matrixRuntimePaths.length
    || entry.matrixRuntimePaths.some((declaration, index) => index > 0 && entry.matrixRuntimePaths[index - 1] > declaration)) {
    throw new Error(`logicalTierProjection entry ${tierId} matrixRuntimePaths must be sorted unique non-empty strings`)
  }
  const canonicalPaths = Object.keys(entry.artifactSubstitutionProofs).sort()
  const expectedProofMode = canonicalPaths.length > 0
    ? 'matrix-runtime-artifacts-with-substitutions'
    : (entry.matrixRuntimePaths.length > 0 ? 'matrix-runtime-artifacts' : 'command-log-and-test-ids')
  if (entry.artifactProofMode !== expectedProofMode) {
    throw new Error(`logicalTierProjection entry ${tierId} artifactProofMode must be ${expectedProofMode}`)
  }
  for (const declaration of entry.matrixRuntimePaths) {
    if (!Object.hasOwn(entry.artifactDigests, declaration)) {
      throw new Error(`logicalTierProjection entry ${tierId} is missing matrix runtime digest: ${declaration}`)
    }
  }
  for (const canonicalPath of canonicalPaths) {
    if (!entry.matrixRuntimePaths.includes(canonicalPath)) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution canonical path is not declared: ${canonicalPath}`)
    }
    const proof = entry.artifactSubstitutionProofs[canonicalPath]
    if (!plainObject(proof)) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution proof must be an object: ${canonicalPath}`)
    }
    const expectedFields = artifactTable
      ? ['actualDigests', 'actualPaths', 'actualRefs', 'canonicalArtifactRef', 'canonicalDigest', 'canonicalPath']
      : ['actualDigests', 'actualPaths', 'canonicalDigest', 'canonicalPath']
    if (!sameSortedStrings(Object.keys(proof).sort(), expectedFields)) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution proof has unexpected fields: ${canonicalPath}`)
    }
    if (proof.canonicalPath !== canonicalPath) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution canonicalPath must match its key: ${canonicalPath}`)
    }
    if (!Array.isArray(proof.actualPaths)
      || proof.actualPaths.length === 0
      || proof.actualPaths.some((actualPath) => typeof actualPath !== 'string' || !actualPath.trim())
      || new Set(proof.actualPaths).size !== proof.actualPaths.length
      || proof.actualPaths.some((actualPath, index) => index > 0 && proof.actualPaths[index - 1] > actualPath)
      || proof.actualPaths.some((actualPath) => canonicalPaths.includes(actualPath))) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution actualPaths are invalid: ${canonicalPath}`)
    }
    if (!plainObject(proof.actualDigests)
      || !sameSortedStrings(Object.keys(proof.actualDigests).sort(), proof.actualPaths)) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution actualDigests must exactly match actualPaths: ${canonicalPath}`)
    }
    for (const actualPath of proof.actualPaths) {
      const actualDigest = proof.actualDigests[actualPath]
      if (!/^sha256:[a-f0-9]{64}$/u.test(String(actualDigest ?? ''))) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution actual digest must be sha256: ${actualPath}`)
      }
      if (entry.artifactDigests[actualPath] !== actualDigest) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution actual digest must match artifactDigests: ${actualPath}`)
      }
      if (artifactTable && proof.actualRefs?.[actualPath] !== entry.artifactRefs?.[actualPath]) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution actual ref must match artifactRefs: ${actualPath}`)
      }
    }
    const bindingDigest = artifactSubstitutionBindingDigest(canonicalPath, proof.actualDigests)
    if (proof.canonicalDigest !== bindingDigest) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution canonicalDigest is invalid: ${canonicalPath}`)
    }
    if (entry.artifactDigests[canonicalPath] !== bindingDigest) {
      throw new Error(`logicalTierProjection entry ${tierId} substitution canonical digest must match artifactDigests: ${canonicalPath}`)
    }
    if (artifactTable) {
      if (!plainObject(proof.actualRefs)
        || !sameSortedStrings(Object.keys(proof.actualRefs).sort(), proof.actualPaths)) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution actualRefs must exactly match actualPaths: ${canonicalPath}`)
      }
      if (proof.canonicalArtifactRef !== entry.artifactRefs?.[canonicalPath]) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution canonical ref must match artifactRefs: ${canonicalPath}`)
      }
      const substitutionRecord = artifactTable.artifacts?.[proof.canonicalArtifactRef]
      if (!substitutionRecord || substitutionRecord.pathType !== 'substitution'
        || substitutionRecord.digest !== bindingDigest
        || fingerprint(substitutionRecord.actualArtifactRefs) !== fingerprint(proof.actualRefs)) {
        throw new Error(`logicalTierProjection entry ${tierId} substitution artifact ref is invalid: ${canonicalPath}`)
      }
    }
  }
  return new Set(canonicalPaths)
}

function validateProjectionEntry(entry, tierId, projection, checkpoint, root, artifactTable = null) {
  if (!plainObject(entry)) throw new Error(`logicalTierProjection entry ${tierId} must be an object`)
  if (!tierId || entry.tierId !== tierId) {
    throw new Error(`logicalTierProjection entry ${tierId} tierId must match its key`)
  }
  if (!['executed', 'summary-only'].includes(entry.evidenceKind)) {
    throw new Error(`logicalTierProjection entry ${tierId} evidenceKind is invalid`)
  }
  const summaryOnly = entry.evidenceKind === 'summary-only'
  const expectedStatus = summaryOnly ? 'collected-blocked' : 'success'
  const expectedSource = summaryOnly ? 'external-environment' : 'fresh'
  if (entry.status !== expectedStatus) {
    throw new Error(`logicalTierProjection entry ${tierId} status must be ${expectedStatus}`)
  }
  if (entry.executionSource !== expectedSource) {
    throw new Error(`logicalTierProjection entry ${tierId} executionSource must be ${expectedSource}`)
  }
  if (!Array.isArray(entry.testIds)
    || entry.testIds.some((testId) => typeof testId !== 'string' || !testId.trim())
    || new Set(entry.testIds).size !== entry.testIds.length
    || entry.testIds.some((testId, index) => index > 0 && entry.testIds[index - 1] > testId)) {
    throw new Error(`logicalTierProjection entry ${tierId} testIds must be sorted unique non-empty strings`)
  }
  if ((!summaryOnly && entry.testIds.length === 0) || (summaryOnly && entry.testIds.length !== 0)) {
    throw new Error(`logicalTierProjection entry ${tierId} testIds do not match its evidenceKind`)
  }
  if (!plainObject(entry.artifactDigests) || Object.keys(entry.artifactDigests).length === 0) {
    throw new Error(`logicalTierProjection entry ${tierId} artifactDigests must be a non-empty object`)
  }
  if (artifactTable) validateArtifactRefs(entry.artifactDigests, entry.artifactRefs, artifactTable)
  const sealedBundle = summaryOnly
    ? null
    : bundleSummaryOutput(checkpoint, root, entry.physicalBundleId)
  const sealedMember = sealedBundle?.summary?.members?.[tierId]
  if (!summaryOnly && !plainObject(sealedMember)) {
    throw new Error(`logicalTierProjection entry ${tierId} has no sealed member evidence in ${sealedBundle.summaryPath}`)
  }
  const substitutionCanonicalPaths = summaryOnly
    ? new Set()
    : validateArtifactSubstitutionProofs(entry, tierId, artifactTable)
  for (const [artifactPath, digest] of Object.entries(entry.artifactDigests)) {
    if (!artifactPath.trim() || path.isAbsolute(artifactPath) || artifactPath === '..' || artifactPath.startsWith('../')) {
      throw new Error(`logicalTierProjection entry ${tierId} artifact digest path is invalid`)
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(String(digest))) {
      throw new Error(`logicalTierProjection entry ${tierId} artifactDigests must contain sha256 digests`)
    }
    let currentDigest
    if (substitutionCanonicalPaths.has(artifactPath)) {
      currentDigest = digest
    } else if (summaryOnly && !artifactTable) {
      const absoluteArtifact = path.resolve(root, artifactPath)
      if (artifactPath.includes('*')
        || artifactPath.includes('?')
        || !absoluteArtifact.startsWith(`${root}${path.sep}`)
        || !fs.existsSync(absoluteArtifact)
        || !fs.lstatSync(absoluteArtifact).isFile()
        || fs.lstatSync(absoluteArtifact).isSymbolicLink()) {
        throw new Error(`logicalTierProjection entry ${tierId} artifact is missing or invalid: ${artifactPath}`)
      }
      currentDigest = `sha256:${sha256(fs.readFileSync(absoluteArtifact))}`
    } else if (summaryOnly) {
      currentDigest = artifactTable.artifacts[entry.artifactRefs[artifactPath]].digest
    } else {
      currentDigest = sealedMember.artifactDigests?.[artifactPath]
    }
    if (currentDigest !== digest) {
      throw new Error(`logicalTierProjection entry ${tierId} artifact digest does not match: ${artifactPath}`)
    }
  }
  if (summaryOnly) {
    if (entry.physicalBundleId !== null) {
      throw new Error(`logicalTierProjection entry ${tierId} physicalBundleId must be null`)
    }
    if (entry.durationMs !== null) {
      throw new Error(`logicalTierProjection entry ${tierId} durationMs must be null`)
    }
  } else {
    if (!Number.isFinite(entry.durationMs) || entry.durationMs < 0) {
      throw new Error(`logicalTierProjection entry ${tierId} durationMs must be non-negative`)
    }
    const sealedFields = {
      status: sealedMember.status,
      durationMs: Number(sealedMember.durationMs),
      testIds: [...(sealedMember.testIds ?? [])].sort(),
      artifactProofMode: sealedMember.artifactProofMode,
      matrixRuntimePaths: [...(sealedMember.matrixRuntimePaths ?? [])],
      artifactSubstitutionProofs: sealedMember.artifactSubstitutionProofs,
      artifactDigests: sealedMember.artifactDigests,
      ...(artifactTable ? { artifactRefs: sealedMember.artifactRefs } : {})
    }
    const projectedFields = {
      status: entry.status,
      durationMs: entry.durationMs,
      testIds: entry.testIds,
      artifactProofMode: entry.artifactProofMode,
      matrixRuntimePaths: entry.matrixRuntimePaths,
      artifactSubstitutionProofs: entry.artifactSubstitutionProofs,
      artifactDigests: entry.artifactDigests,
      ...(artifactTable ? { artifactRefs: entry.artifactRefs } : {})
    }
    if (fingerprint(projectedFields) !== fingerprint(sealedFields)) {
      throw new Error(`logicalTierProjection entry ${tierId} does not match sealed bundle member evidence`)
    }
  }
  if (!projection.logicalTierIds.includes(tierId)) {
    throw new Error(`logicalTierProjection entry ${tierId} is not declared in logicalTierIds`)
  }
}

function validateCheckpointEvidence(checkpoint, evidence, root) {
  if (!plainObject(evidence)) {
    throw new Error('checkpoint evidence must be an object')
  }
  const supportedFields = new Set(['logicalTierProjection'])
  for (const field of Object.keys(evidence)) {
    if (!supportedFields.has(field)) throw new Error(`unsupported checkpoint evidence field: ${field}`)
  }
  const projection = evidence.logicalTierProjection
  if (!plainObject(projection) || projection.schema !== 'fsusblog.local-profile-projection.v1') {
    throw new Error('logicalTierProjection must use schema fsusblog.local-profile-projection.v1')
  }
  if (projection.runId !== checkpoint.runId) {
    throw new Error(`logicalTierProjection run ${projection.runId} does not match checkpoint run ${checkpoint.runId}`)
  }
  if (projection.executionSource !== 'fresh') {
    throw new Error('logicalTierProjection executionSource must be fresh')
  }
  if (projection.profileId !== checkpoint.targetTierId || projection.status !== 'success') {
    throw new Error('logicalTierProjection profileId/status must match a successful checkpoint target')
  }
  let artifactTable = null
  if (projection.artifactDigestTable !== undefined) {
    const descriptor = projection.artifactDigestTable
    if (!plainObject(descriptor) || typeof descriptor.path !== 'string'
      || path.isAbsolute(descriptor.path) || descriptor.path === '..' || descriptor.path.startsWith('../')) {
      throw new Error('logicalTierProjection artifactDigestTable descriptor is invalid')
    }
    artifactTable = readAndValidateArtifactDigestTable(path.resolve(root, descriptor.path), {
      root,
      runId: checkpoint.runId,
      sourceState: checkpoint.sourceState,
      expectedContentDigest: descriptor.contentDigest
    })
    if (descriptor.schema !== artifactTable.schema
      || descriptor.runId !== artifactTable.runId
      || descriptor.sourceState?.commit !== artifactTable.sourceState?.commit
      || descriptor.sourceState?.worktreeFingerprint !== artifactTable.sourceState?.worktreeFingerprint
      || descriptor.artifactCount !== Object.keys(artifactTable.artifacts ?? {}).length) {
      throw new Error('logicalTierProjection artifactDigestTable descriptor does not match its table')
    }
  }
  if (!projection.entries || typeof projection.entries !== 'object' || Array.isArray(projection.entries)) {
    throw new Error('logicalTierProjection entries must be an object')
  }
  const entryIds = Object.keys(projection.entries).sort()
  if (!Number.isInteger(projection.logicalTierCount) || projection.logicalTierCount !== entryIds.length) {
    throw new Error('logicalTierProjection logicalTierCount must match its entries')
  }
  if (!Array.isArray(projection.logicalTierIds)
    || projection.logicalTierIds.some((tierId) => typeof tierId !== 'string' || !tierId.trim())
    || new Set(projection.logicalTierIds).size !== projection.logicalTierIds.length
    || projection.logicalTierIds.some((tierId, index) => index > 0 && projection.logicalTierIds[index - 1] > tierId)) {
    throw new Error('logicalTierProjection logicalTierIds must be sorted unique non-empty strings')
  }
  const declaredTierIds = projection.logicalTierIds
  if (declaredTierIds.length !== entryIds.length
    || declaredTierIds.some((tierId, index) => tierId !== entryIds[index])) {
    throw new Error('logicalTierProjection logicalTierIds must exactly match its entries')
  }
  const summaryOnlyTierCount = Object.values(projection.entries)
    .filter((entry) => entry?.evidenceKind === 'summary-only').length
  if (!Number.isInteger(projection.summaryOnlyTierCount)
    || !Number.isInteger(projection.executedTierCount)
    || projection.summaryOnlyTierCount !== summaryOnlyTierCount
    || projection.executedTierCount !== entryIds.length - summaryOnlyTierCount) {
    throw new Error('logicalTierProjection executed/summary-only counts must match its entries')
  }
  if (String(projection.sourceState?.commit ?? '') !== String(checkpoint.sourceState?.commit ?? '')
    || String(projection.sourceState?.worktreeFingerprint ?? '') !== String(checkpoint.sourceState?.worktreeFingerprint ?? '')) {
    throw new Error('logicalTierProjection sourceState must match the checkpoint')
  }
  for (const tierId of entryIds) {
    validateProjectionEntry(projection.entries[tierId], tierId, projection, checkpoint, root, artifactTable)
  }
}

async function validateCurrentCheckpointSource(checkpoint, root, snapshotWorktree) {
  const snapshot = await (snapshotWorktree ?? (() => snapshotGitWorktree(root)))()
  const current = {
    commit: gitHead(root),
    worktreeFingerprint: snapshot?.fingerprint
  }
  if (!String(current.worktreeFingerprint ?? '').trim() || !sameCheckpointSource(current, checkpoint.sourceState)) {
    throw new Error('checkpoint sourceState does not match the current repository source')
  }
  return current
}

function persistEvidenceFailure(checkpointFile, expectedRunId, error) {
  const checkpoint = readCheckpoint(checkpointFile)
  if (!checkpoint || checkpoint.runId !== expectedRunId || checkpoint.status !== 'success') return
  const failure = {
    tierId: checkpoint.targetTierId,
    exitCode: 1,
    signal: null,
    reason: `checkpoint evidence finalization failed: ${error.message}`,
    changedPaths: []
  }
  checkpoint.status = 'failure'
  checkpoint.failure = failure
  checkpoint.failurePoint = checkpoint.targetTierId
  checkpoint.finishedAt = new Date().toISOString()
  checkpoint.ungeneratedEvidence = [{
    tierId: checkpoint.targetTierId,
    declaration: 'logicalTierProjection'
  }]
  writeCheckpoint(checkpointFile, checkpoint, {
    boundary: true,
    stage: 'evidence-finalization-failed',
    eventType: 'evidence-finalization-failed',
    tier: checkpoint.targetTierId,
    step: 'finalize-evidence'
  })
}

export async function attachCheckpointEvidence(checkpointFileValue, expectedRunId, evidenceOrBuilder, options = {}) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runDirectory = path.dirname(checkpointFile)
  const runsRoot = path.dirname(runDirectory)
  const root = path.resolve(options.root ?? '')
  if (!options.root) throw new Error('checkpoint evidence attach requires options.root')
  if (!Number.isInteger(options.expectedRevision) || options.expectedRevision <= 0) {
    throw new Error('checkpoint evidence attach requires a positive expectedRevision')
  }
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  let finalizationStarted = false
  try {
    const checkpoint = readCheckpoint(checkpointFile)
    if (!checkpoint) throw new Error(`missing or invalid scheduler checkpoint: ${checkpointFileValue}`)
    if (checkpoint.runId !== expectedRunId) {
      throw new Error(`checkpoint run ${checkpoint.runId} does not match expected run ${expectedRunId}`)
    }
    if (checkpoint.revision !== options.expectedRevision) {
      throw new Error(`checkpoint revision ${checkpoint.revision} does not match expected revision ${options.expectedRevision}`)
    }
    if (checkpoint.status !== 'success') {
      throw new Error(`checkpoint ${checkpoint.runId} must be successful before attaching evidence`)
    }
    finalizationStarted = true
    await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree)
    validateCheckpointBundleSummaries(checkpoint, root)
    const evidence = typeof evidenceOrBuilder === 'function'
      ? await evidenceOrBuilder(checkpoint)
      : evidenceOrBuilder
    await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree)
    validateCheckpointBundleSummaries(checkpoint, root)
    validateCheckpointEvidence(checkpoint, evidence, root)
    checkpoint.logicalTierProjection = evidence.logicalTierProjection
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: 'evidence-finalized',
      eventType: 'evidence-finalized',
      tier: checkpoint.targetTierId,
      step: 'finalize-evidence'
    })
    return checkpoint
  } catch (error) {
    if (finalizationStarted) persistEvidenceFailure(checkpointFile, expectedRunId, error)
    throw error
  } finally {
    releaseLock()
  }
}

export function isProjectionOnlyCheckpointFailure(checkpoint) {
  const projectionFailure = String(checkpoint?.failure?.reason ?? '')
    .startsWith('checkpoint evidence finalization failed:')
  const onlyProjectionMissing = checkpoint?.ungeneratedEvidence?.length === 1
    && checkpoint.ungeneratedEvidence[0]?.tierId === checkpoint.targetTierId
    && checkpoint.ungeneratedEvidence[0]?.declaration === 'logicalTierProjection'
  const physicalTiers = Object.values(checkpoint?.tiers ?? {})
  const physicalTiersSucceeded = physicalTiers.length > 0
    && physicalTiers.every((tier) => tier?.status === 'success' && tier?.reused === false)
  return checkpoint?.status === 'failure'
    && checkpoint?.mode === 'fresh'
    && checkpoint?.authoritative === true
    && projectionFailure
    && onlyProjectionMissing
    && physicalTiersSucceeded
}

export async function resumeCheckpointEvidence(checkpointFileValue, expectedRunId, evidenceBuilder, options = {}) {
  const checkpointFile = path.resolve(checkpointFileValue)
  const runsRoot = path.dirname(path.dirname(checkpointFile))
  const root = path.resolve(options.root ?? '')
  if (!options.root) throw new Error('checkpoint evidence resume requires options.root')
  if (typeof evidenceBuilder !== 'function') throw new Error('checkpoint evidence resume requires an evidence builder')
  const releaseLock = acquireRunLock(runsRoot, expectedRunId)
  try {
    const checkpoint = readCheckpoint(checkpointFile)
    if (!checkpoint || checkpoint.runId !== expectedRunId) {
      throw new Error(`missing or mismatched scheduler checkpoint: ${checkpointFileValue}`)
    }
    if (!isProjectionOnlyCheckpointFailure(checkpoint)) {
      throw new Error('checkpoint is not a projection-only failure with fresh successful physical tiers')
    }
    await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree)
    validateCheckpointBundleSummaries(checkpoint, root)
    const successfulCheckpoint = structuredClone(checkpoint)
    successfulCheckpoint.status = 'success'
    successfulCheckpoint.failure = null
    delete successfulCheckpoint.failurePoint
    delete successfulCheckpoint.ungeneratedEvidence
    const evidence = await evidenceBuilder(successfulCheckpoint)
    const finalizerSource = await validateCurrentCheckpointSource(checkpoint, root, options.snapshotWorktree)
    validateCheckpointBundleSummaries(checkpoint, root)
    validateCheckpointEvidence(successfulCheckpoint, evidence, root)
    checkpoint.status = 'success'
    checkpoint.failure = null
    delete checkpoint.failurePoint
    delete checkpoint.ungeneratedEvidence
    checkpoint.logicalTierProjection = evidence.logicalTierProjection
    checkpoint.evidenceFinalization = {
      mode: 'projection-resume',
      finalizedAt: new Date().toISOString(),
      finalizerSource
    }
    writeCheckpoint(checkpointFile, checkpoint, {
      boundary: true,
      stage: 'evidence-finalized',
      eventType: 'evidence-finalized',
      tier: checkpoint.targetTierId,
      step: 'resume-evidence'
    })
    return checkpoint
  } finally {
    releaseLock()
  }
}

function safeRunId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'run'
}

export function createRunId(prefix = 'matrix') {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  return safeRunId(`${prefix}-${timestamp}-${process.pid}`)
}

export function findLatestRunId(runsRoot, targetTierId = null) {
  if (!fs.existsSync(runsRoot)) return null
  const latest = fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ runId: entry.name, checkpoint: readCheckpoint(path.join(runsRoot, entry.name, 'checkpoint.json')) }))
    .filter((entry) => (
      entry.checkpoint
      && (!targetTierId || entry.checkpoint.targetTierId === targetTierId)
    ))
    .sort((left, right) => String(right.checkpoint.updatedAt).localeCompare(String(left.checkpoint.updatedAt)))[0]
  if (latest?.checkpoint.status === 'running' && runLockIsActive(runsRoot, latest.runId)) {
    throw new Error(`test matrix run ${latest.runId} is already active`)
  }
  return latest?.runId ?? null
}

function resolveRealOrAncestralPath(targetPath) {
  const resolved = path.resolve(targetPath)
  if (fs.existsSync(resolved)) {
    return fs.realpathSync(resolved)
  }
  const parent = path.dirname(resolved)
  if (fs.existsSync(parent)) {
    return path.join(fs.realpathSync(parent), path.basename(resolved))
  }
  return resolved
}

async function runDagUnlocked(options) {
  const root = path.resolve(options.root)
  const runsRoot = resolveRealOrAncestralPath(options.runsRoot ?? path.join(root, '.tmp/test-runs'))
  const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'))
  const runDirectory = path.join(runsRoot, runId)
  const checkpointFile = path.join(runDirectory, 'checkpoint.json')
  const resourceGrantFile = path.join(runDirectory, 'resource-grants.json')
  const residentLeaseFile = path.join(runDirectory, 'resident-resource-leases.json')
  const residentHandoffFile = path.join(runDirectory, 'resident-resource-handoff.json')
  const tierLogDirectory = path.join(runDirectory, 'tiers')
  const snapshotWorktree = options.snapshotWorktree ?? (() => snapshotGitWorktree(root))
  const runSourceSnapshot = await snapshotWorktree()
  // Honor explicit source-identity env overrides so prepareProductionBuildLayout
  // (which seeds layout.json from the same env) and onSourceState bind once with
  // the same commit/fingerprint. Without this, fixture/CI overrides in
  // FSUSBLOG_TEST_SOURCE_* would pre-bind the layout, then git-derived values
  // here would fail closed as an immutable identity mismatch (#1069 / #1079).
  const envCommit = String(process.env.FSUSBLOG_TEST_SOURCE_COMMIT ?? '').trim()
  const envFingerprint = String(process.env.FSUSBLOG_TEST_SOURCE_FINGERPRINT ?? '').trim()
  const sourceState = {
    commit: envCommit || gitHead(root),
    worktreeFingerprint: envFingerprint || runSourceSnapshot.fingerprint
  }
  await options.onSourceState?.(sourceState)
  const resources = options.systemResources ?? defaultSystemResources()
  const budget = resourceBudget(resources)
  const maxParallel = Math.max(1, Math.floor(Number(options.maxParallel) || resources.cpuCount || 1))
  const terminationGraceMs = Math.max(0, Number(options.terminationGraceMs) || 5000)
  const wallClockBudgetMs = Number.isFinite(Number(options.wallClockBudgetMs)) && Number(options.wallClockBudgetMs) > 0
    ? Number(options.wallClockBudgetMs)
    : null
  const mode = options.mode ?? (options.resume === true ? 'resume' : 'fresh')
  const collectFailures = options.collectFailures === true
  if (!['fresh', 'resume'].includes(mode)) throw new Error(`invalid scheduler mode: ${mode}`)
  if (options.resume === true && mode !== 'resume') throw new Error('resume=true requires mode=resume')
  const resume = mode === 'resume'
  const supersedesUniverse = options.supersedesUniverse ?? options.tiers ?? []
  const supersedesErrors = validateSupersedesRules(supersedesUniverse, options.coverageRegistry)
  if (supersedesErrors.length > 0) throw new Error(`invalid supersedes metadata: ${supersedesErrors.join('; ')}`)
  const tiers = applySupersedes(options.tiers ?? [])
  for (const tier of tiers) {
    if (tier.resourceGrantMode === 'dynamic') {
      const declaredStartupMemoryWeight = startupMemoryWeight(tier)
      if (!Number.isFinite(Number(tier.cpuWeight)) || Number(tier.cpuWeight) <= 0
        || !Number.isFinite(Number(tier.memoryWeight)) || Number(tier.memoryWeight) <= 0
        || !Number.isInteger(Number(tier.minCpuUnits)) || Number(tier.minCpuUnits) < 1
        || !Number.isInteger(Number(tier.startupMinCpuUnits ?? tier.minCpuUnits))
        || Number(tier.startupMinCpuUnits ?? tier.minCpuUnits) < 1
        || startupMinCpuUnits(tier) > Number(tier.minCpuUnits)
        || !Number.isFinite(declaredStartupMemoryWeight)
        || declaredStartupMemoryWeight <= 0
        || !Number.isFinite(Number(tier.startupPriority ?? 0))
        || Number(tier.startupPriority ?? 0) < 0) {
        throw new Error(`tier ${tier.id} has unresolved dynamic resource policy`)
      }
      continue
    }
    tierResourceUnits(tier)
  }
  const byId = new Map(tiers.map((tier) => [tier.id, tier]))
  const residentLeaseProducers = tiers.filter((tier) => tier.residentLeaseProducer === true)
  const residentLeaseConsumers = tiers.filter((tier) => tier.residentLeaseConsumer === true)
  if (residentLeaseProducers.length !== residentLeaseConsumers.length
    || residentLeaseProducers.length > 1) {
    throw new Error('resident lease topology requires exactly one producer/consumer pair or neither')
  }
  const residentConsumerBundleId = residentLeaseConsumers.length === 1
    ? (residentLeaseConsumers[0].physicalBundleId ?? residentLeaseConsumers[0].id)
    : null
  if (residentLeaseProducers.length === 1
    && residentLeaseProducers[0].residentLeaseTarget !== residentConsumerBundleId) {
    throw new Error('resident lease producer target must match its consumer')
  }
  const resourceEnforcer = createProductionResourceEnforcer({
    ...(options.resourceEnforcementOptions ?? {}),
    runId,
    bundleIds: tiers.map((tier) => tier.physicalBundleId ?? tier.id),
    machine: { cpuUnits: budget.cpuUnits, memoryGiB: budget.memoryGiB },
    mode: options.resourceEnforcementMode ?? 'advisory'
  })
  let resourceEnforcerFinalized = false
  const finalizeResourceEnforcer = () => {
    if (resourceEnforcerFinalized) return
    resourceEnforcerFinalized = true
    resourceEnforcer.sample()
    resourceEnforcer.cleanup()
  }
  options.registerSchedulerFinalizer?.(finalizeResourceEnforcer)
  const conservativeRepositoryFingerprint = tiers.some((tier) => effectiveCacheInputs(tier).length === 0)
    ? repositoryInputFingerprint(root)
    : null

  if (!resume) {
    checkpointPersistence.delete(path.resolve(checkpointFile))
    fs.rmSync(runDirectory, { recursive: true, force: true })
  }
  fs.mkdirSync(tierLogDirectory, { recursive: true })
  const previous = resume ? readCheckpoint(checkpointFile) : null
  const resumeSourceChanged = Boolean(previous)
    && (previous.sourceState?.commit !== sourceState.commit
      || previous.sourceState?.worktreeFingerprint !== sourceState.worktreeFingerprint)
  const requestedWallClockStartedAtMs = options.wallClockStartedAtMs === undefined
    ? Date.now()
    : Number(options.wallClockStartedAtMs)
  if (!Number.isFinite(requestedWallClockStartedAtMs) || requestedWallClockStartedAtMs <= 0) {
    throw new Error('wallClockStartedAtMs must be a positive finite epoch timestamp')
  }
  const effectiveWallClockStartedAtMs = previous?.startedAt
    ? Date.parse(previous.startedAt)
    : requestedWallClockStartedAtMs
  if (!Number.isFinite(effectiveWallClockStartedAtMs) || effectiveWallClockStartedAtMs > Date.now()) {
    throw new Error('wall clock start must be a valid timestamp that is not in the future')
  }
  const checkpoint = {
    schema: checkpointSchema,
    runId,
    targetTierId: options.targetTierId ?? tiers.at(-1)?.id ?? null,
    mode,
    authoritative: mode === 'fresh',
    status: 'running',
    startedAt: new Date(effectiveWallClockStartedAtMs).toISOString(),
    updatedAt: new Date().toISOString(),
    resourceBudget: budget,
    budgetMs: wallClockBudgetMs,
    timedOut: false,
    resourcePeaks: {
      load1: Math.max(0, Number(os.loadavg()[0]) || 0),
      usedMemoryGiB: Math.max(0, (os.totalmem() - os.freemem()) / (1024 ** 3)),
      reservedCpuUnits: 0,
      reservedMemoryGiB: 0
    },
    resourceUtilization: {
      status: 'collecting',
      samples: [],
      curveCompactions: 0,
      waits: null
    },
    resourceEnforcement: resourceEnforcer.evidence(),
    residentResourceLeases: {
      status: 'not-acquired',
      inventoryFile: path.relative(root, residentLeaseFile).replaceAll(path.sep, '/'),
      handoffFile: path.relative(root, residentHandoffFile).replaceAll(path.sep, '/'),
      ownerBundleId: null,
      generation: null,
      digest: null,
      resourceGrant: null,
      reservation: { cpuUnits: 0, memoryGiB: 0 },
      services: {},
      events: [],
      handoff: null,
      releasedAt: null
    },
    maxParallel,
    sourceState,
    ...(options.runtimeNamespace ? { runtimeNamespace: options.runtimeNamespace } : {}),
    resumePolicy: resume ? {
      sourceChanged: resumeSourceChanged,
      reuseAcrossSourceChanges: options.reuseAcrossSourceChanges !== false
    } : null,
    // A resume attempt may fail before it reaches otherwise reusable tiers.
    // Keep those prior successes separate from this attempt's completed tiers;
    // each candidate must still pass every normal reuse check before promotion.
    resumeCandidates: resume ? resumeTierCandidates(previous, byId) : {},
    completedTiers: [],
    tiers: {},
    failure: null,
    failurePoint: null,
    failures: []
  }
  const dynamicPriorityEnabled = options.dynamicPriority !== false
    && String(options.env?.FSUSBLOG_TEST_DYNAMIC_PRIORITY
      ?? process.env.FSUSBLOG_TEST_DYNAMIC_PRIORITY
      ?? '1') !== '0'
  checkpoint.priorityScheduling = {
    schema: prioritySchemas.score,
    modelVersion: 1,
    enabled: dynamicPriorityEnabled,
    inputSchema: options.priorityInput?.schema ?? null,
    waves: []
  }
  if (resumeSourceChanged) {
    checkpointPersistence.delete(path.resolve(checkpointFile))
    fs.rmSync(path.join(runDirectory, 'evidence-store'), { recursive: true, force: true })
  }
  writeCheckpoint(checkpointFile, checkpoint, {
    boundary: true,
    stage: 'run-start',
    eventType: 'run-started',
    tier: checkpoint.targetTierId,
    step: 'scheduler'
  })

  const pending = [...tiers]
  const completed = new Set()
  const failed = new Set()
  const resultFingerprints = new Map()
  const active = new Map()
  const schedulerWaitLedger = createWaitLedger()
  let interruptPromise = null
  let resolveInterrupt = null
  let interrupted = null
  const interruptHandlers = new Map()
  if (resourceEnforcer.mode === 'enforced') {
    interruptPromise = new Promise((resolve) => { resolveInterrupt = resolve })
    for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const handler = () => {
        if (interrupted) return
        interrupted = { signal, exitCode }
        for (const entry of active.values()) {
          entry.cancelRequested = true
          entry.terminate()
        }
        resolveInterrupt({ interrupted: true, signal, exitCode })
      }
      interruptHandlers.set(signal, handler)
      process.on(signal, handler)
    }
  }
  const removeInterruptHandlers = () => {
    for (const [signal, handler] of interruptHandlers) process.off(signal, handler)
    interruptHandlers.clear()
  }
  options.registerSchedulerFinalizer?.(removeInterruptHandlers)
  const reusedTiers = []
  const readyAges = new Map()
  let priorityWaveNumber = 0
  let firstFailure = null
  let residentState = null
  let lastResidentSampleAtMs = 0
  const residentSampleIntervalMs = Math.max(
    500,
    Math.round(5_000 / Math.sqrt(Math.max(1, budget.cpuUnits)))
  )
  const residentEvidence = checkpoint.residentResourceLeases
  const recordResidentEvent = (type, details = {}) => {
    residentEvidence.events.push({ type, at: new Date().toISOString(), ...details })
    if (residentEvidence.events.length > 1024) {
      residentEvidence.events = residentEvidence.events.filter((_, index) => index % 2 === 0)
    }
  }
  const residentUsage = () => residentState?.reconciliation?.reservation ?? { cpuUnits: 0, memoryGiB: 0 }
  const accountedUsage = (entries) => {
    const active = activeUsage(entries)
    const resident = residentUsage()
    return {
      cpuUnits: active.cpuUnits + resident.cpuUnits,
      memoryGiB: active.memoryGiB + resident.memoryGiB
    }
  }
  const appendResidentObservation = (reconciliation) => {
    for (const service of reconciliation.services) {
      const evidence = residentEvidence.services[service.id] ??= {
        generation: service.generation,
        reservation: residentState.inventory.services.find((item) => item.id === service.id)?.reservation ?? null,
        history: [],
        restartCount: 0,
        releasedAt: null
      }
      if (evidence.generation !== service.generation) {
        evidence.generation = service.generation
        evidence.reservation = residentState.inventory.services
          .find((item) => item.id === service.id)?.reservation ?? null
        evidence.restartCount += 1
      }
      evidence.history.push(service)
      if (evidence.history.length > 4096) evidence.history = evidence.history.filter((_, index) => index % 2 === 0)
      if (service.status === 'exited' && evidence.releasedAt === null) evidence.releasedAt = service.observedAt
    }
  }
  const reconcileResidentEnforcement = (inventory, state) => {
    if (!inventory.enforcement) throw new Error('resident lease inventory has no cgroup/OCI enforcement binding')
    const expectedProcessScope = resourceEnforcer.environment(state.enforcementBundleId)
    if (inventory.enforcement.mode !== resourceEnforcer.mode
      || (resourceEnforcer.mode === 'enforced'
        && inventory.enforcement.processScope?.path !== expectedProcessScope.FSUSBLOG_CGROUP_BUNDLE_PATH)) {
      throw new Error('resident lease enforcement scope does not match scheduler cgroup evidence')
    }
    const processReservation = inventory.services
      .filter((service) => service.kind === 'process')
      .reduce((total, service) => ({
        cpuUnits: total.cpuUnits + service.reservation.cpuUnits,
        memoryGiB: total.memoryGiB + service.reservation.memoryGiB
      }), { cpuUnits: 0, memoryGiB: 0 })
    if (processReservation.cpuUnits > 0 && processReservation.memoryGiB > 0) {
      resourceEnforcer.update(state.enforcementBundleId, processReservation)
    }
    residentEvidence.enforcement = inventory.enforcement
  }
  const reconcileResidentState = ({ force = false } = {}) => {
    if (!residentState) return null
    const now = Date.now()
    if (!force && now - lastResidentSampleAtMs < residentSampleIntervalMs) return residentState.reconciliation
    lastResidentSampleAtMs = now
    let previousInventory = null
    if (fs.existsSync(residentLeaseFile)) {
      const current = readResidentLeaseDocument(residentLeaseFile)
      validateResidentLeaseInventory(current, {
        runId,
        namespace: residentState.inventory.namespace,
        ownerBundleId: residentState.inventory.ownerBundleId,
        resourceGrantHistory: residentState.resourceGrantHistory,
        resourceBudget: budget,
        requiredServiceIds: residentState.requiredServiceIds,
        sourceState: sourceState.commit ? sourceState : undefined
      })
      if (current.digest !== residentState.inventory.digest) {
        const previousGeneration = residentState.inventory.generation
        previousInventory = residentState.inventory
        reconcileResidentEnforcement(current, residentState)
        residentState.inventory = current
        recordResidentEvent('generation-replaced', {
          previousGeneration,
          generation: current.generation,
          ownerBundleId: current.ownerBundleId,
          reservation: current.reservation,
          enforcementMode: current.enforcement.mode
        })
      }
    }
    const reconciliation = reconcileResidentLeaseInventory(residentState.inventory, {
      observeService: options.observeResidentService
    })
    residentState.reconciliation = reconciliation
    residentEvidence.generation = residentState.inventory.generation
    residentEvidence.digest = residentState.inventory.digest
    residentEvidence.reservation = reconciliation.reservation
    appendResidentObservation(reconciliation)
    if (fs.existsSync(residentHandoffFile)) {
      const handoff = readResidentLeaseDocument(residentHandoffFile)
      if (handoff.consumedBy === residentConsumerBundleId && residentEvidence.handoff?.status !== 'consumed') {
        const validateConsumed = (inventory) => validateResidentLeaseHandoff(handoff, {
          inventory,
          consumerBundleId: residentConsumerBundleId,
          sourceState: sourceState.commit ? sourceState : undefined,
          requireConsumed: true
        })
        try {
          validateConsumed(residentState.inventory)
        } catch (error) {
          if (!previousInventory) throw error
          validateConsumed(previousInventory)
        }
        residentEvidence.status = 'handed-off'
        residentEvidence.ownerBundleId = handoff.consumedBy
        residentEvidence.handoff = {
          ...residentEvidence.handoff,
          status: 'consumed',
          consumedAt: handoff.consumedAt,
          consumedBy: handoff.consumedBy,
          digest: handoff.digest
        }
        recordResidentEvent('handoff-consumed', {
          digest: handoff.digest,
          consumerBundleId: handoff.consumedBy
        })
      }
    }
    if (reconciliation.fullyReleased) {
      residentEvidence.status = 'released'
      residentEvidence.releasedAt ??= new Date().toISOString()
      recordResidentEvent('released', { ownerBundleId: residentEvidence.ownerBundleId })
    } else if (!reconciliation.healthy) {
      residentEvidence.status = 'identity-review-required'
    }
    return reconciliation
  }
  const acquireResidentState = (tier, tierEnvironment, {
    publishHandoff = true,
    resourceGrantHistory = [tierResourceUnits(tier)]
  } = {}) => {
    if (!fs.existsSync(residentLeaseFile)) {
      throw new Error(`resident lease producer did not publish ${path.relative(root, residentLeaseFile)}`)
    }
    const inventory = readResidentLeaseDocument(residentLeaseFile)
    validateResidentLeaseInventory(inventory, {
      runId,
      namespace: tierEnvironment.FSUSBLOG_TEST_NAMESPACE,
      ownerBundleId: tier.physicalBundleId ?? tier.id,
      resourceGrantHistory,
      resourceBudget: budget,
      ...(tier.residentLeaseServiceIds ? { requiredServiceIds: tier.residentLeaseServiceIds } : {}),
      sourceState: sourceState.commit ? sourceState : undefined
    })
    residentState = {
      inventory,
      reconciliation: null,
      enforcementBundleId: tier.physicalBundleId ?? tier.id,
      resourceGrantHistory,
      requiredServiceIds: tier.residentLeaseServiceIds
    }
    residentEvidence.status = 'acquired'
    residentEvidence.ownerBundleId = inventory.ownerBundleId
    residentEvidence.resourceGrant = inventory.schedulerResourceGrant ?? inventory.resourceGrant
    residentEvidence.acquiredAt = new Date().toISOString()
    residentEvidence.enforcement = inventory.enforcement ?? null
    recordResidentEvent('acquired', {
      ownerBundleId: inventory.ownerBundleId,
      generation: inventory.generation,
      digest: inventory.digest
    })
    const reconciliation = reconcileResidentState({ force: true })
    if (!reconciliation.healthy && publishHandoff) {
      throw new Error('resident lease producer published non-live or changed service identities')
    }
    reconcileResidentEnforcement(inventory, residentState)
    if (!publishHandoff) {
      residentEvidence.status = 'partial'
      recordResidentEvent('partial-evidence-retained', {
        reservation: reconciliation.reservation,
        healthy: reconciliation.healthy
      })
      return
    }
    const receipt = createResidentLeaseHandoff({
      inventory,
      toOwnerBundleId: residentConsumerBundleId,
      readiness: {
        status: 'ready',
        checkedAt: new Date().toISOString(),
        services: reconciliation.services.map((service) => ({
          id: service.id,
          generation: service.generation,
          status: service.status
        }))
      }
    })
    writeResidentLeaseDocument(residentHandoffFile, receipt)
    residentEvidence.handoff = {
      status: 'published',
      digest: receipt.digest,
      fromOwnerBundleId: receipt.fromOwnerBundleId,
      toOwnerBundleId: receipt.toOwnerBundleId,
      generatedAt: receipt.generatedAt,
      consumedAt: null
    }
    recordResidentEvent('handoff-published', { digest: receipt.digest })
  }
  const sampleResourcePeaks = () => {
    reconcileResidentState()
    const usage = accountedUsage([...active.values()])
    checkpoint.resourcePeaks.load1 = Math.max(checkpoint.resourcePeaks.load1, Math.max(0, Number(os.loadavg()[0]) || 0))
    checkpoint.resourcePeaks.usedMemoryGiB = Math.max(
      checkpoint.resourcePeaks.usedMemoryGiB,
      Math.max(0, (os.totalmem() - os.freemem()) / (1024 ** 3))
    )
    checkpoint.resourcePeaks.reservedCpuUnits = Math.max(checkpoint.resourcePeaks.reservedCpuUnits, usage.cpuUnits)
    checkpoint.resourcePeaks.reservedMemoryGiB = Math.max(checkpoint.resourcePeaks.reservedMemoryGiB, usage.memoryGiB)
    checkpoint.resourceUtilization.samples.push({
      atMs: Date.now(),
      load1: Math.max(0, Number(os.loadavg()[0]) || 0),
      runnableQueue: pending.filter((tier) => dependenciesReady(tier)).length,
      pendingCount: pending.length,
      activeCount: active.size,
      reservedCpuUnits: usage.cpuUnits,
      reservedMemoryGiB: usage.memoryGiB,
      hostUsedMemoryGiB: Math.max(0, (os.totalmem() - os.freemem()) / (1024 ** 3))
    })
    resourceEnforcer.sample()
    const maximumCurveSamples = Math.max(1024, Math.min(16384, Math.ceil(budget.cpuUnits * 512)))
    if (checkpoint.resourceUtilization.samples.length > maximumCurveSamples) {
      checkpoint.resourceUtilization.samples = checkpoint.resourceUtilization.samples
        .filter((_, index) => index % 2 === 0)
      checkpoint.resourceUtilization.curveCompactions += 1
    }
  }
  const resourceTimer = setInterval(sampleResourcePeaks, 500)
  resourceTimer.unref?.()
  let budgetTimer = null
  const remainingWallClockBudgetMs = wallClockBudgetMs === null
    ? null
    : Math.max(0, wallClockBudgetMs - (Date.now() - effectiveWallClockStartedAtMs))
  let budgetPromise = wallClockBudgetMs === null
    ? null
    : new Promise((resolve) => {
        budgetTimer = setTimeout(() => resolve({ budgetExpired: true }), remainingWallClockBudgetMs)
        budgetTimer.unref?.()
      })
  let deadlineExpired = false

  const dependenciesReady = (tier) => tierExecutionDependencies(tier).every((dependencyId) => completed.has(dependencyId) || !byId.has(dependencyId))
  const failedDependencies = (tier) => tierExecutionDependencies(tier).filter((dependencyId) => failed.has(dependencyId))
  const dependencyFingerprint = (tier) => fingerprint(tierExecutionDependencies(tier).map((dependencyId) => ({
    id: dependencyId,
    fingerprint: resultFingerprints.get(dependencyId) ?? 'external'
  })))

  const currentFreeMemoryGiB = () => {
    const measured = Number(options.currentFreeMemoryGiB?.() ?? (os.freemem() / (1024 ** 3)))
    return Number.isFinite(measured) && measured >= 0 ? measured : budget.memoryGiB
  }

  const writeActiveResourceGrants = () => {
    const grants = Object.fromEntries([...active.values()]
      .map(({ tier }) => [tier.id, {
        cpuUnits: tierResourceUnits(tier).cpuUnits,
        memoryGiB: tierResourceUnits(tier).memoryGiB
      }])
      .sort(([left], [right]) => left.localeCompare(right)))
    const document = {
      schema: 'fsusblog.test-matrix.resource-grants.v1',
      runId,
      resourceBudget: budget,
      residentReservation: residentUsage(),
      grants,
      generatedAt: new Date().toISOString()
    }
    const temporary = `${resourceGrantFile}.next-${process.pid}`
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`)
    fs.renameSync(temporary, resourceGrantFile)
    for (const { tier } of active.values()) {
      resourceEnforcer.update(tier.physicalBundleId ?? tier.id, tierResourceUnits(tier))
    }
  }

  const rebalanceActiveDynamicGrants = ({ expand = true } = {}) => {
    const elastic = [...active.values()].filter((entry) => entry.tier.resourceGrantDynamic === true)
    if (elastic.length === 0) {
      writeActiveResourceGrants()
      return
    }
    let usage = accountedUsage([...active.values()])
    let excessCpuUnits = Math.max(0, Math.ceil(usage.cpuUnits - budget.cpuUnits))
    for (const entry of [...elastic].sort((left, right) => right.tier.cpuUnits - left.tier.cpuUnits
      || left.tier.id.localeCompare(right.tier.id))) {
      const floor = Math.max(1, startupMinCpuUnits(entry.tier))
      const reduction = Math.min(excessCpuUnits, Math.max(0, Math.floor(entry.tier.cpuUnits - floor)))
      entry.tier.cpuUnits -= reduction
      excessCpuUnits -= reduction
      if (excessCpuUnits <= 0) break
    }
    if (excessCpuUnits > 0) throw new Error('resident reservation exceeds elastic CPU reclaim capacity')

    // Startup minima let coordination-heavy bundles enter the first wave, but
    // a long-lived bundle may later need its steady floor before it can launch
    // expensive worker hosts. Rebalance units held above a sibling's steady
    // minimum even when the machine has no completely free CPU units.
    let steadyDeficitCpuUnits = elastic.reduce(
      (total, entry) => total + Math.max(0, steadyMinCpuUnits(entry.tier) - entry.tier.cpuUnits),
      0
    )
    while (steadyDeficitCpuUnits > 0) {
      const receiver = [...elastic]
        .filter((entry) => entry.tier.cpuUnits < steadyMinCpuUnits(entry.tier))
        .sort((left, right) => (
          steadyMinCpuUnits(right.tier) - right.tier.cpuUnits
            - (steadyMinCpuUnits(left.tier) - left.tier.cpuUnits)
          || startupAdmissionOrder(left.tier, right.tier)
        ))[0]
      const donor = [...elastic]
        .filter((entry) => entry.tier.cpuUnits > steadyMinCpuUnits(entry.tier))
        .sort((left, right) => (
          right.tier.cpuUnits - steadyMinCpuUnits(right.tier)
            - (left.tier.cpuUnits - steadyMinCpuUnits(left.tier))
          || right.tier.cpuWeight - left.tier.cpuWeight
          || left.tier.id.localeCompare(right.tier.id)
        ))[0]
      if (!receiver || !donor) break
      receiver.tier.cpuUnits += 1
      donor.tier.cpuUnits -= 1
      steadyDeficitCpuUnits -= 1
    }

    usage = accountedUsage([...active.values()])
    let excessMemoryGiB = Math.max(0, usage.memoryGiB - budget.memoryGiB)
    for (const entry of [...elastic].sort((left, right) => right.tier.memoryGiB - left.tier.memoryGiB
      || left.tier.id.localeCompare(right.tier.id))) {
      const floor = Number.EPSILON
      const reduction = Math.min(excessMemoryGiB, Math.max(0, entry.tier.memoryGiB - floor))
      entry.tier.memoryGiB -= reduction
      excessMemoryGiB -= reduction
      if (excessMemoryGiB <= Number.EPSILON) break
    }
    if (excessMemoryGiB > Number.EPSILON) {
      throw new Error('resident reservation exceeds elastic memory reclaim capacity')
    }

    usage = accountedUsage([...active.values()])
    let freeCpuUnits = Math.max(0, Math.floor(budget.cpuUnits - usage.cpuUnits))
    while (expand && freeCpuUnits > 0) {
      const selected = [...elastic].sort((left, right) => {
        const leftDeficit = Math.max(0, Number(left.tier.minCpuUnits) - Number(left.tier.cpuUnits))
        const rightDeficit = Math.max(0, Number(right.tier.minCpuUnits) - Number(right.tier.cpuUnits))
        if (leftDeficit !== rightDeficit) return rightDeficit - leftDeficit
        const leftShare = Number(left.tier.cpuUnits) / Math.max(Number.EPSILON, Number(left.tier.cpuWeight))
        const rightShare = Number(right.tier.cpuUnits) / Math.max(Number.EPSILON, Number(right.tier.cpuWeight))
        return leftShare - rightShare || left.tier.id.localeCompare(right.tier.id)
      })[0]
      selected.tier.cpuUnits += 1
      freeCpuUnits -= 1
    }

    const currentUsage = accountedUsage([...active.values()])
    const liveMemoryEnvelope = Math.min(
      budget.memoryGiB,
      currentUsage.memoryGiB + currentFreeMemoryGiB()
    )
    const freeMemoryGiB = Math.max(0, liveMemoryEnvelope - currentUsage.memoryGiB)
    if (expand && freeMemoryGiB > 0) {
      const weightTotal = elastic.reduce(
        (total, entry) => total + Math.max(Number.EPSILON, Number(entry.tier.memoryWeight)),
        0
      )
      for (const entry of elastic) {
        entry.tier.memoryGiB += freeMemoryGiB
          * Math.max(Number.EPSILON, Number(entry.tier.memoryWeight))
          / weightTotal
      }
    }
    for (const entry of elastic) {
      entry.resourceGrantHistory ??= []
      const grant = tierResourceUnits(entry.tier)
      const previous = entry.resourceGrantHistory.at(-1)
      if (!previous || previous.cpuUnits !== grant.cpuUnits || previous.memoryGiB !== grant.memoryGiB) {
        entry.resourceGrantHistory.push({
          ...grant,
          effectiveAt: new Date().toISOString()
        })
      }
    }
    writeActiveResourceGrants()
  }

  const admissionWave = () => {
    if (pending.length === 0 || active.size >= maxParallel) return []
    const activeEntries = [...active.values()]
    const usage = accountedUsage(activeEntries)
    const barrierPhase = Math.min(
      ...pending.map(tierPhase),
      ...activeEntries.map((entry) => tierPhase(entry.tier))
    )
    const ready = pending.filter((tier) => tierPhase(tier) === barrierPhase && dependenciesReady(tier))
      .sort(startupAdmissionOrder)
    const priority = rankReadyTiers(ready, options.priorityInput, {
      enabled: dynamicPriorityEnabled,
      minimumSamples: options.priorityMinimumSamples,
      agingCap: options.priorityAgingCap,
      readyAges
    })
    const readyById = new Map(ready.map((tier) => [tier.id, tier]))
    const orderedReady = priority.ranked.map((entry) => readyById.get(entry.tierId))
    const priorityById = new Map(priority.ranked.map((entry) => [entry.tierId, entry]))
    const selected = []
    const decisions = []
    let fixedCpu = 0
    let fixedMemory = 0
    let dynamicMinimumCpu = 0
    const availableCpu = Math.max(0, Math.floor(budget.cpuUnits - usage.cpuUnits))
    const availableMemory = Math.max(0, Math.min(
      budget.memoryGiB - usage.memoryGiB,
      currentFreeMemoryGiB()
    ))

    for (const tier of orderedReady) {
      const admittedEntries = [...activeEntries, ...selected.map((item) => ({ tier: item }))]
      let excludedBy = null
      if (!canShareAdmission(tier, admittedEntries, maxParallel)) {
        if (admittedEntries.length >= maxParallel) excludedBy = 'max-parallel'
        else if (admittedEntries.length > 0 && tier.parallelizable !== true) excludedBy = 'tier-non-parallel'
        else if (admittedEntries.some((entry) => entry.tier.parallelizable !== true)) excludedBy = 'active-non-parallel'
        else if (admittedEntries.some((entry) => intersects(tier.exclusiveResources, entry.tier.exclusiveResources))) excludedBy = 'exclusive-resource'
        else if (admittedEntries.some((entry) => (
          (tier.services?.length ?? 0) > 0
          && (entry.tier.services?.length ?? 0) > 0
          && intersects(tier.services, entry.tier.services)
        ))) excludedBy = 'service-resource'
        else excludedBy = 'resource-class-parallel-limit'
      }
      if (excludedBy) {
        decisions.push({ ...priorityById.get(tier.id), admitted: false, hardConstraint: excludedBy })
        continue
      }
      if (tier.resourceGrantMode === 'dynamic') {
        const minimum = startupMinCpuUnits(tier)
        if (fixedCpu + dynamicMinimumCpu + minimum > availableCpu || availableMemory - fixedMemory <= 0) {
          decisions.push({
            ...priorityById.get(tier.id),
            admitted: false,
            hardConstraint: fixedCpu + dynamicMinimumCpu + minimum > availableCpu ? 'cpu-budget' : 'memory-budget'
          })
          continue
        }
        dynamicMinimumCpu += minimum
      } else {
        const request = tierResourceUnits(tier)
        if (fixedCpu + dynamicMinimumCpu + request.cpuUnits > availableCpu
          || fixedMemory + request.memoryGiB > availableMemory) {
          decisions.push({
            ...priorityById.get(tier.id),
            admitted: false,
            hardConstraint: fixedCpu + dynamicMinimumCpu + request.cpuUnits > availableCpu ? 'cpu-budget' : 'memory-budget'
          })
          continue
        }
        fixedCpu += request.cpuUnits
        fixedMemory += request.memoryGiB
      }
      selected.push(tier)
      decisions.push({ ...priorityById.get(tier.id), admitted: true, hardConstraint: null })
    }

    const selectedIds = new Set(selected.map((tier) => tier.id))
    for (const tier of ready) {
      if (selectedIds.has(tier.id)) readyAges.delete(tier.id)
      else readyAges.set(tier.id, (readyAges.get(tier.id) ?? 0) + 1)
    }
    checkpoint.priorityScheduling.waves.push({
      wave: ++priorityWaveNumber,
      mode: priority.mode,
      fallbackReason: priority.fallbackReason,
      readyTierIds: ready.map((tier) => tier.id),
      admissionOrder: orderedReady.map((tier) => tier.id),
      decisions
    })
    const dynamic = selected.filter((tier) => tier.resourceGrantMode === 'dynamic')
    const dynamicCpu = Math.max(0, Math.floor(availableCpu - fixedCpu))
    const cpuAllocations = dynamic.length > 0
      ? startupIntegerAllocation(dynamic, dynamicCpu)
      : new Map()
    if (dynamic.length > 0 && cpuAllocations === null) return []
    const dynamicMemory = Math.max(0, availableMemory - fixedMemory)
    const memoryWeightTotal = dynamic.reduce(
      (total, tier) => total + startupMemoryWeight(tier),
      0
    )
    const admittedAtMs = Date.now()
    return selected.map((tier) => {
      const priorityDecision = decisions.find((entry) => entry.tierId === tier.id)
      return tier.resourceGrantMode === 'dynamic'
      ? {
          ...tier,
          resourceGrantMode: 'granted',
          resourceGrantDynamic: true,
          cpuUnits: cpuAllocations.get(tier.id),
          memoryGiB: dynamicMemory * startupMemoryWeight(tier) / memoryWeightTotal,
          startupGrant: {
            cpuUnits: cpuAllocations.get(tier.id),
            memoryGiB: dynamicMemory * startupMemoryWeight(tier) / memoryWeightTotal
          },
          admittedAtMs,
          priorityDecision
        }
      : { ...tier, admittedAtMs, priorityDecision }
    })
  }

  const completeReusedTier = (tier, inputFingerprint, dependencyFingerprintValue, tierEnvironment) => {
    const candidate = checkpoint.resumeCandidates?.[tier.id]
    const previousTier = candidate?.tierResult
    const currentOutputs = snapshotTierOutputs(root, tier, tierEnvironment)
    if (
      (options.reuseAcrossSourceChanges === false && !sameCheckpointSource(candidate?.sourceState, sourceState))
      || previousTier?.status !== 'success'
      || previousTier.inputFingerprint !== inputFingerprint
      || previousTier.dependencyFingerprint !== dependencyFingerprintValue
      || previousTier.outputFingerprint !== currentOutputs.fingerprint
      || currentOutputs.reusable !== true
      || (tier.services?.length ?? 0) > 0
      || tier.selfBootstraps === true
    ) return false

    const resultFingerprint = previousTier.resultFingerprint ?? fingerprint({ inputFingerprint, dependencyFingerprint: dependencyFingerprintValue })
    completed.add(tier.id)
    resultFingerprints.set(tier.id, resultFingerprint)
    reusedTiers.push(tier.id)
    delete checkpoint.resumeCandidates[tier.id]
    checkpoint.tiers[tier.id] = {
      ...previousTier,
      reused: true,
      reuseSourceState: candidate.sourceState,
      logFile: path.relative(root, path.join(tierLogDirectory, `${tier.id}.log`)).replaceAll(path.sep, '/')
    }
    writeCheckpoint(checkpointFile, checkpoint, {
      eventType: 'tier-reused',
      tier: tier.id,
      step: 'resume'
    })
    options.onTierReused?.(tier, checkpoint.tiers[tier.id])
    return true
  }

  const startTier = async (tier) => {
    schedulerWaitLedger.observe(tier.id, null)
    const enforcementBundleId = tier.physicalBundleId ?? tier.id
    const effectiveEnforcement = resourceEnforcer.update(enforcementBundleId, tierResourceUnits(tier))
    const tierEnvironment = {
      ...process.env,
      ...(options.env ?? {}),
      ...(options.envForTier?.(tier) ?? {}),
      FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit ?? '',
      FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint,
      FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: resourceGrantFile,
      FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: tier.id,
      ...(tier.residentLeaseConsumer === true ? {
        FSUSBLOG_RESIDENT_LEASE_INVENTORY: residentLeaseFile,
        FSUSBLOG_RESIDENT_LEASE_HANDOFF: residentHandoffFile
      } : {}),
      ...resourceEnforcer.environment(enforcementBundleId),
      FSUSBLOG_CGROUP_EFFECTIVE_CPU_MAX: effectiveEnforcement.cpuMax,
      FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_HIGH_BYTES: String(effectiveEnforcement.memoryHighBytes),
      FSUSBLOG_CGROUP_EFFECTIVE_MEMORY_MAX_BYTES: String(effectiveEnforcement.memoryMaxBytes),
      FSUSBLOG_CGROUP_EFFECTIVE_PIDS_MAX: String(effectiveEnforcement.pidsMax)
    }
    const inputFingerprint = tierInputFingerprint(tier, root, {
      env: tierEnvironment,
      platform: options.platform,
      arch: options.arch,
      nodeVersion: options.nodeVersion,
      repositoryFingerprint: conservativeRepositoryFingerprint
    })
    const dependencyFingerprintValue = dependencyFingerprint(tier)
    if (resume && completeReusedTier(tier, inputFingerprint, dependencyFingerprintValue, tierEnvironment)) return false

    // Once execution is about to begin, the old success is no longer a safe
    // fallback: the command may mutate its outputs before failing or being
    // interrupted. Persist the retirement before spawning any work so a killed
    // resume remains fail-closed on the next attempt.
    if (resume && checkpoint.resumeCandidates?.[tier.id]) {
      delete checkpoint.resumeCandidates[tier.id]
      writeCheckpoint(checkpointFile, checkpoint, {
        eventType: 'resume-candidate-retired',
        tier: tier.id,
        step: 'resume'
      })
    }

    const ownedOutputs = ownedGeneratedDeclarations(tier, byId)
    if (!resume) cleanFreshOwnedFiles(root, ownedOutputs, tierEnvironment)
    const beforeOutputProvenance = outputProvenance(root, ownedOutputs, tierEnvironment)

    const logFile = path.join(tierLogDirectory, `${tier.id}.log`)
    const outputPipeline = createAsyncLogPipeline({
      root,
      file: logFile,
      teeOutput: options.teeOutput === true,
      highWaterMark: options.logHighWaterMark,
      indexHighWaterMark: options.logIndexHighWaterMark,
      consoleMaxBufferedBytes: options.consoleLogMaxBufferedBytes
    })
    const writeOutput = (chunk, stderr = false) => {
      return outputPipeline.write(chunk, stderr ? 'stderr' : 'stdout')
    }
    const beforeSnapshot = await snapshotWorktree()
    const startedAt = Date.now()
    const context = {
      env: tierEnvironment,
      logFile,
      logIndexFile: outputPipeline.indexFile,
      logEvidenceFile: outputPipeline.evidenceFile,
      writeOutput,
      runId,
      runDirectory
    }
    const execution = options.executeTier
      ? {
          promise: Promise.resolve().then(() => options.executeTier(tier, context)).then(normalizeExecutionResult, (error) => ({ code: 1, signal: null, error })),
          terminate: () => options.abortTier?.(tier)
        }
      : beginSubprocess(tier, {
          root,
          env: tierEnvironment,
          outputPipeline,
          terminationGraceMs,
          suspendForAttach: resourceEnforcer.mode === 'enforced'
        })
    if (execution.child) {
      try {
        resourceEnforcer.attach(enforcementBundleId, execution.child.pid)
        execution.resume?.()
      } catch (error) {
        execution.terminate()
        execution.resume?.()
        await outputPipeline.close({ complete: false, truncationReason: 'cgroup-attach-failed' })
        throw new Error(`cgroup attach failed for ${enforcementBundleId}: ${error.message}`, { cause: error })
      }
    }
    const resourceCollector = execution.child
      ? createLinuxProcessTreeCollector({
          rootPid: execution.child.pid,
          grantProvider: () => tierResourceUnits(tier),
          sampleIntervalMs: resolveResourceSampleIntervalMs({
            cpuUnits: tierResourceUnits(tier).cpuUnits,
            benchmark: tier.resourceClass === 'benchmark'
          })
        })
      : null

    options.onTierStart?.(tier, { startedAt, logFile })
    const entry = {
      tier,
      admittedAtMs: tier.admittedAtMs ?? startedAt,
      startupGrant: tier.startupGrant ?? tierResourceUnits(tier),
      firstExecutableStepAtMs: startedAt,
      cancelRequested: false,
      terminate: execution.terminate,
      promise: Promise.race([
        execution.promise.then((result) => ({ kind: 'execution', result })),
        outputPipeline.failure.then((error) => ({ kind: 'log-failure', error }))
      ]).then(async (outcome) => {
        let executionResult
        if (outcome.kind === 'log-failure') {
          execution.terminate()
          if (execution.child) await execution.promise
          executionResult = {
            code: 1,
            signal: null,
            error: new Error(`authoritative log pipeline failed: ${outcome.error.message}`, { cause: outcome.error }),
            logComplete: false,
            logTruncationReason: 'writer-error'
          }
        } else {
          executionResult = outcome.result
        }
        const logFinalization = await outputPipeline.close({
          complete: executionResult.logComplete !== false,
          truncationReason: executionResult.logTruncationReason ?? null
        })
        if (logFinalization.error && !executionResult.error) {
          executionResult = {
            ...executionResult,
            code: 1,
            error: new Error(
              `authoritative log pipeline failed: ${logFinalization.error.message}`,
              { cause: logFinalization.error }
            )
          }
        }
        const resourceUtilization = resourceCollector?.stop() ?? {
          status: 'unavailable',
          platform: process.platform,
          actualCpuSeconds: null,
          grantedCpuSeconds: null,
          cpuGrantEfficiency: null
        }
        const afterSnapshot = await snapshotWorktree()
        return {
          executionResult,
          resourceUtilization,
          changedPaths: changedSnapshotPaths(beforeSnapshot, afterSnapshot),
          durationMs: Math.max(0, Date.now() - startedAt),
          inputFingerprint,
          dependencyFingerprint: dependencyFingerprintValue,
          ownedOutputs,
          tierEnvironment,
          beforeOutputProvenance,
          logFile,
          logIndexFile: logFinalization.indexFile,
          logEvidenceFile: logFinalization.evidenceFile,
          logEvidence: logFinalization.evidence
        }
      })
    }
    active.set(tier.id, entry)
    // Publish the admitted grant before an in-process executor or a very fast
    // child can read it. The later expansion pass may grow this grant, but the
    // startup grant and current resident deduction must already be authoritative.
    writeActiveResourceGrants()
    if (tier.resourceGrantDynamic === true) {
      entry.resourceGrantHistory = [{
        ...entry.startupGrant,
        effectiveAt: new Date(startedAt).toISOString()
      }]
    }
    sampleResourcePeaks()
    return true
  }

  const recordSettled = (entry, settled) => {
    const { tier } = entry
    const {
      executionResult,
      resourceUtilization,
      changedPaths,
      durationMs,
      inputFingerprint,
      dependencyFingerprint: dependencyFingerprintValue,
      ownedOutputs,
      tierEnvironment,
      beforeOutputProvenance,
      logFile,
      logIndexFile,
      logEvidenceFile,
      logEvidence
    } = settled
    const commandFailed = executionResult.code !== 0 || executionResult.signal || executionResult.error
    const polluted = changedPaths.length > 0
    const cancelled = entry.cancelRequested && firstFailure !== null
    const outputs = snapshotTierOutputs(root, tier, tierEnvironment)
    const outputInvalid = !commandFailed && outputs.reusable !== true
    const afterOutputProvenance = outputProvenance(root, ownedOutputs, tierEnvironment)
    const staleOutputs = !commandFailed
      && !outputInvalid
      && ownedOutputs.length > 0
      && beforeOutputProvenance.fingerprint === afterOutputProvenance.fingerprint
    let success = !cancelled && !commandFailed && !polluted && !outputInvalid && !staleOutputs
    const resultFingerprint = fingerprint({
      inputFingerprint,
      dependencyFingerprint: dependencyFingerprintValue,
      outputFingerprint: outputs.fingerprint
    })
    const relativeLogFile = path.relative(root, logFile).replaceAll(path.sep, '/')
    let reason = null
    if (cancelled) reason = 'cancelled after sibling failure'
    else if (executionResult.error) reason = executionResult.error.message
    else if (commandFailed) reason = `${tier.command} exited ${executionResult.code}${executionResult.signal ? ` (${executionResult.signal})` : ''}`
    else if (polluted) reason = `working tree pollution detected: ${changedPaths.join(', ')}`
    else if (outputInvalid) {
      const invalidOutputs = Object.entries(outputs.entries)
        .filter(([, value]) => value === 'missing' || value === 'missing-wildcard' || value === 'outside-root')
        .map(([declaration, value]) => `${declaration} (${value})`)
      reason = `required artifact/evidence missing or invalid: ${invalidOutputs.join(', ')}`
    }
    else if (staleOutputs) reason = `fresh tier did not produce or update its owned generated evidence: ${ownedOutputs.join(', ')}`

    if (tier.residentLeaseProducer === true) {
      if (fs.existsSync(residentLeaseFile) || success) {
        try {
          acquireResidentState(tier, tierEnvironment, {
            publishHandoff: success,
            resourceGrantHistory: entry.resourceGrantHistory ?? [tierResourceUnits(tier)]
          })
        } catch (error) {
          recordResidentEvent('acquisition-failed', { reason: error.message })
          if (success) {
            success = false
            reason = error.message
            executionResult.code = 1
            executionResult.error = error
          }
        }
      } else {
        recordResidentEvent('partial-inventory-missing', { ownerBundleId: tier.physicalBundleId ?? tier.id })
      }
    } else if (residentState) {
      reconcileResidentState({ force: true })
    }

    checkpoint.tiers[tier.id] = {
      status: success ? 'success' : (cancelled ? 'cancelled' : 'failure'),
      resourceGrant: tierResourceUnits(tier),
      admittedAtMs: entry.admittedAtMs,
      startupGrant: entry.startupGrant,
      firstExecutableStepAtMs: entry.firstExecutableStepAtMs,
      resourceGrantHistory: entry.resourceGrantHistory ?? [tierResourceUnits(tier)],
      priorityDecision: tier.priorityDecision ?? null,
      resourceUtilization,
      inputFingerprint,
      dependencyFingerprint: dependencyFingerprintValue,
      resultFingerprint,
      durationMs,
      exitCode: executionResult.code,
      signal: executionResult.signal,
      changedPaths,
      outputFingerprint: outputs.fingerprint,
      outputs: outputs.entries,
      outputsReusable: outputs.reusable,
      outputProvenanceFingerprint: afterOutputProvenance.fingerprint,
      ownedGeneratedOutputs: ownedOutputs,
      reason,
      logFile: relativeLogFile,
      log: {
        ...logEvidence,
        rawLog: relativeLogFile,
        index: path.relative(root, logIndexFile).replaceAll(path.sep, '/'),
        evidence: path.relative(root, logEvidenceFile).replaceAll(path.sep, '/')
      },
      reused: false
    }
    if (success) {
      completed.add(tier.id)
      resultFingerprints.set(tier.id, resultFingerprint)
    }
    options.onTierComplete?.(tier, checkpoint.tiers[tier.id])
    writeCheckpoint(checkpointFile, checkpoint, {
      eventType: success ? 'tier-completed' : (cancelled ? 'tier-cancelled' : 'tier-failed'),
      tier: tier.id,
      step: 'execute'
    })
    return { success, cancelled, reason, changedPaths, executionResult }
  }

  while (pending.length > 0 || active.size > 0) {
    if (interrupted && active.size === 0) break
    if (collectFailures) {
      let blockedAny = true
      while (blockedAny) {
        blockedAny = false
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const blockedBy = failedDependencies(pending[index])
          if (blockedBy.length === 0) continue
          const [blockedTier] = pending.splice(index, 1)
          failed.add(blockedTier.id)
          checkpoint.tiers[blockedTier.id] = {
            status: 'blocked',
            durationMs: 0,
            reason: `blocked by failed dependencies: ${blockedBy.join(', ')}`,
            reused: false
          }
          blockedAny = true
        }
      }
    }
    if ((!firstFailure || collectFailures) && !deadlineExpired) {
      const wave = admissionWave()
      const waveIds = new Set(wave.map((tier) => tier.id))
      const activeEntries = [...active.values()]
      const admissionEntries = [...activeEntries, ...wave.map((tier) => ({ tier }))]
      const usage = accountedUsage(admissionEntries)
      const barrierPhase = Math.min(
        ...pending.map(tierPhase),
        ...activeEntries.map((entry) => tierPhase(entry.tier))
      )
      for (const tier of pending) {
        if (waveIds.has(tier.id)) continue
        if (tierPhase(tier) > barrierPhase) {
          schedulerWaitLedger.observe(tier.id, { dependencies: [`phase:${barrierPhase}`] })
          continue
        }
        const dependencies = tierExecutionDependencies(tier).filter((dependencyId) => byId.has(dependencyId) && !completed.has(dependencyId))
        if (dependencies.length > 0) {
          schedulerWaitLedger.observe(tier.id, { dependencies })
          continue
        }
        const exclusiveResources = (tier.exclusiveResources ?? []).filter((resource) =>
          admissionEntries.some((entry) => (entry.tier.exclusiveResources ?? []).includes(resource)))
        const serviceResources = (tier.services ?? []).filter((service) =>
          admissionEntries.some((entry) => (entry.tier.services ?? []).includes(service)))
          .map((service) => `service:${service}`)
        exclusiveResources.push(...serviceResources)
        if (exclusiveResources.includes('benchmark-window')) {
          schedulerWaitLedger.observe(tier.id, { benchmarkIsolation: true })
        } else if (exclusiveResources.length > 0) {
          schedulerWaitLedger.observe(tier.id, { exclusiveResources })
        } else {
          const request = tier.resourceGrantMode === 'dynamic'
            ? { cpuUnits: startupMinCpuUnits(tier), memoryGiB: Number.EPSILON }
            : tierResourceUnits(tier)
          const capacity = {
            cpu: admissionEntries.length >= maxParallel
              || !canShareAdmission(tier, admissionEntries, maxParallel)
              || usage.cpuUnits + request.cpuUnits > budget.cpuUnits,
            memory: usage.memoryGiB + request.memoryGiB > Math.min(budget.memoryGiB, usage.memoryGiB + currentFreeMemoryGiB())
          }
          schedulerWaitLedger.observe(tier.id, tier.resourceGrantMode === 'dynamic'
            ? { startupCapacity: capacity }
            : { capacity })
        }
      }
      for (const grantedTier of wave) {
        const nextIndex = pending.findIndex((tier) => tier.id === grantedTier.id)
        if (nextIndex < 0) continue
        pending.splice(nextIndex, 1)
        await startTier(grantedTier)
      }
      // Admit newly-ready work before redistributing released capacity to
      // already-running elastic tiers. Otherwise an active tier can consume
      // every released CPU unit and indefinitely starve a downstream bundle
      // whose minimum grant would fit in that same envelope.
      rebalanceActiveDynamicGrants()
      if (wave.length > 0 && active.size === 0) continue
    }

    if (active.size === 0) {
      if (deadlineExpired) break
      if (pending.length > 0 && (!firstFailure || collectFailures)) {
        const barrierPhase = Math.min(...pending.map(tierPhase))
        const readyTier = pending.find((tier) => tierPhase(tier) === barrierPhase && dependenciesReady(tier))
        const request = readyTier
          ? (readyTier.resourceGrantMode === 'dynamic'
              ? { cpuUnits: startupMinCpuUnits(readyTier), memoryGiB: Number.EPSILON }
              : tierResourceUnits(readyTier))
          : null
        const liveMemoryCapacityGiB = Math.min(budget.memoryGiB, currentFreeMemoryGiB())
        const resident = residentUsage()
        const executableBudget = {
          cpuUnits: Math.max(0, budget.cpuUnits - resident.cpuUnits),
          memoryGiB: Math.max(0, liveMemoryCapacityGiB - resident.memoryGiB)
        }
        const unschedulable = request
          && (request.cpuUnits > executableBudget.cpuUnits || request.memoryGiB > executableBudget.memoryGiB)
        firstFailure = {
          tierId: readyTier?.id ?? pending[0].id,
          exitCode: 1,
          signal: null,
          reason: unschedulable
            ? `unschedulable resource request for ${readyTier.id}: cpu=${request.cpuUnits}/${executableBudget.cpuUnits}, memoryGiB=${request.memoryGiB}/${executableBudget.memoryGiB} after resident reservation`
            : 'no runnable tiers remain; check DAG dependencies and resource metadata',
          changedPaths: []
        }
      }
      break
    }

    const activePromises = [...active.entries()].map(([tierId, entry]) => (
      entry.promise.then((settled) => ({ tierId, settled }))
    ))
    const raceEntries = budgetPromise && (!firstFailure || collectFailures)
      ? [...activePromises, budgetPromise]
      : activePromises
    if (interruptPromise) raceEntries.push(interruptPromise)
    const outcome = await Promise.race(raceEntries)
    if (outcome.interrupted) {
      interruptPromise = null
      deadlineExpired = true
      firstFailure ??= {
        tierId: active.keys().next().value ?? pending[0]?.id ?? checkpoint.targetTierId,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        reason: `scheduler interrupted by ${outcome.signal}`,
        changedPaths: []
      }
      checkpoint.failure = firstFailure
      checkpoint.failurePoint = firstFailure.tierId
      checkpoint.failures.push(firstFailure)
      writeCheckpoint(checkpointFile, checkpoint, {
        eventType: 'run-interrupted',
        tier: firstFailure.tierId,
        step: 'scheduler'
      })
      continue
    }
    if (outcome.budgetExpired) {
      deadlineExpired = true
      budgetPromise = null
      const timedOutTierId = active.keys().next().value ?? pending[0]?.id ?? checkpoint.targetTierId
      firstFailure = {
        tierId: timedOutTierId,
        exitCode: 124,
        signal: null,
        reason: `wall-clock budget exceeded (${wallClockBudgetMs}ms)`,
        changedPaths: []
      }
      checkpoint.timedOut = true
      checkpoint.failure = firstFailure
      checkpoint.failurePoint = timedOutTierId
      checkpoint.failures.push(firstFailure)
      writeCheckpoint(checkpointFile, checkpoint, {
        eventType: 'run-timed-out',
        tier: timedOutTierId,
        step: 'scheduler'
      })
      for (const entry of active.values()) {
        entry.cancelRequested = true
        entry.terminate()
      }
      continue
    }
    const { tierId, settled } = outcome
    const entry = active.get(tierId)
    active.delete(tierId)
    const recorded = recordSettled(entry, settled)
    // A producer may have converted part of its released grant into resident
    // leases. Contract active elastic grants immediately, before another
    // admission/resource sample can observe an overcommitted envelope.
    rebalanceActiveDynamicGrants({ expand: false })
    if (!recorded.success && !recorded.cancelled && !firstFailure) {
      const failure = {
        tierId,
        exitCode: recorded.executionResult.code ?? 1,
        signal: recorded.executionResult.signal ?? null,
        reason: recorded.reason,
        changedPaths: recorded.changedPaths
      }
      firstFailure = failure
      failed.add(tierId)
      checkpoint.failures.push(failure)
      if (!collectFailures) {
        for (const sibling of active.values()) {
          sibling.cancelRequested = true
          sibling.terminate()
        }
      }
    } else if (!recorded.success && !recorded.cancelled && collectFailures) {
      const failure = {
        tierId,
        exitCode: recorded.executionResult.code ?? 1,
        signal: recorded.executionResult.signal ?? null,
        reason: recorded.reason,
        changedPaths: recorded.changedPaths
      }
      failed.add(tierId)
      checkpoint.failures.push(failure)
    }
  }

  checkpoint.status = firstFailure ? 'failure' : 'success'
  checkpoint.failure = firstFailure
  checkpoint.failurePoint = firstFailure?.tierId ?? null
  checkpoint.finishedAt = new Date().toISOString()
  if (budgetTimer) clearTimeout(budgetTimer)
  clearInterval(resourceTimer)
  sampleResourcePeaks()
  checkpoint.criticalPath = criticalPath(tiers, checkpoint.tiers)
  checkpoint.resourceUtilization.status = firstFailure ? 'partial' : 'complete'
  checkpoint.resourceUtilization.waits = schedulerWaitLedger.finish()
  checkpoint.resourceUtilization.resourceGrantHistory = Object.fromEntries(Object.entries(checkpoint.tiers)
    .map(([tierId, result]) => [tierId, result.resourceGrantHistory ?? []]))
  finalizeResourceEnforcer()
  checkpoint.resourceEnforcement = resourceEnforcer.evidence()
  removeInterruptHandlers()
  checkpoint.ungeneratedEvidence = firstFailure
    ? tiers.flatMap((tier) => {
        const result = checkpoint.tiers[tier.id]
        if (result?.status === 'success') return []
        return [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])])].map((declaration) => ({
          tierId: tier.id,
          declaration
        }))
      })
    : []
  writeCheckpoint(checkpointFile, checkpoint, {
    boundary: true,
    stage: firstFailure ? 'run-failed' : 'run-complete',
    eventType: firstFailure ? 'run-failed' : 'run-completed',
    tier: firstFailure?.tierId ?? checkpoint.targetTierId,
    step: 'scheduler'
  })

  return {
    status: checkpoint.status,
    runId,
    runDirectory,
    checkpointPath: checkpointFile,
    reusedTiers,
    failure: firstFailure,
    checkpoint
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function runLockIsActive(runsRoot, runId) {
  const lockPath = path.join(runsRoot, '.locks', `${runId}.lock`)
  const ownerFile = path.join(lockPath, 'owner.json')
  if (!fs.existsSync(lockPath)) return false
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
    return processIsAlive(Number(owner.pid))
  } catch {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs < 30_000
    } catch {
      return false
    }
  }
}

function acquireRunLock(runsRoot, runId) {
  const lockDirectory = path.join(runsRoot, '.locks')
  const lockPath = path.join(lockDirectory, `${runId}.lock`)
  const ownerFile = path.join(lockPath, 'owner.json')
  fs.mkdirSync(lockDirectory, { recursive: true })
  const token = crypto.randomUUID()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      fs.writeFileSync(ownerFile, `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 })
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
          if (owner.token === token) fs.rmSync(lockPath, { recursive: true, force: true })
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner = null
      try {
        owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      } catch {}
      if (processIsAlive(Number(owner?.pid))) {
        throw new Error(`test matrix run ${runId} is already active (pid ${owner.pid})`)
      }
      if (!owner) {
        const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs
        if (ageMs < 30_000) throw new Error(`test matrix run ${runId} is already active (owner metadata initializing)`)
      }
      fs.rmSync(lockPath, { recursive: true, force: true })
    }
  }
  throw new Error(`unable to acquire test matrix run lock for ${runId}`)
}

export async function runDag(options) {
  const root = path.resolve(options.root)
  const runsRoot = resolveRealOrAncestralPath(options.runsRoot ?? path.join(root, '.tmp/test-runs'))
  const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'))
  const releaseLock = acquireRunLock(runsRoot, runId)
  const schedulerFinalizers = []
  try {
    return await runDagUnlocked({
      ...options,
      root,
      runsRoot,
      runId,
      registerSchedulerFinalizer(finalizer) {
        schedulerFinalizers.push(finalizer)
      }
    })
  } finally {
    for (const finalizer of schedulerFinalizers.reverse()) {
      try { await finalizer() } catch {}
    }
    releaseLock()
  }
}
