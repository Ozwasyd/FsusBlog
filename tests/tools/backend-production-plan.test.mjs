import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    composeBackendPlatformFilter,
    parseBackendPlatformTrx,
    projectBackendPlatformPlan,
    reconcileBackendPlatformOutcome
} from '../../tools/test/backend-platform-selection.mjs';
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
    parseTrxTimingEvidence,
    projectProductionPlatformPlan,
    projectProductionUnionRecords,
    readManifestClassWideProductionExclusions,
    readBackendResourceGrantAfterBenchmark,
    readBackendSchedulerResourceGrant,
    resolveBackendShardParallelism,
    resolveBackendPotentialProcessCount,
    runAuthoritativeProductionDiscovery,
    runRollingPartitions,
    staleBackendBuildServerPids,
    staleBackendPostgresContainers,
    validateCategoryMembership,
    validateExactProductionUnion,
    validateShardRecords,
    validateShardSummaryArtifacts
} from '../../tools/test/run-backend-production-shards.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const unixPlatformTest = {
    id: 'unix-id',
    fullyQualifiedName: 'Example.Tests.Files.ExactDelete',
    displayName: 'Example.Tests.Files.ExactDelete',
    source: '/repo/tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',
    traits: { Platform: ['Unix'] }
};
const portablePlatformTest = {
    id: 'ordinary-id',
    fullyQualifiedName: 'Example.Tests.Files.Portable',
    displayName: 'Example.Tests.Files.Portable',
    source: unixPlatformTest.source,
    traits: {}
};
const unixModePlatformTest = {
    ...unixPlatformTest,
    id: 'unix-mode-id',
    fullyQualifiedName: 'Example.Tests.Files.UploadSessionRoot_IsPrivateOnUnix',
    displayName: 'Example.Tests.Files.UploadSessionRoot_IsPrivateOnUnix',
    traits: {
        Platform: ['Unix'],
        PlatformEvidence: ['UnixMode']
    }
};
const unixModeRuntimeEvidence = {
    schema: 'fsusblog.backend-platform-unix-mode-evidence.v1',
    evidenceContract: 'unix-mode',
    fullyQualifiedName: unixModePlatformTest.fullyQualifiedName,
    freshModeOctal: '0700',
    widenedExistingModeOctal: '0777',
    effectiveModeOctal: '0700',
    assertions: {
        groupReadDenied: true,
        groupWriteDenied: true,
        groupExecuteDenied: true,
        otherReadDenied: true,
        otherWriteDenied: true,
        otherExecuteDenied: true
    },
    ownerArtifact: {
        created: true,
        read: true,
        deleted: true
    },
    existingRoot: {
        overbroadModeApplied: true,
        converged: true
    }
};

function unixModeTrx(runtimeEvidence = unixModeRuntimeEvidence)
{
    return [
        '<TestRun><Results>',
        `<UnitTestResult testId="${unixModePlatformTest.id}" `,
        `testName="${unixModePlatformTest.displayName}" outcome="Passed">`,
        '<Output><StdOut>backend-platform-runtime-evidence ',
        JSON.stringify(runtimeEvidence),
        '</StdOut></Output></UnitTestResult>',
        '</Results><ResultSummary outcome="Completed">',
        '<Counters total="1" executed="1" passed="1" failed="0" />',
        '</ResultSummary></TestRun>'
    ].join('');
}

const unixRequestPathOperations = [
    'complete',
    'abort',
    'expired-status',
    'expired-part-map',
    'expired-part',
    'expired-token'
];
const unixRequestPathPlatformTests = unixRequestPathOperations.map((operation, index) => ({
    ...unixPlatformTest,
    id: `unix-request-path-${index}`,
    fullyQualifiedName: 'Example.Tests.Files.UploadRequestPaths_DoNotEnumerateExpirationIndexRoot',
    displayName:
        `Example.Tests.Files.UploadRequestPaths_DoNotEnumerateExpirationIndexRoot(operation: "${operation}")`,
    traits: {
        Platform: ['Unix'],
        PlatformEvidence: ['UnixRequestPath']
    }
}));

function unixRequestPathEvidence(operation)
{
    const complete = operation === 'complete';
    return {
        schema: 'fsusblog.backend-platform-unix-request-path-evidence.v1',
        evidenceContract: 'unix-request-path',
        fullyQualifiedName: unixRequestPathPlatformTests[0].fullyQualifiedName,
        operation,
        enumerationDenied: true,
        requestContractSatisfied: true,
        requestOutcome: complete || operation === 'abort' ? 'succeeded' : 'expired-rejected',
        sessionPresent: complete,
        expirationIndexEntryCount: complete ? 1 : 0,
        ...(complete
            ? {
                completeContract: {
                    manifestCompleted: true,
                    ownerPreserved: true,
                    tokenDigestPresent: true,
                    retryAccepted: true,
                    wrongOwnerRejected: true,
                    wrongTokenRejected: true
                }
            }
            : { cleanupCompleted: true })
    };
}

function unixRequestPathTrx(
    records = unixRequestPathPlatformTests,
    evidenceFor = (operation) => unixRequestPathEvidence(operation)
)
{
    const results = records.map((record) =>
    {
        const operation = record.displayName.match(/\(operation: "([^"]+)"\)$/u)?.[1];
        const testName = record.displayName.replaceAll('"', '&quot;');
        return [
            `<UnitTestResult testId="${record.id}" `,
            `testName="${testName}" outcome="Passed">`,
            '<Output><StdOut>backend-platform-runtime-evidence ',
            JSON.stringify(evidenceFor(operation)),
            '</StdOut></Output></UnitTestResult>'
        ].join('');
    }).join('');
    return [
        `<TestRun><Results>${results}</Results>`,
        '<ResultSummary outcome="Completed">',
        `<Counters total="${records.length}" executed="${records.length}" `,
        `passed="${records.length}" failed="0" />`,
        '</ResultSummary></TestRun>'
    ].join('');
}

const unixSymlinkBoundaryPlatformTest = {
    ...unixPlatformTest,
    id: 'unix-symlink-boundary-id',
    fullyQualifiedName:
        'Example.Tests.Security.CanonicalPathBoundaryTests.TryResolveRelative_RejectsSymbolicLinkThatEscapesPhysicalRoot',
    displayName:
        'Example.Tests.Security.CanonicalPathBoundaryTests.TryResolveRelative_RejectsSymbolicLinkThatEscapesPhysicalRoot',
    traits: {
        Platform: ['Unix'],
        PlatformEvidence: ['UnixSymlinkBoundary']
    }
};
const unixSymlinkBoundaryRuntimeEvidence = {
    schema: 'fsusblog.backend-platform-unix-symlink-boundary-evidence.v1',
    evidenceContract: 'unix-symlink-boundary',
    fullyQualifiedName: unixSymlinkBoundaryPlatformTest.fullyQualifiedName,
    root: {
        identity: '1'.repeat(64),
        exists: true
    },
    escapeLink: {
        identity: '2'.repeat(64),
        targetIdentity: '3'.repeat(64),
        exists: true,
        targetExists: true,
        targetOutsideRoot: true,
        targetMatchesExpected: true
    },
    rejection: {
        resolved: false,
        pathEmpty: true
    },
    positiveControl: {
        rootIdentity: '4'.repeat(64),
        linkIdentity: '5'.repeat(64),
        targetIdentity: '6'.repeat(64),
        rootExists: true,
        linkExists: true,
        targetExists: true,
        targetMatchesExpected: true,
        resolved: true,
        resolvedInsideRoot: true,
        resolvedPathMatchesExpected: true
    },
    cleanupCompleted: true
};

function unixSymlinkBoundaryTrx(runtimeEvidence = unixSymlinkBoundaryRuntimeEvidence)
{
    return [
        '<TestRun><Results>',
        `<UnitTestResult testId="${unixSymlinkBoundaryPlatformTest.id}" `,
        `testName="${unixSymlinkBoundaryPlatformTest.displayName}" outcome="Passed">`,
        '<Output><StdOut>backend-platform-runtime-evidence ',
        JSON.stringify(runtimeEvidence),
        '</StdOut></Output></UnitTestResult>',
        '</Results><ResultSummary outcome="Completed">',
        '<Counters total="1" executed="1" passed="1" failed="0" />',
        '</ResultSummary></TestRun>'
    ].join('');
}

test('backend production discovery captures a rejected authoritative union', async () =>
{
    const started = [];
    const batch = await runAuthoritativeProductionDiscovery(async (filter) =>
    {
        started.push(filter);
        await Promise.resolve();
        throw new Error('spawn failed');
    });
    assert.deepEqual(started, [null]);
    const failure = aggregateProductionDiscoveryFailures(batch);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.message, /1 independent branches: production-union/u);
    assert.deepEqual(failure.errors.map(({ message }) => message), [
        'production-union: spawn failed'
    ]);
});

test('backend production partition environment replaces every inherited STEP and bundle resource grant', () =>
{
    const environment = backendPartitionEnvironment({
        KEEP: 'yes',
        DOTNET_PROCESSOR_COUNT: '8',
        FSUSBLOG_BACKEND_CPU_BUDGET: '8',
        FSUSBLOG_STEP_CPU_BUDGET: '8',
        FSUSBLOG_STEP_MEMORY_GIB: '32',
        FSUSBLOG_BUNDLE_CPU_UNITS: '8',
        FSUSBLOG_BUNDLE_CPU_BUDGET: '8',
        FSUSBLOG_BUNDLE_MEMORY_GIB: '32',
        FSUSBLOG_REPO_ROOT: '/wrong/inherited/root'
    }, {
        processors: 2,
        memoryGiB: 3.5,
        namespace: 'run-partition-0',
        tempDirectory: '/repo/.tmp/test-results/backend/production/tmp/shard-0'
    });
    assert.deepEqual(Object.fromEntries(Object.entries(environment)
        .filter(([key]) => !key.startsWith('FSUSBLOG_DOCKER_'))), {
        KEEP: 'yes',
        FSUSBLOG_REPO_ROOT: root,
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
    });
    assert.equal(environment.FSUSBLOG_DOCKER_CPU_UNITS, '2');
    assert.equal(environment.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES, String(Math.round(3.5 * 1024 ** 3)));
    assert.ok(Number(environment.FSUSBLOG_DOCKER_MEMORY_MAX_BYTES) > Number(environment.FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES));
    assert.ok(Number(environment.FSUSBLOG_DOCKER_PIDS_MAX) >= 64);
    assert.throws(() => backendPartitionEnvironment({}, {
        processors: 0,
        memoryGiB: 1,
        namespace: 'invalid'
    }), /processors must be a positive integer/u);
    assert.throws(() => backendPartitionEnvironment({}, {
        processors: 1,
        memoryGiB: 1,
        namespace: 'invalid',
        tempDirectory: 'relative/tmp'
    }), /temp directory must be absolute/u);
});

test('backend production resource cleanup selects only containers whose encoded testhost owner is dead', () =>
{
    const active = 'fsus-pg-bp-0123456789-m-4321-aabbccdd';
    const stale = 'fsus-pg-production-2026-07-9876-deadbeef';
    const unrelated = 'fsusblog-dev-postgres';
    assert.equal(backendPostgresContainerOwnerPid(active), 4321);
    assert.equal(backendPostgresContainerOwnerPid(stale), 9876);
    assert.equal(backendPostgresContainerOwnerPid(unrelated), null);
    assert.deepEqual(staleBackendPostgresContainers([active, stale, unrelated], {
        processExists: (pid) => pid === 4321
    }), [stale]);
    assert.throws(() => staleBackendPostgresContainers('not-an-array'), /container-name array/u);
});

test('backend production database namespace is short, deterministic, and has no postlude role', () =>
{
    const main = backendProductionDatabaseNamespace('main', { runId: 'production-run', runnerPid: 42 });
    const repeated = backendProductionDatabaseNamespace('main', { runId: 'production-run', runnerPid: 42 });
    assert.equal(main, repeated);
    assert.ok(main.length <= 18);
    assert.match(main, /^bp-[0-9a-f]{10}-m$/u);
    assert.throws(() => backendProductionDatabaseNamespace('postlude'), /unknown backend database namespace role/u);
    assert.throws(() => backendProductionDatabaseNamespace('unknown'), /unknown backend database namespace role/u);
});

test('backend production build-server cleanup is limited to the current scheduler run', () =>
{
    const command = [
        '/usr/lib/dotnet/dotnet',
        '/usr/lib/dotnet/sdk/10.0.108/MSBuild.dll',
        '/noautoresponse',
        '/nologo',
        '/nodemode:1',
        '/nodeReuse:true',
        '/low:false'
    ];
    const record = (pid, runId, namespace, overrides = {}) => ({
        pid,
        ppid: 1,
        startTimeTicks: String(1_000 + pid),
        cwd: root,
        args: command,
        env: {
            FSUSBLOG_TEST_RUN_ID: runId,
            FSUSBLOG_TEST_NAMESPACE: namespace,
            FSUSBLOG_PRODUCTION_BUILD_ROOT: `${root}/.tmp/build/${runId}`,
            FSUSBLOG_TEST_EXECUTION_SOURCE: 'fresh'
        },
        ...overrides
    });
    const currentRunId = 'production-2026-07-12_12-07-56-517-700';
    const staleRunId = 'production-2026-07-12_12-07-56-517-701';
    const activeRunId = 'production-2026-07-12_12-07-56-517-702';
    const processes = [
        record(100, currentRunId, 'current-tier'),
        record(101, staleRunId, `${staleRunId}-fresh-local-production-0`),
        record(102, activeRunId, `${activeRunId}-fresh-local-production-0`),
        record(103, currentRunId, 'current-tier', { args: ['/usr/lib/dotnet/dotnet', 'testhost.dll'] }),
        record(104, '', ''),
        record(105, currentRunId, 'other-live-tier'),
        record(106, 'backend-focused-20260712', 'manual-tier'),
        record(107, currentRunId, 'current-tier', { ppid: 900 })
    ];
    assert.equal(backendRunOwnerPid(currentRunId), 700);
    assert.equal(backendRunOwnerPid('backend-focused-20260712'), null);
    assert.equal(backendRunOwnerPid('standalone'), null);
    assert.deepEqual(staleBackendBuildServerPids(processes, {
        repositoryRoot: root,
        currentRunId,
        currentNamespace: 'current-tier',
        currentStartSource: 'fresh',
        runActivity: ({ runId }) => ({ status: runId === activeRunId ? 'active' : 'inactive' })
    }), [100]);
    const source = fs.readFileSync(path.join(root, 'tools/test-matrix/dotnet-build-server-cleanup.mjs'), 'utf8');
    assert.match(source, /observed\.ppid === expected\.ppid/u);
    assert.match(source, /observed\.startTimeTicks === expected\.startTimeTicks/u);
    assert.match(source, /observed\.args\.join\('\\0'\) === expected\.args\.join\('\\0'\)/u);
});

test('backend production shard plan is deterministic, mutually exclusive, and exhaustive', () =>
{
    const names = Array.from({ length: 40 }, (_, index) => `Example.Tests.Class${index}.Case`);
    names.push('Example.Tests.TheoryClass.Theory(value: 1)', 'Example.Tests.TheoryClass.Theory(value: 2)');
    const first = buildShardPlan(names, 2);
    const second = buildShardPlan([...names].reverse(), 2);
    assert.deepEqual(first.methodsByShard, second.methodsByShard);
    assert.equal(first.testCaseCount, names.length);
    assert.equal(first.methodCounts.get('Example.Tests.TheoryClass.Theory'), 2);
    assert.deepEqual(first.plannedTestCaseCountsByShard, [21, 21]);
    const flattened = first.methodsByShard.flat();
    assert.equal(new Set(flattened).size, flattened.length);
    assert.deepEqual([...flattened].sort(), [...first.methodCounts.keys()].sort());

    const weighted = buildShardPlan(
        Array.from({ length: 12 }, (_, index) => `Example.Tests.Weighted${index}.Case`),
        3,
        [2, 1, 1]
    );
    assert.deepEqual(weighted.plannedTestCaseCountsByShard, [6, 3, 3]);
    assert.throws(() => buildShardPlan(names, 3, [2, 1]), /positive processor allocation/u);
});

test('backend production shard plan keeps a discovered affinity group on one deterministic shard', () =>
{
    const names = [
        'Example.Tests.EndpointClass.EndpointA(value: 1)',
        'Example.Tests.EndpointClass.EndpointA(value: 2)',
        'Example.Tests.EndpointClass.EndpointB',
        'Example.Tests.EndpointClass.UntaggedHelper',
        ...Array.from({ length: 9 }, (_, index) => `Example.Tests.Other${index}.Case`)
    ];
    const affinityGroups = [{
        name: 'EndpointContractApplication',
        testNames: [
            'Example.Tests.EndpointClass.EndpointB',
            'Example.Tests.EndpointClass.EndpointA(value: 1)',
            'Example.Tests.EndpointClass.EndpointA(value: 2)'
        ]
    }];
    const first = buildShardPlan(names, 2, [2, 2], { affinityGroups });
    const second = buildShardPlan([...names].reverse(), 2, [2, 2], { affinityGroups });
    assert.deepEqual(first.methodsByShard, second.methodsByShard);
    assert.deepEqual(first.affinityAssignments.EndpointContractApplication, {
        shardId: 0,
        actualTestCaseCount: 4,
        affinityTaggedTestCaseCount: 3,
        startupWeight: 4,
        planningWeight: 8
    });
    const affinityShard = first.affinityAssignments.EndpointContractApplication.shardId;
    assert.ok(Number.isInteger(affinityShard));
    assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.EndpointA'));
    assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.EndpointB'));
    assert.ok(first.methodsByShard[affinityShard].includes('Example.Tests.EndpointClass.UntaggedHelper'));
    assert.ok(first.methodsByShard.every((methods, index) => (
        index === affinityShard || (!methods.includes('Example.Tests.EndpointClass.EndpointA') && !methods.includes('Example.Tests.EndpointClass.EndpointB'))
    )));
    assert.equal(first.plannedTestCaseCountsByShard.reduce((total, count) => total + count, 0), names.length);
    assert.equal(first.planningWeightsByShard.reduce((total, count) => total + count, 0), names.length + 4);
    assert.ok(first.plannedTestCaseCountsByShard[affinityShard] < first.plannedTestCaseCountsByShard[1 - affinityShard]);
    assert.throws(() => buildShardPlan(names, 2, [1, 1], {
        affinityGroups: [{ name: 'outside', testNames: ['Example.Tests.Missing'] }]
    }), /outside the production union/u);
    assert.throws(() => buildShardPlan(names, 2, [1, 1], {
        affinityGroups: [{ name: 'partial-theory', testNames: ['Example.Tests.EndpointClass.EndpointA(value: 1)'] }]
    }), /case count mismatch/u);
});

test('backend production shard plan keeps ordinary test classes intact to avoid repeated fixture startup', () =>
{
    const names = Array.from({ length: 9 }, (_, classIndex) => (
        Array.from({ length: classIndex + 1 }, (_, methodIndex) => (
            `Example.Tests.Class${classIndex}.Method${methodIndex}`
        ))
    )).flat();
    const plan = buildShardPlan(names, 3, [1, 1, 1]);
    assert.equal(plan.partitionUnitKind, 'test-class');
    for (let classIndex = 0; classIndex < 9; classIndex += 1)
    {
        const shards = plan.methodsByShard
            .map((methods, shardId) => methods.some((method) => method.startsWith(`Example.Tests.Class${classIndex}.`)) ? shardId : -1)
            .filter((shardId) => shardId >= 0);
        assert.equal(shards.length, 1, `Class${classIndex} must not be split across shards`);
    }
    assert.equal(plan.plannedTestCaseCountsByShard.reduce((total, count) => total + count, 0), names.length);

    assert.throws(() => buildShardPlan([
        'Example.Tests.One',
        'Example.Tests.Two',
        'Example.Tests.Three'
    ], 2, [1, 1]), /indivisible class\/affinity units/u);
});

test('backend production shard plan merges overlapping affinity groups as deterministic transitive components', () =>
{
    const connected = ['A', 'B', 'C', 'D'].map((name) => `Example.Tests.${name}.Case`);
    const names = [
        ...connected,
        ...Array.from({ length: 8 }, (_, index) => `Example.Tests.Other${index}.Case`)
    ];
    const affinityGroups = [
        { name: 'endpoint', testNames: connected.slice(0, 2) },
        { name: 'postgres-a', testNames: connected.slice(1, 3) },
        { name: 'postgres-b', testNames: connected.slice(2, 4) }
    ];
    const first = buildShardPlan(names, 2, [1, 1], { affinityGroups });
    const second = buildShardPlan([...names].reverse(), 2, [1, 1], {
        affinityGroups: [...affinityGroups].reverse()
    });
    assert.deepEqual(first.methodsByShard, second.methodsByShard);
    const shardIds = new Set(['endpoint', 'postgres-a', 'postgres-b']
        .map((name) => first.affinityAssignments[name].shardId));
    assert.equal(shardIds.size, 1);
    const [componentShard] = shardIds;
    assert.ok(connected.every((method) => first.methodsByShard[componentShard].includes(method)));
    for (const name of ['endpoint', 'postgres-a', 'postgres-b'])
    {
        assert.equal(first.affinityAssignments[name].actualTestCaseCount, connected.length);
        assert.equal(first.affinityAssignments[name].affinityTaggedTestCaseCount, connected.length);
    }
    const partitioning = deriveBackendPartitionCount(names, {
        maxConcurrentProcesses: 3,
        potentialConcurrentProcesses: 10,
        affinityGroups
    });
    assert.equal(partitioning.affinityUnitCount, 1);
    assert.equal(partitioning.planningUnitCount, 9);
    assert.equal(partitioning.partitionCount, 9);
});

test('backend production reserves distinct shards for independent affinity components', () =>
{
    const names = [
        'Example.Tests.PostgresA.One',
        'Example.Tests.PostgresB.One',
        ...Array.from({ length: 8 }, (_, index) => `Example.Tests.Regular${index}.Case`)
    ];
    const plan = buildShardPlan(names, 3, [1, 1, 1], {
        affinityGroups: [
            { name: 'PostgresA', testNames: [names[0]] },
            { name: 'PostgresB', testNames: [names[1]] }
        ]
    });
    assert.notEqual(plan.affinityAssignments.PostgresA.shardId, plan.affinityAssignments.PostgresB.shardId);

    const exclusive = buildShardPlan(names, 3, [1, 1, 1], {
        affinityGroups: [
            { name: 'PostgresA', testNames: [names[0]] },
            { name: 'PostgresB', testNames: [names[1]] }
        ],
        exclusiveAffinityGroups: ['PostgresA', 'PostgresB']
    });
    const reserved = new Set([
        exclusive.affinityAssignments.PostgresA.shardId,
        exclusive.affinityAssignments.PostgresB.shardId
    ]);
    for (const shardId of reserved)
    {
        assert.equal(exclusive.methodsByShard[shardId].length, 1);
    }
    assert.equal(exclusive.methodsByShard.find((_, index) => !reserved.has(index)).length, names.length - 2);
});

test('backend production shard plan weights Docker cases independently without creating dependency affinity', () =>
{
    const affinityTests = ['Example.Tests.EndpointClass.EndpointA', 'Example.Tests.EndpointClass.EndpointB'];
    const dockerTests = [
        'Example.Tests.EndpointClass.EndpointA',
        ...Array.from({ length: 6 }, (_, index) => `Example.Tests.Docker${index}.Case`)
    ];
    const names = [
        ...affinityTests,
        ...dockerTests.slice(1),
        ...Array.from({ length: 6 }, (_, index) => `Example.Tests.Other${index}.Case`)
    ];
    const options = {
        affinityGroups: [{ name: 'EndpointContractApplication', testNames: affinityTests }],
        dependencyWeights: [{ name: 'Docker', testNames: dockerTests }]
    };
    const first = buildShardPlan(names, 2, [2, 2], options);
    const second = buildShardPlan([...names].reverse(), 2, [2, 2], options);
    assert.deepEqual(first.methodsByShard, second.methodsByShard);
    assert.equal(first.affinityAssignments.EndpointContractApplication.planningWeight, 5);
    assert.equal(first.planningWeightsByShard.reduce((total, weight) => total + weight, 0), names.length + 2 + dockerTests.length);
    const dockerAssignment = first.dependencyWeightAssignments.Docker;
    assert.equal(dockerAssignment.actualTestMethodCount, 7);
    assert.equal(dockerAssignment.actualTestCaseCount, 7);
    assert.equal(dockerAssignment.planningMultiplier, 2);
    assert.equal(dockerAssignment.additionalPlanningWeight, 7);
    assert.equal(dockerAssignment.weightedPlanningWeight, 14);
    assert.deepEqual(dockerAssignment.testMethods, [...dockerTests].sort());
    assert.ok(dockerAssignment.plannedTestMethodCountsByShard.every((count) => count > 0));
    assert.ok(dockerAssignment.plannedTestCaseCountsByShard.every((count) => count > 0));
    assert.equal(dockerAssignment.plannedTestMethodCountsByShard.reduce((sum, count) => sum + count, 0), 7);
    assert.equal(dockerAssignment.plannedTestCaseCountsByShard.reduce((sum, count) => sum + count, 0), 7);
    assert.throws(() => buildShardPlan(names, 2, [2, 2], {
        dependencyWeights: [{ name: 'Docker', testNames: ['Example.Tests.Outside'] }]
    }), /outside the production union/u);
    assert.throws(() => buildShardPlan(names, 2, [2, 2], {
        dependencyWeights: [{
            name: 'Docker',
            testNames: ['Example.Tests.EndpointClass.EndpointA', 'Example.Tests.EndpointClass.EndpointA']
        }]
    }), /case count exceeds the production union/u);
});
