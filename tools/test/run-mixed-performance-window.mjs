#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  validateHotPathBenchmarkContract
} from '../perf/run-backend-benchmark-regression.mjs'
import { resolveManifestChildEnvironment } from './run-command-manifest.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const performanceOutputRoot = path.resolve(
  process.env.FSUSBLOG_PERFORMANCE_OUTPUT_ROOT ?? path.join(root, '.tmp/perf'))
const qpsModes = Object.freeze([
  'view-count-flush', 'visitlog-invalidation', 'cache-hit', 'comment-cursor', 'hotread',
  'cache-miss-singleflight', 'risk-filter', 'related-reading', 'list-pagination',
  'article-detail-miss', 'cache-registry', 'cache-invalidation-batch', 'index-plan'
])
const resumableCohortNames = Object.freeze(['benchmark', 'publicApi', 'qps'])

export function buildMixedWindowPlan() {
  return {
    durationMs: 60_000,
    cohorts: {
      baseline: { minimumDurationMs: 30_000, command: 'tools/test/lanes/load-profile.sh baseline', cpuWeight: 1, memoryWeight: 1 },
      peak: { minimumDurationMs: 60_000, command: 'tools/test/lanes/load-profile.sh expected-peak', cpuWeight: 1, memoryWeight: 1 },
      burst: { minimumDurationMs: 15_000, command: 'tools/test/lanes/load-profile.sh burst', cpuWeight: 1, memoryWeight: 1 },
      notification: {
        minimumDurationMs: 30_000,
        command: 'npm run check:load:notification-stream-pressure',
        cpuWeight: 1,
        memoryWeight: 1
      },
      qps: {
        modes: [...qpsModes],
        publicApiCommand: 'npm run check:load:public-api',
        cpuWeight: 1,
        memoryWeight: 1
      },
      benchmark: {
        command: 'tools/test/lanes/backend-benchmark-regression.sh',
        cpuWeight: 8,
        memoryWeight: 16
      }
    }
  }
}

function positiveNumber(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`)
  return parsed
}

function weightedIntegerCpu(entries, totalCpu) {
  if (totalCpu < entries.length) {
    const weightTotal = entries.reduce((total, entry) => total + entry.cpuWeight, 0)
    return entries.map((entry) => totalCpu * entry.cpuWeight / weightTotal)
  }
  const allocation = entries.map(() => 1)
  const remaining = totalCpu - entries.length
  const weightTotal = entries.reduce((total, entry) => total + entry.cpuWeight, 0)
  const exact = entries.map((entry) => remaining * entry.cpuWeight / weightTotal)
  exact.forEach((value, index) => { allocation[index] += Math.floor(value) })
  let leftover = totalCpu - allocation.reduce((total, value) => total + value, 0)
  const order = exact.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (let index = 0; index < leftover; index += 1) allocation[order[index].index] += 1
  return allocation
}

export function resolveMixedWindowResources({
  plan = buildMixedWindowPlan(),
  env = process.env,
  availableCpu = os.availableParallelism?.() ?? os.cpus().length,
  freeMemoryGiB = os.freemem() / (1024 ** 3)
} = {}) {
  const hostCpu = Math.max(1, Math.floor(positiveNumber(availableCpu, 1, 'mixed-window available CPU')))
  const detectedMemoryGiB = positiveNumber(freeMemoryGiB, null, 'mixed-window free memory')
  const cpuGrant = Math.min(hostCpu, positiveNumber(
    env.FSUSBLOG_STEP_CPU_BUDGET ?? env.FSUSBLOG_BUNDLE_CPU_BUDGET,
    hostCpu,
    'mixed-window CPU grant'
  ))
  const memoryGrantGiB = Math.min(detectedMemoryGiB, positiveNumber(
    env.FSUSBLOG_STEP_MEMORY_GIB ?? env.FSUSBLOG_BUNDLE_MEMORY_GIB,
    detectedMemoryGiB,
    'mixed-window memory grant'
  ))
  const entries = Object.entries(plan.cohorts).map(([name, declaration]) => ({ name, ...declaration }))
  const cpuAllocation = weightedIntegerCpu(entries, Math.max(1, Math.floor(cpuGrant)))
  const memoryWeightTotal = entries.reduce((total, entry) => total + entry.memoryWeight, 0)
  const cohorts = Object.fromEntries(entries.map((entry, index) => [entry.name, {
    cpuUnits: cpuAllocation[index],
    memoryGiB: memoryGrantGiB * entry.memoryWeight / memoryWeightTotal,
    cpuWeight: entry.cpuWeight,
    memoryWeight: entry.memoryWeight
  }]))
  return {
    total: { cpuUnits: Math.max(1, Math.floor(cpuGrant)), memoryGiB: memoryGrantGiB },
    cohorts,
    allocated: {
      cpuUnits: Object.values(cohorts).reduce((total, cohort) => total + cohort.cpuUnits, 0),
      memoryGiB: Object.values(cohorts).reduce((total, cohort) => total + cohort.memoryGiB, 0)
    }
  }
}

function cohortEnvironment(resource) {
  return {
    FSUSBLOG_STEP_CPU_BUDGET: String(resource.cpuUnits),
    FSUSBLOG_STEP_MEMORY_GIB: String(resource.memoryGiB)
  }
}

function writeAtomicJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.pending-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`)
  fs.renameSync(temporary, file)
}

export function createMixedWindowResourceCoordinator({
  resources,
  runId,
  file,
  writeSnapshot = writeAtomicJson
}) {
  if (!resources?.total || !resources?.cohorts || !String(runId ?? '').trim()) {
    throw new Error('mixed-window resource coordinator requires resources and run id')
  }
  const allocations = Object.fromEntries(Object.entries(resources.cohorts).map(([name, resource]) => [name, {
    cpuUnits: Number(resource.cpuUnits),
    memoryGiB: Number(resource.memoryGiB)
  }]))
  const completed = new Set()
  const timeline = []
  let generation = 0

  const snapshot = () => ({
    schema: 'fsusblog.mixed-performance-resources.v1',
    runId,
    generation,
    total: { ...resources.total },
    allocations: Object.fromEntries(Object.entries(allocations).map(([name, resource]) => [name, { ...resource }])),
    completed: [...completed].sort(),
    generatedAt: new Date().toISOString()
  })
  const publish = (event) => {
    const document = snapshot()
    const allocatedCpu = Object.values(document.allocations).reduce((total, item) => total + item.cpuUnits, 0)
    const allocatedMemory = Object.values(document.allocations).reduce((total, item) => total + item.memoryGiB, 0)
    if (allocatedCpu > document.total.cpuUnits
      || allocatedMemory > document.total.memoryGiB + Number.EPSILON * 64) {
      throw new Error('mixed-window resource transfer exceeds the admitted total grant')
    }
    timeline.push({ event, generation, allocations: document.allocations, generatedAt: document.generatedAt })
    if (file) writeSnapshot(file, document)
    return document
  }
  const activeTail = (source) => {
    if ('benchmark' in allocations && source !== 'benchmark' && !completed.has('benchmark')) return 'benchmark'
    return null
  }
  const complete = (name) => {
    if (!(name in allocations)) throw new Error(`unknown mixed-window allocation: ${name}`)
    if (completed.has(name)) throw new Error(`mixed-window allocation completed twice: ${name}`)
    completed.add(name)
    const source = allocations[name]
    const targetName = activeTail(name)
    if (targetName) {
      allocations[targetName].cpuUnits += source.cpuUnits
      allocations[targetName].memoryGiB += source.memoryGiB
      source.cpuUnits = 0
      source.memoryGiB = 0
    }
    generation += 1
    return publish({ type: 'complete', source: name, target: targetName })
  }
  const track = (name, promise) => Promise.resolve(promise).finally(() => complete(name))
  publish({ type: 'initial' })
  return {
    complete,
    track,
    resource(name) {
      const resource = allocations[name]
      return resource ? { ...resource } : null
    },
    snapshot,
    timeline: () => structuredClone(timeline)
  }
}

function sha256(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
}

function readBenchmarkContract() {
  const benchmarkRoot = path.join(root, 'benchmarks/core')
  const program = fs.readFileSync(path.join(benchmarkRoot, 'Program.cs'), 'utf8')
  const sources = fs.readdirSync(benchmarkRoot)
    .filter((file) => file.endsWith('.cs'))
    .map((file) => fs.readFileSync(path.join(benchmarkRoot, file), 'utf8'))
  return validateHotPathBenchmarkContract(program, sources)
}

export function collectBenchmarkEvidence({
  startedAtMs,
  aggregateReports = path.join(
    process.env.FSUSBLOG_BENCHMARK_ARTIFACT_ROOT ?? path.join(root, 'BenchmarkDotNet.Artifacts'),
    'results'),
  checkerFile = path.join(aggregateReports, 'fsusblog-benchmark-regression.json'),
  releaseSummaryFile = path.join(
    process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT
      ? path.join(process.env.FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT, 'reports')
      : performanceOutputRoot,
    'release-summaries/backend-benchmark-regression.json'),
  contract = readBenchmarkContract()
}) {
  const reportFiles = fs.readdirSync(aggregateReports)
    .filter((file) => file.includes('--') && file.endsWith('.json'))
    .map((file) => path.join(aggregateReports, file))
    .sort()
  const reports = reportFiles.map((file) => {
    const stat = fs.statSync(file)
    if (stat.mtimeMs < startedAtMs) throw new Error(`stale benchmark report: ${path.relative(root, file)}`)
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    const entries = payload.Benchmarks ?? payload.benchmarks ?? payload.Results ?? []
    const benchmarkClasses = [...new Set(entries.map((entry) => (
      String(entry.Type ?? entry.BenchmarkType ?? entry.Class ?? '').split('.').at(-1)
    )).filter(Boolean))]
    return {
      path: path.relative(root, file).replaceAll(path.sep, '/'),
      digest: sha256(file),
      generatedAtMs: stat.mtimeMs,
      measurementCount: entries.length,
      benchmarkClasses
    }
  })
  const measuredClasses = [...new Set(reports.flatMap((report) => report.benchmarkClasses))].sort()
  const measurementCount = reports.reduce((total, report) => total + report.measurementCount, 0)
  if (reportFiles.length !== contract.classes.length) {
    throw new Error(`benchmark evidence expected ${contract.classes.length} shard reports, received ${reportFiles.length}`)
  }
  if (JSON.stringify(measuredClasses) !== JSON.stringify([...contract.classes].sort())) {
    throw new Error('benchmark evidence class set does not match the HotPath contract')
  }
  if (measurementCount !== contract.caseCount) {
    throw new Error(`benchmark evidence expected ${contract.caseCount} measurements, received ${measurementCount}`)
  }
  const bindSummary = (file, label) => {
    if (!fs.existsSync(file)) throw new Error(`missing benchmark ${label}: ${path.relative(root, file)}`)
    const stat = fs.statSync(file)
    if (stat.mtimeMs < startedAtMs) throw new Error(`stale benchmark ${label}: ${path.relative(root, file)}`)
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    return {
      path: path.relative(root, file).replaceAll(path.sep, '/'),
      digest: sha256(file),
      generatedAtMs: stat.mtimeMs,
      status: payload.status
    }
  }
  return {
    status: 'complete',
    windowStartedAtMs: startedAtMs,
    expectedClassCount: contract.classes.length,
    expectedMeasurementCount: contract.caseCount,
    measuredClasses,
    measurementCount,
    reports,
    checker: bindSummary(checkerFile, 'checker output'),
    releaseSummary: bindSummary(releaseSummaryFile, 'release summary')
  }
}

function command(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

function measuredLoadDuration(summary, name) {
  const durationMs = Number(summary?.runtime?.durationMs)
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${name} load sample did not report a positive runtime.durationMs`)
  }
  return durationMs
}

export async function collectSampledDuration({ name, minimumDurationMs, executeSample }) {
  if (typeof executeSample !== 'function') throw new Error(`${name} sample executor is required`)
  let sampleCount = 0
  let sampledDurationMs = 0
  while (sampledDurationMs < minimumDurationMs) {
    const summary = await executeSample({
      sampleIndex: sampleCount,
      sampledDurationMs,
      remainingDurationMs: minimumDurationMs - sampledDurationMs
    })
    sampledDurationMs += measuredLoadDuration(summary, name)
    sampleCount += 1
  }
  return { sampleCount, sampledDurationMs }
}

export function resolveAdaptiveLoadRounds(summary, remainingDurationMs) {
  if (remainingDurationMs <= 0) return null
  const sampleDurationMs = measuredLoadDuration(summary, summary?.profileName ?? 'load')
  const measuredRounds = Number(summary?.effective?.rounds)
  if (!Number.isInteger(measuredRounds) || measuredRounds <= 0) {
    throw new Error('load sample did not report positive effective.rounds')
  }
  // Adjacent samples do not have identical throughput. Positive headroom
  // avoids an extra full-concurrency tail sample when the prior estimate
  // undershoots the required window by only a few hundred milliseconds.
  return Math.max(1, Math.ceil(measuredRounds * remainingDurationMs / sampleDurationMs * 1.1))
}

async function runRepeatedCohort(name, declaration, resource) {
  const cohortStartedAt = Date.now()
  const sampleRoot = path.join(performanceOutputRoot, 'mixed-window', name)
  fs.rmSync(sampleRoot, { recursive: true, force: true })
  fs.mkdirSync(sampleRoot, { recursive: true })
  let adaptiveRounds = null
  const sampling = await collectSampledDuration({
    name,
    minimumDurationMs: declaration.minimumDurationMs,
    executeSample: async ({ sampleIndex, remainingDurationMs }) => {
      const sampleEnv = cohortEnvironment(resource)
      if (adaptiveRounds !== null) sampleEnv.FSUSBLOG_LOAD_PROFILE_ROUNDS = String(adaptiveRounds)
      await command(declaration.command, { env: sampleEnv })
      const profile = name === 'peak' ? 'expected-peak' : name
      const summaryFile = path.join(performanceOutputRoot, `load-${profile}`, 'summary.json')
      if (!fs.existsSync(summaryFile)) throw new Error(`${name} did not produce ${path.relative(root, summaryFile)}`)
      const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      fs.copyFileSync(summaryFile, path.join(sampleRoot, `${String(sampleIndex + 1).padStart(4, '0')}.json`))
      adaptiveRounds = resolveAdaptiveLoadRounds(
        summary,
        remainingDurationMs - measuredLoadDuration(summary, name)
      )
      return summary
    }
  })
  return {
    name,
    status: 'ok',
    minimumDurationMs: declaration.minimumDurationMs,
    sampledDurationMs: sampling.sampledDurationMs,
    elapsedMs: Date.now() - cohortStartedAt,
    sampleCount: sampling.sampleCount
  }
}

async function runLoadWarmup(declaration, resource) {
  const startedAt = Date.now()
  await command(declaration.command, { env: cohortEnvironment(resource) })
  const summaryFile = path.join(performanceOutputRoot, 'load-baseline', 'summary.json')
  if (!fs.existsSync(summaryFile)) throw new Error('baseline warmup did not produce load evidence')
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
  if (summary.status !== 'ok') throw new Error(`baseline warmup status is ${String(summary.status)}`)
  const evidenceFile = path.join(performanceOutputRoot, 'mixed-window', 'baseline-warmup.json')
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true })
  fs.copyFileSync(summaryFile, evidenceFile)
  return {
    name: 'baseline-warmup',
    status: 'ok',
    elapsedMs: Date.now() - startedAt,
    sampledDurationMs: measuredLoadDuration(summary, 'baseline-warmup'),
    evidence: path.relative(root, evidenceFile).replaceAll(path.sep, '/')
  }
}

async function runPublicApi(commandName, env) {
  const cohortStartedAt = Date.now()
  const evidenceFile = path.join(performanceOutputRoot, 'load-public-api.json')
  await command(commandName, {
    cwd: path.join(root, 'src/frontend'),
    env: {
      ...env,
      FSUSBLOG_BASE_URL: process.env.FSUSBLOG_DEBUG_BACKEND_URL,
      FSUSBLOG_PUBLIC_BASE_URL: process.env.FSUSBLOG_RELEASE_PREVIEW_URL,
      PLAYWRIGHT_BASE_URL: process.env.FSUSBLOG_RELEASE_PREVIEW_URL
    }
  })
  if (!fs.existsSync(evidenceFile) || fs.statSync(evidenceFile).mtimeMs < cohortStartedAt) {
    throw new Error(`public API load check did not produce fresh ${path.relative(root, evidenceFile)}`)
  }
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  if (evidence.status !== 'ok') throw new Error(`public API load check status is ${String(evidence.status)}`)
  return {
    name: 'publicApi',
    status: 'ok',
    elapsedMs: Date.now() - cohortStartedAt,
    evidence: path.relative(root, evidenceFile).replaceAll(path.sep, '/')
  }
}

async function runNotification(declaration, resource) {
  const cohortStartedAt = Date.now()
  const frontend = path.join(root, 'src/frontend')
  const evidenceFile = path.join(performanceOutputRoot, 'notification-stream-pressure.json')
  await command(declaration.command, {
    cwd: frontend,
    env: {
      ...cohortEnvironment(resource),
      FSUSBLOG_NOTIFICATION_STREAM_DURATION_MS: String(declaration.minimumDurationMs),
      FSUSBLOG_BASE_URL: process.env.FSUSBLOG_DEBUG_BACKEND_URL,
      PLAYWRIGHT_BASE_URL: process.env.FSUSBLOG_DEBUG_FRONTEND_URL
    }
  })
  if (!fs.existsSync(evidenceFile) || fs.statSync(evidenceFile).mtimeMs < cohortStartedAt) {
    throw new Error(`notification did not produce fresh ${path.relative(root, evidenceFile)}`)
  }
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'))
  const sampledDurationMs = Number(evidence.durationMs)
  if (!Number.isFinite(sampledDurationMs) || sampledDurationMs < declaration.minimumDurationMs) {
    throw new Error(`notification sampled ${sampledDurationMs}ms below ${declaration.minimumDurationMs}ms`)
  }
  return {
    name: 'notification',
    status: 'ok',
    minimumDurationMs: declaration.minimumDurationMs,
    sampledDurationMs,
    elapsedMs: Date.now() - cohortStartedAt,
    sampleCount: 1
  }
}

export function resolveQpsWorkerCapacity({
  resource,
  modeCount,
  availableCpu = os.availableParallelism?.() ?? os.cpus().length,
  totalMemoryGiB = os.totalmem() / (1024 ** 3)
}) {
  const hostCpu = Math.max(1, Math.floor(positiveNumber(availableCpu, 1, 'QPS available CPU')))
  const hostMemoryGiB = positiveNumber(totalMemoryGiB, null, 'QPS total memory')
  const cpuLimit = Math.max(1, Math.floor(Math.min(hostCpu, positiveNumber(resource?.cpuUnits, 1, 'QPS CPU grant'))))
  const memoryGiBPerCpu = hostMemoryGiB / hostCpu
  const memoryLimit = Math.max(1, Math.floor(
    positiveNumber(resource?.memoryGiB, memoryGiBPerCpu, 'QPS memory grant') / memoryGiBPerCpu
  ))
  return {
    workerCount: Math.min(Math.max(1, modeCount), cpuLimit, memoryLimit),
    cpuLimit,
    memoryLimit,
    memoryGiBPerCpu
  }
}

export async function runQpsModeQueue({
  modes,
  resource,
  env = process.env,
  availableCpu,
  totalMemoryGiB,
  executeMode,
  executeAggregate
}) {
  if (!Array.isArray(modes) || modes.length === 0) throw new Error('QPS modes must be non-empty')
  if (typeof executeMode !== 'function' || typeof executeAggregate !== 'function') {
    throw new Error('QPS mode and aggregate executors are required')
  }
  const capacity = resolveQpsWorkerCapacity({ resource, modeCount: modes.length, availableCpu, totalMemoryGiB })
  const parentEnv = { ...env, ...cohortEnvironment(resource) }
  const childEnv = resolveManifestChildEnvironment({
    env: parentEnv,
    workers: capacity.workerCount,
    concurrent: true
  })
  const aggregateEnv = resolveManifestChildEnvironment({
    env: parentEnv,
    workers: capacity.workerCount,
    concurrent: false
  })
  const failures = []
  let nextIndex = 0
  const workers = Array.from({ length: capacity.workerCount }, async () => {
    while (nextIndex < modes.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        await executeMode(modes[index], childEnv)
      } catch (error) {
        failures.push({ index, error: new Error(`${modes[index]}: ${error instanceof Error ? error.message : String(error)}`) })
      }
    }
  })
  await Promise.all(workers)
  try {
    await executeAggregate(aggregateEnv)
  } catch (error) {
    failures.push({
      index: modes.length,
      error: new Error(`aggregate: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  failures.sort((left, right) => left.index - right.index)
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `QPS cohort failed in ${failures.length} independent commands: ${failures.map((failure) => failure.error.message).join('; ')}`
    )
  }
  return { capacity, childEnv, aggregateEnv }
}

async function runQps(resource, declaration) {
  const capacity = resolveQpsWorkerCapacity({ resource, modeCount: qpsModes.length })
  const publicApiPromise = runPublicApi(
    declaration.publicApiCommand,
    cohortEnvironment(resource)
  )
    .catch((error) => ({
      name: 'publicApi',
      status: 'failed',
      failures: [error instanceof Error ? error.message : String(error)]
    }))
  const qpsPromise = runQpsChecks(resource, capacity)
  return Promise.all([publicApiPromise, qpsPromise])
}

async function runQpsChecks(
  resource,
  capacity = resolveQpsWorkerCapacity({ resource, modeCount: qpsModes.length })
) {
  let failures = []
  try {
    await runQpsModeQueue({
      modes: qpsModes,
      resource,
      executeMode: async (mode, env) => {
        await command(`tools/test/lanes/backend-qps.sh ${mode}`, { env })
      },
      executeAggregate: (env) => command('tools/test/lanes/backend-qps.sh aggregate', { env })
    })
  } catch (error) {
    failures = (error instanceof AggregateError ? error.errors : [error])
      .map((cause) => cause instanceof Error ? cause.message : String(cause))
  }
  return {
    name: 'qps',
    status: failures.length > 0 ? 'failed' : 'ok',
    modes: [...qpsModes],
    sampleCount: qpsModes.length,
    workerCount: capacity.workerCount,
    failures
  }
}

export function resolveMixedWindowResumeNames(cohorts) {
  if (!Array.isArray(cohorts)) throw new Error('mixed performance resume cohorts are missing')
  const failedNames = cohorts
    .filter((cohort) => cohort?.status === 'failed')
    .map((cohort) => cohort.name)
  if (failedNames.length === 0) throw new Error('mixed performance resume has no failed cohorts')
  const unsupported = failedNames.filter((name) => !resumableCohortNames.includes(name))
  if (unsupported.length > 0) {
    throw new Error(`mixed performance resume cannot isolate cohorts: ${unsupported.join(', ')}`)
  }
  if (new Set(failedNames).size !== failedNames.length) {
    throw new Error(`mixed performance resume contains duplicate failed cohorts: ${failedNames.join(', ')}`)
  }
  return failedNames
}

export function mergeMixedWindowResumedCohorts(previousCohorts, resumedCohorts) {
  const replacements = new Map(resumedCohorts.map((cohort) => [cohort.name, cohort]))
  return previousCohorts.map((cohort) => replacements.get(cohort.name) ?? cohort)
}

export async function settleCohortExecutions(executions) {
  const settled = await Promise.allSettled(executions.map((entry) => entry.promise))
  return settled.flatMap((result, index) => {
    if (result.status === 'fulfilled') return Array.isArray(result.value) ? result.value : [result.value]
    const causes = result.reason instanceof AggregateError
      ? result.reason.errors
      : [result.reason]
    const failures = causes.map((cause) => cause instanceof Error ? cause.message : String(cause))
    return [{ name: executions[index].name, status: 'failed', failures }]
  })
}

async function runBenchmark(windowStartedAt, declaration, resource, adaptiveResource) {
  let commandFailure = null
  try {
    await command(declaration.command, {
      env: {
        ...cohortEnvironment(resource),
        ...(adaptiveResource ?? {})
      }
    })
  } catch (error) {
    commandFailure = error
  }
  let evidence = null
  let evidenceFailure = null
  try {
    evidence = collectBenchmarkEvidence({ startedAtMs: windowStartedAt })
  } catch (error) {
    evidenceFailure = error
  }
  const checkerFailure = evidence && evidence.checker.status !== 'ok'
    ? `benchmark checker status is ${String(evidence.checker.status)}`
    : null
  return {
    name: 'benchmark',
    status: commandFailure || evidenceFailure || checkerFailure ? 'failed' : 'ok',
    elapsedMs: Date.now() - windowStartedAt,
    resource,
    evidence,
    failures: [commandFailure, evidenceFailure, checkerFailure]
      .filter(Boolean)
      .map((error) => error instanceof Error ? error.message : String(error))
  }
}

async function main() {
  const plan = buildMixedWindowPlan()
  const resources = resolveMixedWindowResources({ plan })
  if (process.argv.includes('--plan')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  const startedAt = Date.now()
  process.env.FSUSBLOG_BASE_URL ||= process.env.FSUSBLOG_DEBUG_BACKEND_URL
  process.env.FSUSBLOG_PUBLIC_BASE_URL ||= process.env.FSUSBLOG_RELEASE_PREVIEW_URL
  process.env.PLAYWRIGHT_BASE_URL ||= process.env.FSUSBLOG_RELEASE_PREVIEW_URL
  const outFile = path.join(performanceOutputRoot, 'mixed-window', 'summary.json')
  if (process.argv.includes('--reuse-passed') && fs.existsSync(outFile)) {
    const previous = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    const expectedCohorts = ['baseline', 'benchmark', 'burst', 'notification', 'peak', 'publicApi', 'qps']
    const actualCohorts = previous.cohorts.map((cohort) => cohort.name).sort()
    if (previous.status === 'ok'
      && JSON.stringify(actualCohorts) === JSON.stringify(expectedCohorts)
      && previous.cohorts.every((cohort) => cohort.status === 'ok')) {
      console.log(`[mixed-performance-window] reused passed evidence elapsedMs=${previous.elapsedMs}`)
      return
    }
  }
  if (process.argv.includes('--resume-failed')) {
    if (!fs.existsSync(outFile)) throw new Error('mixed performance resume summary is missing')
    const previous = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    const failedNames = resolveMixedWindowResumeNames(previous.cohorts)
    const executions = failedNames.map((name) => {
      if (name === 'benchmark') {
        return {
          name,
          promise: runBenchmark(startedAt, plan.cohorts.benchmark, resources.total)
        }
      }
      if (name === 'publicApi') {
        return {
          name,
          promise: runPublicApi(
            plan.cohorts.qps.publicApiCommand,
            cohortEnvironment(resources.cohorts.qps)
          )
        }
      }
      return {
        name,
        promise: runQpsChecks(resources.cohorts.qps)
      }
    })
    const resumedCohorts = await settleCohortExecutions(executions)
    const cohorts = mergeMixedWindowResumedCohorts(previous.cohorts, resumedCohorts)
    const summary = {
      ...previous,
      status: cohorts.some((cohort) => cohort.status === 'failed') ? 'failed' : 'ok',
      executionSource: 'resume-failed',
      elapsedMs: Number(previous.elapsedMs) + (Date.now() - startedAt),
      cohorts,
      generatedAt: new Date().toISOString()
    }
    writeAtomicJson(outFile, summary)
    console.log(`[mixed-performance-window] resumed=${failedNames.join(',')} status=${summary.status}`)
    if (summary.status !== 'ok') throw new Error('mixed performance resumed cohort still failed')
    return
  }
  const resourceFile = path.join(performanceOutputRoot, 'mixed-window', 'resources.json')
  const resourceRunId = process.env.FSUSBLOG_TEST_RUN_ID || process.env.FSUSBLOG_TEST_NAMESPACE || `local-${startedAt}`
  const benchmarkResources = {
    total: { ...resources.total },
    cohorts: { benchmark: { ...resources.total } }
  }
  const benchmarkCoordinator = createMixedWindowResourceCoordinator({
    resources: benchmarkResources,
    runId: `${resourceRunId}-benchmark`,
    file: resourceFile
  })
  const cohorts = await settleCohortExecutions([
    {
      name: 'benchmark',
      promise: benchmarkCoordinator.track('benchmark', runBenchmark(startedAt, plan.cohorts.benchmark, resources.total, {
        FSUSBLOG_MIXED_WINDOW_RESOURCE_FILE: resourceFile,
        FSUSBLOG_MIXED_WINDOW_RESOURCE_RUN_ID: `${resourceRunId}-benchmark`
      }))
    }
  ])
  const warmup = await runLoadWarmup(plan.cohorts.baseline, resources.cohorts.baseline)
  const loadTimeline = []
  const runExclusiveLoad = async (name, resourceName, execute) => {
    const allocation = resources.cohorts[resourceName]
    const coordinator = createMixedWindowResourceCoordinator({
      resources: { total: { ...resources.total }, cohorts: { [name]: { ...allocation } } },
      runId: `${resourceRunId}-${name}`,
      file: resourceFile
    })
    const result = await settleCohortExecutions([{
      name,
      promise: coordinator.track(name, execute(allocation))
    }])
    loadTimeline.push(...coordinator.timeline().map((entry) => ({ ...entry, phase: name })))
    return result
  }
  cohorts.push(...await runExclusiveLoad('burst', 'burst', (resource) => (
    runRepeatedCohort('burst', plan.cohorts.burst, resource)
  )))
  const pairedResources = {
    total: { ...resources.total },
    cohorts: {
      notification: { ...resources.cohorts.notification },
      baseline: { ...resources.cohorts.baseline }
    }
  }
  const pairedCoordinator = createMixedWindowResourceCoordinator({
    resources: pairedResources,
    runId: `${resourceRunId}-notification-baseline`,
    file: resourceFile
  })
  cohorts.push(...await settleCohortExecutions([
    {
      name: 'notification',
      promise: pairedCoordinator.track('notification', runNotification(
        plan.cohorts.notification,
        pairedResources.cohorts.notification
      ))
    },
    {
      name: 'baseline',
      promise: pairedCoordinator.track('baseline', runRepeatedCohort(
        'baseline',
        plan.cohorts.baseline,
        pairedResources.cohorts.baseline
      ))
    }
  ]))
  loadTimeline.push(...pairedCoordinator.timeline().map((entry) => ({
    ...entry,
    phase: 'notification-baseline'
  })))
  cohorts.push(...await runExclusiveLoad('peak', 'peak', (resource) => (
    runRepeatedCohort('peak', plan.cohorts.peak, resource)
  )))
  cohorts.push(...await runExclusiveLoad('qps-shared', 'qps', (resource) => (
    runQps(resource, plan.cohorts.qps)
  )))
  const elapsedMs = Date.now() - startedAt
  for (const cohort of cohorts.filter((entry) => entry.status !== 'failed' && entry.minimumDurationMs)) {
    if (cohort.sampledDurationMs < cohort.minimumDurationMs) {
      cohort.status = 'failed'
      cohort.failures = [`${cohort.name} sampled ${cohort.sampledDurationMs}ms below ${cohort.minimumDurationMs}ms`]
    }
  }
  if (elapsedMs < plan.durationMs) await new Promise((resolve) => setTimeout(resolve, plan.durationMs - elapsedMs))
  const summary = {
    schema: 'fsusblog.mixed-performance-window.v1',
    status: cohorts.some((cohort) => cohort.status === 'failed') ? 'failed' : 'ok',
    executionSource: 'fresh',
    startedAt: new Date(startedAt).toISOString(),
    startedAtMs: startedAt,
    minimumWindowMs: plan.durationMs,
    elapsedMs: Date.now() - startedAt,
    resources,
    warmup,
    resourceTimeline: [
      ...benchmarkCoordinator.timeline().map((entry) => ({ ...entry, phase: 'benchmark' })),
      ...loadTimeline
    ],
    cohorts,
    generatedAt: new Date().toISOString()
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`[mixed-performance-window] elapsedMs=${summary.elapsedMs} cohorts=${cohorts.length}`)
  if (summary.status !== 'ok') throw new Error('mixed performance window contains failed cohort evidence')
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch((error) => {
    console.error(`[mixed-performance-window] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
