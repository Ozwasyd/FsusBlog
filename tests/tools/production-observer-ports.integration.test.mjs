import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { observePostgresqlState, observeRedisState } from '../../tools/test-fixtures/observers/postgres-redis.mjs'
import {
  createDockerPostgresqlReadonlyPort,
  createDockerRedisReadonlyPort
} from '../../tools/test-runtime/production-observer-ports.mjs'
import { runtimeIdentity } from './support/runtime-state-fixture.mjs'

function docker(container, ...args) {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

test('production PostgreSQL and Redis ports observe real session state without writes', async (t) => {
  const postgresContainer = process.env.FSUSBLOG_RUNTIME_ORDER_TEST_POSTGRES ?? 'fsusblog-dev-postgres'
  const redisContainer = process.env.FSUSBLOG_RUNTIME_ORDER_TEST_REDIS ?? 'fsusblog-dev-redis'
  const suffix = `${process.pid}`
  const table = `runtime_order_port_${suffix}`
  const redisPrefix = `FsusBlog_runtime_order_${suffix}:`
  const redisKey = `${redisPrefix}sample`
  docker(postgresContainer, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-c',
    `CREATE TABLE ${table} (id integer PRIMARY KEY, payload jsonb NOT NULL); INSERT INTO ${table} VALUES (2, '{"b":2}'), (1, '{"a":1}');`)
  docker(redisContainer, 'redis-cli', 'SET', redisKey, 'value', 'PX', '600000')
  t.after(() => {
    docker(postgresContainer, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-c', `DROP TABLE IF EXISTS ${table};`)
    docker(redisContainer, 'redis-cli', 'DEL', redisKey)
  })
  const identity = runtimeIdentity()
  const owner = (domain) => ({ runId: identity.runId, attemptId: identity.attemptId, sessionId: identity.sessionId, domain })
  const postgresDomain = 'postgres.article'
  const redisDomain = 'redis.cache.public'
  const fixedClock = { epochMs: 1700000000000, digest: identity.clockDigest }
  const postgres = await observePostgresqlState({
    domain: postgresDomain,
    identity,
    context: {
      handles: {
        [postgresDomain]: {
          owner: owner(postgresDomain),
          catalogDigest: identity.catalogDigest,
          namespace: `postgres-${suffix}`,
          schema: 'public',
          table,
          primaryKey: ['id'],
          semanticClockColumns: []
        }
      },
      ports: { postgresql: createDockerPostgresqlReadonlyPort({ container: postgresContainer }) }
    }
  })
  const redis = await observeRedisState({
    domain: redisDomain,
    identity,
    context: {
      fixedClock,
      handles: {
        [redisDomain]: {
          owner: owner(redisDomain),
          catalogDigest: identity.catalogDigest,
          namespace: `redis-${suffix}`,
          namespacePrefix: redisPrefix,
          keyPattern: `${redisPrefix}*`
        }
      },
      ports: { redis: createDockerRedisReadonlyPort({ container: redisContainer, fixedClock }) }
    }
  })
  assert.deepEqual(postgres.semantic.rows.map((row) => row.values.id), [1, 2])
  assert.equal(postgres.sideEffects.writes, 0)
  assert.equal(redis.semantic.entries.length, 1)
  assert.equal(redis.semantic.entries[0].value, 'value')
  assert.equal(redis.sideEffects.writes, 0)
  assert.equal(docker(postgresContainer, 'psql', '-X', '-U', 'fsusblog', '-d', 'fsusblog', '-Atqc', `SELECT count(*) FROM ${table};`), '2')
  assert.equal(docker(redisContainer, 'redis-cli', 'GET', redisKey), 'value')
})
