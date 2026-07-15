import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import {
  bindResidentLeaseEnforcement,
  consumeResidentLeaseHandoff,
  consumeResidentLeaseHandoffFile,
  createResidentLeaseHandoff,
  createResidentLeaseInventory,
  finalizeResidentLeaseCleanup,
  productionResidentServiceIds,
  reconcileResidentLeaseInventory,
  readResidentLeaseDocument,
  residentLeaseDigest,
  validateResidentLeaseInventory,
  writeResidentLeaseDocument
} from '../../tools/test-matrix/resident-resource-leases.mjs'
import { publishResidentInventoryFromEnvironment } from '../../tools/test-matrix/resident-resource-leases-cli.mjs'

function services() {
  return [
    {
      id: 'backend', kind: 'process', identity: { pid: 42, startTimeTicks: '100' }, port: 24001,
      generation: 'backend-1', health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' }, observedRssBytes: 300
    },
    {
      id: 'postgres', kind: 'container', identity: { containerId: 'a'.repeat(64), createdAt: '2026-07-14T00:00:00Z' }, port: 20001,
      generation: 'postgres-1', health: { status: 'ready', checkedAt: '2026-07-14T00:00:00.000Z' }, observedRssBytes: 700
    }
  ]
}

function inventory() {
  return createResidentLeaseInventory({
    runId: 'run-1', namespace: 'production-fresh', ownerBundleId: 'runtime-browser',
    sourceState: { commit: 'abc123', worktreeFingerprint: 'tree-1' },
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 }, services: services(), generatedAt: '2026-07-14T00:00:01.000Z'
  })
}

function readiness(value, checkedAt = '2026-07-14T00:00:02.000Z') {
  return {
    status: 'ready',
    checkedAt,
    services: value.services.map((service) => ({
      id: service.id,
      generation: service.generation,
      status: 'live'
    }))
  }
}

test('resident inventory gives every live service a nonzero measured lease while retaining executable capacity', () => {
  const value = inventory()
  assert.ok(value.reservation.cpuUnits > 0 && value.reservation.cpuUnits < 2)
  assert.ok(value.reservation.memoryGiB > 0 && value.reservation.memoryGiB < 4)
  assert.ok(2 - value.reservation.cpuUnits >= 1)
  assert.ok(value.services.every((service) => service.reservation.cpuUnits > 0 && service.reservation.memoryGiB > 0))
  assert.ok(value.services[1].reservation.memoryGiB > value.services[0].reservation.memoryGiB)
  validateResidentLeaseInventory(value, {
    runId: 'run-1', namespace: 'production-fresh', ownerBundleId: 'runtime-browser',
    verifyProcess: (identity) => identity.pid === 42 && identity.startTimeTicks === '100',
    verifyContainer: (identity) => identity.containerId === 'a'.repeat(64)
  })
})

test('reconciliation releases only confirmed exits and retains drift or unknown identities fail-closed', () => {
  const value = inventory()
  const reconciled = reconcileResidentLeaseInventory(value, {
    observeService: (service) => service.id === 'backend'
      ? { status: 'exited', observedRssBytes: 0, observedCpuTicks: 10 }
      : { status: 'identity-changed', observedRssBytes: 900, observedCpuTicks: 20 },
    observedAt: '2026-07-14T00:00:05.000Z'
  })
  assert.equal(reconciled.fullyReleased, false)
  assert.equal(reconciled.healthy, false)
  assert.equal(reconciled.services[0].status, 'exited')
  assert.equal(reconciled.reservation.cpuUnits, value.services[1].reservation.cpuUnits)
  const released = reconcileResidentLeaseInventory(value, {
    observeService: () => ({ status: 'exited' })
  })
  assert.equal(released.fullyReleased, true)
  assert.deepEqual(released.reservation, { cpuUnits: 0, memoryGiB: 0 })
})

test('resident inventory rejects foreign identity, digest drift, and zero reservations', () => {
  const value = inventory()
  assert.throws(() => validateResidentLeaseInventory(value, { runId: 'other' }), /another run/u)
  assert.throws(() => validateResidentLeaseInventory(value, {
    sourceState: { commit: 'abc123', worktreeFingerprint: 'tree-2' }
  }), /another source state/u)
  assert.throws(() => validateResidentLeaseInventory(value, { verifyProcess: () => false }), /identity changed/u)
  const drifted = structuredClone(value)
  drifted.services[0].port += 1
  assert.throws(() => validateResidentLeaseInventory(drifted), /digest mismatch/u)
  const zero = structuredClone(value)
  zero.services[0].reservation.cpuUnits = 0
  assert.throws(() => validateResidentLeaseInventory(zero), /digest mismatch|no resource reservation/u)

  const resignedUnderReservation = structuredClone(value)
  resignedUnderReservation.services[0].reservation = { cpuUnits: 0.001, memoryGiB: 0.001 }
  resignedUnderReservation.reservation = resignedUnderReservation.services.reduce((total, service) => ({
    cpuUnits: total.cpuUnits + service.reservation.cpuUnits,
    memoryGiB: total.memoryGiB + service.reservation.memoryGiB
  }), { cpuUnits: 0, memoryGiB: 0 })
  const { digest: _discardedDigest, ...unsignedUnderReservation } = resignedUnderReservation
  resignedUnderReservation.digest = residentLeaseDigest(unsignedUnderReservation)
  assert.throws(() => validateResidentLeaseInventory(resignedUnderReservation), /not derived from its resource grant/u)

  const foreignGrant = createResidentLeaseInventory({
    runId: 'run-1', namespace: 'production-fresh', ownerBundleId: 'runtime-browser',
    sourceState: value.sourceState,
    resourceGrant: { cpuUnits: 1, memoryGiB: 1 }, services: services()
  })
  assert.throws(() => validateResidentLeaseInventory(foreignGrant, {
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 }
  }), /another resource grant/u)
  assert.throws(() => validateResidentLeaseInventory(value, {
    requiredServiceIds: productionResidentServiceIds
  }), /service roster mismatch/u)
  assert.throws(() => createResidentLeaseInventory({
    runId: 'run-1', namespace: 'production-fresh', ownerBundleId: 'runtime-browser',
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 },
    services: [{ ...services()[0], identity: { pid: 42, startTimeTicks: 'not-proc-stat' } }]
  }), /startTimeTicks must be numeric/u)
})

test('enforcement binding reconciles process cgroup and per-container OCI hard limits with leases', () => {
  const value = inventory()
  const backend = value.services.find((service) => service.id === 'backend')
  const postgres = value.services.find((service) => service.id === 'postgres')
  const memoryHighBytes = Math.round(postgres.reservation.memoryGiB * (1024 ** 3))
  const bound = bindResidentLeaseEnforcement(value, {
    mode: 'enforced',
    processScope: {
      status: 'enforced',
      path: '/sys/fs/cgroup/fsusblog/runtime-browser',
      reservation: backend.reservation
    },
    containers: {
      postgres: {
        status: 'enforced',
        containerId: postgres.identity.containerId,
        reservation: postgres.reservation,
        observed: {
          cpuUnits: postgres.reservation.cpuUnits,
          memoryHighBytes,
          memoryMaxBytes: memoryHighBytes + 1
        }
      }
    },
    boundAt: '2026-07-14T00:00:01.000Z'
  })
  validateResidentLeaseInventory(bound)
  assert.equal(bound.enforcement.processScope.reservation.cpuUnits, backend.reservation.cpuUnits)
  assert.equal(bound.enforcement.containers.postgres.observed.memoryHighBytes, memoryHighBytes)
  assert.throws(() => bindResidentLeaseEnforcement(value, {
    mode: 'enforced',
    processScope: { status: 'enforced', path: '/wrong', reservation: value.reservation },
    containers: {},
    boundAt: '2026-07-14T00:00:01.000Z'
  }), /process cgroup reservation/u)

  const resignedDrift = structuredClone(bound)
  resignedDrift.enforcement.containers.postgres.observed.memoryHighBytes -= 1
  const { digest: _discardedDigest, ...unsignedDrift } = resignedDrift
  resignedDrift.digest = residentLeaseDigest(unsignedDrift)
  assert.throws(() => validateResidentLeaseInventory(resignedDrift), /OCI hard limit does not match/u)
})

test('bootstrap publisher inventories all five services without mutating process environment and binds OCI evidence', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resident-publisher-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const outputFile = path.join(directory, 'inventory.json')
  const originalMarker = process.env.FSUSBLOG_TEST_RUN_ID
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'publisher-run',
    FSUSBLOG_TEST_NAMESPACE: 'publisher-namespace',
    FSUSBLOG_PHYSICAL_BUNDLE_ID: 'runtime-browser',
    FSUSBLOG_TEST_SOURCE_COMMIT: 'abc123',
    FSUSBLOG_TEST_SOURCE_FINGERPRINT: 'tree-publisher',
    FSUSBLOG_STEP_CPU_BUDGET: '4',
    FSUSBLOG_STEP_MEMORY_GIB: '8',
    FSUSBLOG_DEBUG_BACKEND_PORT: '24001',
    FSUSBLOG_DEBUG_FRONTEND_PORT: '24002',
    FSUSBLOG_RELEASE_PREVIEW_PORT: '24003',
    FSUSBLOG_POSTGRES_PORT: '24004',
    FSUSBLOG_REDIS_PORT: '24005',
    FSUSBLOG_RESIDENT_BACKEND_PID: '101',
    FSUSBLOG_RESIDENT_FRONTEND_PID: '102',
    FSUSBLOG_RESIDENT_PREVIEW_PID: '103',
    FSUSBLOG_POSTGRES_CONTAINER_NAME: 'postgres-test',
    FSUSBLOG_REDIS_CONTAINER_NAME: 'redis-test',
    FSUSBLOG_CGROUP_ENFORCEMENT_MODE: 'advisory',
    FSUSBLOG_CGROUP_BUNDLE_PATH: ''
  }
  const processSnapshots = new Map([
    ['101', { identity: { pid: 101, startTimeTicks: '1001' }, observedRssBytes: 100 }],
    ['102', { identity: { pid: 102, startTimeTicks: '1002' }, observedRssBytes: 200 }],
    ['103', { identity: { pid: 103, startTimeTicks: '1003' }, observedRssBytes: 300 }]
  ])
  const containerSnapshots = new Map([
    ['postgres-test', { identity: { containerId: 'a'.repeat(64), createdAt: '2026-07-14T00:00:00Z' }, observedRssBytes: 400 }],
    ['redis-test', { identity: { containerId: 'b'.repeat(64), createdAt: '2026-07-14T00:00:01Z' }, observedRssBytes: 500 }]
  ])
  const result = publishResidentInventoryFromEnvironment({
    env,
    outputFile,
    snapshotProcess: (pid) => processSnapshots.get(String(pid)),
    snapshotContainer: (name) => containerSnapshots.get(name),
    enforceContainer: (_name, service) => {
      const memoryHighBytes = Math.round(service.reservation.memoryGiB * (1024 ** 3))
      return {
        status: 'enforced',
        containerId: service.identity.containerId,
        reservation: service.reservation,
        observed: {
          cpuUnits: service.reservation.cpuUnits,
          memoryHighBytes,
          memoryMaxBytes: memoryHighBytes + 1
        }
      }
    }
  })
  assert.equal(result.inventory.services.length, 5)
  assert.deepEqual(result.inventory.sourceState, { commit: 'abc123', worktreeFingerprint: 'tree-publisher' })
  assert.deepEqual(result.inventory.services.map((service) => service.id), [
    'debug-backend', 'debug-frontend', 'release-preview', 'postgres', 'redis'
  ])
  assert.equal(result.inventory.enforcement.containers.postgres.status, 'enforced')
  assert.equal(result.inventory.enforcement.containers.redis.status, 'enforced')
  assert.equal(process.env.FSUSBLOG_TEST_RUN_ID, originalMarker)
  assert.equal(readResidentLeaseDocument(outputFile).digest, result.inventory.digest)
})

test('handoff binds run namespace generation readiness owners and rejects stale or double consumption', () => {
  const value = inventory()
  const receipt = createResidentLeaseHandoff({
    inventory: value,
    toOwnerBundleId: 'performance-evidence',
    readiness: readiness(value),
    generatedAt: '2026-07-14T00:00:03.000Z'
  })
  const consumed = consumeResidentLeaseHandoff(receipt, {
    inventory: value, consumerBundleId: 'performance-evidence', consumedAt: '2026-07-14T00:00:04.000Z'
  })
  assert.equal(consumed.consumedBy, 'performance-evidence')
  assert.deepEqual(consumed.sourceState, value.sourceState)
  assert.throws(() => consumeResidentLeaseHandoff(consumed, {
    inventory: value, consumerBundleId: 'performance-evidence'
  }), /already consumed/u)
  assert.throws(() => consumeResidentLeaseHandoff(receipt, {
    inventory: value, consumerBundleId: 'foreign'
  }), /another consumer/u)
  const resignedStaleReadiness = structuredClone(receipt)
  resignedStaleReadiness.readiness.services[0].generation = 'foreign-generation'
  const { digest: _discardedReadinessDigest, ...unsignedStaleReadiness } = resignedStaleReadiness
  resignedStaleReadiness.digest = residentLeaseDigest(unsignedStaleReadiness)
  assert.throws(() => consumeResidentLeaseHandoff(resignedStaleReadiness, {
    inventory: value, consumerBundleId: 'performance-evidence'
  }), /readiness is stale/u)
  const restarted = createResidentLeaseInventory({
    runId: 'run-1', namespace: 'production-fresh', ownerBundleId: 'runtime-browser',
    sourceState: value.sourceState,
    resourceGrant: { cpuUnits: 2, memoryGiB: 4 },
    services: services().map((service) => service.id === 'backend'
      ? { ...service, identity: { pid: 43, startTimeTicks: '101' }, generation: 'backend-2' }
      : service)
  })
  assert.throws(() => consumeResidentLeaseHandoff(receipt, {
    inventory: restarted, consumerBundleId: 'performance-evidence'
  }), /stale/u)
})

test('handoff file consumption is atomic across competing consumer processes', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resident-handoff-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const inventoryFile = path.join(directory, 'inventory.json')
  const handoffFile = path.join(directory, 'handoff.json')
  const childFile = path.join(directory, 'consume.mjs')
  const value = inventory()
  writeResidentLeaseDocument(inventoryFile, value)
  writeResidentLeaseDocument(handoffFile, createResidentLeaseHandoff({
    inventory: value,
    toOwnerBundleId: 'performance-evidence',
    readiness: readiness(value)
  }))
  const moduleUrl = pathToFileURL(path.resolve('tools/test-matrix/resident-resource-leases.mjs')).href
  fs.writeFileSync(childFile, [
    `import { consumeResidentLeaseHandoffFile, readResidentLeaseDocument } from ${JSON.stringify(moduleUrl)}`,
    'try {',
    '  const inventory = readResidentLeaseDocument(process.argv[2])',
    "  consumeResidentLeaseHandoffFile(process.argv[3], { inventory, consumerBundleId: 'performance-evidence' })",
    "  process.stdout.write('consumed')",
    '} catch (error) {',
    '  process.stderr.write(error.message)',
    '  process.exitCode = 2',
    '}'
  ].join('\n'))
  const runConsumer = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [childFile, inventoryFile, handoffFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
  const results = await Promise.all([runConsumer(), runConsumer()])
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 2])
  assert.equal(results.filter((result) => result.stdout === 'consumed').length, 1)
  assert.match(results.find((result) => result.status === 2).stderr, /already consumed/u)
  assert.equal(readResidentLeaseDocument(handoffFile).consumedBy, 'performance-evidence')
  assert.equal(fs.existsSync(`${handoffFile}.consume.lock`), false)

  writeResidentLeaseDocument(handoffFile, createResidentLeaseHandoff({
    inventory: value,
    toOwnerBundleId: 'performance-evidence',
    readiness: readiness(value, '2026-07-14T00:00:03.000Z')
  }))
  fs.writeFileSync(`${handoffFile}.consume.lock`, `${JSON.stringify({
    pid: 999_999_999,
    startTimeTicks: '1',
    token: 'dead-owner'
  })}\n`)
  const staleAt = new Date(Date.now() - 60_000)
  fs.utimesSync(`${handoffFile}.consume.lock`, staleAt, staleAt)
  const recovered = consumeResidentLeaseHandoffFile(handoffFile, {
    inventory: value,
    consumerBundleId: 'performance-evidence',
    staleLockMs: 1
  })
  assert.equal(recovered.consumedBy, 'performance-evidence')
  assert.equal(fs.existsSync(`${handoffFile}.consume.lock`), false)
})

test('resident documents publish atomically and unreadable input fails closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resident-leases-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'leases.json')
  writeResidentLeaseDocument(file, inventory())
  assert.equal(readResidentLeaseDocument(file).schema, 'fsusblog.test-matrix.resident-resource-leases.v2')
  assert.deepEqual(fs.readdirSync(directory), ['leases.json'])
  fs.writeFileSync(file, '{broken')
  assert.throws(() => readResidentLeaseDocument(file), /unreadable/u)
})

test('cleanup evidence releases the ledger only after every bound identity is confirmed exited', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resident-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const runDirectory = path.join(root, '.tmp/test-runs/run-1')
  const inventoryFile = path.join(runDirectory, 'resident-resource-leases.json')
  const checkpointFile = path.join(runDirectory, 'checkpoint.json')
  writeResidentLeaseDocument(inventoryFile, inventory())
  writeResidentLeaseDocument(checkpointFile, {
    schema: 'fsusblog.test-matrix.checkpoint.v1',
    residentResourceLeases: {
      status: 'handed-off',
      inventoryFile: '.tmp/test-runs/run-1/resident-resource-leases.json',
      reservation: inventory().reservation,
      services: {},
      events: []
    }
  })
  const retained = finalizeResidentLeaseCleanup({
    root,
    checkpointFile,
    cleanup: { terminatedPids: [] },
    observeService: () => ({ status: 'unknown', reason: 'still-visible' })
  })
  assert.equal(retained.residentResourceLeases.status, 'cleanup-pending-live-services')
  assert.ok(retained.residentResourceLeases.reservation.cpuUnits > 0)
  const released = finalizeResidentLeaseCleanup({
    root,
    checkpointFile,
    cleanup: { terminatedPids: [42] },
    observeService: () => ({ status: 'exited' })
  })
  assert.equal(released.residentResourceLeases.status, 'released')
  assert.deepEqual(released.residentResourceLeases.reservation, { cpuUnits: 0, memoryGiB: 0 })
})
