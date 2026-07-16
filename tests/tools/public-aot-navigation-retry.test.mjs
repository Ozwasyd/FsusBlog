import assert from 'node:assert/strict'
import test from 'node:test'

import {
  navigateThroughRetryablePublicAot,
  retryablePublicAotDelayMs
} from '../frontend/support/playwright/publicAotNavigationRetry.mjs'

function response(status, headers = {}) {
  return {
    status: () => status,
    headers: () => headers
  }
}

const retryableHeaders = {
  'retry-after': '5',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, follow',
  'x-fsus-public-aot-source': 'server-status',
  'x-fsus-public-aot-state': 'transient-failure'
}

test('public AOT retry delay comes from the complete server retry contract', () => {
  assert.equal(retryablePublicAotDelayMs(response(503, retryableHeaders)), 5_000)
  assert.equal(retryablePublicAotDelayMs(response(503, {
    ...retryableHeaders,
    'x-fsus-public-aot-state': 'gone'
  })), null)
  assert.equal(retryablePublicAotDelayMs(response(500, retryableHeaders)), null)
})

test('public AOT navigation retries only the cold response and uses Retry-After verbatim', async () => {
  let clockMs = 1_000
  const waits = []
  const retryObservations = []
  const responses = [response(503, retryableHeaders), response(200)]

  const result = await navigateThroughRetryablePublicAot({
    navigate: async () => responses.shift(),
    sleep: async (delayMs) => {
      waits.push(delayMs)
      clockMs += delayMs
    },
    onRetryableResponse: ({ response: retryResponse, retryDelayMs }) => {
      retryObservations.push([retryResponse.status(), retryDelayMs, waits.length])
    },
    deadlineAtMs: 20_000,
    now: () => clockMs
  })

  assert.equal(result.status(), 200)
  assert.deepEqual(waits, [5_000])
  assert.deepEqual(retryObservations, [[503, 5_000, 0]])
  assert.equal(responses.length, 0)
})

test('public AOT navigation does not retry unrelated service failures', async () => {
  let navigationCount = 0
  const result = await navigateThroughRetryablePublicAot({
    navigate: async () => {
      navigationCount += 1
      return response(503, { 'retry-after': '5' })
    },
    sleep: async () => assert.fail('unrelated 503 must not sleep'),
    deadlineAtMs: 20_000,
    now: () => 1_000
  })

  assert.equal(result.status(), 503)
  assert.equal(navigationCount, 1)
})

test('public AOT navigation cannot wait beyond its runtime-derived deadline', async () => {
  await assert.rejects(
    navigateThroughRetryablePublicAot({
      navigate: async () => response(503, retryableHeaders),
      sleep: async () => assert.fail('deadline exhaustion must not sleep'),
      deadlineAtMs: 5_000,
      now: () => 1_000
    }),
    /exceeds the runtime navigation deadline/u
  )
})
