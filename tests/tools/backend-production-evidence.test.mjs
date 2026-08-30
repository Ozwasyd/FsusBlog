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

test('backend production summary binds one coverage exact-union testhost', () =>
{
    const repositoryRoot = '/repo';
    const trxFiles = [`${repositoryRoot}/.tmp/test-results/backend/production/main-coverage.trx`];
    const summary = {
        status: 'success',
        executionMode: 'single-testhost-exact-union',
        partitionCount: 1,
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
        execution: {
            executedTestCaseCount: 3544,
            governanceRequirementTestCaseCount: 1,
            exactOnce: true,
            allPassed: true
        },
        partitions: [{
            id: 0,
            kind: 'coverage-exact-union',
            processSlot: 0,
            processors: 3,
            memoryGiB: 12,
            testCaseCount: 3544,
            trx: path.relative(repositoryRoot, trxFiles[0]).replaceAll(path.sep, '/'),
            coverageRoot: '.tmp/coverage/backend/production/main'
        }]
    };
    assert.deepEqual(validateShardSummaryArtifacts(summary, trxFiles, { repositoryRoot }), {
        partitionCount: 1,
        maxConcurrentProcesses: 1,
        initialConcurrentProcesses: 1,
        peakConcurrentProcesses: 1,
        potentialConcurrentProcesses: 1,
        plannedConcurrentProcesses: 1,
        globalPotentialConcurrentProcesses: 1,
        processorsByProcess: [3],
        allocatedCpuUnits: 3
    });
    const invalid = structuredClone(summary);
    invalid.execution.exactOnce = false;
    assert.throws(
        () => validateShardSummaryArtifacts(invalid, trxFiles, { repositoryRoot }),
        /does not prove a passing exact-once production union/u
    );
});

test('backend production summary records global 8, planned 5, initial 3, and five distinct coverage sessions', () =>
{
    const repositoryRoot = '/repo';
    const partitionCount = 5;
    const trxFiles = Array.from({ length: partitionCount }, (_, id) => (
        `${repositoryRoot}/.tmp/test-results/backend/production/shard-${id}.trx`
    ));
    const initialMemoryGiB = 3.17;
    const admittedMemoryGiB = 5.17;
    const addedMemoryGiB = (admittedMemoryGiB - initialMemoryGiB) / 2;
    const memoryGiBByProcess = [
        ...Array.from({ length: 3 }, () => initialMemoryGiB / 3),
        addedMemoryGiB,
        addedMemoryGiB
    ];
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
        allocatedMemoryGiB: admittedMemoryGiB,
        parallelism: { cpuBudget: 3, memoryGiB: initialMemoryGiB },
        resourceExpansion: {
            dynamic: true,
            initialGrant: { cpuUnits: 3, memoryGiB: initialMemoryGiB },
            observedGrant: { cpuUnits: 5, memoryGiB: admittedMemoryGiB },
            potentialBudget: { cpuUnits: 8, memoryGiB: 8 }
        },
        planningForecast: {
            initialTopology: {
                schema: 'fsusblog.backend-production-topology.v1',
                testhostCount: 3,
                rollingPartitionCount: 5,
                allocatedCpuUnits: 3,
                invariants: { exactCpuConservation: true, affinityUnitsRemainIndivisible: true }
            },
            potentialTopology: {
                schema: 'fsusblog.backend-production-topology.v1',
                testhostCount: 5,
                rollingPartitionCount: 5,
                allocatedCpuUnits: 8,
                invariants: { exactCpuConservation: true, governanceIncludedInExactUnion: true }
            }
        },
        partitions: trxFiles.map((file, id) => ({
            id,
            processSlot: id,
            processors: 1,
            memoryGiB: memoryGiBByProcess[id],
            timingStatus: 'unavailable',
            firstTestStartedAtUnixMs: null,
            testhostStartupMs: null,
            testExecutionSpanMs: null,
            trx: path.relative(repositoryRoot, file).replaceAll(path.sep, '/'),
            coverageRoot: `.tmp/coverage/backend/production/shard-${id}`
        }))
    };
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
    });
    assert.equal(new Set(summary.partitions.map(({ trx }) => trx)).size, partitionCount);
    assert.equal(new Set(summary.partitions.map(({ coverageRoot }) => coverageRoot)).size, partitionCount);

    const capacityConstrained = structuredClone(summary);
    capacityConstrained.maxConcurrentProcesses = 3;
    capacityConstrained.peakConcurrentProcesses = 3;
    capacityConstrained.processorsByProcess = [1, 1, 1];
    capacityConstrained.memoryGiBByProcess = Array.from({ length: 3 }, () => initialMemoryGiB / 3);
    capacityConstrained.allocatedCpuUnits = 3;
    capacityConstrained.allocatedMemoryGiB = initialMemoryGiB;
    capacityConstrained.resourceExpansion.observedGrant = {
        cpuUnits: 3,
        memoryGiB: initialMemoryGiB
    };
    capacityConstrained.partitions = capacityConstrained.partitions.map((partition, index) => ({
        ...partition,
        processSlot: index % 3,
        processors: 1,
        memoryGiB: initialMemoryGiB / 3
    }));
    assert.doesNotThrow(() => validateShardSummaryArtifacts(
        capacityConstrained,
        trxFiles,
        { repositoryRoot }
    ));

    const missedObservedExpansion = structuredClone(capacityConstrained);
    missedObservedExpansion.resourceExpansion.observedGrant = {
        cpuUnits: 5,
        memoryGiB: admittedMemoryGiB
    };
    assert.throws(
        () => validateShardSummaryArtifacts(missedObservedExpansion, trxFiles, { repositoryRoot }),
        /did not expand toward its observed scheduler grant/u
    );

    const invalidTopology = structuredClone(summary);
    invalidTopology.planningForecast.potentialTopology.rollingPartitionCount = 4;
    assert.throws(
        () => validateShardSummaryArtifacts(invalidTopology, trxFiles, { repositoryRoot }),
        /invalid topology planning evidence/u
    );
});

test('backend production category discovery binds special tiers to methods inside the union', () =>
{
    const names = [
        'Example.Tests.ApiClass.Api',
        'Example.Tests.AuthClass.Auth',
        'Example.Tests.ConcurrentClass.Concurrent(value: 1)',
        'Example.Tests.ConcurrentClass.Concurrent(value: 2)',
        'Example.Tests.PropertyClass.Property',
        'Example.Tests.GoldenClass.Golden',
        'Example.Tests.UnitClass.Unit'
    ];
    const plan = buildShardPlan(names, 2);
    const membership = validateCategoryMembership(plan, {
        ApiIntegration: ['Example.Tests.ApiClass.Api'],
        SecurityStateMachine: ['Example.Tests.AuthClass.Auth'],
        Concurrency: ['Example.Tests.ConcurrentClass.Concurrent(value: 1)', 'Example.Tests.ConcurrentClass.Concurrent(value: 2)'],
        Property: ['Example.Tests.PropertyClass.Property'],
        GoldenContract: ['Example.Tests.GoldenClass.Golden']
    });
    assert.deepEqual(membership.Concurrency, ['Example.Tests.ConcurrentClass.Concurrent']);
    assert.throws(() => validateCategoryMembership(plan, {
        ApiIntegration: ['Example.Tests.Outside'],
        SecurityStateMachine: ['Example.Tests.AuthClass.Auth'],
        Concurrency: ['Example.Tests.ConcurrentClass.Concurrent'],
        Property: ['Example.Tests.PropertyClass.Property'],
        GoldenContract: ['Example.Tests.GoldenClass.Golden']
    }), /outside the production union/u);
});

test('backend category discovery reports every independently failed projection', () =>
{
    const failure = aggregateCategoryDiscoveryFailures([
        { category: 'ApiIntegration', result: { code: 1, signal: null, stderr: 'api failed' } },
        { category: 'Concurrency', result: { code: 0, signal: null, stderr: '' } },
        { category: 'GoldenContract', result: { code: 2, signal: null, stderr: 'golden failed' } }
    ]);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.message, /2 independent branches: ApiIntegration, GoldenContract/u);
    assert.deepEqual(failure.errors.map((error) => error.message), [
        'ApiIntegration: api failed',
        'GoldenContract: golden failed'
    ]);
    assert.equal(aggregateCategoryDiscoveryFailures([
        { category: 'Concurrency', result: { code: 0, signal: null, stderr: '' } }
    ]), null);
});

test('backend projection discovery aggregates category, affinity, and dependency failures', () =>
{
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
    ]);
    assert.ok(failure instanceof AggregateError);
    assert.match(failure.message, /3 independent branches: Category=ApiIntegration, ShardAffinity=EndpointContractApplication, Dependency=Docker/u);
    assert.deepEqual(failure.errors.map((error) => error.message), [
        'Category=ApiIntegration: api failed',
        'ShardAffinity=EndpointContractApplication: affinity failed',
        'Dependency=Docker: docker failed'
    ]);
});

test('backend production executes fixed exact coverage shards with governance inside the union', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/test/run-backend-production-shards.mjs'), 'utf8');
    const start = source.indexOf('async function runExpandableBackendProductionShards');
    const end = source.indexOf('\nexport async function runBackendProductionShards', start);
    const executionBody = source.slice(start, end);
    const rolling = executionBody.indexOf('const outcomes = await runRollingPartitions');
    const finalize = executionBody.indexOf("runNode(['tools/security/check-perception-v2-e2e-evidence.mjs']");
    assert.ok(start > 0 && rolling > 0 && finalize > rolling);
    assert.match(executionBody, /'--ListTests'[\s\S]*?`--Diag:\$\{diagnosticFile\}`/u);
    assert.match(executionBody, /prepareShardFiles\(plan,[\s\S]*?runRollingPartitions/u);
    assert.match(executionBody, /readBackendResourceGrantAfterBenchmark/u);
    assert.match(executionBody, /outerSchedulerGrant[\s\S]*?cpuUnits: parallelism\.cpuBudget,[\s\S]*?memoryGiB: parallelism\.memoryGiB/u);
    assert.match(executionBody, /'--Collect:XPlat Code Coverage'/u);
    assert.match(executionBody, /`--logger:trx;LogFileName=\$\{path\.basename\(trxFile\)\}`/u);
    assert.match(executionBody, /`--ResultsDirectory:\$\{resultRoot\}`/u);
    assert.match(executionBody, /`--TestAdapterPath:\$\{partition\.collectorDirectory\}`/u);
    assert.match(executionBody, /fs\.copyFileSync\(collectorTrxFile, trxFile\)/u);
    assert.match(source, /FsusBlog\.Server\.Tests\.deps\.json[\s\S]*?FsusBlog\.Server\.Tests\.runtimeconfig\.json/u);
    assert.match(source, /assets\.packageFolders[\s\S]*?coverlet\.collector\.dll/u);
    assert.match(source, /<TestCaseFilter>\$\{escapeXml\(filter\)\}<\/TestCaseFilter>/u);
    assert.match(executionBody, /executionPolicy: 'fixed-exact-partitions-expand-on-live-grant'/u);
    assert.match(executionBody, /kind: 'coverage-shard'/u);
    assert.doesNotMatch(executionBody, /kind: 'governance-postlude'|postludeResult|governance-postlude\.trx/u);
    assert.match(executionBody, /governanceRequirementTestCaseCount: 1/u);
    assert.equal((executionBody.match(/check-perception-v2-e2e-evidence\.mjs/gu) ?? []).length, 1);
});

test('exact-union requirement governance remains a pure JSON and evidence-path consumer', () =>
{
    const source = fs.readFileSync(path.join(root, 'tests/backend/Unit/BackendTestGovernanceTests.cs'), 'utf8');
    const start = source.indexOf('public void Issue40Requirements_HaveEvidenceAndRiskTraceability()');
    const end = source.indexOf('\n    [Fact]', start);
    assert.ok(start > 0 && end > start);
    const method = source.slice(start, end);
    assert.match(method, /ReadRequirementsFixture\(\)/u);
    assert.match(method, /AssertEvidencePathsExist\(requirement\["evidencePaths"\]/u);
    assert.doesNotMatch(method, /FsusBlog\.Server|WebApplication|ServiceCollection|BuildServiceProvider|Process\.|Assembly\.|Activator\./u);
});

test('backend requirement profiles treat generated evidence as matrix-owned output', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/check-backend-test-governance.mjs'), 'utf8');
    assert.match(
        source,
        /for \(const path of profile\.evidencePaths \|\| \[\]\)[\s\S]*?requireEvidencePath\(path\);/u
    );
    assert.doesNotMatch(
        source,
        /for \(const path of profile\.evidencePaths \|\| \[\]\)[\s\S]{0,120}?requireFile\(path\);/u
    );
});

test('Perception evidence finalizer resolves non-ASCII repository paths from file URLs', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/security/check-perception-v2-e2e-evidence.mjs'), 'utf8');
    assert.match(source, /fileURLToPath\(import\.meta\.url\)/u);
    assert.doesNotMatch(source, /new URL\(import\.meta\.url\)\.pathname/u);
});

test('backend bundle delegates shard sizing to the runtime CPU budget without fail-fast controls', () =>
{
    const source = fs.readFileSync(path.join(root, 'tools/test/bundles/run-bundle.mjs'), 'utf8');
    assert.match(source, /FSUSBLOG_BACKEND_CPU_BUDGET="\$FSUSBLOG_STEP_CPU_BUDGET" node tools\/test\/run-backend-production-shards\.mjs/u);
    assert.match(source, /FSUSBLOG_BUNDLE_MEMORY_GIB: String\(stepCapacity\.memoryGiB\)/u);
    assert.match(source, /const testStep = commandStep\('dotnet-production-union',[\s\S]*?minCpuUnits: 2,[\s\S]*?minMemoryGiB: backendTopologyDefaults\.memoryGiBPerTesthost \* 2/u);
    assert.doesNotMatch(source, /dotnet-production-union'[\s\S]{0,240}?dependsOn:/u);
    assert.doesNotMatch(source, /FSUSBLOG_BACKEND_PRODUCTION_SHARDS=2|FSUSBLOG_BACKEND_SHARD_PROCESSORS=2/u);
    assert.doesNotMatch(source, /(?:fail-fast|maxFailures|--blame-hang)/u);
    assert.match(source, /await executeBundleStepDag\(\[[\s\S]*?testStep,[\s\S]*?perception-matrix[\s\S]*?integrity-proof/u);
    assert.match(source, /perception-matrix[\s\S]*?dependsOn: \['dotnet-production-union'\]/u);
    assert.match(source, /perception-evidence-finalize[\s\S]*?dependsOn: \['perception-matrix'\]/u);
    const backendFinalizer = source.match(/commandStep\('perception-evidence-finalize',[\s\S]*?\}\),/u)?.[0] ?? '';
    assert.doesNotMatch(backendFinalizer, /check-perception-v2-e2e-evidence\.mjs/u);
    assert.match(backendFinalizer, /FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE/u);
    assert.match(source, /integrity-proof[\s\S]*?dependsOn: \['perception-matrix'\]/u);
    assert.match(source, /backend-coverage-summary[\s\S]*?dependsOn: \['dotnet-production-union'\]/u);
    assert.match(source, /readPerceptionUnionProjection[\s\S]*?perception-v2\.union-projection\.v1[\s\S]*?schedulerRunId\(\)[\s\S]*?expectedDllDigest[\s\S]*?expectedTrxDigests/u);
});
