#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { sha256Value } from '../../../tools/runtime-profiles/runtime-publish-profile.mjs'

const stage = process.env.FSUSBLOG_RUNTIME_EXECUTOR_STAGE
const request = JSON.parse(process.env.FSUSBLOG_RUNTIME_PROFILE_REQUEST)
const output = process.env.FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT
const resultOutput = process.env.FSUSBLOG_RUNTIME_STAGE_RESULT_OUTPUT
const artifactRoot = process.env.FSUSBLOG_RUNTIME_STAGE_ARTIFACT_ROOT
const artifactMode = process.env.FSUSBLOG_RUNTIME_FIXTURE_ARTIFACT_MODE ?? 'valid'
const artifactModeStage = process.env.FSUSBLOG_RUNTIME_FIXTURE_ARTIFACT_STAGE ?? stage
if (stage === artifactModeStage && artifactMode === 'root-symlink') {
  const replacement = `${artifactRoot}-replacement`
  fs.rmSync(artifactRoot, { recursive: true, force: true })
  fs.mkdirSync(replacement)
  fs.symlinkSync(replacement, artifactRoot)
}
const targetMemoryBytes = 4294967296
const targetCpuCount = Number(process.env.FSUSBLOG_RUNTIME_TARGET_CPU_COUNT)
const explicitHardLimit = request.profile.gc.heapHardLimitMode === 'explicit-container-percent'
const hardLimitPercent = request.profile.gc.heapHardLimitPercent
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
const payload = stage === 'measure' ? {
  imageReceipt: {
    imageRef: `fixture/${request.profile.id}@${request.identity.profileDigest}`
  },
  effectiveRuntime: {
    profilePurpose: request.profile.purpose,
    singleFile: request.profile.publish.singleFile,
    readyToRun: request.profile.publish.readyToRun,
    tieredPgo: request.profile.publish.tieredPgo,
    quickJitForLoops: request.profile.publish.quickJitForLoops,
    threadPoolMode: request.profile.threadPool.mode,
    threadPoolMinThreadsPerCpuDeclared: request.profile.threadPool.minThreadsPerCpu,
    threadPoolMinThreadsPerCpu: request.profile.threadPool.minThreadsPerCpu,
    serverGc: request.profile.gc.server,
    nativeAot: request.profile.publish.nativeAot,
    gcHeapCountMode: request.profile.gc.heapCountMode,
    gcHeapHardLimitMode: request.profile.gc.heapHardLimitMode,
    gcHeapHardLimitPercentConfigured: hardLimitPercent,
    gcHeapCountConfigured: request.profile.gc.heapCountMode === 'cpuset' ? targetCpuCount : 0,
    gcHeapHardLimitBytesConfigured: explicitHardLimit ? Math.floor(targetMemoryBytes * hardLimitPercent / 100) : 0,
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
    targetMemoryBytes,
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
    resourceStress: {
      targetMemoryBytes,
      allocationBurstPeakBytes: 64000000,
      gcPressurePeakPercent: 72,
      oomOutcome: explicitHardLimit ? 'bounded-rejection' : 'not-applicable',
      oomRecoveryMs: explicitHardLimit ? 250 : null,
      blueGreen: {
        activeSlotRssBytes: 180000000,
        candidateSlotRssBytes: 180000000,
        publicSnapshotBytes: 10000000,
        ssrWorkerBytes: 20000000,
        otherBytes: 10000000,
        totalBytes: 400000000
      }
    },
    power: { status: 'unavailable', startupJoules: null, steadyStateWatts: null, reason: 'test fixture has no power counter', source: 'synthetic-test-fixture' },
    routes: Object.fromEntries(['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr'].map((name) => [name, route]))
  }
} : null

if (payload) fs.writeFileSync(output, `${JSON.stringify(payload)}\n`, { flag: 'wx', mode: 0o600 })

const artifactBase = (kind, artifactStage = stage) => ({
  schema: 'fsusblog.runtime-publish-stage-artifact.v1',
  kind,
  status: 'pass',
  stage: artifactStage,
  identity: request.identity
})
const buildFeatureSet = {
  ...artifactBase('feature-set', 'build'),
  scope: 'public-artifact-only',
  features: ['aot-ssr', 'binary-api', 'notification-stream', 'public-artifacts']
}
const featureSetDigest = sha256Value(buildFeatureSet)
const evidence = (() => {
  if (stage.startsWith('cleanup')) return {
    kind: 'cleanup',
    artifactPath: writeArtifact(`${stage}.json`, { ...artifactBase('cleanup'), targets: ['target-cgroup', 'load-generator-cgroup', 'runtime-containers'] })
  }
  if (stage === 'build') return {
    kind: 'build',
    imageRef: `fixture/${request.profile.id}@${request.identity.profileDigest}`,
    imageDigest: request.identity.profileDigest,
    artifactManifestPath: writeArtifact('build-manifest.json', {
      ...artifactBase('build-manifest'),
      imageRef: `fixture/${request.profile.id}@${request.identity.profileDigest}`,
      imageDigest: request.identity.profileDigest,
      artifacts: ['FsusBlog.Server', 'wwwroot', 'runtime-contract']
    }),
    featureSetPath: writeArtifact('feature-set.json', buildFeatureSet)
  }
  if (['correctness', 'security', 'release'].includes(stage)) return {
    kind: 'gate',
    artifactPath: writeArtifact(`${stage}.json`, { ...artifactBase('gate'), gate: stage, checks: [{ id: `${stage}-fixture`, status: 'pass' }] })
  }
  if (stage.endsWith('Parity')) return {
    kind: 'parity',
    artifactPath: writeArtifact(`${stage}.json`, {
      ...artifactBase('parity'),
      parity: stage === 'featureParity' ? 'feature' : 'security',
      scope: 'public-artifact-only',
      featureSetDigest,
      checks: [{ id: `${stage}-fixture`, status: 'pass' }]
    })
  }
  return {
    kind: 'measurement',
    faultPlanPath: writeArtifact('fault-plan.json', {
      ...artifactBase('fault-plan'),
      scenarios: ['allocation-burst', 'gc-pressure', 'oom', 'blue-green-overlap', 'recovery']
    }),
    loadFixturePath: writeArtifact('load-fixture.json', {
      ...artifactBase('load-fixture'),
      fixtureId: request.identity.fixtureId,
      routes: ['aot-ssr', 'db-miss', 'l0', 'l1', 'l2', 'notification']
    })
  }
})()

fs.writeFileSync(resultOutput, `${JSON.stringify({
  schema: 'fsusblog.runtime-publish-stage-result.v1',
  status: 'pass',
  stage,
  identity: request.identity,
  evidence
})}\n`, { flag: 'wx', mode: 0o600 })

function writeArtifact(name, value) {
  let artifact = structuredClone(value)
  if (stage === artifactModeStage && artifactMode === 'stale-identity') artifact.identity.commitSha = 'f'.repeat(40)
  if (stage === artifactModeStage && artifactMode === 'tampered-status') artifact.status = 'failed'
  if (stage === artifactModeStage && artifactMode === 'missing') return name
  if (stage === artifactModeStage && artifactMode === 'escape') {
    fs.writeFileSync(`${artifactRoot}/../${name}`, `${JSON.stringify(artifact)}\n`, { flag: 'wx', mode: 0o600 })
    return `../${name}`
  }
  if (stage === artifactModeStage && artifactMode === 'symlink') {
    const outside = `${artifactRoot}/../outside-${name}`
    fs.writeFileSync(outside, `${JSON.stringify(artifact)}\n`, { flag: 'wx', mode: 0o600 })
    fs.symlinkSync(outside, `${artifactRoot}/${name}`)
    return name
  }
  fs.writeFileSync(`${artifactRoot}/${name}`, `${JSON.stringify(artifact)}\n`, { flag: 'wx', mode: 0o600 })
  return name
}
