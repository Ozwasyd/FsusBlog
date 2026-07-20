import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  readRuntimeProfileManifest,
  resolveRuntimeProfile,
  runtimeProfileBuildArgs,
  sha256Value,
  validateRuntimeProfileManifest
} from '../../tools/runtime-profiles/runtime-publish-profile.mjs'
import {
  RUNTIME_MATRIX_EVIDENCE_SCHEMA,
  RUNTIME_PROFILE_RESULT_SCHEMA,
  captureHardwareIdentity,
  createBalancedSchedule,
  createRuntimeMeasurementClaimDigest,
  evaluateRuntimeProfileSelection,
  resolveContainerVisibleCpuCount,
  resolveContainerVisibleMemoryBytes,
  sealRuntimeProfileSelection,
  summarizeRuntimeRuns,
  validateRuntimeMatrixEvidence,
  validateRuntimeProfileResult
} from '../../tools/runtime-profiles/runtime-publish-evidence.mjs'
import { resolveAutoBalancedCpuSets } from '../../tools/runtime-profiles/runtime-publish-isolation.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const commitSha = '0123456789abcdef0123456789abcdef01234567'
const fixtureId = 'production-fixture-v1'
const testHardware = {
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
const hardwareDigest = sha256Value(testHardware)
const selectionPolicy = {
  schema: 'fsusblog.runtime-publish-selection-policy.v1',
  decision: 'retain-baseline',
  candidateProfileId: 'throughput-glibc',
  operatorReason: 'Retain the production baseline when the candidate does not clear every sealed gate.',
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
}

function createRuntimeDockerShim(directory, profileManifestDigest) {
  const profiles = Object.fromEntries(readRuntimeProfileManifest().manifest.profiles.map((profile) => [profile.id, profile]))
  const bin = path.join(directory, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format' && args[3] === '{{json .}}') {
  const imageRef = args[4] ?? ''
  const match = imageRef.match(/^fixture\\/([^@]+)@(sha256:[0-9a-f]{64})$/u)
  if (!match) process.exit(41)
  const profileId = match[1]
  const imageDigest = match[2]
  const profile = ${JSON.stringify(profiles)}[profileId]
  if (!profile) process.exit(43)
  const glibc = profile.baseImageFamily === 'glibc'
  const labels = {
    'org.opencontainers.image.revision': ${JSON.stringify(commitSha)},
    'io.fsusblog.runtime.profile-id': process.env.FSUSBLOG_RUNTIME_FAKE_DOCKER_BAD_PROFILE_LABEL === '1' ? 'wrong-profile' : profileId,
    'io.fsusblog.runtime.profile-digest': imageDigest,
    'io.fsusblog.runtime.profile-manifest-digest': ${JSON.stringify(profileManifestDigest)},
    'io.fsusblog.runtime.base-family': glibc ? 'glibc' : 'musl',
    'io.fsusblog.runtime.target-runtime': glibc ? 'linux-x64' : 'linux-musl-x64',
    'io.fsusblog.runtime.publish-single-file': String(profile.publish.singleFile),
    'io.fsusblog.runtime.publish-ready-to-run': String(profile.publish.readyToRun),
    'io.fsusblog.runtime.tiered-pgo': String(profile.publish.tieredPgo),
    'io.fsusblog.runtime.quick-jit-for-loops': String(profile.publish.quickJitForLoops),
    'io.fsusblog.runtime.server-gc': String(profile.gc.server),
    'io.fsusblog.runtime.native-aot': String(profile.publish.nativeAot),
    'io.fsusblog.runtime.gc-heap-count-mode': profile.gc.heapCountMode,
    'io.fsusblog.runtime.gc-heap-hard-limit-mode': profile.gc.heapHardLimitMode,
    'io.fsusblog.runtime.gc-heap-hard-limit-percent': String(profile.gc.heapHardLimitPercent),
    'io.fsusblog.runtime.thread-pool-mode': profile.threadPool.mode,
    'io.fsusblog.runtime.thread-pool-min-threads-per-cpu': String(profile.threadPool.minThreadsPerCpu),
    'io.fsusblog.runtime.topology-mode': profile.topology.mode,
    'io.fsusblog.runtime.dotnet-version': '10.0.10',
    'io.fsusblog.runtime.base-image-digest': 'sha256:' + (glibc ? 'e' : 'd').repeat(64),
    'io.fsusblog.build.dotnet-sdk-version': '10.0.302',
    'io.fsusblog.build.sdk-image-digest': 'sha256:' + (glibc ? '9' : 'f').repeat(64)
  }
  process.stdout.write(JSON.stringify({ Id: imageDigest, Config: { Labels: labels } }) + '\\n')
  process.exit(0)
}
if (args[0] === 'run' && args[1] === '--rm' && args[2] === '--network' && args[3] === 'none' && args[4] === '--entrypoint' && args[5] === 'node' && /^sha256:[0-9a-f]{64}$/u.test(args[6] ?? '') && args[7] === '--version') {
  process.stdout.write('v24.16.0\\n')
  process.exit(0)
}
process.exit(42)
`, { mode: 0o755 })
  return bin
}

test('runtime profile catalog covers every required controlled axis', () => {
  const loaded = readRuntimeProfileManifest()
  assert.equal(loaded.manifest.defaultProfile, 'throughput-musl')
  assert.ok(loaded.manifest.profiles.length >= 10)
  assert.match(loaded.digest, /^sha256:[0-9a-f]{64}$/u)
  const glibc = resolveRuntimeProfile('throughput-glibc')
  assert.deepEqual(runtimeProfileBuildArgs(glibc), {
    runtimeProfileId: 'throughput-glibc',
    runtimeProfileManifestDigest: loaded.digest,
    runtimeProfileDigest: sha256Value(glibc.profile),
    runtimeBaseFlavor: 'glibc',
    targetRuntime: 'linux-x64',
    publishSingleFile: 'true',
    publishReadyToRun: 'false',
    tieredPgo: 'true',
    quickJitForLoops: 'true',
    nativeAot: 'false',
    gcHeapCountMode: 'container-default',
    gcHeapHardLimitMode: 'container-limit',
    gcHeapHardLimitPercent: '0',
    serverGc: 'true',
    threadPoolMode: 'runtime-default',
    threadPoolMinThreadsPerCpu: '0',
    topologyMode: 'smt-visible'
  })
})

test('runtime profile catalog fails closed on drift, unsafe thread tuning and missing axis coverage', () => {
  const manifest = structuredClone(readRuntimeProfileManifest().manifest)
  manifest.profiles[0].unexpected = true
  manifest.profiles.find((profile) => profile.id === 'threadpool-evidence-derived').threadPool.minThreadsPerCpu = 12
  manifest.profiles = manifest.profiles.filter((profile) => profile.baseImageFamily !== 'glibc')
  const errors = validateRuntimeProfileManifest(manifest)
  assert.ok(errors.some((error) => error.includes('unexpected is not allowed')))
  assert.ok(errors.some((error) => error.includes('evidence-derived value must be supplied by sealed run evidence')))
  assert.ok(errors.some((error) => error.includes('base image family glibc')))

  const nativeAot = structuredClone(readRuntimeProfileManifest().manifest)
  const prototype = nativeAot.profiles.find((profile) => profile.id === 'nativeaot-public-prototype')
  prototype.conditionalAdmission.requireSecurityParity = false
  prototype.conditionalAdmission.onParityFailure = 'continue'
  const nativeErrors = validateRuntimeProfileManifest(nativeAot)
  assert.ok(nativeErrors.some((error) => error.includes('requireSecurityParity must be true')))
  assert.ok(nativeErrors.some((error) => error.includes('onParityFailure must be reject')))
})

test('every controlled runtime and publish profile remains a one-factor comparison', () => {
  const profiles = readRuntimeProfileManifest().manifest.profiles
  const baseline = profiles.find((profile) => profile.id === 'throughput-musl')
  const glibc = profiles.find((profile) => profile.id === 'throughput-glibc')
  const r2r = profiles.find((profile) => profile.id === 'startup-musl-r2r')
  const pgo = profiles.find((profile) => profile.id === 'throughput-musl-pgo-off')
  const multifile = profiles.find((profile) => profile.id === 'throughput-musl-multifile')
  const threadPool = profiles.find((profile) => profile.id === 'threadpool-evidence-derived')
  const negativeControl = profiles.find((profile) => profile.id === 'threadpool-overprovisioned-negative-control')
  const quickJit = profiles.find((profile) => profile.id === 'throughput-musl-quickjit-off')
  const gc = profiles.find((profile) => profile.id === 'gc-cpuset')
  const hardLimit = profiles.find((profile) => profile.id === 'gc-explicit-hard-limit')
  const topology = profiles.find((profile) => profile.id === 'physical-core-only')
  const numa = profiles.find((profile) => profile.id === 'numa-local')
  assert.equal(glibc.baseImageFamily, 'glibc')
  assert.equal(glibc.targetRuntime, 'linux-x64')
  assert.deepEqual(glibc.publish, baseline.publish)
  assert.equal(r2r.publish.readyToRun, true)
  assert.equal(r2r.publish.singleFile, baseline.publish.singleFile)
  assert.equal(pgo.publish.tieredPgo, false)
  assert.equal(pgo.publish.quickJitForLoops, baseline.publish.quickJitForLoops)
  assert.equal(multifile.publish.singleFile, false)
  assert.equal(multifile.publish.readyToRun, baseline.publish.readyToRun)
  assert.equal(threadPool.threadPool.mode, 'evidence-derived')
  assert.equal(threadPool.threadPool.minThreadsPerCpu, baseline.threadPool.minThreadsPerCpu)
  assert.equal(negativeControl.threadPool.mode, 'overprovisioned-negative-control')
  assert.ok(negativeControl.threadPool.minThreadsPerCpu >= 64)
  assert.equal(quickJit.publish.quickJitForLoops, false)
  assert.equal(quickJit.publish.tieredPgo, baseline.publish.tieredPgo)
  assert.equal(gc.topology.mode, baseline.topology.mode)
  assert.equal(gc.gc.heapHardLimitMode, baseline.gc.heapHardLimitMode)
  assert.equal(hardLimit.gc.heapCountMode, baseline.gc.heapCountMode)
  assert.deepEqual(topology.gc, baseline.gc)
  assert.deepEqual(numa.gc, baseline.gc)
})

test('one-factor controls reject hidden secondary variable drift', () => {
  const cases = [
    ['throughput-glibc', (profile) => { profile.publish.readyToRun = true }],
    ['startup-musl-r2r', (profile) => { profile.publish.singleFile = false }],
    ['throughput-musl-multifile', (profile) => { profile.publish.tieredPgo = false }],
    ['gc-cpuset', (profile) => { profile.gc.heapHardLimitMode = 'explicit-container-percent' }],
    ['gc-explicit-hard-limit', (profile) => { profile.gc.heapCountMode = 'cpuset' }],
    ['threadpool-evidence-derived', (profile) => { profile.topology.mode = 'physical-core-only' }],
    ['threadpool-overprovisioned-negative-control', (profile) => { profile.gc.heapCountMode = 'cpuset' }],
    ['numa-local', (profile) => { profile.publish.readyToRun = true }]
  ]
  for (const [profileId, mutate] of cases) {
    const manifest = structuredClone(readRuntimeProfileManifest().manifest)
    mutate(manifest.profiles.find((profile) => profile.id === profileId))
    const errors = validateRuntimeProfileManifest(manifest)
    assert.ok(
      errors.some((error) => error.startsWith(`${profileId} must differ from throughput-musl only by `)),
      `${profileId} should reject hidden secondary drift: ${errors.join('; ')}`
    )
  }
})

test('hardware topology records physical cores, SMT siblings and honest NUMA availability', () => {
  const { identity, digest } = captureHardwareIdentity()
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u)
  assert.ok(identity.logicalCpuCount >= 1)
  assert.ok(identity.totalMemoryBytes >= 1)
  assert.ok(['ok', 'unavailable'].includes(identity.topology.status))
  assert.ok(['ok', 'not-applicable', 'unavailable'].includes(identity.topology.numa.status))
  if (identity.topology.status === 'ok') {
    assert.ok(identity.topology.physicalCoreCount >= 1)
    assert.ok(identity.topology.threadsPerCore >= 1)
    assert.equal(identity.topology.smtSiblingGroups.length, identity.topology.physicalCoreCount)
  } else {
    assert.ok(identity.topology.reason.length >= 3)
  }
  if (identity.topology.numa.status !== 'ok') assert.ok(identity.topology.numa.reason.length >= 3)
})

test('container-visible CPU and memory identity never expands to host-only capacity', () => {
  assert.equal(resolveContainerVisibleCpuCount(64, '8-15', '250000 100000'), 3)
  assert.equal(resolveContainerVisibleCpuCount(64, '8-15', 'max 100000'), 8)
  assert.equal(resolveContainerVisibleMemoryBytes(64 * 1024 ** 3, String(6 * 1024 ** 3)), 6 * 1024 ** 3)
  assert.equal(resolveContainerVisibleMemoryBytes(64 * 1024 ** 3, 'max'), 64 * 1024 ** 3)
})

test('auto-balanced isolation honors SMT, physical-core-only and NUMA-local profiles', () => {
  const common = {
    visibleCpus: [0, 1, 2, 3, 4, 5, 6, 7],
    physicalCoreGroups: [[0, 4], [1, 5], [2, 6], [3, 7]],
    numaNodes: [[0, 1, 4, 5], [2, 3, 6, 7]]
  }
  assert.deepEqual(resolveAutoBalancedCpuSets({ ...common, topologyMode: 'smt-visible' }), {
    targetCpus: [0, 4, 1, 5],
    loadGeneratorCpus: [2, 6, 3, 7]
  })
  assert.deepEqual(resolveAutoBalancedCpuSets({ ...common, topologyMode: 'physical-core-only' }), {
    targetCpus: [0, 1],
    loadGeneratorCpus: [2, 3]
  })
  assert.deepEqual(resolveAutoBalancedCpuSets({ ...common, topologyMode: 'numa-local' }), {
    targetCpus: [0, 1, 4, 5],
    loadGeneratorCpus: [2, 3, 6, 7]
  })
})

test('balanced schedule runs every profile exact-once per round without a fixed repeated order', () => {
  const ids = ['alpha', 'beta', 'gamma', 'delta']
  const schedule = createBalancedSchedule(ids, 4, 'same-sha:same-hardware')
  assert.equal(schedule.length, 16)
  const orders = []
  for (let round = 1; round <= 4; round += 1) {
    const entries = schedule.filter((entry) => entry.round === round).sort((a, b) => a.position - b.position)
    assert.deepEqual(new Set(entries.map((entry) => entry.profileId)), new Set(ids))
    orders.push(entries.map((entry) => entry.profileId).join(','))
  }
  assert.ok(new Set(orders).size > 1)
})

test('profile result requires same identity, all gates and every runtime route metric', () => {
  const result = createResult('throughput-musl', 1)
  assert.deepEqual(validateRuntimeProfileResult(result, result.identity), [])
  const drifted = structuredClone(result)
  drifted.identity.commitSha = 'f'.repeat(40)
  delete drifted.measurements.routes.notification
  drifted.gates.security = 'skip'
  drifted.execution.loadGeneratorCpuset = '0'
  drifted.execution.cleanupAfter = 'skip'
  const errors = validateRuntimeProfileResult(drifted, result.identity)
  assert.ok(errors.some((error) => error.includes('commitSha does not match')))
  assert.ok(errors.some((error) => error.includes('gates.security must be pass')))
  assert.ok(errors.some((error) => error.includes('routes.notification is required')))
  assert.ok(errors.some((error) => error.includes('cleanup must pass')))
  assert.ok(errors.some((error) => error.includes('cpusets must be disjoint')))
})

test('complete matrix evidence requires three rounds and emits pairwise plus Pareto comparison', () => {
  const loaded = readRuntimeProfileManifest()
  const profileIds = loaded.manifest.profiles.map((profile) => profile.id)
  const schedule = createBalancedSchedule(profileIds, 3, 'sealed-run')
  const runs = schedule.map((entry) => createResult(entry.profileId, entry.round, {
    profileManifestDigest: loaded.digest,
    profileDigest: sha256Value(loaded.manifest.profiles.find((profile) => profile.id === entry.profileId)),
    position: entry.position
  }))
  const comparison = summarizeRuntimeRuns(runs, loaded.manifest.defaultProfile)
  const evidence = {
    schema: RUNTIME_MATRIX_EVIDENCE_SCHEMA,
    status: 'complete',
    identity: { commitSha, fixtureId, profileManifestDigest: loaded.digest, hardwareDigest },
    hardware: testHardware,
    rounds: 3,
    profileIds,
    schedule,
    runs,
    comparison
  }
  evidence.selection = sealRuntimeProfileSelection(evidence, selectionPolicy)
  assert.deepEqual(validateRuntimeMatrixEvidence(evidence), [])
  assert.equal(evidence.selection.selectedProfileId, 'throughput-musl')
  assert.deepEqual(validateRuntimeMatrixEvidence(evidence, {
    expectedCommitSha: commitSha,
    expectedSelectedProfileId: 'throughput-musl',
    expectedProfileManifestDigest: loaded.digest,
    expectedProfileDigest: sha256Value(loaded.manifest.profiles.find((profile) => profile.id === 'throughput-musl'))
  }), [])
  assert.ok(validateRuntimeMatrixEvidence(evidence, {
    expectedCommitSha: 'f'.repeat(40)
  }).some((error) => error.includes('release commit')))
  const tamperedSelection = structuredClone(evidence)
  tamperedSelection.selection.selectedProfileId = 'throughput-glibc'
  assert.ok(validateRuntimeMatrixEvidence(tamperedSelection).some((error) => error.includes('selection.selectedProfileId')))
  const tamperedComparison = structuredClone(evidence)
  tamperedComparison.comparison.conclusions.steadyState.highestSafeRpsProfileId = 'throughput-glibc'
  assert.ok(validateRuntimeMatrixEvidence(tamperedComparison).some((error) => error.includes('derived exactly from the successful run evidence')))
  assert.equal(comparison.profiles['throughput-musl'].samples, 3)
  assert.ok(comparison.paretoProfileIds.length > 0)
  assert.ok(comparison.conclusions.startup.lowestColdStartProfileId)
  assert.ok(comparison.conclusions.steadyState.highestSafeRpsProfileId)
  assert.equal(typeof comparison.pairwise['threadpool-overprovisioned-negative-control'].contextSwitchesDeltaPercent, 'number')
  assert.equal(typeof comparison.pairwise['threadpool-overprovisioned-negative-control'].rssDeltaPercent, 'number')
  assert.equal(typeof comparison.pairwise['threadpool-overprovisioned-negative-control'].p999DeltaPercent, 'number')
  const selection = evaluateRuntimeProfileSelection(comparison, 'throughput-glibc')
  assert.equal(selection.eligible, false)
  assert.ok(selection.errors.some((error) => error.includes('materiality floor')))

  const insufficient = structuredClone(evidence)
  insufficient.rounds = 2
  insufficient.schedule = schedule.filter((entry) => entry.round <= 2)
  insufficient.runs = runs.filter((run) => run.identity.round <= 2)
  assert.ok(validateRuntimeMatrixEvidence(insufficient).some((error) => error.includes('at least three rounds')))

  const interrupted = structuredClone(evidence)
  interrupted.status = 'partial'
  interrupted.runs = runs.slice(0, 1)
  interrupted.comparison = summarizeRuntimeRuns(interrupted.runs, loaded.manifest.defaultProfile)
  interrupted.selection = null
  assert.deepEqual(validateRuntimeMatrixEvidence(interrupted, { requireComplete: false }), [])

  const recovered = structuredClone(evidence)
  const retainedFailure = {
    schema: RUNTIME_PROFILE_RESULT_SCHEMA,
    status: 'failed',
    identity: structuredClone(runs[0].identity),
    error: 'retained failure from the first attempt'
  }
  recovered.runs = [retainedFailure, ...runs]
  recovered.comparison = summarizeRuntimeRuns(recovered.runs, loaded.manifest.defaultProfile)
  recovered.selection = sealRuntimeProfileSelection(recovered, selectionPolicy)
  assert.deepEqual(validateRuntimeMatrixEvidence(recovered), [])
  assert.equal(recovered.comparison.profiles[runs[0].identity.profileId].samples, 3)

  const attemptedAfterSuccess = structuredClone(recovered)
  attemptedAfterSuccess.runs.push(structuredClone(retainedFailure))
  assert.ok(validateRuntimeMatrixEvidence(attemptedAfterSuccess).some((error) => error.includes('attempt after its successful result')))
})

test('complete matrix evidence rejects runtime, memory, base-image and per-profile image identity drift', () => {
  const scenarios = [
    {
      expected: 'runtimeVersion must be identical',
      mutate: (evidence) => { evidence.runs[0].effectiveRuntime.runtimeVersion = '10.0.9' }
    },
    {
      expected: 'sdkVersion must be identical',
      mutate: (evidence) => { evidence.runs[0].effectiveRuntime.sdkVersion = '10.0.301' }
    },
    {
      expected: 'targetMemoryBytes must be identical',
      mutate: (evidence) => { evidence.runs[0].execution.targetMemoryBytes = 2147483648 }
    },
    {
      expected: 'profile throughput-musl imageDigest must be identical',
      mutate: (evidence) => {
        evidence.runs.find((run) => run.identity.profileId === 'throughput-musl' && run.identity.round === 2).effectiveRuntime.imageDigest = `sha256:${'1'.repeat(64)}`
      }
    },
    {
      expected: 'musl runtimeBaseImageDigest must be identical',
      mutate: (evidence) => {
        evidence.runs.find((run) => run.identity.profileId === 'throughput-musl-pgo-off').effectiveRuntime.runtimeBaseImageDigest = `sha256:${'2'.repeat(64)}`
      }
    },
    {
      expected: 'musl sdkBaseImageDigest must be identical',
      mutate: (evidence) => {
        evidence.runs.find((run) => run.identity.profileId === 'throughput-musl-pgo-off').effectiveRuntime.sdkBaseImageDigest = `sha256:${'3'.repeat(64)}`
      }
    },
    {
      expected: 'musl nodeVersion must be identical',
      mutate: (evidence) => {
        evidence.runs.find((run) => run.identity.profileId === 'throughput-musl-pgo-off').effectiveRuntime.nodeVersion = 'v24.15.0'
      }
    }
  ]
  for (const scenario of scenarios) {
    const evidence = createCompleteMatrixEvidence()
    scenario.mutate(evidence)
    assert.ok(validateRuntimeMatrixEvidence(evidence).some((error) => error.includes(scenario.expected)), scenario.expected)
  }
})

test('physical-core and NUMA profiles require observed placement to match hardware topology', () => {
  const physicalProfile = readRuntimeProfileManifest().manifest.profiles.find((profile) => profile.id === 'physical-core-only')
  const physical = createResult('physical-core-only', 1)
  physical.execution.targetCpuset = '0-1'
  physical.execution.observedTargetCpuset = '0-1'
  physical.execution.loadGeneratorCpuset = '2'
  const physicalErrors = validateRuntimeProfileResult(physical, { expectedProfile: physicalProfile, expectedHardware: testHardware })
  assert.ok(physicalErrors.some((error) => error.includes('selected SMT siblings')))

  const numa = createResult('candidate', 1)
  numa.effectiveRuntime.topologyMode = 'numa-local'
  numa.execution.targetCpuset = '0,2'
  numa.execution.observedTargetCpuset = '0,2'
  numa.execution.loadGeneratorCpuset = '3'
  const numaErrors = validateRuntimeProfileResult(numa, { expectedHardware: testHardware })
  assert.ok(numaErrors.some((error) => error.includes('inside exactly one observed NUMA node')))

  const unavailable = structuredClone(testHardware)
  unavailable.topology.numa = { status: 'unavailable', reason: 'NUMA sysfs is hidden by the container', nodes: [] }
  const unavailableErrors = validateRuntimeProfileResult(numa, { expectedHardware: unavailable })
  assert.ok(unavailableErrors.some((error) => error.includes('without NUMA topology')))
})

test('selection policy rejects noisy or single-run profile claims', () => {
  const runs = [
    createResult('throughput-musl', 1),
    createResult('candidate', 1)
  ]
  const comparison = summarizeRuntimeRuns(runs, 'throughput-musl')
  const result = evaluateRuntimeProfileSelection(comparison, 'candidate')
  assert.equal(result.eligible, false)
  assert.ok(result.errors.some((error) => error.includes('at least 3 samples')))
})

test('startup-only gains remain a named startup conclusion and cannot replace throughput default', () => {
  const runs = []
  for (let round = 1; round <= 3; round += 1) {
    const baseline = createResult('throughput-musl', round)
    const startup = createResult('startup-musl-r2r', round)
    startup.measurements.coldStartMs = 60
    startup.measurements.readyMs = 90
    startup.measurements.warmupMs = 500
    for (const route of Object.values(startup.measurements.routes)) {
      route.safeRps = baseline.measurements.routes.l0.safeRps
      route.p999Ms = baseline.measurements.routes.l0.p999Ms
    }
    startup.measurements.rssPeakBytes = baseline.measurements.rssPeakBytes
    runs.push(baseline, startup)
  }
  const comparison = summarizeRuntimeRuns(runs, 'throughput-musl')
  assert.equal(comparison.conclusions.startup.lowestColdStartProfileId, 'startup-musl-r2r')
  const result = evaluateRuntimeProfileSelection(comparison, 'startup-musl-r2r', {
    maximumGcPauseP99Ms: 10,
    maximumReadyMs: 1000,
    maximumRolloutMs: 10000,
    maximumRecoveryMs: 10000,
    maximumBlueGreenOverlapBytes: 1000000000
  })
  assert.equal(result.eligible, false)
  assert.ok(result.errors.some((error) => error.includes('startup-only improvement')))
})

test('selection rejects a single-route regression and enforces absolute lifecycle budgets', () => {
  const runs = []
  for (let round = 1; round <= 3; round += 1) {
    const baseline = createResult('throughput-musl', round)
    const candidate = createResult('candidate', round)
    for (const route of Object.values(candidate.measurements.routes)) route.safeRps += 100
    candidate.measurements.routes['db-miss'].safeRps = 700
    runs.push(baseline, candidate)
  }
  const comparison = summarizeRuntimeRuns(runs, 'throughput-musl')
  assert.equal(comparison.profiles.candidate.safeRpsFloorMedian, 700)
  assert.equal(comparison.profiles.candidate.routes['db-miss'].safeRpsMedian, 700)
  const result = evaluateRuntimeProfileSelection(comparison, 'candidate', {
    maximumGcPauseP99Ms: 10,
    maximumReadyMs: 1000,
    maximumRolloutMs: 10000,
    maximumRecoveryMs: 10000,
    maximumBlueGreenOverlapBytes: 1000000000
  })
  assert.equal(result.eligible, false)
  assert.ok(result.errors.some((error) => error.includes('db-miss safe RPS regresses')))
})

test('measurement contract rejects invented unavailable power, invalid IPC and unproven ThreadPool tuning', () => {
  const result = createResult('threadpool-evidence-derived', 1)
  result.measurements.routes.l0.ipc = 9
  result.measurements.power.startupJoules = 1
  delete result.threadPoolEvidence
  result.measurements.resourceStress.blueGreen.publicSnapshotBytes = 0
  result.measurements.resourceStress.oomRecoveryMs = 10
  const errors = validateRuntimeProfileResult(result, result.identity)
  assert.ok(errors.some((error) => error.includes('ipc does not match')))
  assert.ok(errors.some((error) => error.includes('cannot invent numeric values')))
  assert.ok(errors.some((error) => error.includes('requires starvation evidence')))
  assert.ok(errors.some((error) => error.includes('slot/snapshot/SSR breakdown')))
  assert.ok(errors.some((error) => error.includes('must be null when no OOM probe applies')))
})

test('successful profile results require concrete runtime, image, SDK, Node and memory identity', () => {
  const result = createResult('throughput-musl', 1)
  result.effectiveRuntime.imageDigest = 'sha256:mutable'
  result.effectiveRuntime.runtimeVersion = '10.0'
  result.effectiveRuntime.sdkVersion = 'latest'
  delete result.effectiveRuntime.runtimeBaseImageDigest
  result.effectiveRuntime.sdkBaseImageDigest = 'sha256:missing'
  result.effectiveRuntime.nodeVersion = 'current'
  result.execution.targetMemoryBytes = 0
  const errors = validateRuntimeProfileResult(result, result.identity)
  for (const expected of [
    'effectiveRuntime.imageDigest',
    'effectiveRuntime.runtimeVersion',
    'effectiveRuntime.sdkVersion',
    'effectiveRuntime.runtimeBaseImageDigest',
    'effectiveRuntime.sdkBaseImageDigest',
    'effectiveRuntime.nodeVersion',
    'execution.targetMemoryBytes'
  ]) assert.ok(errors.some((error) => error.includes(expected)), expected)
})

test('publish scripts and Dockerfile consume the named profile instead of restoring split hardcoded defaults', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'ops/docker/FsusBlog.Server.Dockerfile'), 'utf8')
  const frontendBuild = dockerfile.slice(dockerfile.indexOf('FROM node-runtime-musl AS frontend-build'))
  const nativeBuild = fs.readFileSync(path.join(root, 'tools/build-native.sh'), 'utf8')
  const finalBuild = fs.readFileSync(path.join(root, 'tools/build-final-image.sh'), 'utf8')
  const collector = fs.readFileSync(path.join(root, 'tools/operations/collect-release-evidence.sh'), 'utf8')
  const ensureWasm = fs.readFileSync(path.join(root, 'tools/frontend/ensure-wasm.mjs'), 'utf8')
  assert.match(dockerfile, /FROM base-\$\{RUNTIME_BASE_FLAVOR\} AS base/u)
  assert.match(dockerfile, /FROM build-\$\{RUNTIME_BASE_FLAVOR\} AS build/u)
  assert.match(dockerfile, /mcr\.microsoft\.com\/dotnet\/aspnet:\$\{DOTNET_RUNTIME_VERSION\}-noble@\$\{DOTNET_ASPNET_GLIBC_DIGEST\} AS base-glibc/u)
  assert.match(dockerfile, /mcr\.microsoft\.com\/dotnet\/sdk:\$\{DOTNET_SDK_VERSION\}-noble@\$\{DOTNET_SDK_GLIBC_DIGEST\} AS build-glibc/u)
  assert.doesNotMatch(dockerfile, /10\.0-bookworm-slim/u)
  assert.ok(dockerfile.indexOf('RUN git clone https://github.com/microsoft/vcpkg.git') < dockerfile.indexOf('COPY tools/frontend/ /work/tools/frontend/'))
  assert.match(dockerfile, /io\.fsusblog\.runtime\.profile-manifest-digest/u)
  assert.match(dockerfile, /\/p:PublishReadyToRun="\$PUBLISH_READY_TO_RUN"/u)
  assert.match(dockerfile, /dotnet restore[^\n]+\/p:PublishReadyToRun="\$PUBLISH_READY_TO_RUN"[^\n]+\/p:ReadyToRunUseCrossgen2="\$PUBLISH_READY_TO_RUN"/u)
  assert.match(dockerfile, /COPY --from=fsusui \/vue\/packages \/opt\/fsusui\/vue\/packages/u)
  assert.match(dockerfile, /ln -s \/app\/node_modules \/opt\/fsusui\/node_modules/u)
  assert.match(dockerfile, /FSUSBLOG_LOCAL_FSUSUI_ROOT=\/opt\/fsusui/u)
  assert.match(dockerfile, /io\.fsusblog\.build\.fsusui-commit/u)
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*-H "Host: \$host"[\s\S]*\/health\/live/u)
  assert.ok(
    frontendBuild.indexOf('RUN --mount=type=secret,id=github_packages_token')
      < frontendBuild.indexOf('ARG FSUSBLOG_RELEASE_ID=local-unversioned'),
    'release identity must not invalidate the npm dependency layer',
  )
  assert.match(nativeBuild, /resolve-runtime-publish-profile\.mjs/u)
  assert.match(finalBuild, /--runtime-profile-manifest-digest/u)
  assert.match(finalBuild, /NativeAOT is a conditional narrow prototype/u)
  assert.match(finalBuild, /--build-context "fsusui=\$FSUSUI_CONTEXT_DIR"/u)
  assert.match(finalBuild, /FSUSBLOG_LOCAL_FSUSUI_ROOT is required/u)
  assert.match(finalBuild, /local FsusUI source must be a clean Git worktree/u)
  assert.match(collector, /check-runtime-publish-evidence\.mjs/u)
  assert.match(collector, /FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST/u)
  assert.match(collector, /--expected-profile-id/u)
  assert.match(collector, /--expected-commit-sha/u)
  assert.match(collector, /--expected-profile-manifest-digest/u)
  assert.match(collector, /--expected-profile-digest/u)
  assert.match(collector, /runtime matrix profile identity does not match the release manifest/u)
  assert.match(ensureWasm, /ignoredWasmDirectories[\s\S]*'stage'/u)
  assert.doesNotMatch(nativeBuild, /\/p:PublishReadyToRun=true/u)
})

test('NativeAOT prototype executor rejects a plan without feature and security parity stages', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-nativeaot-plan-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const loaded = readRuntimeProfileManifest()
  const profile = loaded.manifest.profiles.find((candidate) => candidate.id === 'nativeaot-public-prototype')
  const request = {
    schema: 'fsusblog.runtime-publish-profile-request.v1',
    identity: {
      commitSha,
      fixtureId,
      hardwareDigest,
      profileManifestDigest: loaded.digest,
      profileDigest: sha256Value(profile),
      profileId: profile.id,
      round: 1,
      position: 1
    },
    profile,
    cooldownMs: 0,
    cooldownObservedMs: 0
  }
  const fixtureCommand = path.join(root, 'tests/tools/fixtures/runtime-profile-plan-command.mjs')
  const command = { file: process.execPath, args: [fixtureCommand], timeoutMs: 10000 }
  const plan = {
    schema: 'fsusblog.runtime-publish-executor-plan.v1',
    isolation: { targetCpuset: '0', loadGeneratorCpuset: '1', targetCgroup: '/fsus/target', loadGeneratorCgroup: '/fsus/loadgen' },
    commands: Object.fromEntries(['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'].map((name) => [name, command]))
  }
  const requestFile = path.join(directory, 'request.json')
  const planFile = path.join(directory, 'plan.json')
  fs.writeFileSync(requestFile, JSON.stringify(request))
  fs.writeFileSync(planFile, JSON.stringify(plan))
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/execute-runtime-publish-profile.mjs'),
    '--request', requestFile,
    '--output', path.join(directory, 'result.json'),
    '--plan', planFile
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, FSUSBLOG_RUNTIME_MATRIX_EXECUTOR: '1' } })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /featureParity/u)
})

test('stage adapter derives gate and measurement provenance from fresh confined artifacts', (t) => {
  const gate = runStageAdapterFixture(t, { stage: 'correctness' })
  assert.equal(gate.result.status, 0, gate.result.stderr)
  const gateReceipt = JSON.parse(fs.readFileSync(gate.receiptFile, 'utf8'))
  assert.equal(gateReceipt.evidence.gate, 'correctness')
  assert.match(gateReceipt.evidence.evidenceDigest, /^sha256:[0-9a-f]{64}$/u)

  const measurement = runStageAdapterFixture(t, { stage: 'measure' })
  assert.equal(measurement.result.status, 0, measurement.result.stderr)
  const measurementReceipt = JSON.parse(fs.readFileSync(measurement.receiptFile, 'utf8'))
  for (const field of ['payloadDigest', 'faultPlanDigest', 'loadFixtureDigest']) assert.match(measurementReceipt.evidence[field], /^sha256:[0-9a-f]{64}$/u)

  const parity = runStageAdapterFixture(t, { stage: 'featureParity', profileId: 'nativeaot-public-prototype' })
  assert.equal(parity.result.status, 0, parity.result.stderr)
  const parityReceipt = JSON.parse(fs.readFileSync(parity.receiptFile, 'utf8'))
  assert.equal(parityReceipt.evidence.scope, 'public-artifact-only')
  assert.match(parityReceipt.evidence.featureSetDigest, /^sha256:[0-9a-f]{64}$/u)
})

test('stage adapter rejects missing, stale, tampered, escaping and symlink artifacts', (t) => {
  const cases = [
    ['missing', 'correctness', /unable to read|ENOENT/u],
    ['stale-identity', 'correctness', /identity is stale/u],
    ['tampered-status', 'correctness', /schema\/status\/stage is invalid/u],
    ['escape', 'correctness', /artifactPath is invalid|artifact path is invalid|escapes the stage artifact root/u],
    ['symlink', 'correctness', /symlink/u],
    ['root-symlink', 'correctness', /artifact root/u],
    ['missing', 'measure', /unable to read|ENOENT/u]
  ]
  for (const [mode, stage, message] of cases) {
    const invocation = runStageAdapterFixture(t, { stage, mode })
    assert.notEqual(invocation.result.status, 0, `${mode}:${stage} unexpectedly passed`)
    assert.match(invocation.result.stderr, message)
    assert.equal(fs.existsSync(invocation.receiptFile), false)
  }
})

test('NativeAOT parity receipts bind the actual built feature-set digest', () => {
  const result = createResult('nativeaot-public-prototype', 1)
  assert.deepEqual(validateRuntimeProfileResult(result), [])
  result.execution.commandReceipts.find((receipt) => receipt.stage === 'securityParity').evidence.featureSetDigest = sha256Value({ tampered: true })
  assert.ok(validateRuntimeProfileResult(result).some((error) => error.includes('featureSetDigest must match the built prototype')))
})

test('measurement claim digest rejects post-receipt metric tampering', () => {
  const result = createResult('throughput-musl', 1)
  result.measurements.routes.l0.p999Ms += 1
  assert.ok(validateRuntimeProfileResult(result).some((error) => error.includes('measurementClaimDigest')))
})

test('matrix runner seals partial checkpoint evidence through the executor protocol', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-matrix-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'evidence.json')
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    '--executor', path.join(root, 'tests/tools/fixtures/runtime-profile-executor.mjs'),
    '--output', output,
    '--commit-sha', commitSha,
    '--fixture-id', fixtureId,
    '--profiles', 'throughput-musl,throughput-glibc',
    '--rounds', '1',
    '--cooldown-ms', '0'
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(evidence.status, 'partial')
  assert.equal(evidence.runs.length, 2)
  assert.deepEqual(validateRuntimeMatrixEvidence(evidence, { requireComplete: false }), [])
})

test('matrix runner retains a structured failed result from a non-zero executor', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-matrix-failure-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'evidence.json')
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    '--executor', path.join(root, 'tests/tools/fixtures/runtime-profile-failing-executor.mjs'),
    '--output', output,
    '--commit-sha', commitSha,
    '--fixture-id', fixtureId,
    '--profiles', 'throughput-musl,throughput-glibc',
    '--rounds', '1',
    '--cooldown-ms', '0'
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(evidence.status, 'partial')
  assert.equal(evidence.runs.length, 2)
  assert.ok(evidence.runs.every((run) => run.status === 'failed'))
  assert.ok(evidence.runs.every((run) => run.error === 'fixture retained the executor failure detail'))
  assert.deepEqual(validateRuntimeMatrixEvidence(evidence, { requireComplete: false }), [])
})

test('matrix runner resumes only failed schedule keys and retains every attempt', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-matrix-resume-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'evidence.json')
  const commonArgs = [
    '--executor', path.join(root, 'tests/tools/fixtures/runtime-profile-executor.mjs'),
    '--output', output,
    '--commit-sha', commitSha,
    '--fixture-id', fixtureId,
    '--profiles', 'throughput-musl,throughput-glibc',
    '--rounds', '1',
    '--cooldown-ms', '0'
  ]
  const initial = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.equal(initial.status, 0, initial.stderr)
  const checkpoint = JSON.parse(fs.readFileSync(output, 'utf8'))
  const failedIdentity = structuredClone(checkpoint.runs[0].identity)
  checkpoint.runs[0] = {
    schema: RUNTIME_PROFILE_RESULT_SCHEMA,
    status: 'failed',
    identity: failedIdentity,
    error: 'fixture failed before resume'
  }
  checkpoint.comparison = summarizeRuntimeRuns(checkpoint.runs, checkpoint.comparison.baselineProfileId)
  fs.writeFileSync(output, `${JSON.stringify(checkpoint, null, 2)}\n`)

  const resumed = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs,
    '--resume-from', output
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.equal(resumed.status, 0, resumed.stderr)
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(evidence.runs.length, 3)
  const resumedKey = evidence.runs.filter((run) => run.identity.round === failedIdentity.round && run.identity.profileId === failedIdentity.profileId)
  assert.deepEqual(resumedKey.map((run) => run.status), ['failed', 'ok'])
  const untouched = evidence.runs.filter((run) => run.identity.profileId !== failedIdentity.profileId)
  assert.equal(untouched.length, 1)
  assert.equal(untouched[0].status, 'ok')
  assert.deepEqual(validateRuntimeMatrixEvidence(evidence, { requireComplete: false }), [])

  const wrongIdentity = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs.map((value) => value === commitSha ? 'f'.repeat(40) : value),
    '--resume-from', output
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(wrongIdentity.status, 0)
  assert.match(wrongIdentity.stderr, /identity\.commitSha does not match/u)

  const wrongFixture = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs.map((value) => value === fixtureId ? 'other-production-fixture' : value),
    '--resume-from', output
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(wrongFixture.status, 0)
  assert.match(wrongFixture.stderr, /identity\.fixtureId does not match/u)

  const manifestDriftFile = path.join(directory, 'manifest-drift.json')
  const manifestDrift = structuredClone(evidence)
  manifestDrift.identity.profileManifestDigest = `sha256:${'d'.repeat(64)}`
  for (const run of manifestDrift.runs) {
    run.identity.profileManifestDigest = manifestDrift.identity.profileManifestDigest
    for (const receipt of run.execution?.commandReceipts ?? []) receipt.identity.profileManifestDigest = manifestDrift.identity.profileManifestDigest
  }
  fs.writeFileSync(manifestDriftFile, `${JSON.stringify(manifestDrift, null, 2)}\n`)
  const wrongManifest = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs,
    '--resume-from', manifestDriftFile
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(wrongManifest.status, 0)
  assert.match(wrongManifest.stderr, /identity\.profileManifestDigest does not match/u)

  const hardwareDriftFile = path.join(directory, 'hardware-drift.json')
  const hardwareDrift = structuredClone(evidence)
  hardwareDrift.hardware.resumeTestMarker = 'different-machine'
  hardwareDrift.identity.hardwareDigest = sha256Value(hardwareDrift.hardware)
  for (const run of hardwareDrift.runs) {
    run.identity.hardwareDigest = hardwareDrift.identity.hardwareDigest
    for (const receipt of run.execution?.commandReceipts ?? []) receipt.identity.hardwareDigest = hardwareDrift.identity.hardwareDigest
  }
  fs.writeFileSync(hardwareDriftFile, `${JSON.stringify(hardwareDrift, null, 2)}\n`)
  const wrongHardware = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs,
    '--resume-from', hardwareDriftFile
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(wrongHardware.status, 0)
  assert.match(wrongHardware.stderr, /identity\.hardwareDigest does not match/u)

  const scheduleDriftFile = path.join(directory, 'schedule-drift.json')
  const scheduleDrift = structuredClone(evidence)
  const firstPosition = scheduleDrift.schedule[0].position
  const secondPosition = scheduleDrift.schedule[1].position
  scheduleDrift.schedule[0].position = secondPosition
  scheduleDrift.schedule[1].position = firstPosition
  for (const run of scheduleDrift.runs) {
    const entry = scheduleDrift.schedule.find((candidate) => candidate.round === run.identity.round && candidate.profileId === run.identity.profileId)
    run.identity.position = entry.position
    for (const receipt of run.execution?.commandReceipts ?? []) receipt.identity.position = entry.position
  }
  fs.writeFileSync(scheduleDriftFile, `${JSON.stringify(scheduleDrift, null, 2)}\n`)
  const wrongSchedule = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    ...commonArgs,
    '--resume-from', scheduleDriftFile
  ], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.notEqual(wrongSchedule.status, 0)
  assert.match(wrongSchedule.stderr, /schedule does not match/u)
})

test('full matrix default excludes conditional NativeAOT admission without hiding required axes', () => {
  const runner = fs.readFileSync(path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'), 'utf8')
  assert.match(runner, /profile\.conditionalAdmission === undefined/u)
  assert.match(runner, /sameIds\(selectedIds, requiredProfileIds\)/u)
  assert.doesNotMatch(runner, /selectedIds\.length === loaded\.manifest\.profiles\.length/u)
})

test('plan-driven executor runs cleanup, gates and measurement with isolated target and loadgen identities', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-plan-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'evidence.json')
  const fixtureCommand = path.join(root, 'tests/tools/fixtures/runtime-profile-plan-command.mjs')
  const sitePlanFile = path.join(directory, 'site-plan.json')
  const siteCommand = { file: process.execPath, args: [fixtureCommand], timeoutMs: 10000 }
  fs.writeFileSync(sitePlanFile, `${JSON.stringify({
    schema: 'fsusblog.runtime-publish-stage-site-plan.v1',
    commands: Object.fromEntries(['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'].map((name) => [name, siteCommand]))
  })}\n`)
  const command = {
    file: process.execPath,
    args: [path.join(root, 'tools/runtime-profiles/runtime-profile-stage.mjs'), '--site-plan', sitePlanFile],
    timeoutMs: 10000
  }
  const plan = {
    schema: 'fsusblog.runtime-publish-executor-plan.v1',
    isolation: { strategy: 'auto-balanced', cgroupPrefix: '/fsus/auto' },
    commands: Object.fromEntries(['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'].map((name) => [name, command]))
  }
  const planFile = path.join(directory, 'plan.json')
  fs.writeFileSync(planFile, `${JSON.stringify(plan)}\n`)
  const dockerBin = createRuntimeDockerShim(directory, readRuntimeProfileManifest().digest)
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    '--executor', path.join(root, 'tools/runtime-profiles/execute-runtime-publish-profile.mjs'),
    '--output', output,
    '--commit-sha', commitSha,
    '--fixture-id', fixtureId,
    '--profiles', 'throughput-musl,throughput-glibc',
    '--rounds', '1',
    '--cooldown-ms', '0'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${dockerBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FSUSBLOG_RUNTIME_MATRIX_PLAN: planFile,
      FSUSBLOG_RUNTIME_AVAILABLE_CPUSET: '0-3'
    }
  })
  assert.equal(result.status, 0, result.stderr)
  const evidence = JSON.parse(fs.readFileSync(output, 'utf8'))
  assert.equal(evidence.runs.length, 2)
  assert.ok(evidence.runs.every((run) => run.status === 'ok'), evidence.runs.map((run) => run.error ?? run.status).join('\n'))
  for (const run of evidence.runs) {
    assert.equal(run.execution.cleanupBefore, 'pass')
    assert.equal(run.execution.cleanupAfter, 'pass')
    assert.equal(run.execution.commandReceipts.length, 7)
    assert.equal(run.execution.loadGeneratorIsolated, true)
    assert.equal(run.execution.targetCpuset, '0-1')
    assert.equal(run.execution.observedTargetCpuset, '0-1')
    assert.equal(run.execution.loadGeneratorCpuset, '2-3')
    assert.equal(run.execution.targetCgroup, '/fsus/auto/target')
    assert.equal(run.execution.loadGeneratorCgroup, '/fsus/auto/loadgen')
    assert.equal(run.execution.targetMemoryBytes, 4294967296)
    assert.equal(run.effectiveRuntime.runtimeVersion, '10.0.10')
    assert.equal(run.effectiveRuntime.sdkVersion, '10.0.302')
    assert.equal(run.effectiveRuntime.nodeVersion, 'v24.16.0')
  }

  const driftOutput = path.join(directory, 'bad-image-receipt.json')
  const drift = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/run-runtime-publish-matrix.mjs'),
    '--executor', path.join(root, 'tools/runtime-profiles/execute-runtime-publish-profile.mjs'),
    '--output', driftOutput,
    '--commit-sha', commitSha,
    '--fixture-id', fixtureId,
    '--profiles', 'throughput-musl,throughput-glibc',
    '--rounds', '1',
    '--cooldown-ms', '0'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PATH: `${dockerBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FSUSBLOG_RUNTIME_MATRIX_PLAN: planFile,
      FSUSBLOG_RUNTIME_AVAILABLE_CPUSET: '0-3',
      FSUSBLOG_RUNTIME_FAKE_DOCKER_BAD_PROFILE_LABEL: '1'
    }
  })
  assert.equal(drift.status, 0, drift.stderr)
  const rejected = JSON.parse(fs.readFileSync(driftOutput, 'utf8'))
  assert.ok(rejected.runs.every((run) => run.status === 'failed'))
  assert.ok(rejected.runs.every((run) => run.error.includes('inspected image label io.fsusblog.runtime.profile-id')))
})

test('auto-balanced isolation fails closed when fewer than two CPUs are visible', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-runtime-auto-cpu-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const loaded = readRuntimeProfileManifest()
  const profile = loaded.manifest.profiles.find((candidate) => candidate.id === 'throughput-musl')
  const request = {
    schema: 'fsusblog.runtime-publish-profile-request.v1',
    identity: {
      commitSha,
      fixtureId,
      hardwareDigest,
      profileManifestDigest: loaded.digest,
      profileDigest: sha256Value(profile),
      profileId: profile.id,
      round: 1,
      position: 1
    },
    profile,
    cooldownMs: 0,
    cooldownObservedMs: 0
  }
  const fixtureCommand = path.join(root, 'tests/tools/fixtures/runtime-profile-plan-command.mjs')
  const command = { file: process.execPath, args: [fixtureCommand], timeoutMs: 10000 }
  const plan = {
    schema: 'fsusblog.runtime-publish-executor-plan.v1',
    isolation: { strategy: 'auto-balanced', cgroupPrefix: '/fsus/auto' },
    commands: Object.fromEntries(['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter'].map((name) => [name, command]))
  }
  const requestFile = path.join(directory, 'request.json')
  const planFile = path.join(directory, 'plan.json')
  fs.writeFileSync(requestFile, `${JSON.stringify(request)}\n`)
  fs.writeFileSync(planFile, `${JSON.stringify(plan)}\n`)
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/execute-runtime-publish-profile.mjs'),
    '--request', requestFile,
    '--output', path.join(directory, 'result.json'),
    '--plan', planFile
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_RUNTIME_MATRIX_EXECUTOR: '1',
      FSUSBLOG_RUNTIME_AVAILABLE_CPUSET: '0'
    }
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /at least two visible CPUs/u)
})

function createResult(profileId, round, overrides = {}) {
  const profileOffset = profileId.length
  const declaredProfile = readRuntimeProfileManifest().manifest.profiles.find((profile) => profile.id === profileId)
  const threadPoolMode = declaredProfile?.threadPool.mode ?? 'runtime-default'
  const selectedMinThreadsPerCpu = threadPoolMode === 'evidence-derived' ? 10 : (declaredProfile?.threadPool.minThreadsPerCpu ?? 0)
  const baseImageFamily = declaredProfile?.baseImageFamily ?? 'musl'
  const targetCpuset = overrides.targetCpuset ?? '0'
  const targetCpuCount = targetCpuset.split(',').flatMap((part) => {
    const [start, end = start] = part.split('-').map(Number)
    return Array.from({ length: end - start + 1 })
  }).length
  const gcHeapCountMode = declaredProfile?.gc.heapCountMode ?? 'container-default'
  const gcHeapHardLimitMode = declaredProfile?.gc.heapHardLimitMode ?? 'container-limit'
  const gcHeapHardLimitPercent = declaredProfile?.gc.heapHardLimitPercent ?? 0
  const targetMemoryBytes = overrides.targetMemoryBytes ?? 4294967296
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
    identity: {
      commitSha,
      fixtureId,
      hardwareDigest,
      profileManifestDigest: overrides.profileManifestDigest ?? `sha256:${'b'.repeat(64)}`,
      profileDigest: overrides.profileDigest ?? `sha256:${'c'.repeat(64)}`,
      profileId,
      round,
      position: overrides.position ?? 1
    },
    gates: { correctness: 'pass', security: 'pass', release: 'pass' },
    effectiveRuntime: {
      imageDigest: overrides.imageDigest ?? sha256Value({ kind: 'runtime-image', profileId }),
      runtimeVersion: overrides.runtimeVersion ?? '10.0.10',
      sdkVersion: overrides.sdkVersion ?? '10.0.302',
      runtimeBaseImageDigest: overrides.runtimeBaseImageDigest ?? sha256Value({ kind: 'runtime-base', baseImageFamily }),
      sdkBaseImageDigest: overrides.sdkBaseImageDigest ?? sha256Value({ kind: 'sdk-base', baseImageFamily }),
      nodeVersion: overrides.nodeVersion ?? 'v24.16.0',
      profilePurpose: declaredProfile?.purpose ?? 'experiment',
      singleFile: declaredProfile?.publish.singleFile ?? true,
      readyToRun: declaredProfile?.publish.readyToRun ?? false,
      tieredPgo: declaredProfile?.publish.tieredPgo ?? true,
      quickJitForLoops: declaredProfile?.publish.quickJitForLoops ?? true,
      threadPoolMode,
      threadPoolMinThreadsPerCpuDeclared: declaredProfile?.threadPool.minThreadsPerCpu ?? 0,
      threadPoolMinThreadsPerCpu: selectedMinThreadsPerCpu,
      serverGc: declaredProfile?.gc.server ?? true,
      nativeAot: declaredProfile?.publish.nativeAot ?? false,
      gcHeapCountMode,
      gcHeapHardLimitMode,
      gcHeapHardLimitPercentConfigured: gcHeapHardLimitPercent,
      gcHeapCountConfigured: gcHeapCountMode === 'cpuset' ? targetCpuCount : 0,
      gcHeapHardLimitBytesConfigured: gcHeapHardLimitMode === 'explicit-container-percent' ? Math.floor(targetMemoryBytes * gcHeapHardLimitPercent / 100) : 0,
      baseImageFamily,
      targetRuntime: declaredProfile?.targetRuntime ?? 'linux-musl-x64',
      topologyMode: declaredProfile?.topology.mode ?? 'smt-visible'
    },
    ...(threadPoolMode === 'evidence-derived' ? {
      threadPoolEvidence: { selectedMinThreadsPerCpu, baselineStarvationCount: 1, baselineQueueP99: 2 }
    } : {}),
    execution: {
      cooldownRequestedMs: 0,
      cooldownObservedMs: 0,
      cleanupBefore: 'pass',
      cleanupAfter: 'pass',
      measurementWindowQuiet: true,
      loadGeneratorIsolated: true,
      targetCpuset,
      observedTargetCpuset: targetCpuset,
      loadGeneratorCpuset: '1',
      targetCgroup: '/fsus/target',
      loadGeneratorCgroup: '/fsus/loadgen',
      targetMemoryBytes
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
        oomOutcome: gcHeapHardLimitMode === 'explicit-container-percent' ? 'bounded-rejection' : 'not-applicable',
        oomRecoveryMs: gcHeapHardLimitMode === 'explicit-container-percent' ? 250 : null,
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
      routes: Object.fromEntries(['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr'].map((name) => [name, { ...route }]))
    }
  }
  result.execution.commandReceipts = createStageReceipts(result)
  result.execution.measurementClaimDigest = createRuntimeMeasurementClaimDigest(result)
  return result
}

function runStageAdapterFixture(t, { stage, mode = 'valid', profileId = 'throughput-musl' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fsusblog-runtime-stage-${stage}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const loaded = readRuntimeProfileManifest()
  const profile = loaded.manifest.profiles.find((candidate) => candidate.id === profileId)
  const request = {
    schema: 'fsusblog.runtime-publish-profile-request.v1',
    identity: {
      commitSha,
      fixtureId,
      hardwareDigest,
      profileManifestDigest: loaded.digest,
      profileDigest: sha256Value(profile),
      profileId,
      round: 1,
      position: 1
    },
    profile,
    cooldownMs: 0,
    cooldownObservedMs: 0
  }
  const fixtureCommand = path.join(root, 'tests/tools/fixtures/runtime-profile-plan-command.mjs')
  const command = { file: process.execPath, args: [fixtureCommand], timeoutMs: 10000 }
  const commands = Object.fromEntries(['cleanupBefore', 'build', 'correctness', 'security', 'release', 'featureParity', 'securityParity', 'measure', 'cleanupAfter'].map((name) => [name, command]))
  const sitePlanFile = path.join(directory, 'site-plan.json')
  const receiptFile = path.join(directory, 'receipt.json')
  fs.writeFileSync(sitePlanFile, `${JSON.stringify({ schema: 'fsusblog.runtime-publish-stage-site-plan.v1', commands })}\n`)
  const result = spawnSync(process.execPath, [
    path.join(root, 'tools/runtime-profiles/runtime-profile-stage.mjs'),
    '--site-plan', sitePlanFile
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FSUSBLOG_RUNTIME_EXECUTOR_STAGE: stage,
      FSUSBLOG_RUNTIME_PROFILE_REQUEST: JSON.stringify(request),
      FSUSBLOG_RUNTIME_STAGE_RECEIPT_OUTPUT: receiptFile,
      FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT: path.join(directory, 'measurements.json'),
      FSUSBLOG_RUNTIME_TARGET_CPUSET: '0',
      FSUSBLOG_RUNTIME_LOADGEN_CPUSET: '1',
      FSUSBLOG_RUNTIME_TARGET_CGROUP: '/fsus/target',
      FSUSBLOG_RUNTIME_LOADGEN_CGROUP: '/fsus/loadgen',
      FSUSBLOG_RUNTIME_TARGET_CPU_COUNT: '1',
      FSUSBLOG_RUNTIME_FIXTURE_ARTIFACT_MODE: mode,
      FSUSBLOG_RUNTIME_FIXTURE_ARTIFACT_STAGE: stage
    }
  })
  return { result, receiptFile }
}

function createStageReceipts(result) {
  const stages = ['cleanupBefore', 'build', 'correctness', 'security', 'release']
  if (result.effectiveRuntime.nativeAot) stages.push('featureParity', 'securityParity')
  stages.push('measure', 'cleanupAfter')
  const featureSetDigest = sha256Value({ fixture: 'feature-set', profileId: result.identity.profileId })
  return stages.map((stage) => {
    let evidence
    if (stage.startsWith('cleanup')) evidence = { kind: 'cleanup', cleanupTargetsDigest: sha256Value({ stage, identity: result.identity }) }
    else if (stage === 'build') evidence = {
      kind: 'build',
      imageRef: `fixture/${result.identity.profileId}@${result.effectiveRuntime.imageDigest}`,
      imageDigest: result.effectiveRuntime.imageDigest,
      artifactManifestDigest: sha256Value({ fixture: 'artifacts', profileId: result.identity.profileId }),
      featureSetDigest
    }
    else if (['correctness', 'security', 'release'].includes(stage)) evidence = {
      kind: 'gate', gate: stage, gateStatus: 'pass', evidenceDigest: sha256Value({ fixture: 'gate', stage, identity: result.identity })
    }
    else if (stage.endsWith('Parity')) evidence = {
      kind: 'parity',
      parity: stage === 'featureParity' ? 'feature' : 'security',
      scope: 'public-artifact-only',
      parityStatus: 'pass',
      evidenceDigest: sha256Value({ fixture: 'parity', stage, identity: result.identity }),
      featureSetDigest
    }
    else evidence = {
      kind: 'measurement',
      payloadDigest: sha256Value(result.measurements),
      faultPlanDigest: sha256Value({ fixture: 'fault-plan', profileId: result.identity.profileId }),
      loadFixtureDigest: sha256Value({ fixture: 'load', fixtureId: result.identity.fixtureId })
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
      resultDigest: sha256Value({ fixture: 'stage-result', stage, identity: result.identity }),
      evidence
    }
  })
}

function createCompleteMatrixEvidence() {
  const loaded = readRuntimeProfileManifest()
  const profileIds = loaded.manifest.profiles.map((profile) => profile.id)
  const schedule = createBalancedSchedule(profileIds, 3, 'runtime-identity-gate')
  const runs = schedule.map((entry) => createResult(entry.profileId, entry.round, {
    profileManifestDigest: loaded.digest,
    profileDigest: sha256Value(loaded.manifest.profiles.find((profile) => profile.id === entry.profileId)),
    position: entry.position
  }))
  const evidence = {
    schema: RUNTIME_MATRIX_EVIDENCE_SCHEMA,
    status: 'complete',
    identity: { commitSha, fixtureId, profileManifestDigest: loaded.digest, hardwareDigest },
    hardware: testHardware,
    rounds: 3,
    profileIds,
    schedule,
    runs,
    comparison: summarizeRuntimeRuns(runs, loaded.manifest.defaultProfile)
  }
  evidence.selection = sealRuntimeProfileSelection(evidence, selectionPolicy)
  return evidence
}
