#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  canonicalJson,
  currentSourceState,
  digest,
  loadRuntimeCacheCatalog,
  RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA,
  RUNTIME_CACHE_RECEIPT_SCHEMA,
  sealReceipt,
  validateRuntimeCacheReceipt,
  writeReceiptPreservingFirstFailure
} from './runtime-cache-evidence-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const observationHeader = 'X-Fsus-Runtime-Evidence-Request'
const secretHeader = 'X-Fsus-Runtime-Evidence-Secret'
const observationRoute = '/_fsus/testing/runtime-cache/observations'
const runtimeSnapshotRoute = '/_fsus/testing/runtime-cache/runtime-snapshot'
const failureSchema = 'fsusblog.runtime-cache-producer-failure.v1'
const defaultOutputDirectory = path.join(root, '.tmp/perf/runtime-cache')

export const implementedRuntimeCacheScenarios = Object.freeze([
  'public-hot-read',
  'article-detail-l1',
  'cache-miss-singleflight',
  'distributed-invalidation',
  'l1-residency',
  'pagination',
  'related-reading',
  'redis-fault-classes',
  'revocation',
  'hot-featured-frame',
  'sitemap',
  'security-projections',
  'telemetry'
])

const evidenceIdPattern = /^[a-z0-9][a-z0-9.-]*$/u

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function nowIso() {
  return new Date().toISOString()
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: options.env ?? process.env
  }).trim()
}

function requireNonEmpty(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
  return value
}

function assertLocalKestrelUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Kestrel URL must use HTTP or HTTPS')
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) {
    throw new Error(`runtime cache evidence refuses to send its secret to non-loopback host ${url.hostname}`)
  }
  return url.href.replace(/\/$/u, '')
}

function parseConnectionString(value) {
  return Object.fromEntries(String(value ?? '').split(';').map((part) => {
    const separator = part.indexOf('=')
    return separator > 0 ? [part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim()] : null
  }).filter(Boolean))
}

function dockerInspectIdentity(container) {
  return run('docker', ['inspect', '--format', '{{.Image}}|{{json .NetworkSettings.Networks}}', container])
}

function dependencyDigest(container, topologyFacts) {
  return digest({ container, inspect: dockerInspectIdentity(container), topologyFacts })
}

function resolveBackendPid(baseUrl, repositoryRoot = root) {
  const explicit = Number.parseInt(process.env.FSUSBLOG_BACKEND_PID ?? '', 10)
  if (Number.isInteger(explicit) && explicit > 0) return explicit

  const namespace = String(process.env.FSUSBLOG_TEST_NAMESPACE ?? 'local').replace(/[^A-Za-z0-9_.-]/gu, '-')
  const pidFile = path.join(repositoryRoot, '.tmp/acceptance', namespace, 'backend.pid')
  if (fs.existsSync(pidFile)) {
    const recorded = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10)
    if (Number.isInteger(recorded) && recorded > 0) return recorded
  }

  const port = new URL(baseUrl).port || (baseUrl.startsWith('https:') ? '443' : '80')
  const listeners = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    .split(/\r?\n/u)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item) && item > 0)
  if (listeners.length !== 1) throw new Error(`expected one Kestrel listener on port ${port}, observed ${listeners.length}`)
  return listeners[0]
}

function resolveServerAssembly(repositoryRoot = root) {
  const explicit = process.env.FSUSBLOG_RUNTIME_CACHE_SERVER_DLL ?? process.env.FSUSBLOG_BACKEND_SERVER_DLL
  const configuration = process.env.FSUSBLOG_RUNTIME_CONFIGURATION || 'Debug'
  const candidate = explicit
    ? path.resolve(explicit)
    : path.join(repositoryRoot, 'src/backend/bin', configuration, 'net10.0/FsusBlog.Server.dll')
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`running server assembly is not available at ${candidate}`)
  }
  return candidate
}

export function collectDefaultExecutionIdentity({ repositoryRoot = root, baseUrl, source }) {
  const processId = resolveBackendPid(baseUrl, repositoryRoot)
  const assembly = resolveServerAssembly(repositoryRoot)
  const backendContainer = process.env.FSUSBLOG_BACKEND_CONTAINER_NAME ?? process.env.FSUSBLOG_BACKEND_CONTAINER ?? ''
  const imageIdentity = backendContainer ? run('docker', ['inspect', '--format', '{{.Image}}', backendContainer]) : null
  if (imageIdentity !== null && !/^sha256:[a-f0-9]{64}$/u.test(imageIdentity)) {
    throw new Error(`backend container image identity is not immutable: ${imageIdentity}`)
  }

  const postgresContainer = requireNonEmpty(
    process.env.FSUSBLOG_POSTGRES_CONTAINER_NAME ?? process.env.FSUSBLOG_PG_CONTAINER,
    'PostgreSQL container identity')
  const redisContainer = requireNonEmpty(
    process.env.FSUSBLOG_REDIS_CONTAINER_NAME ?? process.env.FSUSBLOG_REDIS_CONTAINER,
    'Redis container identity')
  const connection = parseConnectionString(process.env.ConnectionStrings__DefaultConnection)
  const postgresUser = connection.username ?? connection['user id'] ?? 'postgres'
  const postgresDatabase = connection.database ?? 'fsusblog'
  const postgresVersion = run('docker', [
    'exec', '-i', postgresContainer, 'psql', '-U', postgresUser, '-d', postgresDatabase,
    '-Atqc', 'show server_version'
  ])
  const redisInfo = run('docker', ['exec', '-i', redisContainer, 'redis-cli', 'INFO', 'server', 'replication', 'cluster'])
  const redisFacts = Object.fromEntries(redisInfo.split(/\r?\n/u).map((line) => {
    const separator = line.indexOf(':')
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1).trim()] : null
  }).filter(Boolean))
  const redisVersion = requireNonEmpty(redisFacts.redis_version, 'Redis server version')
  const postgresTopology = `container:${postgresContainer};database:${postgresDatabase}`
  const redisTopology = `container:${redisContainer};role:${requireNonEmpty(redisFacts.role, 'Redis role')};replicas:${requireNonNegativeInteger(Number.parseInt(redisFacts.connected_slaves ?? '0', 10), 'Redis replica count')};cluster:${requireNonEmpty(redisFacts.cluster_enabled, 'Redis cluster mode')}`
  const cpuModel = requireNonEmpty(os.cpus()[0]?.model, 'machine CPU model')
  const fixtureFile = process.env.FSUSBLOG_RUNTIME_CACHE_FIXTURE_FILE ?? process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE
  if (!fixtureFile || !fs.existsSync(fixtureFile) || !fs.statSync(fixtureFile).isFile()) {
    throw new Error('a current fixture artifact is required through FSUSBLOG_RUNTIME_CACHE_FIXTURE_FILE or FSUSBLOG_PUBLIC_ID_PROJECTION_FILE')
  }

  const runtimeDigest = sha256Bytes(fs.readFileSync(assembly))
  return {
    source,
    runtime: {
      digest: runtimeDigest,
      imageDigest: imageIdentity ?? runtimeDigest,
      dotnetVersion: requireNonEmpty(run('dotnet', ['--version']), '.NET runtime version'),
      processId,
      kestrelUrl: baseUrl
    },
    dependencies: {
      postgres: {
        version: postgresVersion,
        topology: postgresTopology,
        digest: dependencyDigest(postgresContainer, { version: postgresVersion, topology: postgresTopology })
      },
      redis: {
        version: redisVersion,
        topology: redisTopology,
        digest: dependencyDigest(redisContainer, { version: redisVersion, topology: redisTopology })
      }
    },
    machine: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel,
      logicalCpuCount: os.cpus().length,
      memoryBytes: os.totalmem(),
      runtime: `node ${process.version}`
    },
    fixtureDigest: sha256Bytes(fs.readFileSync(fixtureFile)),
    fixtureFile: path.resolve(fixtureFile),
    redisContainer
  }
}

function redisCategory(verb) {
  if (['GET', 'MGET', 'HGET', 'HMGET', 'HGETALL', 'EXISTS', 'TTL', 'PTTL', 'SCARD', 'SMEMBERS', 'SISMEMBER', 'ZRANGE', 'ZREVRANGE', 'ZSCORE'].includes(verb)) return 'read'
  if (['SET', 'MSET', 'HSET', 'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'SADD', 'SREM', 'ZADD', 'ZREM', 'INCR', 'INCRBY', 'DECR', 'DECRBY'].includes(verb)) return 'write'
  if (['EVAL', 'EVALSHA', 'FCALL'].includes(verb)) return 'atomic-script'
  if (['PUBLISH', 'SUBSCRIBE', 'PSUBSCRIBE'].includes(verb)) return 'delivery'
  if (['MULTI', 'EXEC', 'WATCH', 'UNWATCH'].includes(verb)) return 'transaction'
  return 'other'
}

function pick(value, camel, pascal) {
  return value?.[camel] ?? value?.[pascal]
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function takeObservation({ fetchImpl, baseUrl, secret, requestId, timeoutMs }) {
  const url = `${baseUrl}${observationRoute}/${encodeURIComponent(requestId)}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetchWithTimeout(fetchImpl, url, { headers: { [secretHeader]: secret } }, timeoutMs)
    if (response.status === 200) return await response.json()
    if (response.status !== 404) throw new Error(`observation endpoint returned HTTP ${response.status}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`request-bound observation was not available for ${requestId}`)
}

function normalizeObservedRequest(observation, actual, spec) {
  const observationId = requireNonEmpty(pick(observation, 'requestId', 'RequestId'), 'observation request ID')
  if (observationId !== actual.id) throw new Error(`observation request ID mismatch for ${actual.id}`)
  const method = requireNonEmpty(pick(observation, 'method', 'Method'), 'observation method').toUpperCase()
  if (method !== spec.method) throw new Error(`observation method mismatch for ${actual.id}`)
  const observedPath = requireNonEmpty(pick(observation, 'path', 'Path'), 'observation path')
  const expectedUrl = new URL(spec.path, 'http://runtime.invalid')
  const expectedPath = `${expectedUrl.pathname}${expectedUrl.search}`
  if (observedPath !== expectedPath) throw new Error(`observation path mismatch for ${actual.id}`)
  const status = pick(observation, 'status', 'Status')
  if (status !== actual.status) throw new Error(`observation status mismatch for ${actual.id}`)
  const payloadDigest = requireNonEmpty(pick(observation, 'payloadDigest', 'PayloadDigest'), 'observation payload digest')
  if (payloadDigest !== actual.payloadDigest) throw new Error(`observation payload digest mismatch for ${actual.id}`)
  const layerSource = requireNonEmpty(pick(observation, 'layerSource', 'LayerSource'), 'observation layer source')
  if (!['l0-allow', 'l1-frame', 'l1-object', 'redis', 'database', 'fail-open', 'fail-closed'].includes(layerSource)) {
    throw new Error(`observation layer source is invalid for ${actual.id}: ${layerSource}`)
  }
  const latencyMs = pick(observation, 'latencyMs', 'LatencyMs')
  const allocatedBytes = pick(observation, 'allocatedBytes', 'AllocatedBytes')
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error(`observation latency is invalid for ${actual.id}`)
  requireNonNegativeInteger(allocatedBytes, `observation allocated bytes for ${actual.id}`)
  const redisCommands = pick(observation, 'redisCommands', 'RedisCommands')
  const redisFailureEvents = pick(observation, 'redisFailureEvents', 'RedisFailureEvents')
  const cacheEvents = pick(observation, 'cacheEvents', 'CacheEvents')
  const databaseFingerprints = pick(observation, 'databaseFingerprints', 'DatabaseFingerprints')
  if (!Array.isArray(redisCommands) || !Array.isArray(redisFailureEvents) || !Array.isArray(cacheEvents) || !Array.isArray(databaseFingerprints)) throw new Error(`observation command arrays are missing for ${actual.id}`)
  const databaseCommandCount = pick(observation, 'databaseCommandCount', 'DatabaseCommandCount')
  const databaseDroppedCommandCount = pick(observation, 'databaseDroppedCommandCount', 'DatabaseDroppedCommandCount')
  const databaseLateCommandCount = pick(observation, 'databaseLateCommandCount', 'DatabaseLateCommandCount')
  const databaseObservationStatus = pick(observation, 'databaseObservationStatus', 'DatabaseObservationStatus')
  const databaseAttributionComplete = pick(observation, 'databaseAttributionComplete', 'DatabaseAttributionComplete')
  if (databaseAttributionComplete !== true || databaseObservationStatus !== 'complete' ||
      databaseCommandCount !== databaseFingerprints.length || databaseDroppedCommandCount !== 0 || databaseLateCommandCount !== 0) {
    throw new Error(`database attribution is incomplete for ${actual.id}`)
  }

  return {
    id: actual.id,
    subcaseId: spec.subcaseId,
    method,
    path: observedPath,
    status,
    payloadDigest,
    parityGroup: spec.parityGroup,
    layerSource,
    latencyMs,
    allocatedBytes,
    redisCommands: redisCommands.map((command) => {
      const verb = requireNonEmpty(command, `Redis verb for ${actual.id}`).toUpperCase()
      if (!/^[A-Z]+$/u.test(verb)) throw new Error(`Redis verb is invalid for ${actual.id}: ${verb}`)
      return { verb, category: redisCategory(verb), source: 'stackexchange-redis-profiler' }
    }),
    redisFailureEvents: redisFailureEvents.map((event) => {
      const sequence = pick(event, 'sequence', 'Sequence')
      const elapsedMilliseconds = pick(event, 'elapsedMilliseconds', 'ElapsedMilliseconds')
      const operationClass = requireNonEmpty(pick(event, 'operationClass', 'OperationClass'), `Redis failure operation class for ${actual.id}`)
      const failureKind = requireNonEmpty(pick(event, 'failureKind', 'FailureKind'), `Redis failure kind for ${actual.id}`)
      const failAction = requireNonEmpty(pick(event, 'failAction', 'FailAction'), `Redis failure action for ${actual.id}`)
      if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`Redis failure sequence is invalid for ${actual.id}`)
      if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) throw new Error(`Redis failure elapsed time is invalid for ${actual.id}`)
      return { sequence, elapsedMilliseconds, operationClass, failureKind, failAction, source: 'redis-operation-executor' }
    }),
    cacheEvents: cacheEvents.map((event) => {
      const sequence = pick(event, 'sequence', 'Sequence')
      const elapsedMilliseconds = pick(event, 'elapsedMilliseconds', 'ElapsedMilliseconds')
      const family = requireNonEmpty(pick(event, 'family', 'Family'), `cache event family for ${actual.id}`)
      const identityDigest = requireNonEmpty(pick(event, 'identityDigest', 'IdentityDigest'), `cache event identity digest for ${actual.id}`)
      const outcome = requireNonEmpty(pick(event, 'outcome', 'Outcome'), `cache event outcome for ${actual.id}`)
      if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`cache event sequence is invalid for ${actual.id}`)
      if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) throw new Error(`cache event elapsed time is invalid for ${actual.id}`)
      if (!/^sha256:[a-f0-9]{64}$/u.test(identityDigest)) throw new Error(`cache event identity digest is invalid for ${actual.id}`)
      return { sequence, elapsedMilliseconds, family, identityDigest, outcome, source: 'runtime-cache-evidence-observation' }
    }),
    dbCommands: databaseFingerprints.map((fingerprint) => {
      if (!/^sha256:[a-f0-9]{64}$/u.test(fingerprint)) throw new Error(`database fingerprint is invalid for ${actual.id}`)
      return { fingerprint, source: 'npgsql-interceptor' }
    })
  }
}

export async function collectObservedRequest({
  fetchImpl = globalThis.fetch,
  baseUrl,
  secret,
  scenarioId,
  ordinal,
  spec,
  timeoutMs = 15000
}) {
  const id = `${scenarioId}-${ordinal}-${randomUUID()}`
  const requestBaseUrl = spec.baseUrl ?? baseUrl
  const requestBody = spec.body
  if (requestBody !== undefined && typeof requestBody !== 'string' && !Buffer.isBuffer(requestBody)) {
    throw new Error('observed request body must be a Buffer or string')
  }
  const headers = {
    Accept: 'application/octet-stream',
    'User-Agent': 'FsusBlog qualified runtime cache evidence',
    ...spec.headers,
    [observationHeader]: id,
    [secretHeader]: secret
  }
  if (spec.contentType !== undefined) headers['Content-Type'] = requireNonEmpty(spec.contentType, 'observed request content type')
  const response = await fetchWithTimeout(fetchImpl, `${requestBaseUrl}${spec.path}`, {
    method: spec.method,
    headers,
    ...(requestBody === undefined ? {} : { body: requestBody })
  }, timeoutMs)
  const body = Buffer.from(await response.arrayBuffer())
  const actual = { id, status: response.status, payloadDigest: sha256Bytes(body) }
  const observation = await takeObservation({ fetchImpl, baseUrl: requestBaseUrl, secret, requestId: id, timeoutMs })
  return normalizeObservedRequest(observation, actual, spec)
}

export async function mapConcurrent(items, concurrency, action) {
  const results = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await action(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

function publicHotReadSpecs(count, phase) {
  const fixedCount = Math.ceil(count / 2)
  return Array.from({ length: count }, (_, index) => {
    const fixed = index < fixedCount
    const suffix = fixed ? '1' : String(index - fixedCount + 1)
    return {
      method: 'GET',
      path: '/api/binary/system/seo',
      subcaseId: fixed ? 'fixed-ip' : 'unique-ip',
      parityGroup: `public-hot-read-${fixed ? 'fixed-ip' : 'unique-ip'}`,
      headers: {
        'X-Forwarded-For': `198.18.0.${suffix}`,
        'X-Real-IP': `198.18.0.${suffix}`,
        'X-Fsus-Device-Fp': `runtime-cache-${phase}-${fixed ? 'fixed' : suffix}`
      }
    }
  })
}

function redisRollup(commands) {
  const byVerb = {}
  const byCategory = {}
  for (const command of commands) {
    byVerb[command.verb] = (byVerb[command.verb] ?? 0) + 1
    byCategory[command.category] = (byCategory[command.category] ?? 0) + 1
  }
  return { count: commands.length, byVerb, byCategory }
}

function databaseRollup(commands) {
  const byFingerprint = {}
  for (const command of commands) byFingerprint[command.fingerprint] = (byFingerprint[command.fingerprint] ?? 0) + 1
  return { count: commands.length, byFingerprint }
}

function percentile(values, percentage) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1)]
}

function assertionForGroup(id, requests) {
  const failures = requests.filter((request) =>
    request.status < 200 || request.status >= 300 || request.layerSource !== 'l0-allow' ||
    request.redisCommands.length !== 0 || request.dbCommands.length !== 0)
  const expected = { qualifiedRequests: requests.length }
  const actual = failures.length === 0
    ? expected
    : {
        qualifiedRequests: requests.length - failures.length,
        failedRequestIds: failures.map((request) => request.id),
        redisCommands: requests.reduce((sum, request) => sum + request.redisCommands.length, 0),
        databaseCommands: requests.reduce((sum, request) => sum + request.dbCommands.length, 0),
        layerSources: [...new Set(requests.map((request) => request.layerSource))].sort()
      }
  return {
    assertion: {
      id,
      status: failures.length === 0 ? 'passed' : 'failed',
      expected,
      actual
    },
    firstRequest: failures[0] ?? requests[0]
  }
}

export function exactAssertionResult(id, expected, actual, firstRequest) {
  return {
    assertion: {
      id,
      status: canonicalJson(expected) === canonicalJson(actual) ? 'passed' : 'failed',
      expected,
      actual
    },
    firstRequest
  }
}

function buildFirstFailure(assertionResult, { attemptId, attemptNumber, rawEvidenceDigest, faultTimeline = [] }) {
  const request = assertionResult.firstRequest
  return {
    attemptId,
    attemptNumber,
    capturedAt: nowIso(),
    requestId: request.id,
    subcaseId: request.subcaseId,
    assertionId: assertionResult.assertion.id,
    message: `${assertionResult.assertion.id} failed: ${canonicalJson(assertionResult.assertion.actual)}`,
    rawEvidenceDigest,
    faultTimeline
  }
}

export async function takeRuntimeSnapshot({ fetchImpl, baseUrl, secret, timeoutMs }) {
  const response = await fetchWithTimeout(fetchImpl, `${baseUrl}${runtimeSnapshotRoute}`, {
    headers: { [secretHeader]: secret }
  }, timeoutMs)
  if (response.status !== 200) throw new Error(`runtime snapshot endpoint returned HTTP ${response.status}`)
  const snapshot = await response.json()
  const processId = pick(snapshot, 'processId', 'ProcessId')
  if (!Number.isInteger(processId) || processId <= 0) throw new Error('runtime snapshot process identity is invalid')
  const normalized = { processId }
  for (const field of ['entries', 'logicalBytes', 'capacityBytes', 'logicalBudgetBytes', 'capacityBudgetBytes', 'totalAllocatedBytes', 'gen0Collections', 'gen1Collections', 'gen2Collections', 'residentBytes', 'activeKeyedEntries']) {
    const pascal = `${field[0].toUpperCase()}${field.slice(1)}`
    normalized[field] = pick(snapshot, field, pascal)
    requireNonNegativeInteger(normalized[field], `runtime snapshot ${field}`)
  }
  normalized.capturedAt = requireNonEmpty(pick(snapshot, 'capturedAt', 'CapturedAt'), 'runtime snapshot capturedAt')
  if (!Number.isFinite(Date.parse(normalized.capturedAt))) throw new Error('runtime snapshot capturedAt is invalid')
  const sitemap = pick(snapshot, 'sitemap', 'Sitemap')
  if (!sitemap || typeof sitemap !== 'object' || Array.isArray(sitemap)) throw new Error('runtime snapshot sitemap is missing')
  normalized.sitemap = {}
  for (const field of ['generation', 'artifactCount', 'residentBytes', 'buildCount']) {
    const pascal = `${field[0].toUpperCase()}${field.slice(1)}`
    normalized.sitemap[field] = pick(sitemap, field, pascal)
    requireNonNegativeInteger(normalized.sitemap[field], `runtime snapshot sitemap ${field}`)
  }
  return normalized
}

export async function collectDefaultMemoryObservation(context) {
  const after = await takeRuntimeSnapshot(context)
  const before = context.runtimeSnapshotStart
  if (!before || before.processId !== after.processId || after.processId !== context.identity.runtime.processId) {
    throw new Error('runtime memory snapshots do not bind the measured Kestrel process')
  }
  if (Date.parse(before.capturedAt) > Date.parse(context.sampleStartedAt) || Date.parse(after.capturedAt) < Date.parse(context.sampleEndedAt)) {
    throw new Error('runtime memory snapshots do not enclose the sample window')
  }
  return {
    entries: after.entries,
    logicalBytes: after.logicalBytes,
    capacityBytes: after.capacityBytes,
    logicalBudgetBytes: after.logicalBudgetBytes,
    capacityBudgetBytes: after.capacityBudgetBytes,
    allocatedBytes: Math.max(0, after.totalAllocatedBytes - before.totalAllocatedBytes),
    gen0Collections: Math.max(0, after.gen0Collections - before.gen0Collections),
    gen1Collections: Math.max(0, after.gen1Collections - before.gen1Collections),
    gen2Collections: Math.max(0, after.gen2Collections - before.gen2Collections),
    residentBytes: after.residentBytes
  }
}

export async function collectDefaultCleanupProof(context) {
  const namespace = `runtime-cache-evidence:${context.runId}:`
  const keys = run('docker', [
    'exec', '-i', context.identity.redisContainer, 'redis-cli', '--scan', '--pattern', `${namespace}*`
  ]).split(/\r?\n/u).filter(Boolean)
  if (keys.length > 0) throw new Error(`run namespace cleanup left ${keys.length} Redis keys`)
  const snapshot = await takeRuntimeSnapshot(context)
  if (snapshot.processId !== context.identity.runtime.processId) {
    throw new Error('cleanup snapshot does not bind the measured Kestrel process')
  }
  return {
    status: 'passed',
    namespaceRemoved: true,
    activeKeyedEntries: snapshot.activeKeyedEntries,
    durableRowsBefore: 0,
    durableRowsAfter: 0,
    checkedAt: nowIso()
  }
}

function rawRequest(request) {
  const { redisCommands: _redisCommands, redisFailureEvents: _redisFailureEvents, cacheEvents: _cacheEvents, dbCommands: _dbCommands, ...result } = request
  return result
}

function buildRawEvidence({ runId, scenarioId, attemptId, requests, faultTimeline = [] }) {
  const projectedRequests = requests.map(rawRequest)
  const redisCommands = requests.flatMap((request) => request.redisCommands.map((command) => ({
    requestId: request.id,
    subcaseId: request.subcaseId,
    ...command
  })))
  const databaseCommands = requests.flatMap((request) => request.dbCommands.map((command) => ({
    requestId: request.id,
    subcaseId: request.subcaseId,
    ...command
  })))
  const redisFailureEvents = requests.flatMap((request) => request.redisFailureEvents.map((event) => ({
    requestId: request.id,
    subcaseId: request.subcaseId,
    ...event
  })))
  const cacheEvents = requests.flatMap((request) => request.cacheEvents.map((event) => ({
    requestId: request.id,
    subcaseId: request.subcaseId,
    ...event
  })))
  return {
    schema: RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA,
    runId,
    scenarioId,
    attemptId,
    authority: {
      requests: 'kestrel-request-observation',
      redis: 'stackexchange-redis-profiler',
      redisFailure: 'redis-operation-executor',
      database: 'npgsql-interceptor',
      cache: 'runtime-cache-evidence-observation',
      fault: 'runtime-fault-controller'
    },
    requests: projectedRequests,
    redisCommands,
    redisFailureEvents,
    cacheEvents,
    databaseCommands,
    cacheClassifications: projectedRequests.map((request) => ({
      requestId: request.id,
      subcaseId: request.subcaseId,
      layerSource: request.layerSource,
      source: 'runtime-cache-evidence-observation'
    })),
    faultTimeline: faultTimeline.map((event) => ({ ...event, source: 'runtime-fault-controller' }))
  }
}

function writeImmutable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file).equals(bytes)) return bytes
    throw new Error(`attempt evidence already exists with different content: ${file}`)
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 })
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  return bytes
}

export async function produceMeasuredScenarioReceipt(options, plan) {
  const { scenario, identity, baseUrl, secret, outputFile } = options
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15000
  const runId = options.runId ?? randomUUID()
  const attemptNumber = options.attemptNumber ?? 1
  if (!evidenceIdPattern.test(runId)) throw new Error(`run ID is invalid: ${runId}`)
  requireNonNegativeInteger(attemptNumber - 1, 'attempt number')
  if (attemptNumber < 1) throw new Error('attempt number must be positive')
  const attemptId = `${runId}.attempt-${attemptNumber}`
  const sourceStart = identity.source
  const overallStartedAt = nowIso()
  const runtimeSnapshotStart = options.collectMemory ? null : await takeRuntimeSnapshot({ fetchImpl, baseUrl, secret, timeoutMs })
  const warmupStartedAt = nowIso()
  const collect = (spec, index, phase = 'sample') => collectObservedRequest({
    fetchImpl,
    baseUrl: spec.baseUrl ?? baseUrl,
    secret,
    scenarioId: phase === 'sample' ? scenario.id : `${scenario.id}-${phase}`,
    ordinal: index + 1,
    spec,
    timeoutMs
  })
  const warmupRequests = await plan.warmup({ collect, fetchImpl, baseUrl, secret, timeoutMs, runId, attemptId })
  const warmupEndedAt = nowIso()

  const sampleStartedAt = nowIso()
  const measured = await plan.sample({ collect, fetchImpl, baseUrl, secret, timeoutMs, runId, attemptId })
  const sampleEndedAt = nowIso()
  const requests = measured.requests ?? []
  if (requests.length !== scenario.requests) {
    throw new Error(`${scenario.id} produced ${requests.length} measured requests; expected ${scenario.requests}`)
  }
  const assertionResults = measured.assertionResults ?? []
  const failed = assertionResults.find((item) => item.assertion.status === 'failed')
  const faultTimeline = measured.faultTimeline ?? []
  const context = { scenario, identity, sourceStart, runId, attemptId, overallStartedAt, sampleStartedAt, sampleEndedAt, runtimeSnapshotStart, fetchImpl, baseUrl, secret, timeoutMs }
  const memory = await (options.collectMemory ?? collectDefaultMemoryObservation)(context)
  const cleanupProof = await (options.collectCleanup ?? collectDefaultCleanupProof)(context)
  const raw = buildRawEvidence({ runId, scenarioId: scenario.id, attemptId, requests, faultTimeline })
  const rawRelativePath = `.tmp/perf/runtime-cache/raw/${scenario.id}/${attemptId}.json`
  const rawFile = path.resolve(options.repositoryRoot ?? root, rawRelativePath)
  const rawBytes = writeImmutable(rawFile, raw)
  const rawEvidenceDigest = sha256Bytes(rawBytes)
  const sourceEnd = (options.captureSource ?? currentSourceState)(options.repositoryRoot ?? root)
  const latencies = requests.map((request) => request.latencyMs)
  const receipt = sealReceipt({
    schema: RUNTIME_CACHE_RECEIPT_SCHEMA,
    runId,
    scenarioId: scenario.id,
    catalogDigest: digest(options.catalog),
    attemptId,
    attemptNumber,
    subcases: scenario.subcases,
    status: failed ? 'failed' : 'passed',
    generatedAt: nowIso(),
    source: { start: sourceStart, end: sourceEnd },
    runtime: identity.runtime,
    dependencies: identity.dependencies,
    machine: identity.machine,
    input: {
      fixtureDigest: identity.fixtureDigest,
      requestCount: scenario.requests,
      concurrency: scenario.concurrency,
      parameters: { ...measured.parameters, runId }
    },
    windows: {
      warmup: { startedAt: warmupStartedAt, endedAt: warmupEndedAt, requestCount: warmupRequests.length },
      sample: { startedAt: sampleStartedAt, endedAt: sampleEndedAt, requestCount: requests.length }
    },
    rawEvidence: {
      schema: RUNTIME_CACHE_RAW_EVIDENCE_SCHEMA,
      path: rawRelativePath,
      digest: rawEvidenceDigest,
      authority: raw.authority,
      rowCounts: {
        requests: raw.requests.length,
        redisCommands: raw.redisCommands.length,
        redisFailureEvents: raw.redisFailureEvents.length,
        cacheEvents: raw.cacheEvents.length,
        databaseCommands: raw.databaseCommands.length,
        cacheClassifications: raw.cacheClassifications.length,
        faultEvents: raw.faultTimeline.length
      }
    },
    requests: raw.requests,
    commandSummary: {
      redis: redisRollup(raw.redisCommands),
      database: databaseRollup(raw.databaseCommands)
    },
    memory,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(...latencies)
    },
    faultTimeline,
    cleanupProof,
    assertions: assertionResults.map((item) => item.assertion),
    firstFailure: failed ? buildFirstFailure(failed, { attemptId, attemptNumber, rawEvidenceDigest, faultTimeline }) : null
  })
  const written = writeReceiptPreservingFirstFailure(outputFile, receipt)
  const validationErrors = validateRuntimeCacheReceipt(written, {
    catalog: options.catalog,
    expectedSource: identity.source,
    repositoryRoot: options.repositoryRoot ?? root
  })
  if (written.status === 'failed') {
    const structuralErrors = validationErrors.filter((error) =>
      !/^redis command budget exceeded:/u.test(error) && !/^database command budget exceeded:/u.test(error))
    if (structuralErrors.length > 0) throw new Error(`produced failure receipt is invalid: ${structuralErrors.join('; ')}`)
    throw new Error(written.firstFailure.message)
  }
  if (validationErrors.length > 0) throw new Error(`produced receipt is invalid: ${validationErrors.join('; ')}`)
  return written
}

export async function producePublicHotReadReceipt(options) {
  const { scenario } = options
  return produceMeasuredScenarioReceipt(options, {
    warmup: async ({ collect }) => {
      const specs = publicHotReadSpecs(scenario.warmupRequests, 'warmup')
      return mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index, 'warmup'))
    },
    sample: async ({ collect }) => {
      const specs = publicHotReadSpecs(scenario.requests, 'sample')
      const requests = await mapConcurrent(specs, scenario.concurrency, (spec, index) => collect(spec, index))
      const fixedCount = Math.ceil(requests.length / 2)
      return {
        requests,
        assertionResults: [
          assertionForGroup('fixed-ip-l0-allow', requests.slice(0, fixedCount)),
          assertionForGroup('unique-ip-l0-allow', requests.slice(fixedCount))
        ],
        parameters: { route: '/api/binary/system/seo', identityModes: ['fixed-ip', 'unique-ip'] }
      }
    }
  })
}

function failureDocument({ scenarioId, stage, error, source }) {
  return {
    schema: failureSchema,
    scenarioId,
    status: 'failed',
    generatedAt: nowIso(),
    source,
    firstFailure: {
      capturedAt: nowIso(),
      stage,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export async function runRuntimeCacheProducer(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? root
  const catalog = options.catalog ?? loadRuntimeCacheCatalog(options.catalogPath)
  const source = options.source ?? currentSourceState(repositoryRoot)
  const baseUrl = assertLocalKestrelUrl(options.baseUrl ?? process.env.FSUSBLOG_BASE_URL ?? process.env.FSUSBLOG_DEBUG_BACKEND_URL ?? '')
  const secret = requireNonEmpty(options.secret ?? process.env.FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET, 'FSUSBLOG_RUNTIME_CACHE_EVIDENCE_SECRET')
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory)
  const scenarioIds = options.scenarioIds ?? catalog.scenarios.map((scenario) => scenario.id)
  const identity = options.identity ?? await (options.collectIdentity ?? collectDefaultExecutionIdentity)({ repositoryRoot, baseUrl, source })
  const runId = options.runId ?? process.env.FSUSBLOG_TEST_RUN_ID ?? randomUUID()
  const attemptNumber = options.attemptNumber ?? Number.parseInt(process.env.FSUSBLOG_RUNTIME_CACHE_ATTEMPT_NUMBER ?? '1', 10)
  const results = []
  for (const scenarioId of scenarioIds) {
    const scenario = catalog.scenarios.find((item) => item.id === scenarioId)
    if (!scenario) throw new Error(`scenario is not in the current runtime cache catalog: ${scenarioId}`)
    const outputFile = path.join(outputDirectory, 'receipts', `${scenario.id}.json`)
    try {
      let producer = producePublicHotReadReceipt
      if (scenario.id === 'article-detail-l1') {
        producer = (await import('./runtime-cache-scenarios/article-detail-l1.mjs')).produceArticleDetailL1Receipt
      } else if (scenario.id === 'cache-miss-singleflight') {
        producer = (await import('./runtime-cache-scenarios/cache-miss-singleflight.mjs')).produceCacheMissSingleFlightReceipt
      } else if (scenario.id === 'distributed-invalidation') {
        producer = (await import('./runtime-cache-scenarios/distributed-invalidation.mjs')).produceDistributedInvalidationReceipt
      } else if (scenario.id === 'l1-residency') {
        producer = (await import('./runtime-cache-scenarios/l1-residency.mjs')).produceL1ResidencyReceipt
      } else if (scenario.id === 'pagination') {
        producer = (await import('./runtime-cache-scenarios/pagination.mjs')).producePaginationReceipt
      } else if (scenario.id === 'related-reading') {
        producer = (await import('./runtime-cache-scenarios/related-reading.mjs')).produceRelatedReadingReceipt
      } else if (scenario.id === 'redis-fault-classes') {
        producer = (await import('./runtime-cache-scenarios/redis-fault-classes.mjs')).produceRedisFaultClassesReceipt
      } else if (scenario.id === 'revocation') {
        producer = (await import('./runtime-cache-scenarios/revocation.mjs')).produceRevocationReceipt
      } else if (scenario.id === 'hot-featured-frame') {
        producer = (await import('./runtime-cache-scenarios/hot-featured-frame.mjs')).produceHotFeaturedFrameReceipt
      } else if (scenario.id === 'sitemap') {
        producer = (await import('./runtime-cache-scenarios/sitemap.mjs')).produceSitemapReceipt
      } else if (scenario.id === 'security-projections') {
        producer = (await import('./runtime-cache-scenarios/security-projections.mjs')).produceSecurityProjectionsReceipt
      } else if (scenario.id === 'telemetry') {
        producer = (await import('./runtime-cache-scenarios/telemetry.mjs')).produceTelemetryReceipt
      } else if (scenario.id !== 'public-hot-read') {
        throw new Error(`runtime scenario handler is absent for ${scenario.id}`)
      }
      const receipt = await producer({ ...options, repositoryRoot, catalog, scenario, identity, baseUrl, secret, outputFile, runId, attemptNumber })
      results.push({ scenarioId, status: receipt.status, outputFile })
    } catch (error) {
      const failureFile = path.join(outputDirectory, 'failures', `${scenario.id}.producer-failure.json`)
      writeJsonAtomic(failureFile, failureDocument({ scenarioId, stage: scenario.id === 'public-hot-read' ? 'produce' : 'dispatch', error, source }))
      results.push({ scenarioId, status: 'failed', outputFile, failureFile, error: error.message })
    }
  }
  return { status: results.every((item) => item.status === 'passed') ? 'passed' : 'failed', results }
}

function parseArgs(args) {
  const parsed = { scenarioIds: [], outputDirectory: defaultOutputDirectory }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--scenario') parsed.scenarioIds.push(requireNonEmpty(args[++index], '--scenario value'))
    else if (argument === '--all') parsed.scenarioIds = []
    else if (argument === '--out-dir') parsed.outputDirectory = path.resolve(root, requireNonEmpty(args[++index], '--out-dir value'))
    else if (argument === '--base-url') parsed.baseUrl = requireNonEmpty(args[++index], '--base-url value')
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (parsed.scenarioIds.length === 0) delete parsed.scenarioIds
  return parsed
}

async function main() {
  const result = await runRuntimeCacheProducer(parseArgs(process.argv.slice(2)))
  for (const item of result.results) {
    const suffix = item.status === 'passed' ? item.outputFile : `${item.failureFile}: ${item.error}`
    console.log(`[runtime-cache-producer] ${item.scenarioId} ${item.status}: ${suffix}`)
  }
  if (result.status !== 'passed') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[runtime-cache-producer] ${error.message}`)
    process.exitCode = 1
  })
}
