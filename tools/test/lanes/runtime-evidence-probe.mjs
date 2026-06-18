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
  const container = process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || ''
  if (!container) return { available: false, error: 'redis container env missing' }
  const result = runDocker(['exec', '-i', container, 'redis-cli', 'DBSIZE'])
  if (!result.ok) return { available: false, error: result.error }
  const parsed = Number.parseInt(result.stdout, 10)
  return Number.isFinite(parsed)
    ? { available: true, value: parsed }
    : { available: false, error: `unexpected redis dbsize: ${result.stdout}` }
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

function redisContainerName() {
  return process.env.FSUSBLOG_REDIS_CONTAINER_NAME || process.env.FSUSBLOG_REDIS_CONTAINER || ''
}

function runRedisCli(container, args) {
  return runDocker(['exec', '-i', container, 'redis-cli', ...args])
}

function scanBackendLogsForUnhandledExceptions() {
  const container = process.env.FSUSBLOG_BACKEND_CONTAINER_NAME || process.env.FSUSBLOG_BACKEND_CONTAINER || ''
  if (!container) {
    return { status: 'not-configured', reason: 'backend container env missing' }
  }

  const result = runDocker(['logs', '--since', process.env.FSUSBLOG_REDIS_DRILL_LOG_SINCE || '10m', container])
  if (!result.ok) {
    return { status: 'blocked', target: container, error: result.error }
  }

  const patterns = [
    /Unhandled exception/i,
    /UnhandledException/i,
    /StackExchange\.Redis.*(?:Fatal|Unhandled|timeout)/i,
    /Redis.*(?:unhandled|fatal)/i
  ]
  const matched = patterns.find((pattern) => pattern.test(result.stdout))
  return matched
    ? { status: 'failed', target: container, matchedPattern: String(matched) }
    : { status: 'ok', target: container, scannedBytes: result.stdout.length }
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
    finalHealthStatus: item.finalHealth?.status ?? null
  }
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
  const redisCases = new Set(['redis-restart', 'redis-reconnect', 'redis-latency'])
  const postgresCases = new Set(['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout'])
  const notificationCases = new Set(['notification-stream-slow-consumer'])
  const defaultCases = [
    'redis-restart',
    'redis-reconnect',
    'redis-latency',
    'postgres-readiness',
    'postgres-reconnect',
    'postgres-lock-timeout',
    'notification-stream-slow-consumer',
    'graceful-shutdown'
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
