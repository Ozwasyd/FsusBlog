import {
  RUNTIME_MATRIX_EVIDENCE_SCHEMA,
  RUNTIME_PROFILE_RESULT_SCHEMA,
  createBalancedSchedule,
  createRuntimeMeasurementClaimDigest,
  sealRuntimeProfileSelection,
  summarizeRuntimeRuns
} from '../../../tools/runtime-profiles/runtime-publish-evidence.mjs'
import { sha256Value } from '../../../tools/runtime-profiles/runtime-publish-profile.mjs'

const fixtureId = 'release-matrix-self-test'
const hardware = {
  logicalCpuCount: 4,
  totalMemoryBytes: 4294967296,
  cpuset: '0-3',
  cpuMax: '400000 100000',
  memoryMax: '4294967296',
  topology: {
    status: 'ok',
    reason: null,
    physicalCoreCount: 2,
    threadsPerCore: 2,
    smtSiblingGroups: [[0, 1], [2, 3]],
    numa: { status: 'ok', reason: null, nodes: [{ id: 0, cpulist: '0-1' }, { id: 1, cpulist: '2-3' }] }
  }
}

export function createReleaseRuntimeMatrixFixture({ commitSha, profileManifestDigest, profileDigest }) {
  const profileIds = ['throughput-musl', 'candidate']
  const schedule = createBalancedSchedule(profileIds, 3, `${commitSha}:${fixtureId}`)
  const hardwareDigest = sha256Value(hardware)
  const runs = schedule.map((entry) => createResult({
    ...entry,
    commitSha,
    hardwareDigest,
    profileManifestDigest,
    profileDigest: entry.profileId === 'throughput-musl' ? profileDigest : sha256Value({ profileId: entry.profileId })
  }))
  const evidence = {
    schema: RUNTIME_MATRIX_EVIDENCE_SCHEMA,
    status: 'complete',
    identity: { commitSha, fixtureId, profileManifestDigest, hardwareDigest },
    hardware,
    rounds: 3,
    profileIds,
    schedule,
    runs,
    comparison: summarizeRuntimeRuns(runs, 'throughput-musl')
  }
  evidence.selection = sealRuntimeProfileSelection(evidence, {
    schema: 'fsusblog.runtime-publish-selection-policy.v1',
    decision: 'retain-baseline',
    candidateProfileId: 'candidate',
    operatorReason: 'Retain the baseline because the candidate does not clear every sealed gate.',
    options: {
      baselineProfileId: 'throughput-musl',
      minimumSamples: 3,
      maximumCvPercent: 5,
      maximumGcPauseP99Ms: 25,
      maximumReadyMs: 3000,
      maximumRolloutMs: 30000,
      maximumRecoveryMs: 30000,
      maximumBlueGreenOverlapBytes: 2147483648
    }
  })
  return evidence
}

function createResult(identity) {
  const profileOffset = identity.profileId.length
  const imageDigest = sha256Value({ kind: 'runtime-image', profileId: identity.profileId })
  const route = {
    safeRps: 1000 + profileOffset,
    saturationKneeRps: 1100 + profileOffset,
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
    schema: RUNTIME_PROFILE_RESULT_SCHEMA,
    status: 'ok',
    identity: { ...identity, fixtureId },
    gates: { correctness: 'pass', security: 'pass', release: 'pass' },
    effectiveRuntime: {
      imageDigest,
      runtimeVersion: '10.0.10',
      sdkVersion: '10.0.302',
      runtimeBaseImageDigest: sha256Value({ kind: 'runtime-base', family: 'musl' }),
      sdkBaseImageDigest: sha256Value({ kind: 'sdk-base', family: 'musl' }),
      nodeVersion: 'v24.16.0',
      profilePurpose: identity.profileId === 'throughput-musl' ? 'throughput' : 'experiment',
      singleFile: true,
      readyToRun: false,
      tieredPgo: true,
      quickJitForLoops: true,
      threadPoolMode: 'runtime-default',
      threadPoolMinThreadsPerCpuDeclared: 0,
      threadPoolMinThreadsPerCpu: 0,
      serverGc: true,
      nativeAot: false,
      gcHeapCountMode: 'container-default',
      gcHeapHardLimitMode: 'container-limit',
      gcHeapHardLimitPercentConfigured: 0,
      gcHeapCountConfigured: 0,
      gcHeapHardLimitBytesConfigured: 0,
      baseImageFamily: 'musl',
      targetRuntime: 'linux-musl-x64',
      topologyMode: 'smt-visible'
    },
    execution: {
      cooldownRequestedMs: 0,
      cooldownObservedMs: 0,
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
      resourceStress: {
        targetMemoryBytes: 4294967296,
        allocationBurstPeakBytes: 64000000,
        gcPressurePeakPercent: 72,
        oomOutcome: 'not-applicable',
        oomRecoveryMs: null,
        blueGreen: {
          activeSlotRssBytes: 180000000,
          candidateSlotRssBytes: 180000000,
          publicSnapshotBytes: 10000000,
          ssrWorkerBytes: 20000000,
          otherBytes: 10000000,
          totalBytes: 400000000
        }
      },
      power: {
        status: 'unavailable',
        startupJoules: null,
        steadyStateWatts: null,
        reason: 'self-test fixture has no power counter',
        source: 'synthetic-test-fixture'
      },
      routes: Object.fromEntries(['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr'].map((name) => [name, { ...route }]))
    }
  }
  result.execution.commandReceipts = createReceipts(result)
  result.execution.measurementClaimDigest = createRuntimeMeasurementClaimDigest(result)
  return result
}

function createReceipts(result) {
  const featureSetDigest = sha256Value({ fixture: 'feature-set', profileId: result.identity.profileId })
  return ['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'].map((stage) => {
    let evidence
    if (stage.startsWith('cleanup')) {
      evidence = { kind: 'cleanup', cleanupTargetsDigest: sha256Value({ stage, identity: result.identity }) }
    } else if (stage === 'build') {
      evidence = {
        kind: 'build',
        imageRef: `fixture/${result.identity.profileId}@${result.effectiveRuntime.imageDigest}`,
        imageDigest: result.effectiveRuntime.imageDigest,
        artifactManifestDigest: sha256Value({ fixture: 'artifacts', profileId: result.identity.profileId }),
        featureSetDigest
      }
    } else if (['correctness', 'security', 'release'].includes(stage)) {
      evidence = { kind: 'gate', gate: stage, gateStatus: 'pass', evidenceDigest: sha256Value({ stage, identity: result.identity }) }
    } else {
      evidence = {
        kind: 'measurement',
        payloadDigest: sha256Value(result.measurements),
        faultPlanDigest: sha256Value({ fixture: 'fault-plan', profileId: result.identity.profileId }),
        loadFixtureDigest: sha256Value({ fixture: 'load', fixtureId })
      }
    }
    return {
      schema: 'fsusblog.runtime-publish-stage-receipt.v1',
      status: 'pass',
      stage,
      identity: structuredClone(result.identity),
      startedAtUtc: '2026-07-15T00:00:00.000Z',
      completedAtUtc: '2026-07-15T00:00:01.000Z',
      command: {
        executableDigest: sha256Value({ fixture: 'executable', stage }),
        argsDigest: sha256Value([]),
        durationMs: 1,
        exitCode: 0
      },
      resultDigest: sha256Value({ stage, identity: result.identity }),
      evidence
    }
  })
}
