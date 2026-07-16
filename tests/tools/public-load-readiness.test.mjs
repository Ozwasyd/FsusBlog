import assert from 'node:assert/strict'
import test from 'node:test'

import {
  matchesExpectedStatus,
  waitForReadyResponse
} from '../frontend/checks/load/loadReadiness.mjs'

function response(status, headers = {}) {
  return new Response(`status=${status}`, { status, headers })
}

test('public load readiness retries a transient AOT miss before measurement', async () => {
  const responses = [response(503, { 'Retry-After': '0.005' }), response(200)]
  const timeouts = []
  const logs = []
  let clockMs = 0
  const ready = await waitForReadyResponse(
    { name: 'public_home', url: 'http://example.test/' },
    {
      requestTimeoutMs: 100,
      fetchResponse: async (_url, _init, timeoutMs) => {
        timeouts.push(timeoutMs)
        return responses.shift()
      },
      sleep: async (delayMs) => { clockMs += delayMs },
      now: () => clockMs,
      log: (message) => logs.push(message)
    }
  )

  assert.equal(ready.status, 200)
  assert.deepEqual(timeouts, [100, 100])
  assert.deepEqual(logs, [
    '[check-load-public-api] ready: public_home attempts=2 statuses={"200":1,"503":1}'
  ])
})

test('public load readiness rejects a persistent transient status at its deadline', async () => {
  let clockMs = 0
  let attempts = 0
  await assert.rejects(
    waitForReadyResponse(
      { name: 'public_home', url: 'http://example.test/' },
      {
        requestTimeoutMs: 100,
        fetchResponse: async () => {
          attempts += 1
          return response(503)
        },
        sleep: async (delayMs) => { clockMs += delayMs },
        now: () => clockMs,
        log: () => {}
      }
    ),
    /readiness did not converge statuses=\{"503":4\}/u
  )
  assert.equal(attempts, 4)
})

test('public load readiness does not retry an unexpected server error', async () => {
  let attempts = 0
  await assert.rejects(
    waitForReadyResponse(
      { name: 'public_home', url: 'http://example.test/' },
      {
        requestTimeoutMs: 100,
        fetchResponse: async () => {
          attempts += 1
          return response(500)
        }
      }
    ),
    /unexpected status 500/u
  )
  assert.equal(attempts, 1)
})

test('public load readiness preserves explicit expected status contracts', async () => {
  const ready = await waitForReadyResponse(
    {
      name: 'public_search_extreme_query',
      url: 'http://example.test/search',
      expectedStatuses: [400]
    },
    {
      requestTimeoutMs: 100,
      fetchResponse: async () => response(400)
    }
  )
  assert.equal(matchesExpectedStatus(ready, [400]), true)
  assert.equal(matchesExpectedStatus(ready), false)
})
