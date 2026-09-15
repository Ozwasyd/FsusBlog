import assert from 'node:assert/strict'
import test from 'node:test'

import { telemetryScenarioInternals } from '../../tools/test/runtime-cache-scenarios/telemetry.mjs'

test('telemetry scenario partitions all requests into real hit, miss and decode-error probes', () => {
  const layout = telemetryScenarioInternals.specsFor({ requests: 1000 }, 'run-1')
  assert.equal(layout.specs.length, 1000)
  assert.equal(layout.hitCount + layout.missCount + layout.errorCount, 1000)
  assert.equal(layout.specs.filter((item) => item.subcaseId === 'miss').length, layout.missCount)
  assert.equal(layout.specs.filter((item) => item.subcaseId === 'error').length, layout.errorCount)
  assert.ok(layout.specs.some((item) => item.subcaseId === 'unsampled-l1-hit'))
  assert.ok(layout.specs.some((item) => item.subcaseId === 'exact-hit-count'))
})

test('telemetry scenario computes miss and error evidence from production counter snapshots', () => {
  const before = { operations: [
    { operation: 'get', layer: 'l2', result: 'miss', count: 4 },
    { operation: 'get', layer: 'l1', result: 'decode_failed', count: 2 }
  ] }
  const after = { operations: [
    { operation: 'get', layer: 'l2', result: 'miss', count: 54 },
    { operation: 'get', layer: 'l1', result: 'decode_failed', count: 52 }
  ] }
  assert.equal(telemetryScenarioInternals.delta(after, before, 'get', 'l2', 'miss'), 50)
  assert.equal(telemetryScenarioInternals.delta(after, before, 'get', 'l1', 'decode_failed'), 50)
})
