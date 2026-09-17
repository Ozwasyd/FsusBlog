import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  classifyProfile,
  experimentProfiles,
  parseArguments,
  percentile,
  summarizeSamples
} from '../../tools/frontend/run-scheduler-yield-experiment.mjs'

const execFileAsync = promisify(execFile)

test('defines only condition-named profiles with exact CPU throttles', () => {
  assert.deepEqual(experimentProfiles.map(profile => [profile.name, profile.cpuRate]), [
    ['desktop-baseline-1x', 1],
    ['mobile-medium-4x', 4],
    ['mobile-slow-6x', 6]
  ])
  assert.equal(experimentProfiles.some(profile => /pixel|android|iphone/iu.test(profile.name)), false)
})

test('calculates distribution percentiles without selecting a best run', () => {
  assert.equal(percentile([10, 20, 30, 40, 50], 0.75), 40)
  const summary = summarizeSamples([10, 20, 30, 40, 50].map(value => ({
    probeInputDelayMs: value,
    totalDurationMs: value * 2,
    longTaskBlockingMs: value / 2,
    taskDurationMs: value,
    scriptDurationMs: value,
    heapDeltaBytes: value,
    yieldCount: value,
    eventTimingSamples: 1
  })))
  assert.equal(summary.rounds, 5)
  assert.equal(summary.probeInputDelayMs.p50, 30)
  assert.equal(summary.probeInputDelayMs.p95, 48)
  assert.equal(summary.probeInputDelayMs.minimum, 10)
  assert.equal(summary.probeInputDelayMs.maximum, 50)
  assert.equal(Math.round(summary.probeInputDelayMs.standardDeviation), 14)
  assert.equal(summary.eventTiming.samples, 0)
})

test('classifies tradeoffs without claiming a real device or enabling production', () => {
  const metric = value => ({ p50: value, p75: value, p95: value })
  const control = { probeInputDelayMs: metric(100), longTaskBlockingMs: metric(80), totalDurationMs: metric(100) }
  const candidate = { probeInputDelayMs: metric(20), longTaskBlockingMs: metric(10), totalDurationMs: metric(120) }
  assert.deepEqual(classifyProfile(control, candidate), {
    inputImproved: true,
    blockingImproved: true,
    totalWithinTradeoff: true,
    outcome: 'promising-local-fixture'
  })

  const zeroBlocking = { ...control, longTaskBlockingMs: metric(0) }
  assert.equal(classifyProfile(zeroBlocking, { ...candidate, longTaskBlockingMs: metric(0) }).blockingImproved, false)
})

test('rejects invalid run counts', () => {
  assert.throws(() => parseArguments(['--rounds', '1']), /3 through 20/u)
  assert.equal(parseArguments(['--rounds', '7']).rounds, 7)
})

test('runs the static scheduler.yield ownership gate', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['tests/frontend/checks/static/check-browser-task-scheduler.mjs'])
  assert.match(stdout, /no production call sites/u)
})
