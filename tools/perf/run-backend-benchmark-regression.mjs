#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`)
  return parsed
}

export function discoverHotPathBenchmarkClasses(programSource) {
  const classes = [...String(programSource).matchAll(/typeof\(\s*([A-Za-z_][A-Za-z0-9_]*HotPath[A-Za-z0-9_]*)\s*\)/gu)]
    .map((match) => match[1])
  return [...new Set(classes)].sort()
}

export function parseCpuList(value) {
  const cpus = []
  for (const part of String(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/u)
    if (!match) throw new Error(`invalid CPU list segment: ${part}`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (end < start) throw new Error(`invalid CPU list range: ${part}`)
    for (let cpu = start; cpu <= end; cpu += 1) cpus.push(cpu)
  }
  return [...new Set(cpus)]
}

export function resolveAllowedCpuIds({ platform = process.platform, procStatus = null, availableCpu } = {}) {
  if (platform === 'linux') {
    const status = procStatus ?? fs.readFileSync('/proc/self/status', 'utf8')
    const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/mu)?.[1]
    const parsed = parseCpuList(allowed)
    if (parsed.length > 0) return parsed
  }
  const count = Math.max(1, Math.floor(positiveNumber(
    availableCpu,
    os.availableParallelism?.() ?? os.cpus().length,
    'available CPU'
  )))
  return Array.from({ length: count }, (_, index) => index)
}

function classBody(source, benchmarkClass) {
  const declaration = new RegExp(`\\bclass\\s+${benchmarkClass}\\b`, 'u').exec(source)
  if (!declaration) return null
  const opening = source.indexOf('{', declaration.index)
  if (opening < 0) return null
  let depth = 0
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(opening + 1, index)
    }
  }
  return null
}

function parameterValueCount(raw) {
  let count = 1
  let inString = false
  let escaped = false
  for (const character of raw) {
    if (escaped) escaped = false
    else if (character === '\\') escaped = true
    else if (character === '"') inString = !inString
    else if (character === ',' && !inString) count += 1
  }
  return count
}

export function validateHotPathBenchmarkContract(programSource, benchmarkSources) {
  if (!String(programSource).includes('Job.ShortRun')) {
    throw new Error('HotPath benchmark runner must retain Job.ShortRun')
  }
  if (!String(programSource).includes('InProcessNoEmitToolchain.Instance')) {
    throw new Error('HotPath benchmark runner must use the in-process no-emit toolchain')
  }
  const classes = discoverHotPathBenchmarkClasses(programSource)
  const sources = benchmarkSources.map(String)
  let methodCount = 0
  let caseCount = 0
  for (const benchmarkClass of classes) {
    const source = sources.find((candidate) => classBody(candidate, benchmarkClass) !== null)
    if (!source) throw new Error(`missing source for ${benchmarkClass}`)
    if (!new RegExp(`\\[MemoryDiagnoser\\]\\s*public(?:\\s+partial)?\\s+class\\s+${benchmarkClass}\\b`, 'u').test(source)) {
      throw new Error(`${benchmarkClass} must retain MemoryDiagnoser`)
    }
    const body = classBody(source, benchmarkClass)
    const methods = [...body.matchAll(/\[Benchmark(?:\([^\]]*\))?\]/gu)].length
    const parameterSets = [...body.matchAll(/\[Params\(([^\]]+)\)\]/gu)]
      .reduce((total, match) => total * parameterValueCount(match[1]), 1)
    methodCount += methods
    caseCount += methods * parameterSets
  }
  return { classes, methodCount, caseCount, job: 'ShortRun', memoryDiagnoserClassCount: classes.length }
}

export function resolveBenchmarkParallelism({
  env = process.env,
  availableCpu = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryGiB = os.freemem() / (1024 ** 3),
  totalMemoryGiB = os.totalmem() / (1024 ** 3),
  allowedCpuIds = resolveAllowedCpuIds({ availableCpu }),
  classCount
} = {}) {
  const hostCpu = Math.max(1, Math.min(
    allowedCpuIds.length,
    Math.floor(positiveNumber(availableCpu, allowedCpuIds.length, 'available CPU'))
  ))
  const detectedFreeMemoryGiB = positiveNumber(freeMemoryGiB, null, 'free memory')
  const detectedTotalMemoryGiB = positiveNumber(totalMemoryGiB, null, 'total memory')
  const stepCpuGrant = positiveNumber(env.FSUSBLOG_STEP_CPU_BUDGET, null, 'benchmark STEP CPU grant')
  const stepMemoryGrantGiB = positiveNumber(env.FSUSBLOG_STEP_MEMORY_GIB, null, 'benchmark STEP memory grant')
  const schedulerManaged = stepCpuGrant !== null && stepMemoryGrantGiB !== null
  const inheritedCpu = stepCpuGrant ?? env.FSUSBLOG_BUNDLE_CPU_BUDGET
  const inheritedMemory = stepMemoryGrantGiB ?? env.FSUSBLOG_BUNDLE_MEMORY_GIB
  const cpuBudget = Math.min(hostCpu, positiveNumber(inheritedCpu, hostCpu, 'benchmark CPU grant'))
  const memoryBudgetGiB = schedulerManaged
    ? stepMemoryGrantGiB
    : Math.min(
        detectedFreeMemoryGiB,
        positiveNumber(inheritedMemory, detectedFreeMemoryGiB, 'benchmark memory grant')
      )
  const memoryGiBPerCpu = detectedTotalMemoryGiB / hostCpu
  const cpuWorkerLimit = Math.max(1, Math.floor(cpuBudget))
  const memoryWorkerLimit = schedulerManaged
    ? cpuWorkerLimit
    : Math.max(1, Math.floor(memoryBudgetGiB / memoryGiBPerCpu))
  const benchmarkClassCount = Math.max(1, Math.floor(positiveNumber(classCount, 1, 'benchmark class count')))
  const workerCount = Math.min(benchmarkClassCount, cpuWorkerLimit, memoryWorkerLimit)
  const grantedCpuIds = allowedCpuIds.slice(0, cpuWorkerLimit)
  const workerCpuSets = Array.from({ length: workerCount }, () => [])
  grantedCpuIds.forEach((cpu, index) => workerCpuSets[index % workerCount].push(cpu))
  return {
    hostCpu,
    detectedFreeMemoryGiB,
    detectedTotalMemoryGiB,
    schedulerManaged,
    cpuBudget,
    memoryBudgetGiB,
    memoryGiBPerCpu,
    cpuWorkerLimit,
    memoryWorkerLimit,
    classCount: benchmarkClassCount,
    workerCount,
    workerCpuSets,
    affinityMode: process.platform === 'linux' ? 'linux-taskset' : 'os-scheduler',
    derivation: schedulerManaged
      ? 'min(classCount,floor(stepCpuGrant)); step memory trusted after scheduler admission'
      : 'min(classCount,floor(cpuBudget),floor(liveMemoryBudget/(totalMemory/hostCpu)))'
  }
}

export function resolveBenchmarkWorkerEnvironment(capacity, workerIndex, env = process.env) {
  const cpuSet = capacity?.workerCpuSets?.[workerIndex]
  if (!Array.isArray(cpuSet) || cpuSet.length === 0) {
    throw new Error(`benchmark worker ${workerIndex} has no assigned CPU`)
  }
  const assignedCpuUnits = capacity.workerCpuSets.reduce((total, workerCpuSet) => total + workerCpuSet.length, 0)
  const memoryGiB = positiveNumber(capacity.memoryBudgetGiB, null, 'benchmark memory budget')
    * cpuSet.length / assignedCpuUnits
  return {
    ...env,
    FSUSBLOG_STEP_CPU_BUDGET: String(cpuSet.length),
    FSUSBLOG_STEP_MEMORY_GIB: String(memoryGiB),
    FSUSBLOG_BUNDLE_CPU_UNITS: String(cpuSet.length),
    FSUSBLOG_BUNDLE_CPU_BUDGET: String(cpuSet.length),
    FSUSBLOG_BUNDLE_MEMORY_GIB: String(memoryGiB),
    DOTNET_PROCESSOR_COUNT: String(cpuSet.length),
    FSUSBLOG_BENCHMARK_IN_PROCESS_NO_EMIT: '1'
  }
}

export async function runBenchmarkClassQueue(classes, workerCount, executeClass) {
  if (!Array.isArray(classes) || classes.length === 0) throw new Error('benchmark class queue is empty')
  if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('benchmark worker count must be positive')
  if (typeof executeClass !== 'function') throw new Error('benchmark class executor is required')
  const results = new Array(classes.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(workerCount, classes.length) }, async (_, workerIndex) => {
    while (nextIndex < classes.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'success', value: await executeClass(classes[index], index, workerIndex) }
      } catch (error) {
        results[index] = { status: 'failure', error }
      }
    }
  })
  await Promise.all(workers)
  return results
}

export function readAdaptiveBenchmarkResourceGrant({
  env = process.env,
  readFile = (file) => fs.readFileSync(file, 'utf8')
} = {}) {
  const grantFile = String(env.FSUSBLOG_MIXED_WINDOW_RESOURCE_FILE ?? '').trim()
  const runId = String(env.FSUSBLOG_MIXED_WINDOW_RESOURCE_RUN_ID ?? '').trim()
  if (!grantFile && !runId) return null
  if (!grantFile || !runId) throw new Error('adaptive benchmark resource grant requires both file and run id')
  let document
  try {
    document = JSON.parse(readFile(path.resolve(grantFile)))
  } catch (error) {
    throw new Error(`adaptive benchmark resource grant is unreadable: ${grantFile}`, { cause: error })
  }
  if (document?.schema !== 'fsusblog.mixed-performance-resources.v1') {
    throw new Error('adaptive benchmark resource grant has an invalid schema')
  }
  if (document.runId !== runId) {
    throw new Error(`adaptive benchmark resource grant runId mismatch: expected ${runId}, received ${document.runId ?? '<missing>'}`)
  }
  const allocation = document.allocations?.benchmark
  const cpuUnits = Number(allocation?.cpuUnits)
  const memoryGiB = Number(allocation?.memoryGiB)
  const totalCpuUnits = Number(document.total?.cpuUnits)
  const totalMemoryGiB = Number(document.total?.memoryGiB)
  const allAllocations = Object.values(document.allocations ?? {})
  const allocationsValid = allAllocations.every((entry) => (
    Number.isInteger(Number(entry?.cpuUnits)) && Number(entry.cpuUnits) >= 0
    && Number.isFinite(Number(entry?.memoryGiB)) && Number(entry.memoryGiB) >= 0
  ))
  const allocatedCpuUnits = allAllocations
    .reduce((total, entry) => total + Number(entry?.cpuUnits ?? 0), 0)
  const allocatedMemoryGiB = allAllocations
    .reduce((total, entry) => total + Number(entry?.memoryGiB ?? 0), 0)
  const generation = Number(document.generation)
  if (!Number.isInteger(cpuUnits) || cpuUnits < 1
    || !Number.isFinite(memoryGiB) || memoryGiB <= 0
    || !Number.isInteger(totalCpuUnits) || totalCpuUnits < cpuUnits
    || !Number.isFinite(totalMemoryGiB) || totalMemoryGiB < memoryGiB
    || !allocationsValid
    || !Number.isInteger(generation) || generation < 0
    || allocatedCpuUnits > totalCpuUnits
    || allocatedMemoryGiB > totalMemoryGiB + Number.EPSILON * 64) {
    throw new Error('adaptive benchmark resource grant exceeds the mixed-window budget')
  }
  return { cpuUnits, memoryGiB, generation }
}

export async function runAdaptiveBenchmarkClassQueue({
  classes,
  initialCapacity,
  resolveCapacity,
  executeClass
}) {
  if (!Array.isArray(classes) || classes.length === 0) throw new Error('benchmark class queue is empty')
  if (!initialCapacity || !Number.isInteger(initialCapacity.workerCount) || initialCapacity.workerCount < 1) {
    throw new Error('initial benchmark capacity must contain a positive worker count')
  }
  if (typeof resolveCapacity !== 'function' || typeof executeClass !== 'function') {
    throw new Error('adaptive benchmark capacity resolver and class executor are required')
  }
  const results = new Array(classes.length)
  const active = new Map()
  let capacity = initialCapacity
  let nextIndex = 0
  let peakWorkerCount = 0

  const launchAvailable = () => {
    for (let workerIndex = 0; workerIndex < capacity.workerCount && nextIndex < classes.length; workerIndex += 1) {
      if (active.has(workerIndex)) continue
      const index = nextIndex
      nextIndex += 1
      const promise = Promise.resolve()
        .then(() => executeClass(classes[index], index, workerIndex, capacity))
        .then(
          (value) => ({ workerIndex, index, status: 'success', value }),
          (error) => ({ workerIndex, index, status: 'failure', error })
        )
      active.set(workerIndex, promise)
    }
    peakWorkerCount = Math.max(peakWorkerCount, active.size)
  }

  launchAvailable()
  while (active.size > 0) {
    const settled = await Promise.race(active.values())
    active.delete(settled.workerIndex)
    results[settled.index] = settled.status === 'success'
      ? { status: 'success', value: settled.value }
      : { status: 'failure', error: settled.error }
    const resolved = await resolveCapacity(capacity)
    if (!resolved || !Number.isInteger(resolved.workerCount) || resolved.workerCount < capacity.workerCount) {
      throw new Error('adaptive benchmark capacity must be monotonic and retain active workers')
    }
    capacity = resolved
    launchAvailable()
  }
  return { results, capacity, peakWorkerCount }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }))
  })
}

function safeSegment(value) {
  return String(value).replaceAll(/[^A-Za-z0-9_.-]/gu, '_')
}

export function collectShardReports(shards, aggregateDirectory) {
  fs.rmSync(aggregateDirectory, { recursive: true, force: true })
  fs.mkdirSync(aggregateDirectory, { recursive: true })
  const copied = []
  if (shards.length === 0) throw new Error('no successful benchmark class shards were available to aggregate')
  for (const shard of shards) {
    const resultDirectory = path.join(shard.artifactDirectory, 'results')
    const reports = fs.existsSync(resultDirectory)
      ? fs.readdirSync(resultDirectory).filter((file) => file.endsWith('.json')).sort()
      : []
    if (reports.length === 0) throw new Error(`${shard.benchmarkClass} produced no BenchmarkDotNet JSON report`)
    for (const report of reports) {
      const destination = path.join(
        aggregateDirectory,
        `${safeSegment(shard.benchmarkClass)}--${safeSegment(report)}`
      )
      fs.copyFileSync(path.join(resultDirectory, report), destination)
      copied.push(destination)
    }
  }
  if (copied.length === 0) throw new Error('benchmark class shards produced no JSON reports')
  return copied
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = value
  }
  return options
}

function globPattern(value) {
  const escaped = String(value).replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*')
  return new RegExp(`^${escaped}$`, 'u')
}

export async function runBackendBenchmarkRegression({
  project = path.join(root, 'benchmarks/core/FsusBlog.Core.Benchmarks.csproj'),
  program = path.join(root, 'benchmarks/core/Program.cs'),
  artifactRoot = path.join(root, 'BenchmarkDotNet.Artifacts'),
  aggregateReports = path.join(root, 'BenchmarkDotNet.Artifacts/results'),
  budgets = path.join(root, 'tests/performance/backend-hotpath-budgets.json'),
  output = path.join(root, 'BenchmarkDotNet.Artifacts/results/fsusblog-benchmark-regression.json'),
  releaseSummary = path.join(root, '.tmp/perf/release-summaries/backend-benchmark-regression.json'),
  checker = path.join(root, 'tools/perf/check-backend-benchmark-regression.mjs'),
  buildWrapper = path.join(root, 'tools/build-with-data-env.sh'),
  node = process.env.FSUSBLOG_NODE || process.execPath,
  env = process.env
} = {}) {
  const discovered = discoverHotPathBenchmarkClasses(fs.readFileSync(program, 'utf8'))
  const benchmarkSources = fs.readdirSync(path.dirname(program))
    .filter((file) => file.endsWith('.cs'))
    .map((file) => fs.readFileSync(path.join(path.dirname(program), file), 'utf8'))
  const contract = validateHotPathBenchmarkContract(fs.readFileSync(program, 'utf8'), benchmarkSources)
  const requestedFilter = env.FSUSBLOG_BENCHMARK_FILTER || '*HotPath*'
  const filter = globPattern(requestedFilter)
  const classes = discovered.filter((benchmarkClass) => filter.test(benchmarkClass))
  if (classes.length === 0) throw new Error(`benchmark filter ${requestedFilter} matched no HotPath benchmark classes`)
  const capacity = resolveBenchmarkParallelism({ env, classCount: classes.length })
  const shardRoot = path.join(artifactRoot, 'backend-benchmark-shards')
  fs.rmSync(shardRoot, { recursive: true, force: true })
  fs.mkdirSync(shardRoot, { recursive: true })
  console.log(
    `[backend-benchmark-regression] classes=${classes.length} workers=${capacity.workerCount}`
    + ` cpu=${capacity.cpuBudget.toFixed(2)} memoryGiB=${capacity.memoryBudgetGiB.toFixed(2)}`
  )
  let adaptiveCapacity = capacity
  let observedGrantGeneration = -1
  const adaptive = await runAdaptiveBenchmarkClassQueue({
    classes,
    initialCapacity: capacity,
    resolveCapacity: async (current) => {
      const grant = readAdaptiveBenchmarkResourceGrant({ env })
      if (!grant || grant.generation === observedGrantGeneration) return current
      observedGrantGeneration = grant.generation
      const candidate = resolveBenchmarkParallelism({
        env: {
          ...env,
          FSUSBLOG_STEP_CPU_BUDGET: String(grant.cpuUnits),
          FSUSBLOG_STEP_MEMORY_GIB: String(grant.memoryGiB)
        },
        classCount: classes.length
      })
      if (candidate.workerCount < current.workerCount) {
        throw new Error(`adaptive benchmark grant shrank workers from ${current.workerCount} to ${candidate.workerCount}`)
      }
      if (candidate.workerCount > current.workerCount) {
        console.log(
          `[backend-benchmark-regression] capacity workers=${current.workerCount}->${candidate.workerCount}`
          + ` generation=${grant.generation}`
        )
      }
      adaptiveCapacity = candidate
      return candidate
    },
    executeClass: async (benchmarkClass, _index, workerIndex, activeCapacity) => {
      const artifactDirectory = path.join(shardRoot, safeSegment(benchmarkClass))
      fs.mkdirSync(artifactDirectory, { recursive: true })
      const command = activeCapacity.affinityMode === 'linux-taskset' ? 'taskset' : buildWrapper
      const workerCpuSet = activeCapacity.workerCpuSets[workerIndex]
      const commandPrefix = activeCapacity.affinityMode === 'linux-taskset'
        ? ['-c', workerCpuSet.join(','), buildWrapper]
        : []
      const result = await runProcess(command, [...commandPrefix,
        'dotnet', 'run', '--project', project, '-c', 'Release', '--no-build', '--no-restore', '--',
        '--filter', `*${benchmarkClass}*`, '--artifacts', artifactDirectory, '--exporters', 'json'
      ], {
        env: resolveBenchmarkWorkerEnvironment(activeCapacity, workerIndex, env)
      })
      if (result.code !== 0 || result.signal) {
        throw new Error(`${benchmarkClass} failed (${result.signal ?? `exit ${result.code}`})`)
      }
      return { benchmarkClass, artifactDirectory }
    }
  })
  const executions = adaptive.results
  const failedExecutions = executions.filter((execution) => execution.status === 'failure')
  const successfulShards = executions.filter((execution) => execution.status === 'success').map((execution) => execution.value)
  let collectionError = null
  try {
    const reports = collectShardReports(successfulShards, aggregateReports)
    const measurementCount = reports.reduce((total, report) => {
      const payload = JSON.parse(fs.readFileSync(report, 'utf8'))
      const entries = payload.Benchmarks ?? payload.benchmarks ?? payload.Results ?? []
      return total + (Array.isArray(entries) ? entries.length : 0)
    }, 0)
    if (classes.length === contract.classes.length && measurementCount !== contract.caseCount) {
      throw new Error(`HotPath benchmark report count ${measurementCount} does not match declared case count ${contract.caseCount}`)
    }
  } catch (error) {
    collectionError = error
  }
  fs.mkdirSync(path.dirname(releaseSummary), { recursive: true })
  const checkerResult = await runProcess(node, [
    checker,
    '--reports', aggregateReports,
    '--budgets', budgets,
    '--output', output,
    '--release-summary', releaseSummary
  ], { env })
  if (failedExecutions.length > 0 || collectionError || checkerResult.code !== 0 || checkerResult.signal) {
    const causes = [
      ...failedExecutions.map((execution) => execution.error?.message ?? String(execution.error)),
      ...(collectionError ? [collectionError.message] : []),
      ...(checkerResult.code !== 0 || checkerResult.signal
        ? [`benchmark checker failed (${checkerResult.signal ?? `exit ${checkerResult.code}`})`]
        : [])
    ]
    throw new AggregateError(causes.map((cause) => new Error(cause)), causes.join('; '))
  }
  return {
    classes,
    capacity: adaptiveCapacity,
    initialCapacity: capacity,
    peakWorkerCount: adaptive.peakWorkerCount,
    contract,
    reports: fs.readdirSync(aggregateReports).filter((file) => file.endsWith('.json')).sort()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runBackendBenchmarkRegression(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[backend-benchmark-regression] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
