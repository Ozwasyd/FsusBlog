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

test('backend production rolling partitions start LPT-heavy shards first and refill with the next heavy tail', async () =>
{
    const partitions = [
        { index: 0, planningWeight: 1, testCaseCount: 500, startupWeight: 1 },
        { index: 1, planningWeight: 100, testCaseCount: 20, startupWeight: 1 },
        { index: 2, planningWeight: 80, testCaseCount: 30, startupWeight: 1 },
        { index: 3, planningWeight: 2, testCaseCount: 600, startupWeight: 1 },
        { index: 4, planningWeight: 60, testCaseCount: 40, startupWeight: 1 }
    ];
    const gates = Object.fromEntries(partitions.map(({ index }) =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return [index, { promise, resolve }];
    }));
    const started = [];
    const rolling = runRollingPartitions(partitions, [1, 1], async (partition) =>
    {
        started.push(partition.index);
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1, 2]);
    gates[2].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1, 2, 4]);
    for (const gate of Object.values(gates))
    {
        gate.resolve();
    }
    const outcomes = await rolling;
    assert.deepEqual(outcomes.map(({ partition }) => partition.index), [0, 1, 2, 3, 4]);
});

test('backend production rolling partitions start affinity shards before heavier ordinary shards', async () =>
{
    const started = [];
    const gates = Array.from({ length: 3 }, () =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    const rolling = runRollingPartitions([
        { index: 0, planningWeight: 1, affinityPriority: true },
        { index: 1, planningWeight: 100, affinityPriority: false },
        { index: 2, planningWeight: 90, affinityPriority: false }
    ], [1], async (partition) =>
    {
        started.push(partition.index);
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [0]);
    for (const gate of gates)
    {
        gate.resolve();
    }
    await rolling;
});

test('backend production admits one memory-proven ordinary bridge while live CPUs wait on PostgreSQL affinity', async () =>
{
    const gates = Array.from({ length: 5 }, () =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    let grant = { cpuUnits: 2, memoryGiB: 2 };
    let publishGrant;
    const started = [];
    const rolling = runRollingPartitions([
        { index: 0, affinityPriority: true, planningWeight: 30 },
        { index: 1, affinityPriority: true, planningWeight: 29 },
        { index: 2, affinityPriority: true, planningWeight: 28 },
        { index: 3, affinityPriority: false, planningWeight: 100 },
        { index: 4, affinityPriority: false, planningWeight: 90 }
    ], [1, 1], async (partition, slot) =>
    {
        started.push({ partition: partition.index, admission: slot.admission ?? 'scheduler-grant' });
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
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
        waitForResourceChange: () => new Promise((resolve) =>
        {
            publishGrant = resolve;
        })
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.map(({ partition }) => partition), [0, 1]);
    grant = { cpuUnits: 3, memoryGiB: 3 };
    publishGrant();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [
        { partition: 0, admission: 'scheduler-grant' },
        { partition: 1, admission: 'scheduler-grant' },
        { partition: 2, admission: 'scheduler-grant' },
        { partition: 3, admission: 'io-overcommit' }
    ]);
    gates[3].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started.at(-1), { partition: 4, admission: 'io-overcommit' });
    gates[0].resolve();
    gates[4].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (const gate of gates)
    {
        gate.resolve();
    }
    const outcomes = await rolling;
    assert.equal(outcomes.rollingExecution.peakConcurrentProcesses, 4);
    assert.deepEqual(outcomes.rollingExecution.ioOvercommit, {
        enabled: true,
        admittedProcessCount: 1,
        peakCpuOvercommitUnits: 1,
        executedPartitionCount: 2,
        memoryGiBPerProcess: 1,
        observedAvailableMemoryGiB: 4,
        reason: 'bridge-ordinary-coverage-while-postgres-affinity-is-io-bound'
    });
});

test('backend production waits for the run-bound benchmark marker before expanding 3 STEP slots to 5 bundle slots', async () =>
{
    const partitions = Array.from({ length: 5 }, (_, index) => ({ index }));
    const gates = partitions.map(() =>
    {
        let resolve;
        const promise = new Promise((done) =>
        {
            resolve = done;
        });
        return { promise, resolve };
    });
    const runId = 'barrier-run';
    const initialMemoryGiB = 3.17;
    const outerGrant = {
        cpuUnits: 5,
        memoryGiB: 5.17,
        resourceBudget: { cpuUnits: 8, memoryGiB: 8 }
    };
    let markerExists = false;
    let publishGrant;
    const started = [];
    const readResourceGrant = () => readBackendResourceGrantAfterBenchmark({
        env: { FSUSBLOG_TEST_RUN_ID: runId },
        initialGrant: { cpuUnits: 3, memoryGiB: initialMemoryGiB },
        repositoryRoot: '/repo',
        exists: (file) =>
        {
            assert.equal(file, `/repo/.tmp/test-runs/${runId}/benchmark-build-ready.json`);
            return markerExists;
        },
        readFile: () => JSON.stringify({
            schema: 'fsusblog.local-production.benchmark-build-ready.v1',
            status: 'success',
            physicalBundleId: 'backend-tests',
            schedulerRunId: runId
        }),
        readSchedulerGrant: () => outerGrant
    });
    const rolling = runRollingPartitions(partitions, [1, 1, 1], async (partition, slot) =>
    {
        started.push({ partition: partition.index, ...slot });
        await gates[partition.index].promise;
        return { index: partition.index, code: 0, signal: null };
    }, {
        initialMemoryGiBByProcess: Array.from({ length: 3 }, () => initialMemoryGiB / 3),
        readResourceGrant,
        potentialProcessCount: 5,
        potentialMemoryGiB: 8,
        waitForResourceChange: () => new Promise((resolve) =>
        {
            publishGrant = resolve;
        })
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 3);
    markerExists = true;
    publishGrant();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started.length, 5);
    const addedSlots = started.filter(({ processSlot }) => processSlot >= 3);
    assert.equal(addedSlots.length, 2);
    const expectedAddedMemoryGiB = (outerGrant.memoryGiB - initialMemoryGiB) / 2;
    assert.ok(addedSlots.every(({ processors }) => processors === 1));
    assert.ok(addedSlots.every(({ memoryGiB }) => Math.abs(memoryGiB - expectedAddedMemoryGiB) < 1e-12));
    assert.ok(started.reduce((sum, { processors }) => sum + processors, 0) <= outerGrant.cpuUnits);
    assert.ok(started.reduce((sum, { memoryGiB }) => sum + memoryGiB, 0) <= outerGrant.memoryGiB + 1e-12);

    for (const gate of gates)
    {
        gate.resolve();
    }
    const outcomes = await rolling;
    assert.equal(outcomes.rollingExecution.initialConcurrentProcesses, 3);
    assert.equal(outcomes.rollingExecution.peakConcurrentProcesses, 5);
    assert.deepEqual(outcomes.rollingExecution.observedGrant, {
        cpuUnits: outerGrant.cpuUnits,
        memoryGiB: outerGrant.memoryGiB
    });
});

test('backend production shard validation rejects omissions and cross-shard execution', () =>
{
    const names = Array.from({ length: 30 }, (_, index) => `Example.Tests.Class${index}.Case`);
    names.push('Example.Tests.TheoryClass.Theory(value: 1)', 'Example.Tests.TheoryClass.Theory(value: 2)');
    const plan = buildShardPlan(names, 2);
    const records = plan.methodsByShard.map((methods) => methods.flatMap((method) =>
    {
        const count = plan.methodCounts.get(method);
        return Array.from({ length: count }, (_, index) => ({
            testName: count === 1 ? method : `${method}(value: ${index})`,
            outcome: 'Passed'
        }));
    }));
    assert.deepEqual(validateShardRecords(plan, records), {
        executedTestCaseCount: names.length,
        executedMethodCount: plan.methodCounts.size
    });
    assert.throws(() => validateShardRecords(plan, records.map((entries, index) => index === 0 ? entries.slice(1) : entries)), /executed .* discovery required/u);
    const foreign = records.map((entries) => [...entries]);
    foreign[0][0] = { testName: plan.methodsByShard[1][0], outcome: 'Passed' };
    assert.throws(() => validateShardRecords(plan, foreign), /out-of-partition/u);
});

test('backend production TRX parser retains result names and outcomes', () =>
{
    const records = parseTrxRecords([
        '<TestRun><Results>',
        '<UnitTestResult testId="fact-id" testName="Example.Tests.Fact" outcome="Passed" />',
        '<UnitTestResult testId="rule-id" testName="Example.Tests.Rule(value: &quot;a&quot;)" outcome="Passed" />',
        '</Results></TestRun>'
    ].join(''));
    assert.deepEqual(records, [
        { testId: 'fact-id', testName: 'Example.Tests.Fact', outcome: 'Passed' },
        { testId: 'rule-id', testName: 'Example.Tests.Rule(value: "a")', outcome: 'Passed' }
    ]);
});

test('backend production TRX timing evidence records first-test startup boundaries', () =>
{
    const timing = parseTrxTimingEvidence(`
    <TestRun><Results>
      <UnitTestResult testId="one" testName="Example.One" outcome="Passed" startTime="2026-07-14T01:00:01.000Z" endTime="2026-07-14T01:00:03.000Z" />
      <UnitTestResult testId="two" testName="Example.Two" outcome="Passed" startTime="2026-07-14T01:00:00.500Z" endTime="2026-07-14T01:00:04.500Z" />
    </Results></TestRun>`);
    assert.deepEqual(timing, {
        status: 'measured',
        firstTestStartedAtUnixMs: Date.parse('2026-07-14T01:00:00.500Z'),
        lastTestEndedAtUnixMs: Date.parse('2026-07-14T01:00:04.500Z'),
        testExecutionSpanMs: 4000
    });
    assert.deepEqual(parseTrxTimingEvidence('<TestRun />'), {
        status: 'unavailable',
        firstTestStartedAtUnixMs: null,
        lastTestEndedAtUnixMs: null,
        testExecutionSpanMs: null
    });
});

test('backend production TRX execution evidence rejects skips, omissions, and repeated IDs', () =>
{
    const trx = (results, counters = `total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"`) => `
    <TestRun><Results>${results}</Results><ResultSummary outcome="Completed"><Counters ${counters} /></ResultSummary></TestRun>`;
    const passing = trx([
        '<UnitTestResult testId="one" testName="Example.One" outcome="Passed" />',
        '<UnitTestResult testId="two" testName="Example.Two" outcome="Passed" />'
    ].join(''));
    assert.equal(parseTrxExecutionEvidence(passing).records.length, 2);
    assert.throws(
        () => parseTrxExecutionEvidence(passing.replace('notExecuted="0"', 'notExecuted="1"')),
        /do not prove every selected test executed and passed/u
    );
    assert.throws(
        () => parseTrxExecutionEvidence(passing.replace('testId="two"', 'testId="one"')),
        /empty or repeated/u
    );
});

test('backend production summary binds rolling process capacity and artifacts to every partition', () =>
{
    const repositoryRoot = '/repo';
    const trxFiles = [0, 1, 2, 3].map((index) => `${repositoryRoot}/.tmp/test-results/backend/production/shard-${index}.trx`);
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
    };
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
    });
    assert.throws(
        () => validateShardSummaryArtifacts(summary, trxFiles.slice(1), { repositoryRoot }),
        /expected 4 partition TRX files, received 3/u
    );
    const duplicate = structuredClone(summary);
    duplicate.partitions[2].trx = duplicate.partitions[1].trx;
    assert.throws(
        () => validateShardSummaryArtifacts(duplicate, trxFiles, { repositoryRoot }),
        /repeats TRX/u
    );
    const mismatchedProcessors = structuredClone(summary);
    mismatchedProcessors.partitions[1].processors = 2;
    assert.throws(
        () => validateShardSummaryArtifacts(mismatchedProcessors, trxFiles, { repositoryRoot }),
        /processor allocation is not bound to its process slot/u
    );
    const mismatchedMemory = structuredClone(summary);
    mismatchedMemory.partitions[2].memoryGiB = 7.5;
    assert.throws(
        () => validateShardSummaryArtifacts(mismatchedMemory, trxFiles, { repositoryRoot }),
        /memory allocation is not bound to its process slot/u
    );
    const missingCpuBudget = structuredClone(summary);
    delete missingCpuBudget.parallelism.cpuBudget;
    assert.throws(
        () => validateShardSummaryArtifacts(missingCpuBudget, trxFiles, { repositoryRoot }),
        /missing a valid parallelism\.cpuBudget/u
    );
    const missingMemoryBudget = structuredClone(summary);
    delete missingMemoryBudget.parallelism.memoryGiB;
    assert.throws(
        () => validateShardSummaryArtifacts(missingMemoryBudget, trxFiles, { repositoryRoot }),
        /missing a valid parallelism\.memoryGiB/u
    );
});
