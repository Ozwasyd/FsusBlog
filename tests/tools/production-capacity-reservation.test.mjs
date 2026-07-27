import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { currentProcessIdentity } from '../../tools/test/process-identity.mjs'
import { acquireProductionCapacityReservation } from '../../tools/test-matrix/production-capacity-reservation.mjs'
import { productionDiskDemandDigest } from '../../tools/test-matrix/production-disk-demand.mjs'

function fixturePlan({ free = 999, requested = 400, safety = 100 } = {}) {
  const declarations = [{
    producerId: 'producer',
    rootId: 'run-output',
    peakAdditionalBytes: 250,
    terminalRetainedBytes: 100,
    rollbackOrRecoveryBytes: 50,
    uncertaintyBytes: 50,
    concurrencyClass: 'fixture',
    estimatorVersion: 'fixture-v1',
    sourceOfEstimate: 'fixture measurement'
  }]
  return {
    schema: 'fsusblog.production-disk-demand-plan.v1',
    planDigest: productionDiskDemandDigest({ plan: 'fixture', requested }),
    producerDeclarationDigest: productionDiskDemandDigest(declarations),
    producerDeclarations: declarations,
    filesystems: [{
      filesystemIdentity: 'fixture:fs',
      canonicalPaths: [os.tmpdir()],
      rootIds: ['run-output'],
      observedFreeBytes: free,
      requestedBytes: requested,
      safetyBytes: safety
    }]
  }
}

function options(t, plan = fixturePlan()) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-reservation-'))
  const repositoryRoot = path.join(parent, 'repository')
  const authorityRoot = path.join(parent, 'authority')
  fs.mkdirSync(repositoryRoot)
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  return {
    plan,
    runId: 'run-fixture',
    candidateIdentityDigest: productionDiskDemandDigest('candidate'),
    repositoryRoot,
    repositoryLeaseOwner: { ownerToken: 'lease-owner-token' },
    authorityRoot,
    ownerIdentity: currentProcessIdentity(),
    measureAvailable: (filesystem) => filesystem.observedFreeBytes
  }
}

test('second run subtracts an active reservation on the same filesystem', (t) => {
  const firstOptions = options(t)
  const first = acquireProductionCapacityReservation(firstOptions)
  assert.throws(() => acquireProductionCapacityReservation({
    ...firstOptions,
    runId: 'run-second'
  }), /active reservation|admission failed/u)
  first.release('released')
  const second = acquireProductionCapacityReservation({
    ...firstOptions,
    runId: 'run-second'
  })
  second.release('released')
})

test('a plan larger than the retired 4 GiB threshold rejects while a small declared plan admits', (t) => {
  const gib = 1024 ** 3
  assert.throws(() => acquireProductionCapacityReservation(options(t, fixturePlan({
    free: 5 * gib,
    requested: 6 * gib,
    safety: 1
  }))), /capacity admission failed/u)
  const small = acquireProductionCapacityReservation(options(t, fixturePlan({
    free: 1024 ** 2,
    requested: 512 * 1024,
    safety: 128 * 1024
  })))
  small.release('released')
})

test('one insufficient filesystem rejects the whole multi-filesystem reservation', (t) => {
  const plan = fixturePlan()
  plan.filesystems.push({
    filesystemIdentity: 'fixture:docker',
    canonicalPaths: [os.tmpdir()],
    rootIds: ['docker-storage'],
    observedFreeBytes: 99,
    requestedBytes: 100,
    safetyBytes: 1
  })
  assert.throws(() => acquireProductionCapacityReservation(options(t, plan)), /fixture:docker/u)
})

test('admission remeasures free bytes while holding the authority lock', (t) => {
  const reservationOptions = options(t)
  reservationOptions.measureAvailable = () => 499
  assert.throws(
    () => acquireProductionCapacityReservation(reservationOptions),
    /capacity admission failed/u)
})

test('owner PID reuse or command mismatch remains blocking', (t) => {
  const firstOptions = options(t)
  const first = acquireProductionCapacityReservation(firstOptions)
  assert.throws(() => acquireProductionCapacityReservation({
    ...firstOptions,
    runId: 'run-second',
    verifyOwner: () => ({ status: 'identity-mismatch' })
  }), /admission failed/u)
  const blocked = JSON.parse(fs.readFileSync(first.activeFile, 'utf8'))
  assert.equal(blocked.state, 'recovery-required')
})

test('dead owner with a live process tree remains blocking; zero residuals recover', (t) => {
  const firstOptions = options(t)
  const first = acquireProductionCapacityReservation(firstOptions)
  assert.throws(() => acquireProductionCapacityReservation({
    ...firstOptions,
    runId: 'run-second',
    verifyOwner: () => ({ status: 'process-tree-live' })
  }), /admission failed/u)
  const recovered = acquireProductionCapacityReservation({
    ...firstOptions,
    runId: 'run-second',
    verifyOwner: () => ({ status: 'terminal' })
  })
  recovered.release('released')
  assert.ok(first.activeFile)
})

test('plan drift is rejected before cleanup and release uses compare-owner token', (t) => {
  const reservation = acquireProductionCapacityReservation(options(t))
  assert.throws(() => reservation.assertPlan({
    ...fixturePlan(),
    planDigest: productionDiskDemandDigest('changed')
  }), /drift requires a new reservation/u)
  const release = reservation.release('released')
  assert.equal(release.receipt.state, 'released')
  assert.ok(fs.existsSync(release.file))
})

test('CAS rejects a resealed journal whose immutable plan identity was changed', (t) => {
  const reservation = acquireProductionCapacityReservation(options(t))
  const original = JSON.parse(fs.readFileSync(reservation.activeFile, 'utf8'))
  const changed = {
    ...original,
    planDigest: productionDiskDemandDigest('tampered-plan')
  }
  const { contentDigest: _contentDigest, ...payload } = changed
  changed.contentDigest = productionDiskDemandDigest(payload)
  fs.writeFileSync(reservation.activeFile, `${JSON.stringify(changed, null, 2)}\n`)
  assert.throws(() => reservation.release('released'), /compare-owner-token failed/u)
  fs.writeFileSync(reservation.activeFile, `${JSON.stringify(original, null, 2)}\n`)
  reservation.release('aborted')
})

test('a stale authority lock is recovered by full process identity, not PID alone', (t) => {
  const reservationOptions = options(t)
  const lock = path.join(reservationOptions.authorityRoot, 'authority.lock')
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 })
  const ownerIdentity = {
    ...currentProcessIdentity(),
    processStartIdentity: 'linux:stale-boot:1'
  }
  const payload = {
    schema: 'fsusblog.production-capacity-authority-lock.v1',
    ownerToken: 'stale-authority-owner',
    ownerIdentity,
    createdAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
    ...payload,
    contentDigest: productionDiskDemandDigest(payload)
  }, null, 2)}\n`)
  const reservation = acquireProductionCapacityReservation(reservationOptions)
  reservation.release('released')
})

test('a resealed authority lock with an incomplete owner fails closed', (t) => {
  const reservationOptions = options(t)
  const lock = path.join(reservationOptions.authorityRoot, 'authority.lock')
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 })
  const payload = {
    schema: 'fsusblog.production-capacity-authority-lock.v1',
    ownerToken: 'forged-authority-owner',
    ownerIdentity: { pid: process.pid },
    createdAt: new Date().toISOString()
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify({
    ...payload,
    contentDigest: productionDiskDemandDigest(payload)
  }, null, 2)}\n`)
  assert.throws(
    () => acquireProductionCapacityReservation(reservationOptions),
    /lock is invalid or tampered/u)
})

test('external capacity loss blocks spawn and under-declaration is classified', (t) => {
  const reservation = acquireProductionCapacityReservation(options(t))
  assert.throws(() => reservation.guardProducer('producer', {
    measureAvailable: () => 399
  }), (error) => error.code === 'EXTERNAL_CAPACITY_LOSS')
  reservation.guardProducer('producer', { measureAvailable: () => 1000 })
  assert.throws(() => reservation.completeProducer('producer', {
    measureAvailable: () => 600
  }), (error) => error.code === 'ESTIMATOR_UNDER_DECLARED')
  reservation.release('aborted')
})

test('success, failure, timeout and cancel terminal paths seal release receipts', (t) => {
  for (const terminalState of ['released', 'failure', 'timeout', 'cancel']) {
    const reservation = acquireProductionCapacityReservation({
      ...options(t),
      runId: `run-${terminalState}`
    })
    const release = reservation.release(terminalState)
    assert.ok(fs.existsSync(release.file))
    assert.equal(release.receipt.terminalState, terminalState)
    assert.equal(release.receipt.state, terminalState === 'released' ? 'released' : 'aborted')
  }
})
