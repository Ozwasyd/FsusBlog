import os from 'node:os'
import { fileURLToPath } from 'node:url'

const gibibyte = 1024 ** 3
const defaultWorkerMemoryBytes = Math.floor(1.5 * gibibyte)
const reportRoot = new URL('../../.tmp/test-results/vitest/', import.meta.url)

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
  load1 = os.loadavg()[0] ?? 0
} = {}) {
  const override = positiveInteger(env.FSUSBLOG_VITEST_MAX_WORKERS ?? env.VITEST_MAX_WORKERS)
  if (override) return override

  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const memoryPerWorker = positiveInteger(env.FSUSBLOG_VITEST_MEMORY_PER_WORKER_BYTES)
    ?? defaultWorkerMemoryBytes
  const memoryCap = Math.max(1, Math.floor(Math.max(0, Number(freeMemoryBytes) || 0) / memoryPerWorker))
  const loadCap = Math.max(1, Math.floor(cpus - Math.max(0, Number(load1) || 0)))
  const configuredCap = positiveInteger(env.FSUSBLOG_VITEST_WORKER_CAP)
    ?? (String(env.CI ?? '').toLowerCase() === 'true' ? 4 : 8)

  return Math.max(1, Math.min(cpus, memoryCap, loadCap, configuredCap))
}

export function createVitestRuntimeOptions(lane, {
  env = process.env,
  argv = process.argv,
  cpuCount,
  freeMemoryBytes,
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
    maxWorkers: resolveVitestWorkerCount({ env, cpuCount, freeMemoryBytes, load1 }),
    bail: 0,
    reporters: ['default', 'json', 'junit'],
    outputFile: {
      json: fileURLToPath(new URL(`${shard}.json`, laneRoot)),
      junit: fileURLToPath(new URL(`${shard}.xml`, laneRoot))
    }
  }
}
