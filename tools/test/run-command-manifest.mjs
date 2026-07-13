#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

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

export function validateCommandManifest(manifest) {
  const errors = []
  if (manifest?.schema !== 'fsusblog.test-command-manifest.v1') {
    errors.push('schema must be fsusblog.test-command-manifest.v1')
  }
  if (typeof manifest?.lane !== 'string' || !manifest.lane.trim()) {
    errors.push('lane must be a non-empty string')
  }
  if (!Array.isArray(manifest?.commands) || manifest.commands.length === 0) {
    errors.push('commands must be a non-empty array')
    return errors
  }

  const ids = new Set()
  for (const command of manifest.commands) {
    if (typeof command?.id !== 'string' || !command.id.trim()) errors.push('command id must be non-empty')
    else if (ids.has(command.id)) errors.push(`duplicate command id: ${command.id}`)
    else ids.add(command.id)
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
    if (command?.environment !== undefined
      && (!command.environment || Array.isArray(command.environment) || typeof command.environment !== 'object'
        || Object.values(command.environment).some((value) => typeof value !== 'string'))) {
      errors.push(`${command?.id ?? 'unknown'}.environment must contain only string values`)
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

// Long-lived orchestration steps can outlive the resource pressure that fixed
// their initial child budget. Re-read the scheduler's atomic grant immediately
// before a new independent wave, but consume only currently idle host CPU and
// memory. This keeps the ordinary resolver strict while allowing a late wave to
// use capacity that the scheduler has explicitly released to this bundle.
export function resolveAdaptiveManifestWorkers({
  env = process.env,
  cpuCount = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryBytes = os.freemem(),
  totalMemoryBytes = os.totalmem(),
  load1 = os.loadavg()[0] ?? 0,
  readGrantFile,
  workload = 'cpu',
  orchestrationWorkersPerCpu = 2,
  orchestrationMemoryGiBPerWorker = 0.125
} = {}) {
  const runtime = { env, cpuCount, freeMemoryBytes, totalMemoryBytes, load1 }
  const baseWorkers = resolveManifestWorkers(runtime)
  const grant = readManifestSchedulerResourceGrant({ env, readFile: readGrantFile })
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
    return Math.max(baseWorkers, admittedWorkers)
  }
  if (workload !== 'orchestration') return liveWorkers

  const stepCpu = optionalPositiveNumber(env, [
    'FSUSBLOG_STEP_CPU_BUDGET',
    'FSUSBLOG_BUNDLE_CPU_UNITS',
    'FSUSBLOG_BUNDLE_CPU_BUDGET'
  ]) ?? 1
  const stepMemoryGiB = optionalPositiveNumber(env, [
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
  return Math.max(baseWorkers, liveWorkers, orchestrationWorkers)
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

export async function executeManifestEntry(entry, { cwd, env }) {
  const command = commandArguments(entry)
  console.log(`[command-manifest] start id=${entry.id} access=${entry.access}`)
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...env, ...(entry.environment ?? {}) },
      stdio: 'inherit'
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

export async function runWeightedCommandManifest(manifest, {
  cwd = process.cwd(),
  env = process.env,
  workload = 'orchestration',
  orchestrationWorkersPerCpu = 2,
  orchestrationMemoryGiBPerWorker = 0.125,
  resolveWorkers = () => resolveAdaptiveManifestWorkers({
    env,
    workload,
    orchestrationWorkersPerCpu,
    orchestrationMemoryGiBPerWorker
  }),
  execute = executeManifestEntry
} = {}) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const pending = planWeightedManifestEntries(manifest.commands)
  const failures = []
  const active = new Map()
  let activeWeight = 0
  let sequence = 0
  const start = (entry, workers) => {
    const index = sequence++
    const concurrencyWeight = Math.min(workers, positiveInteger(entry.concurrencyWeight) ?? 1)
    const childEnv = resolveManifestChildEnvironment({
      env,
      workers,
      concurrent: true,
      concurrencyWeight
    })
    activeWeight += concurrencyWeight
    const promise = execute(entry, { cwd, env: childEnv })
      .catch((reason) => failures.push({ index, error: new Error(`${entry.id}: ${reason.message}`) }))
      .finally(() => {
        activeWeight -= concurrencyWeight
        active.delete(index)
      })
    active.set(index, { promise, concurrencyWeight })
  }

  while (pending.length > 0 || active.size > 0) {
    const workers = Math.max(1, positiveInteger(await resolveWorkers()) ?? 1)
    while (pending.length > 0 && activeWeight < workers) {
      const availableWeight = workers - activeWeight
      const nextIndex = pending.findIndex((entry) => Math.min(
        workers,
        positiveInteger(entry.concurrencyWeight) ?? 1
      ) <= availableWeight)
      if (nextIndex < 0) break
      const [entry] = pending.splice(nextIndex, 1)
      start(entry, workers)
    }
    if (active.size > 0) await Promise.race([...active.values()].map(item => item.promise))
  }
  failures.sort((left, right) => left.index - right.index)
  if (failures.length > 0) {
    throw new AggregateError(failures.map(item => item.error), [
      `${failures.length} weighted command manifest entries failed:`,
      ...failures.map(item => `- ${item.error.message}`)
    ].join('\n'))
  }
}

async function runReadOnly(commands, options, workers) {
  const failures = []
  let nextIndex = 0
  const active = new Map()
  const start = (command, index) => {
    const promise = executeManifestEntry(command, options)
      .catch((reason) => failures.push({ index, error: new Error(`${command.id}: ${reason.message}`) }))
      .finally(() => active.delete(index))
    active.set(index, promise)
  }
  while (nextIndex < commands.length || active.size > 0) {
    while (nextIndex < commands.length && active.size < workers) {
      start(commands[nextIndex], nextIndex)
      nextIndex += 1
    }
    if (active.size > 0) await Promise.race(active.values())
  }
  failures.sort((left, right) => left.index - right.index)
  return failures.map((failure) => failure.error)
}

export async function runCommandManifest(manifest, { cwd = process.cwd(), env = process.env } = {}) {
  const errors = validateCommandManifest(manifest)
  if (errors.length > 0) throw new Error(errors.join('; '))

  const readOnly = manifest.commands.filter((command) => command.access === 'read')
  const writing = manifest.commands.filter((command) => command.access === 'write')
  const workers = resolveManifestWorkers({ env })
  const readEnv = resolveManifestChildEnvironment({ env, workers, concurrent: true })
  const writeEnv = resolveManifestChildEnvironment({ env, workers, concurrent: false })
  const failures = await runReadOnly(readOnly, { cwd, env: readEnv }, workers)
  for (const command of writing) {
    try {
      await executeManifestEntry(command, { cwd, env: writeEnv })
    } catch (error) {
      failures.push(new Error(`${command.id}: ${error.message}`))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, [
      `${failures.length} command manifest entries failed:`,
      ...failures.map((error) => `- ${error.message}`)
    ].join('\n'))
  }
}

async function main(argv) {
  const manifestArgument = argv[0]
  if (!manifestArgument) throw new Error('usage: run-command-manifest.mjs <manifest.json> [--cwd path]')
  const cwdIndex = argv.indexOf('--cwd')
  const cwd = cwdIndex >= 0 ? path.resolve(argv[cwdIndex + 1] ?? '') : process.cwd()
  const manifestPath = path.resolve(cwd, manifestArgument)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await runCommandManifest(manifest, { cwd, env: process.env })
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
