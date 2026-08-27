import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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

function startContainer(name, image, args) {
  execFileSync('docker', ['run', '--detach', '--name', name, ...args, image], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  })
}

function waitFor(container, ...args) {
  let consecutiveSuccesses = 0
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync('docker', ['exec', container, ...args], { stdio: 'ignore' }).status === 0) {
      consecutiveSuccesses += 1
      if (consecutiveSuccesses === 3) return
    } else {
      consecutiveSuccesses = 0
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  throw new Error(`${container} did not become ready`)
}

test('production PostgreSQL and Redis ports observe real session state without writes', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`
  const externalPostgres = String(process.env.FSUSBLOG_RUNTIME_ORDER_TEST_POSTGRES ?? '').trim()
  const externalRedis = String(process.env.FSUSBLOG_RUNTIME_ORDER_TEST_REDIS ?? '').trim()
  const postgresContainer = externalPostgres || `fsusblog-test-runtime-order-postgres-${suffix}`
  const redisContainer = externalRedis || `fsusblog-test-runtime-order-redis-${suffix}`
  if (!externalPostgres) {
    startContainer(postgresContainer,
      'postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
      ['--env', 'POSTGRES_DB=fsusblog', '--env', 'POSTGRES_USER=fsusblog', '--env', 'POSTGRES_PASSWORD=fsusblog_dev'])
    t.after(() => execFileSync('docker', ['rm', '--force', postgresContainer], { stdio: 'ignore' }))
    waitFor(postgresContainer, 'psql', '-X', '-U', 'fsusblog', '-d', 'fsusblog', '-Atqc', 'SELECT 1;')
  }
  if (!externalRedis) {
    startContainer(redisContainer,
      'redis@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf', [])
    t.after(() => execFileSync('docker', ['rm', '--force', redisContainer], { stdio: 'ignore' }))
    waitFor(redisContainer, 'redis-cli', 'ping')
  }
  const table = `runtime_order_port_${suffix.replaceAll('-', '_')}`
  const redisPrefix = `FsusBlog_runtime_order_${suffix}:`
  const redisKey = `${redisPrefix}fsus:blog:article-list:sample`
  docker(postgresContainer, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-c',
    `CREATE TABLE ${table} (id integer PRIMARY KEY, payload jsonb NOT NULL); INSERT INTO ${table} VALUES (2, '{"b":2}'), (1, '{"a":1}');`)
  docker(redisContainer, 'redis-cli', 'SET', redisKey, 'value', 'PX', '600000')
  t.after(() => {
    if (externalPostgres) {
      docker(postgresContainer, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fsusblog', '-d', 'fsusblog', '-c', `DROP TABLE IF EXISTS ${table};`)
    }
    if (externalRedis) docker(redisContainer, 'redis-cli', 'DEL', redisKey)
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
          keyPattern: `${redisPrefix}*|e2e:*`,
          keyPatterns: [`${redisPrefix}*`, 'e2e:*'],
          ownershipClass: 'dedicated-session-container'
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
