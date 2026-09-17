import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertLoopbackOrigin,
  buildAuthenticatedScanPlan,
  evaluateScanStatus,
  resolveAuthenticatedDastEnvironment,
  runAuthenticatedDast
} from '../../tools/security/run-authenticated-dast.mjs'

test('authenticated DAST accepts only loopback origins', () => {
  assert.equal(assertLoopbackOrigin('http://127.0.0.1:7568', 'backend'), 'http://127.0.0.1:7568')
  assert.equal(assertLoopbackOrigin('https://localhost:7443', 'backend'), 'https://localhost:7443')
  assert.throws(() => assertLoopbackOrigin('https://fsus.blog', 'backend'), /non-loopback-target/u)
  assert.throws(() => assertLoopbackOrigin('http://127.0.0.1:7568/api', 'backend'), /must-be-origin-only/u)
})

test('authenticated DAST loads the current namespace runtime without shell-sourcing secrets', () => {
  const resolved = resolveAuthenticatedDastEnvironment({ FSUSBLOG_TEST_NAMESPACE: 'focused-runtime' }, (_root, namespace) => {
    assert.equal(namespace, 'focused-runtime')
    return {
      FSUSBLOG_TEST_NAMESPACE: namespace,
      FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:7568',
      FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:3000',
      FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-test-focused-pg',
      FSUSBLOG_REDIS_CONTAINER_NAME: 'fsusblog-test-focused-redis',
      Jwt__SecretKey: 'test-secret'
    }
  })
  assert.equal(resolved.FSUSBLOG_BASE_URL, 'http://127.0.0.1:7568')
  assert.equal(resolved.PLAYWRIGHT_BASE_URL, 'http://127.0.0.1:3000')
  assert.equal(resolved.FSUSBLOG_PG_CONTAINER, 'fsusblog-test-focused-pg')
  assert.equal(resolved.FSUSBLOG_REDIS_CONTAINER, 'fsusblog-test-focused-redis')
  assert.equal(resolved.Jwt__SecretKey, 'test-secret')
})

test('authenticated DAST plan actively covers all four identities and mutation families', () => {
  const plan = buildAuthenticatedScanPlan()
  assert.deepEqual(plan.map((entry) => entry.context), ['anonymous', 'user', 'admin', 'author-console'])
  assert.equal(plan.flatMap((entry) => entry.checks).length, 15)
  assert.ok(plan.flatMap((entry) => entry.checks).some((entry) => entry.method !== 'GET'))
  assert.ok(plan.flatMap((entry) => entry.checks).some((entry) => entry.headers?.Origin === 'https://attacker.invalid'))
  assert.ok(plan.flatMap((entry) => entry.checks).some((entry) => entry.path.includes('keyword=')))
})

test('authenticated DAST status expectations fail closed', () => {
  assert.equal(evaluateScanStatus(200, 'allowed'), true)
  assert.equal(evaluateScanStatus(403, 'denied'), true)
  assert.equal(evaluateScanStatus(500, 'denied'), false)
  assert.equal(evaluateScanStatus(499, 'no-server-error'), true)
  assert.equal(evaluateScanStatus(500, 'no-server-error'), false)
})

function fakeRequestApi({ failCheck = false } = {}) {
  return {
    async newContext(options) {
      const cookie = options.extraHTTPHeaders?.Cookie ?? ''
      const state = cookie.includes('__Host-AdminAccessToken=')
        ? 'admin.storage-state.json'
        : cookie.includes('__Host-AccessToken=')
          ? 'user.storage-state.json'
          : 'anonymous'
      return {
        async fetch(requestPath, requestOptions) {
          let status = 200
          if (requestOptions.method !== 'GET' && requestOptions.headers?.Origin === 'https://attacker.invalid') status = 403
          else if (state === 'anonymous') status = 401
          else if (state === 'user.storage-state.json' && (requestPath.includes('/admin/') || requestPath.includes('/author/'))) status = 403
          else if (state === 'admin.storage-state.json' && requestPath === '/api/binary/auth/me') status = 401
          if (failCheck && requestPath.includes('/api/binary/admin/users')) status = 500
          return { status: () => status, async dispose() {} }
        },
        async dispose() {}
      }
    }
  }
}

async function createFreshFixture(env) {
  assert.equal(env.FSUSBLOG_PG_CONTAINER, 'fsusblog-test-postgres-production-fresh-test')
  assert.equal(env.FSUSBLOG_REDIS_CONTAINER, 'fsusblog-test-redis-production-fresh-test')
  const authDirectory = path.join(env.FSUSBLOG_FIXTURE_ROOT, 'auth')
  await mkdir(authDirectory, { recursive: true, mode: 0o700 })
  await chmod(authDirectory, 0o700)
  const storageState = { cookies: [], origins: [] }
  for (const [file, cookieName] of [
    ['user.storage-state.json', '__Host-AccessToken'],
    ['admin.storage-state.json', '__Host-AdminAccessToken']
  ]) {
    const scopedStorageState = {
      ...storageState,
      cookies: [{ name: cookieName, value: `${cookieName}-value`, url: env.PLAYWRIGHT_BASE_URL }]
    }
    await writeFile(path.join(authDirectory, file), `${JSON.stringify(scopedStorageState)}\n`, { mode: 0o600 })
    await chmod(path.join(authDirectory, file), 0o600)
  }
  await writeFile(path.join(authDirectory, 'auth-fixtures.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl: env.PLAYWRIGHT_BASE_URL,
    user: { storageStateFile: 'user.storage-state.json' },
    admin: { storageStateFile: 'admin.storage-state.json' }
  })}\n`, { mode: 0o600 })
}

test('authenticated DAST emits authoritative fresh evidence and aggregates all failures', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-authenticated-dast-'))
  try {
    const fixtureRoot = path.join(temp, 'fixtures')
    const outputDirectory = path.join(temp, 'evidence')
    const env = {
      FSUSBLOG_TEST_NAMESPACE: 'production-fresh-test',
      FSUSBLOG_FIXTURE_ROOT: fixtureRoot,
      FSUSBLOG_BASE_URL: 'http://127.0.0.1:7568',
      FSUSBLOG_DEBUG_BACKEND_URL: 'http://127.0.0.1:7569',
      PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3000',
      FSUSBLOG_DEBUG_FRONTEND_URL: 'http://127.0.0.1:3001',
      FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-test-postgres-production-fresh-test',
      FSUSBLOG_REDIS_CONTAINER_NAME: 'fsusblog-test-redis-production-fresh-test'
    }
    const success = await runAuthenticatedDast({
      env,
      requestApi: fakeRequestApi(),
      prepareFixtures: createFreshFixture,
      outputDirectory
    })
    assert.equal(success.status, 'ok')
    assert.equal(success.executionSource, 'fresh-current-lane')
    assert.equal(success.fixture.historicalStateAccepted, false)
    assert.equal(success.fixture.cleanup, 'success')
    assert.equal(success.activeScan.executed, true)
    assert.equal(success.activeScan.requestCount, 15)
    assert.equal(success.activeScan.failedCount, 0)
    assert.equal(success.targetPolicy.backendOrigin, env.FSUSBLOG_DEBUG_BACKEND_URL)
    assert.equal(success.targetPolicy.frontendOrigin, env.FSUSBLOG_DEBUG_FRONTEND_URL)
    assert.ok(Object.values(success.contexts).every((entry) => entry.executed))

    const failure = await runAuthenticatedDast({
      env,
      requestApi: fakeRequestApi({ failCheck: true }),
      prepareFixtures: createFreshFixture,
      outputDirectory
    })
    assert.equal(failure.status, 'failure')
    assert.equal(failure.activeScan.requestCount, 15)
    assert.equal(failure.failureCategory, 'active-scan-check-failed')
    assert.ok(failure.failedChecks.length >= 1)
    assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, 'summary.json'), 'utf8')), failure)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
