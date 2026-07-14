import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  bindResidentLeaseEnforcement,
  consumeResidentLeaseHandoff,
  createResidentLeaseHandoff,
  createResidentLeaseInventory,
  finalizeResidentLeaseCleanup,
  reconcileResidentLeaseInventory,
  readResidentLeaseDocument,
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
    readiness: { status: 'ready', checkedAt: '2026-07-14T00:00:02.000Z' },
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

test('resident documents publish atomically and unreadable input fails closed', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-resident-leases-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'leases.json')
  writeResidentLeaseDocument(file, inventory())
  assert.equal(readResidentLeaseDocument(file).schema, 'fsusblog.test-matrix.resident-resource-leases.v1')
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
