#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'

if (process.env.FSUSBLOG_RUNTIME_EXECUTOR_STAGE !== 'measure') process.exit(0)
const request = JSON.parse(process.env.FSUSBLOG_RUNTIME_PROFILE_REQUEST)
const output = process.env.FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT
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
const payload = {
  imageReceipt: {
    imageRef: `fixture/${request.profile.id}@${request.identity.profileDigest}`
  },
  effectiveRuntime: {
    profilePurpose: request.profile.purpose,
    threadPoolMode: request.profile.threadPool.mode,
    threadPoolMinThreadsPerCpu: request.profile.threadPool.minThreadsPerCpu,
    serverGc: request.profile.gc.server,
    nativeAot: request.profile.publish.nativeAot,
    baseImageFamily: request.profile.baseImageFamily,
    targetRuntime: request.profile.targetRuntime,
    topologyMode: request.profile.topology.mode
  },
  isolationReceipt: {
    targetCpuset: process.env.FSUSBLOG_RUNTIME_TARGET_CPUSET,
    observedTargetCpuset: process.env.FSUSBLOG_RUNTIME_TARGET_CPUSET,
    loadGeneratorCpuset: process.env.FSUSBLOG_RUNTIME_LOADGEN_CPUSET,
    targetCgroup: process.env.FSUSBLOG_RUNTIME_TARGET_CGROUP,
    loadGeneratorCgroup: process.env.FSUSBLOG_RUNTIME_LOADGEN_CGROUP,
    targetMemoryBytes: 4294967296,
    measurementWindowQuiet: true,
    loadGeneratorIsolated: true
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
fs.writeFileSync(output, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 })
