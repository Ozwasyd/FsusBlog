#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  finalizeAedsFrameCostSummary,
  readAedsFrameCostPolicy,
  stageAedsFrameCostArtifacts,
  validateAedsFrameCostSummary
} from './aeds-frame-cost-evidence.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const requiredRedisFaultCases = ['redis-restart', 'redis-reconnect', 'redis-latency']
const requiredPostgresFaultCases = ['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout']
const requiredNotificationFaultCases = ['notification-stream-slow-consumer']
const requiredGracefulShutdownFaultCases = ['graceful-shutdown']
const requiredDiskArtifactFaultCases = ['disk-artifact-storage-write-failure']
const requiredExtendedObservabilityCategories = ['managedRuntime', 'threadOrConnection', 'storageOrCacheLatency']
const perfPolicyRelativeFile = 'tests/performance/perf-policy.yml'

function optionValue(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback
}

function expectedEvidenceCommit() {
  const explicit = optionValue('--expected-commit')
  if (explicit) return explicit.trim().toLowerCase()
  for (const name of ['FSUSBLOG_EVIDENCE_COMMIT_SHA', 'FSUSBLOG_TEST_SOURCE_COMMIT', 'GITHUB_SHA']) {
    const value = process.env[name]?.trim().toLowerCase()
    if (value) return value
  }
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().toLowerCase()
}

function aedsFrameCostPolicy() {
  const policyFile = path.resolve(root, optionValue('--policy', perfPolicyRelativeFile))
  return readAedsFrameCostPolicy(policyFile, perfPolicyRelativeFile)
}

function aedsArtifactContext({ allowDownloaded = false } = {}) {
  const artifactRoot = path.resolve(optionValue('--artifact-root', root))
  const directResolver = (relativePath) => {
    const candidate = path.resolve(artifactRoot, relativePath)
    return fs.existsSync(candidate) ? candidate : null
  }
  return {
    artifactRoot,
    resolveArtifactPath: allowDownloaded && artifactRoot === root
      ? (relativePath) => findEvidenceFile(relativePath)
      : directResolver
  }
}

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
      if (isEvidenceDirectory(next, entry)) {
        stack.push(next)
      } else if (next.endsWith(suffix)) {
        return next
      }
    }
  }
  return null
}

function isEvidenceDirectory(entryPath, entry) {
  if (entry.isDirectory()) {
    return true
  }
  if (!entry.isSymbolicLink()) {
    return false
  }
  try {
    return fs.statSync(entryPath).isDirectory()
  } catch {
    return false
  }
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
        if (isEvidenceDirectory(next, entry)) {
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

function positiveInteger(value, label) {
  assert(Number.isInteger(value) && value > 0, `${label} must be a positive integer`)
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

function readLoadProfilePolicy(profile) {
  const text = fs.readFileSync(path.join(root, perfPolicyRelativeFile), 'utf8')
  const profiles = yamlSection(text, 'loadProfiles')
  const values = yamlScalarMap(yamlSection(profiles, profile, 2))
  const declared = {
    concurrency: values.concurrency,
    rounds: values.rounds,
    durationMs: values.durationMs
  }
  for (const key of ['concurrency', 'rounds', 'durationMs']) {
    positiveInteger(declared[key], `perf-policy.${profile}.${key}`)
  }
  const thresholds = {
    maxP95Ms: values.maxP95Ms,
    maxP99Ms: values.maxP99Ms,
    maxErrorRate: values.maxErrorRate,
    maxTimeoutRate: values.maxTimeoutRate,
    ...(Number.isFinite(values.minRps) ? { minRps: values.minRps } : {})
  }
  for (const key of ['maxP95Ms', 'maxP99Ms', 'maxErrorRate', 'maxTimeoutRate']) {
    nonNegativeNumber(thresholds[key], `perf-policy.${profile}.${key}`)
  }
  return { declared, thresholds }
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
  validateExtendedObservability(probe, label)
}

function validateExtendedObservability(probe, label) {
  assert(['basic-runtime-evidence', 'extended-runtime-evidence'].includes(probe.observabilityLevel), `${label}.runtime.observabilityLevel must distinguish basic-runtime-evidence or extended-runtime-evidence`)
  const extended = probe.extendedObservability
  assert(extended && typeof extended === 'object', `${label}.runtime.extendedObservability missing`)
  assert(Array.isArray(extended.requiredCategories), `${label}.runtime.extendedObservability.requiredCategories missing`)
  for (const category of requiredExtendedObservabilityCategories) {
    assert(extended.requiredCategories.includes(category), `${label}.runtime.extendedObservability.requiredCategories missing ${category}`)
    validateExtendedObservabilityCategory(extended.categories?.[category], `${label}.runtime.extendedObservability.categories.${category}`)
  }
  const complete = requiredExtendedObservabilityCategories
    .every((category) => extended.categories?.[category]?.status === 'ok')
  assert(extended.status === (complete ? 'complete' : 'partial'), `${label}.runtime.extendedObservability.status must match category completeness`)
  const expectedLevel = complete ? 'extended-runtime-evidence' : 'basic-runtime-evidence'
  assert(probe.observabilityLevel === expectedLevel, `${label}.runtime.observabilityLevel must be ${expectedLevel}`)
  if (!complete) {
    assert(typeof extended.reason === 'string' && extended.reason.length > 0, `${label}.runtime.extendedObservability.reason missing for partial evidence`)
  }
}

function validateExtendedObservabilityCategory(category, label) {
  assert(category && typeof category === 'object', `${label} missing`)
  assert(['ok', 'missing', 'unsupported', 'disabled', 'probe-failed', 'not-collected'].includes(category.status), `${label}.status invalid`)
  const fields = category.fields
  assert(fields && typeof fields === 'object', `${label}.fields missing`)
  assert(Object.keys(fields).length > 0, `${label}.fields must be non-empty`)
  let okFieldCount = 0
  for (const [name, field] of Object.entries(fields)) {
    const fieldLabel = `${label}.fields.${name}`
    assert(field && typeof field === 'object', `${fieldLabel} missing`)
    assert(typeof field.status === 'string' && field.status.length > 0, `${fieldLabel}.status missing`)
    if (field.status === 'ok') {
      okFieldCount += 1
      assert(Object.prototype.hasOwnProperty.call(field, 'value'), `${fieldLabel}.value missing`)
      assert(typeof field.source === 'string' && field.source.length > 0, `${fieldLabel}.source missing`)
    } else {
      assert(['unsupported', 'disabled', 'probe-failed', 'not-collected', 'missing'].includes(field.status), `${fieldLabel}.status has unsupported value`)
      assert(typeof field.reason === 'string' && field.reason.length > 0, `${fieldLabel}.reason missing`)
    }
  }
  if (category.status === 'ok') {
    assert(okFieldCount > 0, `${label} ok category must include at least one ok field`)
  } else {
    assert(typeof category.reason === 'string' && category.reason.length > 0, `${label}.reason missing`)
  }
}

function validateCounter(counter, label, requireOk = false) {
  assert(counter && typeof counter === 'object', `${label} missing`)
  assert(typeof counter.status === 'string' && counter.status.length > 0, `${label}.status missing`)
  if (requireOk) {
    assert(counter.status === 'ok', `${label}.status must be ok`)
  }
  if (counter.status === 'ok') {
    const hasValue = Object.keys(counter).some((key) => key !== 'status' && key !== 'source' && key !== 'reason' && counter[key] !== null && counter[key] !== undefined)
    assert(hasValue, `${label} ok counter must include a value`)
  } else {
    assert(['unsupported', 'disabled', 'probe-failed', 'not-collected', 'missing'].includes(counter.status), `${label}.status has unsupported value`)
    assert(typeof counter.reason === 'string' && counter.reason.length > 0, `${label}.reason missing`)
  }
}

function validateDataScaleMetric(metric, label, countField, sizeField) {
  assert(metric && typeof metric === 'object', `${label} missing`)
  assert(['ok', 'missing', 'blocked'].includes(metric.status), `${label}.status must be ok/missing/blocked`)
  assert(metric.status === 'ok', `${label}.status must be ok`)
  positiveInteger(metric[countField], `${label}.${countField}`)
  positiveNumber(metric[sizeField], `${label}.${sizeField}`)
}

function validateBackendQpsCollectorResult(result, label, options = {}) {
  const requireStaticChecks = options.requireStaticChecks ?? true
  assert(result.evidenceType === 'backend-qps-collector-evidence', `${label}.evidenceType must be backend-qps-collector-evidence`)
  assert(result.staticEvidence?.evidenceType === 'static-implementation-evidence', `${label}.staticEvidence.evidenceType must be static-implementation-evidence`)
  if (requireStaticChecks) {
    assert(Array.isArray(result.staticEvidence?.checks) && result.staticEvidence.checks.length > 0, `${label}.staticEvidence.checks must be non-empty`)
  } else {
    assert(result.staticEvidence?.status === 'not-collected', `${label}.staticEvidence.status must be not-collected for sequential runtime measurement`)
    assert(typeof result.staticEvidence?.reason === 'string' && result.staticEvidence.reason.length > 0, `${label}.staticEvidence.reason missing`)
  }
  assert(result.runtimeMeasurement?.evidenceType === 'runtime-http-probe', `${label}.runtimeMeasurement.evidenceType must be runtime-http-probe`)
  assert(Array.isArray(result.runtimeMeasurement?.requestPlan?.steps) && result.runtimeMeasurement.requestPlan.steps.length > 0, `${label}.runtimeMeasurement.requestPlan.steps must be non-empty`)
  for (const [index, step] of result.runtimeMeasurement.requestPlan.steps.entries()) {
    const stepLabel = `${label}.runtimeMeasurement.requestPlan.steps[${index}]`
    assert(step.method === 'GET', `${stepLabel}.method must be GET`)
    assert(typeof step.path === 'string' && step.path.startsWith('/'), `${stepLabel}.path must be an absolute app path`)
    assert(step.expectedStatus === 200, `${stepLabel}.expectedStatus must be 200`)
    assert(step.expectedContentType === 'application/octet-stream', `${stepLabel}.expectedContentType must be application/octet-stream`)
    positiveNumber(step.expectedFrameType, `${stepLabel}.expectedFrameType`)
    assert(typeof step.fixturePrerequisite === 'string' && step.fixturePrerequisite.length > 0, `${stepLabel}.fixturePrerequisite must be explicit`)
  }
  positiveNumber(result.runtimeMeasurement?.requestPlan?.requestCount, `${label}.runtimeMeasurement.requestPlan.requestCount`)
  positiveNumber(result.runtimeMeasurement?.requestPlan?.concurrency, `${label}.runtimeMeasurement.requestPlan.concurrency`)
  assert(result.runtimeMeasurement?.requestPlan?.thresholdPolicy?.countedAsCapacity === false, `${label}.runtimeMeasurement threshold must not be capacity benchmark`)
  positiveNumber(result.runtimeMeasurement?.rps, `${label}.runtimeMeasurement.rps`)
  positiveNumber(result.runtimeMeasurement?.p50Ms, `${label}.runtimeMeasurement.p50Ms`)
  positiveNumber(result.runtimeMeasurement?.p95Ms, `${label}.runtimeMeasurement.p95Ms`)
  const counters = result.runtimeMeasurement?.measuredCounters
  assert(counters && typeof counters === 'object', `${label}.runtimeMeasurement.measuredCounters missing`)
  validateCounter(counters.requestCount, `${label}.measuredCounters.requestCount`, true)
  validateCounter(counters.statusDistribution, `${label}.measuredCounters.statusDistribution`, true)
  validateCounter(counters.bytes, `${label}.measuredCounters.bytes`, true)
  validateCounter(counters.cacheHitSignal, `${label}.measuredCounters.cacheHitSignal`, true)
  validateCounter(counters.dbCommands, `${label}.measuredCounters.dbCommands`)
  validateCounter(counters.redisCommands, `${label}.measuredCounters.redisCommands`)
  validateCounter(counters.allocationEstimate, `${label}.measuredCounters.allocationEstimate`)
  validateCounter(counters.threadPool, `${label}.measuredCounters.threadPool`)
  validateCounter(counters.dbGatePressure, `${label}.measuredCounters.dbGatePressure`)
  if (['cache-hit', 'hotread', 'cache-miss-singleflight'].includes(result.scenario)) {
    validateCounter(counters.cacheHitSignal, `${label}.measuredCounters.cacheHitSignal`, true)
    nonNegativeNumber(counters.cacheHitSignal.ratio, `${label}.measuredCounters.cacheHitSignal.ratio`)
  }
  assert(result.capacityConclusion?.countedAsCapacity === false, `${label}.capacityConclusion must be false`)
  validateRuntimeProbe(result.runtimeMeasurement?.runtime, label)
}

function validateBackendQps() {
  const summary = readJson('.tmp/release-evidence/backend-qps-summary.json')
  assert(summary.status === 'ok', 'backend-qps-summary.status must be ok')
  assert(Array.isArray(summary.results) && summary.results.length > 0, 'backend-qps-summary.results must be non-empty')
  assert(summary.evidenceModel === 'static-implementation-plus-runtime-measurement', 'backend-qps-summary.evidenceModel must separate static and runtime evidence')
  assert(summary.capacityConclusion?.countedAsCapacity === false, 'backend-qps-summary must not be counted as capacity benchmark')
  for (const result of summary.results) {
    validateBackendQpsCollectorResult(result, `backend-qps:${result.scenario ?? 'unknown'}`)
  }
}

function validateBackendQpsSequential() {
  const summary = readJson('.tmp/release-evidence/backend-qps-runtime-sequential-summary.json', true)
  if (!summary) return
  assert(summary.status === 'ok', 'backend-qps-runtime-sequential-summary.status must be ok')
  assert(summary.evidenceType === 'backend-qps-runtime-sequential-summary', 'backend-qps-runtime-sequential-summary.evidenceType mismatch')
  assert(summary.evidenceModel === 'warmed-runtime-sequential-measurement', 'backend-qps-runtime-sequential-summary.evidenceModel must be warmed sequential')
  assert(typeof summary.runtimeId === 'string' && summary.runtimeId.length > 0, 'backend-qps-runtime-sequential-summary.runtimeId missing')
  assert(typeof summary.namespace === 'string' && summary.namespace.length > 0, 'backend-qps-runtime-sequential-summary.namespace missing')
  assert(typeof summary.baseUrl === 'string' && summary.baseUrl.length > 0, 'backend-qps-runtime-sequential-summary.baseUrl missing')
  positiveNumber(summary.warmupDurationMs, 'backend-qps-runtime-sequential-summary.warmupDurationMs')
  assert(summary.warmup?.status === 'ok', 'backend-qps-runtime-sequential-summary.warmup.status must be ok')
  positiveNumber(summary.warmup?.durationMs, 'backend-qps-runtime-sequential-summary.warmup.durationMs')
  positiveNumber(summary.warmup?.sampleCount, 'backend-qps-runtime-sequential-summary.warmup.sampleCount')
  assert(Array.isArray(summary.warmup?.phases) && summary.warmup.phases.length >= 3, 'backend-qps-runtime-sequential-summary.warmup.phases must include warmup phases')
  const warmupPhases = new Set(summary.warmup.phases.map((item) => item.phase))
  for (const phase of ['public-read-warmup', 'binary-read-warmup', 'cache-warmup']) {
    assert(warmupPhases.has(phase), `backend-qps-runtime-sequential-summary.warmup.phases missing ${phase}`)
  }
  assert(Array.isArray(summary.warmup?.requestPlan) && summary.warmup.requestPlan.every((item) => typeof item === 'string' && item.startsWith('/')), 'backend-qps-runtime-sequential-summary.warmup.requestPlan must use app paths')
  validateRuntimeProbe(summary.warmup?.runtime, 'backend-qps-runtime-sequential-summary.warmup')
  assert(summary.cacheMissSeparation?.status === 'explicit', 'backend-qps-runtime-sequential-summary.cacheMissSeparation must be explicit')
  assert(Array.isArray(summary.cacheMissSeparation?.measuredScenarios) && summary.cacheMissSeparation.measuredScenarios.includes('cache-miss-singleflight'), 'backend-qps-runtime-sequential-summary.cacheMissSeparation must list cache miss scenarios')
  assert(Array.isArray(summary.scenarioOrder) && summary.scenarioOrder.length > 0, 'backend-qps-runtime-sequential-summary.scenarioOrder must be non-empty')
  assert(Array.isArray(summary.results) && summary.results.length === summary.scenarioOrder.length, 'backend-qps-runtime-sequential-summary.results must match scenarioOrder')
  assert(summary.scenarioCount === summary.results.length, 'backend-qps-runtime-sequential-summary.scenarioCount must match results')
  assert(summary.performance_baseline?.mode === 'kestrel-only-sequential', 'backend-qps-runtime-sequential-summary.performance_baseline.mode must be sequential')
  assert(typeof summary.machineMetadata === 'string' && summary.machineMetadata.length > 0, 'backend-qps-runtime-sequential-summary.machineMetadata missing')
  assert(summary.capacityConclusion?.countedAsCapacity === false, 'backend-qps-runtime-sequential-summary must not be capacity benchmark')
  for (const [index, result] of summary.results.entries()) {
    assert(result.scenario === summary.scenarioOrder[index], `backend-qps-runtime-sequential-summary.results[${index}].scenario must match scenarioOrder`)
    validateBackendQpsCollectorResult(result, `backend-qps-runtime-sequential:${result.scenario ?? 'unknown'}`, { requireStaticChecks: false })
  }
}

function validateDataScale() {
  const aggregate = readJson('.tmp/release-evidence/data-scale-summary.json', true)
  if (!aggregate) return
  assert(aggregate.schema === 'fsusblog.data-scale-evidence-summary.v1', 'data-scale-summary.schema mismatch')
  assert(aggregate.status === 'ok', 'data-scale-summary.status must be ok')
  assert(
    JSON.stringify(aggregate.requiredTiers) === JSON.stringify(['scale-xs', 'scale-s']),
    'data-scale-summary.requiredTiers must be scale-xs and scale-s'
  )
  assert(Array.isArray(aggregate.tiers) && aggregate.tiers.length === 2, 'data-scale-summary.tiers must contain both required tiers')
  const byTier = new Map(aggregate.tiers.map((entry) => [entry?.tier, entry]))
  assert(byTier.size === 2, 'data-scale-summary.tiers must not contain duplicates')
  for (const tier of aggregate.requiredTiers) {
    const entry = byTier.get(tier)
    assert(entry?.status === 'ok', `data-scale-summary.${tier}.status must be ok`)
    assert(typeof entry?.sourceLocation === 'string' && entry.sourceLocation.length > 0, `data-scale-summary.${tier}.sourceLocation missing`)
    assert(entry?.summary?.tier === tier, `data-scale-summary.${tier}.tier mismatch`)
    validateDataScaleTierSummary(entry.summary)
  }
}

function validateDataScaleTierSummary(summary) {
  assert(summary.status === 'ok', 'data-scale-summary.status must be ok')
  assert(summary.seed?.status === 'ok', 'data-scale-summary.seed.status must be ok')
  assert(summary.cleanup?.status === 'ok', 'data-scale-summary.cleanup.status must be ok')
  assert(summary.observed?.status === 'ok', 'data-scale-summary.observed.status must be ok')
  assert(summary.seed?.declared?.articles === summary.expectedSeed?.articles, 'data-scale declared article count must match lane declaration')
  assert(summary.seed?.declared?.comments === summary.expectedSeed?.comments, 'data-scale declared comment count must match lane declaration')
  assert(summary.seed?.expected?.articles === summary.seed?.observed?.articles, 'data-scale seed article count must match expected')
  assert(summary.seed?.expected?.comments === summary.seed?.observed?.comments, 'data-scale seed comment count must match expected')
  assert(summary.observed?.seedManifest?.declared?.articles === summary.observed?.db?.articleRows, 'data-scale probe article count must match declared')
  assert(summary.observed?.seedManifest?.declared?.comments === summary.observed?.db?.commentRows, 'data-scale probe comment count must match declared')
  assert(summary.observed?.seedManifest?.observed?.articles === summary.observed?.db?.articleRows, 'data-scale probe article count must match seed observed')
  assert(summary.observed?.seedManifest?.observed?.comments === summary.observed?.db?.commentRows, 'data-scale probe comment count must match seed observed')
  assert(summary.observed?.expected?.articles === summary.expectedSeed?.articles, 'data-scale probe expected articles must match lane declaration')
  assert(summary.observed?.expected?.comments === summary.expectedSeed?.comments, 'data-scale probe expected comments must match lane declaration')
  assert(summary.observed?.observed?.articles === summary.expectedSeed?.articles, 'data-scale probe observed articles must match expected')
  assert(summary.observed?.observed?.comments === summary.expectedSeed?.comments, 'data-scale probe observed comments must match expected')
  assert(summary.observed?.observed?.categories >= summary.observed?.expected?.categoriesAtLeast, 'data-scale category count must meet expected minimum')
  assert(summary.observed?.observed?.tags >= summary.observed?.expected?.tagsAtLeast, 'data-scale tag count must meet expected minimum')
  assert(summary.observed?.observed?.rootComments === summary.observed?.expected?.rootComments, 'data-scale root comment count must match expected')
  assert(summary.observed?.observed?.nestedComments === summary.observed?.expected?.nestedComments, 'data-scale nested comment count must match expected')
  assert(summary.observed?.categoryDistribution?.status === 'ok', 'data-scale category distribution status must be ok')
  assert(Array.isArray(summary.observed?.categoryDistribution?.buckets) && summary.observed.categoryDistribution.buckets.length > 0, 'data-scale category distribution buckets must be non-empty')
  assert(summary.observed?.categoryDistribution?.totalArticles === summary.expectedSeed?.articles, 'data-scale category distribution total must match expected articles')
  assert(summary.observed?.tagDistribution?.status === 'ok', 'data-scale tag distribution status must be ok')
  assert(Array.isArray(summary.observed?.tagDistribution?.buckets) && summary.observed.tagDistribution.buckets.length > 0, 'data-scale tag distribution buckets must be non-empty')
  assert(summary.observed?.tagDistribution?.totalArticleTags >= summary.expectedSeed?.articles, 'data-scale tag distribution total must cover expected articles')
  assert(summary.observed?.db?.countsMatch === true, 'data-scale probe countsMatch must be true')
  validateDataScaleMetric(summary.observed?.search, 'data-scale.search', 'entryCount', 'indexSizeBytes')
  validateDataScaleMetric(summary.observed?.aot, 'data-scale.aot', 'artifactCount', 'cacheSizeBytes')
  validateDataScaleMetric(summary.observed?.hotRead, 'data-scale.hotRead', 'artifactSampleCount', 'sampleBytes')
  assert(summary.cleanup?.remaining?.articles === 0, 'data-scale cleanup must remove articles')
  assert(summary.cleanup?.remaining?.comments === 0, 'data-scale cleanup must remove comments')
  assert(summary.cleanup?.search?.residualCount === 0, 'data-scale cleanup search residual count must be explicit zero')
  assert(summary.cleanup?.artifacts?.residualCount === 0, 'data-scale cleanup artifact residual count must be explicit zero')
  nonNegativeNumber(summary.cleanup?.durationMs, 'data-scale.cleanup.durationMs')
  validateRuntimeProbe(summary.observed?.runtime, 'data-scale')
  positiveNumber(summary.observed?.latencyMs?.p95, 'data-scale.latencyMs.p95')
}

function validateLoadProfiles() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}perf${path.sep}load-`))
  for (const file of summaries) {
    const relative = path.relative(root, file)
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    validateLoadProfileSummary(summary, relative)
  }
}

function validateLoadProfileSummary(summary, label) {
  assert(summary.status === 'ok', `${label}.status must be ok`)
  const profile = summary.profileName ?? summary.profile
  assert(typeof profile === 'string' && profile.length > 0, `${label}.profileName must be present`)
  assert(summary.policy?.file === perfPolicyRelativeFile, `${label}.policy.file must be ${perfPolicyRelativeFile}`)
  const policy = readLoadProfilePolicy(profile)
  for (const key of ['concurrency', 'rounds', 'durationMs']) {
    positiveInteger(summary.declared?.[key], `${label}.declared.${key}`)
    positiveInteger(summary.effective?.[key], `${label}.effective.${key}`)
    assert(summary.declared[key] === policy.declared[key], `${label}.declared.${key} must match ${perfPolicyRelativeFile}`)
    const source = summary.overrideSources?.[key]
    assert(typeof source === 'string' && source.length > 0, `${label}.overrideSources.${key} missing`)
    if (source === 'policy') {
      assert(summary.effective[key] === summary.declared[key], `${label}.effective.${key} must match policy without override`)
    } else {
      assert(source === `env:FSUSBLOG_LOAD_PROFILE_${key === 'durationMs' ? 'DURATION_MS' : key.toUpperCase()}`, `${label}.overrideSources.${key} has unsupported source`)
    }
  }
  validateLoadProfileThresholds(summary, label, policy.thresholds)
  const hasOverride = Object.values(summary.overrideSources).some((source) => source !== 'policy')
  assert(summary.overrideSource === (hasOverride ? 'env' : 'policy'), `${label}.overrideSource mismatch`)
  assert(summary.sampling?.totalRequests === summary.effective.concurrency * summary.effective.rounds, `${label}.sampling.totalRequests must be concurrency * rounds`)
  positiveNumber(summary.metrics?.rps, `${label}.metrics.rps`)
  positiveNumber(summary.metrics?.p95Ms, `${label}.metrics.p95Ms`)
  validateRuntimeProbe(summary.runtime, label)
}

function validateLoadProfileThresholds(summary, label, policyThresholds) {
  assert(summary.thresholds && typeof summary.thresholds === 'object', `${label}.thresholds missing`)
  for (const key of ['maxP95Ms', 'maxP99Ms', 'maxErrorRate', 'maxTimeoutRate']) {
    nonNegativeNumber(summary.thresholds[key], `${label}.thresholds.${key}`)
    assert(summary.thresholds[key] === policyThresholds[key], `${label}.thresholds.${key} must match ${perfPolicyRelativeFile}`)
  }
  if (summary.thresholds.minRps !== undefined) {
    nonNegativeNumber(summary.thresholds.minRps, `${label}.thresholds.minRps`)
    assert(summary.thresholds.minRps === policyThresholds.minRps, `${label}.thresholds.minRps must match ${perfPolicyRelativeFile}`)
  }
  assert(summary.thresholdEvaluation?.status === 'pass', `${label}.thresholdEvaluation.status must be pass`)
  assert(Array.isArray(summary.thresholdEvaluation?.checks) && summary.thresholdEvaluation.checks.length >= 4, `${label}.thresholdEvaluation.checks must be present`)
  for (const check of summary.thresholdEvaluation.checks) {
    assert(check.status === 'pass', `${label}.thresholdEvaluation.${check.metric}.status must be pass`)
    assert(['<=', '>='].includes(check.operator), `${label}.thresholdEvaluation.${check.metric}.operator invalid`)
    assert(typeof check.metric === 'string' && check.metric.length > 0, `${label}.thresholdEvaluation check metric missing`)
    nonNegativeNumber(check.actual, `${label}.thresholdEvaluation.${check.metric}.actual`)
    nonNegativeNumber(check.threshold, `${label}.thresholdEvaluation.${check.metric}.threshold`)
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
  for (const required of requiredDiskArtifactFaultCases) {
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
    if (requiredDiskArtifactFaultCases.includes(item.case)) {
      validateDiskArtifactFaultCase(item, label)
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

function validateDiskArtifactFaultCase(item, label) {
  assert(typeof item.targetPath === 'string' && item.targetPath.length > 0, `${label} ${item.case}.targetPath missing`)
  assert(typeof item.expectedErrorClassification === 'string' && item.expectedErrorClassification.length > 0, `${label} ${item.case}.expectedErrorClassification missing`)
  assert(item.writeFailureResult?.status === 'expected-error', `${label} ${item.case}.writeFailureResult.status must be expected-error`)
  assert(item.recoveryResult?.status === 'completed', `${label} ${item.case}.recoveryResult must be completed`)
  assert(item.cleanupResult?.status === 'completed', `${label} ${item.case}.cleanupResult must be completed`)
  positiveNumber(item.recoveryDurationMs ?? item.recoveryTimeMs, `${label} ${item.case}.recoveryDurationMs`)
  assert(item.finalHealthStatus === 'healthy', `${label} ${item.case}.finalHealthStatus must be healthy`)
}

function validateSoakResourceMetric(metric, label) {
  assert(metric && typeof metric === 'object', `${label} missing`)
  assert(typeof metric.name === 'string' && metric.name.length > 0, `${label}.name missing`)
  for (const field of ['startValue', 'endValue', 'maxValue', 'delta']) {
    assert(typeof metric[field] === 'number' && Number.isFinite(metric[field]), `${label}.${field} must be a finite number`)
  }
  assert(typeof metric.unit === 'string' && metric.unit.length > 0, `${label}.unit missing`)
  assert(typeof metric.status === 'string' && metric.status.length > 0, `${label}.status missing`)
}

function validateSoakResourceEvidence(summary, label) {
  const resourceSummary = summary.resourceMetricSummary
  assert(resourceSummary && typeof resourceSummary === 'object', `${label}.resourceMetricSummary missing`)
  const metrics = Array.isArray(resourceSummary.metrics) ? resourceSummary.metrics : []
  const unavailable = Array.isArray(resourceSummary.unavailableMetrics) ? resourceSummary.unavailableMetrics : []
  for (const [index, metric] of metrics.entries()) {
    validateSoakResourceMetric(metric, `${label}.resourceMetricSummary.metrics[${index}]`)
  }
  for (const [index, metric] of unavailable.entries()) {
    assert(typeof metric.reason === 'string' && metric.reason.length > 0, `${label}.resourceMetricSummary.unavailableMetrics[${index}].reason missing`)
  }
  assert(metrics.length > 0 || unavailable.length > 0, `${label}.resourceMetricSummary must include metrics or unavailable reasons`)
}

function validateShortSoakSummary(summary, label) {
  assert(summary.status === 'ok', `${label}.status must be ok`)
  assert(summary.mode === 'short', `${label}.mode must be short`)
  assert(summary.executionMode === 'runtime', `${label}.executionMode must be runtime`)
  assert(summary.countsAsReleaseFinal === true, `${label}.countsAsReleaseFinal must be true`)
  positiveNumber(summary.durationSeconds, `${label}.durationSeconds`)
  positiveNumber(summary.sampleCount, `${label}.sampleCount`)
  positiveNumber(summary.latencyMs?.p95, `${label}.latencyMs.p95`)
  positiveNumber(summary.latencyMs?.p99, `${label}.latencyMs.p99`)
  nonNegativeNumber(summary.errorRate, `${label}.errorRate`)
  validateSoakResourceEvidence(summary, label)
}

function validateImportedLongSoakSummary(summary, label, mode) {
  assert(summary.status === 'ok', `${label}.status must be ok`)
  assert(summary.mode === mode, `${label}.mode must be ${mode}`)
  assert(summary.executionMode === 'imported', `${label}.executionMode must be imported`)
  assert(summary.countsAsReleaseFinal === true, `${label}.countsAsReleaseFinal must be true`)
  positiveNumber(summary.durationSeconds, `${label}.durationSeconds`)
  positiveNumber(summary.sampleCount, `${label}.sampleCount`)
  positiveNumber(summary.latencyMs?.p95, `${label}.latencyMs.p95`)
  positiveNumber(summary.latencyMs?.p99, `${label}.latencyMs.p99`)
  nonNegativeNumber(summary.errorRate, `${label}.errorRate`)
  assert(typeof summary.importedEvidence?.source === 'string' && summary.importedEvidence.source.length > 0, `${label}.importedEvidence.source missing`)
  validateSoakResourceEvidence(summary, label)
}

function validateSoak() {
  const summaries = findEvidenceFilesBySuffix('/summary.json')
    .filter((file) => file.includes(`${path.sep}.tmp${path.sep}soak${path.sep}`))
  for (const file of summaries) {
    const mode = path.basename(path.dirname(file))
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (summary.status === 'scheduled') {
      assert(mode !== 'short', 'short soak must be a runtime probe, not scheduled')
      assert(summary.executionMode === 'scheduled', `soak ${mode}.executionMode must be scheduled`)
      assert(summary.countsAsReleaseFinal === false, `soak ${mode}.countsAsReleaseFinal must be false`)
      assert(typeof summary.reason === 'string' && summary.reason.length > 0, `soak ${mode}.reason missing`)
      continue
    }
    if (mode === 'short') {
      validateShortSoakSummary(summary, `soak ${mode}`)
    } else {
      validateImportedLongSoakSummary(summary, `soak ${mode}`, mode)
    }
  }
}

function validateReleaseResourceMetric(metric, label) {
  assert(metric && typeof metric === 'object', `${label} missing`)
  assert(typeof metric.name === 'string' && metric.name.length > 0, `${label}.name missing`)
  for (const field of ['startValue', 'endValue', 'maxValue', 'threshold']) {
    nonNegativeNumber(metric[field], `${label}.${field}`)
  }
  assert(typeof metric.delta === 'number' && Number.isFinite(metric.delta), `${label}.delta must be a finite number`)
  assert(metric.status === 'ok', `${label}.status must be ok`)
  assert(metric.thresholdOperator === '<=', `${label}.thresholdOperator must be <=`)
  assert(metric.thresholdField === 'delta', `${label}.thresholdField must be delta`)
  assert(metric.delta <= metric.threshold, `${label}.delta must not exceed threshold`)
}

function validateReleaseResourceSummary(summary, label) {
  assert(summary && typeof summary === 'object', `${label} missing`)
  assert(summary.status === 'ok', `${label}.status must be ok`)
  assert(Array.isArray(summary.metrics) && summary.metrics.length > 0, `${label}.metrics must be non-empty`)
  let okMetricCount = 0
  for (const [index, metric] of summary.metrics.entries()) {
    validateReleaseResourceMetric(metric, `${label}.metrics[${index}]`)
    okMetricCount += metric.status === 'ok' ? 1 : 0
  }
  assert(okMetricCount > 0, `${label} must include at least one passing resource metric`)
  const unavailableMetrics = Array.isArray(summary.unavailableMetrics) ? summary.unavailableMetrics : []
  for (const [index, metric] of unavailableMetrics.entries()) {
    assert(typeof metric.reason === 'string' && metric.reason.length > 0, `${label}.unavailableMetrics[${index}].reason missing`)
  }
}

function validateReleaseResourceBudgets() {
  for (const fileName of ['memory-leak-summary.json', 'open-handle-summary.json']) {
    const summary = readJson(`.tmp/release-evidence/${fileName}`, true)
    if (!summary) continue
    validateReleaseResourceSummary(summary, fileName)
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
  validateAedsFrameCostSummary(summary, aedsFrameCostPolicy(), expectedEvidenceCommit(), {
    requireAuthoritative: true,
    requireReleaseArtifacts: false,
    ...aedsArtifactContext({ allowDownloaded: true })
  })
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
  if (Array.isArray(summary.throughput) && Array.isArray(summary.tiers)) {
    validateTieredAedsDecodeBudget(summary)
    return
  }
  const budget = summary.decodeBudget ?? summary
  positiveNumber(budget.frameBytes, 'aeds-decode-budget.frameBytes')
  positiveNumber(budget.payloadBytes, 'aeds-decode-budget.payloadBytes')
  positiveNumber(budget.clientEnvelopeDecodeMs, 'aeds-decode-budget.clientEnvelopeDecodeMs')
  positiveNumber(budget.clientPayloadMapMs, 'aeds-decode-budget.clientPayloadMapMs')
  positiveNumber(budget.clientStructuredCloneMs, 'aeds-decode-budget.clientStructuredCloneMs')
  assert(budget.copyCount === 0, 'aeds-decode-budget.copyCount must be zero')
  assert(Number.isFinite(budget.allocBytesPerDecode) && budget.allocBytesPerDecode >= 0, 'aeds-decode-budget.allocBytesPerDecode must be >= 0')
}

function validateTieredAedsDecodeBudget(summary) {
  assert(summary.measurementSource === 'real-basic-speed-wasm-runtime', 'aeds-decode-budget.measurementSource must be real-basic-speed-wasm-runtime')
  assert(summary.throughput.length >= 3, 'aeds-decode-budget.throughput must contain at least three measured buckets')
  for (const sample of summary.throughput) {
    positiveInteger(sample.frameBytes, 'aeds-decode-budget.throughput.frameBytes')
    positiveNumber(sample.basicMBps, 'aeds-decode-budget.throughput.basicMBps')
    positiveNumber(sample.speedMBps, 'aeds-decode-budget.throughput.speedMBps')
    positiveNumber(sample.speedup, 'aeds-decode-budget.throughput.speedup')
  }
  const improvedBuckets = summary.throughput.filter((sample) => sample.speedup > 1).length
  const minimumImprovedBuckets = Number(summary.budgets?.minimumImprovedBuckets)
  assert(Number.isSafeInteger(minimumImprovedBuckets) && minimumImprovedBuckets >= 1, 'aeds-decode-budget.budgets.minimumImprovedBuckets must be a positive integer')
  assert(improvedBuckets >= minimumImprovedBuckets, 'aeds-decode-budget improved throughput bucket count is below budget')
  positiveNumber(summary.budgets?.minimumMedianSpeedup, 'aeds-decode-budget.budgets.minimumMedianSpeedup')
  positiveNumber(summary.budgets?.measuredMedianSpeedup, 'aeds-decode-budget.budgets.measuredMedianSpeedup')
  assert(summary.budgets.measuredMedianSpeedup >= summary.budgets.minimumMedianSpeedup, 'aeds-decode-budget measured median speedup is below budget')

  const tiers = new Map(summary.tiers.map((tier) => [tier.tier, tier]))
  assert(tiers.size === summary.tiers.length, 'aeds-decode-budget tiers must be unique')
  for (const tierName of ['basic', 'speed']) {
    const tier = tiers.get(tierName)
    assert(tier != null, `aeds-decode-budget tier ${tierName} is required`)
    positiveInteger(tier.artifact?.rawBytes, `aeds-decode-budget.${tierName}.artifact.rawBytes`)
    positiveInteger(tier.artifact?.gzipBytes, `aeds-decode-budget.${tierName}.artifact.gzipBytes`)
    positiveInteger(tier.artifact?.brotliBytes, `aeds-decode-budget.${tierName}.artifact.brotliBytes`)
    positiveNumber(tier.compileP95Ms, `aeds-decode-budget.${tierName}.compileP95Ms`)
    positiveInteger(tier.initialMemoryPages, `aeds-decode-budget.${tierName}.initialMemoryPages`)
    positiveInteger(tier.memoryPages, `aeds-decode-budget.${tierName}.memoryPages`)
    positiveInteger(tier.peakMemoryPages, `aeds-decode-budget.${tierName}.peakMemoryPages`)
    assert(tier.peakMemoryPages >= tier.initialMemoryPages, `aeds-decode-budget.${tierName}.peakMemoryPages must cover initial memory`)
    assert(Number.isSafeInteger(tier.growCount) && tier.growCount >= 0, `aeds-decode-budget.${tierName}.growCount must be non-negative`)
    positiveInteger(tier.arenaReallocationCount, `aeds-decode-budget.${tierName}.arenaReallocationCount`)
    positiveInteger(tier.arenaClearCount, `aeds-decode-budget.${tierName}.arenaClearCount`)
    assert(tier.sensitiveBytesCleared === true, `aeds-decode-budget.${tierName}.sensitiveBytesCleared must be true`)
    const copy = tier.copyBudget
    assert(copy?.measurementSource === 'executed-arena-and-owned-payload-copy', `aeds-decode-budget.${tierName}.copyBudget measurement source is invalid`)
    positiveInteger(copy.measuredDecodeCount, `aeds-decode-budget.${tierName}.copyBudget.measuredDecodeCount`)
    positiveInteger(copy.jsToWasmCopiedBytes, `aeds-decode-budget.${tierName}.copyBudget.jsToWasmCopiedBytes`)
    assert(copy.jsToWasmCopiedBytes === copy.expectedJsToWasmCopiedBytes, `aeds-decode-budget.${tierName} JS-to-Wasm copy evidence must match`)
    positiveInteger(copy.wasmToJsCopiedBytes, `aeds-decode-budget.${tierName}.copyBudget.wasmToJsCopiedBytes`)
    assert(copy.wasmToJsCopiedBytes === copy.expectedWasmToJsCopiedBytes, `aeds-decode-budget.${tierName} Wasm-to-JS copy evidence must match`)
    assert(copy.structuredCloneFullBufferCopies === 0, `aeds-decode-budget.${tierName} must not clone full buffers`)
    assert(tier.arenaReallocationCount < copy.measuredDecodeCount, `aeds-decode-budget.${tierName} must reuse its decode arena`)
  }
  const speed = tiers.get('speed')
  assert(
    speed.initialMemoryPages === 1024 && speed.memoryPages === 1024
      && speed.peakMemoryPages === 1024 && speed.growCount === 0,
    'aeds-decode-budget speed tier must keep fixed 1024-page memory'
  )
}

function selfTestRuntimeProbe() {
  return {
    measurementSource: 'runtime-http-probe',
    sampleCount: 1,
    rps: 1,
    bytes: 1,
    latencyMs: { p50: 1, p95: 1 },
    statusCounts: { 200: 1 },
    observabilityLevel: 'extended-runtime-evidence',
    extendedObservability: {
      status: 'complete',
      requiredCategories: requiredExtendedObservabilityCategories,
      categories: {
        managedRuntime: {
          status: 'ok',
          fields: {
            runtime: { status: 'ok', value: 'dotnet-10', unit: 'name', source: 'self-test' }
          },
          reason: null
        },
        threadOrConnection: {
          status: 'ok',
          fields: {
            configuredConcurrency: { status: 'ok', value: 1, unit: 'count', source: 'self-test' }
          },
          reason: null
        },
        storageOrCacheLatency: {
          status: 'ok',
          fields: {
            cacheBackedHttpP95: { status: 'ok', value: 1, unit: 'ms', source: 'self-test' }
          },
          reason: null
        }
      },
      reason: null
    }
  }
}

function main() {
  if (process.argv[2] === '--finalize-aeds-frame-cost') {
    const input = process.argv[3]
    const output = process.argv[4]
    assert(typeof input === 'string' && input.length > 0, '--finalize-aeds-frame-cost requires an input JSON file')
    assert(typeof output === 'string' && output.length > 0, '--finalize-aeds-frame-cost requires an output JSON file')
    const raw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), input), 'utf8'))
    const artifacts = aedsArtifactContext()
    const staged = stageAedsFrameCostArtifacts(raw, artifacts.artifactRoot)
    const finalized = finalizeAedsFrameCostSummary(staged, aedsFrameCostPolicy(), expectedEvidenceCommit(), {
      ...artifacts,
      requireReleaseArtifacts: true
    })
    const outputFile = path.resolve(process.cwd(), output)
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
    fs.writeFileSync(outputFile, `${JSON.stringify(finalized, null, 2)}\n`)
    console.log(`[evidence-metrics] finalized AEDS frame-cost ${finalized.overallConclusion} -> ${outputFile}`)
    return
  }
  if (process.argv[2] === '--validate-aeds-frame-cost') {
    const input = process.argv[3]
    assert(typeof input === 'string' && input.length > 0, '--validate-aeds-frame-cost requires a JSON file')
    const summary = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), input), 'utf8'))
    validateAedsFrameCostSummary(summary, aedsFrameCostPolicy(), expectedEvidenceCommit(), {
      requireAuthoritative: !process.argv.includes('--allow-non-authoritative'),
      requireReleaseArtifacts: !process.argv.includes('--allow-artifact-snapshot'),
      ...aedsArtifactContext({ allowDownloaded: process.argv.includes('--allow-artifact-snapshot') })
    })
    console.log(`[evidence-metrics] AEDS frame-cost ${summary.overallConclusion} validated`)
    return
  }
  if (process.argv[2] === '--validate-runtime-probe') {
    const input = process.argv[3]
    assert(typeof input === 'string' && input.length > 0, '--validate-runtime-probe requires a JSON file')
    const resolved = path.resolve(process.cwd(), input)
    const probe = JSON.parse(fs.readFileSync(resolved, 'utf8'))
    validateRuntimeProbe(probe, 'runtime-probe-contract')
    console.log(JSON.stringify({
      schema: 'fsusblog.runtime-probe-validation.v1',
      status: 'ok',
      observabilityLevel: probe.observabilityLevel,
      requiredCategories: probe.extendedObservability.requiredCategories
    }))
    return
  }
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  validateBackendQps()
  validateBackendQpsSequential()
  validateDataScale()
  validateLoadProfiles()
  validateFaultInjection()
  validateSoak()
  validateReleaseResourceBudgets()
  validateCoverage()
  validateEndpointDepth()
  validateAedsFrameCost()
  validateAedsCompressionProfile()
  validateAedsDecodeBudget()
  console.log('[evidence-metrics] ok')
}

function runSelfTest() {
  const tierFixture = (tier, memoryPages) => ({
    tier,
    artifact: { rawBytes: 100, gzipBytes: 80, brotliBytes: 70 },
    compileP95Ms: 1,
    initialMemoryPages: memoryPages,
    memoryPages,
    peakMemoryPages: memoryPages,
    growCount: 0,
    arenaReallocationCount: 2,
    arenaClearCount: 10,
    sensitiveBytesCleared: true,
    copyBudget: {
      measurementSource: 'executed-arena-and-owned-payload-copy',
      measuredDecodeCount: 10,
      jsToWasmCopiedBytes: 1000,
      expectedJsToWasmCopiedBytes: 1000,
      wasmToJsCopiedBytes: 900,
      expectedWasmToJsCopiedBytes: 900,
      structuredCloneFullBufferCopies: 0
    }
  })
  const tieredDecodeBudget = {
    status: 'ok',
    measurementSource: 'real-basic-speed-wasm-runtime',
    budgets: {
      minimumMedianSpeedup: 1.05,
      minimumImprovedBuckets: 2,
      measuredMedianSpeedup: 1.2
    },
    throughput: [4096, 65536, 1048576].map((frameBytes, index) => ({
      frameBytes,
      basicMBps: 100 + index,
      speedMBps: 120 + index,
      speedup: 1.2
    })),
    tiers: [tierFixture('basic', 256), tierFixture('speed', 1024)]
  }
  validateTieredAedsDecodeBudget(tieredDecodeBudget)
  let regressedTieredDecodeBudgetFailedAsExpected = false
  try {
    const regressed = structuredClone(tieredDecodeBudget)
    regressed.tiers[1].copyBudget.structuredCloneFullBufferCopies = 1
    validateTieredAedsDecodeBudget(regressed)
  } catch {
    regressedTieredDecodeBudgetFailedAsExpected = true
  }
  assert(regressedTieredDecodeBudgetFailedAsExpected, 'self-test tiered AEDS decode budget must reject full-buffer clones')

  let missingLoadPolicyFailedAsExpected = false
  try {
    validateLoadProfileSummary({
      status: 'ok',
      profile: 'baseline',
      metrics: { rps: 1, p95Ms: 1 },
      runtime: selfTestRuntimeProbe()
    }, 'load-profile-self-test')
  } catch {
    missingLoadPolicyFailedAsExpected = true
  }
  assert(missingLoadPolicyFailedAsExpected, 'self-test load profile missing policy metadata must fail')

  let missingLoadThresholdFailedAsExpected = false
  try {
    validateLoadProfileSummary({
      status: 'ok',
      profile: 'baseline',
      profileName: 'baseline',
      policy: { file: perfPolicyRelativeFile, version: 'fsusblog-perf-policy-v1' },
      declared: { concurrency: 10, rounds: 6, durationMs: 30000 },
      effective: { concurrency: 10, rounds: 6, durationMs: 30000 },
      overrideSource: 'policy',
      overrideSources: { concurrency: 'policy', rounds: 'policy', durationMs: 'policy' },
      sampling: { totalRequests: 60 },
      metrics: { rps: 1, p95Ms: 1 },
      runtime: selfTestRuntimeProbe()
    }, 'load-profile-threshold-self-test')
  } catch {
    missingLoadThresholdFailedAsExpected = true
  }
  assert(missingLoadThresholdFailedAsExpected, 'self-test load profile missing threshold metadata must fail')

  validateLoadProfileSummary({
    status: 'ok',
    profile: 'baseline',
    profileName: 'baseline',
    policy: { file: perfPolicyRelativeFile, version: 'fsusblog-perf-policy-v1' },
    declared: { concurrency: 10, rounds: 6, durationMs: 30000 },
    effective: { concurrency: 2, rounds: 3, durationMs: 1000 },
    thresholds: { maxP95Ms: 2500, maxP99Ms: 5000, maxErrorRate: 0, maxTimeoutRate: 0, minRps: 1 },
    thresholdEvaluation: {
      status: 'pass',
      checks: [
        { metric: 'p95Ms', actual: 1, operator: '<=', threshold: 2500, status: 'pass' },
        { metric: 'p99Ms', actual: 1, operator: '<=', threshold: 5000, status: 'pass' },
        { metric: 'errorRate', actual: 0, operator: '<=', threshold: 0, status: 'pass' },
        { metric: 'timeoutRate', actual: 0, operator: '<=', threshold: 0, status: 'pass' },
        { metric: 'rps', actual: 1, operator: '>=', threshold: 1, status: 'pass' }
      ]
    },
    overrideSource: 'env',
    overrideSources: {
      concurrency: 'env:FSUSBLOG_LOAD_PROFILE_CONCURRENCY',
      rounds: 'env:FSUSBLOG_LOAD_PROFILE_ROUNDS',
      durationMs: 'env:FSUSBLOG_LOAD_PROFILE_DURATION_MS'
    },
    sampling: { totalRequests: 6 },
    metrics: { rps: 1, p95Ms: 1, p99Ms: 1, errorRate: 0, timeoutRate: 0 },
    runtime: selfTestRuntimeProbe()
  }, 'load-profile-self-test-valid')

  const soakSummaryFile = path.join(root, '.tmp/soak/short/summary.json')
  const previousSoakSummary = fs.existsSync(soakSummaryFile)
    ? fs.readFileSync(soakSummaryFile, 'utf8')
    : null
  fs.mkdirSync(path.dirname(soakSummaryFile), { recursive: true })
  fs.writeFileSync(soakSummaryFile, JSON.stringify({
    status: 'ok',
    mode: 'short',
    durationSeconds: 1,
    sampleCount: 1,
    latencyMs: { p95: 1, p99: 1 },
    errorRate: 0
  }))
  let shortSoakMissingResourceFailedAsExpected = false
  try {
    validateSoak()
  } catch {
    shortSoakMissingResourceFailedAsExpected = true
  } finally {
    if (previousSoakSummary === null) {
      fs.rmSync(soakSummaryFile, { force: true })
    } else {
      fs.writeFileSync(soakSummaryFile, previousSoakSummary)
    }
  }
  assert(shortSoakMissingResourceFailedAsExpected, 'self-test short soak missing resource evidence must fail')

  let emptyResourceMetricsFailedAsExpected = false
  try {
    validateReleaseResourceSummary({
      status: 'ok',
      metrics: []
    }, 'release-resource-empty-self-test')
  } catch {
    emptyResourceMetricsFailedAsExpected = true
  }
  assert(emptyResourceMetricsFailedAsExpected, 'self-test empty release resource metrics must fail')

  let thresholdResourceMetricsFailedAsExpected = false
  try {
    validateReleaseResourceSummary({
      status: 'ok',
      metrics: [{
        name: 'backend_rss_bytes',
        startValue: 100,
        endValue: 180,
        maxValue: 180,
        delta: 80,
        threshold: 64,
        thresholdOperator: '<=',
        thresholdField: 'delta',
        status: 'ok'
      }]
    }, 'release-resource-threshold-self-test')
  } catch {
    thresholdResourceMetricsFailedAsExpected = true
  }
  assert(thresholdResourceMetricsFailedAsExpected, 'self-test threshold-exceeding release resource metric must fail')

  validateReleaseResourceSummary({
    status: 'ok',
    metrics: [{
      name: 'backend_rss_bytes',
      startValue: 100,
      endValue: 104,
      maxValue: 104,
      delta: 4,
      threshold: 64,
      thresholdOperator: '<=',
      thresholdField: 'delta',
      status: 'ok'
    }],
    unavailableMetrics: []
  }, 'release-resource-valid-self-test')

  const dataScaleSummaryFile = path.join(root, '.tmp/release-evidence/data-scale-summary.json')
  const previousDataScaleSummary = fs.existsSync(dataScaleSummaryFile)
    ? fs.readFileSync(dataScaleSummaryFile, 'utf8')
    : null
  fs.mkdirSync(path.dirname(dataScaleSummaryFile), { recursive: true })
  try {
    fs.writeFileSync(dataScaleSummaryFile, `${JSON.stringify({
      status: 'ok',
      tier: 'scale-s',
      expectedSeed: { articles: 100, comments: 1000 },
      seed: {
        status: 'ok',
        declared: { articles: 100, comments: 1000 },
        expected: { articles: 100, comments: 1000 },
        observed: { articles: 100, comments: 1000 }
      },
      observed: {
        status: 'ok',
        expected: {
          articles: 100,
          comments: 1000,
          categoriesAtLeast: 4,
          tagsAtLeast: 8,
          rootComments: 500,
          nestedComments: 500
        },
        observed: {
          articles: 100,
          comments: 1000,
          categories: 4,
          tags: 8,
          rootComments: 500,
          nestedComments: 500
        },
        categoryDistribution: {
          status: 'ok',
          totalArticles: 100,
          buckets: [{ categoryId: 1, articleCount: 100 }]
        },
        tagDistribution: {
          status: 'ok',
          totalArticleTags: 100,
          buckets: [{ tagId: 1, articleCount: 100 }]
        },
        seedManifest: {
          declared: { articles: 100, comments: 1000 },
          observed: { articles: 100, comments: 1000 }
        },
        db: {
          articleRows: 100,
          commentRows: 1000,
          countsMatch: true
        },
        search: { status: 'unknown' },
        aot: { status: 'unknown' },
        hotRead: {
          status: 'ok',
          artifactSampleCount: 1,
          sampleBytes: 1
        },
        runtime: selfTestRuntimeProbe(),
        latencyMs: { p95: 1 }
      },
      cleanup: {
        status: 'ok',
        remaining: { articles: 0, comments: 0 },
        search: { residualCount: 0 },
        artifacts: { residualCount: 0 },
        durationMs: 0
      }
    }, null, 2)}\n`)

    let missingSearchArtifactFailedAsExpected = false
    try {
      validateDataScaleTierSummary(JSON.parse(fs.readFileSync(dataScaleSummaryFile, 'utf8')))
    } catch {
      missingSearchArtifactFailedAsExpected = true
    }
    assert(missingSearchArtifactFailedAsExpected, 'self-test data-scale unknown search/artifact fixture must fail')
  } finally {
    if (previousDataScaleSummary === null) {
      fs.rmSync(dataScaleSummaryFile, { force: true })
    } else {
      fs.writeFileSync(dataScaleSummaryFile, previousDataScaleSummary)
    }
  }

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
  let missingDiskArtifactFailedAsExpected = false
  try {
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
  } catch {
    missingDiskArtifactFailedAsExpected = true
  }
  assert(missingDiskArtifactFailedAsExpected, 'self-test missing disk artifact storage fixture must fail')
  validateFaultInjectionSummary({
    status: 'ok',
    caseCount: 9,
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
      },
      {
        case: 'disk-artifact-storage-write-failure',
        status: 'completed',
        actionStatus: 'executed',
        actionStartedAt: '2026-06-18T00:04:00Z',
        actionCompletedAt: '2026-06-18T00:04:10Z',
        targetPath: '.tmp/fault-injection-storage/fixture/artifact-target/probe-artifact.json',
        expectedErrorClassification: 'EACCES|EPERM|ENOSPC|EROFS',
        recoveryDurationMs: 100,
        recoveryTimeMs: 100,
        writeFailureResult: { status: 'expected-error', code: 'EACCES', targetPath: '.tmp/fault-injection-storage/fixture/artifact-target/probe-artifact.json' },
        recoveryResult: { status: 'completed', targetPath: '.tmp/fault-injection-storage/fixture/artifact-target/recovered-artifact.json', bytesWritten: 9 },
        cleanupResult: { status: 'completed', targetPath: '.tmp/fault-injection-storage/fixture' },
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
