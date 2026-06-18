#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const requiredRedisFaultCases = ['redis-restart', 'redis-reconnect', 'redis-latency']
const requiredPostgresFaultCases = ['postgres-readiness', 'postgres-reconnect', 'postgres-lock-timeout']
const requiredNotificationFaultCases = ['notification-stream-slow-consumer']
const requiredGracefulShutdownFaultCases = ['graceful-shutdown']
const requiredDiskArtifactFaultCases = ['disk-artifact-storage-write-failure']

const requiredStatusChecks = [
  ['image digest', (manifest) => manifest.evidenceSummary?.image?.status === 'present'],
  ['coverage', (manifest) => manifest.evidenceSummary?.coverage?.status === 'ok'],
  ['ZAP DAST', (manifest) => manifest.evidenceSummary?.security?.dastZap === 'ok'],
  ['authenticated DAST', (manifest, context) => manifest.evidenceSummary?.security?.authenticatedDast === 'ok' && authenticatedDastOk(manifest, context)],
  ['Wasm fuzz', (manifest, context) => manifest.evidenceSummary?.security?.wasmFuzz === 'ok' && wasmFuzzOk(manifest, context)],
  ['attack matrix', (manifest) => manifest.evidenceSummary?.security?.attackMatrix === 'ok'],
  ['permission matrix', (manifest) => manifest.evidenceSummary?.security?.permissionMatrix === 'ok'],
  ['supply chain', (manifest) => manifest.evidenceSummary?.security?.supplyChain === 'ok'],
  ['SBOM', (manifest) => manifest.evidenceSummary?.security?.sbom === 'ok'],
  ['post deploy smoke', (manifest, context) => manifest.evidenceSummary?.operations?.postDeploySmoke === 'ok' && postDeploySmokeOk(manifest, context)],
  ['backup restore drill', (manifest, context) => manifest.evidenceSummary?.operations?.backupRestoreDrill === 'ok' && backupRestoreDrillOk(manifest, context)],
  ['SLO alert replay', (manifest) => manifest.evidenceSummary?.operations?.sloAlerts === 'ok'],
  ['critical SLO alerts', (manifest) => Number(manifest.evidenceSummary?.operations?.sloCriticalFiring ?? 0) === 0],
  ['fault injection', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.faultInjection === 'ok' && faultInjectionOk(manifest, context)],
  ['short soak', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.soak === 'ok' && shortSoakOk(manifest, context)],
  ['memory leak resource budget', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.memoryLeak === 'ok' && releaseResourceSummaryOk(manifest, context, 'memoryLeakSummary')],
  ['open handle resource budget', (manifest, context) => manifest.evidenceSummary?.resilienceDepth?.openHandle === 'ok' && releaseResourceSummaryOk(manifest, context, 'openHandleSummary')],
  ['production status', (manifest) => manifest.evidenceSummary?.externalExposure?.status === 'ok'],
  ['firewall policy', (manifest) => manifest.evidenceSummary?.externalExposure?.firewallPolicy === 'present'],
  ['DNS readiness', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsReadiness === 'ok'],
  ['DNS delegation', (manifest) => manifest.evidenceSummary?.externalExposure?.dnsDelegation === 'ok'],
  ['live exposure', (manifest) => manifest.evidenceSummary?.externalExposure?.liveExposure === 'ok'],
  ['frontend render pressure', (manifest) => manifest.evidenceSummary?.gates?.frontendRenderPressure === 'ok'],
  ['public AOT cache resilience', (manifest, context) => manifest.evidenceSummary?.gates?.publicAotCacheResilience === 'success' && publicAotCacheResilienceOk(manifest, context)],
  ['public hydration sidecar', (manifest, context) => manifest.evidenceSummary?.gates?.publicHydrationSidecar === 'success' && publicHydrationSidecarOk(manifest, context)],
  ['doc sync', (manifest) => manifest.evidenceSummary?.gates?.docSync === 'ok']
]

const requiredArtifacts = [
  'attackMatrix',
  'permissionMatrix',
  'dastZap',
  'authenticatedDast',
  'fuzz',
  'supplyChain',
  'sbom',
  'postDeploySmoke',
  'backupRestoreDrill',
  'coverage',
  'jobSummaries',
  'uxViewportSummary',
  'frontendRenderPressureSummary',
  'aotCacheResilienceSummary',
  'publicHydrationSidecarSummary',
  'publishArtifactsSummary',
  'docSyncSummary',
  'domBudgetSummary',
  'routeRenderPressureSummary',
  'markdownRenderBudgetSummary',
  'domDepthStaticSummary',
  'productionExposureStatus',
  'productionExposureLive',
  'firewallPolicy',
  'dnsReadiness',
  'dnsDelegation',
  'faultInjection',
  'soak',
  'memoryLeakSummary',
  'openHandleSummary'
]

function fail(message) {
  console.error(`[release-manifest-check] ${message}`)
  process.exit(1)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function artifactPath(manifest, manifestPath, key) {
  const artifact = manifest.artifacts?.[key]
  if (!artifact || artifact === 'null' || !manifestPath) return null
  return path.resolve(path.dirname(manifestPath), artifact)
}

function readArtifactJson(manifest, context, key, relative = null) {
  const base = artifactPath(manifest, context.manifestPath, key)
  if (!base) return null
  const file = relative ? path.join(base, relative) : base
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null
  try {
    return readJson(file)
  } catch {
    return null
  }
}

function includesAll(values, required) {
  const set = new Set(Array.isArray(values) ? values : [])
  return required.every((value) => set.has(value))
}

function backupRestoreDrillOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'backupRestoreDrill')
  return report?.status === 'ok'
    && report.mode === 'real'
    && report.timings?.rpoSeconds !== null
    && report.timings?.rtoSeconds !== null
    && includesAll(report.checks, [
      'postgres-restore:ok',
      'redis-restore:ok',
      'webroot-artifact-restore:ok',
      'restored-backend-start:ok',
      'public-page:ok',
      'binary-api:ok',
      'search-index:ok',
      'notification-stream-live:ok',
      'admin-login:ok'
    ])
}

function postDeploySmokeOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'postDeploySmoke')
  return report?.status === 'ok'
    && report.dryRun === false
    && Array.isArray(report.blockers)
    && report.blockers.length === 0
    && includesAll(report.verifiedCoverage, [
      'anonymous-public',
      'feed-rss',
      'feed-atom',
      'feed-json',
      'sitemap',
      'robots',
      'health-live',
      'health-ready'
    ])
}

function authenticatedDastOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'authenticatedDast', 'summary.json')
  return report?.status === 'ok' && report.activeScan?.executed === true
}

function wasmFuzzOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'fuzz', 'wasm/summary.json')
  return report?.status === 'ok' && Number(report.seedsRun ?? 0) > 0
}

function faultInjectionOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'faultInjection', 'summary.json')
  return report?.status === 'ok'
    && Number(report.caseCount ?? 0) > 0
    && Array.isArray(report.cases)
    && includesAll(report.cases.map((item) => item.case), requiredRedisFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredPostgresFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredNotificationFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredGracefulShutdownFaultCases)
    && includesAll(report.cases.map((item) => item.case), requiredDiskArtifactFaultCases)
    && report.cases.every((item) => item.status === 'completed' && item.actionStatus === 'executed')
    && report.cases
      .filter((item) => requiredRedisFaultCases.includes(item.case))
      .every(redisFaultCaseOk)
    && report.cases
      .filter((item) => requiredPostgresFaultCases.includes(item.case))
      .every(postgresFaultCaseOk)
    && report.cases
      .filter((item) => requiredNotificationFaultCases.includes(item.case))
      .every(notificationFaultCaseOk)
    && report.cases
      .filter((item) => requiredGracefulShutdownFaultCases.includes(item.case))
      .every(gracefulShutdownFaultCaseOk)
    && report.cases
      .filter((item) => requiredDiskArtifactFaultCases.includes(item.case))
      .every(diskArtifactFaultCaseOk)
}

function redisFaultCaseOk(item) {
  return typeof item.actionStartedAt === 'string'
    && item.actionStartedAt.length > 0
    && typeof item.actionCompletedAt === 'string'
    && item.actionCompletedAt.length > 0
    && Number(item.unavailableDurationMs ?? -1) >= 0
    && Number(item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.publicReadResult?.status === 'completed'
    && Number(item.publicReadResult?.sampleCount ?? 0) > 0
    && item.finalHealthStatus === 'healthy'
    && typeof item.authenticatedImpact?.status === 'string'
    && typeof item.notificationStreamImpact?.status === 'string'
}

function postgresFaultCaseOk(item) {
  return typeof item.actionStartedAt === 'string'
    && item.actionStartedAt.length > 0
    && typeof item.actionCompletedAt === 'string'
    && item.actionCompletedAt.length > 0
    && typeof item.affectedEndpoint === 'string'
    && item.affectedEndpoint.length > 0
    && Number(item.unavailableDurationMs ?? -1) >= 0
    && Number(item.dbReconnectDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.publicReadRecoveryResult?.status === 'completed'
    && Number(item.publicReadRecoveryResult?.sampleCount ?? 0) > 0
    && typeof item.writePathRollbackResult?.status === 'string'
    && !['failed', 'scheduled', 'observed-only'].includes(item.writePathRollbackResult.status)
    && item.finalHealthStatus === 'healthy'
}

function notificationFaultCaseOk(item) {
  return Number(item.connectionCount ?? 0) > 0
    && Number(item.heartbeatFrameCount ?? 0) > 0
    && Number(item.businessFrameCount ?? 0) > 0
    && Number(item.deliveredFrameCount ?? 0) > 0
    && Number(item.droppedOrBackpressuredCount ?? 0) > 0
    && item.reconnectSuccess === true
    && Number(item.replayedEventCount ?? 0) > 0
    && item.closeObserved === true
    && Array.isArray(item.eventIds)
    && item.eventIds.length > 0
    && item.eventIds.every((eventId) => Number(eventId) > 0)
    && typeof item.routeKey === 'string'
    && item.routeKey.length > 0
    && typeof item.slowConsumerPolicy === 'string'
    && item.slowConsumerPolicy.length > 0
    && item.finalHealthStatus === 'healthy'
}

function gracefulShutdownFaultCaseOk(item) {
  return typeof item.shutdownRequestedAt === 'string'
    && item.shutdownRequestedAt.length > 0
    && item.processStopResult?.status === 'stopped'
    && Number(item.drainDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && Number(item.restartRecoveryDurationMs ?? item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.livenessBefore?.status === 'completed'
    && item.livenessDuringShutdown?.status === 'unavailable'
    && item.notificationCloseObserved === true
    && Number.isFinite(Number(item.notificationCloseCode))
    && item.notificationReconnectSuccess === true
    && item.publicReadRecoveryResult?.status === 'completed'
    && Number(item.publicReadRecoveryResult?.sampleCount ?? 0) > 0
    && item.basicAuthRecoveryResult?.status === 'completed'
    && Number(item.basicAuthRecoveryResult?.sampleCount ?? 0) > 0
    && item.backgroundWorkerState?.status === 'clean'
    && item.finalHealthStatus === 'healthy'
}

function diskArtifactFaultCaseOk(item) {
  return typeof item.targetPath === 'string'
    && item.targetPath.length > 0
    && typeof item.expectedErrorClassification === 'string'
    && item.expectedErrorClassification.length > 0
    && item.writeFailureResult?.status === 'expected-error'
    && item.recoveryResult?.status === 'completed'
    && item.cleanupResult?.status === 'completed'
    && Number(item.recoveryDurationMs ?? item.recoveryTimeMs ?? 0) > 0
    && item.finalHealthStatus === 'healthy'
}

function shortSoakOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'soak', 'short/summary.json')
  return report?.status === 'ok'
    && report.mode === 'short'
    && Number(report.durationSeconds ?? 0) > 0
    && Number(report.sampleCount ?? 0) > 0
    && Number(report.latencyMs?.p95 ?? 0) > 0
}

function releaseResourceSummaryOk(manifest, context, artifactKey) {
  const report = readArtifactJson(manifest, context, artifactKey)
  const metrics = Array.isArray(report?.metrics) ? report.metrics : []
  return report?.status === 'ok'
    && metrics.length > 0
    && metrics.some((metric) => metric?.status === 'ok')
    && metrics.every((metric) =>
      typeof metric?.name === 'string'
        && metric.name.length > 0
        && Number.isFinite(metric.startValue)
        && Number.isFinite(metric.endValue)
        && Number.isFinite(metric.maxValue)
        && Number.isFinite(metric.delta)
        && Number.isFinite(metric.threshold)
        && metric.status === 'ok'
        && metric.thresholdOperator === '<='
        && metric.thresholdField === 'delta'
        && metric.delta <= metric.threshold)
}

function publicHydrationSidecarOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'publicHydrationSidecarSummary')
  const requiredKinds = ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright']
  return report?.schema === 'fsusblog.public-hydration-sidecar-smoke.v1'
    && report.status === 'success'
    && includesAll(report.requiredPageKinds, requiredKinds)
    && Array.isArray(report.missingRequiredKinds)
    && report.missingRequiredKinds.length === 0
    && Number(report.modeCounts?.['sidecar-primary'] ?? 0) >= requiredKinds.length
    && Object.hasOwn(report.modeCounts ?? {}, 'inline-fallback')
    && report.canary?.status === 'success'
    && Array.isArray(report.checks)
    && requiredKinds.every((kind) => report.checks.some((check) =>
      check.status === 'success'
        && check.expectedPageKind === kind
        && check.pageKind === kind
        && check.mode === 'sidecar-primary'))
}

function publicAotCacheResilienceOk(manifest, context) {
  const report = readArtifactJson(manifest, context, 'aotCacheResilienceSummary')
  const requiredCases = [
    'corrupt-document',
    'invalid-document-bytes',
    'missing-sidecar',
    'corrupt-sidecar',
    'old-asset-version',
    'html-payload-mismatch',
    'sw-stale-cache-poisoning'
  ]

  if (report?.schema !== 'fsusblog.public-aot-cache-resilience.v1' ||
    report.status !== 'success' ||
    report.placeholderOnly === true ||
    !Array.isArray(report.cases) ||
    !includesAll(report.cases.map((item) => item?.name), requiredCases)) {
    return false
  }

  return report.cases.every((item) => item?.status === 'success'
    && typeof item.route === 'string'
    && item.route.length > 0
    && typeof item.initialState === 'string'
    && typeof item.mutation === 'string'
    && item.mutation.length > 0
    && typeof item.observedState === 'string'
    && item.mutationVerified === true
    && item.recovered === true
    && Number(item.durationMs ?? -1) >= 0
    && Array.isArray(item.errors)
    && item.errors.length === 0)
}

function latestManifest() {
  const baseDir = path.join(rootDir, '.tmp', 'release-evidence')
  if (!fs.existsSync(baseDir)) {
    return null
  }

  const candidates = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name, 'manifest.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return candidates[0]?.file ?? null
}

function validateManifest(manifest, options = {}) {
  const context = { manifestPath: options.manifestPath ?? null }
  const errors = []
  if (!['collected-ok', 'collected-blocked'].includes(manifest.status)) {
    errors.push(`invalid status: ${String(manifest.status)}`)
  }

  if (!manifest.commitSha || !/^(unknown|[0-9a-f]{40})$/i.test(manifest.commitSha)) {
    errors.push('commitSha must be a full 40-character SHA or unknown')
  }

  if (!manifest.workflowRun || typeof manifest.workflowRun !== 'object') {
    errors.push('workflowRun object is required')
  }

  for (const key of requiredArtifacts) {
    if (!Object.hasOwn(manifest.artifacts ?? {}, key)) {
      errors.push(`artifacts.${key} is missing`)
    }
  }

  const missingRequired = requiredStatusChecks
    .filter(([, predicate]) => !predicate(manifest, context))
    .map(([label]) => label)

  if (missingRequired.length > 0 && manifest.status !== 'collected-blocked') {
    errors.push(`manifest must be collected-blocked when required evidence is missing or blocked: ${missingRequired.join(', ')}`)
  }

  if (missingRequired.length === 0 && manifest.status !== 'collected-ok') {
    errors.push('manifest must be collected-ok when every required evidence component is ok')
  }

  if (options.requireOk && manifest.status !== 'collected-ok') {
    errors.push(`release closeout requires collected-ok, got ${manifest.status}`)
  }

  for (const key of ['frontendRenderPressureSummary', 'aotCacheResilienceSummary', 'publicHydrationSidecarSummary', 'docSyncSummary', 'domBudgetSummary', 'routeRenderPressureSummary', 'markdownRenderBudgetSummary', 'domDepthStaticSummary']) {
    if (manifest.artifacts?.[key] === null || manifest.artifacts?.[key] === undefined) {
      errors.push(`artifacts.${key} must point to a collected required summary`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    missingRequired
  }
}

function runSelfTest() {
  const base = {
    status: 'collected-ok',
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    workflowRun: { id: '123', attempt: '1', workflow: 'Quality Gate' },
    imageDigest: 'sha256:abc',
    artifacts: Object.fromEntries(requiredArtifacts.map((key) => [key, `${key}.json`])),
    evidenceSummary: {
      image: { status: 'present' },
      coverage: { status: 'ok' },
      operations: {
        postDeploySmoke: 'ok',
        backupRestoreDrill: 'ok',
        sloAlerts: 'ok',
        sloCriticalFiring: 0
      },
      security: {
        dastZap: 'ok',
        authenticatedDast: 'ok',
        attackMatrix: 'ok',
        permissionMatrix: 'ok',
        supplyChain: 'ok',
        sbom: 'ok',
        wasmFuzz: 'ok'
      },
      gates: {
        frontendRenderPressure: 'ok',
        publicAotCacheResilience: 'success',
        publicHydrationSidecar: 'success',
        docSync: 'ok'
      },
      resilienceDepth: {
        faultInjection: 'ok',
        soak: 'ok',
        memoryLeak: 'ok',
        openHandle: 'ok'
      },
      externalExposure: {
        status: 'ok',
        firewallPolicy: 'present',
        dnsReadiness: 'ok',
        dnsDelegation: 'ok',
        liveExposure: 'ok'
      }
    }
  }
  base.artifacts.authenticatedDast = 'authenticatedDast'
  base.artifacts.fuzz = 'fuzz'
  base.artifacts.faultInjection = 'faultInjection'
  base.artifacts.soak = 'soak'
  base.artifacts.memoryLeakSummary = 'memoryLeakSummary.json'
  base.artifacts.openHandleSummary = 'openHandleSummary.json'

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-release-manifest-'))
  const manifestFile = path.join(tmpDir, 'manifest.json')
  fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
    status: 'ok',
    mode: 'real',
    timings: { rpoSeconds: 1, rtoSeconds: 1 },
    checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
  }))
  fs.writeFileSync(path.join(tmpDir, 'postDeploySmoke.json'), JSON.stringify({
    status: 'ok',
    dryRun: false,
    verifiedCoverage: ['anonymous-public', 'feed-rss', 'feed-atom', 'feed-json', 'sitemap', 'robots', 'health-live', 'health-ready'],
    blockers: []
  }))
  fs.writeFileSync(path.join(tmpDir, 'publicHydrationSidecarSummary.json'), JSON.stringify({
    schema: 'fsusblog.public-hydration-sidecar-smoke.v1',
    status: 'success',
    requiredPageKinds: ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'],
    missingRequiredKinds: [],
    modeCounts: { 'sidecar-primary': 8, 'inline-fallback': 0 },
    canary: { status: 'success' },
    checks: ['Home', 'ArticleDetail', 'Archive', 'Filter', 'About', 'Privacy', 'Guidelines', 'Copyright'].map((kind) => ({
      status: 'success',
      expectedPageKind: kind,
      pageKind: kind,
      mode: 'sidecar-primary'
    }))
  }))
  fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
    schema: 'fsusblog.public-aot-cache-resilience.v1',
    status: 'success',
    gitSha: 'fixture',
    rendererVersion: 'fixture',
    placeholderOnly: false,
    cases: [
      'corrupt-document',
      'invalid-document-bytes',
      'missing-sidecar',
      'corrupt-sidecar',
      'old-asset-version',
      'html-payload-mismatch',
      'sw-stale-cache-poisoning'
    ].map((name) => ({
      name,
      route: '/article/1',
      status: 'success',
      initialState: 'fresh',
      mutation: `fixture-${name}`,
      mutationVerified: true,
      observedState: name === 'old-asset-version' ? 'stale' : 'fallback',
      recovered: true,
      durationMs: 1,
      errors: []
    }))
  }))
  fs.mkdirSync(path.join(tmpDir, 'authenticatedDast'))
  fs.writeFileSync(path.join(tmpDir, 'authenticatedDast', 'summary.json'), JSON.stringify({ status: 'ok', activeScan: { executed: true } }))
  fs.mkdirSync(path.join(tmpDir, 'fuzz', 'wasm'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'fuzz', 'wasm', 'summary.json'), JSON.stringify({ status: 'ok', seedsRun: 1 }))
  fs.mkdirSync(path.join(tmpDir, 'faultInjection'))
  const redisFaultFixtureCases = requiredRedisFaultCases.map((caseName, index) => ({
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
  }))
  const postgresFaultFixtureCases = requiredPostgresFaultCases.map((caseName, index) => ({
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
  const notificationFaultFixtureCase = {
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
  fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
    status: 'ok',
    caseCount: 6,
    cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases]
  }))
  const missingNotificationFault = validateManifest(base, { manifestPath: manifestFile })
  if (missingNotificationFault.ok || !missingNotificationFault.missingRequired.includes('fault injection')) {
    fail('self-test expected missing notification slow-consumer fault case to block release closeout')
  }
  fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
    status: 'ok',
    caseCount: 7,
    cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases, notificationFaultFixtureCase]
  }))
  const missingGracefulShutdownFault = validateManifest(base, { manifestPath: manifestFile })
  if (missingGracefulShutdownFault.ok || !missingGracefulShutdownFault.missingRequired.includes('fault injection')) {
    fail('self-test expected missing graceful shutdown fault case to block release closeout')
  }
  const gracefulShutdownFaultFixtureCase = {
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
  fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
    status: 'ok',
    caseCount: 8,
    cases: [...redisFaultFixtureCases, ...postgresFaultFixtureCases, notificationFaultFixtureCase, gracefulShutdownFaultFixtureCase]
  }))
  const missingDiskArtifactFault = validateManifest(base, { manifestPath: manifestFile })
  if (missingDiskArtifactFault.ok || !missingDiskArtifactFault.missingRequired.includes('fault injection')) {
    fail('self-test expected missing disk artifact storage fault case to block release closeout')
  }
  const diskArtifactFaultFixtureCase = {
    case: 'disk-artifact-storage-write-failure',
    status: 'completed',
    actionStatus: 'executed',
    actionStartedAt: '2026-06-18T00:04:00Z',
    actionCompletedAt: '2026-06-18T00:04:10Z',
    targetPath: '.tmp/fault-injection-storage/fixture/artifact-target',
    expectedErrorClassification: 'EACCES',
    recoveryDurationMs: 100,
    recoveryTimeMs: 100,
    writeFailureResult: { status: 'expected-error', code: 'EACCES' },
    recoveryResult: { status: 'completed', bytesWritten: 9 },
    cleanupResult: { status: 'completed' },
    finalHealthStatus: 'healthy'
  }
  fs.writeFileSync(path.join(tmpDir, 'faultInjection', 'summary.json'), JSON.stringify({
    status: 'ok',
    caseCount: 9,
    cases: [
      ...redisFaultFixtureCases,
      ...postgresFaultFixtureCases,
      notificationFaultFixtureCase,
      gracefulShutdownFaultFixtureCase,
      diskArtifactFaultFixtureCase
    ]
  }))
  fs.mkdirSync(path.join(tmpDir, 'soak', 'short'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'soak', 'short', 'summary.json'), JSON.stringify({
    status: 'ok',
    mode: 'short',
    durationSeconds: 1,
    sampleCount: 1,
    latencyMs: { p95: 1 }
  }))
  const resourceSummary = {
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
  }
  fs.writeFileSync(path.join(tmpDir, 'memoryLeakSummary.json'), JSON.stringify(resourceSummary))
  fs.writeFileSync(path.join(tmpDir, 'openHandleSummary.json'), JSON.stringify({
    ...resourceSummary,
    metrics: [{
      ...resourceSummary.metrics[0],
      name: 'backend_open_file_descriptors',
      threshold: 16
    }]
  }))
  fs.writeFileSync(manifestFile, JSON.stringify(base))
  const ok = validateManifest(base, { manifestPath: manifestFile })
  if (!ok.ok) {
    fail(`self-test expected ok manifest to pass: ${ok.errors.join('; ')}`)
  }

  fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
    status: 'ok',
    mode: 'dry-run',
    timings: { rpoSeconds: 1, rtoSeconds: 1 },
    checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
  }))
  const dryRunBackup = validateManifest(base, { manifestPath: manifestFile })
  if (dryRunBackup.ok || !dryRunBackup.missingRequired.includes('backup restore drill')) {
    fail('self-test expected dry-run backup restore artifact to block release closeout')
  }
  fs.writeFileSync(path.join(tmpDir, 'backupRestoreDrill.json'), JSON.stringify({
    status: 'ok',
    mode: 'real',
    timings: { rpoSeconds: 1, rtoSeconds: 1 },
    checks: ['postgres-restore:ok', 'redis-restore:ok', 'webroot-artifact-restore:ok', 'restored-backend-start:ok', 'public-page:ok', 'binary-api:ok', 'search-index:ok', 'notification-stream-live:ok', 'admin-login:ok']
  }))

  fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
    status: 'ok',
    placeholderOnly: true,
    cases: ['corrupt-html', 'corrupt-json']
  }))
  const placeholderAotResilience = validateManifest(base, { manifestPath: manifestFile })
  if (placeholderAotResilience.ok || !placeholderAotResilience.missingRequired.includes('public AOT cache resilience')) {
    fail('self-test expected placeholder AOT cache resilience artifact to block release closeout')
  }
  fs.writeFileSync(path.join(tmpDir, 'aotCacheResilienceSummary.json'), JSON.stringify({
    schema: 'fsusblog.public-aot-cache-resilience.v1',
    status: 'success',
    gitSha: 'fixture',
    rendererVersion: 'fixture',
    placeholderOnly: false,
    cases: [
      'corrupt-document',
      'invalid-document-bytes',
      'missing-sidecar',
      'corrupt-sidecar',
      'old-asset-version',
      'html-payload-mismatch',
      'sw-stale-cache-poisoning'
    ].map((name) => ({
      name,
      route: '/article/1',
      status: 'success',
      initialState: 'fresh',
      mutation: `fixture-${name}`,
      mutationVerified: true,
      observedState: name === 'old-asset-version' ? 'stale' : 'fallback',
      recovered: true,
      durationMs: 1,
      errors: []
    }))
  }))

  const missingButOk = structuredClone(base)
  missingButOk.evidenceSummary.image.status = 'missing'
  const blockedExpectation = validateManifest(missingButOk, { manifestPath: manifestFile })
  if (blockedExpectation.ok || !blockedExpectation.errors.some((error) => error.includes('collected-blocked'))) {
    fail('self-test expected missing image digest to require collected-blocked')
  }

  const blocked = structuredClone(missingButOk)
  blocked.status = 'collected-blocked'
  const blockedResult = validateManifest(blocked, { manifestPath: manifestFile })
  if (!blockedResult.ok || !blockedResult.missingRequired.includes('image digest')) {
    fail(`self-test expected blocked missing-image manifest to pass schema: ${blockedResult.errors.join('; ')}`)
  }

  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('[release-manifest-check] self-test ok')
}

const args = process.argv.slice(2)
const requireOk = args.includes('--require-ok')
if (args.includes('--self-test')) {
  runSelfTest()
  process.exit(0)
}

const manifestArg = args.find((arg) => !arg.startsWith('--'))
const manifestPath = manifestArg ? path.resolve(manifestArg) : latestManifest()
if (!manifestPath) {
  fail('manifest path is required, or .tmp/release-evidence must contain at least one manifest.json')
}

const manifest = readJson(manifestPath)
const result = validateManifest(manifest, { requireOk, manifestPath })
if (!result.ok) {
  for (const error of result.errors) {
    console.error(`[release-manifest-check] violation: ${error}`)
  }
  process.exit(1)
}

console.log(`[release-manifest-check] ok | status=${manifest.status} missing=${result.missingRequired.length} file=${manifestPath}`)
