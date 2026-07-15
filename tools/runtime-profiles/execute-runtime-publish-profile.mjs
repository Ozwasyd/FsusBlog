#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createRuntimeMeasurementClaimDigest, validateRuntimeProfileResult } from './runtime-publish-evidence.mjs'
import { resolveAutoBalancedCpuSets } from './runtime-publish-isolation.mjs'
import { canonicalJson, sha256Value } from './runtime-publish-profile.mjs'

const PLAN_SCHEMA = 'fsusblog.runtime-publish-executor-plan.v1'
const COMMAND_NAMES = ['cleanupBefore', 'build', 'correctness', 'security', 'release', 'measure', 'cleanupAfter']
const SHA256 = /^sha256:[0-9a-f]{64}$/u
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const NODE_VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
const STAGE_RECEIPT_SCHEMA = 'fsusblog.runtime-publish-stage-receipt.v1'

try {
  const options = parseArgs(process.argv.slice(2))
  for (const key of ['request', 'output']) if (!options[key]) throw new Error(`missing --${key}`)
  if (process.env.FSUSBLOG_RUNTIME_MATRIX_EXECUTOR !== '1') throw new Error('executor can only run under the matrix runner')
  const planFile = path.resolve(options.plan ?? process.env.FSUSBLOG_RUNTIME_MATRIX_PLAN ?? '')
  if (!planFile || !fs.statSync(planFile).isFile()) throw new Error('a regular --plan or FSUSBLOG_RUNTIME_MATRIX_PLAN file is required')
  const request = readJson(path.resolve(options.request), 'request')
  const plan = readJson(planFile, 'executor plan')
  const isolation = resolveIsolation(plan.isolation, request.profile.topology.mode)
  validatePlan(plan, request.profile, isolation)
  const output = path.resolve(options.output)
  const workRoot = fs.mkdtempSync(path.join(path.dirname(output), '.runtime-profile-executor-'))
  const measurementsFile = path.join(workRoot, 'measurements.json')
  const receipts = []
  let cleanupBefore = 'not-run'
  let cleanupAfter = 'not-run'
  let primaryError = null
  try {
    receipts.push(runPlanCommand(plan.commands.cleanupBefore, 'cleanupBefore', planFile, request, measurementsFile, isolation))
    cleanupBefore = 'pass'
    for (const stage of ['build', 'correctness', 'security', 'release']) {
      receipts.push(runPlanCommand(plan.commands[stage], stage, planFile, request, measurementsFile, isolation))
    }
    if (request.profile.publish.nativeAot === true) {
      for (const stage of ['featureParity', 'securityParity']) receipts.push(runPlanCommand(plan.commands[stage], stage, planFile, request, measurementsFile, isolation))
    }
    receipts.push(runPlanCommand(plan.commands.measure, 'measure', planFile, request, measurementsFile, isolation))
    const payload = readJson(measurementsFile, 'measurement output')
    validateIsolationReceipt(payload.isolationReceipt, isolation)
    const effectiveRuntime = {
      ...payload.effectiveRuntime,
      ...inspectRuntimeImage(payload.imageReceipt, request, payload.effectiveRuntime)
    }
    const result = {
      schema: 'fsusblog.runtime-publish-profile-result.v1',
      status: 'ok',
      identity: request.identity,
      gates: { correctness: 'pass', security: 'pass', release: 'pass' },
      effectiveRuntime,
      ...(payload.threadPoolEvidence ? { threadPoolEvidence: payload.threadPoolEvidence } : {}),
      execution: {
        cooldownRequestedMs: request.cooldownMs,
        cooldownObservedMs: request.cooldownObservedMs,
        cleanupBefore,
        cleanupAfter: 'pending',
        measurementWindowQuiet: payload.isolationReceipt.measurementWindowQuiet,
        loadGeneratorIsolated: payload.isolationReceipt.loadGeneratorIsolated,
        targetCpuset: payload.isolationReceipt.targetCpuset,
        observedTargetCpuset: payload.isolationReceipt.observedTargetCpuset,
        loadGeneratorCpuset: payload.isolationReceipt.loadGeneratorCpuset,
        targetCgroup: payload.isolationReceipt.targetCgroup,
        loadGeneratorCgroup: payload.isolationReceipt.loadGeneratorCgroup,
        targetMemoryBytes: payload.isolationReceipt.targetMemoryBytes,
        commandReceipts: receipts
      },
      measurements: payload.measurements
    }
    receipts.push(runPlanCommand(plan.commands.cleanupAfter, 'cleanupAfter', planFile, request, measurementsFile, isolation))
    cleanupAfter = 'pass'
    result.execution.cleanupAfter = cleanupAfter
    result.execution.measurementClaimDigest = createRuntimeMeasurementClaimDigest(result)
    const errors = validateRuntimeProfileResult(result, { ...request.identity, cooldownMs: request.cooldownMs, expectedProfile: request.profile, expectedHardware: request.hardware })
    if (errors.length > 0) throw new Error(`measurement output failed validation: ${errors.join('; ')}`)
    writeExclusive(output, result)
  } catch (error) {
    primaryError = error
    if (cleanupAfter !== 'pass') {
      try {
        receipts.push(runPlanCommand(plan.commands.cleanupAfter, 'cleanupAfter', planFile, request, measurementsFile, isolation))
        cleanupAfter = 'pass'
      } catch (cleanupError) {
        cleanupAfter = 'failed'
        primaryError = new Error(`${messageOf(error)}; cleanupAfter failed: ${messageOf(cleanupError)}`)
      }
    }
    writeExclusive(output, {
      schema: 'fsusblog.runtime-publish-profile-result.v1',
      status: 'failed',
      identity: request.identity,
      error: bounded(messageOf(primaryError)),
      execution: { cleanupBefore, cleanupAfter, commandReceipts: receipts }
    })
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true })
  }
  if (primaryError) process.exitCode = 1
} catch (error) {
  console.error(`[execute-runtime-publish-profile] ${messageOf(error)}`)
  process.exitCode = 1
}

function validatePlan(plan, profile, isolation) {
  if (!plainObject(plan) || plan.schema !== PLAN_SCHEMA) throw new Error(`executor plan schema must be ${PLAN_SCHEMA}`)
  const allowed = new Set(['schema', 'isolation', 'commands'])
  for (const key of Object.keys(plan)) if (!allowed.has(key)) throw new Error(`executor plan field is not allowed: ${key}`)
  validateIsolationDeclaration(plan.isolation)
  validateIsolationReceipt({ ...isolation, observedTargetCpuset: isolation.targetCpuset, targetMemoryBytes: 1, measurementWindowQuiet: true, loadGeneratorIsolated: true }, isolation)
  if (!plainObject(plan.commands)) throw new Error('executor plan commands are required')
  const required = [...COMMAND_NAMES]
  if (profile.publish.nativeAot === true) required.push('featureParity', 'securityParity')
  for (const name of required) validateCommand(plan.commands[name], name)
  for (const name of Object.keys(plan.commands)) if (![...COMMAND_NAMES, 'featureParity', 'securityParity'].includes(name)) throw new Error(`unknown executor command: ${name}`)
}

function validateIsolationDeclaration(value) {
  if (!plainObject(value)) throw new Error('executor isolation is required')
  if (value.strategy !== 'auto-balanced') return
  for (const key of Object.keys(value)) if (!['strategy', 'cgroupPrefix'].includes(key)) throw new Error(`executor isolation.${key} is not allowed for auto-balanced isolation`)
  if (typeof value.cgroupPrefix !== 'string' || !/^\/[A-Za-z0-9._/-]{3,240}$/u.test(value.cgroupPrefix) || value.cgroupPrefix.endsWith('/')) {
    throw new Error('executor isolation.cgroupPrefix is invalid')
  }
}

function resolveIsolation(value, topologyMode) {
  if (!plainObject(value) || value.strategy !== 'auto-balanced') return value
  const visibleCpus = parseCpuList(process.env.FSUSBLOG_RUNTIME_AVAILABLE_CPUSET ?? readAllowedCpuList())
  const coreGroups = groupByPhysicalCore(visibleCpus)
  const numaNodes = readVisibleNumaNodes(visibleCpus)
  const { targetCpus, loadGeneratorCpus } = resolveAutoBalancedCpuSets({
    visibleCpus,
    physicalCoreGroups: coreGroups,
    numaNodes,
    topologyMode
  })
  return {
    targetCpuset: formatCpuList(targetCpus),
    loadGeneratorCpuset: formatCpuList(loadGeneratorCpus),
    targetCgroup: `${value.cgroupPrefix}/target`,
    loadGeneratorCgroup: `${value.cgroupPrefix}/loadgen`
  }
}

function readVisibleNumaNodes(visibleCpus) {
  const visible = new Set(visibleCpus)
  try {
    return fs.readdirSync('/sys/devices/system/node')
      .filter((name) => /^node\d+$/u.test(name))
      .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)))
      .map((name) => parseCpuList(fs.readFileSync(`/sys/devices/system/node/${name}/cpulist`, 'utf8').trim()).filter((cpu) => visible.has(cpu)))
      .filter((cpus) => cpus.length > 0)
  } catch {
    return []
  }
}

function readAllowedCpuList() {
  const status = fs.readFileSync('/proc/self/status', 'utf8')
  const value = status.match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1]?.trim()
  if (!value) throw new Error('unable to detect visible CPU set from /proc/self/status')
  return value
}

function parseCpuList(value) {
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(String(value ?? ''))) throw new Error('visible CPU set is invalid')
  const cpus = new Set()
  for (const part of String(value).split(',')) {
    const [startText, endText = startText] = part.split('-')
    const start = Number(startText)
    const end = Number(endText)
    if (end < start || end - start > 4096) throw new Error('visible CPU range is invalid')
    for (let cpu = start; cpu <= end; cpu += 1) cpus.add(cpu)
  }
  return [...cpus].sort((left, right) => left - right)
}

function groupByPhysicalCore(cpus) {
  const groups = new Map()
  for (const cpu of cpus) {
    try {
      const packageId = fs.readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`, 'utf8').trim()
      const coreId = fs.readFileSync(`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`, 'utf8').trim()
      const key = `${packageId}:${coreId}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(cpu)
    } catch {
      return cpus.map((candidate) => [candidate])
    }
  }
  return [...groups.values()].map((group) => group.sort((left, right) => left - right))
}

function formatCpuList(cpus) {
  const sorted = [...new Set(cpus)].sort((left, right) => left - right)
  const parts = []
  let start = sorted[0]
  let end = start
  for (const cpu of sorted.slice(1)) {
    if (cpu === end + 1) {
      end = cpu
      continue
    }
    parts.push(start === end ? String(start) : `${start}-${end}`)
    start = cpu
    end = cpu
  }
  parts.push(start === end ? String(start) : `${start}-${end}`)
  return parts.join(',')
}

function validateCommand(command, name) {
  if (!plainObject(command)) throw new Error(`executor command ${name} is required`)
  for (const key of Object.keys(command)) if (!['file', 'args', 'timeoutMs'].includes(key)) throw new Error(`executor command ${name}.${key} is not allowed`)
  if (typeof command.file !== 'string' || command.file.length === 0 || command.file.length > 512) throw new Error(`executor command ${name}.file is invalid`)
  if (!Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.length > 1024)) throw new Error(`executor command ${name}.args are invalid`)
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1000 || command.timeoutMs > 7_200_000) throw new Error(`executor command ${name}.timeoutMs is invalid`)
}

function runPlanCommand(command, stage, planFile, request, measurementsFile, isolation) {
  const planRoot = path.dirname(planFile)
  const executable = path.resolve(planRoot, command.file)
  const stat = fs.statSync(executable)
  if (!stat.isFile()) throw new Error(`${stage} executable is not a regular file`)
  const receiptFile = path.join(path.dirname(measurementsFile), `${stage}.receipt.json`)
  const startedAt = new Date().toISOString()
  const start = process.hrtime.bigint()
  const child = spawnSync(executable, command.args, {
    cwd: planRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: command.timeoutMs,
    env: {
      ...process.env,
      FSUSBLOG_RUNTIME_EXECUTOR_STAGE: stage,
      FSUSBLOG_RUNTIME_PROFILE_REQUEST: JSON.stringify(request),
      FSUSBLOG_RUNTIME_PROFILE_ID: request.profile.id,
      FSUSBLOG_RUNTIME_PROFILE_DIGEST: request.identity.profileDigest,
      FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST: request.identity.profileManifestDigest,
      FSUSBLOG_RUNTIME_MEASUREMENTS_OUTPUT: measurementsFile,
      FSUSBLOG_RUNTIME_STAGE_RECEIPT_OUTPUT: receiptFile,
      FSUSBLOG_RUNTIME_TARGET_CPUSET: isolation.targetCpuset,
      FSUSBLOG_RUNTIME_LOADGEN_CPUSET: isolation.loadGeneratorCpuset,
      FSUSBLOG_RUNTIME_TARGET_CGROUP: isolation.targetCgroup,
      FSUSBLOG_RUNTIME_LOADGEN_CGROUP: isolation.loadGeneratorCgroup,
      FSUSBLOG_RUNTIME_TARGET_CPU_COUNT: String(parseCpuList(isolation.targetCpuset).length),
      FSUSBLOG_RUNTIME_GC_HEAP_COUNT_MODE: request.profile.gc.heapCountMode,
      FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_MODE: request.profile.gc.heapHardLimitMode,
      FSUSBLOG_RUNTIME_GC_HEAP_HARD_LIMIT_PERCENT: String(request.profile.gc.heapHardLimitPercent),
      FSUSBLOG_RUNTIME_THREAD_POOL_MODE: request.profile.threadPool.mode,
      FSUSBLOG_RUNTIME_THREAD_POOL_MIN_THREADS_PER_CPU: String(request.profile.threadPool.minThreadsPerCpu),
      FSUSBLOG_RUNTIME_TOPOLOGY_MODE: request.profile.topology.mode
    }
  })
  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000
  if (child.status !== 0) throw new Error(`${stage} failed with exit ${child.status ?? 'none'}: ${bounded(child.error?.message || child.stderr || child.stdout)}`)
  const receipt = readJson(receiptFile, `${stage} provenance receipt`)
  validateStageReceipt(receipt, stage, request, measurementsFile)
  return {
    ...receipt,
    executorStartedAtUtc: startedAt,
    executorDurationMs: Number(durationMs.toFixed(3)),
    executorExitCode: 0
  }
}

function validateStageReceipt(receipt, stage, request, measurementsFile) {
  if (!plainObject(receipt) || receipt.schema !== STAGE_RECEIPT_SCHEMA) throw new Error(`${stage} receipt schema is invalid`)
  const allowed = new Set(['schema', 'status', 'stage', 'identity', 'startedAtUtc', 'completedAtUtc', 'command', 'resultDigest', 'evidence'])
  for (const key of Object.keys(receipt)) if (!allowed.has(key)) throw new Error(`${stage} receipt.${key} is not allowed`)
  if (receipt.status !== 'pass' || receipt.stage !== stage) throw new Error(`${stage} receipt status/stage is invalid`)
  if (canonicalJson(receipt.identity) !== canonicalJson(request.identity)) throw new Error(`${stage} receipt identity does not match the run request`)
  for (const field of ['startedAtUtc', 'completedAtUtc']) if (!Number.isFinite(Date.parse(receipt[field]))) throw new Error(`${stage} receipt ${field} is invalid`)
  if (!plainObject(receipt.command) || receipt.command.exitCode !== 0 || !finiteNonNegative(receipt.command.durationMs)) throw new Error(`${stage} receipt command outcome is invalid`)
  for (const field of ['executableDigest', 'argsDigest']) if (!SHA256.test(String(receipt.command?.[field] ?? ''))) throw new Error(`${stage} receipt command.${field} is invalid`)
  if (!SHA256.test(String(receipt.resultDigest ?? ''))) throw new Error(`${stage} receipt resultDigest is invalid`)
  if (!plainObject(receipt.evidence) || receipt.evidence.kind !== expectedStageEvidenceKind(stage)) throw new Error(`${stage} receipt evidence kind is invalid`)
  for (const field of stageEvidenceDigests(stage)) if (!SHA256.test(String(receipt.evidence[field] ?? ''))) throw new Error(`${stage} receipt evidence.${field} is invalid`)
  if (stage === 'measure') {
    const payload = readJson(measurementsFile, 'measurement output')
    if (receipt.evidence.payloadDigest !== sha256Value(payload)) throw new Error('measure receipt does not bind the emitted measurement payload')
  }
  if (stage === 'build') {
    if (typeof receipt.evidence.imageRef !== 'string' || !receipt.evidence.imageRef.endsWith(`@${receipt.evidence.imageDigest}`)) throw new Error('build receipt image identity is invalid')
  }
  if (['correctness', 'security', 'release'].includes(stage) && (receipt.evidence.gate !== stage || receipt.evidence.gateStatus !== 'pass')) {
    throw new Error(`${stage} receipt does not prove the named gate`)
  }
  if (stage.endsWith('Parity') && (receipt.evidence.scope !== 'public-artifact-only' || receipt.evidence.parityStatus !== 'pass')) {
    throw new Error(`${stage} receipt does not prove narrow parity`)
  }
}

function expectedStageEvidenceKind(stage) {
  if (stage.startsWith('cleanup')) return 'cleanup'
  if (stage === 'build') return 'build'
  if (['correctness', 'security', 'release'].includes(stage)) return 'gate'
  if (stage.endsWith('Parity')) return 'parity'
  return 'measurement'
}

function stageEvidenceDigests(stage) {
  if (stage.startsWith('cleanup')) return ['cleanupTargetsDigest']
  if (stage === 'build') return ['imageDigest', 'artifactManifestDigest', 'featureSetDigest']
  if (['correctness', 'security', 'release'].includes(stage)) return ['evidenceDigest']
  if (stage.endsWith('Parity')) return ['evidenceDigest', 'featureSetDigest']
  return ['payloadDigest', 'faultPlanDigest', 'loadFixtureDigest']
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validateIsolationReceipt(receipt, expected) {
  if (!plainObject(receipt) || !plainObject(expected)) throw new Error('isolation receipt is required')
  if (!Number.isSafeInteger(receipt.targetMemoryBytes) || receipt.targetMemoryBytes <= 0) throw new Error('measurement isolation targetMemoryBytes must be a positive safe integer')
  for (const field of ['targetCpuset', 'loadGeneratorCpuset', 'targetCgroup', 'loadGeneratorCgroup']) {
    if (typeof expected[field] !== 'string' || expected[field].trim().length === 0) throw new Error(`executor isolation ${field} is invalid`)
    if (receipt[field] !== expected[field]) throw new Error(`measurement isolation ${field} does not match the executor plan`)
  }
  if (receipt.observedTargetCpuset !== expected.targetCpuset) throw new Error('measurement observed target cpuset does not match the executor plan')
  if (expected.targetCgroup === expected.loadGeneratorCgroup) throw new Error('target and load generator cgroups must differ')
  if (cpusOverlap(expected.targetCpuset, expected.loadGeneratorCpuset)) throw new Error('target and load generator cpusets must be disjoint')
  if (receipt.measurementWindowQuiet !== true || receipt.loadGeneratorIsolated !== true) throw new Error('measurement isolation receipt must prove a quiet isolated window')
}

function inspectRuntimeImage(receipt, request, reportedRuntime) {
  if (!plainObject(receipt)) throw new Error('measurement imageReceipt is required')
  for (const key of Object.keys(receipt)) if (key !== 'imageRef') throw new Error(`measurement imageReceipt.${key} is not allowed`)
  if (typeof receipt.imageRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511}$/u.test(receipt.imageRef)) throw new Error('measurement imageReceipt.imageRef is invalid')
  const inspected = readDockerInspect(receipt.imageRef)
  if (!SHA256.test(String(inspected.Id ?? ''))) throw new Error('inspected image Id must be sha256:<64 lowercase hex>')
  if (!plainObject(inspected.Config?.Labels)) throw new Error('inspected image labels are required')
  const labels = inspected.Config.Labels
  const expectedLabels = {
    'org.opencontainers.image.revision': request.identity.commitSha,
    'io.fsusblog.runtime.profile-id': request.profile.id,
    'io.fsusblog.runtime.profile-digest': request.identity.profileDigest,
    'io.fsusblog.runtime.profile-manifest-digest': request.identity.profileManifestDigest,
    'io.fsusblog.runtime.base-family': request.profile.baseImageFamily,
    'io.fsusblog.runtime.target-runtime': request.profile.targetRuntime,
    'io.fsusblog.runtime.publish-single-file': String(request.profile.publish.singleFile),
    'io.fsusblog.runtime.publish-ready-to-run': String(request.profile.publish.readyToRun),
    'io.fsusblog.runtime.tiered-pgo': String(request.profile.publish.tieredPgo),
    'io.fsusblog.runtime.quick-jit-for-loops': String(request.profile.publish.quickJitForLoops),
    'io.fsusblog.runtime.server-gc': String(request.profile.gc.server),
    'io.fsusblog.runtime.native-aot': String(request.profile.publish.nativeAot),
    'io.fsusblog.runtime.gc-heap-count-mode': request.profile.gc.heapCountMode,
    'io.fsusblog.runtime.gc-heap-hard-limit-mode': request.profile.gc.heapHardLimitMode,
    'io.fsusblog.runtime.gc-heap-hard-limit-percent': String(request.profile.gc.heapHardLimitPercent),
    'io.fsusblog.runtime.thread-pool-mode': request.profile.threadPool.mode,
    'io.fsusblog.runtime.thread-pool-min-threads-per-cpu': String(request.profile.threadPool.minThreadsPerCpu),
    'io.fsusblog.runtime.topology-mode': request.profile.topology.mode
  }
  for (const [name, expected] of Object.entries(expectedLabels)) {
    if (labels[name] !== expected) throw new Error(`inspected image label ${name} does not match the run request`)
  }
  const runtimeVersion = labels['io.fsusblog.runtime.dotnet-version']
  const sdkVersion = labels['io.fsusblog.build.dotnet-sdk-version']
  const runtimeBaseImageDigest = labels['io.fsusblog.runtime.base-image-digest']
  const sdkBaseImageDigest = labels['io.fsusblog.build.sdk-image-digest']
  if (!VERSION.test(String(runtimeVersion ?? ''))) throw new Error('inspected image runtime version label is invalid')
  if (!VERSION.test(String(sdkVersion ?? ''))) throw new Error('inspected image SDK version label is invalid')
  if (!SHA256.test(String(runtimeBaseImageDigest ?? ''))) throw new Error('inspected image runtime base digest label is invalid')
  if (!SHA256.test(String(sdkBaseImageDigest ?? ''))) throw new Error('inspected image SDK base digest label is invalid')
  const nodeVersion = runDocker(
    ['run', '--rm', '--network', 'none', '--entrypoint', 'node', inspected.Id, '--version'],
    'Node version probe'
  ).trim()
  if (!NODE_VERSION.test(nodeVersion)) throw new Error('inspected image Node version must be a concrete semantic version')
  const identity = {
    imageDigest: inspected.Id,
    runtimeVersion,
    sdkVersion,
    runtimeBaseImageDigest,
    sdkBaseImageDigest,
    nodeVersion,
    profilePurpose: request.profile.purpose,
    singleFile: request.profile.publish.singleFile,
    readyToRun: request.profile.publish.readyToRun,
    tieredPgo: request.profile.publish.tieredPgo,
    quickJitForLoops: request.profile.publish.quickJitForLoops,
    serverGc: request.profile.gc.server,
    nativeAot: request.profile.publish.nativeAot,
    gcHeapCountMode: request.profile.gc.heapCountMode,
    gcHeapHardLimitMode: request.profile.gc.heapHardLimitMode,
    gcHeapHardLimitPercentConfigured: request.profile.gc.heapHardLimitPercent,
    threadPoolMode: request.profile.threadPool.mode,
    threadPoolMinThreadsPerCpuDeclared: request.profile.threadPool.minThreadsPerCpu,
    baseImageFamily: request.profile.baseImageFamily,
    targetRuntime: request.profile.targetRuntime,
    topologyMode: request.profile.topology.mode
  }
  if (plainObject(reportedRuntime)) {
    for (const [field, value] of Object.entries(identity)) {
      if (reportedRuntime[field] !== undefined && reportedRuntime[field] !== value) throw new Error(`measurement effectiveRuntime.${field} conflicts with inspected image identity`)
    }
  }
  return identity
}

function readDockerInspect(imageRef) {
  const output = runDocker(['image', 'inspect', '--format', '{{json .}}', imageRef], 'image inspect')
  try {
    const inspected = JSON.parse(output)
    if (!plainObject(inspected)) throw new Error('inspect output is not an object')
    return inspected
  } catch (error) {
    throw new Error(`docker image inspect returned invalid JSON: ${messageOf(error)}`)
  }
}

function runDocker(args, label) {
  const child = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
    env: process.env
  })
  if (child.status !== 0) throw new Error(`docker ${label} failed with exit ${child.status ?? 'none'}: ${bounded(child.error?.message || child.stderr || child.stdout)}`)
  return child.stdout
}

function cpusOverlap(left, right) {
  const expand = (value) => {
    if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.test(value)) throw new Error('executor cpuset is invalid')
    const output = new Set()
    for (const part of value.split(',')) {
      const [startText, endText = startText] = part.split('-')
      const start = Number(startText)
      const end = Number(endText)
      if (end < start || end - start > 4096) throw new Error('executor cpuset range is invalid')
      for (let cpu = start; cpu <= end; cpu += 1) output.add(cpu)
    }
    return output
  }
  const first = expand(left)
  return [...expand(right)].some((cpu) => first.has(cpu))
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`unable to read ${label}: ${messageOf(error)}`)
  }
}

function writeExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`)
    options[key.slice(2)] = value
  }
  return options
}

function bounded(value) {
  return String(value).replace(/[\r\n]+/gu, ' ').trim().slice(0, 2048) || 'command failed without diagnostics'
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
