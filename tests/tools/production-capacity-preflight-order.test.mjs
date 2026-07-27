import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { currentProcessIdentity } from '../../tools/test/process-identity.mjs'
import { acquireProductionCapacityReservation } from '../../tools/test-matrix/production-capacity-reservation.mjs'
import { productionDiskDemandDigest } from '../../tools/test-matrix/production-disk-demand.mjs'
import { runDag } from '../../tools/test-matrix/scheduler.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const runner = fs.readFileSync(path.join(repositoryRoot, 'tools/run-test-matrix.mjs'), 'utf8')
const scheduler = fs.readFileSync(path.join(repositoryRoot, 'tools/test-matrix/scheduler.mjs'), 'utf8')

test('reservation is acquired before runtime/output/cache cleanup and build-root preparation', () => {
  const inspection = runner.indexOf('inspectProductionFreshCacheTransactions)(profileRoot)')
  const acquire = runner.indexOf('acquireReservation({')
  const staleRuntimeCleanup = runner.indexOf('executeProductionFreshPreflight({', acquire)
  const outputCleanup = runner.indexOf('cleanLocalProductionOutputs)(profileRoot', acquire)
  const buildRoot = runner.indexOf('runProductionBuildLifecycle({', acquire)
  assert.ok(inspection > 0)
  assert.ok(acquire > inspection)
  assert.ok(staleRuntimeCleanup > acquire)
  assert.ok(outputCleanup > staleRuntimeCleanup)
  assert.ok(buildRoot > outputCleanup)
})

test('live guard runs before output retirement, log creation and producer spawn', () => {
  const guard = scheduler.indexOf('await options.beforeTierStart?.(')
  const retirement = scheduler.indexOf('resume-candidate-retired', guard)
  const cleanup = scheduler.indexOf('cleanFreshOwnedFiles(root', guard)
  const log = scheduler.indexOf('createAsyncLogPipeline({', guard)
  const spawn = scheduler.indexOf('beginSubprocess(tier', guard)
  assert.ok(guard > 0)
  assert.ok(retirement > guard)
  assert.ok(cleanup > guard)
  assert.ok(log > cleanup)
  assert.ok(spawn > log)
})

test('--plan-only resolves and prints demand without acquiring reservation', () => {
  const planOnly = runner.indexOf('if (options.planOnly) {', runner.indexOf('const capacityTiers'))
  const printDemand = runner.indexOf('const diskPlan = resolveCapacityPlan()', planOnly)
  const acquire = runner.indexOf('acquireReservation({', printDemand)
  assert.ok(planOnly > 0)
  assert.ok(printDemand > planOnly)
  assert.ok(acquire > printDemand)
})

test('capacity rejection leaves every destructive action and old evidence at zero mutation', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-preflight-zero-'))
  const repository = path.join(parent, 'repository')
  const authority = path.join(parent, 'authority')
  fs.mkdirSync(repository)
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const oldEvidence = path.join(repository, 'failure-evidence.json')
  fs.writeFileSync(oldEvidence, '{"status":"old"}\n')
  const before = productionDiskDemandDigest(fs.readFileSync(oldEvidence))
  const actionCounts = {
    runtimeKillOrRemove: 0,
    containerRemove: 0,
    outputDeletion: 0,
    checkpointDeletion: 0,
    logDeletion: 0,
    cacheRenameOrDelete: 0,
    buildRootMutation: 0,
    staleBuildGcSpawn: 0,
    physicalProducerSpawn: 0
  }
  assert.throws(() => acquireProductionCapacityReservation({
    plan: {
      planDigest: productionDiskDemandDigest('plan'),
      producerDeclarationDigest: productionDiskDemandDigest('declarations'),
      producerDeclarations: [],
      filesystems: [{
        filesystemIdentity: 'fixture:full',
        canonicalPaths: [repository],
        rootIds: ['run-output'],
        observedFreeBytes: 99,
        requestedBytes: 100,
        safetyBytes: 1
      }]
    },
    runId: 'capacity-rejected',
    candidateIdentityDigest: productionDiskDemandDigest('candidate'),
    repositoryRoot: repository,
    repositoryLeaseOwner: { ownerToken: 'repository-lease-token' },
    authorityRoot: authority,
    ownerIdentity: currentProcessIdentity(),
    measureAvailable: (filesystem) => filesystem.observedFreeBytes
  }), (error) => {
    assert.equal(error.code, 'PRODUCTION_CAPACITY_ADMISSION_FAILED')
    assert.deepEqual(error.preflightActionCounts, {
      runtimeKillOrRemove: 0,
      containerRemove: 0,
      tempOrOutputDeletion: 0,
      checkpointDeletion: 0,
      logDeletion: 0,
      cacheRenameOrDelete: 0,
      buildRootMutation: 0,
      staleBuildGcSpawn: 0,
      physicalProducerSpawn: 0
    })
    assert.ok(fs.existsSync(error.receiptFile))
    assert.equal(path.dirname(path.dirname(error.receiptFile)), authority)
    assert.match(error.receiptDigest, /^sha256:[a-f0-9]{64}$/u)
    return true
  })
  assert.deepEqual(actionCounts, Object.fromEntries(Object.keys(actionCounts).map((key) => [key, 0])))
  assert.equal(productionDiskDemandDigest(fs.readFileSync(oldEvidence)), before)
})

test('scheduler admission rejection records zero spawn and does not execute the producer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-scheduler-zero-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q'], { cwd: root })
  fs.writeFileSync(path.join(root, '.gitignore'), '.tmp/\n')
  execFileSync('git', ['add', '.gitignore'], { cwd: root })
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root })
  let spawnCount = 0
  const result = await runDag({
    root,
    runsRoot: path.join(root, '.tmp/test-runs'),
    runId: 'capacity-guard-zero-spawn',
    targetTierId: 'producer',
    namespace: 'capacity-guard',
    maxParallel: 1,
    tiers: [{
      id: 'producer',
      command: 'true',
      executionDependsOn: [],
      parallelizable: true,
      exclusiveResources: [],
      resourceClass: 'io',
      cpuUnits: 1,
      memoryGiB: 0.1
    }],
    systemResources: {
      cpuCount: 2,
      availableCpuUnits: 2,
      availableMemoryGiB: 2,
      memoryReserveGiB: 0,
      load1: 0
    },
    beforeTierStart: () => {
      const error = new Error('external-capacity-loss')
      error.code = 'EXTERNAL_CAPACITY_LOSS'
      throw error
    },
    executeTier: () => {
      spawnCount += 1
      return 0
    }
  })
  assert.equal(result.status, 'failure')
  assert.equal(spawnCount, 0)
  assert.equal(result.checkpoint.tiers.producer.producerSpawnCount, 0)
})
