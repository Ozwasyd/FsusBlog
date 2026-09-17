import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const productionFreshOutputRoot = String(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT ?? '').trim()
const reportRoot = productionFreshOutputRoot
  ? pathToFileURL(`${path.join(path.resolve(productionFreshOutputRoot), 'reports', 'vitest')}${path.sep}`)
  : new URL('../../.tmp/test-results/vitest/', import.meta.url)

export const frontendTestSupportRoot = path.join(repositoryRoot, 'tests/frontend/support')

export function resolveVitestCoverageDirectory(relativeDirectory) {
  const normalized = String(relativeDirectory ?? '').replace(/^coverage\/?/u, '')
  return productionFreshOutputRoot
    ? path.join(path.resolve(productionFreshOutputRoot), 'coverage', 'vitest', normalized)
    : relativeDirectory
}

export function resolveFrontendTestSupportFile(relativeFile) {
  if (typeof relativeFile !== 'string' || relativeFile.trim() === '' || path.isAbsolute(relativeFile)) {
    throw new Error('frontend test support path must be a non-empty relative path')
  }

  const resolved = path.resolve(frontendTestSupportRoot, relativeFile)
  const relative = path.relative(frontendTestSupportRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`frontend test support path escapes the canonical support root: ${relativeFile}`)
  }
  return resolved
}

export const frontendUnitSetupFile = resolveFrontendTestSupportFile('unit/setup.ts')
export const frontendTestDependencyDedupe = ['happy-dom']

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function sanitizeSegment(value, fallback) {
  const sanitized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return sanitized || fallback
}

export function resolveVitestWorkerCount({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  load1 = os.loadavg()[0] ?? 0
} = {}) {
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const grantedCpu = resolvePositiveGrant(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ])
  const grantedMemoryGiB = resolvePositiveGrant(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ])
  const schedulerManaged = grantedCpu !== undefined
  const cpuCap = Math.max(1, Math.floor(Math.min(cpus, grantedCpu ?? cpus)))
  const usableMemoryBytes = Math.max(0, Math.min(
    Number(freeMemoryBytes) || 0,
    grantedMemoryGiB === undefined
      ? Number(freeMemoryBytes) || 0
      : grantedMemoryGiB * 1024 ** 3))
  const normalizedTotalMemoryBytes = Math.max(0, Number(totalMemoryBytes) || 0)
    || Math.max(0, Number(freeMemoryBytes) || 0)
  const machineMemoryPerCpu = Math.max(1, normalizedTotalMemoryBytes / cpus)
  // The scheduler has already admitted the step against both live CPU and memory.
  // Applying the host-wide average again would double-count memory pressure and can
  // collapse a multi-CPU step to one worker after sibling steps consume their grants.
  const memoryCap = schedulerManaged
    ? cpuCap
    : Math.max(1, Math.floor(usableMemoryBytes / machineMemoryPerCpu))
  const loadCap = schedulerManaged
    ? cpuCap
    : Math.max(1, Math.floor(cpus - Math.max(0, Number(load1) || 0)))
  const override = positiveInteger(env.FSUSBLOG_VITEST_MAX_WORKERS ?? env.VITEST_MAX_WORKERS)
  const configuredCap = positiveInteger(env.FSUSBLOG_VITEST_WORKER_CAP)

  return Math.max(1, Math.min(
    cpuCap,
    memoryCap,
    loadCap,
    override ?? cpuCap,
    configuredCap ?? cpuCap))
}

export function createVitestRuntimeOptions(lane, {
  env = process.env,
  argv = process.argv,
  cpuCount,
  freeMemoryBytes,
  totalMemoryBytes,
  load1
} = {}) {
  const coverage = argv.includes('--coverage')
  const diagnostic = env.FSUSBLOG_VITEST_DIAGNOSTIC === '1'
  const reportLane = coverage
    ? `${lane}-coverage`
    : (diagnostic ? `${lane}-diagnostic` : lane)
  const normalizedLane = sanitizeSegment(env.FSUSBLOG_VITEST_LANE ?? reportLane, 'vitest')
  const shardIndex = positiveInteger(env.FSUSBLOG_TEST_SHARD_INDEX)
  const shardTotal = positiveInteger(env.FSUSBLOG_TEST_SHARD_TOTAL)
  const shard = shardIndex && shardTotal
    ? `shard-${shardIndex}-of-${shardTotal}`
    : sanitizeSegment(env.FSUSBLOG_VITEST_REPORT_ID, 'unsharded')
  const laneRoot = new URL(`${normalizedLane}/`, reportRoot)

  return {
    maxWorkers: resolveVitestWorkerCount({ env, cpuCount, freeMemoryBytes, totalMemoryBytes, load1 }),
    bail: 0,
    reporters: ['default', 'json', 'junit'],
    outputFile: {
      json: fileURLToPath(new URL(`${shard}.json`, laneRoot)),
      junit: fileURLToPath(new URL(`${shard}.xml`, laneRoot))
    }
  }
}

function resolvePositiveGrant(env, names) {
  for (const name of names) {
    const value = env[name]
    if (value === undefined || value === null || String(value).trim() === '') continue
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite number, got ${value}`)
    }
    return parsed
  }
  return undefined
}
