import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  collectShardReports,
  discoverHotPathBenchmarkClasses,
  parseCpuList,
  readAdaptiveBenchmarkResourceGrant,
  runAdaptiveBenchmarkClassQueue,
  resolveBenchmarkParallelism,
  resolveBenchmarkWorkerEnvironment,
  runBenchmarkClassQueue,
  validateHotPathBenchmarkContract
} from '../../tools/perf/run-backend-benchmark-regression.mjs'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'))
const checker = path.join(root, 'tools/perf/check-backend-benchmark-regression.mjs')

function writeJson(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`)
}

function runFixture({
  baselineMean = 100,
  baselineAllocation = 100,
  currentMean = 80,
  currentAllocation = 40
} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-benchmark-'))
  const reports = path.join(temp, 'reports')
  const output = path.join(reports, 'regression.json')
  const releaseSummary = path.join(temp, 'release-summary.json')
  const budgets = path.join(temp, 'budgets.json')
  writeJson(path.join(reports, 'Benchmark-report.json'), {
    Benchmarks: [
      {
        Type: 'FixtureHotPathBenchmarks',
        Method: 'Before',
        Parameters: { Size: 10 },
        Statistics: { Mean: baselineMean },
        Memory: { BytesAllocatedPerOperation: baselineAllocation }
      },
      {
        Type: 'FixtureHotPathBenchmarks',
        Method: 'After',
        Parameters: { Size: 10 },
        Statistics: { Mean: currentMean },
        Memory: { BytesAllocatedPerOperation: currentAllocation }
      }
    ]
  })
  writeJson(budgets, {
    schema: 'fsusblog.backend-hotpath-budgets.v1',
    policy: { requireAllocationEvidence: true },
    budgets: [{
      id: 'fixture',
      benchmark: 'FixtureHotPathBenchmarks',
      method: 'After',
      baselineMethod: 'Before',
      maxMeanRatio: 1,
      maxAllocatedRatio: 0.5
    }]
  })
  const result = spawnSync(process.execPath, [
    checker,
    '--reports', reports,
    '--budgets', budgets,
    '--output', output,
    '--release-summary', releaseSummary
  ], { encoding: 'utf8' })
  return { result, output: JSON.parse(fs.readFileSync(output, 'utf8')), releaseSummary: JSON.parse(fs.readFileSync(releaseSummary, 'utf8')) }
}

test('emits measured before-after evidence when every budget passes', () => {
  const fixture = runFixture()
  assert.equal(fixture.result.status, 0, fixture.result.stderr)
  assert.equal(fixture.output.status, 'ok')
  assert.equal(fixture.output.measurementCount, 2)
  assert.equal(fixture.output.results[0].comparisons[0].checks[0].actual, 0.8)
  assert.equal(fixture.output.results[0].comparisons[0].checks[1].actual, 0.4)
  assert.equal(fixture.releaseSummary.status, 'ok')
})

test('fails the lane and names the measured regression instead of writing a synthetic ok', () => {
  const fixture = runFixture({ currentMean: 125, currentAllocation: 80 })
  assert.equal(fixture.result.status, 1)
  assert.equal(fixture.output.status, 'failed')
  assert.match(fixture.output.results[0].failures.join('\n'), /mean ratio 1\.2500 > 1/u)
  assert.match(fixture.output.results[0].failures.join('\n'), /allocation ratio 0\.8000 > 0\.5/u)
  assert.deepEqual(fixture.releaseSummary.failedBudgetIds, ['fixture'])
})

test('treats zero baseline and zero current allocation as a zero ratio', () => {
  const fixture = runFixture({ baselineAllocation: 0, currentAllocation: 0 })
  assert.equal(fixture.result.status, 0, fixture.result.stderr)
  const allocation = fixture.output.results[0].comparisons[0].checks
    .find((check) => check.metric === 'allocatedRatio')
  assert.deepEqual(allocation, { metric: 'allocatedRatio', actual: 0, maximum: 0.5 })
})

test('discovers every HotPath class and retains 22 ShortRun MemoryDiagnoser cases', () => {
  const benchmarkRoot = path.join(root, 'benchmarks/core')
  const program = fs.readFileSync(path.join(benchmarkRoot, 'Program.cs'), 'utf8')
  const sources = fs.readdirSync(benchmarkRoot)
    .filter((file) => file.endsWith('.cs'))
    .map((file) => fs.readFileSync(path.join(benchmarkRoot, file), 'utf8'))
  assert.deepEqual(discoverHotPathBenchmarkClasses(program), [
    'BinaryTransportHotPathBenchmarks',
    'ContentFilterHotPathBenchmarks',
    'CrawlerNormalizationHotPathBenchmarks',
    'NotificationStreamHotPathBenchmarks',
    'ReadModelProjectionHotPathBenchmarks',
    'RelatedReadingHotPathBenchmarks',
    'RequestAuditHotPathBenchmarks',
    'StatsProjectionHotPathBenchmarks'
  ])
  assert.deepEqual(validateHotPathBenchmarkContract(program, sources), {
    classes: discoverHotPathBenchmarkClasses(program),
    methodCount: 18,
    caseCount: 22,
    job: 'ShortRun',
    memoryDiagnoserClassCount: 8
  })
})

test('complete STEP grants trust scheduler memory admission and retain every granted CPU worker', () => {
  assert.deepEqual(parseCpuList('2-4,7,9-10'), [2, 3, 4, 7, 9, 10])
  const capacity = resolveBenchmarkParallelism({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '6',
      FSUSBLOG_STEP_MEMORY_GIB: '5'
    },
    availableCpu: 8,
    allowedCpuIds: [2, 3, 4, 5, 6, 7, 8, 9],
    freeMemoryGiB: 12,
    totalMemoryGiB: 16,
    classCount: 8
  })
  assert.equal(capacity.schedulerManaged, true)
  assert.equal(capacity.cpuWorkerLimit, 6)
  assert.equal(capacity.memoryWorkerLimit, 6)
  assert.equal(capacity.workerCount, 6)
  assert.deepEqual(capacity.workerCpuSets, [[2], [3], [4], [5], [6], [7]])
})

test('direct benchmark invocation still protects workers with current host memory', () => {
  const capacity = resolveBenchmarkParallelism({
    env: {
      FSUSBLOG_BUNDLE_CPU_BUDGET: '6',
      FSUSBLOG_BUNDLE_MEMORY_GIB: '5'
    },
    availableCpu: 8,
    allowedCpuIds: [2, 3, 4, 5, 6, 7, 8, 9],
    freeMemoryGiB: 12,
    totalMemoryGiB: 16,
    classCount: 8
  })
  assert.equal(capacity.schedulerManaged, false)
  assert.equal(capacity.cpuWorkerLimit, 6)
  assert.equal(capacity.memoryWorkerLimit, 2)
  assert.equal(capacity.workerCount, 2)
  assert.deepEqual(capacity.workerCpuSets, [[2, 4, 6], [3, 5, 7]])
})

test('benchmark child environments split the admitted STEP grant without overselling it', () => {
  const capacity = resolveBenchmarkParallelism({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '3',
      FSUSBLOG_STEP_MEMORY_GIB: '6'
    },
    availableCpu: 8,
    allowedCpuIds: [0, 1, 2, 3, 4, 5, 6, 7],
    freeMemoryGiB: 1,
    totalMemoryGiB: 16,
    classCount: 8
  })
  const workers = capacity.workerCpuSets.map((_cpuSet, index) =>
    resolveBenchmarkWorkerEnvironment(capacity, index, {}))
  assert.equal(workers.length, 3)
  assert.ok(workers.every((env) => env.FSUSBLOG_STEP_CPU_BUDGET === '1'))
  assert.equal(workers.reduce((total, env) => total + Number(env.FSUSBLOG_STEP_MEMORY_GIB), 0), 6)
})

test('runs each benchmark class atomically through a bounded worker queue', async () => {
  const classes = Array.from({ length: 8 }, (_, index) => `Class${index}HotPathBenchmarks`)
  let active = 0
  let peak = 0
  const workerIds = new Set()
  const results = await runBenchmarkClassQueue(classes, 3, async (benchmarkClass, _index, workerIndex) => {
    active += 1
    peak = Math.max(peak, active)
    workerIds.add(workerIndex)
    await new Promise((resolve) => setImmediate(resolve))
    active -= 1
    return benchmarkClass
  })
  assert.equal(peak, 3)
  assert.deepEqual([...workerIds].sort(), [0, 1, 2])
  assert.deepEqual(results.map((result) => result.value), classes)
  assert.ok(results.every((result) => result.status === 'success'))
})

test('adaptive benchmark queue expands at class boundaries without dropping or duplicating classes', async () => {
  const classes = Array.from({ length: 8 }, (_, index) => `Adaptive${index}HotPathBenchmarks`)
  const initialCapacity = { workerCount: 2, workerCpuSets: [[0], [1]] }
  const expandedCapacity = { workerCount: 4, workerCpuSets: [[0], [1], [2], [3]] }
  let completed = 0
  let active = 0
  let peak = 0
  const attempted = []
  const observedCpuSets = []
  const execution = await runAdaptiveBenchmarkClassQueue({
    classes,
    initialCapacity,
    resolveCapacity: async () => completed > 0 ? expandedCapacity : initialCapacity,
    executeClass: async (benchmarkClass, _index, workerIndex, capacity) => {
      attempted.push(benchmarkClass)
      observedCpuSets.push({ workerIndex, cpus: capacity.workerCpuSets[workerIndex] })
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
      completed += 1
      return benchmarkClass
    }
  })
  assert.equal(execution.peakWorkerCount, 4)
  assert.equal(peak, 4)
  assert.deepEqual(new Set(attempted), new Set(classes))
  assert.deepEqual(execution.results.map((result) => result.value), classes)
  assert.ok(observedCpuSets.every(({ workerIndex, cpus }) => cpus.length === 1 && cpus[0] === workerIndex))
  assert.ok(observedCpuSets.some(({ workerIndex }) => workerIndex === 2))
  assert.ok(observedCpuSets.some(({ workerIndex }) => workerIndex === 3))
})

test('adaptive benchmark grant is run-bound and rejects oversold allocations', () => {
  const env = {
    FSUSBLOG_MIXED_WINDOW_RESOURCE_FILE: '/tmp/mixed-resources.json',
    FSUSBLOG_MIXED_WINDOW_RESOURCE_RUN_ID: 'mixed-current'
  }
  const document = {
    schema: 'fsusblog.mixed-performance-resources.v1',
    runId: 'mixed-current',
    generation: 3,
    total: { cpuUnits: 8, memoryGiB: 8 },
    allocations: {
      benchmark: { cpuUnits: 5, memoryGiB: 6 },
      peak: { cpuUnits: 1, memoryGiB: 1 }
    }
  }
  assert.deepEqual(readAdaptiveBenchmarkResourceGrant({
    env,
    readFile: () => JSON.stringify(document)
  }), { cpuUnits: 5, memoryGiB: 6, generation: 3 })
  assert.throws(() => readAdaptiveBenchmarkResourceGrant({
    env,
    readFile: () => JSON.stringify({ ...document, runId: 'stale' })
  }), /runId mismatch/u)
  assert.throws(() => readAdaptiveBenchmarkResourceGrant({
    env,
    readFile: () => JSON.stringify({
      ...document,
      allocations: {
        benchmark: { cpuUnits: 8, memoryGiB: 8 },
        peak: { cpuUnits: 1, memoryGiB: 1 }
      }
    })
  }), /exceeds the mixed-window budget/u)
})

test('aggregates independent class artifact directories without overwriting reports', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-backend-benchmark-shards-'))
  const shards = ['FirstHotPathBenchmarks', 'SecondHotPathBenchmarks'].map((benchmarkClass, index) => {
    const artifactDirectory = path.join(temp, `shard-${index}`)
    writeJson(path.join(artifactDirectory, 'results', 'report.json'), {
      Benchmarks: [{ Type: benchmarkClass, Method: 'Current' }]
    })
    return { benchmarkClass, artifactDirectory }
  })
  const aggregate = path.join(temp, 'aggregate')
  const reports = collectShardReports(shards, aggregate)
  assert.equal(reports.length, 2)
  assert.deepEqual(fs.readdirSync(aggregate).sort(), [
    'FirstHotPathBenchmarks--report.json',
    'SecondHotPathBenchmarks--report.json'
  ])
})
