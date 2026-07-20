import assert from 'node:assert/strict'
import test from 'node:test'

import {
  allocateBackendTopologyProcessors,
  buildBackendTopologyCalibrationMatrix,
  planBackendProductionTopology,
  resolveBackendTopologyCapacity
} from '../../tools/test/backend-production-topology.mjs'
import {
  buildBackendTopologyCalibrationReport,
  parseBackendTopologyCalibrationArgs,
  parseGnuTimeVerboseMetrics,
  summarizeBackendTopologyCalibrationCandidate
} from '../../tools/test/calibrate-backend-production-topology.mjs'

function plan(cpuBudget, overrides = {}) {
  return planBackendProductionTopology({
    cpuBudget,
    memoryGiB: Math.max(2, cpuBudget * 2),
    planningUnitCount: 47,
    productionTestCaseCount: 640,
    coldApplicationStartupPenalty: 26,
    classStartupPenalty: 12,
    weightedDependencyCount: 18,
    affinityGroupCount: 3,
    governancePostludeCount: 1,
    ...overrides
  })
}

test('automatic backend topology is bounded and does not use one testhost per CPU', () => {
  const expectedHosts = new Map([[2, 2], [4, 2], [8, 2], [16, 4], [32, 5]])
  for (const cpuBudget of [2, 4, 8, 16, 32]) {
    const topology = plan(cpuBudget)
    assert.equal(topology.testhostCount, expectedHosts.get(cpuBudget))
    assert.ok(topology.testhostCount <= 12)
    assert.ok(topology.testhostCount <= cpuBudget)
    assert.equal(topology.processorsByTesthost.length, topology.testhostCount)
    assert.equal(topology.processorsByTesthost.reduce((sum, value) => sum + value, 0), cpuBudget)
    assert.ok(topology.processorsByTesthost.every((value) => value >= 1))
    assert.equal(topology.invariants.exactCpuConservation, true)
    assert.equal(topology.invariants.exactMemoryConservation, true)
  }
})

test('testhost, processor and rolling partition dimensions remain independent', () => {
  const topology = plan(16, {
    testhostOverride: 4,
    partitionMultiplier: 3
  })
  assert.equal(topology.testhostCount, 4)
  assert.deepEqual(topology.processorsByTesthost, [4, 4, 4, 4])
  assert.equal(topology.rollingPartitionCount, 12)
  assert.equal(topology.totalPartitionCount, 13)
  assert.equal(topology.governancePostludeCount, 1)
  assert.notEqual(topology.testhostCount, topology.rollingPartitionCount)
})

test('weighted processor allocation conserves the admitted CPU grant exactly', () => {
  assert.deepEqual(allocateBackendTopologyProcessors(16, 4, {
    mode: 'weighted',
    weights: [5, 3, 2, 1]
  }), [7, 4, 3, 2])
  assert.deepEqual(allocateBackendTopologyProcessors(8, 3), [3, 3, 2])
  assert.throws(() => allocateBackendTopologyProcessors(3, 4), /exceeds CPU budget/u)
})

test('memory and planning units cap testhosts without changing CPU conservation', () => {
  const capacity = resolveBackendTopologyCapacity({
    cpuBudget: 32,
    memoryGiB: 4.5,
    planningUnitCount: 3
  })
  assert.equal(capacity.memoryTesthostLimit, 4)
  assert.equal(capacity.testhostLimit, 3)
  const topology = plan(32, {
    memoryGiB: 4.5,
    planningUnitCount: 3
  })
  assert.equal(topology.testhostCount, 3)
  assert.equal(topology.allocatedCpuUnits, 32)
  assert.ok(topology.memoryGiBByTesthost.every((value) => value >= 1))
  assert.throws(() => plan(8, { memoryGiB: 1.99 }), /at least two testhosts/u)
})

test('workload evidence is retained in candidate scores and affinity/postlude invariants', () => {
  const topology = plan(16)
  assert.deepEqual(topology.modelInputs, {
    productionTestCaseCount: 640,
    coldApplicationStartupPenalty: 26,
    classStartupPenalty: 12,
    weightedDependencyCount: 18,
    affinityGroupCount: 3
  })
  assert.ok(topology.candidateScores.every(({ score }) => (
    Number.isFinite(score.total)
    && Number.isFinite(score.hostStartup)
    && Number.isFinite(score.rollingTail)
    && Number.isFinite(score.dependencyTail)
    && Number.isFinite(score.affinityQueue)
  )))
  assert.equal(topology.invariants.affinityUnitsRemainIndivisible, true)
  assert.equal(topology.invariants.governancePostludeSeparated, true)
})

test('calibration matrix clips the 2/4/6/8/12 host matrix to live capacity', () => {
  const matrix = buildBackendTopologyCalibrationMatrix({
    cpuBudget: 8,
    memoryGiB: 6,
    planningUnitCount: 20
  })
  assert.equal(matrix.length, 18)
  assert.deepEqual([...new Set(matrix.map(({ testhostCount }) => testhostCount))], [2, 4, 6])
  assert.deepEqual([...new Set(matrix.map(({ partitionMultiplier }) => partitionMultiplier))], [1.5, 2, 3])
  assert.deepEqual([...new Set(matrix.map(({ processorAllocationMode }) => processorAllocationMode))], [
    'uniform',
    'weighted'
  ])
  assert.equal(new Set(matrix.map(({ id }) => id)).size, matrix.length)
})

test('invalid diagnostic overrides fail closed', () => {
  assert.throws(() => plan(8, { testhostOverride: 9 }), /exceeds capacity/u)
  assert.throws(() => plan(8, { partitionMultiplier: 0.5 }), /at least one/u)
  assert.throws(() => plan(8, { processorAllocationMode: 'random' }), /allocation mode/u)
})

test('calibration CLI requires fresh semantics and accepts bounded candidate selection', () => {
  assert.throws(() => parseBackendTopologyCalibrationArgs([]), /requires --fresh/u)
  const options = parseBackendTopologyCalibrationArgs([
    '--fresh', '--candidate', 'h4-p2-uniform', '--repeat', '3', '--max-candidates', '1',
    '--cpu-budget', '16', '--memory-gib', '32', '--planning-units', '47'
  ], { availableCpu: 16, totalMemoryGiB: 64, freeMemoryGiB: 48 })
  assert.equal(options.fresh, true)
  assert.deepEqual(options.candidateIds, ['h4-p2-uniform'])
  assert.equal(options.repeat, 3)
  assert.equal(options.maxCandidates, 1)
  assert.equal(options.cpuBudget, 16)
  assert.equal(options.memoryGiB, 32)
  assert.equal(options.planningUnitCount, 47)
})

test('calibration CLI rejects under-sampled or impossible machine envelopes', () => {
  const machine = { availableCpu: 16, totalMemoryGiB: 64, freeMemoryGiB: 48 }
  assert.throws(
    () => parseBackendTopologyCalibrationArgs(['--fresh', '--repeat', '2'], machine),
    /at least 3 fresh samples/u
  )
  assert.throws(
    () => parseBackendTopologyCalibrationArgs(['--fresh', '--cpu-budget', '17'], machine),
    /CPU envelope 17 exceeds live machine capacity 16/u
  )
  assert.throws(
    () => parseBackendTopologyCalibrationArgs(['--fresh', '--memory-gib', '65'], machine),
    /memory envelope 65 GiB exceeds live machine capacity 64 GiB/u
  )
})

test('GNU time diagnostics preserve measured values and mark absent metrics unavailable', () => {
  const metrics = parseGnuTimeVerboseMetrics(`
    User time (seconds): 12.25
    System time (seconds): 1.75
    Elapsed (wall clock) time (h:mm:ss or m:ss): 0:14.50
    Maximum resident set size (kbytes): 420000
    Voluntary context switches: 123
    Involuntary context switches: 45
    File system inputs: 6
    File system outputs: 789
  `)
  assert.deepEqual(metrics.userCpuSeconds, { status: 'measured', value: 12.25 })
  assert.deepEqual(metrics.elapsedSeconds, { status: 'measured', value: 14.5 })
  assert.deepEqual(metrics.peakRssKiB, { status: 'measured', value: 420000 })
  assert.deepEqual(parseGnuTimeVerboseMetrics('').userCpuSeconds, { status: 'unavailable', value: null })
})

test('calibration report ranks three fresh samples and forbids result reuse', () => {
  const candidate = summarizeBackendTopologyCalibrationCandidate({
    id: 'h4-p2-uniform',
    testhostCount: 4,
    partitionMultiplier: 2,
    processorAllocationMode: 'uniform',
    rollingPartitionCount: 8
  }, [1000, 900, 1100].map((wallClockMs, index) => ({
    repeat: index + 1,
    status: 'success',
    wallClockMs
  })))
  assert.equal(candidate.wallClock.medianMs, 1000)
  assert.equal(candidate.wallClock.varianceMs2, 20000 / 3)
  const report = buildBackendTopologyCalibrationReport({
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: `sha256:${'b'.repeat(64)}`,
    machine: { cpuBudget: 16, memoryGiB: 32 },
    candidates: [candidate],
    generatedAt: '2026-07-14T00:00:00.000Z'
  })
  assert.equal(report.status, 'success')
  assert.deepEqual(report.rankedSuccessfulCandidates, [{ rank: 1, id: 'h4-p2-uniform', medianMs: 1000 }])
  assert.equal(report.semantics.freshProductionPerSample, true)
  assert.equal(report.semantics.historicalPassReuseAllowed, false)
  assert.equal(report.semantics.coverageReuseAllowed, false)
  assert.equal(report.semantics.releaseEvidenceReuseAllowed, false)
  assert.throws(
    () => summarizeBackendTopologyCalibrationCandidate({ id: 'under-sampled' }, [
      { repeat: 1, status: 'success', wallClockMs: 1000 },
      { repeat: 2, status: 'success', wallClockMs: 900 }
    ]),
    /at least 3 fresh samples/u
  )
  assert.throws(() => buildBackendTopologyCalibrationReport({
    sourceCommit: 'a'.repeat(40),
    sourceFingerprint: 'sha256:',
    machine: { cpuBudget: 16, memoryGiB: 32 },
    candidates: [candidate]
  }), /full SHA-256/u)
})
