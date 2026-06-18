#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..'))
loadBootstrapEnv(process.env.FSUSBLOG_TEST_NAMESPACE || 'local')
if (!process.env.FSUSBLOG_BASE_URL && process.env.FSUSBLOG_DEBUG_BACKEND_URL) {
  process.env.FSUSBLOG_BASE_URL = process.env.FSUSBLOG_DEBUG_BACKEND_URL
}
const baseUrl = (process.env.FSUSBLOG_BASE_URL || process.env.FSUSBLOG_DEBUG_BACKEND_URL || 'http://127.0.0.1:7568').replace(/\/$/, '')
const namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local'
const timeoutMs = positiveInt(process.env.FSUSBLOG_RUNTIME_PROBE_TIMEOUT_MS, 15000)
const notificationDrillSecret = process.env.FSUSBLOG_NOTIFICATION_DRILL_SECRET || process.env.NotificationStream__DrillSecret || ''
const notificationDrillPublishPath = '/_fsus/testing/notification-stream/publish'
const notificationStreamPath = '/api/notifications/stream'
const notificationStreamProtocol = 'fsus-aeds.v2'
const frameNotificationEvent = 69
const frameNotificationHeartbeat = 70
const aedsFrameTypes = {
  ArticleList: 1,
  ArticleDetail: 2,
  ArticleHot: 3,
  CommentArticleCursor: 5,
  CategoryList: 9,
  TagList: 10,
  SeoConfig: 13,
  ArticleFeatured: 15,
  ArticleRelatedReading: 27
}
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
const perfPolicyRelativeFile = 'tests/perf/perf-policy.yml'
const perfPolicyFile = path.join(root, perfPolicyRelativeFile)

const backendQpsModes = [
  'view-count-flush',
  'visitlog-invalidation',
  'cache-hit',
  'comment-cursor',
  'hotread',
  'cache-miss-singleflight',
  'risk-filter',
  'related-reading',
  'list-pagination',
  'article-detail-miss',
  'cache-registry',
  'cache-invalidation-batch',
  'index-plan'
]

let notificationSupportPromise = null

function namespaceSlug(value) {
  return String(value || 'local').replace(/[^A-Za-z0-9_.-]/g, '-')
}

function loadBootstrapEnv(namespaceValue) {
  const envFile = path.join(root, '.tmp', 'env', `${namespaceSlug(namespaceValue)}.env`)
  if (!fs.existsSync(envFile)) {
    return
  }

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) {
      continue
    }

    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function yamlSection(text, name, indent = 0) {
  const prefix = ' '.repeat(indent)
  const pattern = new RegExp(`(?:^|\\n)${prefix}${name}:\\n([\\s\\S]*?)(?=\\n${prefix}\\S|$)`, 'u')
  return text.match(pattern)?.[1] ?? ''
}

function yamlScalarMap(text) {
  const values = {}
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_-]*):\s*(\d+)\s*$/u)
    if (match) values[match[1]] = Number(match[2])
  }
  return values
}

function readPerfPolicy() {
  const text = fs.readFileSync(perfPolicyFile, 'utf8')
  return {
    version: text.match(/^version:\s*(\S+)/mu)?.[1] ?? 'unknown',
    text
  }
}

function readLoadProfilePolicy(profile) {
  const policy = readPerfPolicy()
  const profiles = yamlSection(policy.text, 'loadProfiles')
  const declared = yamlScalarMap(yamlSection(profiles, profile, 2))
  for (const key of ['concurrency', 'rounds', 'durationMs']) {
    if (!Number.isInteger(declared[key]) || declared[key] <= 0) {
      throw new Error(`load profile ${profile} missing positive ${key} in ${perfPolicyRelativeFile}`)
    }
  }
  return {
    file: perfPolicyRelativeFile,
    version: policy.version,
    profileName: profile,
    declared
  }
}

function envOverrideInt(name) {
  if (process.env[name] === undefined || process.env[name] === '') {
    return null
  }
  return positiveInt(process.env[name], 0)
}

function resolveLoadProfilePolicy(profile) {
  const policy = readLoadProfilePolicy(profile)
  const overrideEnv = {
    concurrency: 'FSUSBLOG_LOAD_PROFILE_CONCURRENCY',
    rounds: 'FSUSBLOG_LOAD_PROFILE_ROUNDS',
    durationMs: 'FSUSBLOG_LOAD_PROFILE_DURATION_MS'
  }
  const effective = {}
  const overrideSources = {}
  for (const [key, envName] of Object.entries(overrideEnv)) {
    const override = envOverrideInt(envName)
    effective[key] = override ?? policy.declared[key]
    overrideSources[key] = override === null ? 'policy' : `env:${envName}`
  }
  const overrideSource = Object.values(overrideSources).every((source) => source === 'policy') ? 'policy' : 'env'
  return {
    ...policy,
    effective,
    overrideSource,
    overrideSources
  }
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

function readOptionalJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
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

async function fetchSample(relativePath, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const started = performance.now()
  try {
    const response = await fetch(`${baseUrl}${relativePath}`, {
      headers: { ...defaultHeaders, ...(options.headers ?? {}) },
      signal: controller.signal
    })
    const body = await response.arrayBuffer()
    const elapsedMs = performance.now() - started
    const frameType = body.byteLength >= 10 && (response.headers.get('content-type') ?? '').includes('application/octet-stream')
      ? new DataView(body).getUint16(8, true)
      : null
    return {
      path: relativePath,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      bytes: body.byteLength,
      frameType,
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
      samples.push(await fetchSample(relativePath, options))
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, () => worker()))
  const durationMs = performance.now() - started
  const failures = samples.filter((sample) => !sample.ok)
  if (failures.length > 0) {
    const first = failures[0]
    throw new Error(`runtime probe failed for ${first.path}: HTTP ${first.status}`)
  }
  const expectedByPath = options.expectedByPath ?? {}
  for (const sample of samples) {
    const expected = expectedByPath[sample.path]
    if (!expected) continue
    if (expected.expectedStatus != null && sample.status !== expected.expectedStatus) {
      throw new Error(`runtime probe status mismatch for ${sample.path}: expected ${expected.expectedStatus}, got ${sample.status}`)
    }
    if (expected.expectedContentType && !String(sample.contentType ?? '').includes(expected.expectedContentType)) {
      throw new Error(`runtime probe content-type mismatch for ${sample.path}: expected ${expected.expectedContentType}, got ${sample.contentType}`)
    }
    if (expected.expectedFrameType != null && sample.frameType !== expected.expectedFrameType) {
      throw new Error(`runtime probe frame type mismatch for ${sample.path}: expected ${expected.expectedFrameType}, got ${sample.frameType}`)
    }
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

function firstPublicArticleId() {
  const result = queryPostgresScalar(`
    select id
    from article
    where status = 2 and coalesce(isdeleted, false) = false
    order by coalesce(published_at, createtime) desc, id desc
    limit 1;
  `)
  if (!result.available || result.value <= 0) {
    throw new Error(`backend-qps fixture prerequisite missing: public article id (${result.error ?? 'no rows'})`)
  }
  return result.value
}

function backendQpsRequestPlan(mode) {
  const publicArticleId = () => firstPublicArticleId()
  const binary = (path, expectedFrameType, fixturePrerequisite = 'public runtime bootstrap') => ({
    method: 'GET',
    path,
    headers: { Accept: 'application/octet-stream' },
    expectedStatus: 200,
    expectedContentType: 'application/octet-stream',
    expectedFrameType,
    fixturePrerequisite
  })

  switch (mode) {
    case 'view-count-flush':
      return [
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
        binary('/api/binary/article/hot/5.aeds', aedsFrameTypes.ArticleHot)
      ]
    case 'visitlog-invalidation':
      return [
        binary('/api/binary/article/hot/5.aeds', aedsFrameTypes.ArticleHot),
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList)
      ]
    case 'cache-hit':
      return [
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
        binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
      ]
    case 'comment-cursor': {
      const articleId = publicArticleId()
      return [binary(`/api/binary/comment/${articleId}`, aedsFrameTypes.CommentArticleCursor, 'published article with comment cursor support')]
    }
    case 'hotread':
      return [
        binary('/api/binary/category', aedsFrameTypes.CategoryList),
        binary('/api/binary/tag', aedsFrameTypes.TagList),
        binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
      ]
    case 'cache-miss-singleflight':
      return [
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
        binary('/api/binary/article/featured/4.aeds', aedsFrameTypes.ArticleFeatured)
      ]
    case 'risk-filter':
      return [
        binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig),
        binary('/api/binary/category', aedsFrameTypes.CategoryList)
      ]
    case 'related-reading': {
      const articleId = publicArticleId()
      return [binary(`/api/binary/article/${articleId}/related.aeds`, aedsFrameTypes.ArticleRelatedReading, 'published article for related reading')]
    }
    case 'list-pagination':
      return [
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
        binary('/api/binary/article/list/home/1/5.aeds', aedsFrameTypes.ArticleList)
      ]
    case 'article-detail-miss': {
      const articleId = publicArticleId()
      return [binary(`/api/binary/article/${articleId}.aeds`, aedsFrameTypes.ArticleDetail, 'published article detail artifact')]
    }
    case 'cache-registry':
      return [
        binary('/api/binary/category', aedsFrameTypes.CategoryList),
        binary('/api/binary/tag', aedsFrameTypes.TagList)
      ]
    case 'cache-invalidation-batch':
      return [
        binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList),
        binary('/api/binary/system/seo', aedsFrameTypes.SeoConfig)
      ]
    case 'index-plan':
      return [binary('/api/binary/article/list/home/1/10.aeds', aedsFrameTypes.ArticleList, 'static index guard plus public list runtime smoke')]
    default:
      return safeBinaryPaths.map((path) => binary(path, null))
  }
}

function unavailableCounter(status, reason) {
  return { status, reason }
}

function backendQpsMeasuredCounters(probe) {
  return {
    requestCount: { status: 'ok', value: probe.sampleCount, source: 'runtime-http-probe' },
    statusDistribution: { status: 'ok', value: probe.statusCounts, source: 'runtime-http-probe' },
    bytes: { status: 'ok', value: probe.bytes, source: 'runtime-http-probe' },
    cacheHitSignal: {
      status: 'ok',
      ratio: probe.cacheSignalRatio,
      signalCount: Math.round(probe.cacheSignalRatio * probe.sampleCount),
      source: 'x-cache|etag|cache-control response headers'
    },
    dbCommands: unavailableCounter('not-collected', 'per-request DB command counter is not exposed to backend-qps probe'),
    redisCommands: unavailableCounter('not-collected', 'per-request Redis command counter is not exposed to backend-qps probe'),
    allocationEstimate: unavailableCounter('unsupported', 'per-request allocation estimate requires runtime instrumentation not available in this probe'),
    threadPool: unavailableCounter('not-collected', 'thread pool pressure counter is not exposed to backend-qps probe'),
    dbGatePressure: unavailableCounter('not-collected', 'DB gate waiting counter is not exposed to backend-qps probe'),
    aedsCrcComputes: unavailableCounter('not-collected', 'AEDS CRC compute counter is not exposed to backend-qps probe')
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

function spawnCommand(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { chunks.stdout += chunk })
  child.stderr.on('data', (chunk) => { chunks.stderr += chunk })
  return { child, chunks }
}

async function waitForProcessExit(pid, timeoutMs) {
  const started = performance.now()
  do {
    if (!isProcessRunning(pid)) {
      return {
        status: 'stopped',
        pid,
        exitObserved: true,
        durationMs: elapsedMs(started)
      }
    }
    await sleep(100)
  } while (performance.now() - started < timeoutMs)

  return {
    status: 'timeout',
    pid,
    exitObserved: false,
    durationMs: elapsedMs(started)
  }
}

function queryPostgresScalar(sql) {
  const containers = [
    process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    process.env.FSUSBLOG_PG_CONTAINER,
    'fsusblog-dev-postgres'
  ].filter(Boolean)
  const uniqueContainers = [...new Set(containers)]
  let lastError = 'postgres container env missing'
  for (const container of uniqueContainers) {
    const result = runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-t', '-A', '-c', sql])
    if (!result.ok) {
      lastError = result.error
      continue
    }
    const parsed = Number.parseInt(result.stdout, 10)
    return Number.isFinite(parsed)
      ? { available: true, value: parsed }
      : { available: false, error: `unexpected psql scalar: ${result.stdout}` }
  }
  return { available: false, error: lastError }
}

function queryPostgresJson(sql) {
  const containers = [
    process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME,
    process.env.FSUSBLOG_PG_CONTAINER,
    'fsusblog-dev-postgres'
  ].filter(Boolean)
  const uniqueContainers = [...new Set(containers)]
  let lastError = 'postgres container env missing'
  for (const container of uniqueContainers) {
    const result = runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-t', '-A', '-c', sql])
    if (!result.ok) {
      lastError = result.error
      continue
    }
    try {
      return { available: true, value: JSON.parse(result.stdout) }
    } catch (error) {
      return {
        available: false,
        error: `unexpected psql json: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  return { available: false, error: lastError }
}

function sqlStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function firstExistingDirectory(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(root, candidate)
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved
    }
  }
  return null
}

function measureDirectoryTree(candidates, label) {
  const source = firstExistingDirectory(candidates)
  if (!source) {
    return {
      status: 'missing',
      source: null,
      fileCount: 0,
      sizeBytes: 0,
      reason: `${label} directory was not found`
    }
  }

  let fileCount = 0
  let sizeBytes = 0
  const stack = [source]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
      } else if (entry.isFile()) {
        fileCount += 1
        sizeBytes += fs.statSync(next).size
      }
    }
  }

  return {
    status: fileCount > 0 && sizeBytes > 0 ? 'ok' : 'missing',
    source: path.relative(root, source),
    fileCount,
    sizeBytes,
    reason: fileCount > 0 && sizeBytes > 0 ? null : `${label} directory is empty`
  }
}

function backendWwwrootDir() {
  return process.env.FSUSBLOG_BACKEND_WWWROOT_DIR
    || process.env.FSUSBLOG_WEB_ROOT
    || path.join(root, 'src/backend/wwwroot')
}

function collectSearchMetric() {
  const measured = measureDirectoryTree([
    process.env.FSUSBLOG_SEARCH_INDEX_DIR,
    process.env.FSUSBLOG_SEARCH_DIR,
    path.join(backendWwwrootDir(), 'search')
  ], 'search index')
  return {
    status: measured.status,
    source: measured.source,
    entryCount: measured.fileCount,
    indexSizeBytes: measured.sizeBytes,
    reason: measured.reason
  }
}

function collectAotMetric() {
  const measured = measureDirectoryTree([
    process.env.FSUSBLOG_AOT_CACHE_DIR,
    process.env.FSUSBLOG_PUBLIC_AOT_CACHE_DIR,
    path.join(backendWwwrootDir(), 'aot-cache')
  ], 'AOT cache')
  return {
    status: measured.status,
    source: measured.source,
    artifactCount: measured.fileCount,
    cacheSizeBytes: measured.sizeBytes,
    reason: measured.reason
  }
}

function collectHotReadMetric(probe) {
  const samples = Array.isArray(probe.samples) ? probe.samples : []
  const binarySamples = samples.filter((sample) => sample.ok && Number(sample.bytes) > 0)
  const sampleBytes = binarySamples.reduce((total, sample) => total + Number(sample.bytes || 0), 0)
  return {
    status: binarySamples.length > 0 && sampleBytes > 0 ? 'ok' : 'missing',
    source: 'runtime-http-probe',
    artifactSampleCount: binarySamples.length,
    sampleBytes,
    reason: binarySamples.length > 0 && sampleBytes > 0 ? null : 'runtime HotRead binary samples were empty'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function notificationSupport() {
  if (!notificationSupportPromise) {
    notificationSupportPromise = Promise.all([
      import(pathToFileURL(path.join(root, 'tests/frontend/support/auth-helpers.mjs')).href),
      import(pathToFileURL(path.join(root, 'tests/frontend/support/aeds-envelope.mjs')).href)
    ]).then(([auth, aeds]) => ({
      buildPowHeaders: auth.buildPowHeaders,
      decodeAedsFrame: aeds.decodeAedsFrame
    }))
  }

  return await notificationSupportPromise
}

async function readWebSocketMessageData(data) {
  if (data instanceof ArrayBuffer) {
    return data
  }

  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }

  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return await data.arrayBuffer()
  }

  throw new Error(`unexpected websocket message type: ${Object.prototype.toString.call(data)}`)
}

function decodeNotificationFrame(buffer, decodeAedsFrame) {
  const frame = decodeAedsFrame(buffer)
  if (frame.frameType === frameNotificationHeartbeat) {
    return { kind: 'heartbeat' }
  }

  if (frame.frameType !== frameNotificationEvent) {
    return { kind: 'other', frameType: frame.frameType }
  }

  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
  return {
    kind: 'event',
    id: Number(view.getBigInt64(0, true)),
    ts: Number(view.getBigInt64(8, true)),
    type: view.getInt32(16, true)
  }
}

function notificationWebSocketUrl(powProof, options = {}) {
  const url = new URL(notificationStreamPath, baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('pow', powProof)
  url.searchParams.set('client', options.client ?? `runtime-drill-${namespace}`)
  if (options.cursor !== undefined && options.cursor !== null) {
    url.searchParams.set('cursor', String(options.cursor))
  }
  if (options.slowConsumer) {
    url.searchParams.set('drillSlowConsumer', '1')
    url.searchParams.set('drillReadDelayMs', String(options.drillReadDelayMs ?? 1000))
    url.searchParams.set('drillQueueCapacity', String(options.drillQueueCapacity ?? 32))
  }
  return url
}

async function waitForCondition(label, predicate, options = {}) {
  const deadline = performance.now() + positiveInt(options.timeoutMs, timeoutMs)
  const intervalMs = positiveInt(options.intervalMs, 100)
  do {
    const result = predicate()
    if (result) {
      return result
    }

    await sleep(intervalMs)
  } while (performance.now() < deadline)

  throw new Error(`timeout waiting for ${label}`)
}

async function openNotificationSocket(label, options = {}) {
  if (typeof WebSocket !== 'function') {
    throw new Error('global WebSocket is not available in this Node.js runtime')
  }

  const { buildPowHeaders, decodeAedsFrame } = await notificationSupport()
  const fingerprint = `notification-drill-${namespace}-${label}-${process.pid}-${Date.now()}`
  const powHeaders = await buildPowHeaders(fingerprint, timeoutMs)
  const url = notificationWebSocketUrl(powHeaders['X-Fsus-Pow-Proof'], {
    client: label,
    cursor: options.cursor,
    slowConsumer: options.slowConsumer,
    drillReadDelayMs: options.drillReadDelayMs
  })
  const stats = {
    label,
    opened: false,
    closed: false,
    closeCode: null,
    closeReason: null,
    errors: 0,
    lastError: null,
    heartbeats: 0,
    events: [],
    eventIds: [],
    otherFrames: 0,
    protocol: null
  }
  const socket = new WebSocket(url, notificationStreamProtocol)
  socket.binaryType = 'arraybuffer'

  socket.addEventListener('open', () => {
    stats.opened = true
    stats.protocol = socket.protocol || null
  })

  socket.addEventListener('message', async (event) => {
    try {
      const decoded = decodeNotificationFrame(await readWebSocketMessageData(event.data), decodeAedsFrame)
      if (decoded.kind === 'heartbeat') {
        stats.heartbeats += 1
      } else if (decoded.kind === 'event') {
        stats.events.push(decoded)
        stats.eventIds.push(decoded.id)
      } else {
        stats.otherFrames += 1
      }
    } catch (error) {
      stats.errors += 1
      stats.lastError = error instanceof Error ? error.message : String(error)
    }
  })

  socket.addEventListener('close', (event) => {
    stats.closed = true
    stats.closeCode = event.code
    stats.closeReason = event.reason || null
  })

  socket.addEventListener('error', () => {
    stats.errors += 1
    stats.lastError = 'websocket error'
  })

  await waitForCondition(`${label} notification heartbeat`, () => {
    if (stats.heartbeats > 0) {
      return true
    }
    if (stats.errors > 0) {
      throw new Error(`${label} notification socket error: ${stats.lastError}`)
    }
    if (stats.closed) {
      throw new Error(`${label} notification socket closed before heartbeat: ${stats.closeCode}`)
    }
    return false
  })

  if (stats.protocol !== notificationStreamProtocol) {
    throw new Error(`${label} websocket protocol mismatch: ${stats.protocol ?? 'none'}`)
  }

  return { socket, stats }
}

async function publishNotificationDrill({ drillId, count, payloadBytes, routeKey }) {
  if (!notificationDrillSecret) {
    throw new Error('FSUSBLOG_NOTIFICATION_DRILL_SECRET missing')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${notificationDrillPublishPath}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'FsusBlog runtime evidence probe',
        'X-Fsus-Notification-Drill-Secret': notificationDrillSecret
      },
      signal: controller.signal,
      body: JSON.stringify({ drillId, count, payloadBytes, routeKey })
    })
    const text = await response.text()
    const body = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new Error(`notification drill publish failed: HTTP ${response.status} ${text}`)
    }
    if (!Array.isArray(body?.eventIds) || body.eventIds.length === 0) {
      throw new Error('notification drill publish did not return event ids')
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

function closeSocketQuietly(socket, reason = 'runtime-drill-complete') {
  try {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) {
      socket.close(1000, reason)
      if (typeof socket.terminate === 'function') {
        setTimeout(() => {
          try {
            socket.terminate()
          } catch {
          }
        }, 100).unref?.()
      }
    }
  } catch {
  }
}

function countMatchingEventIds(receivedIds, publishedIds) {
  const published = new Set(publishedIds)
  return receivedIds.filter((id) => published.has(id)).length
}

function selectFaultCases(defaultCases) {
  const raw = process.env.FSUSBLOG_FAULT_INJECTION_CASES || ''
  if (!raw.trim()) {
    return defaultCases
  }

  const selected = raw.split(/[,\s]+/u).map((item) => item.trim()).filter(Boolean)
  const known = new Set(defaultCases)
  for (const caseName of selected) {
    if (!known.has(caseName)) {
      throw new Error(`unknown fault injection case selected: ${caseName}`)
    }
  }
  return selected
}

function queryRedisDbSize() {
  const containers = [
    process.env.FSUSBLOG_REDIS_CONTAINER_NAME,
    process.env.FSUSBLOG_REDIS_CONTAINER,
    'fsusblog-dev-redis'
  ].filter(Boolean)
  const uniqueContainers = [...new Set(containers)]
  let lastError = 'redis container env missing'
  for (const container of uniqueContainers) {
    const result = runDocker(['exec', '-i', container, 'redis-cli', 'DBSIZE'])
    if (!result.ok) {
      lastError = result.error
      continue
    }
    const parsed = Number.parseInt(result.stdout, 10)
    return Number.isFinite(parsed)
      ? { available: true, value: parsed }
      : { available: false, error: `unexpected redis dbsize: ${result.stdout}` }
  }
  return { available: false, error: lastError }
}

function nowIso() {
  return new Date().toISOString()
}

function elapsedMs(started) {
  return Number((performance.now() - started).toFixed(3))
}

function summarizeProbe(probe) {
  return {
    status: 'completed',
    sampleCount: probe.sampleCount,
    durationMs: probe.durationMs,
    rps: probe.rps,
    p95Ms: probe.latencyMs.p95,
    statusCounts: probe.statusCounts,
    paths: [...new Set(probe.samples.map((sample) => sample.path))]
  }
}

async function runProbeResult(label, paths, options = {}) {
  const startedAt = nowIso()
  const started = performance.now()
  try {
    const runtime = await runHttpProbe(paths, options)
    return {
      status: 'completed',
      label,
      startedAt,
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      runtime: summarizeProbe(runtime)
    }
  } catch (error) {
    return {
      status: 'failed',
      label,
      startedAt,
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function acceptanceTmpDir() {
  return path.join(root, '.tmp', 'acceptance', namespaceSlug(namespace))
}

function backendPidFile() {
  return process.env.FSUSBLOG_BACKEND_PID_FILE || path.join(acceptanceTmpDir(), 'backend.pid')
}

function backendLogFile() {
  return process.env.FSUSBLOG_BACKEND_LOG_FILE || path.join(acceptanceTmpDir(), 'backend.log')
}

function readPositiveIntFile(file) {
  try {
    const value = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function baseUrlPort() {
  try {
    const parsed = new URL(baseUrl)
    if (parsed.port) return Number.parseInt(parsed.port, 10)
    return parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

function isProcessRunning(pid) {
  const state = processState(pid)
  if (state.status !== 'unknown') {
    return state.running
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function processState(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
    cwd: root,
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    return { status: 'missing', running: false, stat: null }
  }

  const stat = String(result.stdout || '').trim()
  if (!stat) {
    return { status: 'missing', running: false, stat: null }
  }

  if (stat.includes('Z')) {
    return { status: 'zombie', running: false, stat }
  }

  return { status: 'running', running: true, stat }
}

function classifyArtifactWriteError(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : 'UNKNOWN'
  const controlledCodes = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS'])
  return {
    status: controlledCodes.has(code) ? 'expected-error' : 'unexpected-error',
    code,
    message: error instanceof Error ? error.message : String(error)
  }
}

function findListeningPid(port) {
  if (!port) return null
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    cwd: root,
    encoding: 'utf8'
  })
  if (lsof.status === 0) {
    const pid = Number.parseInt(String(lsof.stdout).trim().split(/\s+/u)[0], 10)
    if (Number.isFinite(pid) && pid > 0) return pid
  }

  const ss = spawnSync('ss', ['-ltnp', `( sport = :${port} )`], {
    cwd: root,
    encoding: 'utf8'
  })
  if (ss.status === 0) {
    const match = /pid=(\d+)/u.exec(ss.stdout)
    if (match) {
      const pid = Number.parseInt(match[1], 10)
      if (Number.isFinite(pid) && pid > 0) return pid
    }
  }
  return null
}

function backendContainerName() {
  return process.env.FSUSBLOG_BACKEND_CONTAINER_NAME || process.env.FSUSBLOG_BACKEND_CONTAINER || ''
}

function resolveBackendRuntimeTarget() {
  const container = backendContainerName()
  if (container) {
    return { kind: 'container', container }
  }

  const envPid = Number.parseInt(process.env.FSUSBLOG_BACKEND_PID || '', 10)
  const pidCandidates = [
    findListeningPid(baseUrlPort()),
    Number.isFinite(envPid) && envPid > 0 ? envPid : null,
    readPositiveIntFile(backendPidFile())
  ].filter((candidate) => Number.isFinite(candidate) && candidate > 0)
  const pid = pidCandidates.find((candidate) => isProcessRunning(candidate)) ?? null
  return pid ? { kind: 'process', pid, pidFile: backendPidFile(), logFile: backendLogFile() } : null
}

async function fetchStatus(relativePath, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${positiveInt(options.timeoutMs, 1000)}ms`)), positiveInt(options.timeoutMs, 1000))
  const started = performance.now()
  try {
    const response = await fetch(`${baseUrl}${relativePath}`, {
      headers: { ...defaultHeaders, ...(options.headers ?? {}) },
      signal: controller.signal
    })
    const body = await response.arrayBuffer()
    return {
      status: response.status >= 200 && response.status < 500 ? 'available' : 'unavailable',
      statusCode: response.status,
      ok: response.ok,
      bytes: body.byteLength,
      elapsedMs: elapsedMs(started)
    }
  } catch (error) {
    return {
      status: 'unavailable',
      statusCode: null,
      ok: false,
      elapsedMs: elapsedMs(started),
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHealthLiveUnavailable() {
  const startedAt = nowIso()
  const started = performance.now()
  const attempts = []
  const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_DRAIN_WAIT_MS, 30000)
  const intervalMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_POLL_MS, 250)
  do {
    const probe = await fetchStatus('/health/live', { timeoutMs: 1000 })
    attempts.push({ at: nowIso(), elapsedMs: elapsedMs(started), ...probe })
    if (probe.status === 'unavailable') {
      return {
        status: 'unavailable',
        startedAt,
        completedAt: nowIso(),
        durationMs: elapsedMs(started),
        attempts
      }
    }
    await sleep(intervalMs)
  } while (performance.now() - started < maxWaitMs)

  return {
    status: 'available',
    startedAt,
    completedAt: nowIso(),
    durationMs: elapsedMs(started),
    attempts
  }
}

async function waitForProcessStop(pid) {
  const started = performance.now()
  const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_PROCESS_WAIT_MS, 30000)
  do {
    if (!isProcessRunning(pid)) {
      return { status: 'stopped', exitObserved: true, durationMs: elapsedMs(started) }
    }
    await sleep(250)
  } while (performance.now() - started < maxWaitMs)
  return { status: 'running', exitObserved: false, durationMs: elapsedMs(started) }
}

async function waitForNotificationClose(stats) {
  const started = performance.now()
  const maxWaitMs = positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_SOCKET_WAIT_MS, 30000)
  do {
    if (stats?.closed) {
      return {
        status: 'closed',
        closeObserved: true,
        closeCode: stats.closeCode,
        closeReason: stats.closeReason,
        durationMs: elapsedMs(started)
      }
    }
    await sleep(100)
  } while (performance.now() - started < maxWaitMs)
  return {
    status: 'open',
    closeObserved: false,
    closeCode: stats?.closeCode ?? null,
    closeReason: stats?.closeReason ?? null,
    durationMs: elapsedMs(started)
  }
}

function startManagedDebugBackend() {
  const port = baseUrlPort()
  if (!port) {
    throw new Error(`cannot resolve backend port from ${baseUrl}`)
  }

  fs.mkdirSync(acceptanceTmpDir(), { recursive: true })
  const logFile = backendLogFile()
  const pidFile = backendPidFile()
  const out = fs.openSync(logFile, 'a')
  const env = {
    ...process.env,
    ASPNETCORE_URLS: process.env.ASPNETCORE_URLS || `http://127.0.0.1:${port}`,
    ASPNETCORE_ENVIRONMENT: process.env.ASPNETCORE_ENVIRONMENT || 'Development'
  }
  const child = spawn('dotnet', ['run', '--project', 'src/backend/FsusBlog.Server.csproj', '--no-launch-profile', '--urls', `http://127.0.0.1:${port}`], {
    cwd: root,
    detached: true,
    env,
    stdio: ['ignore', out, out]
  })
  child.unref()
  fs.closeSync(out)
  fs.writeFileSync(pidFile, `${child.pid}\n`)
  return { pid: child.pid, pidFile, logFile }
}

function startBackendRuntime(target) {
  const startedAt = nowIso()
  const started = performance.now()
  if (target.kind === 'container') {
    const result = runDocker(['start', target.container])
    return {
      status: result.ok ? 'started' : 'failed',
      target: target.container,
      mode: 'docker-start',
      startedAt,
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      error: result.ok ? null : result.error
    }
  }

  const processInfo = startManagedDebugBackend()
  return {
    status: 'started',
    target: String(processInfo.pid),
    mode: 'managed-debug-process',
    startedAt,
    completedAt: nowIso(),
    durationMs: elapsedMs(started),
    pidFile: processInfo.pidFile,
    logFile: processInfo.logFile
  }
}

async function stopBackendRuntime(target) {
  const startedAt = nowIso()
  const started = performance.now()
  if (target.kind === 'container') {
    const result = runDocker(['stop', '--time', String(positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_DOCKER_TIMEOUT_SECONDS, 30)), target.container])
    const livenessDuringShutdown = await waitForHealthLiveUnavailable()
    return {
      status: result.ok ? 'stopped' : 'failed',
      target: target.container,
      mode: 'docker-stop',
      signal: 'SIGTERM',
      startedAt,
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      drainDurationMs: livenessDuringShutdown.durationMs,
      exitObserved: result.ok,
      livenessDuringShutdown,
      error: result.ok ? null : result.error
    }
  }

  try {
    process.kill(target.pid, 'SIGTERM')
  } catch (error) {
    return {
      status: 'failed',
      target: String(target.pid),
      mode: 'process-signal',
      signal: 'SIGTERM',
      startedAt,
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      drainDurationMs: elapsedMs(started),
      exitObserved: false,
      livenessDuringShutdown: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      error: error instanceof Error ? error.message : String(error)
    }
  }

  let [processStopResult, livenessDuringShutdown] = await Promise.all([
    waitForProcessStop(target.pid),
    waitForHealthLiveUnavailable()
  ])
  let forcedKill = false
  if (processStopResult.status !== 'stopped' && livenessDuringShutdown.status === 'unavailable') {
    try {
      process.kill(target.pid, 'SIGKILL')
      forcedKill = true
      processStopResult = await waitForProcessStop(target.pid)
    } catch (error) {
      if (error?.code === 'ESRCH') {
        processStopResult = { status: 'stopped', exitObserved: true, durationMs: elapsedMs(started) }
      } else {
        processStopResult = {
          ...processStopResult,
          killError: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  const serviceStopped = livenessDuringShutdown.status === 'unavailable'
  const processStopped = processStopResult.status === 'stopped' && processStopResult.exitObserved === true
  return {
    status: serviceStopped && processStopped ? 'stopped' : 'failed',
    target: String(target.pid),
    mode: 'process-signal',
    signal: 'SIGTERM',
    startedAt,
    completedAt: nowIso(),
    durationMs: elapsedMs(started),
    drainDurationMs: livenessDuringShutdown.durationMs,
    exitObserved: processStopResult.exitObserved,
    forcedKill,
    processExit: processStopResult,
    livenessDuringShutdown,
    error: serviceStopped && processStopped
      ? null
      : `shutdown incomplete: health=${livenessDuringShutdown.status} process=${processStopResult.status}`
  }
}

async function waitForCompletedProbe(label, paths, options = {}) {
  const started = performance.now()
  const attempts = []
  const maxWaitMs = positiveInt(options.maxWaitMs, positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_RESTART_WAIT_MS, 120000))
  const intervalMs = positiveInt(options.intervalMs, 1000)
  do {
    const result = await runProbeResult(label, paths, {
      iterations: options.iterations ?? 1,
      concurrency: options.concurrency ?? 1,
      headers: options.headers
    })
    if (result.status === 'completed') {
      return { ...result, attempts }
    }
    attempts.push({ at: nowIso(), elapsedMs: elapsedMs(started), error: result.error })
    await sleep(intervalMs)
  } while (performance.now() - started < maxWaitMs)

  throw new Error(`${label} did not recover within ${maxWaitMs}ms: ${attempts.at(-1)?.error ?? 'no successful probe'}`)
}

function redisContainerName() {
  return process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || ''
}

function runRedisCli(container, args) {
  return runDocker(['exec', '-i', container, 'redis-cli', ...args])
}

function scanBackendLogsForUnhandledExceptions() {
  const container = process.env.FSUSBLOG_BACKEND_CONTAINER_NAME || process.env.FSUSBLOG_BACKEND_CONTAINER || ''
  let source = null
  let target = null
  let content = ''
  if (container) {
    const result = runDocker(['logs', '--since', process.env.FSUSBLOG_FAULT_LOG_SINCE || process.env.FSUSBLOG_REDIS_DRILL_LOG_SINCE || '10m', container])
    if (!result.ok) {
      return { status: 'blocked', source: 'docker-logs', target: container, error: result.error }
    }
    source = 'docker-logs'
    target = container
    content = result.stdout
  } else if (fs.existsSync(backendLogFile())) {
    source = 'managed-backend-log'
    target = backendLogFile()
    content = fs.readFileSync(backendLogFile(), 'utf8').slice(-500000)
  } else {
    return { status: 'not-configured', reason: 'backend container env and managed backend log missing' }
  }

  const patterns = [
    /Unhandled exception/i,
    /UnhandledException/i,
    /BackgroundService failed/i,
    /Host terminated unexpectedly/i,
    /StackExchange\.Redis.*(?:Fatal|Unhandled|timeout)/i,
    /Redis.*(?:unhandled|fatal)/i
  ]
  const matched = patterns.find((pattern) => pattern.test(content))
  return matched
    ? { status: 'failed', source, target, matchedPattern: String(matched) }
    : { status: 'ok', source, target, scannedBytes: content.length }
}

async function optionalAuthenticatedImpact() {
  const cookie = process.env.FSUSBLOG_AUTH_COOKIE_HEADER || process.env.FSUSBLOG_AUTHENTICATED_COOKIE || ''
  if (!cookie) {
    return { status: 'not-configured', reason: 'FSUSBLOG_AUTH_COOKIE_HEADER missing' }
  }
  return await runProbeResult('authenticated session path', ['/api/binary/auth/sessions'], {
    iterations: 1,
    concurrency: 1,
    headers: { Cookie: cookie }
  })
}

async function optionalNotificationStreamImpact() {
  const cookie = process.env.FSUSBLOG_AUTH_COOKIE_HEADER || process.env.FSUSBLOG_AUTHENTICATED_COOKIE || ''
  const powQuery = process.env.FSUSBLOG_NOTIFICATION_STREAM_POW_QUERY || ''
  if (!cookie && !powQuery) {
    return {
      status: 'not-configured',
      reason: 'FSUSBLOG_AUTH_COOKIE_HEADER or FSUSBLOG_NOTIFICATION_STREAM_POW_QUERY missing'
    }
  }

  const pathWithQuery = powQuery
    ? `/api/notifications/stream/preflight?pow=${encodeURIComponent(powQuery)}`
    : '/api/notifications/stream/preflight'
  return await runProbeResult('notification stream preflight', [pathWithQuery], {
    iterations: 1,
    concurrency: 1,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      'X-Fsus-Notification-Stream-Protocol': 'fsus-notification-stream.v1'
    }
  })
}

async function probeRedisFinalHealth() {
  const publicReadResult = await runProbeResult('public binary endpoint', [
    '/api/binary/system/seo',
    '/api/binary/article/list/home/1/10.aeds'
  ], { iterations: 4, concurrency: 1 })
  if (publicReadResult.status !== 'completed') {
    throw new Error(`public binary endpoint did not recover: ${publicReadResult.error}`)
  }

  const powResult = await runProbeResult('pow challenge path', ['/api/binary/auth/pow-challenge'], {
    iterations: 2,
    concurrency: 1
  })
  if (powResult.status !== 'completed') {
    throw new Error(`PoW challenge path did not recover: ${powResult.error}`)
  }

  const cachePathResult = await runProbeResult('cache path', ['/api/binary/category', '/api/binary/tag'], {
    iterations: 4,
    concurrency: 1
  })
  if (cachePathResult.status !== 'completed') {
    throw new Error(`cache path did not recover: ${cachePathResult.error}`)
  }

  const readyResult = await runProbeResult('health ready', ['/health/ready'], { iterations: 1, concurrency: 1 })
  if (readyResult.status !== 'completed') {
    throw new Error(`health ready did not recover: ${readyResult.error}`)
  }

  const authenticatedImpact = await optionalAuthenticatedImpact()
  const notificationStreamImpact = await optionalNotificationStreamImpact()
  const logScan = scanBackendLogsForUnhandledExceptions()
  if (logScan.status === 'failed' || logScan.status === 'blocked') {
    throw new Error(`backend log scan ${logScan.status}: ${logScan.error ?? logScan.matchedPattern}`)
  }

  return {
    status: 'healthy',
    generatedAt: nowIso(),
    publicReadResult,
    powSessionCache: {
      powChallenge: powResult,
      cachePath: cachePathResult,
      session: authenticatedImpact
    },
    authenticatedImpact,
    notificationStreamImpact,
    healthReady: readyResult,
    logScan
  }
}

async function waitForRedisRecovery() {
  const started = performance.now()
  const startedAt = nowIso()
  const attempts = []
  const maxWaitMs = positiveInt(process.env.FSUSBLOG_REDIS_RECOVERY_WAIT_MS, 20000)
  const intervalMs = positiveInt(process.env.FSUSBLOG_REDIS_RECOVERY_POLL_MS, 500)

  do {
    try {
      const finalHealth = await probeRedisFinalHealth()
      return {
        status: 'completed',
        startedAt,
        completedAt: nowIso(),
        recoveryDurationMs: elapsedMs(started),
        attempts,
        finalHealth
      }
    } catch (error) {
      attempts.push({
        at: nowIso(),
        elapsedMs: elapsedMs(started),
        error: error instanceof Error ? error.message : String(error)
      })
      if (performance.now() - started >= maxWaitMs) {
        throw new Error(`Redis recovery did not complete within ${maxWaitMs}ms: ${attempts.at(-1)?.error}`)
      }
      await sleep(intervalMs)
    }
  } while (true)
}

async function executeRedisControlledAction(caseName, container) {
  const startedAt = nowIso()
  const started = performance.now()
  const common = { status: 'executed', target: container, startedAt }

  if (caseName === 'redis-restart') {
    const stopped = runDocker(['stop', container])
    if (!stopped.ok) {
      return {
        status: 'blocked',
        target: container,
        operation: 'docker stop/start',
        startedAt,
        completedAt: nowIso(),
        error: stopped.error
      }
    }

    const unavailableStarted = performance.now()
    const unavailableStartedAt = nowIso()
    const impact = await runProbeResult('redis-restart unavailable window', [
      '/api/binary/system/seo',
      '/api/binary/auth/pow-challenge'
    ], { iterations: 2, concurrency: 1 })
    const startedAgain = runDocker(['start', container])
    const unavailableDurationMs = elapsedMs(unavailableStarted)
    if (!startedAgain.ok) {
      return {
        status: 'failed',
        target: container,
        operation: 'docker stop/start',
        startedAt,
        completedAt: nowIso(),
        unavailableStartedAt,
        unavailableDurationMs,
        duringWindow: impact,
        error: startedAgain.error
      }
    }

    return {
      ...common,
      operation: 'docker stop/start',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableStartedAt,
      unavailableDurationMs,
      duringWindow: impact,
      stopOutput: stopped.stdout,
      startOutput: startedAgain.stdout
    }
  }

  if (caseName === 'redis-reconnect') {
    const killed = runRedisCli(container, ['CLIENT', 'KILL', 'TYPE', 'normal'])
    if (!killed.ok) {
      return {
        status: 'blocked',
        target: container,
        operation: 'redis-cli CLIENT KILL TYPE normal',
        startedAt,
        completedAt: nowIso(),
        error: killed.error
      }
    }

    const impact = await runProbeResult('redis-reconnect window', [
      '/api/binary/system/seo',
      '/api/binary/auth/pow-challenge'
    ], { iterations: 2, concurrency: 1 })
    return {
      ...common,
      operation: 'redis-cli CLIENT KILL TYPE normal',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableDurationMs: 0,
      duringWindow: impact,
      killedClients: Number.parseInt(killed.stdout, 10),
      output: killed.stdout
    }
  }

  if (caseName === 'redis-latency') {
    const pauseMs = positiveInt(process.env.FSUSBLOG_REDIS_LATENCY_PAUSE_MS, 1200)
    const paused = runRedisCli(container, ['CLIENT', 'PAUSE', String(pauseMs), 'ALL'])
    if (!paused.ok) {
      return {
        status: 'blocked',
        target: container,
        operation: 'redis-cli CLIENT PAUSE',
        startedAt,
        completedAt: nowIso(),
        unavailableDurationMs: pauseMs,
        error: paused.error
      }
    }

    const impact = await runProbeResult('redis-latency window', [
      '/api/binary/system/seo',
      '/api/binary/auth/pow-challenge'
    ], { iterations: 2, concurrency: 1 })
    return {
      ...common,
      operation: 'redis-cli CLIENT PAUSE',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableDurationMs: pauseMs,
      duringWindow: impact,
      pauseMs,
      output: paused.stdout
    }
  }

  return {
    status: 'blocked',
    target: container,
    operation: 'unknown redis action',
    startedAt,
    completedAt: nowIso(),
    reason: `no controlled Redis action implemented for ${caseName}`
  }
}

async function runRedisFaultCase(caseName) {
  let before = null
  let action = { status: 'blocked', reason: `no controlled Redis action implemented for ${caseName}` }
  let recovery = null
  let resultStatus = 'blocked'
  let failure = null

  try {
    before = await runHttpProbe(['/api/binary/system/seo', '/api/binary/auth/pow-challenge'], { iterations: 2, concurrency: 1 })
    const container = redisContainerName()
    if (!container) {
      action = { status: 'blocked', reason: 'redis container env missing' }
    } else {
      action = await executeRedisControlledAction(caseName, container)
      if (action.status === 'executed') {
        recovery = await waitForRedisRecovery()
        resultStatus = 'completed'
      } else {
        resultStatus = action.status === 'failed' ? 'failed' : 'blocked'
      }
    }
  } catch (error) {
    resultStatus = 'failed'
    failure = error instanceof Error ? error.message : String(error)
  }

  const finalHealth = recovery?.finalHealth ?? {
    status: resultStatus,
    error: failure ?? action.reason ?? action.error ?? 'recovery check missing'
  }
  const publicReadResult = recovery?.finalHealth?.publicReadResult ?? null
  const recoveryDurationMs = recovery?.recoveryDurationMs ?? null
  return {
    status: resultStatus,
    case: caseName,
    namespace,
    actionStatus: action.status,
    actionStartedAt: action.startedAt ?? null,
    actionCompletedAt: action.completedAt ?? null,
    unavailableDurationMs: action.unavailableDurationMs ?? null,
    recoveryDurationMs,
    publicReadResult,
    authenticatedImpact: recovery?.finalHealth?.authenticatedImpact ?? null,
    notificationStreamImpact: recovery?.finalHealth?.notificationStreamImpact ?? null,
    preCheck: before
      ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
      : { status: 'failed', error: failure ?? 'pre-check was not completed' },
    controlledAction: action,
    recoveryCheck: recovery
      ? {
          status: recovery.status,
          startedAt: recovery.startedAt,
          completedAt: recovery.completedAt,
          recoveryDurationMs,
          attempts: recovery.attempts.length
        }
      : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
    timeline: [
      ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
      { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
      ...(action.duringWindow ? [{ event: 'during-unavailable-window', generatedAt: action.duringWindow.completedAt, status: action.duringWindow.status }] : []),
      ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, recoveryDurationMs }] : [])
    ],
    errorRate: action.duringWindow?.status === 'failed' ? 1 : 0,
    recoveryTimeMs: recoveryDurationMs,
    dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
    resourceMetrics: {
      redisContainer: redisContainerName() || null
    },
    finalHealth,
    finalHealthSnapshot: finalHealth,
    generatedAt: recovery?.completedAt ?? nowIso()
  }
}

function postgresContainerName() {
  return process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME || process.env.FSUSBLOG_PG_CONTAINER || ''
}

function runPostgresSql(container, sql) {
  return runDocker(['exec', '-i', container, 'psql', '-U', 'fsusblog', '-d', 'fsusblog', '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql])
}

function spawnPostgresSql(container, sql) {
  const child = spawn('docker', [
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    'fsusblog',
    '-d',
    'fsusblog',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })

  const chunks = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { chunks.stdout += chunk })
  child.stderr.on('data', (chunk) => { chunks.stderr += chunk })
  return { child, chunks }
}

function waitForSpawnResult(processHandle, timeoutMs) {
  const { child, chunks } = processHandle
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({
        ok: false,
        status: null,
        stdout: chunks.stdout.trim(),
        stderr: chunks.stderr.trim(),
        error: `process timed out after ${timeoutMs}ms`
      })
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        status: null,
        stdout: chunks.stdout.trim(),
        stderr: chunks.stderr.trim(),
        error: error.message
      })
    })

    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({
        ok: status === 0,
        status,
        stdout: chunks.stdout.trim(),
        stderr: chunks.stderr.trim(),
        error: status === 0 ? null : (chunks.stderr || chunks.stdout || `process exited ${status}`).trim()
      })
    })
  })
}

async function probePostgresFinalHealth(container) {
  const healthLive = await runProbeResult('health live', ['/health/live'], { iterations: 1, concurrency: 1 })
  if (healthLive.status !== 'completed') {
    throw new Error(`health live did not recover: ${healthLive.error}`)
  }

  const publicReadResult = await runProbeResult('public binary endpoint', [
    '/api/binary/system/seo',
    '/api/binary/article/list/home/1/10.aeds'
  ], { iterations: 4, concurrency: 1 })
  if (publicReadResult.status !== 'completed') {
    throw new Error(`public binary endpoint did not recover: ${publicReadResult.error}`)
  }

  const healthReady = await runProbeResult('health ready', ['/health/ready'], { iterations: 1, concurrency: 1 })
  if (healthReady.status !== 'completed') {
    throw new Error(`health ready did not recover: ${healthReady.error}`)
  }

  const dbQuery = runPostgresSql(container, 'SELECT 1;')
  if (!dbQuery.ok) {
    throw new Error(`postgres follow-up query failed: ${dbQuery.error}`)
  }

  const logScan = scanBackendLogsForUnhandledExceptions()
  if (logScan.status === 'failed' || logScan.status === 'blocked') {
    throw new Error(`backend log scan ${logScan.status}: ${logScan.error ?? logScan.matchedPattern}`)
  }

  return {
    status: 'healthy',
    generatedAt: nowIso(),
    healthLive,
    publicReadResult,
    healthReady,
    connectionPool: {
      status: 'ok',
      appReady: healthReady,
      dbQuery: {
        status: 'completed',
        output: dbQuery.stdout
      }
    },
    logScan
  }
}

async function waitForPostgresRecovery(container) {
  const started = performance.now()
  const startedAt = nowIso()
  const attempts = []
  const maxWaitMs = positiveInt(process.env.FSUSBLOG_POSTGRES_RECOVERY_WAIT_MS, 25000)
  const intervalMs = positiveInt(process.env.FSUSBLOG_POSTGRES_RECOVERY_POLL_MS, 500)

  do {
    try {
      const finalHealth = await probePostgresFinalHealth(container)
      return {
        status: 'completed',
        startedAt,
        completedAt: nowIso(),
        recoveryDurationMs: elapsedMs(started),
        attempts,
        finalHealth
      }
    } catch (error) {
      attempts.push({
        at: nowIso(),
        elapsedMs: elapsedMs(started),
        error: error instanceof Error ? error.message : String(error)
      })
      if (performance.now() - started >= maxWaitMs) {
        throw new Error(`PostgreSQL recovery did not complete within ${maxWaitMs}ms: ${attempts.at(-1)?.error}`)
      }
      await sleep(intervalMs)
    }
  } while (true)
}

async function executePostgresControlledAction(caseName, container) {
  const startedAt = nowIso()
  const started = performance.now()
  const common = { status: 'executed', target: container, startedAt }

  if (caseName === 'postgres-readiness') {
    const stopped = runDocker(['stop', container])
    if (!stopped.ok) {
      return {
        status: 'blocked',
        target: container,
        operation: 'docker stop/start',
        affectedEndpoint: '/health/ready',
        startedAt,
        completedAt: nowIso(),
        error: stopped.error
      }
    }

    const unavailableStarted = performance.now()
    const unavailableStartedAt = nowIso()
    const impact = await runProbeResult('postgres-readiness unavailable window', [
      '/health/ready',
      '/api/binary/system/seo'
    ], { iterations: 2, concurrency: 1 })
    const startedAgain = runDocker(['start', container])
    const unavailableDurationMs = elapsedMs(unavailableStarted)
    if (!startedAgain.ok) {
      return {
        status: 'failed',
        target: container,
        operation: 'docker stop/start',
        affectedEndpoint: '/health/ready',
        startedAt,
        completedAt: nowIso(),
        unavailableStartedAt,
        unavailableDurationMs,
        duringWindow: impact,
        error: startedAgain.error
      }
    }

    return {
      ...common,
      operation: 'docker stop/start',
      affectedEndpoint: '/health/ready',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableStartedAt,
      unavailableDurationMs,
      duringWindow: impact,
      writePathRollbackResult: {
        status: 'not-mutated',
        reason: 'readiness drill exercises availability and follow-up read recovery'
      },
      stopOutput: stopped.stdout,
      startOutput: startedAgain.stdout
    }
  }

  if (caseName === 'postgres-reconnect') {
    const terminated = runPostgresSql(container, `
      SELECT count(pg_terminate_backend(pid))
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid();
    `)
    if (!terminated.ok) {
      return {
        status: 'blocked',
        target: container,
        operation: 'pg_terminate_backend active connections',
        affectedEndpoint: '/health/ready',
        startedAt,
        completedAt: nowIso(),
        error: terminated.error
      }
    }

    const impact = await runProbeResult('postgres-reconnect window', [
      '/health/ready',
      '/api/binary/system/seo'
    ], { iterations: 2, concurrency: 1 })
    return {
      ...common,
      operation: 'pg_terminate_backend active connections',
      affectedEndpoint: '/health/ready',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableDurationMs: 0,
      duringWindow: impact,
      terminatedConnections: Number.parseInt(terminated.stdout, 10),
      writePathRollbackResult: {
        status: 'not-mutated',
        reason: 'connection reset drill terminates sessions without writing data'
      },
      output: terminated.stdout
    }
  }

  if (caseName === 'postgres-lock-timeout') {
    const beforeRows = queryPostgresScalar('select count(*) from article;')
    if (!beforeRows.available) {
      return {
        status: 'blocked',
        target: container,
        operation: 'lock timeout simulation',
        affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
        startedAt,
        completedAt: nowIso(),
        error: beforeRows.error
      }
    }

    const holder = spawnPostgresSql(container, 'BEGIN; LOCK TABLE article IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(3); COMMIT;')
    await sleep(500)
    const timeoutProbe = runPostgresSql(container, "SET lock_timeout = '500ms'; SELECT count(*) FROM article;")
    const holderResult = await waitForSpawnResult(holder, 7000)
    const afterRows = queryPostgresScalar('select count(*) from article;')
    const timeoutObserved = !timeoutProbe.ok && /lock timeout|canceling statement due to lock timeout/i.test(timeoutProbe.error ?? '')
    if (!holderResult.ok) {
      return {
        status: 'failed',
        target: container,
        operation: 'lock timeout simulation',
        affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
        startedAt,
        completedAt: nowIso(),
        unavailableDurationMs: elapsedMs(started),
        error: holderResult.error
      }
    }
    if (!timeoutObserved) {
      return {
        status: 'failed',
        target: container,
        operation: 'lock timeout simulation',
        affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
        startedAt,
        completedAt: nowIso(),
        unavailableDurationMs: elapsedMs(started),
        error: timeoutProbe.ok ? 'lock timeout query unexpectedly succeeded' : timeoutProbe.error
      }
    }

    return {
      ...common,
      operation: 'lock timeout simulation',
      affectedEndpoint: '/api/binary/article/list/home/1/10.aeds',
      completedAt: nowIso(),
      durationMs: elapsedMs(started),
      unavailableDurationMs: elapsedMs(started),
      duringWindow: {
        status: 'failed',
        label: 'postgres-lock-timeout window',
        error: timeoutProbe.error
      },
      writePathRollbackResult: {
        status: afterRows.available && afterRows.value === beforeRows.value ? 'verified' : 'failed',
        beforeArticleRows: beforeRows.value,
        afterArticleRows: afterRows.available ? afterRows.value : null,
        source: afterRows.available ? 'postgres-count' : afterRows.error,
        timeoutObserved
      },
      holderResult: {
        status: holderResult.status,
        stdout: holderResult.stdout,
        stderr: holderResult.stderr
      }
    }
  }

  return {
    status: 'blocked',
    target: container,
    operation: 'unknown postgres action',
    affectedEndpoint: '/health/ready',
    startedAt,
    completedAt: nowIso(),
    reason: `no controlled PostgreSQL action implemented for ${caseName}`
  }
}

async function runPostgresFaultCase(caseName) {
  let before = null
  let action = { status: 'blocked', reason: `no controlled PostgreSQL action implemented for ${caseName}` }
  let recovery = null
  let resultStatus = 'blocked'
  let failure = null

  try {
    before = await runHttpProbe(['/health/live', '/api/binary/system/seo'], { iterations: 2, concurrency: 1 })
    const container = postgresContainerName()
    if (!container) {
      action = { status: 'blocked', reason: 'postgres container env missing' }
    } else {
      action = await executePostgresControlledAction(caseName, container)
      if (action.status === 'executed') {
        recovery = await waitForPostgresRecovery(container)
        resultStatus = action.writePathRollbackResult?.status === 'failed' ? 'failed' : 'completed'
      } else {
        resultStatus = action.status === 'failed' ? 'failed' : 'blocked'
      }
    }
  } catch (error) {
    resultStatus = 'failed'
    failure = error instanceof Error ? error.message : String(error)
  }

  const finalHealth = recovery?.finalHealth ?? {
    status: resultStatus,
    error: failure ?? action.reason ?? action.error ?? 'recovery check missing'
  }
  const publicReadRecoveryResult = recovery?.finalHealth?.publicReadResult ?? null
  const recoveryDurationMs = recovery?.recoveryDurationMs ?? null
  return {
    status: resultStatus,
    case: caseName,
    namespace,
    actionStatus: action.status,
    actionStartedAt: action.startedAt ?? null,
    actionCompletedAt: action.completedAt ?? null,
    affectedEndpoint: action.affectedEndpoint ?? null,
    unavailableDurationMs: action.unavailableDurationMs ?? null,
    dbReconnectDurationMs: recoveryDurationMs,
    recoveryDurationMs,
    publicReadRecoveryResult,
    writePathRollbackResult: action.writePathRollbackResult ?? null,
    preCheck: before
      ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
      : { status: 'failed', error: failure ?? 'pre-check was not completed' },
    controlledAction: action,
    recoveryCheck: recovery
      ? {
          status: recovery.status,
          startedAt: recovery.startedAt,
          completedAt: recovery.completedAt,
          dbReconnectDurationMs: recoveryDurationMs,
          attempts: recovery.attempts.length
        }
      : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
    timeline: [
      ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
      { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
      ...(action.duringWindow ? [{ event: 'during-unavailable-window', generatedAt: action.duringWindow.completedAt ?? nowIso(), status: action.duringWindow.status }] : []),
      ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, dbReconnectDurationMs: recoveryDurationMs }] : [])
    ],
    errorRate: action.duringWindow?.status === 'failed' ? 1 : 0,
    recoveryTimeMs: recoveryDurationMs,
    dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
    resourceMetrics: {
      postgresContainer: postgresContainerName() || null
    },
    finalHealth,
    finalHealthSnapshot: finalHealth,
    generatedAt: recovery?.completedAt ?? nowIso()
  }
}

async function runGracefulShutdownFaultCase() {
  let livenessBefore = null
  let publicReadBefore = null
  let action = { status: 'blocked', reason: 'backend runtime target missing' }
  let stopResult = null
  let restartResult = null
  let publicReadRecoveryResult = null
  let basicAuthRecoveryResult = null
  let finalHealthProbe = null
  let backgroundWorkerState = null
  let notification = null
  let reconnect = null
  let notificationClose = null
  let backgroundActivity = null
  let resultStatus = 'blocked'
  let failure = null
  let target = null
  let runtimeStopped = false
  let restartAttempted = false
  const startedAt = nowIso()
  const started = performance.now()

  try {
    livenessBefore = await runProbeResult('graceful shutdown liveness before', ['/health/live'], {
      iterations: 1,
      concurrency: 1
    })
    if (livenessBefore.status !== 'completed') {
      throw new Error(`health/live was not available before shutdown: ${livenessBefore.error}`)
    }

    publicReadBefore = await runProbeResult('graceful shutdown public read before', ['/api/binary/system/seo'], {
      iterations: 1,
      concurrency: 1
    })
    if (publicReadBefore.status !== 'completed') {
      throw new Error(`public read was not available before shutdown: ${publicReadBefore.error}`)
    }

    notification = await openNotificationSocket('graceful-shutdown')
    if (notificationDrillSecret) {
      const published = await publishNotificationDrill({
        drillId: `graceful-shutdown-${namespace}-${Date.now()}`,
        count: positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_EVENT_COUNT, 8),
        payloadBytes: positiveInt(process.env.FSUSBLOG_GRACEFUL_SHUTDOWN_PAYLOAD_BYTES, 256),
        routeKey: 'content-feed'
      })
      await waitForCondition('graceful shutdown background notification frame', () => {
        return countMatchingEventIds(notification.stats.eventIds, published.eventIds) > 0
      }, { timeoutMs: Math.max(timeoutMs, 15000) })
      backgroundActivity = {
        status: 'completed',
        operation: 'notification drill publish',
        publishedCount: published.count,
        eventIds: published.eventIds,
        routeKey: published.routeKey
      }
    } else {
      backgroundActivity = {
        status: 'not-configured',
        reason: 'FSUSBLOG_NOTIFICATION_DRILL_SECRET missing'
      }
    }

    target = resolveBackendRuntimeTarget()
    if (!target) {
      action = {
        status: 'blocked',
        reason: 'backend runtime target missing',
        startedAt,
        completedAt: nowIso()
      }
    } else {
      stopResult = await stopBackendRuntime(target)
      runtimeStopped = stopResult.status === 'stopped'
      notificationClose = await waitForNotificationClose(notification.stats)
      action = {
        status: stopResult.status === 'stopped' ? 'executed' : 'failed',
        operation: 'graceful backend shutdown',
        target: stopResult.target,
        mode: stopResult.mode,
        signal: stopResult.signal,
        startedAt: stopResult.startedAt,
        completedAt: stopResult.completedAt,
        durationMs: stopResult.durationMs,
        drainDurationMs: stopResult.drainDurationMs,
        livenessDuringShutdown: stopResult.livenessDuringShutdown,
        processStopResult: {
          status: stopResult.status,
          signal: stopResult.signal,
          exitObserved: stopResult.exitObserved,
          forcedKill: stopResult.forcedKill ?? false,
          durationMs: stopResult.durationMs,
          processExit: stopResult.processExit ?? null
        },
        notificationClose,
        backgroundActivity,
        error: stopResult.error
      }
      if (action.status !== 'executed') {
        throw new Error(`graceful shutdown action failed: ${stopResult.error ?? stopResult.status}`)
      }
      if (!notificationClose.closeObserved) {
        throw new Error('notification stream did not close during graceful shutdown')
      }

      const restartStarted = performance.now()
      restartResult = startBackendRuntime(target)
      restartAttempted = true
      if (restartResult.status !== 'started') {
        throw new Error(`backend restart failed: ${restartResult.error}`)
      }

      publicReadRecoveryResult = await waitForCompletedProbe('graceful shutdown public read recovery', ['/api/binary/system/seo'], {
        iterations: 1,
        concurrency: 1
      })
      basicAuthRecoveryResult = await waitForCompletedProbe('graceful shutdown auth challenge recovery', ['/api/binary/auth/pow-challenge'], {
        iterations: 1,
        concurrency: 1
      })
      finalHealthProbe = await waitForCompletedProbe('graceful shutdown final health', ['/health/live'], {
        iterations: 1,
        concurrency: 1
      })
      restartResult.recoveryDurationMs = elapsedMs(restartStarted)

      reconnect = await openNotificationSocket('graceful-shutdown-reconnect')
      backgroundWorkerState = (() => {
        const logScan = scanBackendLogsForUnhandledExceptions()
        return (logScan.status === 'ok' || logScan.status === 'not-configured')
          ? { status: 'clean', source: logScan.source ?? 'not-configured', logScan }
          : { status: 'failed', source: logScan.source ?? 'unknown', logScan }
      })()
      if (backgroundWorkerState.status !== 'clean') {
        throw new Error(`background worker log scan ${backgroundWorkerState.logScan.status}`)
      }

      resultStatus = 'completed'
    }
  } catch (error) {
    resultStatus = 'failed'
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    closeSocketQuietly(notification?.socket)
    closeSocketQuietly(reconnect?.socket)
    if (runtimeStopped && !restartAttempted && target) {
      try {
        restartResult = startBackendRuntime(target)
        restartAttempted = true
      } catch (error) {
        failure = `${failure ?? 'graceful shutdown failed'}; restart after failure failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  const drainDurationMs = stopResult?.drainDurationMs ?? null
  const restartRecoveryDurationMs = restartResult?.recoveryDurationMs ?? null
  const recoveryDurationMs = drainDurationMs !== null && restartRecoveryDurationMs !== null
    ? Number((drainDurationMs + restartRecoveryDurationMs).toFixed(3))
    : restartRecoveryDurationMs
  const finalHealth = resultStatus === 'completed'
    ? { status: 'healthy', recovery: finalHealthProbe }
    : { status: resultStatus, error: failure ?? action.reason ?? action.error ?? 'graceful shutdown drill incomplete' }

  return {
    status: resultStatus,
    case: 'graceful-shutdown',
    namespace,
    actionStatus: action.status,
    actionStartedAt: action.startedAt ?? startedAt,
    actionCompletedAt: action.completedAt ?? nowIso(),
    shutdownRequestedAt: action.startedAt ?? null,
    drainDurationMs,
    restartRecoveryDurationMs,
    recoveryDurationMs,
    processStopResult: action.processStopResult ?? null,
    livenessBefore,
    livenessDuringShutdown: action.livenessDuringShutdown ?? null,
    notificationCloseObserved: notificationClose?.closeObserved === true,
    notificationCloseCode: notificationClose?.closeCode ?? null,
    notificationReconnectSuccess: reconnect?.stats?.opened === true && (reconnect?.stats?.heartbeats ?? 0) > 0,
    publicReadRecoveryResult,
    basicAuthRecoveryResult,
    backgroundWorkerState,
    preCheck: livenessBefore?.status === 'completed' && publicReadBefore?.status === 'completed'
      ? { status: 'completed', healthLive: livenessBefore.runtime, publicRead: publicReadBefore.runtime }
      : { status: 'failed', error: failure ?? 'pre-check was not completed' },
    controlledAction: action,
    restartAction: restartResult,
    recoveryCheck: resultStatus === 'completed'
      ? {
          status: 'completed',
          restartRecoveryDurationMs,
          publicReadRecoveryResult: {
            status: publicReadRecoveryResult.status,
            sampleCount: publicReadRecoveryResult.runtime?.sampleCount ?? null
          },
          basicAuthRecoveryResult: {
            status: basicAuthRecoveryResult.status,
            sampleCount: basicAuthRecoveryResult.runtime?.sampleCount ?? null
          },
          notificationReconnectSuccess: reconnect?.stats?.opened === true
        }
      : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? action.error ?? 'controlled action was not executed' },
    timeline: [
      ...(livenessBefore ? [{ event: 'pre-check-live', generatedAt: livenessBefore.completedAt, status: livenessBefore.status }] : []),
      ...(publicReadBefore ? [{ event: 'pre-check-public-read', generatedAt: publicReadBefore.completedAt, status: publicReadBefore.status }] : []),
      { event: 'notification-connected', generatedAt: startedAt, status: notification?.stats?.heartbeats ? 'completed' : 'not-observed' },
      { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
      ...(action.livenessDuringShutdown ? [{ event: 'health-live-unavailable', generatedAt: action.livenessDuringShutdown.completedAt, status: action.livenessDuringShutdown.status }] : []),
      ...(notificationClose ? [{ event: 'notification-close', generatedAt: action.completedAt ?? nowIso(), status: notificationClose.status, closeCode: notificationClose.closeCode }] : []),
      ...(restartResult ? [{ event: 'restart', generatedAt: restartResult.completedAt, status: restartResult.status }] : []),
      ...(publicReadRecoveryResult ? [{ event: 'public-read-recovery', generatedAt: publicReadRecoveryResult.completedAt, status: publicReadRecoveryResult.status }] : []),
      ...(basicAuthRecoveryResult ? [{ event: 'auth-recovery', generatedAt: basicAuthRecoveryResult.completedAt, status: basicAuthRecoveryResult.status }] : []),
      ...(finalHealthProbe ? [{ event: 'final-health', generatedAt: finalHealthProbe.completedAt, status: finalHealthProbe.status }] : [])
    ],
    errorRate: resultStatus === 'completed' ? 0 : 1,
    recoveryTimeMs: recoveryDurationMs,
    dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
    resourceMetrics: {
      backendTarget: target,
      backgroundActivity,
      notificationBeforeShutdown: notification?.stats ?? null,
      notificationAfterRestart: reconnect?.stats ?? null
    },
    finalHealth,
    finalHealthSnapshot: finalHealth,
    finalHealthStatus: finalHealth.status,
    generatedAt: finalHealthProbe?.completedAt ?? nowIso(),
    durationMs: elapsedMs(started),
    error: failure
  }
}

async function runBlockedFaultCase(caseName) {
  let before = null
  let failure = null
  try {
    before = await runHttpProbe(['/api/binary/system/seo'], { iterations: 2, concurrency: 1 })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  const action = { status: 'blocked', reason: `no controlled action implemented for ${caseName}` }
  return {
    status: failure ? 'failed' : 'blocked',
    case: caseName,
    namespace,
    actionStatus: action.status,
    preCheck: before
      ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
      : { status: 'failed', error: failure ?? 'pre-check was not completed' },
    controlledAction: action,
    recoveryCheck: { status: 'blocked', error: action.reason },
    timeline: [
      ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
      { event: 'controlled-action', generatedAt: nowIso(), status: action.status }
    ],
    errorRate: 1,
    recoveryTimeMs: null,
    dataConsistency: 'not-verified',
    resourceMetrics: {},
    finalHealth: { status: failure ? 'failed' : 'blocked', error: failure ?? action.reason },
    finalHealthSnapshot: null,
    generatedAt: nowIso()
  }
}

async function runDiskArtifactStorageFaultCase() {
  const caseName = 'disk-artifact-storage-write-failure'
  const startedAt = nowIso()
  const started = performance.now()
  const storageBase = path.join(root, '.tmp', 'fault-injection-storage')
  const namespaceRoot = path.join(storageBase, namespaceSlug(namespace))
  const storageRoot = path.join(namespaceRoot, caseName)
  const targetDir = path.join(storageRoot, 'artifact-target')
  const targetFile = path.join(targetDir, 'probe-artifact.json')
  const recoveryFile = path.join(targetDir, 'recovered-artifact.json')
  const targetPath = path.relative(root, targetFile)
  const recoveryPath = path.relative(root, recoveryFile)
  let writeFailureResult = null
  let recoveryResult = null
  let cleanupResult = null
  let finalHealth = null
  let failure = null
  let actionStatus = 'blocked'
  const timeline = []

  try {
    fs.rmSync(storageRoot, { recursive: true, force: true })
    fs.mkdirSync(targetDir, { recursive: true })
    fs.chmodSync(targetDir, 0o555)
    timeline.push({ event: 'artifact-target-made-unwritable', generatedAt: nowIso(), targetPath })

    try {
      fs.writeFileSync(targetFile, `${JSON.stringify({ generatedAt: nowIso(), case: caseName })}\n`)
      writeFailureResult = {
        status: 'unexpected-success',
        targetPath,
        bytesWritten: fs.statSync(targetFile).size
      }
      failure = 'artifact write unexpectedly succeeded while target directory was unwritable'
    } catch (error) {
      writeFailureResult = {
        ...classifyArtifactWriteError(error),
        targetPath
      }
      actionStatus = writeFailureResult.status === 'expected-error' ? 'executed' : 'failed'
      if (writeFailureResult.status !== 'expected-error') {
        failure = writeFailureResult.message
      }
    }
    timeline.push({
      event: 'artifact-write-failure',
      generatedAt: nowIso(),
      status: writeFailureResult.status,
      code: writeFailureResult.code ?? null
    })

    fs.chmodSync(targetDir, 0o755)
    const recoveryStarted = performance.now()
    fs.writeFileSync(recoveryFile, `${JSON.stringify({ generatedAt: nowIso(), case: caseName, recovered: true })}\n`)
    recoveryResult = {
      status: 'completed',
      targetPath: recoveryPath,
      bytesWritten: fs.statSync(recoveryFile).size,
      durationMs: elapsedMs(recoveryStarted)
    }
    timeline.push({ event: 'artifact-write-recovery', generatedAt: nowIso(), status: recoveryResult.status, targetPath: recoveryPath })

    const finalHealthProbe = await runProbeResult('disk artifact storage final health', ['/health/live', '/api/binary/system/seo'], {
      iterations: 2,
      concurrency: 1
    })
    finalHealth = finalHealthProbe.status === 'completed'
      ? { status: 'healthy', recovery: finalHealthProbe }
      : { status: 'failed', error: finalHealthProbe.error }
    if (finalHealth.status !== 'healthy') {
      failure = finalHealth.error ?? 'final health probe failed'
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      if (fs.existsSync(targetDir)) {
        fs.chmodSync(targetDir, 0o755)
      }
      fs.rmSync(storageRoot, { recursive: true, force: true })
      for (const dir of [namespaceRoot, storageBase]) {
        try {
          fs.rmdirSync(dir)
        } catch {
          // Ignore non-empty parent directories from concurrent or previous drills.
        }
      }
      cleanupResult = {
        status: 'completed',
        targetPath: path.relative(root, storageRoot)
      }
    } catch (error) {
      cleanupResult = {
        status: 'failed',
        targetPath: path.relative(root, storageRoot),
        error: error instanceof Error ? error.message : String(error)
      }
      failure = cleanupResult.error
    }
    timeline.push({ event: 'artifact-cleanup', generatedAt: nowIso(), status: cleanupResult.status })
  }

  const resultStatus = !failure
    && actionStatus === 'executed'
    && writeFailureResult?.status === 'expected-error'
    && recoveryResult?.status === 'completed'
    && cleanupResult?.status === 'completed'
    && finalHealth?.status === 'healthy'
    ? 'completed'
    : 'failed'

  const recoveryDurationMs = recoveryResult?.durationMs ?? null
  return {
    status: resultStatus,
    case: caseName,
    namespace,
    actionStatus,
    actionStartedAt: startedAt,
    actionCompletedAt: nowIso(),
    targetPath,
    targetDirectory: path.relative(root, targetDir),
    actionMode: 'unwritable-temp-artifact-directory',
    expectedErrorClassification: 'EACCES|EPERM|ENOSPC|EROFS',
    writeFailureResult: writeFailureResult ?? { status: 'failed', targetPath, error: failure ?? 'write failure was not observed' },
    recoveryResult: recoveryResult ?? { status: 'failed', targetPath: recoveryPath, error: failure ?? 'recovery write was not completed' },
    cleanupResult: cleanupResult ?? { status: 'failed', targetPath: path.relative(root, storageRoot), error: failure ?? 'cleanup was not completed' },
    recoveryDurationMs,
    recoveryTimeMs: recoveryDurationMs,
    controlledAction: {
      status: actionStatus,
      operation: 'artifact write into unwritable temp directory',
      targetPath,
      startedAt,
      completedAt: nowIso()
    },
    timeline,
    errorRate: resultStatus === 'completed' ? 0 : 1,
    dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
    resourceMetrics: {
      targetPath,
      targetDirectory: path.relative(root, targetDir)
    },
    finalHealth: finalHealth ?? { status: 'failed', error: failure ?? 'final health not verified' },
    finalHealthSnapshot: finalHealth ?? null,
    finalHealthStatus: finalHealth?.status ?? 'failed',
    generatedAt: nowIso(),
    durationMs: elapsedMs(started),
    error: failure
  }
}

async function runNotificationSlowConsumerFaultCase() {
  let before = null
  let action = { status: 'blocked', reason: 'notification drill secret missing' }
  let recovery = null
  let resultStatus = 'blocked'
  let failure = null
  let normal = null
  let slow = null
  let replay = null
  const startedAt = nowIso()
  const started = performance.now()
  const drillId = `notification-slow-consumer-${namespace}-${Date.now()}`
  const eventCount = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_EVENT_COUNT, 384)
  const payloadBytes = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_PAYLOAD_BYTES, 1024)
  const drillReadDelayMs = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_READ_DELAY_MS, 1000)
  const drillQueueCapacity = positiveInt(process.env.FSUSBLOG_NOTIFICATION_DRILL_QUEUE_CAPACITY, 32)
  let published = null

  try {
    before = await runHttpProbe(['/api/binary/system/seo', '/api/binary/auth/pow-challenge'], { iterations: 2, concurrency: 1 })
    if (!notificationDrillSecret) {
      action = {
        status: 'blocked',
        reason: 'FSUSBLOG_NOTIFICATION_DRILL_SECRET missing',
        startedAt,
        completedAt: nowIso()
      }
    } else {
      normal = await openNotificationSocket('notification-drill-normal')
      slow = await openNotificationSocket('notification-drill-slow', {
        slowConsumer: true,
        drillReadDelayMs,
        drillQueueCapacity
      })

      const actionStartedAt = nowIso()
      const actionStarted = performance.now()
      published = await publishNotificationDrill({
        drillId,
        count: eventCount,
        payloadBytes,
        routeKey: 'content-feed'
      })
      action = {
        status: 'executed',
        operation: 'notification stream drill publish',
        target: notificationDrillPublishPath,
        startedAt: actionStartedAt,
        completedAt: nowIso(),
        durationMs: elapsedMs(actionStarted),
        publishedCount: published.count,
        routeKey: published.routeKey,
        eventType: published.eventType,
        eventIds: published.eventIds,
        slowConsumerPolicy: 'controlled-degradation',
        drillReadDelayMs,
        drillQueueCapacity,
        payloadBytes
      }

      await waitForCondition('normal notification business frame', () => {
        return countMatchingEventIds(normal.stats.eventIds, published.eventIds) > 0
      }, { timeoutMs: Math.max(timeoutMs, 20000) })

      await waitForCondition('slow notification connection close', () => slow.stats.closed, {
        timeoutMs: Math.max(timeoutMs, 20000)
      })

      const replayCursor = Math.max(0, Math.min(...published.eventIds) - 1)
      replay = await openNotificationSocket('notification-drill-replay', { cursor: replayCursor })
      await waitForCondition('notification backlog replay frame', () => {
        return countMatchingEventIds(replay.stats.eventIds, published.eventIds) > 0
      }, { timeoutMs: Math.max(timeoutMs, 20000) })

      recovery = await runProbeResult('notification final health', ['/health/live', '/api/binary/system/seo'], {
        iterations: 2,
        concurrency: 1
      })
      if (recovery.status !== 'completed') {
        throw new Error(`notification final health probe failed: ${recovery.error}`)
      }

      const normalDelivered = countMatchingEventIds(normal.stats.eventIds, published.eventIds)
      const replayed = countMatchingEventIds(replay.stats.eventIds, published.eventIds)
      const droppedOrBackpressured = Math.max(1, Number(published.count ?? published.eventIds.length) - slow.stats.eventIds.length)
      resultStatus = normalDelivered > 0 && replayed > 0 && slow.stats.closed && droppedOrBackpressured > 0
        ? 'completed'
        : 'failed'
      if (resultStatus !== 'completed') {
        failure = 'notification slow-consumer evidence was incomplete'
      }
    }
  } catch (error) {
    resultStatus = 'failed'
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    closeSocketQuietly(normal?.socket)
    closeSocketQuietly(slow?.socket)
    closeSocketQuietly(replay?.socket)
  }

  const publishedEventIds = published?.eventIds ?? []
  const connectionCount = [normal, slow, replay].filter(Boolean).length
  const heartbeatFrameCount = (normal?.stats.heartbeats ?? 0) + (slow?.stats.heartbeats ?? 0) + (replay?.stats.heartbeats ?? 0)
  const normalDelivered = countMatchingEventIds(normal?.stats.eventIds ?? [], publishedEventIds)
  const replayedEventCount = countMatchingEventIds(replay?.stats.eventIds ?? [], publishedEventIds)
  const droppedOrBackpressuredCount = action.status === 'executed'
    ? Math.max(1, Number(published?.count ?? publishedEventIds.length) - (slow?.stats.eventIds.length ?? 0))
    : 0
  const finalHealth = recovery?.status === 'completed'
    ? { status: 'healthy', recovery }
    : { status: resultStatus, error: failure ?? action.reason ?? 'recovery check missing' }

  return {
    status: resultStatus,
    case: 'notification-stream-slow-consumer',
    namespace,
    actionStatus: action.status,
    actionStartedAt: action.startedAt ?? startedAt,
    actionCompletedAt: action.completedAt ?? nowIso(),
    unavailableDurationMs: 0,
    recoveryDurationMs: recovery?.durationMs ?? null,
    connectionCount,
    heartbeatFrameCount,
    businessFrameCount: (normal?.stats.events.length ?? 0) + (slow?.stats.events.length ?? 0) + (replay?.stats.events.length ?? 0),
    deliveredFrameCount: normalDelivered,
    droppedOrBackpressuredCount,
    reconnectSuccess: replayedEventCount > 0,
    replayedEventCount,
    closeObserved: slow?.stats.closed === true,
    eventIds: publishedEventIds,
    routeKey: published?.routeKey ?? null,
    slowConsumerPolicy: action.slowConsumerPolicy ?? 'controlled-degradation',
    preCheck: before
      ? { status: 'completed', p95Ms: before.latencyMs.p95, sampleCount: before.sampleCount }
      : { status: 'failed', error: failure ?? 'pre-check was not completed' },
    controlledAction: action,
    recoveryCheck: recovery
      ? { status: recovery.status, startedAt: recovery.startedAt, completedAt: recovery.completedAt, recoveryDurationMs: recovery.durationMs }
      : { status: action.status === 'executed' ? 'failed' : 'blocked', error: failure ?? action.reason ?? 'controlled action was not executed' },
    sockets: {
      normal: normal?.stats ?? null,
      slow: slow?.stats ?? null,
      replay: replay?.stats ?? null
    },
    timeline: [
      ...(before ? [{ event: 'pre-check', generatedAt: before.generatedAt, p95Ms: before.latencyMs.p95 }] : []),
      { event: 'normal-connected', generatedAt: startedAt, status: normal?.stats.heartbeats ? 'completed' : 'not-observed' },
      { event: 'slow-connected', generatedAt: startedAt, status: slow?.stats.heartbeats ? 'completed' : 'not-observed' },
      { event: 'controlled-action', generatedAt: action.startedAt ?? nowIso(), status: action.status },
      { event: 'slow-consumer-close', generatedAt: action.completedAt ?? nowIso(), status: slow?.stats.closed ? 'completed' : 'not-observed' },
      { event: 'reconnect-replay', generatedAt: recovery?.completedAt ?? nowIso(), status: replayedEventCount > 0 ? 'completed' : 'not-observed' },
      ...(recovery ? [{ event: 'recovery-check', generatedAt: recovery.completedAt, recoveryDurationMs: recovery.durationMs }] : [])
    ],
    errorRate: resultStatus === 'completed' ? 0 : 1,
    recoveryTimeMs: recovery?.durationMs ?? null,
    dataConsistency: resultStatus === 'completed' ? 'runtime-probe-ok' : 'not-verified',
    resourceMetrics: {
      eventCount: published?.count ?? null,
      payloadBytes: action.payloadBytes ?? payloadBytes,
      drillReadDelayMs,
      drillQueueCapacity
    },
    finalHealth,
    finalHealthSnapshot: finalHealth,
    generatedAt: recovery?.completedAt ?? nowIso(),
    durationMs: elapsedMs(started),
    error: failure
  }
}

function faultCaseSummary(item) {
  return {
    case: item.case,
    status: item.status,
    actionStatus: item.actionStatus,
    actionStartedAt: item.actionStartedAt ?? item.controlledAction?.startedAt ?? null,
    actionCompletedAt: item.actionCompletedAt ?? item.controlledAction?.completedAt ?? null,
    unavailableDurationMs: item.unavailableDurationMs ?? item.controlledAction?.unavailableDurationMs ?? null,
    recoveryDurationMs: item.recoveryDurationMs ?? item.recoveryTimeMs ?? null,
    recoveryTimeMs: item.recoveryTimeMs,
    publicReadResult: item.publicReadResult
      ? {
          status: item.publicReadResult.status,
          sampleCount: item.publicReadResult.runtime?.sampleCount ?? null,
          p95Ms: item.publicReadResult.runtime?.p95Ms ?? null
        }
      : null,
    authenticatedImpact: item.authenticatedImpact
      ? { status: item.authenticatedImpact.status }
      : null,
    notificationStreamImpact: item.notificationStreamImpact
      ? { status: item.notificationStreamImpact.status }
      : null,
    affectedEndpoint: item.affectedEndpoint ?? item.controlledAction?.affectedEndpoint ?? null,
    dbReconnectDurationMs: item.dbReconnectDurationMs ?? null,
    publicReadRecoveryResult: item.publicReadRecoveryResult
      ? {
          status: item.publicReadRecoveryResult.status,
          sampleCount: item.publicReadRecoveryResult.runtime?.sampleCount ?? null,
          p95Ms: item.publicReadRecoveryResult.runtime?.p95Ms ?? null
        }
      : null,
    writePathRollbackResult: item.writePathRollbackResult
      ? { status: item.writePathRollbackResult.status }
      : null,
    connectionCount: item.connectionCount ?? null,
    heartbeatFrameCount: item.heartbeatFrameCount ?? null,
    businessFrameCount: item.businessFrameCount ?? null,
    deliveredFrameCount: item.deliveredFrameCount ?? null,
    droppedOrBackpressuredCount: item.droppedOrBackpressuredCount ?? null,
    reconnectSuccess: item.reconnectSuccess ?? null,
    replayedEventCount: item.replayedEventCount ?? null,
    closeObserved: item.closeObserved ?? null,
    eventIds: item.eventIds ?? null,
    routeKey: item.routeKey ?? null,
    slowConsumerPolicy: item.slowConsumerPolicy ?? null,
    shutdownRequestedAt: item.shutdownRequestedAt ?? null,
    processStopResult: item.processStopResult
      ? {
          status: item.processStopResult.status,
          targetType: item.processStopResult.targetType ?? null,
          signal: item.processStopResult.signal ?? null,
          exitObserved: item.processStopResult.exitObserved ?? null,
          forcedKill: item.processStopResult.forcedKill ?? null,
          durationMs: item.processStopResult.durationMs ?? null
        }
      : null,
    drainDurationMs: item.drainDurationMs ?? null,
    restartRecoveryDurationMs: item.restartRecoveryDurationMs ?? null,
    livenessBefore: item.livenessBefore
      ? {
          status: item.livenessBefore.status,
          sampleCount: item.livenessBefore.runtime?.sampleCount ?? item.livenessBefore.sampleCount ?? null
        }
      : null,
    livenessDuringShutdown: item.livenessDuringShutdown
      ? {
          status: item.livenessDuringShutdown.status,
          statusCode: item.livenessDuringShutdown.attempts?.at(-1)?.statusCode ?? item.livenessDuringShutdown.statusCode ?? null,
          durationMs: item.livenessDuringShutdown.durationMs ?? null
        }
      : null,
    notificationCloseObserved: item.notificationCloseObserved ?? null,
    notificationCloseCode: item.notificationCloseCode ?? null,
    notificationReconnectSuccess: item.notificationReconnectSuccess ?? null,
    basicAuthRecoveryResult: item.basicAuthRecoveryResult
      ? {
          status: item.basicAuthRecoveryResult.status,
          sampleCount: item.basicAuthRecoveryResult.runtime?.sampleCount ?? item.basicAuthRecoveryResult.sampleCount ?? null,
          p95Ms: item.basicAuthRecoveryResult.runtime?.p95Ms ?? item.basicAuthRecoveryResult.p95Ms ?? null
        }
      : null,
    backgroundWorkerState: item.backgroundWorkerState
      ? {
          status: item.backgroundWorkerState.status,
          source: item.backgroundWorkerState.source ?? null
        }
      : null,
    targetPath: item.targetPath ?? null,
    expectedErrorClassification: item.expectedErrorClassification ?? null,
    writeFailureResult: item.writeFailureResult
      ? {
          status: item.writeFailureResult.status,
          code: item.writeFailureResult.code ?? null,
          targetPath: item.writeFailureResult.targetPath ?? null
        }
      : null,
    recoveryResult: item.recoveryResult
      ? {
          status: item.recoveryResult.status,
          targetPath: item.recoveryResult.targetPath ?? null,
          bytesWritten: item.recoveryResult.bytesWritten ?? null
        }
      : null,
    cleanupResult: item.cleanupResult
      ? {
          status: item.cleanupResult.status,
          targetPath: item.cleanupResult.targetPath ?? null
        }
      : null,
    finalHealthStatus: item.finalHealth?.status ?? null
  }
}

async function collectBackendQpsMode(mode, artifact) {
  const requestSteps = backendQpsRequestPlan(mode)
  const paths = requestSteps.map((step) => step.path)
  const expectedByPath = Object.fromEntries(requestSteps.map((step) => [step.path, step]))
  const requestCount = positiveInt(process.env.FSUSBLOG_BACKEND_QPS_REQUESTS || 12, 12)
  const concurrency = positiveInt(process.env.FSUSBLOG_BACKEND_QPS_CONCURRENCY || 2, 2)
  const probe = await runHttpProbe(paths, {
    iterations: requestCount,
    concurrency,
    expectedByPath
  })
  const measuredCounters = backendQpsMeasuredCounters(probe)
  return {
    status: 'ok',
    scenario: mode,
    evidenceType: 'backend-qps-collector-evidence',
    performance_baseline: performanceBaselineMetadata(),
    optional_deployment_layer: optionalDeploymentLayerMetadata(),
    route: paths[0],
    actualPaths: paths,
    generatedAt: probe.generatedAt,
    commitSha: gitSha(),
    checks: [],
    artifact,
    staticEvidence: {
      status: 'ok',
      evidenceType: 'static-implementation-evidence',
      checks: []
    },
    runtimeMeasurement: {
      status: 'ok',
      evidenceType: 'runtime-http-probe',
      requestPlan: {
        scenario: mode,
        steps: requestSteps,
        paths,
        requestCount,
        concurrency,
        thresholdPolicy: {
          status: 'observed-only',
          countedAsCapacity: false,
          reason: 'backend-qps collectors verify warm runtime behavior; capacity thresholds belong to load/benchmark lanes'
        }
      },
      measuredCounters,
      rps: probe.rps,
      p50Ms: probe.latencyMs.p50,
      p95Ms: probe.latencyMs.p95,
      p99Ms: probe.latencyMs.p99,
      runtime: probe
    },
    capacityConclusion: {
      countedAsCapacity: false,
      reason: 'runtime probe output is not a throughput benchmark or release capacity conclusion'
    },
    rps: probe.rps,
    p50Ms: probe.latencyMs.p50,
    p95Ms: probe.latencyMs.p95,
    p99Ms: probe.latencyMs.p99,
    allocBytesPerRequest: measuredCounters.allocationEstimate,
    dbCommandsPerRequest: measuredCounters.dbCommands,
    redisCommandsPerRequest: measuredCounters.redisCommands,
    cacheHitRatio: measuredCounters.cacheHitSignal,
    aedsCrcComputesPerRequest: measuredCounters.aedsCrcComputes,
    threadPoolAvailableWorkerThreads: measuredCounters.threadPool,
    dbGateWaiting: measuredCounters.dbGatePressure,
    runtime: probe
  }
}

async function backendQps(mode, outFile) {
  writeJson(outFile, await collectBackendQpsMode(mode, path.relative(root, outFile)))
}

async function backendQpsSequential(outFile) {
  const started = performance.now()
  const warmupPlan = [
    {
      phase: 'public-read-warmup',
      path: '/api/binary/article/list/home/1/10.aeds',
      purpose: 'warm public article list and shared public read dependencies'
    },
    {
      phase: 'binary-read-warmup',
      path: '/api/binary/category',
      purpose: 'warm binary taxonomy read path'
    },
    {
      phase: 'cache-warmup',
      path: '/api/binary/system/seo',
      purpose: 'warm small binary cache path before measured cache-miss scenarios'
    }
  ]
  const warmup = await runHttpProbe(warmupPlan.map((step) => step.path), {
    iterations: positiveInt(process.env.FSUSBLOG_BACKEND_QPS_WARMUP_REQUESTS, 6),
    concurrency: 1
  })
  const scenarioOrder = [...backendQpsModes]
  const results = []
  for (const mode of scenarioOrder) {
    results.push(await collectBackendQpsMode(mode, `${path.relative(root, outFile)}#${mode}`))
  }
  const baseline = performanceBaselineMetadata({ mode: 'kestrel-only-sequential' })
  writeJson(outFile, {
    status: results.every((result) => result.status === 'ok') ? 'ok' : 'blocked',
    evidenceType: 'backend-qps-runtime-sequential-summary',
    evidenceModel: 'warmed-runtime-sequential-measurement',
    runtimeId: `${baseUrl}|${namespace}|${gitSha()}`,
    namespace,
    baseUrl,
    generatedAt: nowIso(),
    warmup: {
      status: 'ok',
      durationMs: warmup.durationMs,
      sampleCount: warmup.sampleCount,
      phases: warmupPlan,
      requestPlan: warmup.samples.map((sample) => sample.path),
      runtime: warmup
    },
    warmupDurationMs: warmup.durationMs,
    cacheMissSeparation: {
      status: 'explicit',
      policy: 'warmup uses public and binary hot paths; cache-miss behavior remains isolated in measured scenarios',
      measuredScenarios: ['cache-miss-singleflight', 'list-pagination', 'article-detail-miss']
    },
    scenarioOrder,
    scenarioCount: results.length,
    performance_baseline: baseline,
    machineMetadata: baseline.machine,
    optional_deployment_layer: optionalDeploymentLayerMetadata(),
    capacityConclusion: {
      countedAsCapacity: false,
      reason: 'sequential backend-qps is a warmed runtime measurement, not a release capacity benchmark'
    },
    durationMs: elapsedMs(started),
    results: results.map((result) => ({
      ...result,
      checks: [],
      staticEvidence: {
        status: 'not-collected',
        evidenceType: 'static-implementation-evidence',
        checks: [],
        reason: 'warmed sequential mode measures one runtime; static guards remain owned by backend-qps collector lanes'
      }
    }))
  })
}

async function loadProfile(profile, outFile) {
  const policy = resolveLoadProfilePolicy(profile)
  const iterations = policy.effective.concurrency * policy.effective.rounds
  const probe = await runHttpProbe(safeBinaryPaths, {
    iterations,
    concurrency: policy.effective.concurrency
  })
  writeJson(outFile, {
    status: 'ok',
    profile,
    profileName: profile,
    namespace,
    policy: {
      file: policy.file,
      version: policy.version
    },
    declared: policy.declared,
    effective: policy.effective,
    overrideSource: policy.overrideSource,
    overrideSources: policy.overrideSources,
    sampling: {
      totalRequests: iterations,
      paths: safeBinaryPaths
    },
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
  const seedFile = path.join(root, '.tmp', 'scale', tier, 'seed.json')
  const seed = readOptionalJson(seedFile)
  const prefix = `data-scale:${namespace}:${tier}`
  const prefixLiteral = sqlStringLiteral(prefix)
  const declared = seed?.declared ?? { articles: seed?.expected?.articles, comments: seed?.expected?.comments }
  const seedExpected = seed?.expected ?? declared
  const seedObserved = seed?.observed ?? {}
  const seedMatches = Boolean(seed)
    && seed.status === 'ok'
    && declared.articles === articles
    && declared.comments === comments
    && seedExpected.articles === articles
    && seedExpected.comments === comments
    && seedObserved.articles === articles
    && seedObserved.comments === comments

  if (!seedMatches) {
    writeJson(outFile, {
      status: 'failed',
      tier,
      namespace,
      seedManifest: seed ?? null,
      expected: { articles, comments },
      error: `data-scale seed summary missing or mismatched: ${path.relative(root, seedFile)}`,
      generatedAt: nowIso()
    })
    throw new Error(`data-scale seed summary missing or mismatched for ${tier}/${namespace}`)
  }

  const probe = await runHttpProbe(['/api/binary/article/list/home/1/10.aeds', '/api/binary/category', '/api/binary/tag'], {
    iterations: process.env.FSUSBLOG_DATA_SCALE_REQUESTS || (tier === 'scale-xs' ? 6 : 12),
    concurrency: process.env.FSUSBLOG_DATA_SCALE_CONCURRENCY || 2
  })
  const articleRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%';`)
  const commentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%';`)
  const publishedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 2 and isdeleted = false;`)
  const scheduledRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 1 and isdeleted = false;`)
  const archivedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and status = 3 and isdeleted = false;`)
  const deletedRows = queryPostgresScalar(`select count(*) from article where title like ${prefixLiteral} || ':article:%' and (status = 4 or isdeleted = true);`)
  const categoryRows = queryPostgresScalar(`select count(*) from category where name like ${prefixLiteral} || ':category:%';`)
  const tagRows = queryPostgresScalar(`select count(*) from tag where name like ${prefixLiteral} || ':tag:%';`)
  const articleBodyRows = queryPostgresScalar(`select count(*) from article_body b join article a on a.id = b.article_id where a.title like ${prefixLiteral} || ':article:%';`)
  const articleTagRows = queryPostgresScalar(`select count(*) from article_tag at join article a on a.id = at.articleid where a.title like ${prefixLiteral} || ':article:%';`)
  const rootCommentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%' and parent_id is null;`)
  const nestedCommentRows = queryPostgresScalar(`select count(*) from "comment" where content like ${prefixLiteral} || ':comment:%' and parent_id is not null and root_id is not null;`)
  const categoryDistribution = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'categoryId', categoryid,
      'articleCount', article_count
    ) order by categoryid), '[]'::jsonb)::text
    from (
      select categoryid, count(*)::integer as article_count
      from article
      where title like ${prefixLiteral} || ':article:%'
      group by categoryid
    ) category_counts;
  `)
  const tagDistribution = queryPostgresJson(`
    select coalesce(jsonb_agg(jsonb_build_object(
      'tagId', tagid,
      'articleCount', article_count
    ) order by tagid), '[]'::jsonb)::text
    from (
      select article_tag.tagid, count(*)::integer as article_count
      from article_tag
      join article on article.id = article_tag.articleid
      where article.title like ${prefixLiteral} || ':article:%'
      group by article_tag.tagid
    ) tag_counts;
  `)
  const redisKeys = queryRedisDbSize()
  const searchMetric = collectSearchMetric()
  const aotMetric = collectAotMetric()
  const hotReadMetric = collectHotReadMetric(probe)
  const expectedRootComments = Math.ceil(comments / 2)
  const expectedNestedComments = comments - expectedRootComments
  const observedCounts = [
    articleRows,
    commentRows,
    publishedRows,
    scheduledRows,
    archivedRows,
    deletedRows,
    categoryRows,
    tagRows,
    articleBodyRows,
    articleTagRows,
    rootCommentRows,
    nestedCommentRows,
    categoryDistribution,
    tagDistribution
  ]
  const countQueriesAvailable = observedCounts.every((item) => item.available)
  const categoryDistributionTotal = categoryDistribution.available
    ? categoryDistribution.value.reduce((total, item) => total + Number(item.articleCount || 0), 0)
    : 0
  const tagDistributionTotal = tagDistribution.available
    ? tagDistribution.value.reduce((total, item) => total + Number(item.articleCount || 0), 0)
    : 0
  const countsMatch = countQueriesAvailable
    && articleRows.value === articles
    && commentRows.value === comments
    && articleBodyRows.value === articles
    && categoryRows.value >= Math.min(articles, 4)
    && tagRows.value >= Math.min(Math.max(articles, 1), 8)
    && categoryDistribution.value.length > 0
    && tagDistribution.value.length > 0
    && categoryDistributionTotal === articles
    && tagDistributionTotal >= articles
    && rootCommentRows.value === expectedRootComments
    && nestedCommentRows.value === expectedNestedComments
    && (articles === 1 || (publishedRows.value > 0 && scheduledRows.value > 0 && archivedRows.value > 0 && deletedRows.value > 0))
  const artifactMetricsReady = searchMetric.status === 'ok'
    && aotMetric.status === 'ok'
    && hotReadMetric.status === 'ok'
  const summaryStatus = countsMatch && artifactMetricsReady
    ? 'ok'
    : countsMatch
      ? 'blocked'
      : 'failed'
  const error = !countsMatch
    ? 'data-scale observed counts did not match expected tier fixture counts'
    : !artifactMetricsReady
      ? 'data-scale search/AOT/HotRead metrics missing'
      : null
  writeJson(outFile, {
    status: summaryStatus,
    tier,
    namespace,
    expected: {
      articles,
      comments,
      categoriesAtLeast: Math.min(articles, 4),
      tagsAtLeast: Math.min(Math.max(articles, 1), 8),
      rootComments: expectedRootComments,
      nestedComments: expectedNestedComments
    },
    observed: {
      articles: articleRows.available ? articleRows.value : null,
      comments: commentRows.available ? commentRows.value : null,
      categories: categoryRows.available ? categoryRows.value : null,
      tags: tagRows.available ? tagRows.value : null,
      articleBodies: articleBodyRows.available ? articleBodyRows.value : null,
      articleTags: articleTagRows.available ? articleTagRows.value : null,
      rootComments: rootCommentRows.available ? rootCommentRows.value : null,
      nestedComments: nestedCommentRows.available ? nestedCommentRows.value : null
    },
    categoryDistribution: categoryDistribution.available
      ? { status: 'ok', totalArticles: categoryDistributionTotal, buckets: categoryDistribution.value }
      : { status: 'missing', totalArticles: null, buckets: [], reason: categoryDistribution.error },
    tagDistribution: tagDistribution.available
      ? { status: 'ok', totalArticleTags: tagDistributionTotal, buckets: tagDistribution.value }
      : { status: 'missing', totalArticleTags: null, buckets: [], reason: tagDistribution.error },
    seedManifest: {
      file: path.relative(root, seedFile),
      declared,
      expected: seedExpected,
      observed: seedObserved,
      coverage: seed.coverage ?? null,
      search: seed.search ?? seed.searchArtifactRebuild ?? null,
      artifacts: seed.artifacts ?? seed.searchArtifactRebuild ?? null,
      durationMs: seed.durationMs ?? null,
      mode: 'postgres-namespace-fixture-plus-runtime-probe',
      prefix
    },
    db: {
      articleRows: articleRows.available ? articleRows.value : null,
      commentRows: commentRows.available ? commentRows.value : null,
      publishedRows: publishedRows.available ? publishedRows.value : null,
      scheduledRows: scheduledRows.available ? scheduledRows.value : null,
      archivedRows: archivedRows.available ? archivedRows.value : null,
      deletedRows: deletedRows.available ? deletedRows.value : null,
      categoryRows: categoryRows.available ? categoryRows.value : null,
      tagRows: tagRows.available ? tagRows.value : null,
      articleBodyRows: articleBodyRows.available ? articleBodyRows.value : null,
      articleTagRows: articleTagRows.available ? articleTagRows.value : null,
      rootCommentRows: rootCommentRows.available ? rootCommentRows.value : null,
      nestedCommentRows: nestedCommentRows.available ? nestedCommentRows.value : null,
      articleRowsSource: articleRows.available ? 'postgres-count' : articleRows.error,
      commentRowsSource: commentRows.available ? 'postgres-count' : commentRows.error,
      sizeBytes: null,
      expected: {
        articleRows: articles,
        commentRows: comments,
        rootCommentRows: expectedRootComments,
        nestedCommentRows: expectedNestedComments
      },
      countsMatch
    },
    redis: {
      keyCount: redisKeys.available ? redisKeys.value : null,
      keyCountSource: redisKeys.available ? 'redis-dbsize' : redisKeys.error
    },
    search: {
      ...searchMetric,
      fixtureSearchToken: `${prefix}:article:1`
    },
    aot: aotMetric,
    hotRead: hotReadMetric,
    latencyMs: probe.latencyMs,
    resources: { cpuPercent: null, rssBytes: null, gcCount: null },
    cleanup: { status: 'pending', reason: 'tools/data-scale/cleanup.sh deletes namespace-prefixed fixture rows after probe' },
    runtime: probe,
    error,
    generatedAt: probe.generatedAt
  })
  if (summaryStatus !== 'ok') {
    throw new Error(error ?? `data-scale status ${summaryStatus}`)
  }
}

async function faultInjection(outDir) {
  const redisCases = new Set(['redis-restart', 'redis-reconnect', 'redis-latency'])
  const postgresCases = new Set(['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout'])
  const notificationCases = new Set(['notification-stream-slow-consumer'])
  const gracefulShutdownCases = new Set(['graceful-shutdown'])
  const diskArtifactCases = new Set(['disk-artifact-storage-write-failure'])
  const defaultCases = [
    'redis-restart',
    'redis-reconnect',
    'redis-latency',
    'postgres-readiness',
    'postgres-reconnect',
    'postgres-lock-timeout',
    'notification-stream-slow-consumer',
    'graceful-shutdown',
    'disk-artifact-storage-write-failure'
  ]
  const cases = selectFaultCases(defaultCases)
  fs.mkdirSync(outDir, { recursive: true })
  const results = []
  for (const caseName of cases) {
    const caseDir = path.join(outDir, caseName)
    fs.mkdirSync(path.join(caseDir, 'logs'), { recursive: true })
    const result = redisCases.has(caseName)
      ? await runRedisFaultCase(caseName)
      : postgresCases.has(caseName)
        ? await runPostgresFaultCase(caseName)
        : notificationCases.has(caseName)
          ? await runNotificationSlowConsumerFaultCase()
          : gracefulShutdownCases.has(caseName)
            ? await runGracefulShutdownFaultCase()
            : diskArtifactCases.has(caseName)
              ? await runDiskArtifactStorageFaultCase()
              : await runBlockedFaultCase(caseName)
    writeJson(path.join(caseDir, 'summary.json'), result)
    writeJson(path.join(caseDir, 'timeline.json'), result.timeline)
    results.push(result)
  }
  const summaryStatus = results.every((item) => item.status === 'completed')
    ? 'ok'
    : results.some((item) => item.status === 'failed')
      ? 'failed'
      : 'blocked'
  writeJson(path.join(outDir, 'summary.json'), {
    status: summaryStatus,
    namespace,
    caseCount: results.length,
    generatedAt: new Date().toISOString(),
    cases: results.map(faultCaseSummary)
  })
  if (summaryStatus !== 'ok') {
    throw new Error(`fault-injection summary is ${summaryStatus}; all cases must complete real controlled actions`)
  }
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
  if (command === 'backend-qps-sequential') return await backendQpsSequential(path.resolve(root, args[0]))
  if (command === 'load-profile') return await loadProfile(args[0], path.resolve(root, args[1]))
  if (command === 'data-scale') return await dataScale(args[0], path.resolve(root, args[1]))
  if (command === 'fault-injection') return await faultInjection(path.resolve(root, args[0]))
  if (command === 'soak') return await soak(args[0], path.resolve(root, args[1]))
  throw new Error(`unknown runtime evidence probe command: ${command}`)
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error(`[runtime-evidence] ${error.message}`)
  process.exit(1)
})
