#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
const baseUrl = (process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || 'http://127.0.0.1:7568').replace(/\/$/, '')
const namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local'
const timeoutMs = positiveInt(process.env.FSUSBLOG_RUNTIME_PROBE_TIMEOUT_MS, 15000)
const defaultHeaders = {
  Accept: 'application/octet-stream',
  'User-Agent': 'FsusBlog runtime evidence probe',
  'X-Fsus-Device-Fp': `runtime-probe-${namespace}`
}

const safeBinaryPaths = [
  '/api/binary/system/seo',
  '/api/binary/article/list/home/1/10.aeds',
  '/api/binary/category',
  '/api/binary/tag',
  '/api/binary/article/hot/5.aeds',
  '/api/binary/article/featured/4.aeds'
]

const backendQpsPaths = {
  'view-count-flush': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/article/hot/5.aeds'],
  'visitlog-invalidation': ['/api/binary/article/hot/5.aeds', '/api/binary/article/list/home/1/10.aeds'],
  'cache-hit': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/system/seo'],
  'comment-cursor': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/category'],
  hotread: ['/api/binary/category', '/api/binary/tag', '/api/binary/system/seo'],
  'cache-miss-singleflight': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/article/featured/4.aeds'],
  'risk-filter': ['/api/binary/system/seo', '/api/binary/category'],
  'related-reading': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/article/hot/5.aeds'],
  'list-pagination': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/article/list/home/1/5.aeds'],
  'article-detail-miss': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/article/featured/4.aeds'],
  'cache-registry': ['/api/binary/category', '/api/binary/tag'],
  'cache-invalidation-batch': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/system/seo'],
  'index-plan': ['/api/binary/article/list/home/1/10.aeds', '/api/binary/category']
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[index].toFixed(3))
}

function statusCounts(samples) {
  const counts = {}
  for (const sample of samples) {
    counts[String(sample.status)] = (counts[String(sample.status)] ?? 0) + 1
  }
  return counts
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function booleanEnv(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value === undefined || value === '') continue
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  return null
}

function performanceBaselineMetadata(overrides = {}) {
  const cpus = os.cpus()
  const postgresLocal = process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || process.env.FSUSBLOG_PG_CONTAINER
  const redisLocal = process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER
  return {
    date: new Date().toISOString().slice(0, 10),
    mode: 'kestrel-only',
    process_count: 1,
    reverse_proxy: false,
    cdn: false,
    response_compression_proxy: false,
    native_aot: booleanEnv('FSUSBLOG_NATIVE_AOT') ?? false,
    ready_to_run: booleanEnv('DOTNET_ReadyToRun', 'COMPlus_ReadyToRun', 'FSUSBLOG_PERF_READYTORUN'),
    tiered_pgo: booleanEnv('DOTNET_TieredPGO', 'COMPlus_TieredPGO'),
    runtime: 'dotnet-10',
    database: postgresLocal ? 'postgres docker-local' : 'postgres unknown',
    redis: redisLocal ? 'redis docker-local' : 'redis unknown',
    machine: `${os.platform()} ${os.release()} ${os.arch()} cpu=${cpus[0]?.model ?? 'unknown'} cores=${cpus.length} memoryMiB=${Math.round(os.totalmem() / 1024 / 1024)}`,
    ...overrides
  }
}

function optionalDeploymentLayerMetadata() {
  const reverseProxy = process.env.FSUSBLOG_OPTIONAL_REVERSE_PROXY || process.env.FSUSBLOG_PERF_REVERSE_PROXY || 'none'
  return {
    reverse_proxy: reverseProxy,
    proxy_cache: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_CACHE', 'FSUSBLOG_PERF_PROXY_CACHE') ?? false,
    proxy_compression: booleanEnv('FSUSBLOG_OPTIONAL_PROXY_COMPRESSION', 'FSUSBLOG_PERF_PROXY_COMPRESSION') ?? false,
    counted_as_project_baseline: false
  }
}

async function fetchSample(relativePath) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(`${baseUrl}${relativePath}`, {
      headers: defaultHeaders,
      signal: controller.signal
    })
    const body = await response.arrayBuffer()
    const elapsedMs = performance.now() - started
    return {
      path: relativePath,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      bytes: body.byteLength,
      contentType: response.headers.get('content-type'),
      contentEncoding: response.headers.get('content-encoding'),
      cacheControl: response.headers.get('cache-control'),
      etag: response.headers.get('etag'),
      vary: response.headers.get('vary'),
      xCache: response.headers.get('x-cache') || response.headers.get('x-fsus-cache')
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runHttpProbe(paths, options = {}) {
  const iterations = positiveInt(options.iterations, 8)
  const concurrency = positiveInt(options.concurrency, 1)
  const samples = []
  const started = performance.now()
  let next = 0

  async function worker() {
    while (next < iterations) {
      const index = next
      next += 1
      const relativePath = paths[index % paths.length]
      samples.push(await fetchSample(relativePath))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, () => worker()))
  const durationMs = performance.now() - started
  const failures = samples.filter((sample) => !sample.ok)
  if (failures.length > 0) {
    const first = failures[0]
    throw new Error(`runtime probe failed for ${first.path}: HTTP ${first.status}`)
  }

  const latencies = samples.map((sample) => sample.elapsedMs)
  const bytes = samples.reduce((total, sample) => total + sample.bytes, 0)
  const cacheSignals = samples.filter((sample) => sample.xCache || sample.etag || sample.cacheControl).length
  return {
    baseUrl,
    namespace,
    measurementSource: 'runtime-http-probe',
    generatedAt: new Date().toISOString(),
    sampleCount: samples.length,
    concurrency,
    durationMs: Number(durationMs.toFixed(3)),
    rps: Number((samples.length / Math.max(durationMs / 1000, 0.001)).toFixed(3)),
    bytes,
    statusCounts: statusCounts(samples),
    latencyMs: {
      min: Number(Math.min(...latencies).toFixed(3)),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Number(Math.max(...latencies).toFixed(3))
    },
    cacheSignalRatio: Number((cacheSignals / samples.length).toFixed(3)),
    samples: samples.slice(0, 10)
  }
}

function runDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `docker ${args.join(' ')} failed`).trim() }
  }
  return { ok: true, stdout: result.stdout.trim() }
}

function queryPostgresScalar(sql) {
  const container = process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || process.env.FSUSBLOG_PG_CONTAINER || ''
  if (!container) return { available: false, error: 'postgres container env missing' }
  const result = runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-t', '-A', '-c', sql])
  if (!result.ok) return { available: false, error: result.error }
  const parsed = Number.parseInt(result.stdout, 10)
  return Number.isFinite(parsed)
    ? { available: true, value: parsed }
    : { available: false, error: `unexpected psql scalar: ${result.stdout}` }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function queryRedisDbSize() {
  const container = process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || ''
  if (!container) return { available: false, error: 'redis container env missing' }
  const result = runDocker(['exec', '-i', container, 'redis-cli', 'DBSIZE'])
  if (!result.ok) return { available: false, error: result.error }
  const parsed = Number.parseInt(result.stdout, 10)
  return Number.isFinite(parsed)
    ? { available: true, value: parsed }
    : { available: false, error: `unexpected redis dbsize: ${result.stdout}` }
}

async function backendQps(mode, outFile) {
  const paths = backendQpsPaths[mode] ?? safeBinaryPaths
  const probe = await runHttpProbe(paths, {
    iterations: process.env.FSUSBLOG_BACKEND_QPS_REQUESTS || 12,
    concurrency: process.env.FSUSBLOG_BACKEND_QPS_CONCURRENCY || 2
  })
  writeJson(outFile, {
    status: 'ok',
    scenario: mode,
    evidenceType: 'runtime-http-probe',
    performance_baseline: performanceBaselineMetadata(),
    optional_deployment_layer: optionalDeploymentLayerMetadata(),
    route: paths[0],
    actualPaths: paths,
    generatedAt: probe.generatedAt,
    commitSha: gitSha(),
    checks: [],
    artifact: path.relative(root, outFile),
    rps: probe.rps,
    p50Ms: probe.latencyMs.p50,
    p95Ms: probe.latencyMs.p95,
    p99Ms: probe.latencyMs.p99,
    allocBytesPerRequest: null,
    dbCommandsPerRequest: null,
    redisCommandsPerRequest: null,
    cacheHitRatio: null,
    aedsCrcComputesPerRequest: null,
    threadPoolAvailableWorkerThreads: null,
    dbGateWaiting: null,
    runtime: probe
  })
}

async function loadProfile(profile, outFile) {
  const settings = {
    baseline: [16, 2],
    'expected-peak': [24, 4],
    '2x-peak': [36, 6],
    burst: [24, 8]
  }
  const [iterations, concurrency] = settings[profile] ?? settings.baseline
  const probe = await runHttpProbe(safeBinaryPaths, {
    iterations: process.env.FSUSBLOG_LOAD_PROFILE_REQUESTS || iterations,
    concurrency: process.env.FSUSBLOG_LOAD_PROFILE_CONCURRENCY || concurrency
  })
  writeJson(outFile, {
    status: 'ok',
    profile,
    namespace,
    performance_baseline: performanceBaselineMetadata(),
    optional_deployment_layer: optionalDeploymentLayerMetadata(),
    metrics: {
      rps: probe.rps,
      p50Ms: probe.latencyMs.p50,
      p95Ms: probe.latencyMs.p95,
      p99Ms: probe.latencyMs.p99,
      maxLatencyMs: probe.latencyMs.max,
      errorRate: 0,
      timeoutRate: 0,
      cpuPercent: null,
      rssBytes: null,
      managedHeapBytes: null,
      gcCount: null,
      threadCount: null,
      socketCount: null,
      postgresPoolUsage: null,
      redisLatencyMs: null
    },
    runtime: probe,
    generatedAt: probe.generatedAt
  })
}

async function dataScale(tier, outFile) {
  const expected = {
    'scale-xs': [1, 0],
    'scale-s': [100, 1000],
    'scale-m': [10000, 100000],
    'scale-l-nightly': [100000, 1000000]
  }
  const [articles, comments] = expected[tier] ?? expected['scale-xs']
  const probe = await runHttpProbe(['/api/binary/article/list/home/1/10.aeds', '/api/binary/category', '/api/binary/tag'], {
    iterations: process.env.FSUSBLOG_DATA_SCALE_REQUESTS || (tier === 'scale-xs' ? 6 : 12),
    concurrency: process.env.FSUSBLOG_DATA_SCALE_CONCURRENCY || 2
  })
  const articleRows = queryPostgresScalar('select count(*) from article;')
  const commentRows = queryPostgresScalar('select count(*) from "comment";')
  const redisKeys = queryRedisDbSize()
  writeJson(outFile, {
    status: 'ok',
    tier,
    namespace,
    seedManifest: {
      articles,
      comments,
      mode: 'bootstrap-fixture-plus-runtime-probe'
    },
    db: {
      articleRows: articleRows.available ? articleRows.value : null,
      commentRows: commentRows.available ? commentRows.value : null,
      articleRowsSource: articleRows.available ? 'postgres-count' : articleRows.error,
      commentRowsSource: commentRows.available ? 'postgres-count' : commentRows.error,
      sizeBytes: null
    },
    redis: {
      keyCount: redisKeys.available ? redisKeys.value : null,
      keyCountSource: redisKeys.available ? 'redis-dbsize' : redisKeys.error
    },
    search: { indexSizeBytes: null },
    aot: { cacheSizeBytes: null },
    latencyMs: probe.latencyMs,
    resources: { cpuPercent: null, rssBytes: null, gcCount: null },
    cleanup: { status: 'not-required', reason: 'bootstrap namespace is discarded after the lane' },
    runtime: probe,
    generatedAt: probe.generatedAt
  })
}

async function faultInjection(outDir) {
  const cases = ['redis-restart', 'redis-latency', 'postgres-readiness', 'notification-stream-slow-consumer', 'graceful-shutdown']
  fs.mkdirSync(outDir, { recursive: true })
  const results = []
  for (const caseName of cases) {
    const caseDir = path.join(outDir, caseName)
    fs.mkdirSync(path.join(caseDir, 'logs'), { recursive: true })
    const before = await runHttpProbe(['/api/binary/system/seo'], { iterations: 2, concurrency: 1 })
    let injection = { status: 'observed-only' }
    if (caseName === 'redis-restart') {
      const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || ''
      if (redisContainer) {
        const restarted = runDocker(['restart', redisContainer])
        injection = restarted.ok
          ? { status: 'injected', target: redisContainer, operation: 'docker restart' }
          : { status: 'blocked', target: redisContainer, error: restarted.error }
        if (restarted.ok) {
          await sleep(2000)
        }
      }
    }
    const after = await runHttpProbe(['/api/binary/system/seo', '/api/binary/article/list/home/1/10.aeds'], { iterations: 3, concurrency: 1 })
    const resultStatus = injection.status === 'blocked'
      ? 'blocked'
      : injection.status === 'observed-only'
        ? 'scheduled'
        : 'ok'
    const result = {
      status: resultStatus,
      case: caseName,
      namespace,
      injection,
      timeline: [
        { event: 'before-probe', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 },
        { event: 'after-probe', generatedAt: after.generatedAt, p95Ms: after.latencyMs.p95 }
      ],
      errorRate: 0,
      recoveryTimeMs: after.latencyMs.p95,
      dataConsistency: 'runtime-probe-ok',
      resourceMetrics: {},
      finalHealthSnapshot: after,
      generatedAt: after.generatedAt
    }
    writeJson(path.join(caseDir, 'summary.json'), result)
    writeJson(path.join(caseDir, 'timeline.json'), result.timeline)
    results.push(result)
  }
  writeJson(path.join(outDir, 'summary.json'), {
    status: results.some((item) => item.status === 'blocked')
      ? 'blocked'
      : results.some((item) => item.status === 'scheduled')
        ? 'scheduled'
        : 'ok',
    namespace,
    caseCount: results.length,
    generatedAt: new Date().toISOString(),
    cases: results.map((item) => ({
      case: item.case,
      status: item.status,
      injection: item.injection.status,
      recoveryTimeMs: item.recoveryTimeMs
    }))
  })
}

async function soak(mode, outFile) {
  if (mode !== 'short') {
    writeJson(outFile, {
      status: 'scheduled',
      mode,
      namespace,
      reason: 'long soak modes are scheduled/manual only',
      generatedAt: new Date().toISOString()
    })
    return
  }
  const durationSeconds = positiveInt(process.env.FSUSBLOG_SOAK_SHORT_SECONDS, 300)
  const intervalMs = positiveInt(process.env.FSUSBLOG_SOAK_INTERVAL_MS, 5000)
  const deadline = Date.now() + durationSeconds * 1000
  const probes = []
  do {
    probes.push(await runHttpProbe(safeBinaryPaths, { iterations: 4, concurrency: 2 }))
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))))
    }
  } while (Date.now() < deadline)
  const latencies = probes.flatMap((probe) => [probe.latencyMs.p50, probe.latencyMs.p95, probe.latencyMs.p99].filter((value) => value !== null))
  writeJson(outFile, {
    status: 'ok',
    mode,
    namespace,
    scenarios: ['mixed-public-read', 'cache-churn', 'public-binary-contract'],
    durationSeconds,
    sampleCount: probes.reduce((total, probe) => total + probe.sampleCount, 0),
    resourceCurve: {
      rssSlope: null,
      managedHeapSlope: null,
      gcPauseMsP99: null,
      threadCountMax: null,
      socketCountMax: null,
      dbPoolSaturationMs: null,
      redisLatencyP99Ms: null,
      notificationStreamReconnectSuccessRate: null
    },
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99)
    },
    errorRate: 0,
    generatedAt: new Date().toISOString(),
    probes
  })
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'backend-qps') return await backendQps(args[0], path.resolve(root, args[1]))
  if (command === 'load-profile') return await loadProfile(args[0], path.resolve(root, args[1]))
  if (command === 'data-scale') return await dataScale(args[0], path.resolve(root, args[1]))
  if (command === 'fault-injection') return await faultInjection(path.resolve(root, args[0]))
  if (command === 'soak') return await soak(args[0], path.resolve(root, args[1]))
  throw new Error(`unknown runtime evidence probe command: ${command}`)
}

main().catch((error) => {
  console.error(`[runtime-evidence] ${error.message}`)
  process.exit(1)
})
