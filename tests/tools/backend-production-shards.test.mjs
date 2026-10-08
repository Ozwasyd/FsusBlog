import assert from 'node:assert/strict';
import test from 'node:test';

const {composeBackendPlatformFilter, parseBackendPlatformTrx, projectBackendPlatformPlan, reconcileBackendPlatformOutcome} = await import(new URL('../../tools/test/backend-platform-selection.mjs', import.meta.url));
const {alignAuthoritativeDiscovery, backendDiscoveryEnvironment, normalizeListedTestName, parseListedTests, parseTrxRecords, projectProductionPlatformPlan, projectProductionUnionRecords, runAuthoritativeProductionDiscovery} = await import(new URL('../../tools/test/run-backend-production-shards.mjs', import.meta.url));
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



test('backend production discovery normalizes theory cases to one filterable method', () =>
{
    assert.equal(normalizeListedTestName('Example.Tests.Rule(value: "a")'), 'Example.Tests.Rule');
    assert.equal(normalizeListedTestName('Example.Tests.Fact'), 'Example.Tests.Fact');
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
    ]);
    assert.throws(() => parseListedTests([
        'The following Tests are available:',
        'Microsoft.VisualStudio.TestPlatform.ObjectModel.TestPlatformException: Testhost exited: missing dependency',
        '   at Example.Stack()'
    ].join('\n')), /discovery testhost failed:.*missing dependency/u);
});
test('backend production runs one authoritative discovery for union and trait projections', async () =>
{
    const startedFilters = [];
    const run = runAuthoritativeProductionDiscovery((filter, slot) =>
    {
        startedFilters.push(filter);
        assert.deepEqual(slot, { processSlot: 0, maxParallel: 1, kind: 'union', name: null });
        return Promise.resolve({ code: 0, signal: null, stdout: 'union', stderr: '', durationMs: 1 });
    });
    const result = await run;
    assert.deepEqual(startedFilters, [null]);
    assert.equal(result.discovery.stdout, 'union');
    assert.deepEqual(result.categoryDiscoveryRuns, []);
    assert.deepEqual(result.affinityDiscoveryRuns, []);
    assert.deepEqual(result.dependencyDiscoveryRuns, []);
    assert.equal(result.branchCount, 1);
    assert.equal(result.maxParallel, 1);
    await assert.rejects(
        runAuthoritativeProductionDiscovery(null),
        /runner must be a function/u
    );
});

test('backend production discovery splits inherited STEP and bundle grants across live branch slots', () =>
{
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
    }));
    assert.deepEqual(environments.map((env) => Number(env.FSUSBLOG_STEP_CPU_BUDGET)), [2, 2, 1]);
    assert.deepEqual(environments.map((env) => Number(env.FSUSBLOG_STEP_MEMORY_GIB)), [4, 4, 4]);
    assert.equal(environments.reduce((sum, env) => sum + Number(env.FSUSBLOG_BUNDLE_CPU_BUDGET), 0), 5);
    assert.equal(environments.reduce((sum, env) => sum + Number(env.FSUSBLOG_BUNDLE_MEMORY_GIB), 0), 12);
    for (const env of environments)
    {
        assert.equal(env.DOTNET_PROCESSOR_COUNT, '1');
        assert.equal(env.FSUSBLOG_BACKEND_CPU_BUDGET, env.FSUSBLOG_STEP_CPU_BUDGET);
        assert.equal(env.FSUSBLOG_BUNDLE_CPU_UNITS, env.FSUSBLOG_STEP_CPU_BUDGET);
        assert.equal(env.KEEP, 'yes');
    }
});

test('backend authoritative VSTest discovery aligns exactly with the console union', () =>
{
    const records = [
        { displayName: 'Example.Tests.One.Case', traits: {} },
        { displayName: 'Example.Tests.Two.Theory(value: 1)', traits: {} }
    ];
    assert.equal(alignAuthoritativeDiscovery([
        'Example.Tests.Two.Theory(value: 1)',
        'Example.Tests.One.Case'
    ], records), records);
    assert.throws(
        () => alignAuthoritativeDiscovery(['Example.Tests.One.Case'], records),
        /does not exactly match/u
    );
    assert.deepEqual(projectProductionUnionRecords([
        ...records,
        { displayName: 'Example.Tests.Integration.Case', traits: { Category: ['Integration', 'Concurrency'] } },
        { displayName: 'Example.Tests.Redis.Case', traits: { Fixture: ['LocalRedis'] } }
    ]), records);
});

test('one backend platform authority excludes Unix on Windows and plans it on Linux and macOS', () =>
{
    const windows = projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], 'win32', {
        baseFilter: 'Category!=Integration',
        lane: 'backend-unit'
    });
    assert.equal(windows.executionFilter, '(Category!=Integration)&Platform!=Unix');
    assert.equal(windows.plannedTestCaseCount, 1);
    assert.equal(windows.notSelectedTestCaseCount, 1);
    assert.deepEqual(windows.platformTests, [{
        testId: 'unix-id',
        fullyQualifiedName: unixPlatformTest.fullyQualifiedName,
        displayName: unixPlatformTest.displayName,
        source: unixPlatformTest.source,
        assembly: 'FsusBlog.Server.Tests.dll',
        platform: 'Unix',
        result: 'not-selected',
        reason: 'Platform=Unix is outside the Windows backend plan'
    }]);

    for (const platform of ['linux', 'darwin'])
    {
        const plan = projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], platform, {
            baseFilter: 'Category!=Integration',
            lane: 'backend-unit'
        });
        assert.equal(plan.executionFilter, 'Category!=Integration');
        assert.equal(plan.plannedTestCaseCount, 2);
        assert.equal(plan.notSelectedTestCaseCount, 0);
        assert.equal(plan.platformTests[0].result, 'planned');
    }
});

test('local, CI and Production filters use the same platform projection', () =>
{
    const base = 'Category!=Integration&Category!=Performance';
    for (const platform of ['win32', 'linux', 'darwin'])
    {
        const expected = composeBackendPlatformFilter(base, platform);
        for (const lane of ['backend-unit', 'ci-fast-backend', 'backend-production'])
        {
            assert.equal(projectBackendPlatformPlan(
                [unixPlatformTest, portablePlatformTest],
                platform,
                { baseFilter: base, lane }
            ).executionFilter, expected);
        }
    }
});

test('Windows production plan preserves the canonical LocalRedis exclusion', () =>
{
    const records = [
        unixPlatformTest,
        portablePlatformTest,
        {
            ...portablePlatformTest,
            id: 'integration-id',
            traits: { Category: ['Integration'] }
        },
        {
            ...portablePlatformTest,
            id: 'redis-id',
            traits: { Fixture: ['LocalRedis'] }
        }
    ];
    const plan = projectProductionPlatformPlan(records, 'win32');
    assert.equal(plan.lane, 'backend-production');
    assert.equal(plan.executionFilter,
        '(Category!=Integration&Category!=Performance&Fixture!=LocalRedis)&Platform!=Unix');
    assert.equal(plan.discoveredTestCaseCount, 2);
    assert.equal(plan.plannedTestCaseCount, 1);
    assert.equal(plan.notSelectedTestCaseCount, 1);
    assert.deepEqual(projectProductionUnionRecords(records, 'win32'), [portablePlatformTest]);
    assert.equal(plan.localRedisTests.length, 4);
    assert.ok(plan.localRedisTests.every((record) => record.result === 'not-selected'));
    assert.equal(plan.platformTests[0].result, 'not-selected');

    const outcome = reconcileBackendPlatformOutcome(plan, []);
    assert.equal(outcome.platformTests[0].result, 'not-selected');
    for (const record of plan.localRedisTests)
    {
        assert.throws(() => reconcileBackendPlatformOutcome(plan, [{
            testId: 'excluded-redis-result',
            testName: record.fullyQualifiedName,
            outcome: 'Passed'
        }]), /executed a not-selected LocalRedis test/u);
    }
    assert.throws(() => reconcileBackendPlatformOutcome(plan, [{
        testId: unixPlatformTest.id,
        testName: unixPlatformTest.displayName,
        outcome: 'Passed'
    }]), /executed not-selected Unix test/u);
});

test('platform metadata is closed-world and cannot disappear or be ignored by the runner', () =>
{
    assert.throws(
        () => projectBackendPlatformPlan([{
            ...unixPlatformTest,
            traits: { Platform: ['Windows'] }
        }], 'win32'),
        /unsupported Platform trait/u
    );
    assert.throws(
        () => projectBackendPlatformPlan([{
            ...unixPlatformTest,
            traits: { Platform: ['Unix', 'Unix'] }
        }], 'linux'),
        /multiple Platform traits/u
    );
    assert.throws(
        () => projectBackendPlatformPlan([{
            ...unixPlatformTest,
            traits: { Platform: ['Unix'], PlatformEvidence: ['Unknown'] }
        }], 'linux'),
        /unsupported PlatformEvidence trait/u
    );
    assert.throws(
        () => projectBackendPlatformPlan([{
            ...portablePlatformTest,
            traits: { PlatformEvidence: ['UnixMode'] }
        }], 'linux'),
        /PlatformEvidence without Platform=Unix/u
    );
    const unixPlan = projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], 'linux');
    assert.throws(
        () => reconcileBackendPlatformOutcome(unixPlan, [{
            testId: portablePlatformTest.id,
            testName: portablePlatformTest.displayName,
            outcome: 'Passed'
        }]),
        /did not execute planned test/u
    );
    const windowsPlan = projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], 'win32');
    assert.throws(
        () => reconcileBackendPlatformOutcome(windowsPlan, [{
            testId: unixPlatformTest.id,
            testName: unixPlatformTest.displayName,
            outcome: 'Passed'
        }]),
        /executed not-selected Unix test/u
    );
});

test('semantic outcome records Unix execution and keeps Windows as not-selected without assertion claims', () =>
{
    const linux = projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], 'linux');
    const outcome = reconcileBackendPlatformOutcome(linux, [{
        testId: unixPlatformTest.id,
        testName: unixPlatformTest.displayName,
        outcome: 'Passed'
    }, {
        testId: 'theory-id',
        testName: 'Example.Tests.Theory(value: 1)',
        outcome: 'Passed'
    }, {
        testId: 'theory-id',
        testName: 'Example.Tests.Theory(value: 2)',
        outcome: 'Passed'
    }]);
    assert.equal(outcome.platformTests[0].result, 'passed');
    assert.equal(outcome.platformTests[0].executionEvidenceCount, 1);

    const windows = reconcileBackendPlatformOutcome(
        projectBackendPlatformPlan([unixPlatformTest, portablePlatformTest], 'win32'),
        [{
            testId: portablePlatformTest.id,
            testName: portablePlatformTest.displayName,
            outcome: 'Passed'
        }]
    );
    assert.equal(windows.platformTests[0].result, 'not-selected');
    assert.equal(Object.hasOwn(windows.platformTests[0], 'executionEvidenceCount'), false);
    assert.equal(Object.hasOwn(windows.platformTests[0], 'assertionCount'), false);
    assert.throws(
        () => reconcileBackendPlatformOutcome(linux, [{
            testId: unixPlatformTest.id,
            testName: unixPlatformTest.displayName,
            outcome: 'Passed'
        }, {
            testId: unixPlatformTest.id,
            testName: unixPlatformTest.displayName,
            outcome: 'Passed'
        }]),
        /platform test more than once/u
    );
});

test('Unix mode evidence binds actual permissions and owner usability to ordinary and Production outcomes', () =>
{
    const plan = projectBackendPlatformPlan([unixModePlatformTest], 'linux', {
        baseFilter: 'Category!=Integration',
        lane: 'backend-unit'
    });
    assert.equal(plan.platformTests[0].evidenceContract, 'unix-mode');

    const ordinaryRecords = parseBackendPlatformTrx(unixModeTrx());
    const ordinary = reconcileBackendPlatformOutcome(plan, ordinaryRecords);
    assert.deepEqual(ordinary.platformTests[0].evidence, unixModeRuntimeEvidence);

    const productionRecords = parseTrxRecords(unixModeTrx());
    const production = reconcileBackendPlatformOutcome(
        projectProductionPlatformPlan([
            unixModePlatformTest,
            {
                ...portablePlatformTest,
                traits: { Category: ['Integration'] }
            }
        ], 'linux'),
        productionRecords
    );
    assert.deepEqual(production.platformTests[0].evidence, unixModeRuntimeEvidence);

    const windows = projectBackendPlatformPlan([unixModePlatformTest], 'win32');
    assert.equal(windows.platformTests[0].result, 'not-selected');
    assert.equal(windows.platformTests[0].evidenceContract, 'unix-mode');
    assert.equal(Object.hasOwn(windows.platformTests[0], 'evidence'), false);
});

test('Unix mode evidence fails closed for missing receipts, open bits, unusable owners, and duplicates', () =>
{
    const plan = projectBackendPlatformPlan([unixModePlatformTest], 'linux');
    assert.throws(
        () => reconcileBackendPlatformOutcome(plan, [{
            testId: unixModePlatformTest.id,
            testName: unixModePlatformTest.displayName,
            outcome: 'Passed'
        }]),
        /passed without required runtime evidence/u
    );
    for (const invalid of [
        {
            ...unixModeRuntimeEvidence,
            effectiveModeOctal: '0770'
        },
        {
            ...unixModeRuntimeEvidence,
            ownerArtifact: {
                ...unixModeRuntimeEvidence.ownerArtifact,
                read: false
            }
        },
        {
            ...unixModeRuntimeEvidence,
            existingRoot: {
                ...unixModeRuntimeEvidence.existingRoot,
                converged: false
            }
        }
    ])
    {
        assert.throws(
            () => reconcileBackendPlatformOutcome(plan, parseBackendPlatformTrx(unixModeTrx(invalid))),
            /backend Unix mode evidence/u
        );
    }
    assert.throws(
        () => parseBackendPlatformTrx(
            unixModeTrx().replace(
                '</StdOut>',
                `\nbackend-platform-runtime-evidence ${JSON.stringify(unixModeRuntimeEvidence)}</StdOut>`
            )
        ),
        /multiple runtime evidence receipts/u
    );

    const failed = reconcileBackendPlatformOutcome(plan, [{
        testId: unixModePlatformTest.id,
        testName: unixModePlatformTest.displayName,
        outcome: 'Failed'
    }]);
    assert.equal(failed.platformTests[0].result, 'failed');
    assert.equal(Object.hasOwn(failed.platformTests[0], 'evidence'), false);
});

test('Unix request-path evidence preserves six case identities across ordinary, Production, and Windows', () =>
{
    const plan = projectBackendPlatformPlan(unixRequestPathPlatformTests, 'linux', {
        baseFilter: 'Category!=Integration',
        lane: 'backend-unit'
    });
    assert.equal(plan.plannedTestCaseCount, 6);
    assert.deepEqual(
        plan.platformTests.map((record) => record.operation),
        unixRequestPathOperations
    );
    assert.equal(new Set(plan.platformTests.map((record) => record.testId)).size, 6);
    assert.ok(plan.platformTests.every((record) => record.evidenceContract === 'unix-request-path'));

    const ordinary = reconcileBackendPlatformOutcome(
        plan,
        parseBackendPlatformTrx(unixRequestPathTrx())
    );
    assert.deepEqual(
        ordinary.platformTests.map((record) => record.evidence.operation),
        unixRequestPathOperations
    );
    assert.ok(ordinary.platformTests.every((record) => record.executionEvidenceCount === 1));

    const production = reconcileBackendPlatformOutcome(
        projectProductionPlatformPlan([
            ...unixRequestPathPlatformTests,
            {
                ...portablePlatformTest,
                id: 'unix-request-path-integration',
                displayName: 'Example.Tests.Files.ExcludedIntegration',
                traits: { Category: ['Integration'] }
            }
        ], 'linux'),
        parseTrxRecords(unixRequestPathTrx())
    );
    assert.deepEqual(
        production.platformTests.map((record) => record.evidence.operation),
        unixRequestPathOperations
    );

    const windows = projectBackendPlatformPlan(unixRequestPathPlatformTests, 'win32');
    assert.equal(windows.notSelectedTestCaseCount, 6);
    assert.ok(windows.platformTests.every((record) =>
        record.result === 'not-selected' &&
        record.evidenceContract === 'unix-request-path' &&
        !Object.hasOwn(record, 'evidence')
    ));
});

test('Unix request-path evidence rejects incomplete case sets and invalid per-case receipts', () =>
{
    assert.throws(
        () => projectBackendPlatformPlan(unixRequestPathPlatformTests.slice(0, -1), 'linux'),
        /requires exact operations/u
    );
    assert.throws(
        () => projectBackendPlatformPlan([
            ...unixRequestPathPlatformTests,
            {
                ...unixRequestPathPlatformTests[0],
                id: 'duplicate-complete'
            }
        ], 'linux'),
        /requires exact operations/u
    );
    assert.throws(
        () => projectBackendPlatformPlan([
            ...unixRequestPathPlatformTests.slice(0, -1),
            {
                ...unixRequestPathPlatformTests.at(-1),
                displayName:
                    'Example.Tests.Files.UploadRequestPaths_DoNotEnumerateExpirationIndexRoot(operation: "unknown")'
            }
        ], 'linux'),
        /unknown operation/u
    );

    const plan = projectBackendPlatformPlan(unixRequestPathPlatformTests, 'linux');
    assert.throws(
        () => reconcileBackendPlatformOutcome(
            plan,
            parseBackendPlatformTrx(unixRequestPathTrx(unixRequestPathPlatformTests.slice(0, -1)))
        ),
        /did not execute planned test/u
    );
    const mismatchedDisplay = parseBackendPlatformTrx(unixRequestPathTrx());
    mismatchedDisplay[0].testName = unixRequestPathPlatformTests[1].displayName;
    assert.throws(
        () => reconcileBackendPlatformOutcome(plan, mismatchedDisplay),
        /display identity is invalid/u
    );
    for (const invalid of [
        (evidence) => ({ ...evidence, enumerationDenied: false }),
        (evidence) => ({ ...evidence, operation: 'abort' }),
        (evidence) => ({ ...evidence, sessionPresent: false }),
        (evidence) => ({
            ...evidence,
            completeContract: {
                ...evidence.completeContract,
                retryAccepted: false
            }
        })
    ])
    {
        assert.throws(
            () => reconcileBackendPlatformOutcome(
                plan,
                parseBackendPlatformTrx(unixRequestPathTrx(
                    unixRequestPathPlatformTests,
                    (operation) =>
                    {
                        const evidence = unixRequestPathEvidence(operation);
                        return operation === 'complete' ? invalid(evidence) : evidence;
                    }
                ))
            ),
            /backend Unix request-path evidence/u
        );
    }
    assert.throws(
        () => reconcileBackendPlatformOutcome(plan, [{
            testId: unixRequestPathPlatformTests[0].id,
            testName: unixRequestPathPlatformTests[0].displayName,
            outcome: 'Passed'
        }]),
        /passed without required runtime evidence/u
    );
});
