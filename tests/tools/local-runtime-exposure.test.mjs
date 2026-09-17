import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  assertLoopbackRuntimeOrigin,
  listenerAddressesForPort,
  runLocalRuntimeExposure,
  validateContainerBindings
} from '../../tools/security/check-local-runtime-exposure.mjs'

test('local runtime exposure accepts only explicit loopback port origins', () => {
  assert.deepEqual(assertLoopbackRuntimeOrigin('http://127.0.0.1:25001', 'backend'), {
    origin: 'http://127.0.0.1:25001', port: 25001
  })
  assert.throws(() => assertLoopbackRuntimeOrigin('http://0.0.0.0:25001', 'backend'), /not-loopback/u)
  assert.throws(() => assertLoopbackRuntimeOrigin('https://127.0.0.1:25001', 'backend'), /not-loopback-http/u)
})

test('local runtime exposure parses listener and container binding truth', () => {
  const listeners = 'LISTEN 0 511 127.0.0.1:25001 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:25002 0.0.0.0:*\n'
  assert.deepEqual(listenerAddressesForPort(listeners, 25001), ['127.0.0.1:25001'])
  assert.deepEqual(listenerAddressesForPort(listeners, 25002), ['0.0.0.0:25002'])
  assert.deepEqual(validateContainerBindings({
    '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '25004' }]
  }, 5432, 25004, 'postgres'), [])
  assert.deepEqual(validateContainerBindings({
    '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '25004' }]
  }, 5432, 25004, 'postgres'), ['postgres-binding-not-loopback'])
})

function headers(values = {}) {
  return { get: (name) => values[name.toLowerCase()] ?? null }
}

const goodHeaders = {
  'content-security-policy': "default-src 'self'",
  'permissions-policy': 'camera=()',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
}

test('production runtime DAG executes local exposure and release verification requires its fresh artifact', async () => {
  const bundleSteps = await readFile(new URL('../../tools/test/bundles/bundle-steps.mjs', import.meta.url), 'utf8')
  const releaseVerifier = await readFile(new URL('../../tools/operations/check-release-evidence-manifest.mjs', import.meta.url), 'utf8')

  assert.match(bundleSteps, /step\('local-runtime-exposure', 'node tools\/security\/check-local-runtime-exposure\.mjs'/u)
  assert.match(bundleSteps, /dependsOn: \['security-static', 'security-runtime-core', 'local-runtime-exposure', 'zap-baseline'\]/u)
  assert.match(releaseVerifier, /\['local runtime exposure',[\s\S]*localRuntimeExposureOk\(manifest, context\)/u)
  assert.match(releaseVerifier, /executionSource === 'fresh-loopback-runtime'/u)
})

function environment() {
  return {
    FSUSBLOG_TEST_NAMESPACE: 'production-fresh-test',
    FSUSBLOG_TEST_RUN_ID: 'production-fresh-test',
    FSUSBLOG_BASE_URL: 'http://127.0.0.1:25001',
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:25002',
    FSUSBLOG_RELEASE_PREVIEW_URL: 'http://127.0.0.1:25003',
    FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-test-pg',
    FSUSBLOG_REDIS_CONTAINER_NAME: 'fsusblog-test-redis',
    FSUSBLOG_POSTGRES_PORT: '25004',
    FSUSBLOG_REDIS_PORT: '25005'
  }
}

test('local runtime exposure writes current-run evidence and aggregates binding/header failures', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'fsusblog-local-exposure-'))
  const outputFile = path.join(temp, 'summary.json')
  const listeners = [25001, 25002, 25003].map((port) => `LISTEN 0 511 127.0.0.1:${port} 0.0.0.0:*`).join('\n')
  const bindings = async (container) => container.endsWith('-pg')
    ? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '25004' }] }
    : { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '25005' }] }
  try {
    const success = await runLocalRuntimeExposure({
      env: environment(),
      fetchImpl: async () => ({ status: 200, headers: headers(goodHeaders) }),
      readListeners: async () => listeners,
      inspectBindings: bindings,
      outputFile
    })
    assert.equal(success.status, 'ok')
    assert.equal(success.scope.countsAsProductionCloseout, false)
    assert.equal(success.failures.length, 0)
    assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), success)

    const failure = await runLocalRuntimeExposure({
      env: environment(),
      fetchImpl: async () => ({ status: 200, headers: headers({}) }),
      readListeners: async () => listeners.replace('127.0.0.1:25002', '0.0.0.0:25002'),
      inspectBindings: async (container) => container.endsWith('-pg')
        ? { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '25004' }] }
        : { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '25005' }] },
      outputFile
    })
    assert.equal(failure.status, 'failure')
    assert.ok(failure.failures.includes('frontend-listener-not-loopback'))
    assert.ok(failure.failures.includes('postgres-binding-not-loopback'))
    assert.equal(failure.failures.filter((item) => item.includes('-header-')).length, 5)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
