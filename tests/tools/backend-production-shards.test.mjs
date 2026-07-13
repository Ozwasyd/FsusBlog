import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  aggregateCategoryDiscoveryFailures,
  aggregatePartitionExecutionFailures,
  aggregateProductionDiscoveryFailures,
  aggregateProjectionDiscoveryFailures,
  alignAuthoritativeDiscovery,
  backendDiscoveryEnvironment,
  backendPostgresContainerOwnerPid,
  backendProductionDatabaseNamespace,
  backendRunOwnerPid,
  backendPartitionEnvironment,
  buildPostgresAffinityGroups,
  buildPostgresCollectionPlanningWeights,
  buildShardPlan,
  deriveClassStartupPenalty,
  deriveColdApplicationStartupPenalty,
  deriveBackendPartitionCount,
  normalizeListedTestName,
  parseListedTests,
  parseTrxExecutionEvidence,
  parseTrxRecords,
  projectProductionUnionRecords,
  readManifestClassWideProductionExclusions,
  readBackendResourceGrantAfterBenchmark,
  readBackendSchedulerResourceGrant,
  resolveBackendShardParallelism,
  resolveBackendPotentialProcessCount,
  partitionGovernancePostlude,
  runAuthoritativeProductionDiscovery,
  runRollingPartitions,
  staleBackendBuildServerPids,
  staleBackendPostgresContainers,
  validateCategoryMembership,
  validateExactProductionUnion,
  validateShardRecords,
  validateShardSummaryArtifacts
} from '../../tools/test/run-backend-production-shards.mjs'

const root = path.resolve(import.meta.dirname, '../..')

test('backend production discovery normalizes theory cases to one filterable method', () => {
  assert.equal(normalizeListedTestName('Example.Tests.Rule(value: "a")'), 'Example.Tests.Rule')
  assert.equal(normalizeListedTestName('Example.Tests.Fact'), 'Example.Tests.Fact')
  assert.deepEqual(parseListedTests([
    'The following Tests are available:',
    '    Example.Tests.Fact',
    '    Example.Tests.Rule(value: "a")',
    '    Example.Tests.Rule(value: "b")',
    'Test Run Successful.'
  ].join('\n')), [
    'Example.Tests.Fact',
    'Example.Tests.Rule(value: "a")',
    'Example.Tests.Rule(value: "b")'
  ])
  assert.throws(() => parseListedTests([
    'The following Tests are available:',
    'Microsoft.VisualStudio.TestPlatform.ObjectModel.TestPlatformException: Testhost exited: missing dependency',
    '   at Example.Stack()'
  ].join('\n')), /discovery testhost failed:.*missing dependency/u)
})

test('backend production runs one authoritative discovery for union and trait projections', async () => {
  const startedFilters = []
  const run = runAuthoritativeProductionDiscovery((filter, slot) => {
    startedFilters.push(filter)
    assert.deepEqual(slot, { processSlot: 0, maxParallel: 1, kind: 'union', name: null })
    return Promise.resolve({ code: 0, signal: null, stdout: 'union', stderr: '', durationMs: 1 })
  })
  const result = await run
  assert.deepEqual(startedFilters, [null])
  assert.equal(result.discovery.stdout, 'union')
  assert.deepEqual(result.categoryDiscoveryRuns, [])
  assert.deepEqual(result.affinityDiscoveryRuns, [])
  assert.deepEqual(result.dependencyDiscoveryRuns, [])
  assert.equal(result.branchCount, 1)
  assert.equal(result.maxParallel, 1)
  await assert.rejects(
    runAuthoritativeProductionDiscovery(null),
    /runner must be a function/u
  )
})

test('backend production discovery splits inherited STEP and bundle grants across live branch slots', () => {
  const environments = Array.from({ length: 3 }, (_, processSlot) => backendDiscoveryEnvironment({
    KEEP: 'yes',
    FSUSBLOG_STEP_CPU_BUDGET: '8',
    FSUSBLOG_STEP_MEMORY_GIB: '32',
    FSUSBLOG_BUNDLE_CPU_UNITS: '8',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '8',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '32'
  }, {
    processSlot,
    maxParallel: 3,
    cpuBudget: 5,
    memoryGiB: 12
  }))
  assert.deepEqual(environments.map((env) => Number(env.FSUSBLOG_STEP_CPU_BUDGET)), [2, 2, 1])
  assert.deepEqual(environments.map((env) => Number(env.FSUSBLOG_STEP_MEMORY_GIB)), [4, 4, 4])
  assert.equal(environments.reduce((sum, env) => sum + Number(env.FSUSBLOG_BUNDLE_CPU_BUDGET), 0), 5)
  assert.equal(environments.reduce((sum, env) => sum + Number(env.FSUSBLOG_BUNDLE_MEMORY_GIB), 0), 12)
  for (const env of environments) {
    assert.equal(env.DOTNET_PROCESSOR_COUNT, '1')
    assert.equal(env.FSUSBLOG_BACKEND_CPU_BUDGET, env.FSUSBLOG_STEP_CPU_BUDGET)
    assert.equal(env.FSUSBLOG_BUNDLE_CPU_UNITS, env.FSUSBLOG_STEP_CPU_BUDGET)
    assert.equal(env.KEEP, 'yes')
  }
})

test('backend authoritative VSTest discovery aligns exactly with the console union', () => {
  const records = [
    { displayName: 'Example.Tests.One.Case', traits: {} },
    { displayName: 'Example.Tests.Two.Theory(value: 1)', traits: {} }
  ]
  assert.equal(alignAuthoritativeDiscovery([
    'Example.Tests.Two.Theory(value: 1)',
    'Example.Tests.One.Case'
  ], records), records)
  assert.throws(
    () => alignAuthoritativeDiscovery(['Example.Tests.One.Case'], records),
    /does not exactly match/u
  )
  assert.deepEqual(projectProductionUnionRecords([
    ...records,
    { displayName: 'Example.Tests.Integration.Case', traits: { Category: ['Integration', 'Concurrency'] } }
  ]), records)
})

test('backend governance postlude is an exact-one split and the two TRXs prove a passing union', () => {
  const governance = 'FsusBlog.Server.Tests.Unit.BackendTestGovernanceTests.Issue40Requirements_HaveEvidenceAndRiskTraceability'
  const union = ['Example.Tests.Other.Case', governance]
  const partition = partitionGovernancePostlude(union)
  assert.deepEqual(partition.main, ['Example.Tests.Other.Case'])
  assert.deepEqual(partition.postlude, [governance])
  assert.deepEqual(validateExactProductionUnion(union, [
    [{ testName: union[0], outcome: 'Passed' }],
    [{ testName: governance, outcome: 'Passed' }]
  ]), {
    executedTestCaseCount: 2,
    executedMethodCount: 2,
    exactOnce: true,
    allPassed: true
  })
  assert.throws(
    () => partitionGovernancePostlude(['Example.Tests.Other.Case']),
    /requires exactly one/u
  )
  assert.throws(
    () => validateExactProductionUnion(union, [
      [{ testName: governance, outcome: 'Passed' }],
      [{ testName: union[0], outcome: 'Passed' }]
    ]),
    /do not match their exact filters/u
  )
  const emojiCase = 'Example.Tests.Other.Theory(value: "🙂")'
  const authoritativeRecords = [
    { id: 'emoji-id', displayName: emojiCase },
    { id: 'governance-id', displayName: governance }
  ]
  assert.deepEqual(validateExactProductionUnion(
    authoritativeRecords.map((record) => record.displayName),
    [[{
      testId: 'emoji-id',
      testName: 'Example.Tests.Other.Theory(value: "\\ud83d\\ude42")',
      outcome: 'Passed'
    }], [{ testId: 'governance-id', testName: governance, outcome: 'Passed' }]],
    { authoritativeRecords }
  ), {
    executedTestCaseCount: 2,
    executedMethodCount: 2,
    exactOnce: true,
    allPassed: true
  })
})

test('backend PostgreSQL manifest projects exact classes as soft planning weights', () => {
  const manifest = {
    schema: 'fsusblog.postgres-test-collections.v1',
    collections: [
      {
        id: 'SchemaMigrationPostgresCollectionA',
        estimatedFacts: 3,
        tests: [
          { path: 'Unit/AlphaTests.cs', class: 'AlphaTests' },
          { path: 'Integration/ExcludedIntegrationTests.cs', class: 'ExcludedIntegrationTests' }
        ]
      },
      {
        id: 'SchemaMigrationPostgresCollectionB',
        estimatedFacts: 1,
        tests: [{ path: 'Unit/BetaTests.cs', class: 'BetaTests' }]
      }
    ]
  }
  const union = [
    'FsusBlog.Server.Tests.Unit.AlphaTests.First',
    'FsusBlog.Server.Tests.Unit.AlphaTests.Theory(value: 1)',
    'FsusBlog.Server.Tests.Unit.BetaTests.Second',
    'FsusBlog.Server.Tests.Unit.EndpointTests.Contract'
  ]
  const postgres = buildPostgresCollectionPlanningWeights(union, manifest, {
    excludedTestNames: ['FsusBlog.Server.Tests.Integration.ExcludedIntegrationTests.Case']
  })
  assert.deepEqual(postgres.map(({ name, estimatedFacts, excludedTestCaseCount, testClasses, testNames }) => ({
    name, estimatedFacts, excludedTestCaseCount, testClasses, testNames
  })), [
    {
      name: 'PostgresCollection=SchemaMigrationPostgresCollectionA',
      estimatedFacts: 3,
      excludedTestCaseCount: 1,
      testClasses: ['FsusBlog.Server.Tests.Unit.AlphaTests'],
      testNames: union.slice(0, 2)
    },
    {
      name: 'PostgresCollection=SchemaMigrationPostgresCollectionB',
      estimatedFacts: 1,
      excludedTestCaseCount: 0,
      testClasses: ['FsusBlog.Server.Tests.Unit.BetaTests'],
      testNames: [union[2]]
    }
  ])
  for (const weight of postgres) {
    weight.classStartupPenalty = deriveClassStartupPenalty(weight.testNames, weight.estimatedFacts)
  }
  const endpointWeight = { name: 'EndpointContractApplication', testNames: [union[1], union[3]] }
  endpointWeight.classStartupPenalty = deriveColdApplicationStartupPenalty(union.length)
  assert.equal(endpointWeight.classStartupPenalty, 2)
  const softPlan = buildShardPlan(union, 2, [1, 1], {
    affinityGroups: [],
    dependencyWeights: [
      ...postgres,
      endpointWeight
    ]
  })
  assert.deepEqual(softPlan.affinityAssignments, {})
  assert.notEqual(
    softPlan.methodsByShard.findIndex((methods) => methods.includes('FsusBlog.Server.Tests.Unit.AlphaTests.First')),
    softPlan.methodsByShard.findIndex((methods) => methods.includes('FsusBlog.Server.Tests.Unit.BetaTests.Second'))
  )
  const missing = structuredClone(manifest)
  missing.collections[1].tests[0].class = 'MissingTests'
  missing.collections[1].tests[0].path = 'Unit/MissingTests.cs'
  assert.throws(
    () => buildPostgresCollectionPlanningWeights(union, missing, {
      excludedTestNames: ['FsusBlog.Server.Tests.Integration.ExcludedIntegrationTests.Case']
    }),
    /must match exactly one authoritative VSTest class/u
  )
})

test('rolling production splits PostgreSQL collections by class while application startup stays a soft weight', () => {
  const source = fs.readFileSync('tools/test/run-backend-production-shards.mjs', 'utf8')
  const rollingStart = source.indexOf('const affinityTests = projectTraitMembership')
  const rollingEnd = source.indexOf('const partitioning = deriveBackendPartitionCount', rollingStart)
  const rollingSource = source.slice(rollingStart, rollingEnd)
  assert.match(rollingSource, /buildPostgresAffinityGroups/u)
  assert.match(rollingSource, /postgresGroups,\s*potentialProcessCount/u)
  assert.match(rollingSource, /\.\.\.applicationWeights/u)
  assert.match(rollingSource, /deriveColdApplicationStartupPenalty\(mainTestNames\.length\)/u)
  assert.doesNotMatch(rollingSource, /\.\.\.postgresGroups,[\s\S]*?\.\.\.applicationWeights/u)
  assert.match(source, /executionDriver: 'vstest-copy'/u)
  assert.doesNotMatch(source, /partition\.executionDriver === 'dotnet-test-project'/u)
})

test('PostgreSQL affinity groups scale deterministically and keep every class intact', () => {
  const groups = [{
    name: 'PostgresCollection=A',
    testNames: ['Example.A.One', 'Example.A.Two']
  }, {
    name: 'PostgresCollection=B',
    testNames: [
      'Example.B1.One', 'Example.B1.Two', 'Example.B1.Three',
      'Example.B2.One', 'Example.B2.Two',
      'Example.B3.One'
    ]
  }]
  const two = buildPostgresAffinityGroups(groups, 2)
  assert.deepEqual(two, groups)
  const three = buildPostgresAffinityGroups(groups, 3)
  assert.equal(three.length, 3)
  assert.deepEqual(three.flatMap((group) => group.testNames).sort(), groups.flatMap((group) => group.testNames).sort())
  const classToGroup = new Map()
  for (const [groupIndex, group] of three.entries()) {
    for (const testName of group.testNames) {
      const className = testName.split('.').slice(0, -1).join('.')
      assert.ok(!classToGroup.has(className) || classToGroup.get(className) === groupIndex)
      classToGroup.set(className, groupIndex)
    }
  }
  const machineMaximum = buildPostgresAffinityGroups(groups, 8)
  assert.equal(machineMaximum.length, 4)
  assert.deepEqual(
    machineMaximum.map((group) => group.testNames.length).sort((left, right) => left - right),
    [1, 2, 2, 3]
  )
  assert.throws(() => buildPostgresAffinityGroups(groups, 1), /cannot be smaller/u)
})

test('backend PostgreSQL planning admits only source-proven class-wide production exclusions', () => {
  const manifest = {
    schema: 'fsusblog.postgres-test-collections.v1',
    collections: [{
      id: 'SchemaMigrationPostgresCollectionA',
      estimatedFacts: 3,
      tests: [
        { path: 'Unit/AlphaTests.cs', class: 'AlphaTests' },
        { path: 'Integration/ExcludedTests.cs', class: 'ExcludedTests' }
      ]
    }, {
      id: 'SchemaMigrationPostgresCollectionB',
      estimatedFacts: 1,
      tests: [{ path: 'Unit/BetaTests.cs', class: 'BetaTests' }]
    }]
  }
  const sources = new Map([
    ['/repo/tests/backend/Unit/AlphaTests.cs', 'public sealed class AlphaTests {}'],
    ['/repo/tests/backend/Integration/ExcludedTests.cs', '[Trait("Category", "Integration")]\npublic sealed class ExcludedTests {}'],
    ['/repo/tests/backend/Unit/BetaTests.cs', 'public sealed class BetaTests {}']
  ])
  const exclusions = readManifestClassWideProductionExclusions(manifest, {
    repositoryRoot: '/repo',
    readFile: (file) => sources.get(file)
  })
  assert.deepEqual(exclusions, ['ExcludedTests'])
  const projected = buildPostgresCollectionPlanningWeights([
    'Example.Unit.AlphaTests.One',
    'Example.Unit.AlphaTests.Two',
    'Example.Unit.BetaTests.One'
  ], manifest, { manifestExcludedClasses: exclusions })
  assert.deepEqual(projected.map(({ excludedTestCaseCount }) => excludedTestCaseCount), [1, 0])
})

test('backend production discovery captures a rejected authoritative union', async () => {
  const started = []
  const batch = await runAuthoritativeProductionDiscovery(async (filter) => {
    started.push(filter)
    await Promise.resolve()
    throw new Error('spawn failed')
  })
  assert.deepEqual(started, [null])
  const failure = aggregateProductionDiscoveryFailures(batch)
  assert.ok(failure instanceof AggregateError)
  assert.match(failure.message, /1 independent branches: production-union/u)
  assert.deepEqual(failure.errors.map(({ message }) => message), [
    'production-union: spawn failed'
  ])
})

test('backend production partition environment replaces every inherited STEP and bundle resource grant', () => {
  assert.deepEqual(backendPartitionEnvironment({
    KEEP: 'yes',
    DOTNET_PROCESSOR_COUNT: '8',
    FSUSBLOG_BACKEND_CPU_BUDGET: '8',
    FSUSBLOG_STEP_CPU_BUDGET: '8',
    FSUSBLOG_STEP_MEMORY_GIB: '32',
    FSUSBLOG_BUNDLE_CPU_UNITS: '8',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '8',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '32'
  }, {
    processors: 2,
    memoryGiB: 3.5,
    namespace: 'run-partition-0',
    tempDirectory: '/repo/.tmp/test-results/backend/production/tmp/shard-0'
  }), {
    KEEP: 'yes',
    DOTNET_PROCESSOR_COUNT: '2',
    FSUSBLOG_BACKEND_CPU_BUDGET: '2',
    FSUSBLOG_STEP_CPU_BUDGET: '2',
    FSUSBLOG_STEP_MEMORY_GIB: '3.5',
    FSUSBLOG_BUNDLE_CPU_UNITS: '2',
    FSUSBLOG_BUNDLE_CPU_BUDGET: '2',
    FSUSBLOG_BUNDLE_MEMORY_GIB: '3.5',
    FSUSBLOG_BACKEND_DB_NAMESPACE: 'run-partition-0',
    TMPDIR: '/repo/.tmp/test-results/backend/production/tmp/shard-0',
    TMP: '/repo/.tmp/test-results/backend/production/tmp/shard-0',
    TEMP: '/repo/.tmp/test-results/backend/production/tmp/shard-0'
  })
  assert.throws(() => backendPartitionEnvironment({}, {
    processors: 0,
    memoryGiB: 1,
    namespace: 'invalid'
  }), /processors must be a positive integer/u)
  assert.throws(() => backendPartitionEnvironment({}, {
    processors: 1,
    memoryGiB: 1,
    namespace: 'invalid',
    tempDirectory: 'relative/tmp'
  }), /temp directory must be absolute/u)
})

test('backend production resource cleanup selects only containers whose encoded testhost owner is dead', () => {
  const active = 'fsus-pg-bp-0123456789-m-4321-aabbccdd'
  const stale = 'fsus-pg-production-2026-07-9876-deadbeef'
  const unrelated = 'fsusblog-dev-postgres'
  assert.equal(backendPostgresContainerOwnerPid(active), 4321)
  assert.equal(backendPostgresContainerOwnerPid(stale), 9876)
  assert.equal(backendPostgresContainerOwnerPid(unrelated), null)
  assert.deepEqual(staleBackendPostgresContainers([active, stale, unrelated], {
    processExists: (pid) => pid === 4321
  }), [stale])
  assert.throws(() => staleBackendPostgresContainers('not-an-array'), /container-name array/u)
})

test('backend production database namespace is short, deterministic, and role-isolated', () => {
  const main = backendProductionDatabaseNamespace('main', { runId: 'production-run', runnerPid: 42 })
  const repeated = backendProductionDatabaseNamespace('main', { runId: 'production-run', runnerPid: 42 })
  const postlude = backendProductionDatabaseNamespace('postlude', { runId: 'production-run', runnerPid: 42 })
  assert.equal(main, repeated)
  assert.notEqual(main, postlude)
  assert.ok(main.length <= 18)
  assert.match(main, /^bp-[0-9a-f]{10}-m$/u)
  assert.match(postlude, /^bp-[0-9a-f]{10}-p$/u)
  assert.throws(() => backendProductionDatabaseNamespace('unknown'), /unknown backend database namespace role/u)
})

test('backend production build-server cleanup is limited to the current or dead-owner scheduler run', () => {
  const command = [
    '/usr/lib/dotnet/dotnet',
    '/usr/lib/dotnet/sdk/10.0.108/MSBuild.dll',
    '/noautoresponse',
    '/nologo',
    '/nodemode:1',
    '/nodeReuse:true',
    '/low:false'
  ]
  const record = (pid, runId, namespace, overrides = {}) => ({
    pid,
    ppid: 1,
    startTimeTicks: String(1_000 + pid),
    cwd: root,
    args: command,
    env: {
      FSUSBLOG_TEST_RUN_ID: runId,
      FSUSBLOG_TEST_NAMESPACE: namespace
    },
    ...overrides
  })
  const currentRunId = 'production-2026-07-12_12-07-56-517-700'
  const staleRunId = 'production-2026-07-12_12-07-56-517-701'
  const activeRunId = 'production-2026-07-12_12-07-56-517-702'
  const processes = [
    record(100, currentRunId, 'current-tier'),
    record(101, staleRunId, `${staleRunId}-fresh-local-production-0`),
    record(102, activeRunId, `${activeRunId}-fresh-local-production-0`),
    record(103, currentRunId, 'current-tier', { args: ['/usr/lib/dotnet/dotnet', 'testhost.dll'] }),
    record(104, '', ''),
    record(105, currentRunId, 'other-live-tier'),
    record(106, 'backend-focused-20260712', 'manual-tier'),
    record(107, currentRunId, 'current-tier', { ppid: 900 })
  ]
  assert.equal(backendRunOwnerPid(currentRunId), 700)
  assert.equal(backendRunOwnerPid('backend-focused-20260712'), null)
  assert.equal(backendRunOwnerPid('standalone'), null)
  assert.deepEqual(staleBackendBuildServerPids(processes, {
    repositoryRoot: root,
    currentRunId,
    currentNamespace: 'current-tier',
    includeInactiveProductionRuns: true,
    isRunActive: (runId) => runId === activeRunId
  }), [100, 101])
  const source = fs.readFileSync(path.join(root, 'tools/test-matrix/dotnet-build-server-cleanup.mjs'), 'utf8')
  assert.match(source, /observed\.ppid === expected\.ppid/u)
  assert.match(source, /observed\.startTimeTicks === expected\.startTimeTicks/u)
  assert.match(source, /observed\.args\.join\('\\0'\) === expected\.args\.join\('\\0'\)/u)
})

test('backend production shard plan is deterministic, mutually exclusive, and exhaustive', () => {
  const names = Array.from({ length: 40 }, (_, index) => `Example.Tests.Class${index}.Case`)
  names.push('Example.Tests.TheoryClass.Theory(value: 1)', 'Example.Tests.TheoryClass.Theory(value: 2)')
  const first = buildShardPlan(names, 2)
  const second = buildShardPlan([...names].reverse(), 2)
  assert.deepEqual(first.methodsByShard, second.methodsByShard)
  assert.equal(first.testCaseCount, names.length)
  assert.equal(first.methodCounts.get('Example.Tests.TheoryClass.Theory'), 2)
  assert.deepEqual(first.plannedTestCaseCountsByShard, [21, 21])
  const flattened = first.methodsByShard.flat()
  assert.equal(new Set(flattened).size, flattened.length)
  assert.deepEqual([...flattened].sort(), [...first.methodCounts.keys()].sort())

  const weighted = buildShardPlan(
    Array.from({ length: 12 }, (_, index) => `Example.Tests.Weighted${index}.Case`),
    3,
    [2, 1, 1]
  )
  assert.deepEqual(weighted.plannedTestCaseCountsByShard, [6, 3, 3])
  assert.throws(() => buildShardPlan(names, 3, [2, 1]), /positive processor allocation/u)
})

test('backend production shard plan keeps a discovered affinity group on one deterministic shard', () => {
  const names = [
    'Example.Tests.EndpointClass.EndpointA(value: 1)',
    'Example.Tests.EndpointClass.EndpointA(value: 2)',
    'Example.Tests.EndpointClass.EndpointB',
    'Example.Tests.EndpointClass.UntaggedHelper',
    ...Array.from({ length: 9 }, (_, index) => `Example.Tests.Other${index}.Case`)
  ]
  const affinityGroups = [{
    name: 'EndpointContractApplication',
    testNames: [
      'Example.Tests.EndpointClass.EndpointB',
      'Example.Tests.EndpointClass.EndpointA(value: 1)',
      'Example.Tests.EndpointClass.EndpointA(value: 2)'
    ]
  }]
  const first = buildShardPlan(names, 2, [2, 2], { affinityGroups })
  const second = buildShardPlan([...names].reverse(), 2, [2, 2], { affinityGroups })
  assert.deepEqual(first.methodsByShard, second.methodsByShard)
  assert.deepEqual(first.affinityAssignments.EndpointContractApplication, {
    shardId: 0,
    actualTestCaseCount: 4,
    affinityTaggedTestCaseCount: 3,
    startupWeight: 4,
    planningWeight: 8
  })
  const affinityShard = first.affinityAssignments.EndpointContractApplication.shardId
  assert.ok(Number.isInteger(affinityShard))
  assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.EndpointA'))
  assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.EndpointB'))
  assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.UntaggedHelper'))
  assert.ok(first.methodsByShard.every((methods, index) => (
    index === affinityShard || (!methods.includes('Example.Tests.EndpointClass.EndpointA') && !methods.includes('Example.Tests.EndpointClass.EndpointB'))
  )))
  assert.equal(first.plannedTestCaseCountsByShard.reduce((total, count) => total + count, 0), names.length)
  assert.equal(first.planningWeightsByShard.reduce((total, count) => total + count, 0), names.length + 4)
  assert.ok(first.plannedTestCaseCountsByShard[affinityShard] < first.plannedTestCaseCountsByShard[1 - affinityShard])
  assert.throws(() => buildShardPlan(names, 2, [1, 1], {
    affinityGroups: [{ name: 'outside', testNames: ['Example.Tests.Missing'] }]
  }), /outside the production union/u)
  assert.throws(() => buildShardPlan(names, 2, [1, 1], {
    affinityGroups: [{ name: 'partial-theory', testNames: ['Example.Tests.EndpointClass.EndpointA(value: 1)'] }]
  }), /case count mismatch/u)
})

test('backend production shard plan keeps ordinary test classes intact to avoid repeated fixture startup', () => {
  const names = Array.from({ length: 9 }, (_, classIndex) => (
    Array.from({ length: classIndex + 1 }, (_, methodIndex) => (
      `Example.Tests.Class${classIndex}.Method${methodIndex}`
    ))
  )).flat()
  const plan = buildShardPlan(names, 3, [1, 1, 1])
  assert.equal(plan.partitionUnitKind, 'test-class')
  for (let classIndex = 0; classIndex < 9; classIndex += 1) {
    const shards = plan.methodsByShard
      .map((methods, shardId) => methods.some((method) => method.startsWith(`Example.Tests.Class${classIndex}.`)) ? shardId : -1)
      .filter((shardId) => shardId >= 0)
    assert.equal(shards.length, 1, `Class${classIndex} must not be split across shards`)
  }
  assert.equal(plan.plannedTestCaseCountsByShard.reduce((total, count) => total + count, 0), names.length)

  assert.throws(() => buildShardPlan([
    'Example.Tests.One',
    'Example.Tests.Two',
    'Example.Tests.Three'
  ], 2, [1, 1]), /indivisible class\/affinity units/u)
})

test('backend production shard plan merges overlapping affinity groups as deterministic transitive components', () => {
  const connected = ['A', 'B', 'C', 'D'].map((name) => `Example.Tests.${name}.Case`)
  const names = [
    ...connected,
    ...Array.from({ length: 8 }, (_, index) => `Example.Tests.Other${index}.Case`)
  ]
  const affinityGroups = [
    { name: 'endpoint', testNames: connected.slice(0, 2) },
    { name: 'postgres-a', testNames: connected.slice(1, 3) },
    { name: 'postgres-b', testNames: connected.slice(2, 4) }
  ]
  const first = buildShardPlan(names, 2, [1, 1], { affinityGroups })
  const second = buildShardPlan([...names].reverse(), 2, [1, 1], {
    affinityGroups: [...affinityGroups].reverse()
  })
  assert.deepEqual(first.methodsByShard, second.methodsByShard)
  const shardIds = new Set(['endpoint', 'postgres-a', 'postgres-b']
    .map((name) => first.affinityAssignments[name].shardId))
  assert.equal(shardIds.size, 1)
  const [componentShard] = shardIds
  assert.ok(connected.every((method) => first.methodsByShard[componentShard].includes(method)))
  for (const name of ['endpoint', 'postgres-a', 'postgres-b']) {
    assert.equal(first.affinityAssignments[name].actualTestCaseCount, connected.length)
    assert.equal(first.affinityAssignments[name].affinityTaggedTestCaseCount, connected.length)
  }
  const partitioning = deriveBackendPartitionCount(names, {
    maxConcurrentProcesses: 3,
    potentialConcurrentProcesses: 10,
    affinityGroups
  })
  assert.equal(partitioning.affinityUnitCount, 1)
  assert.equal(partitioning.planningUnitCount, 9)
  assert.equal(partitioning.partitionCount, 9)
})

test('backend production reserves distinct shards for independent affinity components', () => {
  const names = [
    'Example.Tests.PostgresA.One',
    'Example.Tests.PostgresB.One',
    ...Array.from({ length: 8 }, (_, index) => `Example.Tests.Regular${index}.Case`)
  ]
  const plan = buildShardPlan(names, 3, [1, 1, 1], {
    affinityGroups: [
      { name: 'PostgresA', testNames: [names[0]] },
      { name: 'PostgresB', testNames: [names[1]] }
    ]
  })
  assert.notEqual(plan.affinityAssignments.PostgresA.shardId, plan.affinityAssignments.PostgresB.shardId)

  const exclusive = buildShardPlan(names, 3, [1, 1, 1], {
    affinityGroups: [
      { name: 'PostgresA', testNames: [names[0]] },
      { name: 'PostgresB', testNames: [names[1]] }
    ],
    exclusiveAffinityGroups: ['PostgresA', 'PostgresB']
  })
  const reserved = new Set([
    exclusive.affinityAssignments.PostgresA.shardId,
    exclusive.affinityAssignments.PostgresB.shardId
  ])
  for (const shardId of reserved) assert.equal(exclusive.methodsByShard[shardId].length, 1)
  assert.equal(exclusive.methodsByShard.find((_, index) => !reserved.has(index)).length, names.length - 2)
})

test('backend production shard plan weights Docker cases independently without creating dependency affinity', () => {
  const affinityTests = ['Example.Tests.EndpointClass.EndpointA', 'Example.Tests.EndpointClass.EndpointB']
  const dockerTests = [
    'Example.Tests.EndpointClass.EndpointA',
    ...Array.from({ length: 6 }, (_, index) => `Example.Tests.Docker${index}.Case`)
  ]
  const names = [
    ...affinityTests,
    ...dockerTests.slice(1),
    ...Array.from({ length: 6 }, (_, index) => `Example.Tests.Other${index}.Case`)
  ]
  const options = {
    affinityGroups: [{ name: 'EndpointContractApplication', testNames: affinityTests }],
    dependencyWeights: [{ name: 'Docker', testNames: dockerTests }]
  }
  const first = buildShardPlan(names, 2, [2, 2], options)
  const second = buildShardPlan([...names].reverse(), 2, [2, 2], options)
  assert.deepEqual(first.methodsByShard, second.methodsByShard)
  assert.equal(first.affinityAssignments.EndpointContractApplication.planningWeight, 5)
  assert.equal(first.planningWeightsByShard.reduce((total, weight) => total + weight, 0), names.length + 2 + dockerTests.length)
  const dockerAssignment = first.dependencyWeightAssignments.Docker
  assert.equal(dockerAssignment.actualTestMethodCount, 7)
  assert.equal(dockerAssignment.actualTestCaseCount, 7)
  assert.equal(dockerAssignment.planningMultiplier, 2)
  assert.equal(dockerAssignment.additionalPlanningWeight, 7)
  assert.equal(dockerAssignment.weightedPlanningWeight, 14)
  assert.deepEqual(dockerAssignment.testMethods, [...dockerTests].sort())
  assert.ok(dockerAssignment.plannedTestMethodCountsByShard.every((count) => count > 0))
  assert.ok(dockerAssignment.plannedTestCaseCountsByShard.every((count) => count > 0))
  assert.equal(dockerAssignment.plannedTestMethodCountsByShard.reduce((sum, count) => sum + count, 0), 7)
  assert.equal(dockerAssignment.plannedTestCaseCountsByShard.reduce((sum, count) => sum + count, 0), 7)
  assert.throws(() => buildShardPlan(names, 2, [2, 2], {
    dependencyWeights: [{ name: 'Docker', testNames: ['Example.Tests.Outside'] }]
  }), /outside the production union/u)
  assert.throws(() => buildShardPlan(names, 2, [2, 2], {
    dependencyWeights: [{
      name: 'Docker',
      testNames: ['Example.Tests.EndpointClass.EndpointA', 'Example.Tests.EndpointClass.EndpointA']
    }]
  }), /case count exceeds the production union/u)
})

test('backend production parallelism derives rolling process capacity from live CPU and memory budgets', () => {
  const resolve = (cpuBudget, memoryGiB = 64, availableCpu = cpuBudget) => (
    resolveBackendShardParallelism({
      env: {
        FSUSBLOG_BACKEND_CPU_BUDGET: String(cpuBudget),
        FSUSBLOG_BUNDLE_MEMORY_GIB: String(memoryGiB)
      },
      availableCpu,
      availableMemoryGiB: 1,
      totalMemoryGiB: 64
    })
  )
  const expected = [2, 3, 4, 8, 12, 16].map((cpuBudget) => [
    cpuBudget,
    cpuBudget,
    Array.from({ length: cpuBudget }, () => 1)
  ])
  for (const [cpuBudget, processCount, processorsByProcess] of expected) {
    const parallelism = resolve(cpuBudget)
    assert.equal(parallelism.maxConcurrentProcesses, processCount)
    assert.deepEqual(parallelism.processorsByProcess, processorsByProcess)
    assert.equal(parallelism.memoryGiBByProcess.length, processCount)
    assert.ok(Math.abs(parallelism.memoryGiBByProcess.reduce((sum, value) => sum + value, 0) - 64) < 1e-9)
    assert.equal(parallelism.allocatedCpuUnits, cpuBudget)
    assert.equal(parallelism.derivation.source, 'machine-derived')
    assert.equal(
      parallelism.derivation.formula,
      'min(cpuBudget,scheduler-admitted CPU capacity); explicit memory grant trusted'
    )
  }

  assert.equal(resolve(16, 3).maxConcurrentProcesses, 16)
  assert.equal(resolve(16, 2.25).maxConcurrentProcesses, 16)
  assert.equal(resolve(2, 1.99).maxConcurrentProcesses, 2)
  assert.throws(() => resolve(1, 64), /at least two available CPU units/u)

  const diagnosticOverride = resolveBackendShardParallelism({
    env: {
      FSUSBLOG_BACKEND_CPU_BUDGET: '12',
      FSUSBLOG_BUNDLE_MEMORY_GIB: '48',
      FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
    },
    availableCpu: 16,
    availableMemoryGiB: 1,
    totalMemoryGiB: 64
  })
  assert.equal(diagnosticOverride.maxConcurrentProcesses, 3)
  assert.deepEqual(diagnosticOverride.processorsByProcess, [4, 4, 4])
  assert.deepEqual(diagnosticOverride.memoryGiBByProcess, [16, 16, 16])
  assert.deepEqual(diagnosticOverride.derivation, {
    source: 'diagnostic-override',
    formula: 'min(cpuBudget,scheduler-admitted CPU capacity); explicit memory grant trusted',
    derivedProcessCount: 12,
    configuredProcessCount: 3,
    cpuAllocationFormula: 'floor(cpuBudget/processCount) plus one for the first cpuBudget%processCount processes',
    configuredProcessorsPerProcess: null,
    memoryAllocationFormula: 'memoryGiB*(processCpuUnits/allocatedCpuUnits)'
  })
  assert.equal(resolveBackendShardParallelism({
    env: {
      FSUSBLOG_BACKEND_CPU_BUDGET: '8',
      FSUSBLOG_BUNDLE_MEMORY_GIB: '16',
      FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
    },
    availableCpu: 8,
    availableMemoryGiB: 1,
    totalMemoryGiB: 64
  }).maxConcurrentProcesses, 3)
  assert.throws(() => resolveBackendShardParallelism({
    env: {
      FSUSBLOG_BACKEND_CPU_BUDGET: '8',
      FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3'
    },
    availableCpu: 8,
    availableMemoryGiB: 16,
    totalMemoryGiB: 64
  }), /exceeds memory budget limit 2/u)
  assert.throws(() => resolveBackendShardParallelism({
    env: {
      FSUSBLOG_BACKEND_CPU_BUDGET: '8',
      FSUSBLOG_BUNDLE_MEMORY_GIB: '64',
      FSUSBLOG_BACKEND_PRODUCTION_SHARDS: '3',
      FSUSBLOG_BACKEND_SHARD_PROCESSORS: '3'
    },
    availableCpu: 8,
    availableMemoryGiB: 64
  }), /allocation \[3,3,3\] must exactly consume CPU budget 8/u)
  assert.throws(() => resolveBackendShardParallelism({
    env: { FSUSBLOG_BACKEND_CPU_BUDGET: '8x', FSUSBLOG_BUNDLE_MEMORY_GIB: '8' },
    availableCpu: 8,
    availableMemoryGiB: 64
  }), /CPU budget must be a positive integer/u)
  assert.throws(() => resolveBackendShardParallelism({
    env: { FSUSBLOG_BACKEND_CPU_BUDGET: '8', FSUSBLOG_BUNDLE_MEMORY_GIB: '8GiB' },
    availableCpu: 8,
    availableMemoryGiB: 64
  }), /memory budget must be a positive number/u)
})

test('backend production derives more rolling partitions than processes from discovered class units', () => {
  const names = Array.from({ length: 11 }, (_, index) => `Example.Tests.Class${index}.Case`)
  const affinityGroups = [{
    name: 'endpoint',
    testNames: [names[0], names[1]]
  }]
  assert.deepEqual(deriveBackendPartitionCount(names, {
    maxConcurrentProcesses: 3,
    affinityGroups
  }), {
    partitionCount: 6,
    planningUnitCount: 10,
    testClassCount: 9,
    affinityUnitCount: 1,
    formula: 'min(planningUnitCount,processCount+min(processCount,planningUnitCount-processCount))'
  })
  assert.deepEqual(deriveBackendPartitionCount(names.slice(0, 5), {
    maxConcurrentProcesses: 3
  }).partitionCount, 5)
  assert.throws(() => deriveBackendPartitionCount(names.slice(0, 3), {
    maxConcurrentProcesses: 3
  }), /requires more than 3 indivisible/u)

  assert.deepEqual(deriveBackendPartitionCount(names, {
    maxConcurrentProcesses: 3,
    potentialConcurrentProcesses: 8,
    affinityGroups
  }), {
    partitionCount: 8,
    planningUnitCount: 10,
    testClassCount: 9,
    affinityUnitCount: 1,
    formula: 'min(planningUnitCount,potentialConcurrentProcesses)'
  })
  assert.equal(deriveBackendPartitionCount(names, {
    maxConcurrentProcesses: 3,
    potentialConcurrentProcesses: 5,
    affinityGroups
  }).partitionCount, 5)
})

test('backend production scheduler grant validation fails closed and derives host-bounded potential', () => {
  const env = {
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE: '/tmp/resource-grants.json',
    FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID: 'backend',
    FSUSBLOG_TEST_RUN_ID: 'run-one'
  }
  const document = {
    schema: 'fsusblog.test-matrix.resource-grants.v1',
    runId: 'run-one',
    resourceBudget: { cpuUnits: 8, memoryGiB: 12 },
    grants: { backend: { cpuUnits: 3, memoryGiB: 4.5 } }
  }
  const grant = readBackendSchedulerResourceGrant({
    env,
    readFile: () => JSON.stringify(document)
  })
  assert.deepEqual({
    tierId: grant.tierId,
    runId: grant.runId,
    cpuUnits: grant.cpuUnits,
    memoryGiB: grant.memoryGiB,
    resourceBudget: grant.resourceBudget
  }, {
    tierId: 'backend',
    runId: 'run-one',
    cpuUnits: 3,
    memoryGiB: 4.5,
    resourceBudget: { cpuUnits: 8, memoryGiB: 12 }
  })
  assert.equal(resolveBackendPotentialProcessCount(grant, {
    availableCpu: 8,
    totalMemoryGiB: 16
  }), 8)
  assert.throws(() => readBackendSchedulerResourceGrant({
    env,
    readFile: () => JSON.stringify({ ...document, runId: 'run-two' })
  }), /runId mismatch/u)
  assert.throws(() => readBackendSchedulerResourceGrant({
    env,
    readFile: () => JSON.stringify({ ...document, grants: {} })
  }), /missing tier backend/u)
  assert.throws(() => readBackendSchedulerResourceGrant({
    env,
    readFile: () => JSON.stringify({ ...document, schema: 'unknown' })
  }), /invalid schema/u)
  assert.throws(() => resolveBackendPotentialProcessCount(grant, {
    availableCpu: 7,
    totalMemoryGiB: 16
  }), /exceeds host CPU or memory/u)
  assert.throws(() => readBackendResourceGrantAfterBenchmark({
    env: { FSUSBLOG_TEST_RUN_ID: 'run-one' },
    initialGrant: { cpuUnits: 3, memoryGiB: 4.5 },
    repositoryRoot: '/repo',
    exists: () => true,
    readFile: () => JSON.stringify({
      schema: 'fsusblog.local-production.benchmark-build-ready.v1',
      status: 'success',
      physicalBundleId: 'backend-tests',
      schedulerRunId: 'another-run'
    }),
    readSchedulerGrant: () => grant
  }), /not bound to run run-one/u)
  assert.equal(readBackendSchedulerResourceGrant({ env: {} }), null)
})

test('backend production rolling partitions keep the process bound, refill slots, and aggregate all failures', async () => {
  const partitions = Array.from({ length: 5 }, (_, index) => ({ index }))
  const gates = partitions.map(() => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  })
  const started = []
  let active = 0
  let peakActive = 0
  let activeCpu = 0
  let peakCpu = 0
  const rolling = runRollingPartitions(partitions, [2, 1], async (partition, slot) => {
    started.push({ id: partition.index, slot: slot.processSlot, processors: slot.processors })
    active += 1
    activeCpu += slot.processors
    peakActive = Math.max(peakActive, active)
    peakCpu = Math.max(peakCpu, activeCpu)
    const result = await gates[partition.index].promise
    active -= 1
    activeCpu -= slot.processors
    return { index: partition.index, code: result.code, signal: null }
  })

  await Promise.resolve()
  assert.deepEqual(started.map(({ id }) => id), [0, 1])
  gates[0].resolve({ code: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.slice(0, 3).map(({ id }) => id), [0, 1, 2])
  assert.equal(started[2].slot, started[0].slot)

  gates[1].resolve({ code: 1 })
  gates[2].resolve({ code: 0 })
  await new Promise((resolve) => setImmediate(resolve))
  for (const id of started.slice(3).map(({ id }) => id)) gates[id].resolve({ code: id === 4 ? 2 : 0 })
  await new Promise((resolve) => setImmediate(resolve))
  for (let id = 0; id < gates.length; id += 1) gates[id].resolve({ code: id === 4 ? 2 : 0 })
  const outcomes = await rolling
  assert.equal(peakActive, 2)
  assert.equal(peakCpu, 3)
  assert.deepEqual(outcomes.map(({ value }) => value.index), [0, 1, 2, 3, 4])
  const failure = aggregatePartitionExecutionFailures(outcomes)
  assert.ok(failure instanceof AggregateError)
  assert.equal(failure.errors.length, 2)
  assert.deepEqual(failure.errors.map(({ message }) => message), [
    'partition 1: exit 1',
    'partition 4: exit 2'
  ])
})

test('backend production rolling partitions expand deterministically from a 3-unit grant to machine potential', async () => {
  const partitions = Array.from({ length: 8 }, (_, index) => ({ index }))
  const gates = partitions.map(() => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  })
  let grant = { cpuUnits: 3, memoryGiB: 3 }
  let publishGrant
  const started = []
  const rolling = runRollingPartitions(partitions, [1, 1, 1], async (partition, slot) => {
    started.push({ partition: partition.index, ...slot })
    await gates[partition.index].promise
    return { index: partition.index, code: 0, signal: null }
  }, {
    initialMemoryGiBByProcess: [1, 1, 1],
    readResourceGrant: () => grant,
    potentialProcessCount: 8,
    potentialMemoryGiB: 8,
    waitForResourceChange: () => new Promise((resolve) => { publishGrant = resolve })
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, 3)
  grant = { cpuUnits: 8, memoryGiB: 8 }
  publishGrant()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, 8)
  assert.equal(new Set(started.map(({ processSlot }) => processSlot)).size, 8)
  assert.equal(started.reduce((sum, { processors }) => sum + processors, 0), 8)
  assert.ok(started.every(({ memoryGiB }) => memoryGiB === 1))
  assert.ok(started.every(({ processSlot }) => processSlot < partitions.length))

  for (const gate of gates) gate.resolve()
  const outcomes = await rolling
  assert.deepEqual(outcomes.map(({ value }) => value.index), partitions.map(({ index }) => index))
  assert.deepEqual(outcomes.rollingExecution, {
    dynamic: true,
    initialConcurrentProcesses: 3,
    peakConcurrentProcesses: 8,
    potentialConcurrentProcesses: 8,
    slots: Array.from({ length: 8 }, (_, processSlot) => ({
      processSlot,
      processors: 1,
      memoryGiB: 1
    })),
    observedGrant: { cpuUnits: 8, memoryGiB: 8 }
  })
})

test('backend production rolling partitions bind unstarted slots to a smaller live memory grant', async () => {
  const partitions = [{ index: 0 }, { index: 1 }]
  const started = []
  const outcomes = await runRollingPartitions(partitions, [1, 1], async (partition, slot) => {
    started.push({ partition: partition.index, ...slot })
    return { index: partition.index, code: 0, signal: null }
  }, {
    initialMemoryGiBByProcess: [1.25, 1.25],
    readResourceGrant: () => ({ cpuUnits: 2, memoryGiB: 2 }),
    potentialProcessCount: 2,
    potentialMemoryGiB: 8
  })

  assert.equal(started.length, 2)
  assert.ok(started.every(({ memoryGiB }) => memoryGiB === 1))
  assert.deepEqual(outcomes.rollingExecution.slots, [
    { processSlot: 0, processors: 1, memoryGiB: 1 },
    { processSlot: 1, processors: 1, memoryGiB: 1 }
  ])
})

test('backend production rolling partitions start LPT-heavy shards first and refill with the next heavy tail', async () => {
  const partitions = [
    { index: 0, planningWeight: 1, testCaseCount: 500, startupWeight: 1 },
    { index: 1, planningWeight: 100, testCaseCount: 20, startupWeight: 1 },
    { index: 2, planningWeight: 80, testCaseCount: 30, startupWeight: 1 },
    { index: 3, planningWeight: 2, testCaseCount: 600, startupWeight: 1 },
    { index: 4, planningWeight: 60, testCaseCount: 40, startupWeight: 1 }
  ]
  const gates = Object.fromEntries(partitions.map(({ index }) => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return [index, { promise, resolve }]
  }))
  const started = []
  const rolling = runRollingPartitions(partitions, [1, 1], async (partition) => {
    started.push(partition.index)
    await gates[partition.index].promise
    return { index: partition.index, code: 0, signal: null }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [1, 2])
  gates[2].resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [1, 2, 4])
  for (const gate of Object.values(gates)) gate.resolve()
  const outcomes = await rolling
  assert.deepEqual(outcomes.map(({ partition }) => partition.index), [0, 1, 2, 3, 4])
})

test('backend production rolling partitions start affinity shards before heavier ordinary shards', async () => {
  const started = []
  const gates = Array.from({ length: 3 }, () => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  })
  const rolling = runRollingPartitions([
    { index: 0, planningWeight: 1, affinityPriority: true },
    { index: 1, planningWeight: 100, affinityPriority: false },
    { index: 2, planningWeight: 90, affinityPriority: false }
  ], [1], async (partition) => {
    started.push(partition.index)
    await gates[partition.index].promise
    return { index: partition.index, code: 0, signal: null }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [0])
  for (const gate of gates) gate.resolve()
  await rolling
})

test('backend production admits one memory-proven ordinary bridge while live CPUs wait on PostgreSQL affinity', async () => {
  const gates = Array.from({ length: 5 }, () => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  })
  let grant = { cpuUnits: 2, memoryGiB: 2 }
  let publishGrant
  const started = []
  const rolling = runRollingPartitions([
    { index: 0, affinityPriority: true, planningWeight: 30 },
    { index: 1, affinityPriority: true, planningWeight: 29 },
    { index: 2, affinityPriority: true, planningWeight: 28 },
    { index: 3, affinityPriority: false, planningWeight: 100 },
    { index: 4, affinityPriority: false, planningWeight: 90 }
  ], [1, 1], async (partition, slot) => {
    started.push({ partition: partition.index, admission: slot.admission ?? 'scheduler-grant' })
    await gates[partition.index].promise
    return { index: partition.index, code: 0, signal: null }
  }, {
    initialMemoryGiBByProcess: [1, 1],
    readResourceGrant: () => grant,
    potentialProcessCount: 5,
    potentialMemoryGiB: 5,
    ioOvercommit: {
      enabled: true,
      memoryGiBPerProcess: 1,
      readAvailableMemoryGiB: () => 4
    },
    waitForResourceChange: () => new Promise((resolve) => { publishGrant = resolve })
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.map(({ partition }) => partition), [0, 1])
  grant = { cpuUnits: 3, memoryGiB: 3 }
  publishGrant()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [
    { partition: 0, admission: 'scheduler-grant' },
    { partition: 1, admission: 'scheduler-grant' },
    { partition: 2, admission: 'scheduler-grant' },
    { partition: 3, admission: 'io-overcommit' }
  ])
  gates[3].resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started.at(-1), { partition: 4, admission: 'io-overcommit' })
  gates[0].resolve()
  gates[4].resolve()
  await new Promise((resolve) => setImmediate(resolve))
  for (const gate of gates) gate.resolve()
  const outcomes = await rolling
  assert.equal(outcomes.rollingExecution.peakConcurrentProcesses, 4)
  assert.deepEqual(outcomes.rollingExecution.ioOvercommit, {
    enabled: true,
    admittedProcessCount: 1,
    peakCpuOvercommitUnits: 1,
    executedPartitionCount: 2,
    memoryGiBPerProcess: 1,
    observedAvailableMemoryGiB: 4,
    reason: 'bridge-ordinary-coverage-while-postgres-affinity-is-io-bound'
  })
})

test('backend production waits for the run-bound benchmark marker before expanding 3 STEP slots to 5 bundle slots', async () => {
  const partitions = Array.from({ length: 5 }, (_, index) => ({ index }))
  const gates = partitions.map(() => {
    let resolve
    const promise = new Promise((done) => { resolve = done })
    return { promise, resolve }
  })
  const runId = 'barrier-run'
  const initialMemoryGiB = 3.17
  const outerGrant = {
    cpuUnits: 5,
    memoryGiB: 4.75,
    resourceBudget: { cpuUnits: 8, memoryGiB: 8 }
  }
  let markerExists = false
  let publishGrant
  const started = []
  const readResourceGrant = () => readBackendResourceGrantAfterBenchmark({
    env: { FSUSBLOG_TEST_RUN_ID: runId },
    initialGrant: { cpuUnits: 3, memoryGiB: initialMemoryGiB },
    repositoryRoot: '/repo',
    exists: (file) => {
      assert.equal(file, `/repo/.tmp/test-runs/${runId}/benchmark-build-ready.json`)
      return markerExists
    },
    readFile: () => JSON.stringify({
      schema: 'fsusblog.local-production.benchmark-build-ready.v1',
      status: 'success',
      physicalBundleId: 'backend-tests',
      schedulerRunId: runId
    }),
    readSchedulerGrant: () => outerGrant
  })
  const rolling = runRollingPartitions(partitions, [1, 1, 1], async (partition, slot) => {
    started.push({ partition: partition.index, ...slot })
    await gates[partition.index].promise
    return { index: partition.index, code: 0, signal: null }
  }, {
    initialMemoryGiBByProcess: Array.from({ length: 3 }, () => initialMemoryGiB / 3),
    readResourceGrant,
    potentialProcessCount: 5,
    potentialMemoryGiB: 8,
    waitForResourceChange: () => new Promise((resolve) => { publishGrant = resolve })
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, 3)
  markerExists = true
  publishGrant()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, 5)
  const addedSlots = started.filter(({ processSlot }) => processSlot >= 3)
  assert.equal(addedSlots.length, 2)
  const expectedAddedMemoryGiB = (outerGrant.memoryGiB - initialMemoryGiB) / 2
  assert.ok(addedSlots.every(({ processors }) => processors === 1))
  assert.ok(addedSlots.every(({ memoryGiB }) => Math.abs(memoryGiB - expectedAddedMemoryGiB) < 1e-12))
  assert.ok(started.reduce((sum, { processors }) => sum + processors, 0) <= outerGrant.cpuUnits)
  assert.ok(started.reduce((sum, { memoryGiB }) => sum + memoryGiB, 0) <= outerGrant.memoryGiB + 1e-12)

  for (const gate of gates) gate.resolve()
  const outcomes = await rolling
  assert.equal(outcomes.rollingExecution.initialConcurrentProcesses, 3)
  assert.equal(outcomes.rollingExecution.peakConcurrentProcesses, 5)
  assert.deepEqual(outcomes.rollingExecution.observedGrant, {
    cpuUnits: outerGrant.cpuUnits,
    memoryGiB: outerGrant.memoryGiB
  })
})

test('backend production shard validation rejects omissions and cross-shard execution', () => {
  const names = Array.from({ length: 30 }, (_, index) => `Example.Tests.Class${index}.Case`)
  names.push('Example.Tests.TheoryClass.Theory(value: 1)', 'Example.Tests.TheoryClass.Theory(value: 2)')
  const plan = buildShardPlan(names, 2)
  const records = plan.methodsByShard.map((methods) => methods.flatMap((method) => {
    const count = plan.methodCounts.get(method)
    return Array.from({ length: count }, (_, index) => ({
      testName: count === 1 ? method : `${method}(value: ${index})`,
      outcome: 'Passed'
    }))
  }))
  assert.deepEqual(validateShardRecords(plan, records), {
    executedTestCaseCount: names.length,
    executedMethodCount: plan.methodCounts.size
  })
  assert.throws(() => validateShardRecords(plan, records.map((entries, index) => index === 0 ? entries.slice(1) : entries)), /executed .* discovery required/u)
  const foreign = records.map((entries) => [...entries])
  foreign[0][0] = { testName: plan.methodsByShard[1][0], outcome: 'Passed' }
  assert.throws(() => validateShardRecords(plan, foreign), /out-of-partition/u)
})

test('backend production TRX parser retains result names and outcomes', () => {
  const records = parseTrxRecords([
    '<TestRun><Results>',
    '<UnitTestResult testId="fact-id" testName="Example.Tests.Fact" outcome="Passed" />',
    '<UnitTestResult testId="rule-id" testName="Example.Tests.Rule(value: &quot;a&quot;)" outcome="Passed" />',
    '</Results></TestRun>'
  ].join(''))
  assert.deepEqual(records, [
    { testId: 'fact-id', testName: 'Example.Tests.Fact', outcome: 'Passed' },
    { testId: 'rule-id', testName: 'Example.Tests.Rule(value: "a")', outcome: 'Passed' }
  ])
})

test('backend production TRX execution evidence rejects skips, omissions, and repeated IDs', () => {
  const trx = (results, counters = `total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"`) => `
    <TestRun><Results>${results}</Results><ResultSummary outcome="Completed"><Counters ${counters} /></ResultSummary></TestRun>`
  const passing = trx([
    '<UnitTestResult testId="one" testName="Example.One" outcome="Passed" />',
    '<UnitTestResult testId="two" testName="Example.Two" outcome="Passed" />'
  ].join(''))
  assert.equal(parseTrxExecutionEvidence(passing).records.length, 2)
  assert.throws(
    () => parseTrxExecutionEvidence(passing.replace('notExecuted="0"', 'notExecuted="1"')),
    /do not prove every selected test executed and passed/u
  )
  assert.throws(
    () => parseTrxExecutionEvidence(passing.replace('testId="two"', 'testId="one"')),
    /empty or repeated/u
  )
})

test('backend production summary binds rolling process capacity and artifacts to every partition', () => {
  const repositoryRoot = '/repo'
  const trxFiles = [0, 1, 2, 3].map((index) => `${repositoryRoot}/.tmp/test-results/backend/production/shard-${index}.trx`)
  const summary = {
    status: 'success',
    partitionCount: 4,
    maxConcurrentProcesses: 2,
    initialConcurrentProcesses: 2,
    peakConcurrentProcesses: 2,
    potentialConcurrentProcesses: 2,
    plannedConcurrentProcesses: 2,
    globalPotentialConcurrentProcesses: 2,
    processorsByProcess: [2, 1],
    memoryGiBByProcess: [8, 4],
    allocatedCpuUnits: 3,
    allocatedMemoryGiB: 12,
    parallelism: { cpuBudget: 3, memoryGiB: 12 },
    resourceExpansion: {
      dynamic: false,
      initialGrant: { cpuUnits: 3, memoryGiB: 12 },
      observedGrant: null,
      potentialBudget: { cpuUnits: 3, memoryGiB: 12 }
    },
    partitions: trxFiles.map((file, id) => ({
      id,
      processSlot: id % 2,
      processors: [2, 1][id % 2],
      memoryGiB: [8, 4][id % 2],
      trx: path.relative(repositoryRoot, file).replaceAll(path.sep, '/'),
      coverageRoot: `.tmp/coverage/backend/production/shard-${id}`
    }))
  }
  assert.deepEqual(validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot }), {
    partitionCount: 4,
    maxConcurrentProcesses: 2,
    initialConcurrentProcesses: 2,
    peakConcurrentProcesses: 2,
    potentialConcurrentProcesses: 2,
    plannedConcurrentProcesses: 2,
    globalPotentialConcurrentProcesses: 2,
    processorsByProcess: [2, 1],
    allocatedCpuUnits: 3
  })
  assert.throws(
    () => validateShardSummaryArtifacts(summary, trxFiles.slice(1), { repositoryRoot }),
    /expected 4 partition TRX files, received 3/u
  )
  const duplicate = structuredClone(summary)
  duplicate.partitions[2].trx = duplicate.partitions[1].trx
  assert.throws(
    () => validateShardSummaryArtifacts(duplicate, trxFiles, { repositoryRoot }),
    /repeats TRX/u
  )
  const mismatchedProcessors = structuredClone(summary)
  mismatchedProcessors.partitions[1].processors = 2
  assert.throws(
    () => validateShardSummaryArtifacts(mismatchedProcessors, trxFiles, { repositoryRoot }),
    /processor allocation is not bound to its process slot/u
  )
  const mismatchedMemory = structuredClone(summary)
  mismatchedMemory.partitions[2].memoryGiB = 7.5
  assert.throws(
    () => validateShardSummaryArtifacts(mismatchedMemory, trxFiles, { repositoryRoot }),
    /memory allocation is not bound to its process slot/u
  )
  const missingCpuBudget = structuredClone(summary)
  delete missingCpuBudget.parallelism.cpuBudget
  assert.throws(
    () => validateShardSummaryArtifacts(missingCpuBudget, trxFiles, { repositoryRoot }),
    /missing a valid parallelism\.cpuBudget/u
  )
  const missingMemoryBudget = structuredClone(summary)
  delete missingMemoryBudget.parallelism.memoryGiB
  assert.throws(
    () => validateShardSummaryArtifacts(missingMemoryBudget, trxFiles, { repositoryRoot }),
    /missing a valid parallelism\.memoryGiB/u
  )
})

test('backend production summary binds one coverage testhost plus a sequential governance postlude', () => {
  const repositoryRoot = '/repo'
  const trxFiles = [
    `${repositoryRoot}/.tmp/test-results/backend/production/main-coverage.trx`,
    `${repositoryRoot}/.tmp/test-results/backend/production/governance-postlude.trx`
  ]
  const summary = {
    status: 'success',
    executionMode: 'single-testhost-with-governance-postlude',
    partitionCount: 2,
    maxConcurrentProcesses: 1,
    initialConcurrentProcesses: 1,
    peakConcurrentProcesses: 1,
    potentialConcurrentProcesses: 1,
    plannedConcurrentProcesses: 1,
    globalPotentialConcurrentProcesses: 1,
    processorsByProcess: [3],
    memoryGiBByProcess: [12],
    allocatedCpuUnits: 3,
    allocatedMemoryGiB: 12,
    parallelism: { cpuBudget: 3, memoryGiB: 12 },
    resourceExpansion: {
      dynamic: false,
      initialGrant: { cpuUnits: 3, memoryGiB: 12 },
      observedGrant: null,
      potentialBudget: { cpuUnits: 3, memoryGiB: 12 }
    },
    discovery: { testCaseCount: 3544 },
    execution: { executedTestCaseCount: 3544, exactOnce: true, allPassed: true },
    partitions: [{
      id: 0,
      kind: 'coverage-main',
      processSlot: 0,
      processors: 3,
      memoryGiB: 12,
      testCaseCount: 3543,
      trx: path.relative(repositoryRoot, trxFiles[0]).replaceAll(path.sep, '/'),
      coverageRoot: '.tmp/coverage/backend/production/main'
    }, {
      id: 1,
      kind: 'governance-postlude',
      processSlot: 0,
      processors: 3,
      memoryGiB: 12,
      testCaseCount: 1,
      trx: path.relative(repositoryRoot, trxFiles[1]).replaceAll(path.sep, '/'),
      coverageMode: 'excluded-pure-evidence-consumer',
      coverageRoot: null
    }]
  }
  assert.deepEqual(validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot }), {
    partitionCount: 2,
    maxConcurrentProcesses: 1,
    initialConcurrentProcesses: 1,
    peakConcurrentProcesses: 1,
    potentialConcurrentProcesses: 1,
    plannedConcurrentProcesses: 1,
    globalPotentialConcurrentProcesses: 1,
    processorsByProcess: [3],
    allocatedCpuUnits: 3
  })
  const invalid = structuredClone(summary)
  invalid.execution.exactOnce = false
  assert.throws(
    () => validateShardSummaryArtifacts(invalid, trxFiles, { repositoryRoot }),
    /does not prove a passing exact-once production union/u
  )
})

test('backend production summary records global 8, planned 5, initial 3, and five distinct coverage sessions', () => {
  const repositoryRoot = '/repo'
  const partitionCount = 5
  const trxFiles = Array.from({ length: partitionCount }, (_, id) => (
    `${repositoryRoot}/.tmp/test-results/backend/production/shard-${id}.trx`
  ))
  const initialMemoryGiB = 3.17
  const addedMemoryGiB = (4.75 - initialMemoryGiB) / 2
  const memoryGiBByProcess = [
    ...Array.from({ length: 3 }, () => initialMemoryGiB / 3),
    addedMemoryGiB,
    addedMemoryGiB
  ]
  const summary = {
    status: 'success',
    partitionCount,
    maxConcurrentProcesses: 5,
    initialConcurrentProcesses: 3,
    peakConcurrentProcesses: 5,
    potentialConcurrentProcesses: 5,
    plannedConcurrentProcesses: 5,
    globalPotentialConcurrentProcesses: 8,
    processorsByProcess: [1, 1, 1, 1, 1],
    memoryGiBByProcess,
    allocatedCpuUnits: 5,
    allocatedMemoryGiB: 4.75,
    parallelism: { cpuBudget: 3, memoryGiB: initialMemoryGiB },
    resourceExpansion: {
      dynamic: true,
      initialGrant: { cpuUnits: 3, memoryGiB: initialMemoryGiB },
      observedGrant: { cpuUnits: 5, memoryGiB: 4.75 },
      potentialBudget: { cpuUnits: 8, memoryGiB: 8 }
    },
    partitions: trxFiles.map((file, id) => ({
      id,
      processSlot: id,
      processors: 1,
      memoryGiB: memoryGiBByProcess[id],
      trx: path.relative(repositoryRoot, file).replaceAll(path.sep, '/'),
      coverageRoot: `.tmp/coverage/backend/production/shard-${id}`
    }))
  }
  assert.deepEqual(validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot }), {
    partitionCount: 5,
    maxConcurrentProcesses: 5,
    initialConcurrentProcesses: 3,
    peakConcurrentProcesses: 5,
    potentialConcurrentProcesses: 5,
    plannedConcurrentProcesses: 5,
    globalPotentialConcurrentProcesses: 8,
    processorsByProcess: [1, 1, 1, 1, 1],
    allocatedCpuUnits: 5
  })
  assert.equal(new Set(summary.partitions.map(({ trx }) => trx)).size, partitionCount)
  assert.equal(new Set(summary.partitions.map(({ coverageRoot }) => coverageRoot)).size, partitionCount)
})

test('backend production category discovery binds special tiers to methods inside the union', () => {
  const names = [
    'Example.Tests.ApiClass.Api',
    'Example.Tests.AuthClass.Auth',
    'Example.Tests.ConcurrentClass.Concurrent(value: 1)',
    'Example.Tests.ConcurrentClass.Concurrent(value: 2)',
    'Example.Tests.PropertyClass.Property',
    'Example.Tests.GoldenClass.Golden',
    'Example.Tests.UnitClass.Unit'
  ]
  const plan = buildShardPlan(names, 2)
  const membership = validateCategoryMembership(plan, {
    ApiIntegration: ['Example.Tests.ApiClass.Api'],
    SecurityStateMachine: ['Example.Tests.AuthClass.Auth'],
    Concurrency: ['Example.Tests.ConcurrentClass.Concurrent(value: 1)', 'Example.Tests.ConcurrentClass.Concurrent(value: 2)'],
    Property: ['Example.Tests.PropertyClass.Property'],
    GoldenContract: ['Example.Tests.GoldenClass.Golden']
  })
  assert.deepEqual(membership.Concurrency, ['Example.Tests.ConcurrentClass.Concurrent'])
  assert.throws(() => validateCategoryMembership(plan, {
    ApiIntegration: ['Example.Tests.Outside'],
    SecurityStateMachine: ['Example.Tests.AuthClass.Auth'],
    Concurrency: ['Example.Tests.ConcurrentClass.Concurrent'],
    Property: ['Example.Tests.PropertyClass.Property'],
    GoldenContract: ['Example.Tests.GoldenClass.Golden']
  }), /outside the production union/u)
})

test('backend category discovery reports every independently failed projection', () => {
  const failure = aggregateCategoryDiscoveryFailures([
    { category: 'ApiIntegration', result: { code: 1, signal: null, stderr: 'api failed' } },
    { category: 'Concurrency', result: { code: 0, signal: null, stderr: '' } },
    { category: 'GoldenContract', result: { code: 2, signal: null, stderr: 'golden failed' } }
  ])
  assert.ok(failure instanceof AggregateError)
  assert.match(failure.message, /2 independent branches: ApiIntegration, GoldenContract/u)
  assert.deepEqual(failure.errors.map((error) => error.message), [
    'ApiIntegration: api failed',
    'GoldenContract: golden failed'
  ])
  assert.equal(aggregateCategoryDiscoveryFailures([
    { category: 'Concurrency', result: { code: 0, signal: null, stderr: '' } }
  ]), null)
})

test('backend projection discovery aggregates category, affinity, and dependency failures', () => {
  const failure = aggregateProjectionDiscoveryFailures([
    { projection: 'Category=ApiIntegration', result: { code: 1, signal: null, stderr: 'api failed' } },
    { projection: 'Category=Concurrency', result: { code: 0, signal: null, stderr: '' } },
    {
      projection: 'ShardAffinity=EndpointContractApplication',
      result: { code: 2, signal: null, stderr: 'affinity failed' }
    },
    {
      projection: 'Dependency=Docker',
      result: { code: 3, signal: null, stderr: 'docker failed' }
    }
  ])
  assert.ok(failure instanceof AggregateError)
  assert.match(failure.message, /3 independent branches: Category=ApiIntegration, ShardAffinity=EndpointContractApplication, Dependency=Docker/u)
  assert.deepEqual(failure.errors.map((error) => error.message), [
    'Category=ApiIntegration: api failed',
    'ShardAffinity=EndpointContractApplication: affinity failed',
    'Dependency=Docker: docker failed'
  ])
})

test('backend production executes fixed exact coverage shards with live expansion before one no-coverage governance postlude', () => {
  const source = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8')
  const start = source.indexOf('async function runExpandableBackendProductionShards')
  const end = source.indexOf('\nexport async function runBackendProductionShards', start)
  const executionBody = source.slice(start, end)
  const rolling = executionBody.indexOf('const outcomes = await runRollingPartitions')
  const finalize = executionBody.indexOf("runNode(['tools/security/check-perception-v2-e2e-evidence.mjs']")
  const postlude = executionBody.indexOf('const postludeResult = await runDotnet')
  assert.ok(start > 0 && rolling > 0 && finalize > rolling && postlude > finalize)
  assert.match(executionBody, /'--ListTests'[\s\S]*?`--Diag:\$\{diagnosticFile\}`/u)
  assert.match(executionBody, /prepareShardFiles\(plan,[\s\S]*?runRollingPartitions/u)
  assert.match(executionBody, /readBackendResourceGrantAfterBenchmark/u)
  assert.match(executionBody, /outerSchedulerGrant[\s\S]*?cpuUnits: parallelism\.cpuBudget,[\s\S]*?memoryGiB: parallelism\.memoryGiB/u)
  assert.match(executionBody, /'--Collect:XPlat Code Coverage'/u)
  assert.match(executionBody, /`--logger:trx;LogFileName=\$\{path\.basename\(trxFile\)\}`/u)
  assert.match(executionBody, /`--ResultsDirectory:\$\{resultRoot\}`/u)
  assert.match(executionBody, /`--TestAdapterPath:\$\{partition\.collectorDirectory\}`/u)
  assert.match(executionBody, /fs\.copyFileSync\(collectorTrxFile, trxFile\)/u)
  assert.match(source, /FsusBlog\.Server\.Tests\.deps\.json[\s\S]*?FsusBlog\.Server\.Tests\.runtimeconfig\.json/u)
  assert.match(source, /assets\.packageFolders[\s\S]*?coverlet\.collector\.dll/u)
  assert.match(source, /<TestCaseFilter>\$\{escapeXml\(filter\)\}<\/TestCaseFilter>/u)
  assert.doesNotMatch(executionBody.slice(postlude, executionBody.indexOf('const postludeRecords', postlude)), /--Collect:XPlat Code Coverage/u)
  assert.match(executionBody, /executionPolicy: 'fixed-exact-partitions-expand-on-live-grant'/u)
  assert.match(executionBody, /kind: 'coverage-shard'[\s\S]*?kind: 'governance-postlude'[\s\S]*?coverageMode: 'excluded-pure-evidence-consumer'/u)
  assert.equal((executionBody.match(/check-perception-v2-e2e-evidence\.mjs/gu) ?? []).length, 1)
})

test('coverage-excluded governance postlude is a pure JSON and evidence-path consumer', () => {
  const source = fs.readFileSync(path.join(root, 'tests/backend/Unit/BackendTestGovernanceTests.cs'), 'utf8')
  const start = source.indexOf('public void Issue40Requirements_HaveEvidenceAndRiskTraceability()')
  const end = source.indexOf('\n    [Fact]', start)
  assert.ok(start > 0 && end > start)
  const method = source.slice(start, end)
  assert.match(method, /ReadRequirementsFixture\(\)/u)
  assert.match(method, /AssertEvidencePathsExist\(requirement\["evidencePaths"\]/u)
  assert.doesNotMatch(method, /FsusBlog\.Server|WebApplication|ServiceCollection|BuildServiceProvider|Process\.|Assembly\.|Activator\./u)
})

test('backend bundle delegates shard sizing to the runtime CPU budget without fail-fast controls', () => {
  const source = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8')
  assert.match(source, /FSUSBLOG_BACKEND_CPU_BUDGET="\$FSUSBLOG_STEP_CPU_BUDGET" node tools\/test\/run-backend-production-shards\.mjs/u)
  assert.match(source, /FSUSBLOG_BUNDLE_MEMORY_GIB: String\(stepCapacity\.memoryGiB\)/u)
  assert.match(source, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?resources: \{ cpuWeight: 2, memoryWeight: 3, minCpuUnits: 2 \}/u)
  assert.doesNotMatch(source, /dotnet-production-union'[\s\S]{0,240}?dependsOn:/u)
  assert.doesNotMatch(source, /FSUSBLOG_BACKEND_PRODUCTION_SHARDS=2|FSUSBLOG_BACKEND_SHARD_PROCESSORS=2/u)
  assert.doesNotMatch(source, /(?:fail-fast|maxFailures|--blame-hang)/u)
  assert.match(source, /await executeWeightedStepDag\(\[[\s\S]*?testStep,[\s\S]*?perception-matrix[\s\S]*?integrity-proof/u)
  assert.match(source, /perception-matrix[\s\S]*?dependsOn: \['dotnet-production-union'\]/u)
  assert.match(source, /perception-evidence-finalize[\s\S]*?dependsOn: \['perception-matrix'\]/u)
  const backendFinalizer = source.match(/commandStep\('perception-evidence-finalize',[\s\S]*?\}\),/u)?.[0] ?? ''
  assert.doesNotMatch(backendFinalizer, /check-perception-v2-e2e-evidence\.mjs/u)
  assert.match(backendFinalizer, /test -s \.tmp\/security\/perception-v2-e2e-runtime\.json/u)
  assert.match(source, /integrity-proof[\s\S]*?dependsOn: \['perception-matrix'\]/u)
  assert.match(source, /backend-coverage-summary[\s\S]*?dependsOn: \['dotnet-production-union'\]/u)
  assert.match(source, /readPerceptionUnionProjection[\s\S]*?perception-v2\.union-projection\.v1[\s\S]*?schedulerRunId\(\)[\s\S]*?expectedDllDigest[\s\S]*?expectedTrxDigests/u)
})
