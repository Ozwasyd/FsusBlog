import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { executeWeightedStepDag } from '../../tools/test/bundles/bundle-steps.mjs'

import {
  classifyResourceWait,
  createLinuxProcessTreeCollector,
  createWaitLedger,
  integrateResourceGrantHistory,
  measureResourceCollectorOverhead,
  resourceUtilizationSchema,
  resolveResourceSampleIntervalMs,
  validateResourceUtilizationBinding,
  writeResourceUtilizationEvidence
} from '../../tools/test-matrix/resource-utilization.mjs'

test('collector cadence derives from granted machine CPU and protects benchmark windows', () => {
  assert.ok(resolveResourceSampleIntervalMs({ cpuUnits: 16 }) < resolveResourceSampleIntervalMs({ cpuUnits: 1 }))
  assert.ok(resolveResourceSampleIntervalMs({ cpuUnits: 16, benchmark: true }) >= 1000)
  assert.ok(resolveResourceSampleIntervalMs({ cpuUnits: 16, benchmark: true })
    > resolveResourceSampleIntervalMs({ cpuUnits: 16 }))
})

test('collector calibration records a machine-local before/after observation cost', {
  skip: process.platform !== 'linux'
}, () => {
  const calibration = measureResourceCollectorOverhead({ iterations: 4 })
  assert.equal(calibration.status, 'measured')
  assert.equal(calibration.iterations, 4)
  assert.ok(calibration.baselineNs >= 0)
  assert.ok(calibration.observedNs > calibration.baselineNs)
  assert.ok(calibration.addedNsPerSample > 0)
})

test('dynamic resource grants are integrated across expansion and contraction boundaries', () => {
  const result = integrateResourceGrantHistory([
    { atMs: 0, cpuUnits: 2, memoryGiB: 1 },
    { atMs: 1000, cpuUnits: 4, memoryGiB: 2 },
    { atMs: 2500, cpuUnits: 1, memoryGiB: 3 }
  ], 0, 3000)
  assert.equal(result.status, 'measured')
  assert.equal(result.cpuSeconds, 8.5)
  assert.equal(result.memoryGiBSeconds, 5.5)
  assert.deepEqual(result.segments.map((entry) => entry.durationMs), [1000, 1500, 500])
})

test('wait categories are mutually exclusive and readiness has explicit precedence', () => {
  assert.deepEqual(classifyResourceWait({
    readinessMarker: 'frontend-ready',
    dependencies: ['build'],
    exclusiveResources: ['browser'],
    capacity: { cpu: true }
  }), { category: 'readiness-marker-blocked', detail: 'frontend-ready' })
  assert.equal(classifyResourceWait({ dependencies: ['a'] }).category, 'dependency-blocked')
  assert.equal(classifyResourceWait({ benchmarkIsolation: true, exclusiveResources: ['benchmark-window'] }).category,
    'benchmark-isolation-cooldown')
  assert.equal(classifyResourceWait({ exclusiveResources: ['browser'] }).category, 'exclusive-resource-blocked')
  assert.equal(classifyResourceWait({ countedResources: { chromiumLane: { capacity: 1 } } }).category,
    'counted-resource-blocked')
  assert.equal(classifyResourceWait({ capacity: { memory: true } }).category, 'capacity-blocked')
  assert.equal(classifyResourceWait({ externalService: 'postgres' }).category, 'external-service-io-blocked')
})

test('wait ledger closes transitions without double counting', () => {
  let now = 0
  const ledger = createWaitLedger(() => now)
  ledger.observe('step', { dependencies: ['a'] })
  now = 100
  ledger.observe('step', { dependencies: ['a'] })
  now = 250
  ledger.observe('step', { capacity: { cpu: true } })
  now = 400
  const result = ledger.finish()
  assert.equal(result.totalsMs['dependency-blocked'], 250)
  assert.equal(result.totalsMs['capacity-blocked'], 150)
  assert.equal(result.intervals.length, 2)
})

test('weighted step DAG reports dependency, exclusive-resource, and capacity waits to telemetry', async () => {
  const observations = []
  await executeWeightedStepDag([
    { id: 'owner', dependsOn: [], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['browser'] } },
    { id: 'exclusive', dependsOn: [], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1, exclusiveResources: ['browser'] } },
    { id: 'capacity', dependsOn: [], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 2 } },
    { id: 'dependent', dependsOn: ['owner'], resources: { cpuWeight: 1, memoryWeight: 1, minCpuUnits: 1 } }
  ], {
    cpuUnits: 2,
    memoryGiB: 2,
    maxParallel: 3,
    exclusiveResources: ['browser'],
    onWaitState: (stepId, state) => { if (state) observations.push({ stepId, state }) }
  }, async ({ id }) => {
    if (id === 'owner') await new Promise((resolve) => setTimeout(resolve, 20))
  })
  assert.ok(observations.some(({ stepId, state }) => stepId === 'exclusive' && state.exclusiveResources?.includes('browser')))
  assert.ok(observations.some(({ stepId, state }) => stepId === 'capacity' && state.capacity?.cpu === true))
  assert.ok(observations.some(({ stepId, state }) => stepId === 'dependent' && state.dependencies?.includes('owner')))
})

test('Linux collector retains sampled process-tree identity after descendants exit abnormally', {
  skip: process.platform !== 'linux'
}, async () => {
  const child = spawn('/bin/bash', ['-lc', `${process.execPath} -e "setTimeout(() => process.exit(7), 160)"`], {
    detached: true,
    stdio: 'ignore'
  })
  const collector = createLinuxProcessTreeCollector({
    rootPid: child.pid,
    grantProvider: () => ({ cpuUnits: 2, memoryGiB: 1 }),
    sampleIntervalMs: 25
  })
  await new Promise((resolve) => child.once('close', resolve))
  const result = collector.stop()
  assert.equal(result.status, 'measured')
  assert.ok(result.processSpawnCount >= 2)
  assert.equal(result.processSpawnCountStatus, 'sampled-lower-bound')
  assert.ok(result.browserProcessCount >= 0)
  assert.ok(result.peakBrowserProcessCount >= 0)
  assert.equal(result.browserProcessCountStatus, 'sampled-lower-bound')
  assert.ok(result.grantedCpuSeconds > 0)
  assert.ok(result.samples.length >= 2)
})

test('unsupported collector reports null metrics instead of fabricated zeroes', () => {
  const result = createLinuxProcessTreeCollector({ rootPid: null }).stop()
  assert.equal(result.status, 'unsupported')
  assert.equal(result.actualCpuSeconds, null)
  assert.equal(result.readBytes, null)
  assert.equal(result.processSpawnCount, null)
})

test('canonical evidence rejects run, source, and checkpoint mismatch and preserves partial status', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsus-resource-evidence-'))
  const file = path.join(directory, 'evidence.json')
  const expected = {
    runId: 'run-1',
    sourceState: { commit: 'abc', worktreeFingerprint: 'tree' },
    checkpoint: { revision: 9 }
  }
  const evidence = writeResourceUtilizationEvidence(file, {
    status: 'partial', incomplete: true, runId: 'run-1',
    sourceState: expected.sourceState, checkpoint: { revision: 9 }, bundles: {}
  }, expected)
  assert.equal(evidence.schema, resourceUtilizationSchema)
  assert.equal(evidence.status, 'partial')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).incomplete, true)
  assert.deepEqual(validateResourceUtilizationBinding({ ...evidence, runId: 'other' }, expected), ['runId mismatch'])
  assert.deepEqual(validateResourceUtilizationBinding({ ...evidence, sourceState: { commit: 'bad', worktreeFingerprint: 'tree' } }, expected),
    ['sourceState mismatch'])
  assert.deepEqual(validateResourceUtilizationBinding({ ...evidence, checkpoint: { revision: 8 } }, expected),
    ['checkpoint revision mismatch'])
  fs.rmSync(directory, { recursive: true, force: true })
})

test('collector exposes bounded observation cost instead of hiding benchmark disturbance', {
  skip: process.platform !== 'linux'
}, async () => {
  const child = spawn('/bin/bash', ['-lc', 'sleep 0.2'], { detached: true, stdio: 'ignore' })
  const collector = createLinuxProcessTreeCollector({
    rootPid: child.pid,
    grantProvider: () => ({ cpuUnits: 1, memoryGiB: 1 }),
    sampleIntervalMs: 50
  })
  await new Promise((resolve) => child.once('close', resolve))
  const result = collector.stop()
  assert.ok(result.collector.sampleCount >= 2)
  assert.ok(result.collector.collectionCpuNs >= 0)
  assert.ok(result.collector.cpuOverheadRatio < 0.5)
})
