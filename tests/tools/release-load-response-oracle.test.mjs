import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAedsFrame } from '../../tests/frontend/support/aeds-envelope.mjs'
import { fetchRouteSample } from '../../tools/test/lanes/runtime-http-route-contract.mjs'
import { summarizeOpenLoopAttempts } from '../../tools/perf/performance-saturation-v2.mjs'

test('only contract-passing samples contribute latency percentiles and bind catalog identity', async () => {
  const replies = [
    new Response(encodeAedsFrame(13, new Uint8Array(16)), { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  ]; let index = 0
  const fetchImpl = async () => replies[index++]
  const samples = []
  samples.push(await fetchRouteSample({ routeId: 'system-seo', baseUrl: 'http://fixture', timeoutMs: 10, fetchImpl }))
  samples.push(await fetchRouteSample({ routeId: 'system-seo', baseUrl: 'http://fixture', timeoutMs: 10, fetchImpl }))
  const successLatencies = samples.filter((sample) => sample.ok).map((sample) => sample.latencyMs)
  assert.equal(successLatencies.length, 1)
  assert.equal(samples[1].failureKind, 'unexpected-content-type')
  assert.equal(samples[0].routeId, 'system-seo')
  assert.match(samples[0].contractDigest, /^sha256:[a-f0-9]{64}$/)
})
test('open-loop percentiles exclude completed failures', () => {
  const summary = summarizeOpenLoopAttempts({
    durationMs: 1000,
    attempts: [
      { completed: true, error: false, timeout: false, latencyMs: 10, scheduleLagMs: 0 },
      { completed: true, error: true, timeout: false, latencyMs: 9_999, scheduleLagMs: 0 }
    ]
  })
  assert.equal(summary.responseCount, 2)
  assert.equal(summary.p50Ms, 10)
  assert.equal(summary.p95Ms, 10)
  assert.equal(summary.p99Ms, 10)
})
