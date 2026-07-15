import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  cleanupLocalRuntime,
  cleanupStaleLocalRuntimes,
  isOrphanProductionViteProcess,
  isStaleSchemaContainer
} from '../../tools/test-matrix/local-runtime-cleanup.mjs'
import {
  createResidentLeaseInventory,
  writeResidentLeaseDocument
} from '../../tools/test-matrix/resident-resource-leases.mjs'

function schemaContainer(name, {
  created = '2026-07-12T00:00:00.000Z',
  labels = {},
  image = 'postgres:18-alpine',
  hostIp = '127.0.0.1',
  binds = null
} = {}) {
  return {
    Name: `/${name}`,
    Created: created,
    Path: 'docker-entrypoint.sh',
    Args: ['postgres'],
    Config: {
      Image: image,
      Env: ['POSTGRES_USER=postgres', 'POSTGRES_PASSWORD=postgres', 'POSTGRES_DB=postgres'],
      Labels: labels
    },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { '5432/tcp': [{ HostIp: hostIp, HostPort: '' }] },
      Binds: binds
    },
    State: { Running: true }
  }
}

test('default container cleanup removes anonymous test volumes with the container', () => {
  const source = fs.readFileSync('tools/test-matrix/local-runtime-cleanup.mjs', 'utf8')
  assert.match(source, /spawnSync\('docker', \['rm', '--force', '--volumes', name\]/u)
  assert.match(source, /process\.kill\(-pid, 'SIGTERM'\)/u)
  const fixture = fs.readFileSync('tests/backend/Fixtures/PostgresSchemaMigrationFixture.cs', 'utf8')
  assert.match(fixture, /com\.fsusblog\.test\.kind=schema-migration/u)
  assert.match(fixture, /com\.fsusblog\.test\.owner-pid=\{Environment\.ProcessId\}/u)
  assert.match(fixture, /com\.fsusblog\.test\.run-id=\{testRunId\}/u)
})

test('orphan Vite discovery requires a dead canonical production owner and exact repo command binding', () => {
  const root = '/repo'
  const runId = 'production-2026-07-12_12-44-12-568-82962'
  const record = {
    pid: 900,
    ppid: 1,
    startTimeTicks: '1234',
    cwd: '/repo/src/frontend',
    args: ['/usr/bin/node', '/repo/src/frontend/node_modules/.bin/vite', 'preview', '--host', '0.0.0.0', '--port', '29560', '--strictPort'],
    env: {
      FSUSBLOG_TEST_RUN_ID: runId,
      FSUSBLOG_TEST_NAMESPACE: `${runId}-fresh-local-production-0`,
      FSUSBLOG_RELEASE_PREVIEW_PORT: '29560',
      FSUSBLOG_DEBUG_FRONTEND_PORT: '26877'
    }
  }
  assert.equal(isOrphanProductionViteProcess(record, { root, processExists: () => false }), true)
  assert.equal(isOrphanProductionViteProcess({ ...record, ppid: 42 }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({ ...record, cwd: '/other/src/frontend' }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({
    ...record,
    env: { ...record.env, FSUSBLOG_TEST_RUN_ID: 'production-manual-82962' }
  }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess({
    ...record,
    env: { ...record.env, FSUSBLOG_RELEASE_PREVIEW_PORT: '29561' }
  }, { root, processExists: () => false }), false)
  assert.equal(isOrphanProductionViteProcess(record, { root, processExists: (pid) => pid === 82962 }), false)
})

test('schema cleanup accepts dead labeled owners and only the exact aged unlabeled legacy shape', () => {
  const labeled = schemaContainer('fsus-pg-bp-0123456789-m-4321-deadbeef', {
    labels: {
      'com.fsusblog.test.kind': 'schema-migration',
      'com.fsusblog.test.owner-pid': '4321',
      'com.fsusblog.test.run-id': 'production-run'
    }
  })
  assert.equal(isStaleSchemaContainer(labeled, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: () => false
  }), true)
  assert.equal(isStaleSchemaContainer(labeled, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: (pid) => pid === 4321
  }), false)

  const transitional = schemaContainer('fsus-pg-bp-0123456789-m-4321-deadbeef')
  assert.equal(isStaleSchemaContainer(transitional, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: () => false
  }), true)
  assert.equal(isStaleSchemaContainer(transitional, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    processExists: (pid) => pid === 4321
  }), false)

  const legacy = schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9')
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000
  }), true)
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T00:05:00Z'),
    legacyMinimumAgeMs: 600_000
  }), false)
  assert.equal(isStaleSchemaContainer(legacy, {
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    legacyMinimumAgeMs: 600_000,
    activeBackendTesthost: true
  }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsusblog-dev-postgres'), {
    nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000
  }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9', {
    hostIp: '0.0.0.0'
  }), { nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000 }), false)
  assert.equal(isStaleSchemaContainer(schemaContainer('fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9', {
    labels: { owner: 'unknown' }
  }), { nowMs: Date.parse('2026-07-12T01:00:00Z'), legacyMinimumAgeMs: 600_000 }), false)
})

test('untracked cleanup removes only classified orphan processes and schema containers', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-untracked-cleanup-'))
  const orphan = { pid: 900, startTimeTicks: '1234', args: [], env: {} }
  const staleName = 'fsus-schema-migration-8ec9a51537824309ac57ffc72ef4b0f9'
  const retainedName = 'fsusblog-dev-postgres'
  const killed = []
  const removed = []
  const result = cleanupStaleLocalRuntimes({
    root,
    discoverUntracked: true,
    legacyContainerMinimumAgeMs: 600_000,
    orphanTerminationGraceMs: 3_000,
    nowMs: Date.parse('2026-07-12T01:00:00Z'),
    discoverOrphanProcesses: () => [orphan],
    killOrphanProcess: (record, graceMs) => { killed.push([record.pid, graceMs]); return true },
    listSchemaContainers: () => [staleName, retainedName],
    inspectContainer: (name) => name === staleName ? schemaContainer(staleName) : schemaContainer(retainedName),
    detectActiveBackendTesthost: () => false,
    removeContainer: (name) => removed.push(name)
  })
  assert.deepEqual(killed, [[900, 3_000]])
  assert.deepEqual(removed, [staleName])
  assert.deepEqual(result.orphanProcesses, [900])
  assert.deepEqual(result.untrackedContainers, [staleName])
  assert.deepEqual(result.terminatedPids, [900])
  assert.deepEqual(result.removedContainers, [staleName])
  fs.rmSync(root, { recursive: true, force: true })
})

test('cleanupStaleLocalRuntimes discovers tracked namespaces before fresh output deletion', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-stale-runtime-cleanup-'))
  for (const namespace of ['production-old-a', 'production-old-b']) {
    const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
    const envDir = path.join(root, '.tmp/env')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.mkdirSync(envDir, { recursive: true })
    fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${namespace.endsWith('a') ? 101 : 202}\n`)
    fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
      `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
      `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`
    ].join('\n'))
  }

  const removedContainers = []
  const terminatedPids = []
  const result = cleanupStaleLocalRuntimes({
    root,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: (pid) => { terminatedPids.push(pid); return true }
  })

  assert.deepEqual(result.namespaces, ['production-old-a', 'production-old-b'])
  assert.deepEqual(terminatedPids, [101, 202])
  assert.deepEqual(removedContainers, [
    'fsusblog-test-postgres-production-old-a',
    'fsusblog-test-redis-production-old-a',
    'fsusblog-test-postgres-production-old-b',
    'fsusblog-test-redis-production-old-b'
  ])
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-a')), false)
  assert.equal(fs.existsSync(path.join(root, '.tmp/acceptance/production-old-b')), false)
})

test('default stale cleanup refuses a reused pid that is not a managed acceptance command', () => {
  if (process.platform === 'win32') return
  const root = process.cwd()
  const namespace = `reused-pid-${process.pid}`
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), `${process.pid}\n`)

  const result = cleanupLocalRuntime({ root, namespace })

  assert.deepEqual(result.terminatedPids, [])
})

test('cleanupLocalRuntime removes only containers and process state owned by its namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-42'
  const envDir = path.join(root, '.tmp/env')
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  fs.mkdirSync(envDir, { recursive: true })
  for (const directory of [runtimeDir, fixtureDir, dataDir]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'fixture'), 'fixture')
  }
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '999999\n')
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    `FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-test-postgres-${namespace}`,
    `FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-${namespace}`,
    'FSUSBLOG_DEBUG_BACKEND_URL=http://127.0.0.1:40000'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [
    `fsusblog-test-postgres-${namespace}`,
    `fsusblog-test-redis-${namespace}`
  ])
  assert.deepEqual(result.removedContainers, removedContainers)
  assert.equal(fs.existsSync(path.join(envDir, `${namespace}.env`)), false)
  assert.equal(fs.existsSync(runtimeDir), false)
  assert.equal(fs.existsSync(fixtureDir), false)
  assert.equal(fs.existsSync(dataDir), false)
})

test('cleanupLocalRuntime refuses container names not derived from the current namespace', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-cleanup-'))
  const namespace = 'production-run-43'
  const envDir = path.join(root, '.tmp/env')
  fs.mkdirSync(envDir, { recursive: true })
  fs.writeFileSync(path.join(envDir, `${namespace}.env`), [
    'FSUSBLOG_POSTGRES_CONTAINER_NAME=fsusblog-dev-postgres',
    'FSUSBLOG_REDIS_CONTAINER_NAME=fsusblog-test-redis-other-run'
  ].join('\n'))

  const removedContainers = []
  const result = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: (name) => removedContainers.push(name),
    killProcess: () => false
  })

  assert.deepEqual(removedContainers, [])
  assert.deepEqual(result.skippedContainers, ['fsusblog-dev-postgres', 'fsusblog-test-redis-other-run'])
})

test('cleanupLocalRuntime retains recovery handles until resident identities are confirmed exited', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'fsusblog-local-runtime-resident-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const namespace = 'production-resident-retry'
  const runId = 'resident-cleanup-run'
  const envFile = path.join(root, '.tmp/env', `${namespace}.env`)
  const runtimeDir = path.join(root, '.tmp/acceptance', namespace)
  const fixtureDir = path.join(root, '.tmp/fixtures', namespace)
  const dataDir = path.join(root, '.tmp/data', namespace)
  const runDir = path.join(root, '.tmp/test-runs', runId)
  for (const directory of [path.dirname(envFile), runtimeDir, fixtureDir, dataDir, runDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(envFile, `FSUSBLOG_TEST_RUN_ID=${runId}\n`)
  fs.writeFileSync(path.join(runtimeDir, 'backend.pid'), '4242\n')
  fs.writeFileSync(path.join(fixtureDir, 'fixture'), 'fixture')
  fs.writeFileSync(path.join(dataDir, 'state'), 'state')
  const inventory = createResidentLeaseInventory({
    runId,
    namespace,
    ownerBundleId: 'runtime-browser',
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 },
    services: [{
      id: 'debug-backend',
      kind: 'process',
      identity: { pid: 4242, startTimeTicks: '100' },
      port: 24001,
      generation: 'backend-1',
      health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' },
      observedRssBytes: 1024
    }]
  })
  const inventoryFile = path.join(runDir, 'resident-resource-leases.json')
  const checkpointFile = path.join(runDir, 'checkpoint.json')
  writeResidentLeaseDocument(inventoryFile, inventory)
  writeResidentLeaseDocument(checkpointFile, {
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    residentResourceLeases: {
      status: 'handed-off',
      inventoryFile: `.tmp/test-runs/${runId}/resident-resource-leases.json`,
      reservation: inventory.reservation,
      services: {},
      events: []
    }
  })

  const retained = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: () => {},
    killProcess: () => true,
    observeResidentService: () => ({ status: 'unknown', reason: 'termination-pending' }),
    residentCleanupTimeoutMs: 0
  })
  assert.equal(retained.residentResourceLeases.status, 'cleanup-pending-live-services')
  assert.equal(retained.retainedRuntimeState, true)
  assert.equal(fs.existsSync(envFile), true)
  assert.equal(fs.existsSync(runtimeDir), true)
  assert.equal(fs.existsSync(fixtureDir), true)
  assert.equal(fs.existsSync(dataDir), true)

  const released = cleanupLocalRuntime({
    root,
    namespace,
    removeContainer: () => {},
    killProcess: () => true,
    observeResidentService: () => ({ status: 'exited' }),
    residentCleanupTimeoutMs: 0
  })
  assert.equal(released.residentResourceLeases.status, 'released')
  assert.equal(released.retainedRuntimeState, false)
  assert.equal(fs.existsSync(envFile), false)
  assert.equal(fs.existsSync(runtimeDir), false)
  assert.equal(fs.existsSync(fixtureDir), false)
  assert.equal(fs.existsSync(dataDir), false)
})
