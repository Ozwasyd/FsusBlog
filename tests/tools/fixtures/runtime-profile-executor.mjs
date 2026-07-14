#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'

const requestIndex = process.argv.indexOf('--request')
const outputIndex = process.argv.indexOf('--output')
const requestFile = requestIndex >= 0 ? process.argv[requestIndex + 1] : null
const outputFile = outputIndex >= 0 ? process.argv[outputIndex + 1] : null
if (!requestFile || !outputFile || process.env.FSUSBLOG_RUNTIME_MATRIX_EXECUTOR !== '1') process.exit(2)
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
const route = {
  safeRps: 1000,
  saturationKneeRps: 1100,
  p50Ms: 2,
  p95Ms: 5,
  p99Ms: 8,
  p999Ms: 12,
  cyclesPerRequest: 100,
  instructionsPerRequest: 200,
  ipc: 2,
  allocationsBytesPerRequest: 32
}
const result = {
  schema: 'fsusblog.runtime-publish-profile-result.v1',
  status: 'ok',
  identity: request.identity,
  gates: { correctness: 'pass', security: 'pass', release: 'pass' },
  effectiveRuntime: {
    imageDigest: request.identity.profileDigest,
    runtimeVersion: '10.0.10',
    sdkVersion: '10.0.302',
    runtimeBaseImageDigest: `sha256:${request.profile.baseImageFamily === 'musl' ? 'd' : 'e'}`.padEnd(71, request.profile.baseImageFamily === 'musl' ? 'd' : 'e'),
    sdkBaseImageDigest: `sha256:${request.profile.baseImageFamily === 'musl' ? 'f' : '9'}`.padEnd(71, request.profile.baseImageFamily === 'musl' ? 'f' : '9'),
    nodeVersion: 'v24.16.0',
    profilePurpose: request.profile.purpose,
    threadPoolMode: request.profile.threadPool.mode,
    threadPoolMinThreadsPerCpu: request.profile.threadPool.mode === 'evidence-derived' ? 10 : request.profile.threadPool.minThreadsPerCpu,
    serverGc: request.profile.gc.server,
    nativeAot: request.profile.publish.nativeAot,
    baseImageFamily: request.profile.baseImageFamily,
    targetRuntime: request.profile.targetRuntime,
    topologyMode: request.profile.topology.mode
  },
  ...(request.profile.threadPool.mode === 'evidence-derived' ? {
    threadPoolEvidence: { selectedMinThreadsPerCpu: 10, baselineStarvationCount: 1, baselineQueueP99: 2 }
  } : {}),
  execution: {
    cooldownRequestedMs: request.cooldownMs,
    cooldownObservedMs: request.cooldownObservedMs,
    cleanupBefore: 'pass',
    cleanupAfter: 'pass',
    measurementWindowQuiet: true,
    loadGeneratorIsolated: true,
    targetCpuset: '0',
    observedTargetCpuset: '0',
    loadGeneratorCpuset: '1',
    targetCgroup: '/fsus/target',
    loadGeneratorCgroup: '/fsus/loadgen',
    targetMemoryBytes: 4294967296
  },
  measurements: {
    imageSizeBytes: 1000000,
    coldStartMs: 120,
    readyMs: 180,
    warmupMs: 1000,
    rssPeakBytes: 200000000,
    managedHeapPeakBytes: 80000000,
    lohPeakBytes: 1000000,
    gcPauseP99Ms: 3,
    gcCpuPercent: 2,
    jitTimeMs: 40,
    jitCodeSizeBytes: 2000000,
    tierTransitions: 12,
    threadPoolQueueP99: 0,
    threadPoolStarvationCount: 0,
    contextSwitches: 1000,
    cpuMigrations: 20,
    cpuThrottledSeconds: 0,
    startupCpuSeconds: 0.5,
    steadyStateCpuSeconds: 10,
    rolloutMs: 5000,
    recoveryMs: 4000,
    blueGreenOverlapPeakBytes: 400000000,
    power: { status: 'unavailable', startupJoules: null, steadyStateWatts: null, reason: 'test fixture has no power counter', source: 'synthetic-test-fixture' },
    routes: Object.fromEntries(['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr'].map((name) => [name, route]))
  }
}
fs.writeFileSync(outputFile, `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 })
