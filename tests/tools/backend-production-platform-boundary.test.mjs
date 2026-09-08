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

test('Unix symlink-boundary evidence binds physical escape denial and an internal-link positive control', () =>
{
    const plan = projectBackendPlatformPlan([unixSymlinkBoundaryPlatformTest], 'linux', {
        baseFilter: 'Category!=Integration',
        lane: 'backend-unit'
    });
    assert.equal(plan.platformTests[0].evidenceContract, 'unix-symlink-boundary');
    assert.equal(plan.platformTests[0].source, unixSymlinkBoundaryPlatformTest.source);
    assert.equal(plan.platformTests[0].assembly, 'FsusBlog.Server.Tests.dll');

    const ordinary = reconcileBackendPlatformOutcome(
        plan,
        parseBackendPlatformTrx(unixSymlinkBoundaryTrx())
    );
    assert.deepEqual(ordinary.platformTests[0].evidence, unixSymlinkBoundaryRuntimeEvidence);

    const production = reconcileBackendPlatformOutcome(
        projectProductionPlatformPlan([
            unixSymlinkBoundaryPlatformTest,
            {
                ...portablePlatformTest,
                id: 'unix-symlink-boundary-integration',
                displayName: 'Example.Tests.Security.ExcludedIntegration',
                traits: { Category: ['Integration'] }
            }
        ], 'linux'),
        parseTrxRecords(unixSymlinkBoundaryTrx())
    );
    assert.deepEqual(production.platformTests[0].evidence, unixSymlinkBoundaryRuntimeEvidence);

    const windows = projectBackendPlatformPlan([unixSymlinkBoundaryPlatformTest], 'win32');
    assert.equal(windows.platformTests[0].result, 'not-selected');
    assert.equal(windows.platformTests[0].evidenceContract, 'unix-symlink-boundary');
    assert.equal(Object.hasOwn(windows.platformTests[0], 'evidence'), false);
});

test('Unix symlink-boundary evidence rejects missing execution facts, wrong relationships, and stale identities', () =>
{
    const plan = projectBackendPlatformPlan([unixSymlinkBoundaryPlatformTest], 'linux');
    assert.throws(
        () => reconcileBackendPlatformOutcome(plan, [{
            testId: unixSymlinkBoundaryPlatformTest.id,
            testName: unixSymlinkBoundaryPlatformTest.displayName,
            outcome: 'Passed'
        }]),
        /passed without required runtime evidence/u
    );
    for (const invalid of [
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            escapeLink: {
                ...unixSymlinkBoundaryRuntimeEvidence.escapeLink,
                exists: false
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            escapeLink: {
                ...unixSymlinkBoundaryRuntimeEvidence.escapeLink,
                targetOutsideRoot: false
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            escapeLink: {
                ...unixSymlinkBoundaryRuntimeEvidence.escapeLink,
                targetMatchesExpected: false
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            rejection: {
                resolved: true,
                pathEmpty: false
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            positiveControl: {
                ...unixSymlinkBoundaryRuntimeEvidence.positiveControl,
                resolvedInsideRoot: false
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            cleanupCompleted: false
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            root: {
                ...unixSymlinkBoundaryRuntimeEvidence.root,
                identity: unixSymlinkBoundaryRuntimeEvidence.escapeLink.targetIdentity
            }
        },
        {
            ...unixSymlinkBoundaryRuntimeEvidence,
            root: {
                ...unixSymlinkBoundaryRuntimeEvidence.root,
                identity: 'not-a-digest'
            }
        }
    ])
    {
        assert.throws(
            () => reconcileBackendPlatformOutcome(
                plan,
                parseBackendPlatformTrx(unixSymlinkBoundaryTrx(invalid))
            ),
            /backend Unix symlink-boundary evidence/u
        );
    }
});

test('raw Passed counters without a concrete execution row are rejected', () =>
{
    assert.throws(
        () => parseBackendPlatformTrx(
            '<TestRun><Results></Results><ResultSummary outcome="Completed">'
            + '<Counters total="1" executed="1" passed="1" failed="0" />'
            + '</ResultSummary></TestRun>'
        ),
        /without one executed evidence row/u
    );
});

test('backend platform filter composition preserves every production exclusion', () =>
{
    const base = 'Category!=Integration&Category!=Performance&Fixture!=LocalRedis';
    assert.equal(
        composeBackendPlatformFilter(base, 'win32'),
        '(Category!=Integration&Category!=Performance&Fixture!=LocalRedis)&Platform!=Unix'
    );
    for (const platform of ['linux', 'darwin'])
    {
        assert.equal(composeBackendPlatformFilter(base, platform), base);
    }
    assert.throws(
        () => composeBackendPlatformFilter('', 'win32'),
        /backend base test filter is required/u
    );
    assert.throws(
        () => composeBackendPlatformFilter(base, 'freebsd'),
        /unsupported backend runtime platform/u
    );
});

test('backend Production union consumes the canonical Unix platform plan', () =>
{
    const source = '/repo/tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll';
    const portable = {
        id: 'portable',
        fullyQualifiedName: 'Example.Tests.Portable.Case',
        displayName: 'Example.Tests.Portable.Case',
        source,
        traits: {}
    };
    const unix = {
        id: 'unix',
        fullyQualifiedName: 'Example.Tests.Unix.Case',
        displayName: 'Example.Tests.Unix.Case',
        source,
        traits: { Platform: ['Unix'] }
    };
    const integration = {
        id: 'integration',
        fullyQualifiedName: 'Example.Tests.Integration.Case',
        displayName: 'Example.Tests.Integration.Case',
        source,
        traits: { Category: ['Integration'], Platform: ['Unix'] }
    };
    const localRedis = {
        id: 'local-redis',
        fullyQualifiedName: 'Example.Tests.LocalRedis.Case',
        displayName: 'Example.Tests.LocalRedis.Case',
        source,
        traits: { Fixture: ['LocalRedis'] }
    };

    const records = [portable, unix, integration, localRedis];
    assert.deepEqual(projectProductionUnionRecords(records, 'win32'), [portable]);
    assert.deepEqual(projectProductionUnionRecords(records, 'linux'), [portable, unix]);
    assert.deepEqual(projectProductionUnionRecords(records, 'darwin'), [portable, unix]);
    const windows = projectProductionPlatformPlan(records, 'win32');
    assert.equal(
        windows.executionFilter,
        '(Category!=Integration&Category!=Performance&Fixture!=LocalRedis)&Platform!=Unix'
    );
    assert.equal(windows.platformTests.length, 1);
    assert.equal(windows.platformTests[0].result, 'not-selected');
});

test('backend requirement governance remains exact-once inside the canonical union', () =>
{
    const governance = 'FsusBlog.Server.Tests.Unit.BackendTestGovernanceTests.Issue40Requirements_HaveEvidenceAndRiskTraceability';
    const union = ['Example.Tests.Other.Case', governance];
    assert.deepEqual(validateExactProductionUnion(union, [[
        { testName: union[0], outcome: 'Passed' },
        { testName: governance, outcome: 'Passed' }
    ]]), {
        executedTestCaseCount: 2,
        executedMethodCount: 2,
        exactOnce: true,
        allPassed: true
    });
    assert.throws(
        () => validateExactProductionUnion(['Example.Tests.Other.Case'], [[
            { testName: 'Example.Tests.Other.Case', outcome: 'Passed' }
        ]]),
        /requires exactly one/u
    );
    assert.throws(
        () => validateExactProductionUnion(union, [[
            { testName: governance, outcome: 'Passed' },
            { testName: governance, outcome: 'Passed' }
        ]]),
        /do not match their exact filters/u
    );
    const emojiCase = 'Example.Tests.Other.Theory(value: "🙂")';
    const authoritativeRecords = [
        { id: 'emoji-id', displayName: emojiCase },
        { id: 'governance-id', displayName: governance }
    ];
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
    });
});

test('backend PostgreSQL manifest projects exact classes as soft planning weights', () =>
{
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
                tests: [{ path: 'Unit/CombinedMigrationTests.cs', class: 'BetaTests' }]
            }
        ]
    };
    const combinedMigrationSource = 'public sealed class UnitOnlyMigrationTests {}\npublic sealed class BetaTests {}';
    const sources = new Map([
        ['/repo/tests/backend/Unit/AlphaTests.cs', 'public sealed class AlphaTests {}'],
        ['/repo/tests/backend/Integration/ExcludedIntegrationTests.cs', 'public sealed class ExcludedIntegrationTests {}'],
        ['/repo/tests/backend/Unit/CombinedMigrationTests.cs', combinedMigrationSource],
        ['/repo/tests/backend/Unit/MissingTests.cs', 'public sealed class MissingTests {}']
    ]);
    const sourceOptions = {
        repositoryRoot: '/repo',
        readFile: (file) => sources.get(file)
    };
    const planningOptions = {
        excludedTestNames: ['FsusBlog.Server.Tests.Integration.ExcludedIntegrationTests.Case'],
        ...sourceOptions
    };
    const union = [
        'FsusBlog.Server.Tests.Unit.AlphaTests.First',
        'FsusBlog.Server.Tests.Unit.AlphaTests.Theory(value: 1)',
        'FsusBlog.Server.Tests.Unit.BetaTests.Second',
        'FsusBlog.Server.Tests.Unit.EndpointTests.Contract'
    ];
    const postgres = buildPostgresCollectionPlanningWeights(union, manifest, planningOptions);
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
    ]);
    for (const weight of postgres)
    {
        weight.classStartupPenalty = deriveClassStartupPenalty(weight.testNames, weight.estimatedFacts);
    }
    const endpointWeight = { name: 'EndpointContractApplication', testNames: [union[1], union[3]] };
    endpointWeight.classStartupPenalty = deriveColdApplicationStartupPenalty(union.length);
    assert.equal(endpointWeight.classStartupPenalty, 2);
    const softPlan = buildShardPlan(union, 2, [1, 1], {
        affinityGroups: [],
        dependencyWeights: [
            ...postgres,
            endpointWeight
        ]
    });
    assert.deepEqual(softPlan.affinityAssignments, {});
    assert.notEqual(
        softPlan.methodsByShard.findIndex((methods) => methods.includes('FsusBlog.Server.Tests.Unit.AlphaTests.First')),
        softPlan.methodsByShard.findIndex((methods) => methods.includes('FsusBlog.Server.Tests.Unit.BetaTests.Second'))
    );
    const missing = structuredClone(manifest);
    missing.collections[1].tests[0].class = 'MissingTests';
    missing.collections[1].tests[0].path = 'Unit/MissingTests.cs';
    assert.throws(
        () => buildPostgresCollectionPlanningWeights(union, missing, planningOptions),
        /must match exactly one authoritative VSTest class/u
    );
    const wrongSource = structuredClone(manifest);
    wrongSource.collections[1].tests[0].class = 'UnitOnlyMigrationTests';
    assert.throws(
        () => buildPostgresCollectionPlanningWeights(union, wrongSource, planningOptions),
        /must match exactly one authoritative VSTest class/u
    );
    const absentDeclaration = structuredClone(manifest);
    absentDeclaration.collections[1].tests[0].class = 'DeclaredOnlyInTheManifest';
    assert.throws(
        () => buildPostgresCollectionPlanningWeights(union, absentDeclaration, planningOptions),
        /does not declare class DeclaredOnlyInTheManifest/u
    );
    const missingSource = structuredClone(manifest);
    missingSource.collections[1].tests[0].path = 'Unit/AbsentMigrationTests.cs';
    assert.throws(
        () => buildPostgresCollectionPlanningWeights(union, missingSource, planningOptions),
        /source file is missing: Unit\/AbsentMigrationTests\.cs/u
    );
    const pseudoDeclarations = [
        '// public sealed class BetaTests {}',
        '/* public sealed class BetaTests {} */',
        'const string Source = "public sealed class BetaTests {}";',
        'const string Source = """\npublic sealed class BetaTests {}\n""";'
    ];
    for (const pseudoDeclaration of pseudoDeclarations)
    {
        sources.set('/repo/tests/backend/Unit/CombinedMigrationTests.cs', pseudoDeclaration);
        assert.throws(
            () => buildPostgresCollectionPlanningWeights(union, manifest, planningOptions),
            /does not declare class BetaTests/u
        );
    }
    sources.set('/repo/tests/backend/Unit/CombinedMigrationTests.cs', combinedMigrationSource);
});

test('rolling production splits PostgreSQL collections by class while application startup stays a soft weight', () =>
{
    const source = fs.readFileSync('tools/test/run-backend-production-shards.mjs', 'utf8');
    const rollingStart = source.indexOf('const affinityTests = projectTraitMembership');
    const rollingEnd = source.indexOf('const partitioning = deriveBackendPartitionCount', rollingStart);
    const rollingSource = source.slice(rollingStart, rollingEnd);
    assert.match(rollingSource, /buildPostgresAffinityGroups/u);
    assert.match(rollingSource, /postgresGroups,\s*potentialProcessCount/u);
    assert.match(rollingSource, /\.\.\.applicationWeights/u);
    assert.match(rollingSource, /deriveColdApplicationStartupPenalty\(mainTestNames\.length\)/u);
    assert.doesNotMatch(rollingSource, /\.\.\.postgresGroups,[\s\S]*?\.\.\.applicationWeights/u);
    assert.match(source, /executionDriver: 'vstest-copy'/u);
    assert.doesNotMatch(source, /partition\.executionDriver === 'dotnet-test-project'/u);
});

test('PostgreSQL affinity groups scale deterministically and keep every class intact', () =>
{
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
    }];
    const two = buildPostgresAffinityGroups(groups, 2);
    assert.deepEqual(two, groups);
    const three = buildPostgresAffinityGroups(groups, 3);
    assert.equal(three.length, 3);
    assert.deepEqual(three.flatMap((group) => group.testNames).sort(), groups.flatMap((group) => group.testNames).sort());
    const classToGroup = new Map();
    for (const [groupIndex, group] of three.entries())
    {
        for (const testName of group.testNames)
        {
            const className = testName.split('.').slice(0, -1).join('.');
            assert.ok(!classToGroup.has(className) || classToGroup.get(className) === groupIndex);
            classToGroup.set(className, groupIndex);
        }
    }
    const machineMaximum = buildPostgresAffinityGroups(groups, 8);
    assert.equal(machineMaximum.length, 4);
    assert.deepEqual(
        machineMaximum.map((group) => group.testNames.length).sort((left, right) => left - right),
        [1, 2, 2, 3]
    );
    assert.throws(() => buildPostgresAffinityGroups(groups, 1), /cannot be smaller/u);
});

test('backend PostgreSQL planning admits only source-proven class-wide production exclusions', () =>
{
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
    };
    const sources = new Map([
        ['/repo/tests/backend/Unit/AlphaTests.cs', 'public sealed class AlphaTests {}'],
        ['/repo/tests/backend/Integration/ExcludedTests.cs', '[Trait("Category", "Integration")]\npublic sealed class ExcludedTests {}'],
        ['/repo/tests/backend/Unit/BetaTests.cs', 'public sealed class BetaTests {}']
    ]);
    const exclusions = readManifestClassWideProductionExclusions(manifest, {
        repositoryRoot: '/repo',
        readFile: (file) => sources.get(file)
    });
    assert.deepEqual(exclusions, ['ExcludedTests']);
    const projected = buildPostgresCollectionPlanningWeights([
        'Example.Unit.AlphaTests.One',
        'Example.Unit.AlphaTests.Two',
        'Example.Unit.BetaTests.One'
    ], manifest, {
        manifestExcludedClasses: exclusions,
        repositoryRoot: '/repo',
        readFile: (file) => sources.get(file)
    });
    assert.deepEqual(projected.map(({ excludedTestCaseCount }) => excludedTestCaseCount), [1, 0]);
});
