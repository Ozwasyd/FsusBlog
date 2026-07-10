import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'

const checkpointSchema = 'fsusblog.test-matrix.checkpoint.v1'
const protectedSupersedesPattern = /(^|[^a-z])(property|model|perf|performance|benchmark|runtime)([^a-z]|$)/i
const protectedAssertionTypes = new Set(['runtime', 'browser', 'perf', 'fuzz', 'mutation'])
const protectedExecutionVariants = new Set(['property', 'model', 'performance', 'runtime'])
const fingerprintEnvironmentPrefixes = ['FSUSBLOG_', 'PLAYWRIGHT_', 'MATRIX_', 'VITE_']
const fingerprintEnvironmentKeys = new Set(['CI', 'NODE_ENV', 'DOTNET_ROOT'])
const resourceClassDefaults = Object.freeze({
  cpu: { cpuUnits: 1, memoryGiB: 1 },
  io: { cpuUnits: 0.5, memoryGiB: 0.5 },
  browser: { cpuUnits: 2, memoryGiB: 4 },
  network: { cpuUnits: 1, memoryGiB: 1 },
  benchmark: { cpuUnits: 4, memoryGiB: 2 },
  database: { cpuUnits: 2, memoryGiB: 3 }
})

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
    .map((tier) => ({
      ...tier,
      dependsOn: [...new Set((tier.dependsOn ?? [])
        .map(resolveReplacement)
        .filter((dependencyId) => dependencyId !== tier.id))]
    }))
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

export function snapshotTierOutputs(rootValue, tier) {
  const root = path.resolve(rootValue)
  const declarations = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])].map(String))].sort()
  const entries = {}
  let reusable = true
  for (const declaration of declarations) {
    const normalized = declaration.replace(/^\.\//u, '').replaceAll('\\', '/')
    const matcher = wildcardPattern(normalized)
    const absoluteDeclaration = path.resolve(root, normalized)
    if (!absoluteDeclaration.startsWith(`${root}${path.sep}`) && absoluteDeclaration !== root) {
      entries[normalized] = 'outside-root'
      reusable = false
      continue
    }
    if (!hasWildcard(normalized)) {
      if (!fs.existsSync(absoluteDeclaration)) {
        entries[normalized] = 'missing'
        reusable = false
      } else {
        entries[normalized] = outputPathFingerprint(absoluteDeclaration)
      }
      continue
    }

    const searchRoot = wildcardSearchRoot(root, normalized)
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
  const dependencyDeclarations = (tier.dependsOn ?? []).flatMap((dependencyId) => {
    const dependency = byId.get(dependencyId)
    return dependency ? [...(dependency.artifacts ?? []), ...(dependency.evidence ?? [])] : []
  })
  const candidates = [...new Set([...(tier.artifacts ?? []), ...(tier.evidence ?? [])])]
    .filter(generatedOutputDeclaration)
    .filter((declaration) => !dependencyDeclarations.some((dependency) => declarationsOverlap(declaration, dependency)))
  return candidates.filter((declaration) => {
    if (hasWildcard(String(declaration))) return true
    const prefix = declarationPrefix(declaration)
    return !candidates.some((other) => other !== declaration && declarationPrefix(other).startsWith(`${prefix}/`))
  })
}

function outputProvenance(root, declarations) {
  const entries = {}
  for (const declaration of declarations) {
    const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/')
    const matcher = wildcardPattern(normalized)
    const absolute = path.resolve(root, normalized)
    const matches = hasWildcard(normalized)
      ? (fs.existsSync(wildcardSearchRoot(root, normalized))
          ? walkOutputPaths(wildcardSearchRoot(root, normalized)).filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
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

function cleanFreshOwnedFiles(root, declarations) {
  for (const declaration of declarations) {
    const normalized = String(declaration).replace(/^\.\//u, '').replaceAll('\\', '/')
    if (hasWildcard(normalized)) {
      const searchRoot = wildcardSearchRoot(root, normalized)
      if (!fs.existsSync(searchRoot)) continue
      const matcher = wildcardPattern(normalized)
      const matches = walkOutputPaths(searchRoot)
        .filter((candidate) => matcher.test(path.relative(root, candidate).replaceAll(path.sep, '/')))
        .sort((left, right) => right.length - left.length)
      for (const candidate of matches) fs.rmSync(candidate, { recursive: true, force: true })
      continue
    }
    const absolute = path.resolve(root, normalized)
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

  if (/^(?:tools\/test\/lanes\/|tools\/test\/legacy-test\.sh)/u.test(commandPath ?? '')) {
    for (const value of ['tools/test/lanes/_legacy.sh', 'tools/test/legacy-test.sh', 'tools/test/run-once.mjs']) inputs.add(value)
  }
  if (tier.id === 'coverage-frontend' || String(tier.id).startsWith('frontend-')) {
    for (const value of ['src/frontend/package.json', 'src/frontend/tests', 'src/frontend/vitest*.config.ts', 'src/frontend/vitest.shared.mjs']) inputs.add(value)
  }

  const dependencyOnlyAggregate = (tier.dependsOn?.length ?? 0) > 0 && /tools\/test\/lanes\/noop\.sh\b/u.test(String(tier.command))
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
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    return
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if (error.code !== 'ESRCH') child.kill(signal)
      return
    }
  }

  child.kill(signal)
}

function beginSubprocess(tier, { root, env, writeOutput, terminationGraceMs }) {
  const child = spawn(tier.command, {
    cwd: root,
    env,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stdout?.on('data', (chunk) => writeOutput(chunk, false))
  child.stderr?.on('data', (chunk) => writeOutput(chunk, true))

  let settled = false
  const promise = new Promise((resolve) => {
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolve({ code: 1, signal: null, error })
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code: code ?? 1, signal })
    })
  })

  return {
    promise,
    terminate() {
      signalProcessTree(child, 'SIGTERM')
      const timer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), terminationGraceMs)
      timer.unref?.()
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
  return {
    cpuUnits: Math.max(1, cpuCount - Math.ceil(load1)),
    memoryGiB: Math.max(0.1, Number(resources.availableMemoryGiB) || 0.1)
  }
}

export function tierResourceUnits(tier) {
  const defaults = resourceClassDefaults[tier.resourceClass] ?? resourceClassDefaults.cpu
  return {
    cpuUnits: Math.max(0.1, Number(tier.cpuUnits) || defaults.cpuUnits),
    memoryGiB: Math.max(0, Number(tier.memoryGiB) || defaults.memoryGiB)
  }
}

function activeUsage(activeEntries) {
  return {
    cpuUnits: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).cpuUnits, 0),
    memoryGiB: activeEntries.reduce((total, entry) => total + tierResourceUnits(entry.tier).memoryGiB, 0)
  }
}

function intersects(left, right) {
  const rightSet = new Set(right ?? [])
  return (left ?? []).some((item) => rightSet.has(item))
}

function canStartTier(tier, activeEntries, maxParallel, budget) {
  if (activeEntries.length >= maxParallel) return false
  if (activeEntries.length > 0 && tier.parallelizable !== true) return false
  if (activeEntries.some((entry) => entry.tier.parallelizable !== true)) return false
  if (activeEntries.some((entry) => intersects(tier.exclusiveResources, entry.tier.exclusiveResources))) return false
  if (activeEntries.some((entry) => (
    (tier.services?.length ?? 0) > 0
    && (entry.tier.services?.length ?? 0) > 0
    && intersects(tier.services, entry.tier.services)
  ))) return false

  const sameClass = activeEntries.filter((entry) => entry.tier.resourceClass === tier.resourceClass)
  if (sameClass.length >= Math.max(1, Number(tier.maxParallel) || 1)) return false
  if (sameClass.some((entry) => sameClass.length >= Math.max(1, Number(entry.tier.maxParallel) || 1))) return false

  if (activeEntries.length === 0) return true
  const usage = activeUsage(activeEntries)
  const { cpuUnits, memoryGiB } = tierResourceUnits(tier)
  return usage.cpuUnits + cpuUnits <= budget.cpuUnits && usage.memoryGiB + memoryGiB <= budget.memoryGiB
}

function tierPhase(tier) {
  const value = Number(tier.phase)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function readCheckpoint(checkpointFile) {
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'))
    return checkpoint?.schema === checkpointSchema ? checkpoint : null
  } catch {
    return null
  }
}

function writeCheckpoint(checkpointFile, checkpoint) {
  checkpoint.updatedAt = new Date().toISOString()
  checkpoint.completedTiers = Object.entries(checkpoint.tiers)
    .filter(([, value]) => value.status === 'success')
    .map(([tierId]) => tierId)
    .sort()
  const temporaryFile = `${checkpointFile}.next-${process.pid}`
  fs.writeFileSync(temporaryFile, `${JSON.stringify(checkpoint, null, 2)}\n`)
  fs.renameSync(temporaryFile, checkpointFile)
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

async function runDagUnlocked(options) {
  const root = path.resolve(options.root)
  const runsRoot = path.resolve(options.runsRoot ?? path.join(root, '.tmp/test-runs'))
  const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'))
  const runDirectory = path.join(runsRoot, runId)
  const checkpointFile = path.join(runDirectory, 'checkpoint.json')
  const tierLogDirectory = path.join(runDirectory, 'tiers')
  const snapshotWorktree = options.snapshotWorktree ?? (() => snapshotGitWorktree(root))
  const runSourceSnapshot = await snapshotWorktree()
  const sourceState = {
    commit: gitHead(root),
    worktreeFingerprint: runSourceSnapshot.fingerprint
  }
  const resources = options.systemResources ?? defaultSystemResources()
  const budget = resourceBudget(resources)
  const maxParallel = Math.max(1, Math.floor(Number(options.maxParallel) || resources.cpuCount || 1))
  const terminationGraceMs = Math.max(0, Number(options.terminationGraceMs) || 5000)
  const mode = options.mode ?? (options.resume === true ? 'resume' : 'fresh')
  if (!['fresh', 'resume'].includes(mode)) throw new Error(`invalid scheduler mode: ${mode}`)
  if (options.resume === true && mode !== 'resume') throw new Error('resume=true requires mode=resume')
  const resume = mode === 'resume'
  const supersedesUniverse = options.supersedesUniverse ?? options.tiers ?? []
  const supersedesErrors = validateSupersedesRules(supersedesUniverse, options.coverageRegistry)
  if (supersedesErrors.length > 0) throw new Error(`invalid supersedes metadata: ${supersedesErrors.join('; ')}`)
  const tiers = applySupersedes(options.tiers ?? [])
  const byId = new Map(tiers.map((tier) => [tier.id, tier]))
  const conservativeRepositoryFingerprint = tiers.some((tier) => effectiveCacheInputs(tier).length === 0)
    ? repositoryInputFingerprint(root)
    : null

  if (!resume) fs.rmSync(runDirectory, { recursive: true, force: true })
  fs.mkdirSync(tierLogDirectory, { recursive: true })
  const previous = resume ? readCheckpoint(checkpointFile) : null
  const checkpoint = {
    schema: checkpointSchema,
    runId,
    targetTierId: options.targetTierId ?? tiers.at(-1)?.id ?? null,
    mode,
    authoritative: mode === 'fresh',
    status: 'running',
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resourceBudget: budget,
    maxParallel,
    sourceState,
    completedTiers: [],
    tiers: {},
    failure: null,
    failurePoint: null
  }
  writeCheckpoint(checkpointFile, checkpoint)

  const pending = [...tiers]
  const completed = new Set()
  const resultFingerprints = new Map()
  const active = new Map()
  const reusedTiers = []
  let firstFailure = null

  const dependenciesReady = (tier) => (tier.dependsOn ?? []).every((dependencyId) => completed.has(dependencyId) || !byId.has(dependencyId))
  const dependencyFingerprint = (tier) => fingerprint((tier.dependsOn ?? []).map((dependencyId) => ({
    id: dependencyId,
    fingerprint: resultFingerprints.get(dependencyId) ?? 'external'
  })))

  const completeReusedTier = (tier, inputFingerprint, dependencyFingerprintValue) => {
    const previousTier = previous?.tiers?.[tier.id]
    const currentOutputs = snapshotTierOutputs(root, tier)
    if (
      previousTier?.status !== 'success'
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
    checkpoint.tiers[tier.id] = {
      ...previousTier,
      reused: true,
      logFile: path.relative(root, path.join(tierLogDirectory, `${tier.id}.log`)).replaceAll(path.sep, '/')
    }
    writeCheckpoint(checkpointFile, checkpoint)
    options.onTierReused?.(tier, checkpoint.tiers[tier.id])
    return true
  }

  const startTier = async (tier) => {
    const tierEnvironment = {
      ...process.env,
      ...(options.env ?? {}),
      ...(options.envForTier?.(tier) ?? {}),
      FSUSBLOG_TEST_SOURCE_COMMIT: sourceState.commit ?? '',
      FSUSBLOG_TEST_SOURCE_FINGERPRINT: sourceState.worktreeFingerprint
    }
    const inputFingerprint = tierInputFingerprint(tier, root, {
      env: tierEnvironment,
      platform: options.platform,
      arch: options.arch,
      nodeVersion: options.nodeVersion,
      repositoryFingerprint: conservativeRepositoryFingerprint
    })
    const dependencyFingerprintValue = dependencyFingerprint(tier)
    if (resume && completeReusedTier(tier, inputFingerprint, dependencyFingerprintValue)) return false

    const ownedOutputs = ownedGeneratedDeclarations(tier, byId)
    if (!resume) cleanFreshOwnedFiles(root, ownedOutputs)
    const beforeOutputProvenance = outputProvenance(root, ownedOutputs)

    const logFile = path.join(tierLogDirectory, `${tier.id}.log`)
    fs.writeFileSync(logFile, '')
    const writeOutput = (chunk, stderr = false) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      fs.appendFileSync(logFile, buffer)
      if (options.teeOutput === true) (stderr ? process.stderr : process.stdout).write(buffer)
    }
    const beforeSnapshot = await snapshotWorktree()
    const startedAt = Date.now()
    const context = { env: tierEnvironment, logFile, writeOutput, runId, runDirectory }
    const execution = options.executeTier
      ? {
          promise: Promise.resolve().then(() => options.executeTier(tier, context)).then(normalizeExecutionResult, (error) => ({ code: 1, signal: null, error })),
          terminate: () => options.abortTier?.(tier)
        }
      : beginSubprocess(tier, {
          root,
          env: tierEnvironment,
          writeOutput,
          terminationGraceMs
        })

    options.onTierStart?.(tier, { startedAt, logFile })
    const entry = {
      tier,
      cancelRequested: false,
      terminate: execution.terminate,
      promise: execution.promise.then(async (executionResult) => {
        const afterSnapshot = await snapshotWorktree()
        return {
          executionResult,
          changedPaths: changedSnapshotPaths(beforeSnapshot, afterSnapshot),
          durationMs: Math.max(0, Date.now() - startedAt),
          inputFingerprint,
          dependencyFingerprint: dependencyFingerprintValue,
          ownedOutputs,
          beforeOutputProvenance,
          logFile
        }
      })
    }
    active.set(tier.id, entry)
    return true
  }

  const recordSettled = (entry, settled) => {
    const { tier } = entry
    const { executionResult, changedPaths, durationMs, inputFingerprint, dependencyFingerprint: dependencyFingerprintValue, ownedOutputs, beforeOutputProvenance, logFile } = settled
    const commandFailed = executionResult.code !== 0 || executionResult.signal || executionResult.error
    const polluted = changedPaths.length > 0
    const cancelled = entry.cancelRequested && firstFailure !== null
    const outputs = snapshotTierOutputs(root, tier)
    const outputInvalid = !commandFailed && outputs.reusable !== true
    const afterOutputProvenance = outputProvenance(root, ownedOutputs)
    const staleOutputs = !commandFailed
      && !outputInvalid
      && ownedOutputs.length > 0
      && beforeOutputProvenance.fingerprint === afterOutputProvenance.fingerprint
    const success = !cancelled && !commandFailed && !polluted && !outputInvalid && !staleOutputs
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

    checkpoint.tiers[tier.id] = {
      status: success ? 'success' : (cancelled ? 'cancelled' : 'failure'),
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
      reused: false
    }
    if (success) {
      completed.add(tier.id)
      resultFingerprints.set(tier.id, resultFingerprint)
    }
    options.onTierComplete?.(tier, checkpoint.tiers[tier.id])
    writeCheckpoint(checkpointFile, checkpoint)
    return { success, cancelled, reason, changedPaths, executionResult }
  }

  while (pending.length > 0 || active.size > 0) {
    if (!firstFailure) {
      let madeProgress = true
      while (madeProgress && active.size < maxParallel) {
        madeProgress = false
        const activeEntries = [...active.values()]
        const barrierPhase = Math.min(
          ...pending.map(tierPhase),
          ...activeEntries.map((entry) => tierPhase(entry.tier))
        )
        const nextIndex = pending.findIndex((tier) => (
          tierPhase(tier) === barrierPhase
          && dependenciesReady(tier)
          && canStartTier(tier, activeEntries, maxParallel, budget)
        ))
        if (nextIndex >= 0) {
          const [nextTier] = pending.splice(nextIndex, 1)
          await startTier(nextTier)
          madeProgress = true
        }
      }
    }

    if (active.size === 0) {
      if (pending.length > 0 && !firstFailure) {
        firstFailure = {
          tierId: pending[0].id,
          exitCode: 1,
          signal: null,
          reason: 'no runnable tiers remain; check DAG dependencies and resource metadata',
          changedPaths: []
        }
      }
      break
    }

    const { tierId, settled } = await Promise.race([...active.entries()].map(([tierId, entry]) => (
      entry.promise.then((settled) => ({ tierId, settled }))
    )))
    const entry = active.get(tierId)
    active.delete(tierId)
    const recorded = recordSettled(entry, settled)
    if (!recorded.success && !recorded.cancelled && !firstFailure) {
      firstFailure = {
        tierId,
        exitCode: recorded.executionResult.code ?? 1,
        signal: recorded.executionResult.signal ?? null,
        reason: recorded.reason,
        changedPaths: recorded.changedPaths
      }
      for (const sibling of active.values()) {
        sibling.cancelRequested = true
        sibling.terminate()
      }
    }
  }

  checkpoint.status = firstFailure ? 'failure' : 'success'
  checkpoint.failure = firstFailure
  checkpoint.failurePoint = firstFailure?.tierId ?? null
  checkpoint.finishedAt = new Date().toISOString()
  writeCheckpoint(checkpointFile, checkpoint)

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
  const runsRoot = path.resolve(options.runsRoot ?? path.join(root, '.tmp/test-runs'))
  const runId = safeRunId(options.runId ?? createRunId(options.targetTierId ?? 'matrix'))
  const releaseLock = acquireRunLock(runsRoot, runId)
  try {
    return await runDagUnlocked({ ...options, root, runsRoot, runId })
  } finally {
    releaseLock()
  }
}
