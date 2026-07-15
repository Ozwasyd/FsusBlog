import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalVitestId,
  mergeIsolatedTransformCaches,
  planRollingVitestPartitions,
  readLiveVitestGrant,
  resolveRollingVitestTopology,
  runRollingVitestCoordinator,
  validateExactVitestExecution
} from '../../tools/test/run-frontend-vitest-rolling-shards.mjs'

function catalog(count = 12, identityDigest = 'catalog-a') {
  return {
    schema: 'fsusblog.frontend-vitest-catalog.v1',
    identityDigest,
    files: Array.from({ length: count }, (_, index) => ({
      file: `/repo/tests/frontend/unit/file-${String(index).padStart(2, '0')}.test.ts`,
      projectName: 'unit',
      tests: [`suite ${index} > first`, `suite ${index} > second`]
    }))
  }
}

function partitions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `partition-${index + 1}`,
    files: [{ file: `/repo/file-${index}.test.ts`, tests: [`test ${index}`] }],
    identityDigest: `identity-${index}`,
    coverageUniverseOwner: index === 0
  }))
}

test('authoritative catalog exact-once validates files and test IDs, not only pass status', () => {
  const input = catalog(1)
  const file = input.files[0].file
  const report = {
    testResults: [{
      name: file,
      assertionResults: [
        { ancestorTitles: ['suite 0'], title: 'first', status: 'passed' },
        { fullName: 'suite 0 second', status: 'passed' }
      ]
    }]
  }
  assert.deepEqual(validateExactVitestExecution(input, [report]), {
    catalogFileCount: 1,
    catalogTestIdCount: 2,
    executedFileCount: 1,
    executedTestIdCount: 2,
    exactOnce: true
  })
  assert.match(canonicalVitestId(file, 'suite 0 > first'), /#suite 0 first$/u)
  assert.throws(() => validateExactVitestExecution(input, [report, report]), /duplicateFiles=1[\s\S]*duplicateTests=2/u)
  assert.throws(() => validateExactVitestExecution(input, [{ testResults: [] }]), /missingFiles=1[\s\S]*missingTests=2/u)
  const incomplete = structuredClone(report)
  incomplete.testResults[0].assertionResults.pop()
  assert.throws(() => validateExactVitestExecution(input, [incomplete]), /missingTests=1/u)
})

test('4/8/16/32 CPU models derive legal decoupled host, worker and partition topology', () => {
  for (const cpu of [4, 8, 16, 32]) {
    const topology = resolveRollingVitestTopology({ machineCpu: cpu, machineMemoryGiB: cpu * 1.5, fileCount: 100 })
    assert.ok(topology.hostLimit >= 1)
    assert.ok(topology.preferredWorkersPerHost >= 1)
    assert.ok(topology.hostLimit < cpu, `default topology must not create one full host per CPU at ${cpu} CPUs`)
    assert.ok(topology.partitionCount > topology.hostLimit)
    assert.ok(topology.partitionCount < 100, 'default topology must not create one process per file')
    assert.ok(topology.baseMemoryGiB + topology.memoryPerWorkerGiB <= topology.machineMemoryGiB)
  }
})

test('immutable LPT partitions are deterministic, balanced and bound to catalog identity', () => {
  const topology = resolveRollingVitestTopology({ machineCpu: 8, machineMemoryGiB: 12, fileCount: 24 })
  const first = planRollingVitestPartitions(catalog(24, 'catalog-a'), topology)
  const second = planRollingVitestPartitions(catalog(24, 'catalog-a'), topology)
  assert.deepEqual(first, second)
  assert.equal(new Set(first.flatMap((partition) => partition.files.map((entry) => entry.file))).size, 24)
  assert.equal(first.flatMap((partition) => partition.files).length, 24)
  assert.equal(first.filter((partition) => partition.coverageUniverseOwner).length, 1)
  const changed = planRollingVitestPartitions(catalog(24, 'catalog-b'), topology)
  assert.notEqual(first[0].identityDigest, changed[0].identityDigest)
})

test('live grant 1 to 2 to 4 admits additional hosts without duplicate partitions', async () => {
  const startedAt = Date.now()
  const launches = []
  const topology = {
    machineCpu: 4,
    preferredWorkersPerHost: 2,
    hostLimit: 3,
    baseMemoryGiB: 0.25,
    memoryPerWorkerGiB: 0.125
  }
  const result = await runRollingVitestCoordinator({
    partitions: partitions(7),
    topology,
    pollIntervalMs: 3,
    readGrant: () => {
      const elapsed = Date.now() - startedAt
      return { cpuUnits: elapsed < 15 ? 1 : elapsed < 35 ? 2 : 4, memoryGiB: 4, source: 'test' }
    },
    launchHost: async (entry) => {
      launches.push({ partitionId: entry.partition.id, workers: entry.workers, atMs: Date.now() - startedAt })
      await new Promise((resolve) => setTimeout(resolve, 70))
      return { code: 0, status: 'success' }
    }
  })
  assert.ok(result.grantHistory.some((entry) => entry.cpuUnits === 1))
  assert.ok(result.grantHistory.some((entry) => entry.cpuUnits === 2))
  assert.ok(result.grantHistory.some((entry) => entry.cpuUnits === 4))
  assert.equal(result.initialHostCount, 1)
  assert.equal(result.peakHostCount, 3)
  assert.ok(launches.some((entry) => entry.workers === 2))
  assert.equal(new Set(launches.map((entry) => entry.partitionId)).size, 7)
})

test('grant contraction never kills active hosts and blocks new claims until usage fits', async () => {
  const startedAt = Date.now()
  const launches = []
  const result = await runRollingVitestCoordinator({
    partitions: partitions(5),
    topology: {
      machineCpu: 4,
      preferredWorkersPerHost: 2,
      hostLimit: 2,
      baseMemoryGiB: 0.25,
      memoryPerWorkerGiB: 0.125
    },
    pollIntervalMs: 2,
    readGrant: () => ({ cpuUnits: Date.now() - startedAt < 10 ? 4 : 1, memoryGiB: 4, source: 'test' }),
    launchHost: async (entry) => {
      const ordinal = launches.length
      launches.push({ id: entry.partition.id, atMs: Date.now() - startedAt, workers: entry.workers })
      await new Promise((resolve) => setTimeout(resolve, ordinal === 0 ? 30 : 55))
      return { code: 0, status: 'success' }
    }
  })
  assert.equal(result.results.length, 5)
  assert.ok(launches[2].atMs >= 45, `new host started while contraction was overcommitted at ${launches[2].atMs}ms`)
  assert.equal(launches[2].workers, 1)
})

test('one host failure does not prevent independent partitions from being collected', async () => {
  const result = await runRollingVitestCoordinator({
    partitions: partitions(4),
    topology: {
      machineCpu: 4,
      preferredWorkersPerHost: 2,
      hostLimit: 2,
      baseMemoryGiB: 0.25,
      memoryPerWorkerGiB: 0.125
    },
    readGrant: () => ({ cpuUnits: 4, memoryGiB: 4 }),
    launchHost: async ({ partition }) => ({
      code: partition.id === 'partition-1' ? 7 : 0,
      status: partition.id === 'partition-1' ? 'failure' : 'success'
    })
  })
  assert.equal(result.results.length, 4)
  assert.equal(result.results.filter((entry) => entry.status === 'failure').length, 1)
  assert.equal(new Set(result.results.map((entry) => entry.partitionId)).size, 4)
})

test('cancellation stops coordinator admission while the runner owns process-group termination', async () => {
  const controller = new AbortController()
  const cancellationSignals = []
  const settleHosts = []
  let settledHostCount = 0
  const execution = runRollingVitestCoordinator({
    partitions: partitions(3),
    topology: {
      machineCpu: 2,
      preferredWorkersPerHost: 1,
      hostLimit: 2,
      baseMemoryGiB: 0.25,
      memoryPerWorkerGiB: 0.125
    },
    pollIntervalMs: 2,
    readGrant: () => ({ cpuUnits: 2, memoryGiB: 2 }),
    launchHost: () => new Promise((resolve) => { settleHosts.push(resolve) }).finally(() => { settledHostCount += 1 }),
    signal: controller.signal,
    cancelActive: (signal) => {
      cancellationSignals.push(signal)
      for (const settleHost of settleHosts) settleHost({ code: 143, signal })
    }
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(execution, /cancelled/u)
  assert.deepEqual(cancellationSignals, ['SIGTERM'])
  assert.equal(settledHostCount, 2)
})

test('deadline escalates to SIGKILL and drains an unresponsive active host before rejecting', async () => {
  const cancellationSignals = []
  let settleHost
  let settledHostCount = 0
  await assert.rejects(runRollingVitestCoordinator({
    partitions: partitions(1),
    topology: {
      machineCpu: 1,
      preferredWorkersPerHost: 1,
      hostLimit: 1,
      baseMemoryGiB: 0.25,
      memoryPerWorkerGiB: 0.125
    },
    pollIntervalMs: 2,
    deadlineAtMs: Date.now() + 10,
    cancellationGraceMs: 5,
    readGrant: () => ({ cpuUnits: 1, memoryGiB: 1 }),
    launchHost: () => new Promise((resolve) => { settleHost = resolve }).finally(() => { settledHostCount += 1 }),
    cancelActive: (signal) => {
      cancellationSignals.push(signal)
      if (signal === 'SIGKILL') settleHost?.({ code: 137, signal })
    }
  }), /exceeded its step deadline/u)
  assert.deepEqual(cancellationSignals, ['SIGTERM', 'SIGKILL'])
  assert.equal(settledHostCount, 1)
})

test('live grant is atomic, run-bound and fails closed on stale identity', () => {
  const env = {
    FSUSBLOG_TEST_RUN_ID: 'run-a',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/grant.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'vitest'
  }
  const document = {
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'run-a',
    grants: { vitest: { cpuUnits: 3, memoryGiB: 2.5 } }
  }
  assert.deepEqual(readLiveVitestGrant(env, () => JSON.stringify(document)), {
    cpuUnits: 3, memoryGiB: 2.5, source: 'scheduler-resource-grants'
  })
  assert.throws(() => readLiveVitestGrant(env, () => JSON.stringify({ ...document, runId: 'stale' })), /runId mismatch/u)
  assert.throws(() => readLiveVitestGrant({ FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/grant.json' }), /both grant file and tier id/u)
})

test('host-private transform caches merge deterministically and reject conflicting entries', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest-host-cache-'))
  const base = path.join(temporary, 'base')
  const first = path.join(temporary, 'first')
  const second = path.join(temporary, 'second')
  for (const directory of [base, first, second]) fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(base, 'seed'), 'seed')
  fs.writeFileSync(path.join(first, 'seed'), 'seed')
  fs.writeFileSync(path.join(first, 'one'), 'one')
  fs.writeFileSync(path.join(second, 'one'), 'one')
  fs.writeFileSync(path.join(second, 'two'), 'two')
  assert.deepEqual(mergeIsolatedTransformCaches(base, [second, first]), {
    hostCacheCount: 2, addedFiles: 2, identicalFiles: 2, metadataVariants: 0
  })
  fs.writeFileSync(path.join(second, 'seed'), 'corrupt')
  assert.throws(() => mergeIsolatedTransformCaches(base, [second]), /transform cache executable conflict: seed/u)
  fs.writeFileSync(path.join(base, 'variant'), 'code\n//# vitestCache=short')
  fs.writeFileSync(path.join(first, 'variant'), 'code\n//# vitestCache=longer-metadata')
  assert.deepEqual(mergeIsolatedTransformCaches(base, [first]), {
    hostCacheCount: 1, addedFiles: 0, identicalFiles: 2, metadataVariants: 1
  })
  assert.match(fs.readFileSync(path.join(base, 'variant'), 'utf8'), /longer-metadata/u)
  fs.rmSync(temporary, { recursive: true, force: true })
})

test('runner uses one authoritative catalog, isolated outputs and a real coverage-owner host', () => {
  const source = fs.readFileSync('tools/test/run-frontend-vitest-rolling-shards.mjs', 'utf8')
  const config = fs.readFileSync('src/frontend/vitest.production.config.ts', 'utf8')
  const privacyProjection = fs.readFileSync('tools/test/lanes/project-privacy-zk-production.mjs', 'utf8')
  assert.equal((source.match(/'vitest', 'list'/gu) ?? []).length, 1)
  assert.doesNotMatch(source, /__fsusblog_no_matching_test_file__|seedFullCoverageUniverse/u)
  assert.match(source, /runRollingVitestCoordinator[\s\S]*?readLiveVitestGrant/u)
  assert.match(source, /hostId.*partition\.id[\s\S]*?outputFile\.json[\s\S]*?outputFile\.junit[\s\S]*?outputFile\.blob/u)
  assert.match(source, /coverageUniverseOwner[\s\S]*?--coverage\.all=/u)
  assert.match(source, /cloneTransformCacheForHost[\s\S]*?COPYFILE_FICLONE/u)
  assert.match(source, /mergeIsolatedTransformCaches[\s\S]*?transform cache executable conflict/u)
  assert.match(source, /validateExactVitestExecution\(catalog, reports\)/u)
  assert.match(source, /terminateAllChildren\('SIGTERM'\)[\s\S]*?terminateAllChildren\('SIGKILL'\)/u)
  assert.match(source, /catalogIdentityDigest[\s\S]*?grantHistory[\s\S]*?hostStartupMs[\s\S]*?transformCache/u)
  assert.match(config, /FSUSBLOG_VITEST_ROLLING_HOST === '1'/u)
  assert.match(config, /FSUSBLOG_VITEST_COVERAGE_UNIVERSE_OWNER === '1'/u)
  assert.match(privacyProjection, /fsusblog\.frontend-vitest-rolling\.v2/u)
})
