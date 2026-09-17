import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  DEFAULT_SATURATION_POLICY,
  REQUIRED_METRIC_PATHS,
  SATURATION_ROUTES,
  SATURATION_SCHEMA,
  SATURATION_TOPOLOGIES,
  analyzeSaturationScenario,
  buildSaturationReport,
  createOpenLoopSchedule,
  parseSaturationPolicy,
  validateSaturationReport
} from '../../tools/perf/performance-saturation-v2.mjs'
import { mergeSaturationMeasurement } from '../../tools/perf/merge-saturation-measurement.mjs'

function setAtPath(target, dottedPath, value) {
  const parts = dottedPath.split('.')
  let current = target
  for (const part of parts.slice(0, -1)) current = current[part] ??= {}
  current[parts.at(-1)] = value
}

function metrics(overrides = {}) {
  const value = {}
  for (const metricPath of REQUIRED_METRIC_PATHS) setAtPath(value, metricPath, 1)
  Object.assign(value.loadGenerator, {
    cpuPercent: 20,
    scheduleLagP99Ms: 0.2,
    droppedArrivals: 0
  })
  for (const [metricPath, metricValue] of Object.entries(overrides)) setAtPath(value, metricPath, metricValue)
  return value
}

function saturationSamples({ mutate } = {}) {
  const rates = [100, 200, 300, 400]
  return rates.flatMap((offeredRps, rateIndex) => Array.from({ length: 3 }, (_, repeatIndex) => {
    const sample = {
      offeredRps,
      achievedRps: offeredRps * (rateIndex === 3 ? 0.98 : 0.99),
      p50Ms: 2 + rateIndex,
      p95Ms: 4 + rateIndex,
      p99Ms: 6 + rateIndex,
      p999Ms: 8 + rateIndex,
      errorRate: 0,
      timeoutRate: 0,
      durationMs: 30_000,
      responseCount: Math.round(offeredRps * (rateIndex === 3 ? 0.98 : 0.99) * 30),
      repeat: repeatIndex + 1,
      resourceSaturation: {
        cpu: [25, 45, 68, 90][rateIndex],
        memory: 30,
        tlsNic: 20,
        redis: 10,
        postgres: 10
      },
      metrics: metrics({
        'request.cyclesPerRequest': 1200,
        'request.instructionsPerRequest': 2000,
        'request.allocationBytesPerRequest': 64,
        'queues.requestQueueSlope': 0
      }),
      window: {
        startedAt: `2026-07-14T00:${String(rateIndex).padStart(2, '0')}:00.000Z`,
        endedAt: `2026-07-14T00:${String(rateIndex).padStart(2, '0')}:30.000Z`
      },
      sourceDigests: {
        load: `sha256:${'4'.repeat(64)}`,
        systemMetrics: `sha256:${'5'.repeat(64)}`
      }
    }
    mutate?.(sample, { offeredRps, rateIndex, repeatIndex })
    return sample
  }))
}

function identity(capturedAt = new Date().toISOString()) {
  return {
    commitSha: 'a'.repeat(40),
    imageDigest: `sha256:${'b'.repeat(64)}`,
    capturedAt,
    serviceHost: 'service-01',
    hardware: {
      cpuModel: 'Fixture CPU',
      logicalCpus: 16,
      physicalCores: 8,
      smt: true,
      microcode: '0x123'
    },
    platform: { kernel: 'linux-fixture', libc: 'glibc-2.40', containerRuntime: 'containerd-2' },
    cgroup: { cpuQuota: '800000/100000', memoryLimitBytes: 8_589_934_592, cpuset: '0-7' },
    runtime: { dotnetVersion: '10.0.0', environmentDigest: `sha256:${'c'.repeat(64)}` },
    proxy: {
      kind: 'openresty',
      configDigest: `sha256:${'d'.repeat(64)}`,
      tlsConfigDigest: `sha256:${'e'.repeat(64)}`
    },
    postgres: { version: '18', configDigest: `sha256:${'f'.repeat(64)}` },
    redis: { version: '8', configDigest: `sha256:${'1'.repeat(64)}` },
    fixture: { datasetId: 'capacity-v2', articleCount: 10_000, commentCount: 100_000, artifactCount: 20_000 },
    loadGenerator: {
      host: 'load-01',
      cpuModel: 'Load CPU',
      logicalCpus: 16,
      cpuAffinity: '8-15',
      networkPath: 'load-01 -> switch-01 -> service-01'
    },
    serviceCpuAffinity: '0-7'
  }
}

function completeMeasurements(samples = saturationSamples()) {
  return SATURATION_ROUTES.flatMap((routeId) => SATURATION_TOPOLOGIES.map((topology) => ({
    routeId,
    topology,
    samples: structuredClone(samples)
  })))
}

test('perf policy is the authoritative v2 route, topology and threshold source', async () => {
  const text = await import('node:fs').then(({ readFileSync }) => readFileSync(
    new URL('../performance/perf-policy.yml', import.meta.url),
    'utf8'
  ))
  const parsed = parseSaturationPolicy(text)
  assert.deepEqual(parsed.routes, SATURATION_ROUTES)
  assert.deepEqual(parsed.topologies, SATURATION_TOPOLOGIES)
  assert.deepEqual(parsed.policy, DEFAULT_SATURATION_POLICY)
})

test('v2 JSON schema binds the report, sample, identity, metrics and conclusion contracts', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../performance/performance-saturation-v2.schema.json', import.meta.url), 'utf8'))
  assert.equal(schema.properties.schema.const, SATURATION_SCHEMA)
  assert.deepEqual(schema.properties.routeMatrix.prefixItems.map((item) => item.const), SATURATION_ROUTES)
  assert.deepEqual(schema.properties.topologies.const, SATURATION_TOPOLOGIES)
  assert.deepEqual(schema.$defs.sample.required, [
    'offeredRps', 'achievedRps', 'p50Ms', 'p95Ms', 'p99Ms', 'p999Ms',
    'errorRate', 'timeoutRate', 'durationMs', 'repeat', 'responseCount', 'resourceSaturation',
    'metrics', 'window', 'sourceDigests'
  ])
  assert.deepEqual(schema.$defs.conclusion.required, [
    'limitingResource', 'saturationPointRps', 'safeOperatingRps',
    'p99AtSafeOperatingPoint', 'p999AtSafeOperatingPoint', 'cyclesPerRequest',
    'instructionsPerRequest', 'allocationBytesPerRequest', 'queueGrowthStatus'
  ])
  for (const metricPath of REQUIRED_METRIC_PATHS) {
    const [group, field] = metricPath.split('.')
    assert.ok(schema.$defs.metrics.properties[group].required.includes(field), metricPath)
  }
})

test('open-loop schedule is arrival-rate based and independent of completion', () => {
  const schedule = createOpenLoopSchedule({ rate: 100, durationMs: 1000, startMs: 50 })
  assert.equal(schedule.length, 100)
  assert.equal(schedule[0], 50)
  assert.equal(schedule[1] - schedule[0], 10)
  assert.equal(schedule.at(-1), 1040)
})

test('saturation analysis finds the first resource knee and preserves safe headroom', () => {
  const result = analyzeSaturationScenario(saturationSamples())
  assert.equal(result.status, 'ok')
  assert.equal(result.conclusion.limitingResource, 'cpu')
  assert.equal(result.conclusion.saturationPointRps, 392)
  assert.ok(result.conclusion.safeOperatingRps < result.conclusion.saturationPointRps)
  assert.equal(result.conclusion.queueGrowthStatus, 'stable')
  assert.equal(result.conclusion.cyclesPerRequest, 1200)
})

test('missing required metrics fail closed without nullable capacity fields', () => {
  const samples = saturationSamples()
  delete samples[0].metrics.managed.gcPauseP99Ms
  const result = analyzeSaturationScenario(samples)
  assert.equal(result.status, 'blocked')
  assert.match(result.blockers.join('\n'), /managed\.gcPauseP99Ms/u)
  assert.equal(result.conclusion, undefined)
})

test('a low-load single point cannot manufacture a saturation conclusion', () => {
  const result = analyzeSaturationScenario(saturationSamples().filter((sample) => sample.offeredRps === 100))
  assert.equal(result.status, 'blocked')
  assert.match(result.blockers.join('\n'), /offered-load steps/u)
})

test('load generator saturation and repeat variance block the conclusion', () => {
  const generator = analyzeSaturationScenario(saturationSamples({
    mutate(sample, { rateIndex }) {
      if (rateIndex === 2) sample.metrics.loadGenerator.cpuPercent = 90
    }
  }))
  assert.equal(generator.status, 'blocked')
  assert.match(generator.blockers.join('\n'), /load generator saturated/u)

  const noisySamples = saturationSamples({
    mutate(sample, { offeredRps, rateIndex, repeatIndex }) {
      if (rateIndex === 2) sample.achievedRps = offeredRps * [0.75, 1, 1][repeatIndex]
      if (rateIndex === 2) sample.responseCount = Math.round(sample.achievedRps * 30)
    }
  })
  const repeatTemplate = noisySamples.find((sample) => sample.offeredRps === 300 && sample.repeat === 3)
  noisySamples.push(
    { ...structuredClone(repeatTemplate), repeat: 4 },
    { ...structuredClone(repeatTemplate), repeat: 5 }
  )
  const noisy = analyzeSaturationScenario(noisySamples)
  assert.equal(noisy.status, 'blocked')
  assert.match(noisy.blockers.join('\n'), /variance/u)
})

test('latency violations and multiple saturated resources block safe capacity', () => {
  const latency = analyzeSaturationScenario(saturationSamples({
    mutate(sample, { rateIndex }) {
      if (rateIndex === 2) sample.p999Ms = 600
    }
  }))
  assert.equal(latency.status, 'blocked')
  assert.match(latency.blockers.join('\n'), /p99 or p99\.9/u)

  const ambiguous = analyzeSaturationScenario(saturationSamples({
    mutate(sample, { rateIndex }) {
      if (rateIndex === 3) sample.resourceSaturation.memory = 88
    }
  }))
  assert.equal(ambiguous.status, 'blocked')
  assert.match(ambiguous.blockers.join('\n'), /other resources lack headroom/u)
})

test('complete same-identity route and topology matrix validates as v2 real evidence', () => {
  const report = buildSaturationReport({ identity: identity(), measurements: completeMeasurements() })
  assert.equal(report.schema, SATURATION_SCHEMA)
  assert.equal(report.status, 'ok')
  assert.equal(report.scenarios.length, SATURATION_ROUTES.length * SATURATION_TOPOLOGIES.length)
  assert.deepEqual([...new Set(report.scenarios.map((scenario) => scenario.topology))].sort(), [...SATURATION_TOPOLOGIES].sort())
  assert.equal(validateSaturationReport(report, {
    expectedCommit: 'a'.repeat(40),
    expectedImageDigest: `sha256:${'b'.repeat(64)}`
  }).valid, true)
})

test('synthetic, stale, wrong-SHA and wrong-image reports are rejected', () => {
  const report = buildSaturationReport({ identity: identity(), measurements: completeMeasurements() })
  const synthetic = structuredClone(report)
  synthetic.evidenceKind = 'synthetic'
  assert.match(validateSaturationReport(synthetic).errors.join('\n'), /evidenceKind=real/u)
  assert.match(validateSaturationReport(report, { expectedCommit: '2'.repeat(40) }).errors.join('\n'), /current commit/u)
  assert.match(validateSaturationReport(report, { expectedImageDigest: `sha256:${'3'.repeat(64)}` }).errors.join('\n'), /selected image/u)
  const staleNow = Date.parse(report.identity.capturedAt) + DEFAULT_SATURATION_POLICY.maximumEvidenceAgeMs + 1
  assert.match(validateSaturationReport(report, { now: staleNow }).errors.join('\n'), /stale/u)
})

test('tampered identity, policy and hand-written conclusions are rejected', () => {
  const report = buildSaturationReport({ identity: identity(), measurements: completeMeasurements() })
  const identityTamper = structuredClone(report)
  identityTamper.identity.hardware.cpuModel = 'Different CPU'
  assert.match(validateSaturationReport(identityTamper).errors.join('\n'), /identityDigest/u)

  const policyTamper = structuredClone(report)
  policyTamper.policy.maximumErrorRate = 1
  assert.match(validateSaturationReport(policyTamper).errors.join('\n'), /authoritative perf policy/u)

  const conclusionTamper = structuredClone(report)
  conclusionTamper.scenarios[0].conclusion.safeOperatingRps += 1
  assert.match(validateSaturationReport(conclusionTamper).errors.join('\n'), /recomputed measurements/u)
})

test('open-loop and system metrics merge only with exact route, topology and sample identity', () => {
  const load = {
    schema: 'fsusblog.open-loop-load.v2',
    arrivalModel: 'open-loop-fixed-rate',
    routeId: SATURATION_ROUTES[0],
    topology: SATURATION_TOPOLOGIES[0],
    samples: [{
      ...saturationSamples()[0],
      resourceSaturation: undefined,
      metrics: undefined,
      generator: { cpuPercent: 12, scheduleLagP99Ms: 0.4, droppedArrivals: 0 }
    }]
  }
  const systemMetrics = {
    schema: 'fsusblog.saturation-system-metrics.v2',
    routeId: load.routeId,
    topology: load.topology,
    samples: [{
      offeredRps: load.samples[0].offeredRps,
      repeat: load.samples[0].repeat,
      resourceSaturation: saturationSamples()[0].resourceSaturation,
      metrics: metrics(),
      window: { startedAt: '2026-07-14T00:00:00Z', endedAt: '2026-07-14T00:00:30Z' }
    }]
  }
  const sourceDigests = {
    load: `sha256:${'6'.repeat(64)}`,
    systemMetrics: `sha256:${'7'.repeat(64)}`
  }
  const merged = mergeSaturationMeasurement(load, systemMetrics, sourceDigests)
  assert.equal(merged.samples[0].metrics.loadGenerator.cpuPercent, 12)
  assert.equal(merged.samples[0].sourceDigests.load, sourceDigests.load)
  assert.equal(merged.samples[0].generator, undefined)
  assert.throws(
    () => mergeSaturationMeasurement(load, { ...systemMetrics, topology: SATURATION_TOPOLOGIES[1] }),
    /route\/topology identity/u
  )
  const wrongWindow = structuredClone(systemMetrics)
  wrongWindow.samples[0].window.startedAt = '2026-07-14T00:01:00Z'
  wrongWindow.samples[0].window.endedAt = '2026-07-14T00:01:30Z'
  assert.throws(() => mergeSaturationMeasurement(load, wrongWindow), /windows do not match/u)
})

test('identity rejects overlapping affinity, malformed digests and non-positive fixture sizes', () => {
  const report = buildSaturationReport({ identity: identity(), measurements: completeMeasurements() })
  const overlap = structuredClone(report)
  overlap.identity.loadGenerator.cpuAffinity = '4-11'
  overlap.identityDigest = 'invalidated'
  assert.match(validateSaturationReport(overlap).errors.join('\n'), /CPU affinity must be isolated/u)

  const malformed = identity()
  malformed.proxy.configDigest = 'not-a-digest'
  malformed.fixture.articleCount = 0
  assert.throws(
    () => buildSaturationReport({ identity: malformed, measurements: completeMeasurements() }),
    /proxy\.configDigest must be a sha256 digest.*fixture\.articleCount must be a positive integer/us
  )
})
