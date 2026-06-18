#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const requiredRedisFaultCases = ['redis-restart', 'redis-reconnect', 'redis-latency']
const requiredPostgresFaultCases = ['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout']
const requiredNotificationFaultCases = ['notification-stream-slow-consumer']
const requiredGracefulShutdownFaultCases = ['graceful-shutdown']

function readJson(relativePath, optional = false) {
  const file = findEvidenceFile(relativePath)
  if (!file) {
    if (optional) return null
    throw new Error(`missing ${relativePath}`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function findEvidenceFile(relativePath) {
  const direct = path.join(root, relativePath)
  if (fs.existsSync(direct)) return direct

  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  if (!fs.existsSync(downloadedRoot)) return null
  const suffix = relativePath.replace(/^\.\//, '')
  const stack = [downloadedRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(next)
      } else if (next.endsWith(suffix)) {
        return next
      }
    }
  }
  return null
}

function findEvidenceFilesBySuffix(suffix) {
  const files = []
  const roots = [path.join(root, '.tmp')]
  const downloadedRoot = path.join(root, '.tmp/downloaded-artifacts')
  if (fs.existsSync(downloadedRoot)) roots.push(downloadedRoot)
  for (const start of roots) {
    if (!fs.existsSync(start)) continue
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const next = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(next)
        } else if (next.endsWith(suffix)) {
          files.push(next)
        }
      }
    }
  }
  return [...new Set(files)]
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function positiveNumber(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value) && value > 0, `${label} must be > 0`)
}

function nonNegativeNumber(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label} must be >= 0`)
}

function validateRuntimeProbe(probe, label) {
  assert(probe && typeof probe === 'object', `${label}.runtime missing`)
  assert(probe.measurementSource === 'runtime-http-probe', `${label}.runtime.measurementSource must be runtime-http-probe`)
  positiveNumber(probe.sampleCount, `${label}.runtime.sampleCount`)
  positiveNumber(probe.rps, `${label}.runtime.rps`)
  positiveNumber(probe.bytes, `${label}.runtime.bytes`)
  positiveNumber(probe.latencyMs?.p50, `${label}.runtime.latencyMs.p50`)
  positiveNumber(probe.latencyMs?.p95, `${label}.runtime.latencyMs.p95`)
  assert(Object.keys(probe.statusCounts ?? {}).some((status) => status.startsWith('2') || status.startsWith('3')), `${label}.runtime.statusCounts must include 2xx/3xx`)
}

function validateBackendQps() {
  const summary = readJson('.tmp/release-evidence/backend-qps-summary.json')
  assert(summary.status === 'ok', 'backend-qps-summary.status must be ok')
  assert(Array.isArray(summary.results) && summary.results.length > 0, 'backend-qps-summary.results must be non-empty')
  for (const result of summary.results) {
    const label = `backend-qps:${result.scenario ?? 'unknown'}`
    assert(result.evidenceType === 'runtime-http-probe', `${label}.evidenceType must be runtime-http-probe`)
    positiveNumber(result.rps, `${label}.rps`)
    positiveNumber(result.p50Ms, `${label}.p50Ms`)
    positiveNumber(result.p95Ms, `${label}.p95Ms`)
    validateRuntimeProbe(result.runtime, label)
  }
}

function validateDataScale() {
  const summary = readJson('.tmp/release-evidence/data-scale-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'data-scale-summary.status must be ok')
  validateRuntimeProbe(summary.observed?.runtime, 'data-scale')
  positiveNumber(summary.observed?.latencyMs?.p95, 'data-scale.latencyMs.p95')
}

function validateLoadProfiles() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}perf${path.sep}load-`))
  for (const file of summaries) {
    const relative = path.relative(root, file)
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert(summary.status === 'ok', `${relative}.status must be ok`)
    positiveNumber(summary.metrics?.rps, `${relative}.metrics.rps`)
    positiveNumber(summary.metrics?.p95Ms, `${relative}.metrics.p95Ms`)
    validateRuntimeProbe(summary.runtime, relative)
  }
}

function validateFaultInjection() {
  const summary = readJson('.tmp/fault-injection/summary.json', true)
  if (!summary) return
  validateFaultInjectionSummary(summary, 'fault-injection')
}

function validateFaultInjectionSummary(summary, label) {
  assert(summary.status === 'ok', 'fault-injection.summary.status must be ok')
  positiveNumber(summary.caseCount, 'fault-injection.caseCount')
  assert(Array.isArray(summary.cases) && summary.cases.length === summary.caseCount, 'fault-injection.cases must match caseCount')
  const caseNames = new Set(summary.cases.map((item) => item.case))
  for (const required of requiredRedisFaultCases) {
    assert(caseNames.has(required), `${label} must include ${required}`)
  }
  for (const required of requiredPostgresFaultCases) {
    assert(caseNames.has(required), `${label} must include ${required}`)
  }
  for (const required of requiredNotificationFaultCases) {
    assert(caseNames.has(required), `${label} must include ${required}`)
  }
  for (const required of requiredGracefulShutdownFaultCases) {
    assert(caseNames.has(required), `${label} must include ${required}`)
  }
  for (const item of summary.cases) {
    assert(item.status === 'completed', `${label} ${item.case} must be completed`)
    assert(item.actionStatus === 'executed', `${label} ${item.case}.actionStatus must be executed`)
    assert(!['observed-only', 'scheduled'].includes(String(item.status)), `${label} ${item.case} must not be ${item.status}`)
    assert(!['observed-only', 'scheduled'].includes(String(item.actionStatus)), `${label} ${item.case}.actionStatus must not be ${item.actionStatus}`)
    positiveNumber(item.recoveryTimeMs, `fault-injection ${item.case}.recoveryTimeMs`)
    if (requiredRedisFaultCases.includes(item.case)) {
      validateRedisFaultCase(item, label)
    }
    if (requiredPostgresFaultCases.includes(item.case)) {
      validatePostgresFaultCase(item, label)
    }
    if (requiredNotificationFaultCases.includes(item.case)) {
      validateNotificationFaultCase(item, label)
    }
    if (requiredGracefulShutdownFaultCases.includes(item.case)) {
      validateGracefulShutdownFaultCase(item, label)
    }
  }
}

function validateRedisFaultCase(item, label) {
  assert(typeof item.actionStartedAt === 'string' && item.actionStartedAt.length > 0, `${label} ${item.case}.actionStartedAt missing`)
  assert(typeof item.actionCompletedAt === 'string' && item.actionCompletedAt.length > 0, `${label} ${item.case}.actionCompletedAt missing`)
  nonNegativeNumber(item.unavailableDurationMs, `${label} ${item.case}.unavailableDurationMs`)
  positiveNumber(item.recoveryDurationMs ?? item.recoveryTimeMs, `${label} ${item.case}.recoveryDurationMs`)
  assert(item.publicReadResult?.status === 'completed', `${label} ${item.case}.publicReadResult must be completed`)
  positiveNumber(item.publicReadResult?.sampleCount, `${label} ${item.case}.publicReadResult.sampleCount`)
  assert(item.finalHealthStatus === 'healthy', `${label} ${item.case}.finalHealthStatus must be healthy`)
  assert(item.authenticatedImpact && typeof item.authenticatedImpact.status === 'string', `${label} ${item.case}.authenticatedImpact missing`)
  assert(item.notificationStreamImpact && typeof item.notificationStreamImpact.status === 'string', `${label} ${item.case}.notificationStreamImpact missing`)
}

function validatePostgresFaultCase(item, label) {
  assert(typeof item.actionStartedAt === 'string' && item.actionStartedAt.length > 0, `${label} ${item.case}.actionStartedAt missing`)
  assert(typeof item.actionCompletedAt === 'string' && item.actionCompletedAt.length > 0, `${label} ${item.case}.actionCompletedAt missing`)
  assert(typeof item.affectedEndpoint === 'string' && item.affectedEndpoint.length > 0, `${label} ${item.case}.affectedEndpoint missing`)
  nonNegativeNumber(item.unavailableDurationMs, `${label} ${item.case}.unavailableDurationMs`)
  positiveNumber(item.dbReconnectDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs, `${label} ${item.case}.dbReconnectDurationMs`)
  assert(item.publicReadRecoveryResult?.status === 'completed', `${label} ${item.case}.publicReadRecoveryResult must be completed`)
  positiveNumber(item.publicReadRecoveryResult?.sampleCount, `${label} ${item.case}.publicReadRecoveryResult.sampleCount`)
  assert(item.writePathRollbackResult && typeof item.writePathRollbackResult.status === 'string', `${label} ${item.case}.writePathRollbackResult missing`)
  assert(!['failed', 'scheduled', 'observed-only'].includes(item.writePathRollbackResult.status), `${label} ${item.case}.writePathRollbackResult must not be ${item.writePathRollbackResult.status}`)
  assert(item.finalHealthStatus === 'healthy', `${label} ${item.case}.finalHealthStatus must be healthy`)
}

function validateNotificationFaultCase(item, label) {
  positiveNumber(item.connectionCount, `${label} ${item.case}.connectionCount`)
  positiveNumber(item.heartbeatFrameCount, `${label} ${item.case}.heartbeatFrameCount`)
  positiveNumber(item.businessFrameCount, `${label} ${item.case}.businessFrameCount`)
  positiveNumber(item.deliveredFrameCount, `${label} ${item.case}.deliveredFrameCount`)
  positiveNumber(item.droppedOrBackpressuredCount, `${label} ${item.case}.droppedOrBackpressuredCount`)
  assert(item.reconnectSuccess === true, `${label} ${item.case}.reconnectSuccess must be true`)
  positiveNumber(item.replayedEventCount, `${label} ${item.case}.replayedEventCount`)
  assert(item.closeObserved === true, `${label} ${item.case}.closeObserved must be true`)
  assert(Array.isArray(item.eventIds) && item.eventIds.length > 0, `${label} ${item.case}.eventIds missing`)
  assert(item.eventIds.every((eventId) => Number(eventId) > 0), `${label} ${item.case}.eventIds must be positive`)
  assert(typeof item.routeKey === 'string' && item.routeKey.length > 0, `${label} ${item.case}.routeKey missing`)
  assert(typeof item.slowConsumerPolicy === 'string' && item.slowConsumerPolicy.length > 0, `${label} ${item.case}.slowConsumerPolicy missing`)
  assert(item.finalHealthStatus === 'healthy', `${label} ${item.case}.finalHealthStatus must be healthy`)
}

function validateGracefulShutdownFaultCase(item, label) {
  assert(typeof item.shutdownRequestedAt === 'string' && item.shutdownRequestedAt.length > 0, `${label} ${item.case}.shutdownRequestedAt missing`)
  assert(item.processStopResult?.status === 'stopped', `${label} ${item.case}.processStopResult.status must be stopped`)
  positiveNumber(item.drainDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs, `${label} ${item.case}.drainDurationMs`)
  positiveNumber(item.restartRecoveryDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs, `${label} ${item.case}.restartRecoveryDurationMs`)
  assert(item.livenessBefore?.status === 'completed', `${label} ${item.case}.livenessBefore must be completed`)
  assert(item.livenessDuringShutdown?.status === 'unavailable', `${label} ${item.case}.livenessDuringShutdown must be unavailable`)
  assert(item.notificationCloseObserved === true, `${label} ${item.case}.notificationCloseObserved must be true`)
  assert(Number.isFinite(Number(item.notificationCloseCode)), `${label} ${item.case}.notificationCloseCode missing`)
  assert(item.notificationReconnectSuccess === true, `${label} ${item.case}.notificationReconnectSuccess must be true`)
  assert(item.publicReadRecoveryResult?.status === 'completed', `${label} ${item.case}.publicReadRecoveryResult must be completed`)
  positiveNumber(item.publicReadRecoveryResult?.sampleCount, `${label} ${item.case}.publicReadRecoveryResult.sampleCount`)
  assert(item.basicAuthRecoveryResult?.status === 'completed', `${label} ${item.case}.basicAuthRecoveryResult must be completed`)
  positiveNumber(item.basicAuthRecoveryResult?.sampleCount, `${label} ${item.case}.basicAuthRecoveryResult.sampleCount`)
  assert(item.backgroundWorkerState?.status === 'clean', `${label} ${item.case}.backgroundWorkerState.status must be clean`)
  assert(item.finalHealthStatus === 'healthy', `${label} ${item.case}.finalHealthStatus must be healthy`)
}

function validateSoak() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}soak${path.sep}`))
  for (const file of summaries) {
    const mode = path.basename(path.dirname(file))
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (summary.status === 'scheduled') {
      assert(mode !== 'short', 'short soak must be a runtime probe, not scheduled')
      continue
    }
    assert(summary.status === 'ok', `soak ${mode}.status must be ok`)
    positiveNumber(summary.durationSeconds, `soak ${mode}.durationSeconds`)
    positiveNumber(summary.sampleCount, `soak ${mode}.sampleCount`)
    positiveNumber(summary.latencyMs?.p95, `soak ${mode}.latencyMs.p95`)
  }
}

function validateCoverage() {
  const merged = readJson('.tmp/coverage/merged/Summary.json')
  const backend = readJson('.tmp/coverage/backend-merged/Summary.json')
  const frontend = readJson('.tmp/coverage/frontend/Summary.json')

  validateCoverageSummary(merged, 'coverage:merged')
  validateCoverageSummary(backend, 'coverage:backend')
  validateCoverageSummary(frontend, 'coverage:frontend')
  assert(merged.sources?.mergeMethod === 'covered-over-total-weighted', 'coverage:merged must use weighted totals')
  assert(backend.source === 'backend-cobertura', 'coverage:backend.source must be backend-cobertura')
  assert(frontend.source === 'frontend-vitest', 'coverage:frontend.source must be frontend-vitest')
}

function validateCoverageSummary(summary, label) {
  positiveNumber(summary.summary?.linecoverage, `${label}.summary.linecoverage`)
  positiveNumber(summary.totals?.lines?.total, `${label}.totals.lines.total`)
  assert(Number(summary.totals?.lines?.covered ?? -1) >= 0, `${label}.totals.lines.covered must be >= 0`)
  for (const sourcePath of summary.reportPaths ?? []) {
    assert(Boolean(findEvidenceFile(sourcePath)), `${label}.reportPaths missing source artifact ${sourcePath}`)
  }
  if (Array.isArray(summary.reportPaths)) {
    assert(summary.reportPaths.length > 0 || label === 'coverage:merged', `${label}.reportPaths must be non-empty`)
  }
  const syntheticAllHundred = summary.summary?.linecoverage === 100
    && summary.summary?.branchcoverage === 100
    && summary.summary?.methodcoverage === 100
    && !summary.totals
  assert(!syntheticAllHundred, `${label} looks like synthetic 100% coverage`)
}

function validateEndpointDepth() {
  const summary = readJson('.tmp/release-evidence/endpoint-depth-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'endpoint-depth-summary.status must be ok')
  positiveNumber(summary.runtimeCaseCount, 'endpoint-depth.runtimeCaseCount')
  assert(Array.isArray(summary.results) && summary.results.length === summary.runtimeCaseCount, 'endpoint-depth.results must match runtimeCaseCount')
  const scenarios = new Set(summary.scenarios ?? [])
  for (const required of ['wrong-method', 'wrong-accept', 'wrong-content-type']) {
    assert(scenarios.has(required), `endpoint-depth.scenarios must include ${required}`)
  }
  assert([...scenarios].some((item) => ['malformed-header', 'wrong-frame', 'truncated', 'oversized'].includes(item)), 'endpoint-depth must execute malformed protocol cases')
  assert([...scenarios].some((item) => ['missing-pow', 'tampered-pow', 'replayed-pow', 'expired-pow'].includes(item)), 'endpoint-depth must execute PoW negative cases')
  for (const result of summary.results) {
    assert(result.ok === true, `endpoint-depth ${result.id} must be ok`)
    positiveNumber(result.elapsedMs, `endpoint-depth ${result.id}.elapsedMs`)
  }
}

function validateAedsFrameCost() {
  const summary = readJson('.tmp/perf/aeds-frame-cost/summary.json', true)
    ?? readJson('.tmp/release-evidence/aeds-frame-cost-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'aeds-frame-cost.status must be ok')
  assert(summary.measurementSource === 'local-aeds-frame-cost-profiler', 'aeds-frame-cost.measurementSource must be local profiler')
  assert(Array.isArray(summary.results) && summary.results.length >= 10, 'aeds-frame-cost.results must cover required frame types')
  const scenarios = new Set(summary.results.map((item) => item.scenario))
  for (const required of ['EmptySuccess', 'ApiError', 'ArticleList10', 'ArticleList50', 'ArticleList100', 'ArticleDetailLarge', 'CommentCursor', 'ConversationDetail', 'UploadStatus', 'PublicAotBootstrap']) {
    assert(scenarios.has(required), `aeds-frame-cost.results missing ${required}`)
  }
  assert(summary.results.some((item) => item.serverCopyBytesBefore > item.serverCopyBytesAfter), 'aeds-frame-cost must prove copy bytes decreased')
  for (const result of summary.results) {
    const label = `aeds-frame-cost:${result.scenario}`
    positiveNumber(result.rawFrameBytes, `${label}.rawFrameBytes`)
    positiveNumber(result.serverEncodeMs, `${label}.serverEncodeMs`)
    positiveNumber(result.serverEncodeP95Ms, `${label}.serverEncodeP95Ms`)
    positiveNumber(result.serverCrcMs, `${label}.serverCrcMs`)
    assert(Number.isFinite(result.serverCopyBytesAfter) && result.serverCopyBytesAfter >= 0, `${label}.serverCopyBytesAfter must be >= 0`)
    assert(Number.isFinite(result.allocBytesPerRequestAfter) && result.allocBytesPerRequestAfter >= 0, `${label}.allocBytesPerRequestAfter must be >= 0`)
  }
}

function validateAedsCompressionProfile() {
  const summary = readJson('.tmp/perf/aeds-compression-profile/summary.json', true)
    ?? readJson('.tmp/release-evidence/aeds-compression-profile-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'aeds-compression-profile.status must be ok')
  assert(summary.measurementSource === 'local-aeds-compression-profiler', 'aeds-compression-profile.measurementSource must be local profiler')
  assert(Array.isArray(summary.results) && summary.results.length >= 8, 'aeds-compression-profile.results must be non-empty')
  const variants = new Set(summary.results.map((item) => item.variant))
  assert(variants.has('br') && variants.has('gzip'), 'aeds-compression-profile must include br and gzip')
  for (const result of summary.results) {
    const label = `aeds-compression-profile:${result.scenario}:${result.variant}`
    positiveNumber(result.rawFrameBytes, `${label}.rawFrameBytes`)
    positiveNumber(result.encodedFrameBytes, `${label}.encodedFrameBytes`)
    assert(result.encodedFrameBytes < result.rawFrameBytes, `${label}.encodedFrameBytes must be smaller than rawFrameBytes`)
    positiveNumber(result.bytesSaved, `${label}.bytesSaved`)
  }
}

function validateAedsDecodeBudget() {
  const summary = readJson('.tmp/frontend/aeds-decode-budget/summary.json', true)
    ?? readJson('.tmp/release-evidence/aeds-decode-budget-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'aeds-decode-budget.status must be ok')
  positiveNumber(summary.frameBytes, 'aeds-decode-budget.frameBytes')
  positiveNumber(summary.payloadBytes, 'aeds-decode-budget.payloadBytes')
  positiveNumber(summary.clientEnvelopeDecodeMs, 'aeds-decode-budget.clientEnvelopeDecodeMs')
  positiveNumber(summary.clientPayloadMapMs, 'aeds-decode-budget.clientPayloadMapMs')
  positiveNumber(summary.clientStructuredCloneMs, 'aeds-decode-budget.clientStructuredCloneMs')
  assert(summary.copyCount === 0, 'aeds-decode-budget.copyCount must be zero')
  assert(Number.isFinite(summary.allocBytesPerDecode) && summary.allocBytesPerDecode >= 0, 'aeds-decode-budget.allocBytesPerDecode must be >= 0')
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  validateBackendQps()
  validateDataScale()
  validateLoadProfiles()
  validateFaultInjection()
  validateSoak()
  validateCoverage()
  validateEndpointDepth()
  validateAedsFrameCost()
  validateAedsCompressionProfile()
  validateAedsDecodeBudget()
  console.log('[evidence-metrics] ok')
}

function runSelfTest() {
  let failedAsExpected = false
  try {
    validateFaultInjectionSummary({
      status: 'scheduled',
      caseCount: 1,
      cases: [{
        case: 'scheduled-fixture',
        status: 'scheduled',
        actionStatus: 'observed-only',
        recoveryTimeMs: null
      }]
    }, 'fault-injection-self-test')
  } catch {
    failedAsExpected = true
  }
  assert(failedAsExpected, 'self-test scheduled fault-injection fixture must fail')
  let missingNotificationFailedAsExpected = false
  try {
    validateFaultInjectionSummary({
      status: 'ok',
      caseCount: 6,
      cases: [
        ...requiredRedisFaultCases.map((caseName, index) => ({
          case: caseName,
          status: 'completed',
          actionStatus: 'executed',
          actionStartedAt: `2026-06-18T00:00:0${index}Z`,
          actionCompletedAt: `2026-06-18T00:00:1${index}Z`,
          unavailableDurationMs: index,
          recoveryDurationMs: 2 + index,
          recoveryTimeMs: 2 + index,
          publicReadResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
          authenticatedImpact: { status: 'not-configured' },
          notificationStreamImpact: { status: 'not-configured' },
          finalHealthStatus: 'healthy'
        })),
        ...requiredPostgresFaultCases.map((caseName, index) => ({
          case: caseName,
          status: 'completed',
          actionStatus: 'executed',
          actionStartedAt: `2026-06-18T00:01:0${index}Z`,
          actionCompletedAt: `2026-06-18T00:01:1${index}Z`,
          affectedEndpoint: index === 2 ? '/api/binary/article/list/home/1/10.aeds' : '/health/ready',
          unavailableDurationMs: index,
          dbReconnectDurationMs: 3 + index,
          recoveryDurationMs: 3 + index,
          recoveryTimeMs: 3 + index,
          publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
          writePathRollbackResult: { status: index === 2 ? 'verified' : 'not-mutated' },
          finalHealthStatus: 'healthy'
        }))
      ]
    }, 'fault-injection-self-test')
  } catch {
    missingNotificationFailedAsExpected = true
  }
  assert(missingNotificationFailedAsExpected, 'self-test missing notification slow-consumer fixture must fail')
  let missingGracefulShutdownFailedAsExpected = false
  try {
    validateFaultInjectionSummary({
      status: 'ok',
      caseCount: 7,
      cases: [
        ...requiredRedisFaultCases.map((caseName, index) => ({
          case: caseName,
          status: 'completed',
          actionStatus: 'executed',
          actionStartedAt: `2026-06-18T00:00:0${index}Z`,
          actionCompletedAt: `2026-06-18T00:00:1${index}Z`,
          unavailableDurationMs: index,
          recoveryDurationMs: 2 + index,
          recoveryTimeMs: 2 + index,
          publicReadResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
          authenticatedImpact: { status: 'not-configured' },
          notificationStreamImpact: { status: 'not-configured' },
          finalHealthStatus: 'healthy'
        })),
        ...requiredPostgresFaultCases.map((caseName, index) => ({
          case: caseName,
          status: 'completed',
          actionStatus: 'executed',
          actionStartedAt: `2026-06-18T00:01:0${index}Z`,
          actionCompletedAt: `2026-06-18T00:01:1${index}Z`,
          affectedEndpoint: index === 2 ? '/api/binary/article/list/home/1/10.aeds' : '/health/ready',
          unavailableDurationMs: index,
          dbReconnectDurationMs: 3 + index,
          recoveryDurationMs: 3 + index,
          recoveryTimeMs: 3 + index,
          publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
          writePathRollbackResult: { status: index === 2 ? 'verified' : 'not-mutated' },
          finalHealthStatus: 'healthy'
        })),
        {
          case: 'notification-stream-slow-consumer',
          status: 'completed',
          actionStatus: 'executed',
          actionStartedAt: '2026-06-18T00:02:00Z',
          actionCompletedAt: '2026-06-18T00:02:10Z',
          unavailableDurationMs: 0,
          recoveryDurationMs: 5,
          recoveryTimeMs: 5,
          connectionCount: 3,
          heartbeatFrameCount: 2,
          businessFrameCount: 8,
          deliveredFrameCount: 8,
          droppedOrBackpressuredCount: 1,
          reconnectSuccess: true,
          replayedEventCount: 1,
          closeObserved: true,
          eventIds: [101, 102],
          routeKey: 'g:ContentGovernanceGroup',
          slowConsumerPolicy: 'controlled-degradation',
          finalHealthStatus: 'healthy'
        }
      ]
    }, 'fault-injection-self-test')
  } catch {
    missingGracefulShutdownFailedAsExpected = true
  }
  assert(missingGracefulShutdownFailedAsExpected, 'self-test missing graceful shutdown fixture must fail')
  validateFaultInjectionSummary({
    status: 'ok',
    caseCount: 8,
    cases: [
      ...requiredRedisFaultCases.map((caseName, index) => ({
      case: caseName,
      status: 'completed',
      actionStatus: 'executed',
      actionStartedAt: `2026-06-18T00:00:0${index}Z`,
      actionCompletedAt: `2026-06-18T00:00:1${index}Z`,
      unavailableDurationMs: index,
      recoveryDurationMs: 2 + index,
      recoveryTimeMs: 2 + index,
      publicReadResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
      authenticatedImpact: { status: 'not-configured' },
      notificationStreamImpact: { status: 'not-configured' },
      finalHealthStatus: 'healthy'
      })),
      ...requiredPostgresFaultCases.map((caseName, index) => ({
        case: caseName,
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: `2026-06-18T00:01:0${index}Z`,
        actionCompletedAt: `2026-06-18T00:01:1${index}Z`,
        affectedEndpoint: index === 2 ? '/api/binary/article/list/home/1/10.aeds' : '/health/ready',
        unavailableDurationMs: index,
        dbReconnectDurationMs: 3 + index,
        recoveryDurationMs: 3 + index,
        recoveryTimeMs: 3 + index,
        publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        writePathRollbackResult: { status: index === 2 ? 'verified' : 'not-mutated' },
        finalHealthStatus: 'healthy'
      })),
      {
        case: 'notification-stream-slow-consumer',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:02:00Z',
        actionCompletedAt: '2026-06-18T00:02:10Z',
        unavailableDurationMs: 0,
        recoveryDurationMs: 5,
        recoveryTimeMs: 5,
        connectionCount: 3,
        heartbeatFrameCount: 2,
        businessFrameCount: 8,
        deliveredFrameCount: 8,
        droppedOrBackpressuredCount: 1,
        reconnectSuccess: true,
        replayedEventCount: 1,
        closeObserved: true,
        eventIds: [101, 102],
        routeKey: 'g:ContentGovernanceGroup',
        slowConsumerPolicy: 'controlled-degradation',
        finalHealthStatus: 'healthy'
      },
      {
        case: 'graceful-shutdown',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:03:00Z',
        actionCompletedAt: '2026-06-18T00:03:10Z',
        shutdownRequestedAt: '2026-06-18T00:03:01Z',
        drainDurationMs: 300,
        restartRecoveryDurationMs: 500,
        recoveryDurationMs: 800,
        recoveryTimeMs: 800,
        processStopResult: { status: 'stopped', signal: 'SIGTERM', exitObserved: true },
        livenessBefore: { status: 'completed', sampleCount: 1 },
        livenessDuringShutdown: { status: 'unavailable', statusCode: null },
        notificationCloseObserved: true,
        notificationCloseCode: 1001,
        notificationReconnectSuccess: true,
        publicReadRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        basicAuthRecoveryResult: { status: 'completed', sampleCount: 1, p95Ms: 1 },
        backgroundWorkerState: { status: 'clean', source: 'log-scan' },
        finalHealthStatus: 'healthy'
      }
    ]
  }, 'fault-injection-self-test')
  console.log('[evidence-metrics:self-test] ok')
}

try {
  main()
} catch (error) {
  console.error(`[evidence-metrics] ${error.message}`)
  process.exit(1)
}
