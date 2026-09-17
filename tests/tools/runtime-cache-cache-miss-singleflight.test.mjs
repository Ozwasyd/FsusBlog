import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSingleFlightBurst } from '../../tools/test/runtime-cache-scenarios/cache-miss-singleflight.mjs'

const digest = (character) => `sha256:${character.repeat(64)}`

function burst(count, { duplicateRebuild = false, detachedDatabase = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const leader = index === 0
    const duplicate = duplicateRebuild && index === 1
    const rebuild = leader || duplicate
    return {
      id: `request-${index + 1}`,
      status: 200,
      payloadDigest: digest('a'),
      dbCommands: (leader && !detachedDatabase) || (detachedDatabase && index === 2)
        ? [{ fingerprint: digest('b'), source: 'npgsql-interceptor' }]
        : [],
      cacheEvents: rebuild
        ? [{ family: 'cache-miss-singleflight', identityDigest: digest('c'), outcome: 'built', sequence: 1, elapsedMilliseconds: 2 }]
        : [{ family: 'cache-miss-singleflight', identityDigest: digest('c'), outcome: 'hit', sequence: 1, elapsedMilliseconds: 2 }]
    }
  })
}

test('derives one DB-backed rebuild from request-bound events for 100 and 1000 callers', () => {
  for (const count of [100, 1000]) {
    assert.deepEqual(deriveSingleFlightBurst(burst(count)), {
      requestCount: count,
      successfulRequests: count,
      payloadDigestCount: 1,
      identityDigestCount: 1,
      rebuildCount: 1,
      databaseRequestCount: 1,
      databaseCommandCount: 1,
      leaderDatabaseBound: true
    })
  }
})

test('raw-event derivation exposes duplicate rebuilds and detached DB commands', () => {
  const duplicate = deriveSingleFlightBurst(burst(100, { duplicateRebuild: true }))
  assert.equal(duplicate.rebuildCount, 2)

  const detached = deriveSingleFlightBurst(burst(100, { detachedDatabase: true }))
  assert.equal(detached.rebuildCount, 1)
  assert.equal(detached.databaseRequestCount, 1)
  assert.equal(detached.leaderDatabaseBound, false)
})
