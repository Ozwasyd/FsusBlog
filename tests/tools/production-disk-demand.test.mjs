import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { currentProcessIdentity } from '../../tools/test/process-identity.mjs'
import { acquireProductionCapacityReservation } from '../../tools/test-matrix/production-capacity-reservation.mjs'
import {
  buildProductionDiskDemandPlan,
  calculateProductionDiskPeak,
  canonicalFilesystemIdentity,
  productionDiskDemandDigest,
  readProductionDiskDemandCatalog
} from '../../tools/test-matrix/production-disk-demand.mjs'
import { parseMatrix } from '../../tools/test-matrix/parse-matrix.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')

test('catalog exactly covers every Production physical bundle with non-zero rooted declarations', () => {
  const catalog = readProductionDiskDemandCatalog(repositoryRoot)
  const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'))
  const physicalProducerIds = [
    ...matrix.localProfiles.production.bundles.map((producer) => producer.id),
    'managed-production-build-gc'
  ].sort()
  assert.deepEqual(
    catalog.producers.map((producer) => producer.producerId).sort(),
    physicalProducerIds)
  for (const producer of catalog.producers) {
    assert.ok(producer.demands.length > 0)
    for (const demand of producer.demands) {
      assert.ok(demand.peakAdditionalBytes > 0)
      assert.ok(demand.uncertaintyBytes > 0)
      assert.ok(demand.sourceOfEstimate.length > 12)
    }
  }
})

test('canonical identity merges a path and symlink on the same filesystem', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  fs.mkdirSync(real)
  fs.symlinkSync(real, alias, 'dir')
  assert.equal(
    canonicalFilesystemIdentity(real).filesystemIdentity,
    canonicalFilesystemIdentity(alias).filesystemIdentity)
})

test('peak calculation uses concurrent DAG live sets and retained terminal bytes', () => {
  const tiers = [
    { id: 'a', executionDependsOn: [], exclusiveResources: [] },
    { id: 'b', executionDependsOn: [], exclusiveResources: [] },
    { id: 'c', executionDependsOn: ['a', 'b'], exclusiveResources: [] }
  ]
  const demand = (peak, terminal) => [{
    rootId: 'run-output',
    peakAdditionalBytes: peak,
    terminalRetainedBytes: terminal,
    rollbackOrRecoveryBytes: 10,
    uncertaintyBytes: 5
  }]
  const peak = calculateProductionDiskPeak({
    tiers,
    declarationsByProducer: new Map([
      ['a', demand(100, 40)],
      ['b', demand(200, 50)],
      ['c', demand(80, 20)]
    ]),
    maxParallel: 2
  })
  assert.equal(peak.get('run-output'), 330)
})

test('plan merges same-filesystem roots once and preserves different filesystems', () => {
  const catalog = {
    schema: 'fsusblog.production-disk-demand-catalog.v1',
    estimatorVersion: 'fixture-v1',
    safetyBytes: 10,
    rootBindings: { first: 'firstPath', second: 'secondPath', docker: 'dockerPath' },
    producers: [{
      producerId: 'producer',
      demands: [
        { rootId: 'first', peakAdditionalBytes: 100, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' },
        { rootId: 'second', peakAdditionalBytes: 200, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' },
        { rootId: 'docker', peakAdditionalBytes: 300, terminalRetainedBytes: 10, rollbackOrRecoveryBytes: 5, concurrencyClass: 'x', uncertaintyBytes: 5, sourceOfEstimate: 'fixture measurement' }
      ]
    }]
  }
  const identities = new Map([
    ['/first', { filesystemIdentity: 'fs-a', canonicalPath: '/first', availableBytes: 1000 }],
    ['/second', { filesystemIdentity: 'fs-a', canonicalPath: '/second', availableBytes: 900 }],
    ['/docker', { filesystemIdentity: 'fs-b', canonicalPath: '/docker', availableBytes: 2000 }]
  ])
  const plan = buildProductionDiskDemandPlan({
    root: repositoryRoot,
    tiers: [{ id: 'producer', executionDependsOn: [], exclusiveResources: [] }],
    roots: { firstPath: '/first', secondPath: '/second', dockerPath: '/docker' },
    maxParallel: 1,
    catalog,
    resolveFilesystem: (candidate) => identities.get(candidate)
  })
  assert.equal(plan.filesystems.length, 2)
  assert.deepEqual(plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-a').rootIds, ['first', 'second'])
  assert.equal(plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-a').observedFreeBytes, 900)
})

test('same-filesystem admission uses one DAG-state peak instead of summing per-root maxima', (t) => {
  const catalog = {
    schema: 'fsusblog.production-disk-demand-catalog.v1',
    estimatorVersion: 'fixture-v1',
    safetyBytes: 10,
    rootBindings: { first: 'firstPath', second: 'secondPath' },
    producers: [
      {
        producerId: 'first-producer',
        demands: [{
          rootId: 'first',
          peakAdditionalBytes: 100,
          terminalRetainedBytes: 0,
          rollbackOrRecoveryBytes: 0,
          concurrencyClass: 'sequential',
          uncertaintyBytes: 1,
          sourceOfEstimate: 'fixture measurement'
        }]
      },
      {
        producerId: 'second-producer',
        demands: [{
          rootId: 'second',
          peakAdditionalBytes: 100,
          terminalRetainedBytes: 0,
          rollbackOrRecoveryBytes: 0,
          concurrencyClass: 'sequential',
          uncertaintyBytes: 1,
          sourceOfEstimate: 'fixture measurement'
        }]
      }
    ]
  }
  const plan = buildProductionDiskDemandPlan({
    root: repositoryRoot,
    tiers: [
      { id: 'first-producer', executionDependsOn: [], exclusiveResources: [] },
      { id: 'second-producer', executionDependsOn: ['first-producer'], exclusiveResources: [] }
    ],
    roots: { firstPath: '/first', secondPath: '/second' },
    maxParallel: 2,
    catalog,
    resolveFilesystem: (candidate) => ({
      filesystemIdentity: 'fs-shared',
      canonicalPath: candidate,
      availableBytes: 150
    })
  })
  assert.deepEqual(
    plan.rootDemandPeaks.map(({ rootId, requestedBytes }) => ({ rootId, requestedBytes })),
    [
      { rootId: 'first', requestedBytes: 101 },
      { rootId: 'second', requestedBytes: 101 }
    ])
  assert.equal(plan.filesystems[0].requestedBytes, 101)
  assert.equal(plan.filesystems[0].safetyBytes, 10)

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-peak-admission-'))
  const reservationRoot = path.join(parent, 'capacity-authority')
  const reservationRepository = path.join(parent, 'repository')
  fs.mkdirSync(reservationRepository)
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const reservation = acquireProductionCapacityReservation({
    plan,
    runId: 'same-state-peak',
    candidateIdentityDigest: productionDiskDemandDigest('same-state-candidate'),
    repositoryRoot: reservationRepository,
    repositoryLeaseOwner: { ownerToken: 'same-state-lease-owner' },
    authorityRoot: reservationRoot,
    ownerIdentity: currentProcessIdentity(),
    measureAvailable: () => 150
  })
  assert.equal(reservation.receipt.filesystems[0].admittedBytes, 111)
  reservation.release('released')
})

test('Production maxParallel two has an exact same-state host filesystem peak', () => {
  const catalog = readProductionDiskDemandCatalog(repositoryRoot)
  const matrix = parseMatrix(fs.readFileSync(path.join(repositoryRoot, 'tests/matrix.yml'), 'utf8'))
  const managedGc = {
    id: 'managed-production-build-gc',
    executionDependsOn: [],
    exclusiveResources: ['build-root-gc', 'disk-heavy']
  }
  const tiers = [
    managedGc,
    ...matrix.localProfiles.production.bundles.map((producer) => ({
      id: producer.id,
      executionDependsOn: [managedGc.id, ...producer.dependsOn],
      exclusiveResources: producer.exclusiveResources
    }))
  ]
  const roots = Object.fromEntries(
    Object.values(catalog.rootBindings).map((binding) => [binding, `/${binding}`]))
  const plan = buildProductionDiskDemandPlan({
    root: repositoryRoot,
    tiers,
    roots,
    maxParallel: 2,
    catalog,
    resolveFilesystem: (candidate) => ({
      filesystemIdentity: candidate === '/dockerStorageRoot' ? 'fs-docker' : 'fs-host',
      canonicalPath: candidate,
      availableBytes: Number.MAX_SAFE_INTEGER
    })
  })
  const hostFilesystem = plan.filesystems.find((entry) => entry.filesystemIdentity === 'fs-host')
  assert.equal(hostFilesystem.requestedBytes, 19_478_347_776)
  assert.notEqual(hostFilesystem.requestedBytes, 22_699_573_248)
  assert.equal(
    plan.rootDemandPeaks
      .filter((entry) => entry.filesystemIdentity === 'fs-host')
      .reduce((total, entry) => total + entry.requestedBytes, 0),
    22_699_573_248)
})

test('unknown Docker/root identity fails closed', () => {
  const catalog = {
    schema: 'fsusblog.production-disk-demand-catalog.v1',
    estimatorVersion: 'fixture-v1',
    safetyBytes: 10,
    rootBindings: { docker: 'dockerPath' },
    producers: [{
      producerId: 'producer',
      demands: [{
        rootId: 'docker',
        peakAdditionalBytes: 1,
        terminalRetainedBytes: 0,
        rollbackOrRecoveryBytes: 1,
        concurrencyClass: 'docker',
        uncertaintyBytes: 1,
        sourceOfEstimate: 'fixture measurement'
      }]
    }]
  }
  assert.throws(() => buildProductionDiskDemandPlan({
    root: repositoryRoot,
    tiers: [{ id: 'producer', executionDependsOn: [], exclusiveResources: [] }],
    roots: { dockerPath: '/unknown' },
    maxParallel: 1,
    catalog,
    resolveFilesystem: () => { throw new Error('unknown volume') }
  }), /unknown volume/u)
})
