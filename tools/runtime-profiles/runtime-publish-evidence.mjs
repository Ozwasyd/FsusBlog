import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { canonicalJson, sha256Value } from './runtime-publish-profile.mjs'

export const RUNTIME_MATRIX_EVIDENCE_SCHEMA = 'fsusblog.runtime-publish-matrix-evidence.v2'
export const RUNTIME_PROFILE_RESULT_SCHEMA = 'fsusblog.runtime-publish-profile-result.v1'
export const RUNTIME_PROFILE_SELECTION_SCHEMA = 'fsusblog.runtime-publish-selection.v1'
export const RUNTIME_PROFILE_SELECTION_POLICY_SCHEMA = 'fsusblog.runtime-publish-selection-policy.v1'
export const REQUIRED_RUNTIME_ROUTES = ['l0', 'l1', 'l2', 'db-miss', 'notification', 'aot-ssr']
const COMMIT_SHA = /^[0-9a-f]{40}$/u
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u
const RUNTIME_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const NODE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const STAGE_RECEIPT_SCHEMA = 'fsusblog.runtime-publish-stage-receipt.v1'

export function createBalancedSchedule(profileIds, rounds, seed) {
  if (!Array.isArray(profileIds) || profileIds.length < 2 || new Set(profileIds).size !== profileIds.length) {
    throw new Error('profileIds must contain at least two unique entries')
  }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 30) throw new Error('rounds must be between 1 and 30')
  const hash = crypto.createHash('sha256').update(String(seed)).digest()
  const base = [...profileIds]
  const offset = hash.readUInt32BE(0) % base.length
  const direction = hash[4] % 2 === 0 ? 1 : -1
  const ordered = base.map((_, index) => base[(offset + direction * index + base.length * 2) % base.length])
  const schedule = []
  for (let round = 0; round < rounds; round += 1) {
    const rotation = round % ordered.length
    const roundProfiles = [...ordered.slice(rotation), ...ordered.slice(0, rotation)]
    if (round % 2 === 1) roundProfiles.reverse()
    roundProfiles.forEach((profileId, position) => schedule.push({ round: round + 1, position: position + 1, profileId }))
  }
  return schedule
}

export function captureHardwareIdentity() {
  const cpu = os.cpus()[0]
  const cpuset = readFirst(['/sys/fs/cgroup/cpuset.cpus.effective', '/sys/fs/cgroup/cpuset/cpuset.cpus'])
  const cpuMaxV2 = readFirst(['/sys/fs/cgroup/cpu.max'])
  const cpuQuotaV1 = readFirst(['/sys/fs/cgroup/cpu/cpu.cfs_quota_us'])
  const cpuPeriodV1 = readFirst(['/sys/fs/cgroup/cpu/cpu.cfs_period_us'])
  const cpuMax = cpuMaxV2 ?? (cpuQuotaV1 && cpuPeriodV1 ? `${cpuQuotaV1} ${cpuPeriodV1}` : null)
  const memoryMax = readFirst(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'])
  const microcode = readFirst(['/sys/devices/system/cpu/cpu0/microcode/version'])
  const hostLogicalCpuCount = Math.max(1, os.cpus().length)
  const hostMemoryBytes = os.totalmem()
  const identity = {
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    cpuModel: cpu?.model?.trim() || 'unknown',
    logicalCpuCount: resolveContainerVisibleCpuCount(hostLogicalCpuCount, cpuset, cpuMax),
    topology: captureCpuTopology(cpuset, hostLogicalCpuCount),
    totalMemoryBytes: resolveContainerVisibleMemoryBytes(hostMemoryBytes, memoryMax),
    cpuset: cpuset || 'unavailable',
    cpuMax: cpuMax || 'unavailable',
    memoryMax: memoryMax || 'unavailable',
    microcode: microcode || 'unavailable',
    dockerServerVersion: commandVersion('docker', ['version', '--format', '{{.Server.Version}}']),
    dotnetVersion: commandVersion('dotnet', ['--version']),
    nodeVersion: process.version
  }
  return { identity, digest: sha256Value(identity) }
}

export function resolveContainerVisibleCpuCount(hostLogicalCpuCount, cpuset, cpuMax) {
  const candidates = [positiveInteger(hostLogicalCpuCount) ?? 1]
  const cpus = parseCpuSet(cpuset)
  if (cpus?.size) candidates.push(cpus.size)
  const match = String(cpuMax ?? '').trim().match(/^(max|\d+)\s+(\d+)$/u)
  if (match && match[1] !== 'max') {
    const quota = Number(match[1])
    const period = Number(match[2])
    if (quota > 0 && period > 0) candidates.push(Math.max(1, Math.ceil(quota / period)))
  }
  return Math.min(...candidates)
}

export function resolveContainerVisibleMemoryBytes(hostMemoryBytes, memoryMax) {
  const host = positiveSafeInteger(hostMemoryBytes) ?? 1
  const text = String(memoryMax ?? '').trim()
  if (!/^\d+$/u.test(text)) return host
  const limit = Number(text)
  if (!Number.isSafeInteger(limit) || limit <= 0) return host
  return Math.min(host, limit)
}

export function resolveRuntimeProfileAvailability(profiles, hardware) {
  if (!Array.isArray(profiles)) throw new Error('profiles must be an array')
  const topology = hardware?.topology
  const unsupportedProfiles = []
  for (const profile of profiles) {
    if (profile?.topology?.mode === 'physical-core-only' && topology?.status !== 'ok') {
      unsupportedProfiles.push({
        profileId: profile.id,
        capability: 'cpu-topology',
        status: 'unavailable',
        reason: `CPU topology is unavailable: ${boundedReason(topology?.reason ?? 'hardware topology was not captured')}`
      })
    }
    if (profile?.topology?.mode === 'numa-local' && topology?.numa?.status !== 'ok') {
      const status = topology?.numa?.status === 'not-applicable' ? 'not-applicable' : 'unavailable'
      unsupportedProfiles.push({
        profileId: profile.id,
        capability: 'numa-topology',
        status,
        reason: `NUMA topology is ${status}: ${boundedReason(topology?.numa?.reason ?? 'NUMA topology was not captured')}`
      })
    }
  }
  const unsupportedIds = new Set(unsupportedProfiles.map((entry) => entry.profileId))
  return {
    profiles: profiles.filter((profile) => !unsupportedIds.has(profile.id)),
    unsupportedProfiles
  }
}

export function validateRuntimeProfileResult(result, expected = {}) {
  const errors = []
  if (!plainObject(result)) return ['result must be an object']
  if (result.schema !== RUNTIME_PROFILE_RESULT_SCHEMA) errors.push(`schema must be ${RUNTIME_PROFILE_RESULT_SCHEMA}`)
  if (!['ok', 'failed'].includes(result.status)) errors.push('status must be ok or failed')
  if (!plainObject(result.identity)) errors.push('identity is required')
  const identity = result.identity ?? {}
  if (!COMMIT_SHA.test(String(identity.commitSha ?? ''))) errors.push('identity.commitSha is invalid')
  if (!SAFE_ID.test(String(identity.fixtureId ?? ''))) errors.push('identity.fixtureId is invalid')
  if (!SAFE_ID.test(String(identity.profileId ?? ''))) errors.push('identity.profileId is invalid')
  if (!SHA256.test(String(identity.profileDigest ?? ''))) errors.push('identity.profileDigest is invalid')
  if (!SHA256.test(String(identity.profileManifestDigest ?? ''))) errors.push('identity.profileManifestDigest is invalid')
  if (!SHA256.test(String(identity.hardwareDigest ?? ''))) errors.push('identity.hardwareDigest is invalid')
  if (!Number.isInteger(identity.round) || identity.round < 1) errors.push('identity.round is invalid')
  if (!Number.isInteger(identity.position) || identity.position < 1) errors.push('identity.position is invalid')
  for (const [key, expectedValue] of Object.entries(expected).filter(([key]) => !['cooldownMs', 'expectedProfile', 'expectedHardware'].includes(key))) {
    if (expectedValue !== undefined && identity[key] !== expectedValue) errors.push(`identity.${key} does not match the run request`)
  }
  if (result.status === 'failed') {
    if (typeof result.error !== 'string' || result.error.trim().length < 3 || result.error.length > 2048) errors.push('failed result requires a bounded error')
    return errors
  }
  if (!plainObject(result.gates)) errors.push('gates are required for successful results')
  for (const gate of ['correctness', 'security', 'release']) if (result.gates?.[gate] !== 'pass') errors.push(`gates.${gate} must be pass`)
  validateEffectiveRuntime(result.effectiveRuntime, result, errors)
  if (expected.expectedProfile) validateEffectiveProfileBinding(result.effectiveRuntime, expected.expectedProfile, errors)
  validateExecution(result.execution, expected.cooldownMs, result.effectiveRuntime?.topologyMode, expected.expectedHardware, errors)
  validateStageReceipts(result.execution?.commandReceipts, result, errors)
  if (result.execution?.measurementClaimDigest !== createRuntimeMeasurementClaimDigest(result)) errors.push('execution.measurementClaimDigest does not bind the effective runtime and measurements')
  validateMeasurements(result.measurements, result, errors)
  return errors
}

export function createRuntimeMeasurementClaimDigest(result) {
  const execution = result?.execution ?? {}
  return sha256Value({
    effectiveRuntime: result?.effectiveRuntime ?? null,
    threadPoolEvidence: result?.threadPoolEvidence ?? null,
    isolation: {
      measurementWindowQuiet: execution.measurementWindowQuiet,
      loadGeneratorIsolated: execution.loadGeneratorIsolated,
      targetCpuset: execution.targetCpuset,
      observedTargetCpuset: execution.observedTargetCpuset,
      loadGeneratorCpuset: execution.loadGeneratorCpuset,
      targetCgroup: execution.targetCgroup,
      loadGeneratorCgroup: execution.loadGeneratorCgroup,
      targetMemoryBytes: execution.targetMemoryBytes
    },
    stageReceipts: Array.isArray(execution.commandReceipts)
      ? execution.commandReceipts.map((receipt) => ({ stage: receipt?.stage, resultDigest: receipt?.resultDigest, evidence: receipt?.evidence }))
      : null,
    measurements: result?.measurements ?? null
  })
}

function validateEffectiveProfileBinding(value, profile, errors) {
  if (!plainObject(value)) return
  const expected = {
    profilePurpose: profile.purpose,
    threadPoolMode: profile.threadPool.mode,
    threadPoolMinThreadsPerCpuDeclared: profile.threadPool.minThreadsPerCpu,
    singleFile: profile.publish.singleFile,
    readyToRun: profile.publish.readyToRun,
    tieredPgo: profile.publish.tieredPgo,
    quickJitForLoops: profile.publish.quickJitForLoops,
    serverGc: profile.gc.server,
    nativeAot: profile.publish.nativeAot,
    gcHeapCountMode: profile.gc.heapCountMode,
    gcHeapHardLimitMode: profile.gc.heapHardLimitMode,
    gcHeapHardLimitPercentConfigured: profile.gc.heapHardLimitPercent,
    baseImageFamily: profile.baseImageFamily,
    targetRuntime: profile.targetRuntime,
    topologyMode: profile.topology.mode
  }
  for (const [field, expectedValue] of Object.entries(expected)) if (value[field] !== expectedValue) errors.push(`effectiveRuntime.${field} does not match the named profile`)
  if (profile.threadPool.mode !== 'evidence-derived' && value.threadPoolMinThreadsPerCpu !== profile.threadPool.minThreadsPerCpu) {
    errors.push('effectiveRuntime.threadPoolMinThreadsPerCpu does not match the named profile')
  }
}

function validateEffectiveRuntime(value, result, errors) {
  if (!plainObject(value)) return errors.push('effectiveRuntime evidence is required')
  for (const field of ['imageDigest', 'runtimeBaseImageDigest', 'sdkBaseImageDigest']) {
    if (!SHA256.test(String(value[field] ?? ''))) errors.push(`effectiveRuntime.${field} must be sha256:<64 lowercase hex>`)
  }
  for (const field of ['runtimeVersion', 'sdkVersion']) {
    if (!RUNTIME_VERSION.test(String(value[field] ?? ''))) errors.push(`effectiveRuntime.${field} must be a concrete semantic version`)
  }
  if (!NODE_VERSION.test(String(value.nodeVersion ?? ''))) errors.push('effectiveRuntime.nodeVersion must be a concrete semantic version')
  if (!['throughput', 'startup', 'experiment', 'negative-control', 'prototype'].includes(value.profilePurpose)) errors.push('effectiveRuntime.profilePurpose is invalid')
  for (const field of ['singleFile', 'readyToRun', 'tieredPgo', 'quickJitForLoops', 'serverGc', 'nativeAot']) {
    if (typeof value[field] !== 'boolean') errors.push(`effectiveRuntime.${field} must be boolean`)
  }
  if (!['runtime-default', 'evidence-derived', 'overprovisioned-negative-control'].includes(value.threadPoolMode)) errors.push('effectiveRuntime.threadPoolMode is invalid')
  if (!Number.isInteger(value.threadPoolMinThreadsPerCpu) || value.threadPoolMinThreadsPerCpu < 0 || value.threadPoolMinThreadsPerCpu > 256) errors.push('effectiveRuntime.threadPoolMinThreadsPerCpu is invalid')
  if (!Number.isInteger(value.threadPoolMinThreadsPerCpuDeclared) || value.threadPoolMinThreadsPerCpuDeclared < 0 || value.threadPoolMinThreadsPerCpuDeclared > 256) errors.push('effectiveRuntime.threadPoolMinThreadsPerCpuDeclared is invalid')
  if (value.serverGc !== true) errors.push('effectiveRuntime.serverGc must be true')
  if (!['container-default', 'cpuset'].includes(value.gcHeapCountMode)) errors.push('effectiveRuntime.gcHeapCountMode is invalid')
  if (!['container-limit', 'explicit-container-percent'].includes(value.gcHeapHardLimitMode)) errors.push('effectiveRuntime.gcHeapHardLimitMode is invalid')
  if (!Number.isInteger(value.gcHeapCountConfigured) || value.gcHeapCountConfigured < 0 || value.gcHeapCountConfigured > 4096) errors.push('effectiveRuntime.gcHeapCountConfigured is invalid')
  if (!Number.isSafeInteger(value.gcHeapHardLimitBytesConfigured) || value.gcHeapHardLimitBytesConfigured < 0) errors.push('effectiveRuntime.gcHeapHardLimitBytesConfigured is invalid')
  if (!Number.isInteger(value.gcHeapHardLimitPercentConfigured) || value.gcHeapHardLimitPercentConfigured < 0 || value.gcHeapHardLimitPercentConfigured > 95) errors.push('effectiveRuntime.gcHeapHardLimitPercentConfigured is invalid')
  if (!['musl', 'glibc'].includes(value.baseImageFamily)) errors.push('effectiveRuntime.baseImageFamily is invalid')
  if (!['linux-musl-x64', 'linux-x64'].includes(value.targetRuntime)) errors.push('effectiveRuntime.targetRuntime is invalid')
  if (!['smt-visible', 'physical-core-only', 'numa-local'].includes(value.topologyMode)) errors.push('effectiveRuntime.topologyMode is invalid')
  if (value.threadPoolMode === 'runtime-default' && value.threadPoolMinThreadsPerCpu !== 0) errors.push('runtime-default cannot force ThreadPool minimums')
  if (value.threadPoolMode === 'evidence-derived') {
    const evidence = result.threadPoolEvidence
    if (!plainObject(evidence)) errors.push('evidence-derived ThreadPool requires starvation evidence')
    else {
      if (!Number.isInteger(evidence.selectedMinThreadsPerCpu) || evidence.selectedMinThreadsPerCpu <= 0 || evidence.selectedMinThreadsPerCpu !== value.threadPoolMinThreadsPerCpu) errors.push('ThreadPool selected minimum must match sealed evidence')
      if (!finiteNonNegative(evidence.baselineStarvationCount) || !finiteNonNegative(evidence.baselineQueueP99)) errors.push('ThreadPool baseline starvation and queue evidence are required')
      if (evidence.baselineStarvationCount <= 0 && evidence.baselineQueueP99 <= 0) errors.push('ThreadPool evidence-derived mode requires observed starvation or queueing')
    }
  }
  if (value.threadPoolMode === 'overprovisioned-negative-control' && value.profilePurpose !== 'negative-control') errors.push('overprovisioned ThreadPool mode must remain a negative control')
  const targetCpus = parseCpuSet(result.execution?.targetCpuset)
  if (value.gcHeapCountMode === 'container-default' && value.gcHeapCountConfigured !== 0) errors.push('container-default GC heap count cannot force a configured value')
  if (value.gcHeapCountMode === 'cpuset' && (!targetCpus || value.gcHeapCountConfigured !== targetCpus.size)) errors.push('cpuset GC heap count must equal the isolated target CPU count')
  const targetMemoryBytes = result.execution?.targetMemoryBytes
  if (value.gcHeapHardLimitMode === 'container-limit' && (value.gcHeapHardLimitBytesConfigured !== 0 || value.gcHeapHardLimitPercentConfigured !== 0)) errors.push('container-limit GC mode cannot force a heap hard limit')
  const expectedHardLimitBytes = Number.isSafeInteger(targetMemoryBytes) ? Math.floor(targetMemoryBytes * value.gcHeapHardLimitPercentConfigured / 100) : -1
  if (value.gcHeapHardLimitMode === 'explicit-container-percent' && (value.gcHeapHardLimitPercentConfigured < 1 || value.gcHeapHardLimitBytesConfigured !== expectedHardLimitBytes)) {
    errors.push('explicit GC heap hard limit must exactly match the named profile percentage of process-visible memory')
  }
}

function validateExecution(value, expectedCooldownMs, topologyMode, hardware, errors) {
  if (!plainObject(value)) return errors.push('execution evidence is required')
  if (!Number.isSafeInteger(value.targetMemoryBytes) || value.targetMemoryBytes <= 0) errors.push('execution.targetMemoryBytes must be a positive safe integer')
  if (!finiteNonNegative(value.cooldownRequestedMs) || !finiteNonNegative(value.cooldownObservedMs)) errors.push('execution cooldown values must be finite and non-negative')
  if (expectedCooldownMs !== undefined && value.cooldownRequestedMs !== expectedCooldownMs) errors.push('execution.cooldownRequestedMs does not match the run request')
  if (finiteNonNegative(value.cooldownRequestedMs) && finiteNonNegative(value.cooldownObservedMs) && value.cooldownObservedMs < value.cooldownRequestedMs) errors.push('execution cooldown was shorter than requested')
  if (value.cleanupBefore !== 'pass' || value.cleanupAfter !== 'pass') errors.push('execution cleanup must pass before and after the run')
  if (value.measurementWindowQuiet !== true) errors.push('execution measurement window must be quiet')
  if (value.loadGeneratorIsolated !== true) errors.push('execution load generator must be isolated from the target')
  for (const field of ['targetCpuset', 'observedTargetCpuset', 'loadGeneratorCpuset', 'targetCgroup', 'loadGeneratorCgroup']) {
    if (typeof value[field] !== 'string' || value[field].trim().length === 0 || value[field].length > 256) errors.push(`execution.${field} is invalid`)
  }
  if (value.targetCgroup === value.loadGeneratorCgroup) errors.push('execution target and load generator cgroups must differ')
  const targetCpus = parseCpuSet(value.targetCpuset)
  const observedTargetCpus = parseCpuSet(value.observedTargetCpuset)
  const loadCpus = parseCpuSet(value.loadGeneratorCpuset)
  if (!targetCpus || !observedTargetCpus || !loadCpus) errors.push('execution cpusets are invalid')
  else if ([...targetCpus].some((cpu) => loadCpus.has(cpu))) errors.push('execution target and load generator cpusets must be disjoint')
  if (targetCpus && observedTargetCpus && !setsEqual(targetCpus, observedTargetCpus)) errors.push('execution observed target cpuset does not match the requested placement')
  validateTopologyPlacement(observedTargetCpus, topologyMode, hardware, errors)
}

function validateStageReceipts(receipts, result, errors) {
  if (!Array.isArray(receipts)) return errors.push('execution.commandReceipts must contain provenance for every stage')
  const expectedStages = ['cleanupBefore', 'build', 'correctness', 'security', 'release']
  if (result.effectiveRuntime?.nativeAot === true) expectedStages.push('featureParity', 'securityParity')
  expectedStages.push('measure', 'cleanupAfter')
  if (canonicalJson(receipts.map((receipt) => receipt?.stage)) !== canonicalJson(expectedStages)) errors.push('execution.commandReceipts stage order is incomplete or invalid')
  const byStage = new Map()
  for (const receipt of receipts) {
    const stage = receipt?.stage ?? 'unknown'
    if (byStage.has(stage)) errors.push(`execution.commandReceipts duplicates ${stage}`)
    byStage.set(stage, receipt)
    if (!plainObject(receipt) || receipt.schema !== STAGE_RECEIPT_SCHEMA || receipt.status !== 'pass') {
      errors.push(`execution.commandReceipts ${stage} schema/status is invalid`)
      continue
    }
    if (canonicalJson(receipt.identity) !== canonicalJson(result.identity)) errors.push(`execution.commandReceipts ${stage} identity does not match the run`)
    for (const field of ['resultDigest']) if (!SHA256.test(String(receipt[field] ?? ''))) errors.push(`execution.commandReceipts ${stage}.${field} is invalid`)
    if (!plainObject(receipt.command) || receipt.command.exitCode !== 0 || !finiteNonNegative(receipt.command.durationMs)) errors.push(`execution.commandReceipts ${stage}.command is invalid`)
    for (const field of ['executableDigest', 'argsDigest']) if (!SHA256.test(String(receipt.command?.[field] ?? ''))) errors.push(`execution.commandReceipts ${stage}.command.${field} is invalid`)
    const expectedKind = expectedStageEvidenceKind(stage)
    if (!plainObject(receipt.evidence) || receipt.evidence.kind !== expectedKind) errors.push(`execution.commandReceipts ${stage}.evidence kind is invalid`)
    for (const field of stageEvidenceDigestFields(stage)) if (!SHA256.test(String(receipt.evidence?.[field] ?? ''))) errors.push(`execution.commandReceipts ${stage}.evidence.${field} is invalid`)
  }
  const build = byStage.get('build')?.evidence
  if (build?.imageDigest !== result.effectiveRuntime?.imageDigest || !String(build?.imageRef ?? '').endsWith(`@${build?.imageDigest ?? '<missing>'}`)) {
    errors.push('build receipt image identity must match the inspected effective image')
  }
  for (const stage of ['correctness', 'security', 'release']) {
    const evidence = byStage.get(stage)?.evidence
    if (evidence?.gate !== stage || evidence?.gateStatus !== 'pass') errors.push(`${stage} stage receipt must prove the named gate`)
  }
  if (result.effectiveRuntime?.nativeAot === true) {
    for (const [stage, parity] of [['featureParity', 'feature'], ['securityParity', 'security']]) {
      const evidence = byStage.get(stage)?.evidence
      if (evidence?.parity !== parity || evidence?.scope !== 'public-artifact-only' || evidence?.parityStatus !== 'pass') errors.push(`${stage} receipt must prove narrow ${parity} parity`)
      if (evidence?.featureSetDigest !== build?.featureSetDigest) errors.push(`${stage} featureSetDigest must match the built prototype`)
    }
  }
}

function expectedStageEvidenceKind(stage) {
  if (stage.startsWith('cleanup')) return 'cleanup'
  if (stage === 'build') return 'build'
  if (['correctness', 'security', 'release'].includes(stage)) return 'gate'
  if (stage.endsWith('Parity')) return 'parity'
  return 'measurement'
}

function stageEvidenceDigestFields(stage) {
  if (stage.startsWith('cleanup')) return ['cleanupTargetsDigest']
  if (stage === 'build') return ['imageDigest', 'artifactManifestDigest', 'featureSetDigest']
  if (['correctness', 'security', 'release'].includes(stage)) return ['evidenceDigest']
  if (stage.endsWith('Parity')) return ['evidenceDigest', 'featureSetDigest']
  return ['payloadDigest', 'faultPlanDigest', 'loadFixtureDigest']
}

export function validateRuntimeMatrixEvidence(evidence, options = {}) {
  const errors = []
  if (!plainObject(evidence)) return ['evidence must be an object']
  if (evidence.schema !== RUNTIME_MATRIX_EVIDENCE_SCHEMA) errors.push(`schema must be ${RUNTIME_MATRIX_EVIDENCE_SCHEMA}`)
  if (!['complete', 'partial'].includes(evidence.status)) errors.push('status must be complete or partial')
  const validatesCompleteEvidence = options.requireComplete !== false || evidence.status === 'complete'
  if (options.requireComplete !== false && evidence.status !== 'complete') errors.push('evidence must be complete')
  const identity = evidence.identity ?? {}
  if (!COMMIT_SHA.test(String(identity.commitSha ?? ''))) errors.push('identity.commitSha is invalid')
  if (options.expectedCommitSha !== undefined && identity.commitSha !== options.expectedCommitSha) errors.push('identity.commitSha does not match the release commit')
  if (!SAFE_ID.test(String(identity.fixtureId ?? ''))) errors.push('identity.fixtureId is invalid')
  if (!SHA256.test(String(identity.profileManifestDigest ?? ''))) errors.push('identity.profileManifestDigest is invalid')
  if (!SHA256.test(String(identity.hardwareDigest ?? ''))) errors.push('identity.hardwareDigest is invalid')
  validateHardwareTopology(evidence.hardware, errors)
  if (plainObject(evidence.hardware) && identity.hardwareDigest !== sha256Value(evidence.hardware)) errors.push('identity.hardwareDigest does not bind the hardware evidence')
  if (!Number.isInteger(evidence.rounds) || evidence.rounds < 1) errors.push('rounds is invalid')
  if (validatesCompleteEvidence && evidence.rounds < 3) errors.push('complete evidence requires at least three rounds')
  if (!Array.isArray(evidence.catalogProfileIds) || evidence.catalogProfileIds.length < 2 || new Set(evidence.catalogProfileIds).size !== evidence.catalogProfileIds.length) {
    errors.push('catalogProfileIds are invalid')
  }
  if (!Array.isArray(evidence.profileIds) || evidence.profileIds.length < 2 || new Set(evidence.profileIds).size !== evidence.profileIds.length) errors.push('profileIds are invalid')
  validateUnsupportedProfiles(evidence.unsupportedProfiles, evidence.hardware, evidence.catalogProfileIds, evidence.profileIds, errors)
  if (validatesCompleteEvidence && Array.isArray(evidence.catalogProfileIds) && Array.isArray(evidence.profileIds) && Array.isArray(evidence.unsupportedProfiles)) {
    const covered = [...evidence.profileIds, ...evidence.unsupportedProfiles.map((entry) => entry.profileId)]
    if (covered.length !== evidence.catalogProfileIds.length ||
        new Set(covered).size !== covered.length ||
        evidence.catalogProfileIds.some((profileId) => !covered.includes(profileId))) {
      errors.push('profileIds and unsupportedProfiles must exactly cover catalogProfileIds')
    }
  }
  if (!Array.isArray(evidence.schedule) || !Array.isArray(evidence.runs)) {
    errors.push('schedule and runs are required')
    return errors
  }
  const expectedCount = evidence.rounds * evidence.profileIds.length
  if (evidence.schedule.length !== expectedCount) errors.push('schedule must contain every profile exactly once per round')
  const scheduleByKey = new Map()
  for (let round = 1; round <= evidence.rounds; round += 1) {
    const entries = evidence.schedule.filter((entry) => entry.round === round)
    if (entries.length !== evidence.profileIds.length) errors.push(`round ${round} schedule is incomplete`)
    const ids = entries.map((entry) => entry.profileId)
    if (new Set(ids).size !== evidence.profileIds.length || evidence.profileIds.some((id) => !ids.includes(id))) errors.push(`round ${round} schedule is not exact-once`)
    const positions = entries.map((entry) => entry.position)
    if (positions.some((position) => !Number.isInteger(position) || position < 1 || position > evidence.profileIds.length) || new Set(positions).size !== entries.length) {
      errors.push(`round ${round} schedule positions are invalid`)
    }
    for (const entry of entries) {
      const key = `${entry.round}:${entry.profileId}`
      if (scheduleByKey.has(key)) errors.push(`duplicate schedule entry ${key}`)
      scheduleByKey.set(key, entry)
    }
  }
  const attemptsByKey = new Map()
  for (const result of evidence.runs) {
    const key = `${result.identity?.round}:${result.identity?.profileId}`
    const scheduleEntry = scheduleByKey.get(key)
    const resultErrors = validateRuntimeProfileResult(result, {
      commitSha: identity.commitSha,
      fixtureId: identity.fixtureId,
      profileManifestDigest: identity.profileManifestDigest,
      hardwareDigest: identity.hardwareDigest,
      ...(scheduleEntry ? {
        round: scheduleEntry.round,
        position: scheduleEntry.position,
        profileId: scheduleEntry.profileId
      } : {}),
      expectedHardware: evidence.hardware
    })
    errors.push(...resultErrors.map((error) => `${result.identity?.profileId ?? 'unknown'} round ${result.identity?.round ?? '?'}: ${error}`))
    if (!scheduleEntry) {
      errors.push(`unscheduled run ${key}`)
      continue
    }
    const attempts = attemptsByKey.get(key) ?? []
    if (attempts.some((attempt) => attempt.status === 'ok')) errors.push(`run ${key} has an attempt after its successful result`)
    attempts.push(result)
    attemptsByKey.set(key, attempts)
  }
  if (validatesCompleteEvidence) {
    for (const key of scheduleByKey.keys()) {
      const attempts = attemptsByKey.get(key) ?? []
      const successful = attempts.filter((attempt) => attempt.status === 'ok')
      if (successful.length !== 1 || attempts.at(-1)?.status !== 'ok') errors.push(`complete evidence requires exactly one final successful result for ${key}`)
    }
    validateMatrixRuntimeIdentity(evidence.runs.filter((run) => run.status === 'ok'), errors)
  }
  if (validatesCompleteEvidence && !plainObject(evidence.comparison)) errors.push('complete evidence requires pairwise and Pareto comparison')
  else if (validatesCompleteEvidence) {
    validateComparison(evidence.comparison, evidence.profileIds, evidence.rounds, errors)
    const expectedComparison = summarizeRuntimeRuns(
      evidence.runs.filter((run) => run.status === 'ok'),
      evidence.comparison.baselineProfileId
    )
    if (sha256Value(evidence.comparison) !== sha256Value(expectedComparison)) errors.push('comparison must be derived exactly from the successful run evidence')
  }
  if (validatesCompleteEvidence) validateSelection(evidence, options, errors)
  else if (evidence.selection !== null && evidence.selection !== undefined) errors.push('partial evidence cannot contain a production selection')
  return errors
}

function validateUnsupportedProfiles(value, hardware, catalogProfileIds, profileIds, errors) {
  if (!Array.isArray(value)) return errors.push('unsupportedProfiles must be an array')
  const expectedById = new Map()
  const topology = hardware?.topology
  if (topology?.status !== 'ok') {
    expectedById.set('physical-core-only', {
      capability: 'cpu-topology',
      status: 'unavailable',
      reason: `CPU topology is unavailable: ${boundedReason(topology?.reason ?? 'hardware topology was not captured')}`
    })
  }
  if (topology?.numa?.status !== 'ok') {
    const status = topology?.numa?.status === 'not-applicable' ? 'not-applicable' : 'unavailable'
    expectedById.set('numa-local', {
      capability: 'numa-topology',
      status,
      reason: `NUMA topology is ${status}: ${boundedReason(topology?.numa?.reason ?? 'NUMA topology was not captured')}`
    })
  }
  const seen = new Set()
  for (const entry of value) {
    if (!plainObject(entry)) {
      errors.push('unsupportedProfiles entries must be objects')
      continue
    }
    if (!SAFE_ID.test(String(entry.profileId ?? '')) || seen.has(entry.profileId)) errors.push('unsupportedProfiles profileId is invalid or duplicated')
    seen.add(entry.profileId)
    if (!Array.isArray(catalogProfileIds) || !catalogProfileIds.includes(entry.profileId)) errors.push(`unsupported profile ${entry.profileId ?? '<missing>'} is absent from catalogProfileIds`)
    if (Array.isArray(profileIds) && profileIds.includes(entry.profileId)) errors.push(`unsupported profile ${entry.profileId} cannot be scheduled`)
    const expected = expectedById.get(entry.profileId)
    if (!expected) {
      errors.push(`unsupported profile ${entry.profileId ?? '<missing>'} is not justified by captured hardware`)
      continue
    }
    if (entry.capability !== expected.capability) errors.push(`unsupported profile ${entry.profileId} capability does not match captured hardware`)
    if (entry.status !== expected.status) errors.push(`unsupported profile ${entry.profileId} status does not match captured hardware`)
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 3 || entry.reason.length > 512) errors.push(`unsupported profile ${entry.profileId} requires a bounded reason`)
    else if (entry.reason !== expected.reason) errors.push(`unsupported profile ${entry.profileId} reason does not match captured hardware`)
  }
  if (Array.isArray(catalogProfileIds)) {
    for (const [profileId] of expectedById) {
      if (catalogProfileIds.includes(profileId) && !seen.has(profileId)) errors.push(`captured hardware requires unsupported evidence for ${profileId}`)
    }
  }
}

function validateMatrixRuntimeIdentity(successfulRuns, errors) {
  requireOneRuntimeValue(successfulRuns, (run) => run.effectiveRuntime?.runtimeVersion, 'runtimeVersion', errors)
  requireOneRuntimeValue(successfulRuns, (run) => run.effectiveRuntime?.sdkVersion, 'sdkVersion', errors)
  requireOneRuntimeValue(successfulRuns, (run) => run.execution?.targetMemoryBytes, 'targetMemoryBytes', errors)

  for (const profileId of new Set(successfulRuns.map((run) => run.identity?.profileId))) {
    const runs = successfulRuns.filter((run) => run.identity?.profileId === profileId)
    requireOneRuntimeValue(runs, (run) => run.effectiveRuntime?.imageDigest, `profile ${profileId} imageDigest`, errors)
  }

  for (const baseImageFamily of new Set(successfulRuns.map((run) => run.effectiveRuntime?.baseImageFamily))) {
    const runs = successfulRuns.filter((run) => run.effectiveRuntime?.baseImageFamily === baseImageFamily)
    requireOneRuntimeValue(runs, (run) => run.effectiveRuntime?.runtimeBaseImageDigest, `${baseImageFamily} runtimeBaseImageDigest`, errors)
    requireOneRuntimeValue(runs, (run) => run.effectiveRuntime?.sdkBaseImageDigest, `${baseImageFamily} sdkBaseImageDigest`, errors)
    requireOneRuntimeValue(runs, (run) => run.effectiveRuntime?.nodeVersion, `${baseImageFamily} nodeVersion`, errors)
  }
}

function requireOneRuntimeValue(runs, selector, label, errors) {
  if (new Set(runs.map(selector)).size !== 1) errors.push(`complete evidence ${label} must be identical across successful runs`)
}

export function sealRuntimeProfileSelection(evidence, policy) {
  const policyErrors = validateRuntimeSelectionPolicy(policy)
  if (policyErrors.length > 0) throw new Error(policyErrors.join('\n'))
  if (!plainObject(evidence?.comparison) || !Array.isArray(evidence?.runs)) throw new Error('matrix comparison and runs are required before selection')
  const evaluation = evaluateRuntimeProfileSelection(evidence.comparison, policy.candidateProfileId, policy.options)
  if (policy.decision === 'select-candidate' && !evaluation.eligible) {
    throw new Error(`candidate is not eligible for production: ${evaluation.errors.join('; ')}`)
  }
  const selectedProfileId = policy.decision === 'select-candidate' ? policy.candidateProfileId : evaluation.baselineProfileId
  const selectedDigests = new Set(evidence.runs
    .filter((run) => run.status === 'ok' && run.identity?.profileId === selectedProfileId)
    .map((run) => run.identity?.profileDigest))
  if (selectedDigests.size !== 1 || !SHA256.test(String([...selectedDigests][0] ?? ''))) {
    throw new Error('selected profile runs do not bind exactly one profile digest')
  }
  return {
    schema: RUNTIME_PROFILE_SELECTION_SCHEMA,
    status: 'selected',
    decision: policy.decision,
    selectedProfileId,
    candidateProfileId: policy.candidateProfileId,
    baselineProfileId: evaluation.baselineProfileId,
    profileManifestDigest: evidence.identity?.profileManifestDigest,
    profileDigest: [...selectedDigests][0],
    comparisonDigest: sha256Value(evidence.comparison),
    policy: structuredClone(policy),
    evaluation
  }
}

export function validateRuntimeSelectionPolicy(policy) {
  const errors = []
  if (!plainObject(policy)) return ['selection policy must be an object']
  const allowed = new Set(['schema', 'decision', 'candidateProfileId', 'operatorReason', 'options'])
  for (const key of Object.keys(policy)) if (!allowed.has(key)) errors.push(`selection policy.${key} is not allowed`)
  if (policy.schema !== RUNTIME_PROFILE_SELECTION_POLICY_SCHEMA) errors.push(`selection policy schema must be ${RUNTIME_PROFILE_SELECTION_POLICY_SCHEMA}`)
  if (!['select-candidate', 'retain-baseline'].includes(policy.decision)) errors.push('selection policy decision must be select-candidate or retain-baseline')
  if (!SAFE_ID.test(String(policy.candidateProfileId ?? ''))) errors.push('selection policy candidateProfileId is invalid')
  if (typeof policy.operatorReason !== 'string' || policy.operatorReason.trim().length < 3 || policy.operatorReason.length > 512) errors.push('selection policy operatorReason must be bounded')
  if (!plainObject(policy.options)) return [...errors, 'selection policy options are required']
  const allowedOptions = new Set([
    'baselineProfileId',
    'minimumSamples',
    'maximumCvPercent',
    'minimumSafeRpsDeltaPercent',
    'maximumP999DeltaPercent',
    'maximumRssDeltaPercent',
    'maximumGcPauseDeltaPercent',
    'maximumReadyDeltaPercent',
    'maximumRolloutDeltaPercent',
    'maximumRecoveryDeltaPercent',
    'maximumBlueGreenOverlapDeltaPercent',
    'minimumMaterialDeltaPercent',
    'maximumGcPauseP99Ms',
    'maximumReadyMs',
    'maximumRolloutMs',
    'maximumRecoveryMs',
    'maximumBlueGreenOverlapBytes'
  ])
  for (const key of Object.keys(policy.options)) if (!allowedOptions.has(key)) errors.push(`selection policy options.${key} is not allowed`)
  if (policy.options.baselineProfileId !== undefined && !SAFE_ID.test(String(policy.options.baselineProfileId))) errors.push('selection policy options.baselineProfileId is invalid')
  if (policy.options.minimumSamples !== undefined && (!Number.isInteger(policy.options.minimumSamples) || policy.options.minimumSamples < 3)) errors.push('selection policy options.minimumSamples must be at least 3')
  for (const [key, value] of Object.entries(policy.options)) {
    if (key === 'baselineProfileId' || key === 'minimumSamples') continue
    if (!Number.isFinite(value)) errors.push(`selection policy options.${key} must be finite`)
  }
  for (const key of ['maximumGcPauseP99Ms', 'maximumReadyMs', 'maximumRolloutMs', 'maximumRecoveryMs', 'maximumBlueGreenOverlapBytes']) {
    if (!finiteNonNegative(policy.options[key])) errors.push(`selection policy options.${key} is required and must be non-negative`)
  }
  return errors
}

function validateSelection(evidence, options, errors) {
  const selection = evidence.selection
  if (!plainObject(selection)) return errors.push('complete evidence requires a sealed production selection')
  if (selection.schema !== RUNTIME_PROFILE_SELECTION_SCHEMA) errors.push(`selection.schema must be ${RUNTIME_PROFILE_SELECTION_SCHEMA}`)
  if (selection.status !== 'selected') errors.push('selection.status must be selected')
  let expected
  try {
    expected = sealRuntimeProfileSelection(evidence, selection.policy)
  } catch (error) {
    errors.push(`selection is invalid: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const field of ['decision', 'selectedProfileId', 'candidateProfileId', 'baselineProfileId', 'profileManifestDigest', 'profileDigest', 'comparisonDigest']) {
    if (selection[field] !== expected[field]) errors.push(`selection.${field} does not match the sealed matrix decision`)
  }
  if (sha256Value(selection.evaluation) !== sha256Value(expected.evaluation)) errors.push('selection.evaluation does not match the sealed matrix decision')
  if (options.expectedSelectedProfileId !== undefined && selection.selectedProfileId !== options.expectedSelectedProfileId) errors.push('selection.selectedProfileId does not match the release profile')
  if (options.expectedProfileManifestDigest !== undefined && selection.profileManifestDigest !== options.expectedProfileManifestDigest) errors.push('selection.profileManifestDigest does not match the release profile')
  if (options.expectedProfileDigest !== undefined && selection.profileDigest !== options.expectedProfileDigest) errors.push('selection.profileDigest does not match the release profile')
}

function validateComparison(comparison, profileIds, rounds, errors) {
  if (!plainObject(comparison.profiles) || !plainObject(comparison.pairwise) || !Array.isArray(comparison.paretoProfileIds) || !plainObject(comparison.conclusions)) {
    errors.push('comparison profiles, pairwise, Pareto and startup/steady conclusions are required')
    return
  }
  for (const field of ['startup', 'steadyState']) if (!plainObject(comparison.conclusions[field])) errors.push(`comparison conclusions.${field} is required`)
  for (const profileId of profileIds) {
    const profile = comparison.profiles[profileId]
    const pairwise = comparison.pairwise[profileId]
    if (!plainObject(profile) || profile.samples !== rounds) {
      errors.push(`comparison profile ${profileId} must summarize every round`)
      continue
    }
    if (!plainObject(pairwise) || !plainObject(pairwise.routes)) errors.push(`comparison pairwise ${profileId} is incomplete`)
    for (const routeName of REQUIRED_RUNTIME_ROUTES) {
      if (!plainObject(profile.routes?.[routeName])) errors.push(`comparison profile ${profileId} route ${routeName} is missing`)
      if (!plainObject(pairwise?.routes?.[routeName])) errors.push(`comparison pairwise ${profileId} route ${routeName} is missing`)
    }
  }
  const negativeControl = profileIds.find((profileId) => comparison.profiles?.[profileId]?.threadPoolMode === 'overprovisioned-negative-control')
  if (negativeControl) {
    const contrast = comparison.pairwise[negativeControl]
    for (const field of ['contextSwitchesDeltaPercent', 'rssDeltaPercent', 'p999DeltaPercent']) if (typeof contrast?.[field] !== 'number') errors.push(`negative control comparison requires ${field}`)
  }
}

export function summarizeRuntimeRuns(runs, baselineProfileId) {
  const successful = runs.filter((run) => run.status === 'ok')
  const profileIds = [...new Set(successful.map((run) => run.identity.profileId))]
  const profiles = Object.fromEntries(profileIds.map((profileId) => {
    const values = successful.filter((run) => run.identity.profileId === profileId)
    const perRunSafeRpsFloor = values.map((run) => Math.min(...Object.values(run.measurements.routes).map((route) => route.safeRps)))
    const perRunP999Ceiling = values.map((run) => Math.max(...Object.values(run.measurements.routes).map((route) => route.p999Ms)))
    const routes = Object.fromEntries(REQUIRED_RUNTIME_ROUTES.map((routeName) => {
      const safeRps = values.map((run) => run.measurements.routes[routeName].safeRps)
      const p999 = values.map((run) => run.measurements.routes[routeName].p999Ms)
      return [routeName, {
        safeRpsMedian: median(safeRps),
        safeRpsCvPercent: coefficientOfVariation(safeRps),
        p999MedianMs: median(p999),
        p999CvPercent: coefficientOfVariation(p999),
        ipcMedian: median(values.map((run) => run.measurements.routes[routeName].ipc))
      }]
    }))
    return [profileId, {
      samples: values.length,
      profilePurpose: values[0].effectiveRuntime.profilePurpose,
      threadPoolMode: values[0].effectiveRuntime.threadPoolMode,
      safeRpsFloorMedian: median(perRunSafeRpsFloor),
      safeRpsFloorCvPercent: coefficientOfVariation(perRunSafeRpsFloor),
      p999CeilingMedianMs: median(perRunP999Ceiling),
      p999CeilingCvPercent: coefficientOfVariation(perRunP999Ceiling),
      routes,
      rssPeakMedianBytes: median(values.map((run) => run.measurements.rssPeakBytes)),
      coldStartMedianMs: median(values.map((run) => run.measurements.coldStartMs)),
      readyMedianMs: median(values.map((run) => run.measurements.readyMs)),
      warmupMedianMs: median(values.map((run) => run.measurements.warmupMs)),
      rolloutMedianMs: median(values.map((run) => run.measurements.rolloutMs)),
      recoveryMedianMs: median(values.map((run) => run.measurements.recoveryMs)),
      gcPauseP99MedianMs: median(values.map((run) => run.measurements.gcPauseP99Ms)),
      blueGreenOverlapPeakMedianBytes: median(values.map((run) => run.measurements.blueGreenOverlapPeakBytes)),
      contextSwitchesMedian: median(values.map((run) => run.measurements.contextSwitches)),
      cpuMigrationsMedian: median(values.map((run) => run.measurements.cpuMigrations)),
      threadPoolQueueP99Median: median(values.map((run) => run.measurements.threadPoolQueueP99)),
      threadPoolStarvationMedian: median(values.map((run) => run.measurements.threadPoolStarvationCount))
    }]
  }))
  const baseline = profiles[baselineProfileId]
  const pairwise = baseline ? Object.fromEntries(Object.entries(profiles).map(([id, value]) => [id, {
    safeRpsDeltaPercent: percentDelta(value.safeRpsFloorMedian, baseline.safeRpsFloorMedian),
    p999DeltaPercent: percentDelta(value.p999CeilingMedianMs, baseline.p999CeilingMedianMs),
    rssDeltaPercent: percentDelta(value.rssPeakMedianBytes, baseline.rssPeakMedianBytes),
    coldStartDeltaPercent: percentDelta(value.coldStartMedianMs, baseline.coldStartMedianMs),
    readyDeltaPercent: percentDelta(value.readyMedianMs, baseline.readyMedianMs),
    rolloutDeltaPercent: percentDelta(value.rolloutMedianMs, baseline.rolloutMedianMs),
    recoveryDeltaPercent: percentDelta(value.recoveryMedianMs, baseline.recoveryMedianMs),
    gcPauseDeltaPercent: percentDelta(value.gcPauseP99MedianMs, baseline.gcPauseP99MedianMs),
    blueGreenOverlapDeltaPercent: percentDelta(value.blueGreenOverlapPeakMedianBytes, baseline.blueGreenOverlapPeakMedianBytes),
    contextSwitchesDeltaPercent: percentDelta(value.contextSwitchesMedian, baseline.contextSwitchesMedian),
    cpuMigrationsDeltaPercent: percentDelta(value.cpuMigrationsMedian, baseline.cpuMigrationsMedian),
    threadPoolQueueDeltaPercent: percentDelta(value.threadPoolQueueP99Median, baseline.threadPoolQueueP99Median),
    threadPoolStarvationDeltaPercent: percentDelta(value.threadPoolStarvationMedian, baseline.threadPoolStarvationMedian),
    routes: Object.fromEntries(REQUIRED_RUNTIME_ROUTES.map((routeName) => [routeName, {
      safeRpsDeltaPercent: percentDelta(value.routes[routeName].safeRpsMedian, baseline.routes[routeName].safeRpsMedian),
      p999DeltaPercent: percentDelta(value.routes[routeName].p999MedianMs, baseline.routes[routeName].p999MedianMs)
    }]))
  }])) : {}
  const pareto = Object.keys(profiles).filter((candidate) => !Object.keys(profiles).some((other) => other !== candidate && dominates(profiles[other], profiles[candidate])))
  const lowest = (selector) => profileIds.reduce((best, id) => best === null || selector(profiles[id]) < selector(profiles[best]) ? id : best, null)
  const highest = (selector) => profileIds.reduce((best, id) => best === null || selector(profiles[id]) > selector(profiles[best]) ? id : best, null)
  const conclusions = {
    startup: {
      lowestColdStartProfileId: lowest((profile) => profile.coldStartMedianMs),
      lowestReadyProfileId: lowest((profile) => profile.readyMedianMs),
      lowestWarmupProfileId: lowest((profile) => profile.warmupMedianMs)
    },
    steadyState: {
      highestSafeRpsProfileId: highest((profile) => profile.safeRpsFloorMedian),
      lowestP999ProfileId: lowest((profile) => profile.p999CeilingMedianMs),
      lowestRssProfileId: lowest((profile) => profile.rssPeakMedianBytes),
      paretoProfileIds: pareto
    }
  }
  return { baselineProfileId, profiles, pairwise, paretoProfileIds: pareto, conclusions }
}

export function evaluateRuntimeProfileSelection(comparison, candidateProfileId, options = {}) {
  const errors = []
  const baselineId = options.baselineProfileId ?? comparison?.baselineProfileId
  const baseline = comparison?.profiles?.[baselineId]
  const candidate = comparison?.profiles?.[candidateProfileId]
  if (!baseline) return { eligible: false, errors: ['baseline profile summary is missing'] }
  if (!candidate) return { eligible: false, errors: ['candidate profile summary is missing'] }
  const minimumSamples = options.minimumSamples ?? 3
  const maximumCvPercent = options.maximumCvPercent ?? 5
  if (baseline.samples < minimumSamples || candidate.samples < minimumSamples) errors.push(`baseline and candidate require at least ${minimumSamples} samples`)
  for (const [label, value] of [
    ['baseline safe RPS floor', baseline.safeRpsFloorCvPercent],
    ['baseline p99.9 ceiling', baseline.p999CeilingCvPercent],
    ['candidate safe RPS floor', candidate.safeRpsFloorCvPercent],
    ['candidate p99.9 ceiling', candidate.p999CeilingCvPercent]
  ]) if (!finiteNonNegative(value) || value > maximumCvPercent) errors.push(`${label} variance exceeds ${maximumCvPercent}%`)
  for (const routeName of REQUIRED_RUNTIME_ROUTES) {
    for (const [label, value] of [
      [`baseline ${routeName} safe RPS`, baseline.routes[routeName].safeRpsCvPercent],
      [`baseline ${routeName} p99.9`, baseline.routes[routeName].p999CvPercent],
      [`candidate ${routeName} safe RPS`, candidate.routes[routeName].safeRpsCvPercent],
      [`candidate ${routeName} p99.9`, candidate.routes[routeName].p999CvPercent]
    ]) if (!finiteNonNegative(value) || value > maximumCvPercent) errors.push(`${label} variance exceeds ${maximumCvPercent}%`)
  }
  const delta = comparison.pairwise?.[candidateProfileId]
  if (!delta) errors.push('candidate pairwise comparison is missing')
  else {
    if (delta.safeRpsDeltaPercent < (options.minimumSafeRpsDeltaPercent ?? -2)) errors.push('candidate safe RPS regresses beyond policy')
    if (delta.p999DeltaPercent > (options.maximumP999DeltaPercent ?? 5)) errors.push('candidate p99.9 regresses beyond policy')
    if (delta.rssDeltaPercent > (options.maximumRssDeltaPercent ?? 10)) errors.push('candidate RSS regresses beyond policy')
    if (delta.gcPauseDeltaPercent > (options.maximumGcPauseDeltaPercent ?? 5)) errors.push('candidate GC pause regresses beyond policy')
    if (delta.readyDeltaPercent > (options.maximumReadyDeltaPercent ?? 5)) errors.push('candidate ready time regresses beyond policy')
    if (delta.rolloutDeltaPercent > (options.maximumRolloutDeltaPercent ?? 5)) errors.push('candidate rollout time regresses beyond policy')
    if (delta.recoveryDeltaPercent > (options.maximumRecoveryDeltaPercent ?? 5)) errors.push('candidate recovery time regresses beyond policy')
    if (delta.blueGreenOverlapDeltaPercent > (options.maximumBlueGreenOverlapDeltaPercent ?? 5)) errors.push('candidate blue-green overlap memory regresses beyond policy')
    for (const routeName of REQUIRED_RUNTIME_ROUTES) {
      if (delta.routes[routeName].safeRpsDeltaPercent < (options.minimumSafeRpsDeltaPercent ?? -2)) errors.push(`candidate ${routeName} safe RPS regresses beyond policy`)
      if (delta.routes[routeName].p999DeltaPercent > (options.maximumP999DeltaPercent ?? 5)) errors.push(`candidate ${routeName} p99.9 regresses beyond policy`)
    }
    const noiseFloor = options.minimumMaterialDeltaPercent ?? 2
    const steadyStateMaterial = delta.safeRpsDeltaPercent >= noiseFloor || delta.p999DeltaPercent <= -noiseFloor || delta.rssDeltaPercent <= -noiseFloor
    const material = steadyStateMaterial || delta.coldStartDeltaPercent <= -noiseFloor
    if (!material) errors.push(`candidate does not exceed the ${noiseFloor}% materiality floor`)
    if (candidate.profilePurpose === 'startup' && !steadyStateMaterial) errors.push('startup-only improvement cannot replace the throughput production default')
  }
  for (const [optionName, label, actual] of [
    ['maximumGcPauseP99Ms', 'GC pause', candidate.gcPauseP99MedianMs],
    ['maximumReadyMs', 'ready time', candidate.readyMedianMs],
    ['maximumRolloutMs', 'rollout time', candidate.rolloutMedianMs],
    ['maximumRecoveryMs', 'recovery time', candidate.recoveryMedianMs],
    ['maximumBlueGreenOverlapBytes', 'blue-green overlap memory', candidate.blueGreenOverlapPeakMedianBytes]
  ]) {
    if (!finiteNonNegative(options[optionName])) errors.push(`${label} absolute policy is required`)
    else if (actual > options[optionName]) errors.push(`candidate ${label} exceeds the absolute policy`)
  }
  if (candidate.profilePurpose === 'negative-control' || candidate.threadPoolMode === 'overprovisioned-negative-control') errors.push('negative control cannot be selected for production')
  return { eligible: errors.length === 0, baselineProfileId: baselineId, candidateProfileId, errors }
}

function validateMeasurements(value, result, errors) {
  if (!plainObject(value)) return errors.push('measurements are required')
  for (const field of ['imageSizeBytes', 'coldStartMs', 'readyMs', 'warmupMs', 'rssPeakBytes', 'managedHeapPeakBytes', 'lohPeakBytes', 'gcPauseP99Ms', 'gcCpuPercent', 'jitTimeMs', 'jitCodeSizeBytes', 'tierTransitions', 'threadPoolQueueP99', 'threadPoolStarvationCount', 'contextSwitches', 'cpuMigrations', 'cpuThrottledSeconds', 'startupCpuSeconds', 'steadyStateCpuSeconds', 'rolloutMs', 'recoveryMs', 'blueGreenOverlapPeakBytes']) {
    if (!finiteNonNegative(value[field])) errors.push(`measurements.${field} must be a finite non-negative number`)
  }
  if (!plainObject(value.routes)) return errors.push('measurements.routes are required')
  for (const routeName of REQUIRED_RUNTIME_ROUTES) {
    const route = value.routes?.[routeName]
    if (!plainObject(route)) {
      errors.push(`measurements.routes.${routeName} is required`)
      continue
    }
    for (const field of ['safeRps', 'saturationKneeRps', 'p50Ms', 'p95Ms', 'p99Ms', 'p999Ms', 'cyclesPerRequest', 'instructionsPerRequest', 'ipc', 'allocationsBytesPerRequest']) {
      if (!finiteNonNegative(route[field])) errors.push(`measurements.routes.${routeName}.${field} must be finite and non-negative`)
    }
    if (finiteNonNegative(route.p99Ms) && finiteNonNegative(route.p999Ms) && route.p999Ms < route.p99Ms) errors.push(`measurements.routes.${routeName}.p999Ms cannot be lower than p99Ms`)
    if (route.cyclesPerRequest > 0 && Math.abs(route.ipc - (route.instructionsPerRequest / route.cyclesPerRequest)) > 0.001) errors.push(`measurements.routes.${routeName}.ipc does not match instructions/cycles`)
  }
  validatePower(value.power, errors)
  validateResourceStress(value.resourceStress, value.blueGreenOverlapPeakBytes, result, errors)
}

function validateResourceStress(value, blueGreenOverlapPeakBytes, result, errors) {
  if (!plainObject(value)) return errors.push('measurements.resourceStress is required')
  if (!Number.isSafeInteger(value.targetMemoryBytes) || value.targetMemoryBytes <= 0 || value.targetMemoryBytes !== result.execution?.targetMemoryBytes) {
    errors.push('measurements.resourceStress.targetMemoryBytes must match execution target memory')
  }
  if (!Number.isSafeInteger(value.allocationBurstPeakBytes) || value.allocationBurstPeakBytes <= 0) errors.push('measurements.resourceStress.allocationBurstPeakBytes must be a positive safe integer')
  if (!finiteNonNegative(value.gcPressurePeakPercent) || value.gcPressurePeakPercent > 100) errors.push('measurements.resourceStress.gcPressurePeakPercent must be between 0 and 100')
  const requiresOomProbe = result.effectiveRuntime?.gcHeapHardLimitMode === 'explicit-container-percent'
  const allowedOutcomes = requiresOomProbe ? ['bounded-rejection', 'recovered'] : ['not-applicable', 'bounded-rejection', 'recovered']
  if (!allowedOutcomes.includes(value.oomOutcome)) errors.push('measurements.resourceStress.oomOutcome does not prove the configured hard-limit behavior')
  if (value.oomOutcome === 'not-applicable') {
    if (value.oomRecoveryMs !== null) errors.push('measurements.resourceStress.oomRecoveryMs must be null when no OOM probe applies')
  } else if (!finiteNonNegative(value.oomRecoveryMs)) errors.push('measurements.resourceStress.oomRecoveryMs must record bounded recovery')

  const overlap = value.blueGreen
  if (!plainObject(overlap)) return errors.push('measurements.resourceStress.blueGreen is required')
  const fields = ['activeSlotRssBytes', 'candidateSlotRssBytes', 'publicSnapshotBytes', 'ssrWorkerBytes', 'otherBytes', 'totalBytes']
  for (const field of fields) if (!Number.isSafeInteger(overlap[field]) || overlap[field] < 0) errors.push(`measurements.resourceStress.blueGreen.${field} must be a non-negative safe integer`)
  const parts = ['activeSlotRssBytes', 'candidateSlotRssBytes', 'publicSnapshotBytes', 'ssrWorkerBytes', 'otherBytes']
  const total = parts.reduce((sum, field) => sum + (Number.isSafeInteger(overlap[field]) ? overlap[field] : 0), 0)
  if (overlap.totalBytes !== total) errors.push('measurements.resourceStress.blueGreen.totalBytes must equal the slot/snapshot/SSR breakdown')
  if (overlap.totalBytes !== blueGreenOverlapPeakBytes) errors.push('measurements.resourceStress.blueGreen.totalBytes must match blueGreenOverlapPeakBytes')
  if (Number.isSafeInteger(value.targetMemoryBytes) && overlap.totalBytes > value.targetMemoryBytes) errors.push('blue-green overlap exceeds the target memory budget')
}

function validatePower(value, errors) {
  if (!plainObject(value) || !['ok', 'unavailable'].includes(value.status)) return errors.push('measurements.power must declare ok or unavailable')
  if (typeof value.source !== 'string' || value.source.trim().length === 0 || value.source.length > 256) errors.push('measurements.power.source is invalid')
  if (value.status === 'ok') {
    for (const field of ['startupJoules', 'steadyStateWatts']) if (!finiteNonNegative(value[field])) errors.push(`measurements.power.${field} must be finite and non-negative`)
    if (value.reason !== null) errors.push('measurements.power.reason must be null when available')
  } else {
    if (typeof value.reason !== 'string' || value.reason.trim().length < 3 || value.reason.length > 512) errors.push('unavailable power evidence requires a bounded reason')
    if (value.startupJoules !== null || value.steadyStateWatts !== null) errors.push('unavailable power evidence cannot invent numeric values')
  }
}

function captureCpuTopology(cpuset, logicalCpuCount) {
  const visibleCpus = parseCpuSet(cpuset) ?? new Set(Array.from({ length: logicalCpuCount }, (_, index) => index))
  const cores = new Set()
  const siblingGroups = new Map()
  for (const cpu of [...visibleCpus].sort((left, right) => left - right)) {
    const packageId = readFirst([`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`])
    const coreId = readFirst([`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`])
    const siblings = parseCpuSet(readFirst([`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`]))
    if (packageId === null || coreId === null || !siblings) {
      return {
        status: 'unavailable',
        reason: `sysfs CPU topology is unavailable for visible cpu ${cpu}`,
        physicalCoreCount: null,
        threadsPerCore: null,
        smtSiblingGroups: [],
        numa: captureNumaTopology(visibleCpus)
      }
    }
    cores.add(`${packageId}:${coreId}`)
    const visibleSiblings = [...siblings].filter((sibling) => visibleCpus.has(sibling)).sort((left, right) => left - right)
    siblingGroups.set(visibleSiblings.join(','), visibleSiblings)
  }
  const groups = [...siblingGroups.values()].sort((left, right) => left[0] - right[0])
  return {
    status: 'ok',
    reason: null,
    physicalCoreCount: cores.size,
    threadsPerCore: Math.max(...groups.map((group) => group.length)),
    smtSiblingGroups: groups,
    numa: captureNumaTopology(visibleCpus)
  }
}

function captureNumaTopology(visibleCpus) {
  let nodeNames
  try {
    nodeNames = fs.readdirSync('/sys/devices/system/node').filter((name) => /^node\d+$/u.test(name)).sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)))
  } catch (error) {
    return { status: 'unavailable', reason: `NUMA sysfs is unavailable: ${boundedReason(error)}`, nodes: [] }
  }
  const nodes = []
  for (const name of nodeNames) {
    const cpus = parseCpuSet(readFirst([`/sys/devices/system/node/${name}/cpulist`]))
    if (!cpus) return { status: 'unavailable', reason: `NUMA cpulist is unavailable for ${name}`, nodes: [] }
    const visible = [...cpus].filter((cpu) => visibleCpus.has(cpu)).sort((left, right) => left - right)
    if (visible.length > 0) nodes.push({ id: Number(name.slice(4)), cpulist: formatCpuSet(visible) })
  }
  if (nodes.length === 0) return { status: 'unavailable', reason: 'no NUMA node intersects the visible cpuset', nodes: [] }
  if (nodes.length === 1) return { status: 'not-applicable', reason: 'only one NUMA node intersects the visible cpuset', nodes }
  return { status: 'ok', reason: null, nodes }
}

function validateHardwareTopology(hardware, errors) {
  if (!Number.isInteger(hardware?.logicalCpuCount) || hardware.logicalCpuCount < 1) errors.push('hardware.logicalCpuCount must be container-visible and positive')
  if (!Number.isSafeInteger(hardware?.totalMemoryBytes) || hardware.totalMemoryBytes < 1) errors.push('hardware.totalMemoryBytes must be container-visible and positive')
  const visibleCpus = parseCpuSet(hardware?.cpuset)
  if (visibleCpus && hardware.logicalCpuCount > visibleCpus.size) errors.push('hardware.logicalCpuCount cannot exceed the visible cpuset')
  const topology = hardware?.topology
  if (!plainObject(topology) || !['ok', 'unavailable'].includes(topology.status)) {
    errors.push('hardware.topology must declare ok or unavailable')
    return
  }
  if (topology.status === 'unavailable') {
    if (typeof topology.reason !== 'string' || topology.reason.trim().length < 3) errors.push('unavailable CPU topology requires a reason')
  } else {
    if (!Number.isInteger(topology.physicalCoreCount) || topology.physicalCoreCount < 1) errors.push('hardware.topology.physicalCoreCount is invalid')
    if (!Number.isInteger(topology.threadsPerCore) || topology.threadsPerCore < 1) errors.push('hardware.topology.threadsPerCore is invalid')
    if (!Array.isArray(topology.smtSiblingGroups) || topology.smtSiblingGroups.length !== topology.physicalCoreCount) errors.push('hardware.topology.smtSiblingGroups must enumerate physical cores')
  }
  const numa = topology.numa
  if (!plainObject(numa) || !['ok', 'not-applicable', 'unavailable'].includes(numa.status)) return errors.push('hardware.topology.numa status is invalid')
  if (numa.status === 'unavailable' || numa.status === 'not-applicable') {
    if (typeof numa.reason !== 'string' || numa.reason.trim().length < 3) errors.push('unavailable or not-applicable NUMA topology requires a reason')
  }
  if (!Array.isArray(numa.nodes)) return errors.push('hardware.topology.numa.nodes must be an array')
  for (const node of numa.nodes) if (!Number.isInteger(node?.id) || !parseCpuSet(node?.cpulist)) errors.push('hardware.topology.numa node is invalid')
  if (numa.status === 'ok' && numa.nodes.length < 2) errors.push('available NUMA topology requires at least two visible nodes')
  if (numa.status === 'not-applicable' && numa.nodes.length !== 1) errors.push('not-applicable NUMA topology requires exactly one visible node')
}

function validateTopologyPlacement(observedCpus, topologyMode, hardware, errors) {
  if (!observedCpus || topologyMode === 'smt-visible' || topologyMode === undefined) return
  const topology = hardware?.topology
  if (!plainObject(topology) || topology.status !== 'ok') return errors.push(`execution cannot prove ${topologyMode} placement without available CPU topology`)
  if (topologyMode === 'physical-core-only') {
    const groups = topology.smtSiblingGroups?.map((group) => new Set(group)) ?? []
    for (const cpu of observedCpus) if (!groups.some((group) => group.has(cpu))) errors.push(`execution observed cpu ${cpu} is absent from hardware sibling topology`)
    if (groups.some((group) => [...observedCpus].filter((cpu) => group.has(cpu)).length > 1)) errors.push('physical-core-only placement selected SMT siblings from the same physical core')
  }
  if (topologyMode === 'numa-local') {
    const numa = topology.numa
    if (!plainObject(numa) || numa.status === 'unavailable') return errors.push('execution cannot prove numa-local placement without NUMA topology')
    const containingNodes = numa.nodes.filter((node) => [...observedCpus].every((cpu) => parseCpuSet(node.cpulist)?.has(cpu)))
    if (containingNodes.length !== 1) errors.push('numa-local placement must remain inside exactly one observed NUMA node')
  }
}

function formatCpuSet(cpus) {
  return cpus.join(',')
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function boundedReason(error) {
  return String(error instanceof Error ? error.message : error).replace(/[\r\n]+/gu, ' ').trim().slice(0, 256) || 'unknown reason'
}

function readFirst(files) {
  for (const file of files) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim()
      if (value) return value
    } catch {}
  }
  return null
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || 'unavailable'
  } catch {
    return 'unavailable'
  }
}

function median(values) {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle]
}

function coefficientOfVariation(values) {
  if (values.length === 0) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Number(((Math.sqrt(variance) / mean) * 100).toFixed(4))
}

function percentDelta(value, baseline) {
  return baseline === 0 ? null : Number((((value - baseline) / baseline) * 100).toFixed(4))
}

function dominates(a, b) {
  const noWorse = a.safeRpsFloorMedian >= b.safeRpsFloorMedian && a.p999CeilingMedianMs <= b.p999CeilingMedianMs && a.rssPeakMedianBytes <= b.rssPeakMedianBytes && a.rolloutMedianMs <= b.rolloutMedianMs
  const better = a.safeRpsFloorMedian > b.safeRpsFloorMedian || a.p999CeilingMedianMs < b.p999CeilingMedianMs || a.rssPeakMedianBytes < b.rssPeakMedianBytes || a.rolloutMedianMs < b.rolloutMedianMs
  return noWorse && better
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function parseCpuSet(value) {
  if (typeof value !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) return null
  const cpus = new Set()
  for (const part of value.split(',')) {
    const [startText, endText = startText] = part.split('-')
    const start = Number(startText)
    const end = Number(endText)
    if (end < start || end - start > 4096) return null
    for (let cpu = start; cpu <= end; cpu += 1) cpus.add(cpu)
  }
  return cpus
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
