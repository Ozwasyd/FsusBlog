#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { executeWeightedStepDag } from './bundles/bundle-steps.mjs'
import { loadCommandGroup } from '../test-matrix/command-groups.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bytesPerGiB = 1024 ** 3
const protectedResourceEnvironment = new Set([
  'FSUSBLOG_STEP_CPU_BUDGET',
  'FSUSBLOG_STEP_MEMORY_GIB',
  'FSUSBLOG_COMMAND_MANIFEST_WORKERS',
  'FSUSBLOG_NODE_TEST_CONCURRENCY',
  'FSUSBLOG_PARALLEL_ACTIVE_WORKERS'
])
const manifestMemoryClasses = new Map([
  ['tiny', 0.125],
  ['standard', 0.25],
  ['heavy', 0.5]
])

function evidenceSlug(value) {
  const slug = String(value ?? 'manifest').replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return slug && slug !== '.' && slug !== '..' ? slug : 'manifest'
}

export function writeLiveGrantEvidence(file, evidence) {
  if (!file) return
  const absolute = path.resolve(file)
  mkdirSync(path.dirname(absolute), { recursive: true })
  const temporary = `${absolute}.next-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`)
  renameSync(temporary, absolute)
}

function positiveInteger(value) {
  const parsed = Number(String(value ?? ''))
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function optionalPositiveNumber(env, names) {
  for (const name of names) {
    if (env[name] === undefined || String(env[name]).trim() === '') continue
    const parsed = Number(env[name])
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive finite number`)
    }
    return parsed
  }
  return null
}

export function readManifestSchedulerResourceGrant({
  env = process.env,
  readFile = (file) => readFileSync(file, 'utf8')
} = {}) {
  const grantFile = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim()
  const tierId = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim()
  if (!grantFile && !tierId) return null
  if (!grantFile || !tierId) {
    throw new Error('command manifest scheduler grant requires both resource grant file and tier id')
  }
  const runId = String(env.FSUSBLOG_TEST_RUN_ID ?? '').trim()
  if (!runId) throw new Error('command manifest scheduler grant requires FSUSBLOG_TEST_RUN_ID')

  let document
  try {
    document = JSON.parse(readFile(path.resolve(grantFile)))
  } catch (error) {
    throw new Error(`command manifest scheduler grant is unreadable: ${grantFile}`, { cause: error })
  }
  if (document?.schema !== 'fsusblog.test-matrix.resource-grants.v1') {
    throw new Error('command manifest scheduler grant has an invalid schema')
  }
  if (document.runId !== runId) {
    throw new Error(
      `command manifest scheduler grant runId mismatch: expected ${runId}, received ${document.runId ?? '<missing>'}`
    )
  }
  const grant = document.grants?.[tierId]
  const budget = document.resourceBudget
  const cpuUnits = Number(grant?.cpuUnits)
  const memoryGiB = Number(grant?.memoryGiB)
  const budgetCpuUnits = Number(budget?.cpuUnits)
  const budgetMemoryGiB = Number(budget?.memoryGiB)
  if (!Number.isInteger(cpuUnits) || cpuUnits < 1
    || !Number.isFinite(memoryGiB) || memoryGiB <= 0
    || !Number.isInteger(budgetCpuUnits) || budgetCpuUnits < cpuUnits
    || !Number.isFinite(budgetMemoryGiB) || budgetMemoryGiB < memoryGiB) {
    throw new Error(`command manifest scheduler grant is invalid for tier ${tierId}`)
  }
  return { cpuUnits, memoryGiB, budgetCpuUnits, budgetMemoryGiB }
}

const commandManifestSchemas = new Set([
  'fsusblog.test-command-manifest.v1',
  'fsusblog.frontend-static-command-manifest.v2'
])
const frontendStaticStages = new Set([
  'blocking-prebuild',
  'concurrent',
  'postbuild',
  'isolated',
  'final'
])

function stringArrayErrors(value, name, { required = false } = {}) {
  if (!Array.isArray(value)) return [`${name} must be an array`]
  if (required && value.length === 0) return [`${name} must be a non-empty array`]
  if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return [`${name} must contain only non-empty strings`]
  }
  if (new Set(value).size !== value.length) return [`${name} must not contain duplicates`]
  return []
}

function validateFrontendStaticMetadata(command, label) {
  const errors = []
  if (!frontendStaticStages.has(command?.stage)) {
    errors.push(`${label}.stage must be blocking-prebuild, concurrent, postbuild, isolated, or final`)
  }
  if (typeof command?.reason !== 'string' || !command.reason.trim()) {
    errors.push(`${label}.reason must be a non-empty string`)
  }
  errors.push(...stringArrayErrors(command?.consumedInputs, `${label}.consumedInputs`, { required: true }))
  errors.push(...stringArrayErrors(command?.ownedOutputs, `${label}.ownedOutputs`))
  errors.push(...stringArrayErrors(command?.dependsOn, `${label}.dependsOn`))
  if (!command?.resources || Array.isArray(command.resources) || typeof command.resources !== 'object') {
    errors.push(`${label}.resources must be an object`)
  } else {
    for (const field of ['cpuWeight', 'memoryWeight', 'minCpuUnits']) {
      const value = Number(command.resources[field])
      if (!Number.isFinite(value) || value <= 0) errors.push(`${label}.resources.${field} must be positive`)
    }
    errors.push(...stringArrayErrors(
      command.resources.exclusiveResources,
      `${label}.resources.exclusiveResources`
    ))
  }
  if (command?.access === 'write' && Array.isArray(command.ownedOutputs) && command.ownedOutputs.length === 0) {
    errors.push(`${label}.ownedOutputs must identify every write target`)
  }
  return errors
}

export function validateCommandManifest(manifest) {
  const errors = []
  if (!commandManifestSchemas.has(manifest?.schema)) {
    errors.push('schema must be fsusblog.test-command-manifest.v1 or fsusblog.frontend-static-command-manifest.v2')
  }
  if (typeof manifest?.lane !== 'string' || !manifest.lane.trim()) {
    errors.push('lane must be a non-empty string')
  }
  if (!Array.isArray(manifest?.commands) || manifest.commands.length === 0) {
    errors.push('commands must be a non-empty array')
    return errors
  }

  const ids = new Set()
  const allCommands = []
  const visit = (command, label) => {
    if (typeof command?.id !== 'string' || !command.id.trim()) errors.push('command id must be non-empty')
    else if (ids.has(command.id)) errors.push(`duplicate command id: ${command.id}`)
    else ids.add(command.id)
    allCommands.push(command)
    if (!['read', 'write'].includes(command?.access)) errors.push(`${command?.id ?? 'unknown'}.access must be read or write`)
    const hasScript = typeof command?.script === 'string' && command.script.trim().length > 0
    const hasCommand = Array.isArray(command?.command) && command.command.length > 0 && command.command.every((part) => typeof part === 'string')
    if (hasScript === hasCommand) errors.push(`${command?.id ?? 'unknown'} must declare exactly one of script or command`)
    if (command?.estimatedDurationMs !== undefined
      && (!Number.isFinite(Number(command.estimatedDurationMs)) || Number(command.estimatedDurationMs) <= 0)) {
      errors.push(`${command?.id ?? 'unknown'}.estimatedDurationMs must be a positive finite number`)
    }
    if (command?.concurrencyWeight !== undefined && positiveInteger(command.concurrencyWeight) === null) {
      errors.push(`${command?.id ?? 'unknown'}.concurrencyWeight must be a positive integer`)
    }
    if (command?.memoryCostGiB !== undefined
      && (!Number.isFinite(Number(command.memoryCostGiB)) || Number(command.memoryCostGiB) <= 0)) {
      errors.push(`${command?.id ?? 'unknown'}.memoryCostGiB must be a positive finite number`)
    }
    if (command?.memoryClass !== undefined && !manifestMemoryClasses.has(command.memoryClass)) {
      errors.push(`${command?.id ?? 'unknown'}.memoryClass must be tiny, standard, or heavy`)
    }
    if (command?.memoryCostGiB !== undefined && command?.memoryClass !== undefined) {
      errors.push(`${command?.id ?? 'unknown'} must declare only one of memoryCostGiB or memoryClass`)
    }
    if (command?.environment !== undefined
      && (!command.environment || Array.isArray(command.environment) || typeof command.environment !== 'object'
        || Object.values(command.environment).some((value) => typeof value !== 'string'))) {
      errors.push(`${command?.id ?? 'unknown'}.environment must contain only string values`)
    } else if (command.environment
      && Object.keys(command.environment).some((name) => protectedResourceEnvironment.has(name))) {
      errors.push(`${command?.id ?? 'unknown'}.environment must not override resource safety boundaries`)
    }
    if (manifest.schema === 'fsusblog.test-command-manifest.v1') {
      for (const field of ['consumedInputs', 'ownedOutputs', 'exclusiveResources', 'dependsOn', 'settledDependsOn']) {
        if (command?.[field] !== undefined) {
          errors.push(...stringArrayErrors(command[field], `${label}.${field}`))
        }
      }
    }
    if (manifest.schema === 'fsusblog.test-command-manifest.v1'
      && command?.access === 'write'
      && (!Array.isArray(command.ownedOutputs) || command.ownedOutputs.length === 0)) {
      errors.push(`${label}.ownedOutputs must identify every write target`)
    }
    if (manifest.schema === 'fsusblog.frontend-static-command-manifest.v2') {
      errors.push(...validateFrontendStaticMetadata(command, label))
      if (command.localCommands !== undefined) {
        if (!Array.isArray(command.localCommands) || command.localCommands.length === 0) {
          errors.push(`${label}.localCommands must be a non-empty array`)
        } else {
          command.localCommands.forEach((child, index) => visit(child, `${label}.localCommands[${index}]`))
        }
      }
    }
  }
  manifest.commands.forEach((command, index) => visit(command, `commands[${index}]`))

  for (const command of allCommands) {
    for (const field of ['dependsOn', 'settledDependsOn']) {
      for (const dependency of command[field] ?? []) {
        if (!ids.has(dependency)) errors.push(`${command.id}.dependsOn references unknown command: ${dependency}`)
        if (dependency === command.id) errors.push(`${command.id}.dependsOn must not reference itself`)
      }
    }
  }
  return errors
}

export function resolveManifestWorkers({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  load1 = os.loadavg()[0] ?? 0
} = {}) {
  const override = positiveInteger(env.FSUSBLOG_COMMAND_MANIFEST_WORKERS)
  if (env.FSUSBLOG_COMMAND_MANIFEST_WORKERS !== undefined
    && String(env.FSUSBLOG_COMMAND_MANIFEST_WORKERS).trim() !== ''
    && override === null) {
    throw new Error('FSUSBLOG_COMMAND_MANIFEST_WORKERS must be a positive integer')
  }
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const totalMemory = Math.max(1, Number(totalMemoryBytes) || Number(freeMemoryBytes) || 1)
  const memoryPerCpu = totalMemory / cpus
  const cpuGrant = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ])
  const memoryGrantGiB = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ])
  const schedulerControlled = cpuGrant !== null || memoryGrantGiB !== null
  const cpuCap = Math.max(1, Math.floor(Math.min(cpus, cpuGrant ?? cpus)))
  const memoryBytes = schedulerControlled && memoryGrantGiB !== null
    ? memoryGrantGiB * 1024 ** 3
    : Math.max(0, Number(freeMemoryBytes) || 0)
  // A scheduler grant has already been admitted against both live CPU and
  // available memory. Reapplying the host-average memory-per-CPU ratio here
  // double-counts that constraint and can collapse a multi-CPU step to one
  // child even though the scheduler deliberately packed it into a smaller
  // memory share. Direct invocation still needs the host-derived guard.
  const memoryCap = schedulerControlled
    ? cpuCap
    : Math.max(1, Math.floor(memoryBytes / memoryPerCpu))
  const loadCap = schedulerControlled
    ? cpus
    : Math.max(1, Math.floor(cpus - Math.max(0, Number(load1) || 0)))
  return Math.max(1, Math.min(cpuCap, memoryCap, loadCap, override ?? Number.POSITIVE_INFINITY))
}

export function resolveNestedManifestMemoryGiBPerWorker({
  env = process.env,
  defaultMemoryGiBPerWorker = 0.25
} = {}) {
  const fallback = Number(defaultMemoryGiBPerWorker)
  if (!Number.isFinite(fallback) || fallback <= 0) {
    throw new Error('defaultMemoryGiBPerWorker must be a positive number')
  }
  const inheritedMemoryGiB = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ])
  if (inheritedMemoryGiB === null) return fallback
  const workers = resolveManifestWorkers({ env })
  return Math.min(fallback, inheritedMemoryGiB / workers)
}

// Long-lived orchestration steps can outlive the resource pressure that fixed
// their initial child budget. Re-read the scheduler's atomic grant immediately
// before a new independent wave, but consume only currently idle host CPU and
// memory. This keeps the ordinary resolver strict while allowing a late wave to
// use capacity that the scheduler has explicitly released to this bundle.
function resolveAdaptiveManifestWorkersFromGrant({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  load1 = os.loadavg()[0] ?? 0,
  workload = 'cpu',
  orchestrationWorkersPerCpu = 2,
  orchestrationMemoryGiBPerWorker = 0.125
} = {}, grant) {
  const runtime = { env, cpuCount, freeMemoryBytes, totalMemoryBytes, load1 }
  const baseWorkers = resolveManifestWorkers(runtime)
  const cpus = Math.max(1, Math.floor(Number(cpuCount) || 1))
  const override = positiveInteger(env.FSUSBLOG_COMMAND_MANIFEST_WORKERS)
  let liveWorkers = baseWorkers
  if (grant) {
    const liveCpuCap = Math.max(1, Math.min(cpus, grant.cpuUnits))
    // The scheduler has already admitted this live grant against the current
    // CPU load and memory budget. Applying host load or host-average memory per
    // CPU again here double-counts pressure (and is especially wrong when the
    // process sees a host total-memory value larger than its CPU/memory scope).
    // Trust the atomic current-run grant; the manifest override remains the
    // caller's explicit upper bound.
    liveWorkers = Math.max(1, Math.min(
      liveCpuCap,
      override ?? Number.POSITIVE_INFINITY
    ))
  }
  if (workload === 'scheduler-admitted') {
    const admittedWorkers = grant
      ? Math.max(1, Math.min(cpus, grant.cpuUnits, override ?? Number.POSITIVE_INFINITY))
      : baseWorkers
    return admittedWorkers
  }
  if (workload !== 'orchestration') return liveWorkers

  const stepCpu = grant?.cpuUnits ?? optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ]) ?? 1
  const stepMemoryGiB = grant?.memoryGiB ?? optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ]) ?? (Number(freeMemoryBytes) / 1024 ** 3)
  const fanout = positiveInteger(orchestrationWorkersPerCpu)
  if (fanout === null) throw new Error('orchestrationWorkersPerCpu must be a positive integer')
  const memoryPerWorkerGiB = Number(orchestrationMemoryGiBPerWorker)
  if (!Number.isFinite(memoryPerWorkerGiB) || memoryPerWorkerGiB <= 0) {
    throw new Error('orchestrationMemoryGiBPerWorker must be a positive number')
  }
  // These manifests orchestrate subprocess fixtures whose wall time is mostly
  // bounded waits and file handshakes. The caller selects the measured fanout
  // for its fixture type while memory remains the 128 MiB-per-child bound. A
  // direct focused bundle has no live grant file, but its inherited STEP grant
  // is still authoritative and must receive the same bounded fanout.
  const orchestrationCpuCap = Math.max(1, Math.floor(stepCpu * fanout))
  const orchestrationMemoryCap = Math.max(1, Math.floor(stepMemoryGiB / memoryPerWorkerGiB))
  const orchestrationWorkers = Math.min(
    cpus,
    orchestrationCpuCap,
    orchestrationMemoryCap,
    override ?? Number.POSITIVE_INFINITY
  )
  return grant ? Math.max(1, orchestrationWorkers) : Math.max(baseWorkers, orchestrationWorkers)
}

export function resolveAdaptiveManifestWorkers(options = {}) {
  const env = options.env ?? process.env
  const grant = readManifestSchedulerResourceGrant({ env, readFile: options.readGrantFile })
  return resolveAdaptiveManifestWorkersFromGrant(options, grant)
}

export function resolveManifestLiveCapacity({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  load1 = os.loadavg()[0] ?? 0,
  readGrantFile,
  workload = 'orchestration',
  orchestrationWorkersPerCpu = 2,
  orchestrationMemoryGiBPerWorker = 0.125
} = {}) {
  const grant = readManifestSchedulerResourceGrant({ env, readFile: readGrantFile })
  const workers = resolveAdaptiveManifestWorkersFromGrant({
    env,
    cpuCount,
    freeMemoryBytes,
    totalMemoryBytes,
    load1,
    workload,
    orchestrationWorkersPerCpu,
    orchestrationMemoryGiBPerWorker
  }, grant)
  const inheritedCpu = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ])
  const inheritedMemoryGiB = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ])
  const parentCpuUnits = grant?.cpuUnits ?? inheritedCpu ?? workers
  const parentMemoryGiB = grant?.memoryGiB
    ?? inheritedMemoryGiB
    ?? Math.max(orchestrationMemoryGiBPerWorker, Number(freeMemoryBytes) / bytesPerGiB)
  return {
    schema: 'fsusblog.live-grant-capacity.v1',
    maxParallel: workers,
    cpuUnits: workers,
    memoryGiB: parentMemoryGiB,
    parentCpuUnits,
    parentMemoryGiB,
    source: grant ? 'scheduler-resource-grants' : 'direct-invocation-fallback'
  }
}

export function resolveManifestRuntimeChildEnvironment({
  env = process.env,
  runtimeCapacity,
  parentCapacity
} = {}) {
  const slots = Number(parentCapacity?.cpuUnits)
  const childSlots = Number(runtimeCapacity?.cpuUnits)
  const childMemoryGiB = Number(runtimeCapacity?.memoryGiB)
  const parentCpuUnits = Number(parentCapacity?.parentCpuUnits)
  if (!Number.isFinite(slots) || slots <= 0
    || !Number.isFinite(childSlots) || childSlots <= 0
    || !Number.isFinite(childMemoryGiB) || childMemoryGiB <= 0
    || !Number.isFinite(parentCpuUnits) || parentCpuUnits <= 0) {
    throw new Error('manifest child runtime capacity must be positive')
  }
  const childCpuUnits = parentCpuUnits * childSlots / slots
  const nestedWorkers = Math.max(1, Math.floor(childCpuUnits))
  return {
    ...env,
    FSUSBLOG_STEP_CPU_BUDGET: String(childCpuUnits),
    FSUSBLOG_STEP_MEMORY_GIB: String(childMemoryGiB),
    FSUSBLOG_PARALLEL_ACTIVE_WORKERS: String(parentCapacity.maxParallel),
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(nestedWorkers),
    FSUSBLOG_NODE_TEST_CONCURRENCY: String(nestedWorkers)
  }
}

export function resolveManifestChildEnvironment({
  env = process.env,
  workers,
  concurrent = true,
  concurrencyWeight = 1
} = {}) {
  const workerCount = positiveInteger(workers)
  if (workerCount === null) throw new Error('workers must be a positive integer')
  const workerWeight = positiveInteger(concurrencyWeight)
  if (workerWeight === null) throw new Error('concurrencyWeight must be a positive integer')
  const boundedWeight = Math.min(workerCount, workerWeight)
  const divisor = concurrent ? workerCount / boundedWeight : 1
  const cpuGrant = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ])
  const memoryGrantGiB = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_MEMORY_GIB',
    'FSUSBLOG_BUNDLE_MEMORY_GIB'
  ])
  const nestedWorkers = Math.max(1, Math.floor((cpuGrant ?? workerCount) / divisor))
  return {
    ...env,
    ...(cpuGrant === null ? {} : { FSUSBLOG_STEP_CPU_BUDGET: String(cpuGrant / divisor) }),
    ...(memoryGrantGiB === null ? {} : { FSUSBLOG_STEP_MEMORY_GIB: String(memoryGrantGiB / divisor) }),
    FSUSBLOG_PARALLEL_ACTIVE_WORKERS: String(concurrent ? workerCount : 1),
    FSUSBLOG_COMMAND_MANIFEST_WORKERS: String(nestedWorkers),
    FSUSBLOG_NODE_TEST_CONCURRENCY: String(nestedWorkers)
  }
}

function commandArguments(entry) {
  return entry.script
    ? ['npm', 'run', entry.script]
    : entry.command
}

export async function executeManifestEntry(entry, { cwd, env, signal }) {
  const command = commandArguments(entry)
  console.log(`[command-manifest] start id=${entry.id} access=${entry.access}`)
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: {
        ...env,
        ...Object.fromEntries(Object.entries(entry.environment ?? {})
          .filter(([name]) => !protectedResourceEnvironment.has(name)))
      },
      stdio: 'inherit',
      signal
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${entry.id} failed (${signal ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
  console.log(`[command-manifest] done id=${entry.id} durationMs=${Date.now() - startedAt}`)
}

export function planWeightedManifestEntries(commands) {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((left, right) => {
      const durationDelta = Number(right.command.estimatedDurationMs ?? 1)
        - Number(left.command.estimatedDurationMs ?? 1)
      return durationDelta || left.index - right.index
    })
    .map(({ command }) => command)
}

function materializeManifestDependencies(manifest) {
  if (manifest.schema !== 'fsusblog.test-command-manifest.v1') return manifest
  const commands = manifest.commands.map((command) => ({
    ...command,
    dependsOn: [...(command.dependsOn ?? [])],
    settledDependsOn: [...(command.settledDependsOn ?? [])]
  }))
  const overlaps = (left, right) => left.some((value) => right.includes(value))
  for (let rightIndex = 0; rightIndex < commands.length; rightIndex += 1) {
    const right = commands[rightIndex]
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const left = commands[leftIndex]
      const conflict = overlaps(left.ownedOutputs ?? [], [
        ...(right.consumedInputs ?? []),
        ...(right.ownedOutputs ?? [])
      ]) || overlaps(right.ownedOutputs ?? [], left.consumedInputs ?? [])
      if (conflict && !right.settledDependsOn.includes(left.id)) right.settledDependsOn.push(left.id)
    }
  }
  return { ...manifest, commands }
}

function manifestEntryMemoryCost(entry, defaultMemoryGiB) {
  if (entry.memoryCostGiB !== undefined) return Number(entry.memoryCostGiB)
  if (entry.memoryClass !== undefined) return manifestMemoryClasses.get(entry.memoryClass)
  return defaultMemoryGiB * Number(entry.resources?.memoryWeight ?? 1)
}

function manifestEntryStep(entry, defaultMemoryGiB) {
  const declaredWeight = positiveInteger(entry.concurrencyWeight)
  const exclusiveCapacity = declaredWeight === Number.MAX_SAFE_INTEGER
  return {
    ...entry,
    dependsOn: entry.dependsOn ?? [],
    resources: {
      cpuWeight: Number(entry.resources?.cpuWeight ?? (exclusiveCapacity ? 1 : declaredWeight ?? 1)),
      memoryWeight: Number(entry.resources?.memoryWeight ?? 1),
      minCpuUnits: Number(entry.resources?.minCpuUnits ?? (exclusiveCapacity ? 1 : declaredWeight ?? 1)),
      minMemoryGiB: manifestEntryMemoryCost(entry, defaultMemoryGiB),
      exclusiveResources: entry.resources?.exclusiveResources ?? entry.exclusiveResources ?? [],
      exclusiveCapacity
    }
  }
}

export async function runWeightedCommandManifest(manifest, {
  cwd = process.cwd(),
  env = process.env,
  workload = 'orchestration',
  orchestrationWorkersPerCpu = 2,
  orchestrationMemoryGiBPerWorker = 0.125,
  resolveWorkers,
  readGrantFile,
  execute = executeManifestEntry,
  signal,
  evidenceFile = String(env.FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE ?? '').trim() || null
} = {}) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const deadlineAtMs = env.FSUSBLOG_EXECUTION_DEADLINE_AT_MS === undefined
    ? null
    : Number(env.FSUSBLOG_EXECUTION_DEADLINE_AT_MS)
  if (deadlineAtMs !== null && (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= 0)) {
    throw new Error('FSUSBLOG_EXECUTION_DEADLINE_AT_MS must be a positive finite epoch timestamp')
  }
  const executionController = deadlineAtMs === null ? null : new AbortController()
  let deadlineExpired = false
  let deadlineTimer
  const forwardCancellation = () => executionController?.abort(signal.reason)
  if (executionController) {
    if (signal?.aborted) forwardCancellation()
    else signal?.addEventListener('abort', forwardCancellation, { once: true })
    const delayMs = Math.max(0, deadlineAtMs - Date.now())
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true
      executionController.abort(new Error(`command manifest execution deadline exceeded: ${deadlineAtMs}`))
    }, delayMs)
  }
  const executionSignal = executionController?.signal ?? signal

  const executionManifest = materializeManifestDependencies(manifest)
  const planned = planWeightedManifestEntries(executionManifest.commands)
  const steps = planned.map((entry) => manifestEntryStep(entry, orchestrationMemoryGiBPerWorker))
  const exclusiveResources = [...new Set(steps.flatMap((entry) => entry.resources.exclusiveResources))]
  const grantFileConfigured = Boolean(String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim())
  const grantTierConfigured = Boolean(String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim())
  const hasLiveGrant = grantFileConfigured && grantTierConfigured
  const evidence = {
    schema: 'fsusblog.live-grant-execution.v1',
    lane: manifest.lane,
    executionMode: grantFileConfigured || grantTierConfigured ? 'live-grant' : 'fixed',
    schedulerRunId: env.FSUSBLOG_TEST_RUN_ID ?? null,
    grantHistory: [],
    children: [],
    blocked: [],
    startedAtMs: Date.now()
  }
  const lastWaitState = new Map()
  let currentCapacity
  let capacitySignature = ''
  const capacityProvider = () => {
    if (resolveWorkers) {
      const workers = Number(resolveWorkers())
      if (!Number.isInteger(workers) || workers < 1) throw new Error('resolveWorkers must return a positive integer')
      const parentCpuUnits = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_CPU_BUDGET',
        'FSUSBLOG_BUNDLE_CPU_UNITS',
        'FSUSBLOG_BUNDLE_CPU_BUDGET'
      ]) ?? workers
      const parentMemoryGiB = optionalPositiveNumber(env, [
        'FSUSBLOG_STEP_MEMORY_GIB',
        'FSUSBLOG_BUNDLE_MEMORY_GIB'
      ]) ?? Math.max(orchestrationMemoryGiBPerWorker, os.freemem() / bytesPerGiB)
      currentCapacity = {
        schema: 'fsusblog.live-grant-capacity.v1',
        maxParallel: workers,
        cpuUnits: workers,
        memoryGiB: parentMemoryGiB,
        parentCpuUnits,
        parentMemoryGiB,
        source: 'injected-capacity-resolver'
      }
    } else {
      currentCapacity = resolveManifestLiveCapacity({
        env,
        readGrantFile,
        workload,
        orchestrationWorkersPerCpu,
        orchestrationMemoryGiBPerWorker
      })
    }
    const signature = JSON.stringify([
      currentCapacity.maxParallel,
      currentCapacity.cpuUnits,
      currentCapacity.memoryGiB,
      currentCapacity.parentCpuUnits,
      currentCapacity.source
    ])
    if (signature !== capacitySignature) {
      capacitySignature = signature
      evidence.grantHistory.push({ ...currentCapacity, observedAtMs: Date.now() })
    }
    return {
      ...currentCapacity,
      exclusiveResources,
      signal: executionSignal,
      onWaitState: (id, waitState) => {
        const next = JSON.stringify(waitState)
        if (lastWaitState.get(id) === next) return
        lastWaitState.set(id, next)
        if (waitState) evidence.blocked.push({ id, ...waitState, observedAtMs: Date.now() })
      }
    }
  }
  try {
    const initialCapacity = capacityProvider()
    await executeWeightedStepDag(steps, hasLiveGrant ? capacityProvider : initialCapacity, async (entry) => {
      const admittedAtMs = Date.now()
      const childEnv = resolveManifestRuntimeChildEnvironment({
        env,
        runtimeCapacity: entry.runtimeCapacity,
        parentCapacity: currentCapacity
      })
      const childEvidence = {
        id: entry.id,
        status: 'running',
        admittedAtMs,
        activeWeight: entry.runtimeCapacity.cpuUnits,
        cpuBudget: Number(childEnv.FSUSBLOG_STEP_CPU_BUDGET),
        memoryGiB: Number(childEnv.FSUSBLOG_STEP_MEMORY_GIB),
        nestedWorkers: Number(childEnv.FSUSBLOG_COMMAND_MANIFEST_WORKERS)
      }
      evidence.children.push(childEvidence)
      try {
        await execute(entry, { cwd, env: childEnv, signal: executionSignal })
        childEvidence.status = 'success'
      } catch (error) {
        childEvidence.status = deadlineExpired
          ? 'timed-out'
          : executionSignal?.aborted ? 'cancelled' : 'failure'
        childEvidence.error = error instanceof Error ? error.message : String(error)
        throw new Error(`${entry.id}: ${childEvidence.error}`, { cause: error })
      } finally {
        childEvidence.finishedAtMs = Date.now()
        childEvidence.durationMs = childEvidence.finishedAtMs - admittedAtMs
      }
    })
    evidence.status = 'success'
  } catch (error) {
    evidence.status = deadlineExpired
      ? 'timed-out'
      : executionSignal?.aborted ? 'cancelled' : 'failure'
    evidence.error = error instanceof Error ? error.message : String(error)
    const failedChildren = evidence.children.filter((child) => child.status === 'failure')
    const reportedError = error instanceof AggregateError && failedChildren.length > 0
      ? new AggregateError(error.errors, [
          `${failedChildren.length} weighted command manifest entries failed:`,
          ...failedChildren.map((child) => `- ${child.id}: ${child.error}`)
        ].join('\n'))
      : error
    if (reportedError && typeof reportedError === 'object') reportedError.liveGrantEvidence = evidence
    throw reportedError
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
    signal?.removeEventListener('abort', forwardCancellation)
    evidence.finishedAtMs = Date.now()
    evidence.durationMs = evidence.finishedAtMs - evidence.startedAtMs
    writeLiveGrantEvidence(evidenceFile, evidence)
  }
  return evidence
}

export async function runCommandManifest(manifest, { cwd = process.cwd(), env = process.env } = {}) {
  return runWeightedCommandManifest(manifest, {
    cwd,
    env,
    workload: 'scheduler-admitted',
    orchestrationMemoryGiBPerWorker: resolveNestedManifestMemoryGiBPerWorker({ env })
  })
}

async function main(argv) {
  const groupIndex = argv.indexOf('--matrix-group')
  if (groupIndex < 0) {
    throw new Error('usage: run-command-manifest.mjs --matrix-group <id> [--cwd path]')
  }
  const cwdIndex = argv.indexOf('--cwd')
  const cwd = cwdIndex >= 0 ? path.resolve(argv[cwdIndex + 1] ?? '') : process.cwd()
  const manifest = loadCommandGroup(repoRoot, argv[groupIndex + 1])
  const runId = evidenceSlug(process.env.FSUSBLOG_TEST_RUN_ID ?? 'direct')
  const evidenceFile = String(process.env.FSUSBLOG_LIVE_GRANT_EVIDENCE_FILE ?? '').trim()
    || path.join(repoRoot, '.tmp', 'test-results', 'live-grant', runId, `${evidenceSlug(manifest.lane)}.json`)
  const controller = new AbortController()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => controller.abort(new Error(`command manifest cancelled by ${signal}`)))
  }
  await runWeightedCommandManifest(manifest, {
    cwd,
    env: process.env,
    workload: 'scheduler-admitted',
    orchestrationMemoryGiBPerWorker: 0.25,
    signal: controller.signal,
    evidenceFile
  })
  console.log(`[command-manifest] ok lane=${manifest.lane} commands=${manifest.commands.length}`)
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[command-manifest] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
