import assert from 'node:assert/strict'
import test from 'node:test'

import { digestCanonical } from '../../tools/test-fixtures/receipt/canonical.mjs'
import { observePostgresqlState, observeRedisState } from '../../tools/test-fixtures/observers/postgres-redis.mjs'
import { noSideEffects, runtimeIdentity } from './support/runtime-state-fixture.mjs'

const identity = runtimeIdentity()
const owner = (domain, namespace) => ({
  owner: { runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain },
  catalogDigest: identity.catalogDigest,
  namespace
})

test('PostgreSQL observer is row-order stable and type/null/content sensitive', async () => {
  const domain = 'postgres.article'
  const makeContext = (rows) => ({
    handles: { [domain]: owner(domain, 'pg-session') },
    ports: {
      postgresql: {
        readonly: true,
        async describeDomain() { return { readonly: true, namespace: 'pg-session', schema: 'public', table: 'articles', columns: [{ name: 'id', type: 'uuid', nullable: false }, { name: 'title', type: 'text', nullable: true }], primaryKey: ['id'], providerId: 'postgresql', providerVersion: '16' } },
        async *streamRows() { yield * rows.map((values) => ({ values })) },
        async readSideEffectCounters() { return noSideEffects() }
      }
    }
  })
  const first = await observePostgresqlState({ domain, identity, context: makeContext([{ id: '2', title: null }, { id: '1', title: 'a' }]) })
  const second = await observePostgresqlState({ domain, identity, context: makeContext([{ id: '1', title: 'a' }, { id: '2', title: null }]) })
  assert.equal(digestCanonical(first.semantic), digestCanonical(second.semantic))
  const changed = await observePostgresqlState({ domain, identity, context: makeContext([{ id: '1', title: 'changed' }, { id: '2', title: null }]) })
  assert.notEqual(digestCanonical(first.semantic), digestCanonical(changed.semantic))
})

test('Redis observer normalizes TTL to fixed clock and rejects clock drift', async () => {
  const domain = 'redis.cache.public'
  const makeContext = (entries, clock = identity.clockDigest) => ({
    handles: { [domain]: owner(domain, 'redis-session') },
    fixedClock: { epochMs: 1000, digest: identity.clockDigest },
    ports: {
      redis: {
        readonly: true,
        async describeDomain() { return { readonly: true, namespace: 'redis-session', clockDigest: clock, keyPattern: 'run:*', providerId: 'redis', providerVersion: '7' } },
        async *scanDomain() { yield * entries },
        async readSideEffectCounters() { return noSideEffects() }
      }
    }
  })
  const entries = [{ key: 'run:b', type: 'string', value: 'b', expiresAtEpochMs: 1500, generation: '1' }, { key: 'run:a', type: 'string', value: 'a', expiresAtEpochMs: 1500, generation: '1' }]
  const first = await observeRedisState({ domain, identity, context: makeContext(entries) })
  const second = await observeRedisState({ domain, identity, context: makeContext([...entries].reverse()) })
  assert.equal(digestCanonical(first.semantic), digestCanonical(second.semantic))
  assert.equal(first.semantic.entries[0].ttlMs, 500)
  await assert.rejects(observeRedisState({ domain, identity, context: makeContext(entries, 'sha256:' + 'f'.repeat(64)) }), /identity\/clock is stale/)
})
