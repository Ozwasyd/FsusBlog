import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const resourceEnforcementSchema = 'fsusblog.production.resource-enforcement.v1'
const controllers = ['cpu', 'memory', 'pids']

function safeSegment(value, name) {
  const segment = String(value ?? '')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(segment)) throw new Error(`${name} is not cgroup-safe`)
  return segment
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return null }
}

function parseKeyValues(value) {
  if (value === null) return null
  return Object.fromEntries(value.split('\n').filter(Boolean).map((line) => {
    const [key, raw] = line.trim().split(/\s+/u)
    const number = Number(raw)
    return [key, Number.isFinite(number) ? number : raw]
  }))
}

function numericOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function selfCgroupPath(procCgroup = readText('/proc/self/cgroup')) {
  const unified = String(procCgroup ?? '').split('\n').find((line) => line.startsWith('0::'))
  return unified ? unified.slice(3) : null
}

export function resolveProductionCgroupCapabilities(options = {}) {
  if ((options.platform ?? process.platform) !== 'linux') {
    return { status: 'unsupported', reason: 'non-linux', cgroupVersion: null, delegateRoot: null, controllers: [] }
  }
  const mountRoot = path.resolve(options.mountRoot ?? '/sys/fs/cgroup')
  const mountType = options.mountType ?? (() => {
    try { return fs.statfsSync(mountRoot).type === 0x63677270 ? 'cgroup2fs' : 'other' } catch { return 'unavailable' }
  })()
  if (mountType !== 'cgroup2fs') {
    return { status: 'unsupported', reason: 'cgroup-v2-unavailable', cgroupVersion: mountType, delegateRoot: null, controllers: [] }
  }
  const explicitRoot = options.delegateRoot ?? process.env.FSUSBLOG_CGROUP_DELEGATE_ROOT
  const relativeSelf = selfCgroupPath(options.procCgroup)
  const delegateRoot = path.resolve(explicitRoot || path.join(mountRoot, relativeSelf ?? '/'))
  if (!delegateRoot.startsWith(`${mountRoot}${path.sep}`) && delegateRoot !== mountRoot) {
    return { status: 'unavailable', reason: 'delegate-root-outside-cgroup-mount', cgroupVersion: 2, delegateRoot, controllers: [] }
  }
  const available = String(readText(path.join(delegateRoot, 'cgroup.controllers')) ?? '').split(/\s+/u).filter(Boolean)
  const missing = controllers.filter((controller) => !available.includes(controller))
  if (missing.length) {
    return { status: 'unavailable', reason: `controllers-missing:${missing.join(',')}`, cgroupVersion: 2, delegateRoot, controllers: available }
  }
  try {
    fs.accessSync(delegateRoot, fs.constants.W_OK)
  } catch {
    return { status: 'unavailable', reason: 'delegate-root-not-writable', cgroupVersion: 2, delegateRoot, controllers: available }
  }
  return { status: 'available', reason: null, cgroupVersion: 2, delegateRoot, controllers: available }
}

function writeControl(file, value) {
  fs.writeFileSync(file, String(value))
  const effective = readText(file)
  return effective
}

function enableControllers(directory) {
  return writeControl(path.join(directory, 'cgroup.subtree_control'), controllers.map((name) => `+${name}`).join(' '))
}

export function resolveCgroupLimits(grant, machine) {
  const cpuUnits = Number(grant.cpuUnits)
  const memoryGiB = Number(grant.memoryGiB)
  const machineCpu = Math.max(1, Number(machine.cpuUnits ?? machine.cpuCount) || os.availableParallelism?.() || 1)
  const machineMemoryBytes = Math.max(1, Number(machine.memoryGiB) * 1024 ** 3 || os.totalmem())
  if (!Number.isFinite(cpuUnits) || cpuUnits <= 0 || !Number.isFinite(memoryGiB) || memoryGiB <= 0) {
    throw new Error('cgroup limits require positive CPU and memory grants')
  }
  const periodUs = Math.max(10_000, Math.min(1_000_000, Math.round(100_000 * Math.sqrt(machineCpu) / Math.sqrt(cpuUnits))))
  const quotaUs = Math.max(1_000, Math.round(periodUs * cpuUnits))
  const memoryHighBytes = Math.max(16 * 1024 ** 2, Math.round(memoryGiB * 1024 ** 3))
  const headroomBytes = Math.max(64 * 1024 ** 2, Math.round(memoryHighBytes / Math.sqrt(machineCpu * 16)))
  const memoryMaxBytes = Math.min(machineMemoryBytes, memoryHighBytes + headroomBytes)
  const cpuWeight = Math.max(1, Math.min(10_000, Math.round(10_000 * cpuUnits / machineCpu)))
  const pidsMax = Math.max(64, Math.min(8192,
    Math.ceil(Math.max(cpuUnits * 128, memoryGiB * 64))))
  return {
    cpuUnits,
    memoryGiB,
    cpuWeight,
    cpuMax: `${quotaUs} ${periodUs}`,
    cpuMaxPolicy: 'hard-grant-ceiling',
    memoryHighBytes,
    memoryMaxBytes,
    memoryHeadroomBytes: memoryMaxBytes - memoryHighBytes,
    pidsMax,
    cpuset: null,
    cpusetStatus: 'disabled-topology-and-numa-not-proven'
  }
}

function sampleCgroup(directory) {
  return {
    path: directory,
    cpuMax: readText(path.join(directory, 'cpu.max')),
    cpuWeight: readText(path.join(directory, 'cpu.weight')),
    cpuStat: parseKeyValues(readText(path.join(directory, 'cpu.stat'))),
    cpuPressure: readText(path.join(directory, 'cpu.pressure')),
    memoryHigh: readText(path.join(directory, 'memory.high')),
    memoryMax: readText(path.join(directory, 'memory.max')),
    memoryCurrent: numericOrNull(readText(path.join(directory, 'memory.current'))),
    memoryEvents: parseKeyValues(readText(path.join(directory, 'memory.events'))),
    memoryPressure: readText(path.join(directory, 'memory.pressure')),
    pidsCurrent: numericOrNull(readText(path.join(directory, 'pids.current'))),
    pidsMax: readText(path.join(directory, 'pids.max')),
    pidsEvents: parseKeyValues(readText(path.join(directory, 'pids.events'))),
    processIds: String(readText(path.join(directory, 'cgroup.procs')) ?? '').split(/\s+/u).filter(Boolean).map(Number),
    sampledAt: new Date().toISOString()
  }
}

export function cleanupStaleProductionCgroups(campaignRoot, { currentRunId = null, removeDirectory } = {}) {
  const result = { removed: [], retainedActive: [], errors: [] }
  if (!fs.existsSync(campaignRoot)) return result
  const remove = removeDirectory ?? ((directory) => fs.rmdirSync(directory))
  for (const entry of fs.readdirSync(campaignRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentRunId) continue
    const runDirectory = path.join(campaignRoot, entry.name)
    const bundles = fs.readdirSync(runDirectory, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory())
      .map((candidate) => path.join(runDirectory, candidate.name))
    if (bundles.some((directory) => String(readText(path.join(directory, 'cgroup.procs')) ?? '').trim() !== '')) {
      result.retainedActive.push(entry.name)
      continue
    }
    try {
      for (const directory of bundles) remove(directory)
      remove(runDirectory)
      result.removed.push(entry.name)
    } catch (error) {
      result.errors.push({ runId: entry.name, error: `${error.code ?? 'error'}:${error.message}` })
    }
  }
  return result
}

function cleanupStaleManagerCgroups(delegateRoot, removeDirectory) {
  const removed = []
  const retainedActive = []
  const remove = removeDirectory ?? ((value) => fs.rmdirSync(value))
  for (const entry of fs.readdirSync(delegateRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.fsusblog-manager-')) continue
    const directory = path.join(delegateRoot, entry.name)
    if (String(readText(path.join(directory, 'cgroup.procs')) ?? '').trim() !== '') {
      retainedActive.push(entry.name)
      continue
    }
    try {
      remove(directory)
      removed.push(entry.name)
    } catch {}
  }
  return { removed, retainedActive }
}

export function createProductionResourceEnforcer(options) {
  const requestedMode = String(options.mode ?? process.env.FSUSBLOG_CGROUP_ENFORCEMENT ?? 'auto').toLowerCase()
  if (!['auto', 'strict', 'advisory', 'off'].includes(requestedMode)) throw new Error(`invalid cgroup enforcement mode: ${requestedMode}`)
  const strict = requestedMode === 'strict' || options.strict === true
  const runId = safeSegment(options.runId, 'runId')
  const bundleIds = [...new Set(options.bundleIds ?? [])].map((value) => safeSegment(value, 'bundleId'))
  const capabilities = resolveProductionCgroupCapabilities(options)
  const evidence = {
    schema: resourceEnforcementSchema,
    requestedMode,
    mode: 'advisory',
    status: capabilities.status,
    reason: capabilities.reason,
    runId,
    machine: options.machine,
    capabilities,
    cpuPolicy: 'cpu.weight plus cpu.max hard grant ceiling; quota is isolation, never a speed optimization',
    memoryPolicy: 'memory.high equals the grant; memory.max adds machine-derived safety headroom',
    cpusetPolicy: 'disabled unless topology, NUMA, and dynamic redistribution are proven',
    bundles: {},
    cleanup: null,
    generatedAt: new Date().toISOString()
  }
  let runRoot = null
  if (!['off', 'advisory'].includes(requestedMode) && capabilities.status === 'available') {
    const createdDirectories = []
    let managerRoot = null
    try {
      evidence.managerCleanup = cleanupStaleManagerCgroups(capabilities.delegateRoot, options.removeDirectory)
      try {
        enableControllers(capabilities.delegateRoot)
      } catch (error) {
        const parentPids = String(readText(path.join(capabilities.delegateRoot, 'cgroup.procs')) ?? '')
          .split(/\s+/u).filter(Boolean).map(Number)
        if (error.code !== 'EBUSY' || parentPids.some((pid) => pid !== process.pid)) throw error
        managerRoot = path.join(capabilities.delegateRoot, `.fsusblog-manager-${runId}`)
        fs.mkdirSync(managerRoot)
        options.prepareDirectory?.(managerRoot)
        writeControl(path.join(managerRoot, 'cgroup.procs'), process.pid)
        evidence.managerCgroup = {
          path: managerRoot,
          pid: process.pid,
          status: 'runner-moved-to-leaf-until-process-exit'
        }
        enableControllers(capabilities.delegateRoot)
      }
      const campaignRoot = path.join(capabilities.delegateRoot, 'fsusblog-production')
      const campaignExisted = fs.existsSync(campaignRoot)
      fs.mkdirSync(campaignRoot, { recursive: true })
      if (!campaignExisted) createdDirectories.push(campaignRoot)
      options.prepareDirectory?.(campaignRoot)
      enableControllers(campaignRoot)
      evidence.staleCleanup = cleanupStaleProductionCgroups(campaignRoot, {
        currentRunId: runId,
        removeDirectory: options.removeDirectory
      })
      runRoot = path.join(campaignRoot, runId)
      fs.mkdirSync(runRoot)
      createdDirectories.push(runRoot)
      options.prepareDirectory?.(runRoot)
      enableControllers(runRoot)
      for (const bundleId of bundleIds) {
        const directory = path.join(runRoot, bundleId)
        fs.mkdirSync(directory)
        createdDirectories.push(directory)
        options.prepareDirectory?.(directory)
        evidence.bundles[bundleId] = { path: directory, grants: [], samples: [], attachedPid: null }
      }
      evidence.mode = 'enforced'
      evidence.status = 'active'
      evidence.reason = null
    } catch (error) {
      evidence.status = 'unavailable'
      evidence.reason = `delegation-setup-failed:${error.code ?? error.message}`
      const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory))
      const cleanupErrors = []
      for (const directory of createdDirectories.reverse()) {
        try { removeDirectory(directory) } catch (cleanupError) {
          if (!['ENOENT', 'ENOTEMPTY', 'EBUSY'].includes(cleanupError.code)) cleanupErrors.push(`${cleanupError.code ?? 'error'}:${directory}`)
        }
      }
      if (managerRoot) {
        try {
          writeControl(path.join(capabilities.delegateRoot, 'cgroup.procs'), process.pid)
          const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory))
          removeDirectory(managerRoot)
        } catch (managerError) {
          cleanupErrors.push(`${managerError.code ?? 'error'}:${managerRoot}`)
        }
      }
      evidence.setupCleanup = { attempted: createdDirectories.length, errors: cleanupErrors }
      runRoot = null
    }
  } else if (requestedMode === 'off') {
    evidence.status = 'disabled'
    evidence.reason = 'explicitly-disabled'
  } else if (requestedMode === 'advisory') {
    evidence.status = 'advisory'
    evidence.reason = 'explicit-advisory-mode'
  }
  if (strict && evidence.mode !== 'enforced') {
    throw new Error(`strict cgroup enforcement unavailable: ${evidence.reason ?? evidence.status}`)
  }

  const update = (bundleIdValue, grant) => {
    const bundleId = safeSegment(bundleIdValue, 'bundleId')
    const limits = resolveCgroupLimits(grant, options.machine)
    const bundle = evidence.bundles[bundleId] ??= { path: null, grants: [], samples: [], attachedPid: null }
    if (evidence.mode === 'enforced') {
      writeControl(path.join(bundle.path, 'cpu.weight'), limits.cpuWeight)
      writeControl(path.join(bundle.path, 'cpu.max'), limits.cpuMax)
      const currentMemoryMax = Number(readText(path.join(bundle.path, 'memory.max')))
      if (Number.isFinite(currentMemoryMax) && currentMemoryMax < limits.memoryMaxBytes) {
        writeControl(path.join(bundle.path, 'memory.max'), limits.memoryMaxBytes)
        writeControl(path.join(bundle.path, 'memory.high'), limits.memoryHighBytes)
      } else {
        writeControl(path.join(bundle.path, 'memory.high'), limits.memoryHighBytes)
        writeControl(path.join(bundle.path, 'memory.max'), limits.memoryMaxBytes)
      }
      writeControl(path.join(bundle.path, 'pids.max'), limits.pidsMax)
    }
    const previous = bundle.grants.at(-1)
    if (!previous || previous.cpuMax !== limits.cpuMax
      || previous.cpuWeight !== limits.cpuWeight
      || previous.memoryHighBytes !== limits.memoryHighBytes
      || previous.memoryMaxBytes !== limits.memoryMaxBytes
      || previous.pidsMax !== limits.pidsMax) {
      bundle.grants.push({ ...limits, effectiveAt: new Date().toISOString() })
    }
    bundle.effectiveLimits = evidence.mode === 'enforced' ? sampleCgroup(bundle.path) : null
    bundle.consistency = evidence.mode === 'enforced' ? {
      status: bundle.effectiveLimits.cpuMax === limits.cpuMax
        && bundle.effectiveLimits.cpuWeight === String(limits.cpuWeight)
        && bundle.effectiveLimits.memoryHigh === String(limits.memoryHighBytes)
        && bundle.effectiveLimits.memoryMax === String(limits.memoryMaxBytes)
        && bundle.effectiveLimits.pidsMax === String(limits.pidsMax)
        ? 'consistent' : 'mismatch',
      declaredGrant: { cpuUnits: limits.cpuUnits, memoryGiB: limits.memoryGiB },
      expected: {
        cpuMax: limits.cpuMax, cpuWeight: String(limits.cpuWeight),
        memoryHigh: String(limits.memoryHighBytes), memoryMax: String(limits.memoryMaxBytes), pidsMax: String(limits.pidsMax)
      },
      effective: {
        cpuMax: bundle.effectiveLimits.cpuMax, cpuWeight: bundle.effectiveLimits.cpuWeight,
        memoryHigh: bundle.effectiveLimits.memoryHigh, memoryMax: bundle.effectiveLimits.memoryMax,
        pidsMax: bundle.effectiveLimits.pidsMax
      }
    } : { status: 'advisory', declaredGrant: { cpuUnits: limits.cpuUnits, memoryGiB: limits.memoryGiB } }
    return { ...limits, mode: evidence.mode, cgroupPath: bundle.path }
  }
  const attach = (bundleIdValue, pid) => {
    const bundleId = safeSegment(bundleIdValue, 'bundleId')
    const bundle = evidence.bundles[bundleId] ??= { path: null, grants: [], samples: [], attachedPid: null }
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) throw new Error('cgroup attach requires a positive PID')
    if (evidence.mode === 'enforced') writeControl(path.join(bundle.path, 'cgroup.procs'), Number(pid))
    bundle.attachedPid = Number(pid)
    bundle.attachStatus = evidence.mode === 'enforced' ? 'attached' : 'advisory'
    return bundle.attachStatus
  }
  const sample = () => {
    for (const bundle of Object.values(evidence.bundles)) {
      if (evidence.mode === 'enforced' && bundle.path) {
        if (bundle.samples.length >= 4096) bundle.samples = bundle.samples.filter((_, index) => index % 2 === 0)
        bundle.samples.push(sampleCgroup(bundle.path))
      }
    }
    return evidence
  }
  const cleanup = () => {
    sample()
    if (evidence.mode !== 'enforced' || !runRoot) {
      evidence.cleanup = { status: 'not-applicable', completedAt: new Date().toISOString() }
      return evidence.cleanup
    }
    const busy = Object.entries(evidence.bundles).filter(([, bundle]) =>
      String(readText(path.join(bundle.path, 'cgroup.procs')) ?? '').trim() !== '')
    if (busy.length) {
      evidence.cleanup = { status: 'retained-active', bundles: busy.map(([bundleId]) => bundleId), completedAt: new Date().toISOString() }
      return evidence.cleanup
    }
    try {
      const removeDirectory = options.removeDirectory ?? ((directory) => fs.rmdirSync(directory))
      for (const bundle of Object.values(evidence.bundles)) removeDirectory(bundle.path)
      removeDirectory(runRoot)
      const campaignRoot = path.dirname(runRoot)
      try { removeDirectory(campaignRoot) } catch (error) { if (!['ENOTEMPTY', 'EBUSY'].includes(error.code)) throw error }
      evidence.cleanup = { status: 'removed', completedAt: new Date().toISOString() }
    } catch (error) {
      evidence.cleanup = { status: 'failed', error: `${error.code ?? 'error'}:${error.message}`, completedAt: new Date().toISOString() }
    }
    return evidence.cleanup
  }
  return {
    mode: evidence.mode,
    capabilities,
    update,
    attach,
    sample,
    cleanup,
    environment(bundleId) {
      const bundle = evidence.bundles[safeSegment(bundleId, 'bundleId')]
      return {
        FSUSBLOG_CGROUP_ENFORCEMENT_MODE: evidence.mode,
        FSUSBLOG_CGROUP_BUNDLE_PATH: bundle?.path ?? '',
        FSUSBLOG_CGROUP_ENFORCEMENT_REASON: evidence.reason ?? ''
      }
    },
    evidence: () => evidence
  }
}

export function dockerResourceArguments(environment = process.env) {
  const cpuUnits = Number(environment.FSUSBLOG_DOCKER_CPU_UNITS)
  const memoryBytes = Number(environment.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES)
  const memoryHighBytes = Number(environment.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES)
  const pidsMax = Number(environment.FSUSBLOG_DOCKER_PIDS_MAX)
  if (![cpuUnits, memoryBytes, memoryHighBytes, pidsMax].every((value) => Number.isFinite(value) && value > 0)) return []
  const labels = [
    ['io.fsusblog.test.run-id', environment.FSUSBLOG_TEST_RUN_ID],
    ['io.fsusblog.test.bundle-id', environment.FSUSBLOG_PHYSICAL_BUNDLE_ID],
    ['io.fsusblog.test.step-id', environment.FSUSBLOG_STEP_ID],
    ['io.fsusblog.test.cpu-units', cpuUnits],
    ['io.fsusblog.test.memory-high-bytes', memoryHighBytes],
    ['io.fsusblog.test.memory-max-bytes', memoryBytes],
    ['io.fsusblog.test.pids-max', pidsMax]
  ].filter(([, value]) => String(value ?? '').trim() !== '')
  return [
    '--cpus', String(cpuUnits),
    '--memory-reservation', String(Math.round(memoryHighBytes)),
    '--memory', String(Math.round(memoryBytes)),
    '--pids-limit', String(Math.round(pidsMax)),
    ...labels.flatMap(([key, value]) => ['--label', `${key}=${value}`])
  ]
}
