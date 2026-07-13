#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value) throw new Error(`Invalid argument near ${name ?? '<end>'}`)
    options[name.slice(2)] = path.resolve(value)
  }
  for (const required of ['reports', 'budgets', 'output', 'release-summary']) {
    if (!options[required]) throw new Error(`Missing --${required}`)
  }
  return options
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function benchmarkClassName(entry) {
  const explicit = entry.Type ?? entry.BenchmarkType ?? entry.Class ?? entry.className
  if (typeof explicit === 'string' && explicit.length > 0) return explicit.split('.').at(-1)
  const fullName = entry.FullName ?? entry.fullName ?? ''
  const beforeMethod = String(fullName).split('(')[0]
  const segments = beforeMethod.split('.')
  return segments.length > 1 ? segments.at(-2) : ''
}

function methodName(entry) {
  const explicit = entry.Method ?? entry.method ?? entry.MethodTitle
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return String(entry.FullName ?? entry.fullName ?? '').split('(')[0].split('.').at(-1)
}

function parameterKey(entry) {
  const parameters = entry.Parameters ?? entry.parameters ?? entry.Params ?? null
  return parameters === null || parameters === undefined ? 'default' : JSON.stringify(parameters)
}

function normalizeBenchmark(entry, source) {
  const statistics = entry.Statistics ?? entry.statistics ?? {}
  const memory = entry.Memory ?? entry.memory ?? entry.Gc ?? {}
  return {
    benchmark: benchmarkClassName(entry),
    method: methodName(entry),
    parameters: parameterKey(entry),
    meanNanoseconds: finiteNumber(statistics.Mean ?? entry.Mean ?? entry.meanNanoseconds),
    allocatedBytes: finiteNumber(
      memory.BytesAllocatedPerOperation
      ?? memory.AllocatedBytes
      ?? entry.AllocatedBytes
      ?? entry.allocatedBytes),
    source
  }
}

function loadReports(directory, outputFile) {
  const outputResolved = path.resolve(outputFile)
  const files = fs.readdirSync(directory)
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(directory, file))
    .filter(file => path.resolve(file) !== outputResolved)
    .sort()
  const benchmarks = []
  for (const file of files) {
    const report = readJson(file)
    const entries = report.Benchmarks ?? report.benchmarks ?? report.Results ?? []
    if (!Array.isArray(entries)) continue
    benchmarks.push(...entries.map(entry => normalizeBenchmark(entry, path.relative(process.cwd(), file))))
  }
  return benchmarks
}

function select(entries, budget, method) {
  return entries.filter(entry => entry.benchmark === budget.benchmark && entry.method === method)
}

function ratio(numerator, denominator) {
  if (denominator === 0) return numerator === 0 ? 0 : Number.POSITIVE_INFINITY
  return numerator / denominator
}

function compareBudget(entries, budget, requireAllocationEvidence) {
  const current = select(entries, budget, budget.method)
  const failures = []
  const comparisons = []
  if (current.length === 0) {
    failures.push(`missing benchmark ${budget.benchmark}.${budget.method}`)
    return { ...budget, status: 'failed', failures, comparisons }
  }

  const baseline = budget.baselineMethod ? select(entries, budget, budget.baselineMethod) : []
  if (budget.baselineMethod && baseline.length === 0) failures.push(`missing baseline ${budget.benchmark}.${budget.baselineMethod}`)
  const baselineByParameters = new Map(baseline.map(entry => [entry.parameters, entry]))

  for (const measurement of current) {
    const result = { ...measurement, checks: [] }
    if (measurement.meanNanoseconds === null) failures.push(`${budget.id}:${measurement.parameters} missing mean`)
    if (requireAllocationEvidence && measurement.allocatedBytes === null) failures.push(`${budget.id}:${measurement.parameters} missing allocation`)

    if (budget.baselineMethod) {
      const before = baselineByParameters.get(measurement.parameters)
      if (!before) {
        failures.push(`${budget.id}:${measurement.parameters} missing matching baseline parameters`)
      } else {
        result.baseline = before
        if (measurement.meanNanoseconds !== null && before.meanNanoseconds !== null) {
          const measuredRatio = ratio(measurement.meanNanoseconds, before.meanNanoseconds)
          result.checks.push({ metric: 'meanRatio', actual: measuredRatio, maximum: budget.maxMeanRatio })
          if (measuredRatio > budget.maxMeanRatio) failures.push(`${budget.id}:${measurement.parameters} mean ratio ${measuredRatio.toFixed(4)} > ${budget.maxMeanRatio}`)
        }
        if (measurement.allocatedBytes !== null && before.allocatedBytes !== null) {
          const measuredRatio = ratio(measurement.allocatedBytes, before.allocatedBytes)
          result.checks.push({ metric: 'allocatedRatio', actual: measuredRatio, maximum: budget.maxAllocatedRatio })
          if (measuredRatio > budget.maxAllocatedRatio) failures.push(`${budget.id}:${measurement.parameters} allocation ratio ${measuredRatio.toFixed(4)} > ${budget.maxAllocatedRatio}`)
        }
      }
    } else {
      if (measurement.meanNanoseconds !== null) {
        result.checks.push({ metric: 'meanNanoseconds', actual: measurement.meanNanoseconds, maximum: budget.maxMeanNanoseconds })
        if (measurement.meanNanoseconds > budget.maxMeanNanoseconds) failures.push(`${budget.id}:${measurement.parameters} mean ${measurement.meanNanoseconds}ns > ${budget.maxMeanNanoseconds}ns`)
      }
      if (measurement.allocatedBytes !== null) {
        result.checks.push({ metric: 'allocatedBytes', actual: measurement.allocatedBytes, maximum: budget.maxAllocatedBytes })
        if (measurement.allocatedBytes > budget.maxAllocatedBytes) failures.push(`${budget.id}:${measurement.parameters} allocation ${measurement.allocatedBytes}B > ${budget.maxAllocatedBytes}B`)
      }
    }
    comparisons.push(result)
  }
  return { ...budget, status: failures.length === 0 ? 'ok' : 'failed', failures, comparisons }
}

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
}

export function evaluate(options) {
  const policy = readJson(options.budgets)
  if (policy.schema !== 'fsusblog.backend-hotpath-budgets.v1' || !Array.isArray(policy.budgets)) {
    throw new Error('Unsupported backend hot-path budget schema')
  }
  const entries = loadReports(options.reports, options.output)
  const results = policy.budgets.map(budget => compareBudget(entries, budget, policy.policy?.requireAllocationEvidence === true))
  const failed = results.filter(result => result.status !== 'ok')
  const generatedAt = new Date().toISOString()
  const output = {
    schema: 'fsusblog.backend-benchmark-regression.v2',
    status: failed.length === 0 ? 'ok' : 'failed',
    generatedAt,
    measurementCount: entries.length,
    budgetCount: results.length,
    failedBudgetCount: failed.length,
    budgetFile: path.relative(process.cwd(), options.budgets),
    results
  }
  writeJson(options.output, output)
  writeJson(options['release-summary'], {
    schema: 'fsusblog.backend-benchmark-release-summary.v2',
    status: output.status,
    generatedAt,
    artifact: path.relative(process.cwd(), options.output),
    measuredBudgetIds: results.map(result => result.id),
    failedBudgetIds: failed.map(result => result.id)
  })
  return output
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const result = evaluate(parseArgs(process.argv.slice(2)))
    console.log(`[backend-benchmark-regression] ${result.status}: ${result.budgetCount - result.failedBudgetCount}/${result.budgetCount} budgets passed`)
    process.exitCode = result.status === 'ok' ? 0 : 1
  } catch (error) {
    console.error(`[backend-benchmark-regression] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
