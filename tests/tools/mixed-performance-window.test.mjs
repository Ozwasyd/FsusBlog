import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  resolveBenchmarkParallelism,
  runBenchmarkClassQueue
} from '../../tools/perf/run-backend-benchmark-regression.mjs'

import {
  buildMixedWindowPlan,
  collectSampledDuration,
  collectBenchmarkEvidence,
  createMixedWindowResourceCoordinator,
  resolveMixedWindowResources,
  resolveAdaptiveLoadRounds,
  resolveQpsWorkerCapacity,
  runQpsModeQueue,
  settleCohortExecutions
} from '../../tools/test/run-mixed-performance-window.mjs'

test('mixed performance window preserves every minimum duration and QPS cohort', () => {
  const plan = buildMixedWindowPlan()
  assert.equal(plan.durationMs, 60_000)
  assert.equal(plan.cohorts.qps.publicApiCommand, 'npm run check:load:public-api')
  assert.equal(plan.cohorts.baseline.minimumDurationMs, 30_000)
  assert.equal(plan.cohorts.peak.minimumDurationMs, 60_000)
  assert.equal(plan.cohorts.burst.minimumDurationMs, 15_000)
  assert.equal(plan.cohorts.notification.minimumDurationMs, 30_000)
  assert.equal(plan.cohorts.qps.modes.length, 13)
  assert.equal(new Set(plan.cohorts.qps.modes).size, 13)
  assert.equal(plan.cohorts.benchmark.command, 'tools/test/lanes/backend-benchmark-regression.sh')
})

test('mixed performance window keeps six top-level grants and protects benchmark capacity', () => {
  const resources = resolveMixedWindowResources({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '8',
      FSUSBLOG_STEP_MEMORY_GIB: '10'
    },
    availableCpu: 8,
    freeMemoryGiB: 20
  })
  assert.equal(Object.keys(resources.cohorts).length, 6)
  assert.equal(resources.total.cpuUnits, 8)
  assert.equal(resources.allocated.cpuUnits, resources.total.cpuUnits)
  assert.ok(Math.abs(resources.allocated.memoryGiB - resources.total.memoryGiB) < Number.EPSILON * 16)
  assert.equal(resources.cohorts.benchmark.cpuUnits, 3)
  assert.ok(resources.cohorts.benchmark.memoryGiB > resources.cohorts.qps.memoryGiB)
  assert.ok(Object.values(resources.cohorts).every((cohort) => cohort.cpuUnits > 0 && cohort.memoryGiB > 0))
})

test('mixed window transfers only completed cohort grants and never exceeds the admitted total', () => {
  const resources = resolveMixedWindowResources({
    env: { FSUSBLOG_STEP_CPU_BUDGET: '8', FSUSBLOG_STEP_MEMORY_GIB: '8' },
    availableCpu: 8,
    freeMemoryGiB: 8
  })
  const documents = []
  const coordinator = createMixedWindowResourceCoordinator({
    resources,
    runId: 'mixed-live',
    file: '/tmp/not-written.json',
    writeSnapshot: (_file, document) => documents.push(structuredClone(document))
  })
  assert.equal(coordinator.resource('benchmark').cpuUnits, 3)
  coordinator.complete('burst')
  assert.equal(coordinator.resource('burst').cpuUnits, 0)
  assert.equal(coordinator.resource('benchmark').cpuUnits, 4)
  coordinator.complete('notification')
  assert.equal(coordinator.resource('benchmark').cpuUnits, 5)
  for (const document of documents) {
    assert.ok(Object.values(document.allocations).reduce((total, item) => total + item.cpuUnits, 0) <= 8)
    assert.ok(Object.values(document.allocations).reduce((total, item) => total + item.memoryGiB, 0) <= 8 + Number.EPSILON * 64)
    assert.equal(document.runId, 'mixed-live')
  }
  assert.deepEqual(documents.map((document) => document.generation), [0, 1, 2])
})

test('8 CPU mixed benchmark grant admits and actually runs three BenchmarkDotNet class workers', async () => {
  const resources = resolveMixedWindowResources({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: '8',
      FSUSBLOG_STEP_MEMORY_GIB: '10'
    },
    availableCpu: 8,
    freeMemoryGiB: 20
  })
  const benchmark = resources.cohorts.benchmark
  const capacity = resolveBenchmarkParallelism({
    env: {
      FSUSBLOG_STEP_CPU_BUDGET: String(benchmark.cpuUnits),
      FSUSBLOG_STEP_MEMORY_GIB: String(benchmark.memoryGiB)
    },
    availableCpu: 8,
    allowedCpuIds: [0, 1, 2, 3, 4, 5, 6, 7],
    freeMemoryGiB: 1,
    totalMemoryGiB: 16,
    classCount: 8
  })
  assert.equal(benchmark.cpuUnits, 3)
  assert.equal(capacity.schedulerManaged, true)
  assert.equal(capacity.workerCount, 3)

  let active = 0
  let peak = 0
  const results = await runBenchmarkClassQueue(
    Array.from({ length: 8 }, (_, index) => `Mixed${index}HotPathBenchmarks`),
    capacity.workerCount,
    async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active -= 1
    }
  )
  assert.equal(peak, 3)
  assert.ok(results.every((result) => result.status === 'success'))
})

test('repeated load cohorts accumulate measured probe time instead of outer wall time', async () => {
  const samples = [12_500, 18_000, 29_500]
  const result = await collectSampledDuration({
    name: 'peak',
    minimumDurationMs: 60_000,
    executeSample: async ({ sampleIndex }) => ({
      elapsedMs: 90_000,
      runtime: { durationMs: samples[sampleIndex] }
    })
  })
  assert.deepEqual(result, { sampleCount: 3, sampledDurationMs: 60_000 })
})

test('remaining load rounds scale from measured throughput without a fixed worker count', () => {
  assert.equal(resolveAdaptiveLoadRounds({
    profileName: 'expected-peak',
    effective: { rounds: 12 },
    runtime: { durationMs: 2_000 }
  }, 58_000), 348)
  assert.equal(resolveAdaptiveLoadRounds({
    profileName: 'expected-peak',
    effective: { rounds: 12 },
    runtime: { durationMs: 2_000 }
  }, 0), null)
})

test('mixed cohort settlement preserves every independent failure', async () => {
  const cohorts = await settleCohortExecutions([
    {
      name: 'one',
      promise: Promise.reject(new AggregateError([new Error('first failed'), new Error('second failed')]))
    },
    {
      name: 'shared',
      promise: Promise.resolve([
        { name: 'publicApi', status: 'ok' },
        { name: 'qps', status: 'ok' }
      ])
    },
    { name: 'three', promise: Promise.reject(new Error('third failed')) }
  ])
  assert.deepEqual(cohorts, [
    { name: 'one', status: 'failed', failures: ['first failed', 'second failed'] },
    { name: 'publicApi', status: 'ok' },
    { name: 'qps', status: 'ok' },
    { name: 'three', status: 'failed', failures: ['third failed'] }
  ])
})

test('mixed benchmark evidence binds fresh class shards, measurements, checker, and release summary', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-mixed-benchmark-evidence-'))
  const reports = path.join(temp, 'reports')
  const startedAtMs = Date.now() - 100
  fs.mkdirSync(reports, { recursive: true })
  fs.writeFileSync(path.join(reports, 'FirstHotPathBenchmarks--report.json'), JSON.stringify({
    Benchmarks: [
      { Type: 'FirstHotPathBenchmarks', Method: 'Before' },
      { Type: 'FirstHotPathBenchmarks', Method: 'After' }
    ]
  }))
  fs.writeFileSync(path.join(reports, 'SecondHotPathBenchmarks--report.json'), JSON.stringify({
    Benchmarks: [{ Type: 'SecondHotPathBenchmarks', Method: 'Current' }]
  }))
  const checker = path.join(reports, 'fsusblog-benchmark-regression.json')
  const releaseSummary = path.join(temp, 'release-summary.json')
  fs.writeFileSync(checker, JSON.stringify({ status: 'failed' }))
  fs.writeFileSync(releaseSummary, JSON.stringify({ status: 'failed' }))
  const evidence = collectBenchmarkEvidence({
    startedAtMs,
    aggregateReports: reports,
    checkerFile: checker,
    releaseSummaryFile: releaseSummary,
    contract: {
      classes: ['FirstHotPathBenchmarks', 'SecondHotPathBenchmarks'],
      caseCount: 3
    }
  })
  assert.equal(evidence.expectedClassCount, 2)
  assert.equal(evidence.windowStartedAtMs, startedAtMs)
  assert.equal(evidence.measurementCount, 3)
  assert.equal(evidence.reports.length, 2)
  assert.equal(evidence.checker.status, 'failed')
  assert.equal(evidence.releaseSummary.status, 'failed')
  assert.ok(evidence.reports.every((report) => report.digest.startsWith('sha256:')))
})

test('QPS mode workers derive from the cohort CPU and live machine memory', () => {
  assert.deepEqual(resolveQpsWorkerCapacity({
    resource: { cpuUnits: 6, memoryGiB: 5 },
    modeCount: 13,
    availableCpu: 8,
    totalMemoryGiB: 16
  }), {
    workerCount: 2,
    cpuLimit: 6,
    memoryLimit: 2,
    memoryGiBPerCpu: 2
  })
})

test('QPS mode queue rolls all modes through bounded child grants, aggregates last, and reports every failure', async () => {
  const modes = ['one', 'two', 'three', 'four', 'five']
  const started = []
  const completed = []
  let active = 0
  let peak = 0
  let aggregateObservedActive = null
  await assert.rejects(
    runQpsModeQueue({
      modes,
      resource: { cpuUnits: 4, memoryGiB: 4 },
      availableCpu: 8,
      totalMemoryGiB: 16,
      executeMode: async (mode, env) => {
        started.push({ mode, cpu: env.FSUSBLOG_STEP_CPU_BUDGET, memory: env.FSUSBLOG_STEP_MEMORY_GIB })
        active += 1
        peak = Math.max(peak, active)
        await new Promise((resolve) => setImmediate(resolve))
        active -= 1
        completed.push(mode)
        if (['two', 'four'].includes(mode)) throw new Error('mode failed')
      },
      executeAggregate: async (env) => {
        aggregateObservedActive = active
        assert.equal(env.FSUSBLOG_STEP_CPU_BUDGET, '4')
        assert.equal(env.FSUSBLOG_STEP_MEMORY_GIB, '4')
        throw new Error('aggregate failed')
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 3)
      assert.match(error.message, /two: mode failed.*four: mode failed.*aggregate: aggregate failed/u)
      return true
    }
  )
  assert.equal(peak, 2)
  assert.equal(aggregateObservedActive, 0)
  assert.deepEqual(started.map((entry) => entry.mode), modes)
  assert.deepEqual(completed.sort(), [...modes].sort())
  assert.ok(started.every((entry) => entry.cpu === '2' && entry.memory === '2'))
})
