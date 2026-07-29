import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { cleanupSensitiveFixtures, writeSchedulerProducerReceipts } = await import(new URL("../../tools/run-test-matrix.mjs", import.meta.url));
const { assertProductionFreshBundleProducerWiring, assertProductionFreshProducerConfiguration, assertProductionFreshSchedulerProducerWiring, captureProductionFreshOutputInventory, createProductionFreshOutputRoot, productionFreshGovernanceOutputs, productionFreshProducerInventory, productionFreshOutputEnvironment, resolveProductionFreshSchedulerProducerIds, verifyProductionFreshReceiptInventory } = await import(new URL("../../tools/test-matrix/production-fresh-run-bound-outputs.mjs", import.meta.url));

const releaseCollectorSource = fs.readFileSync(
    new URL('../../tools/operations/collect-release-evidence.sh', import.meta.url),
    'utf8');

test('release collector consumes configured Fresh producer roots without ambient fallback reads', () =>
{
    for (const configuredRoot of [
        'FSUSBLOG_COVERAGE_EVIDENCE_DIR',
        'FSUSBLOG_SECURITY_OUTPUT_ROOT',
        'FSUSBLOG_PERF_EVIDENCE_DIR',
        'FSUSBLOG_FRONTEND_OUTPUT_ROOT',
        'FSUSBLOG_UX_OUTPUT_ROOT',
        'FSUSBLOG_OPERATIONS_EVIDENCE_SOURCE_DIR',
        'FSUSBLOG_GATE_LOG_SOURCE_DIR',
        'FSUSBLOG_FAULT_EVIDENCE_DIR',
        'FSUSBLOG_SOAK_EVIDENCE_DIR',
        'FSUSBLOG_FUZZ_EVIDENCE_DIR'
    ])
    {
        assert.match(releaseCollectorSource, new RegExp(configuredRoot));
    }
    assert.match(
        releaseCollectorSource,
        /FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT[^]*return[^]*restore-downloaded-artifacts\.sh/);
    for (const fixedRead of [
        '$ROOT_DIR/.tmp/perf/release-summaries/performance-saturation-v2.json',
        '$ROOT_DIR/.tmp/ux" ux',
        '$ROOT_DIR/.tmp/frontend/dom-budget.json',
        '$ROOT_DIR/.tmp/frontend/route-render-pressure.json'
    ])
    {
        assert.equal(releaseCollectorSource.includes(fixedRead), false, fixedRead);
    }
});

test('Fresh sensitive fixture cleanup writes evidence and deletes auth only inside the attempt root', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-cleanup-'));
    try
    {
        const layout = createProductionFreshOutputRoot({ root, runId: 'fresh-run' });
        const environment = productionFreshOutputEnvironment(layout, 'production');
        const fixtureRoot = path.join(environment.FSUSBLOG_ACCEPTANCE_FIXTURE_ROOT, 'fresh-run');
        const globalFixtureRoot = path.join(root, '.tmp', 'fixtures', 'fresh-run', 'auth');
        fs.mkdirSync(path.join(fixtureRoot, 'auth'), { recursive: true });
        fs.writeFileSync(path.join(fixtureRoot, 'auth', 'state.json'), '{}');
        fs.mkdirSync(globalFixtureRoot, { recursive: true });
        fs.writeFileSync(path.join(globalFixtureRoot, 'unowned.json'), '{}');

        cleanupSensitiveFixtures('fresh-run', environment);

        assert.equal(fs.existsSync(path.join(fixtureRoot, 'auth')), false);
        assert.equal(fs.existsSync(globalFixtureRoot), true);
        const receiptFile = path.join(
            environment.FSUSBLOG_RELEASE_EVIDENCE_DIR,
            'sensitive-fixture-cleanup.json');
        assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).status, 'ok');
        assert.equal(fs.existsSync(path.join(root, '.tmp', 'release-evidence')), false);
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Fresh producer output environment rejects fixed global correctness defaults', () =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-output-governance-'));
    try
    {
        const layout = createProductionFreshOutputRoot({ root, runId: 'fresh-run' });
        const env = productionFreshOutputEnvironment(layout, 'local-production-backend-tests');
        for (const [name, value] of Object.entries(env))
        {
            if (name === 'FSUSBLOG_PRODUCTION_FRESH_ATTEMPT_ID')
            {
                continue;
            }
            if (name === 'FSUSBLOG_DATA_ROOT')
            {
                assert.equal(value.startsWith(`${layout.outputRoot}${path.sep}`), false);
                assert.match(
                    value,
                    /test-runs[\\/]fresh-run[\\/]runtime-data[\\/]attempt-0001[\\/]local-production-backend-tests$/
                );
                continue;
            }
            assert.ok(value.startsWith(`${layout.outputRoot}${path.sep}`) || value === layout.outputRoot);
            assert.equal(value.includes(`${path.sep}.tmp${path.sep}coverage`), false);
            assert.equal(value.includes(`${path.sep}.tmp${path.sep}test-results`), false);
            assert.equal(value.includes(`${path.sep}.tmp${path.sep}release-evidence`), false);
        }
        assert.match(env.FSUSBLOG_BACKEND_TRX_DIR, /outputs[\\/]attempts[\\/]attempt-0001[\\/]reports[\\/]trx[\\/]backend$/);
        assert.match(env.FSUSBLOG_PERCEPTION_RUNTIME_EVIDENCE_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]runtime[\\/]perception-v2-e2e-runtime\.json$/);
        assert.match(env.FSUSBLOG_PERCEPTION_MATRIX_SUMMARY_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]artifacts[\\/]perception-v2-test-matrix\.json$/);
        assert.match(env.FSUSBLOG_PERCEPTION_RELEASE_EVIDENCE_FILE, /outputs[\\/]attempts[\\/]attempt-0001[\\/]release-evidence[\\/]perception-v2-release-evidence\.json$/);
        assert.deepEqual(Object.keys(productionFreshProducerInventory.bundles).sort(), [
            'backend-tests',
            'build-static',
            'frontend-tests',
            'performance-evidence',
            'runtime-browser'
        ]);
        assert.ok(Object.values(productionFreshProducerInventory.bundles)
            .every((producers) => producers.length > 0));
        assert.equal(assertProductionFreshProducerConfiguration(layout, env), true);
        const sibling = productionFreshOutputEnvironment(layout, 'local-production-frontend-tests');
        assert.notEqual(env.FSUSBLOG_DATA_ROOT, sibling.FSUSBLOG_DATA_ROOT);
        for (const [name, fixed] of [
            ['FSUSBLOG_TEST_RESULTS_ROOT', path.join(root, '.tmp/test-results')],
            ['FSUSBLOG_COVERAGE_ROOT', path.join(root, '.tmp/coverage')],
            ['FSUSBLOG_BACKEND_TRX_DIR', path.join(root, '.tmp/test-results/backend')],
            ['PLAYWRIGHT_OUTPUT_DIR', path.join(root, 'src/frontend/test-results/playwright')],
            ['FSUSBLOG_BENCHMARK_ARTIFACT_ROOT', path.join(root, 'BenchmarkDotNet.Artifacts')],
            ['FSUSBLOG_RELEASE_EVIDENCE_DIR', path.join(root, '.tmp/release-evidence')],
            ['FSUSBLOG_DATA_ROOT', path.join(root, '.tmp/data')]
        ])
        {
            assert.throws(
                () => assertProductionFreshProducerConfiguration(layout, { ...env, [name]: fixed }),
                new RegExp(name));
        }
    }
    finally
    {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime producer wiring rejects missing and unexpected physical or scheduler producers', () =>
{
    for (const [bundleId, producerIds] of Object.entries(productionFreshProducerInventory.bundles))
    {
        assert.equal(assertProductionFreshBundleProducerWiring(bundleId, producerIds), true);
        assert.throws(
            () => assertProductionFreshBundleProducerWiring(bundleId, producerIds.slice(1)),
            /wiring mismatch.*missing=/);
        assert.throws(
            () => assertProductionFreshBundleProducerWiring(bundleId, [...producerIds, 'global-output-adapter']),
            /unexpected=global-output-adapter/);
        assert.equal(
            assertProductionFreshBundleProducerWiring(bundleId, producerIds.slice(0, 1), {
                status: 'partial'
            }),
            true);
        assert.throws(
            () => assertProductionFreshBundleProducerWiring(
                bundleId,
                [...producerIds.slice(0, 1), 'global-output-adapter'],
                { status: 'partial' }
            ),
            /unexpected=global-output-adapter/);
    }
    const schedulerDeclarations = Object.fromEntries(
        productionFreshProducerInventory.schedulerProducers.map((producerId) => [producerId, [`runtime/${producerId}.json`]]));
    assert.equal(assertProductionFreshSchedulerProducerWiring(schedulerDeclarations), true);
    assert.equal(assertProductionFreshSchedulerProducerWiring({
        ...schedulerDeclarations,
        'logical-tier-projection': []
    }, { status: 'failure' }), true);
    assert.throws(
        () => assertProductionFreshSchedulerProducerWiring({
            ...schedulerDeclarations,
            'logical-tier-projection': []
        }),
        /missing=logical-tier-projection/);
    assert.throws(
        () => assertProductionFreshSchedulerProducerWiring({
            ...schedulerDeclarations,
            'forbidden-output-observation': []
        }),
        /missing=forbidden-output-observation/);
    assert.throws(
        () => assertProductionFreshSchedulerProducerWiring({
            ...schedulerDeclarations,
            'global-file-lock': ['runtime/global-file-lock.json']
        }),
        /unexpected=global-file-lock/);
    assert.equal(assertProductionFreshSchedulerProducerWiring({
        ...schedulerDeclarations,
        'managed-production-build-gc': [],
        'logical-tier-projection': []
    }, {
        status: 'failure',
        producerLifecycles: {
            'managed-production-build-gc': {
                status: 'failure',
                producerSpawnCount: 0
            }
        }
    }), true);
    assert.throws(() => assertProductionFreshSchedulerProducerWiring({
        ...schedulerDeclarations,
        'managed-production-build-gc': []
    }), /missing=managed-production-build-gc/);
    assert.ok(resolveProductionFreshSchedulerProducerIds({
        ...schedulerDeclarations,
        'logical-tier-projection': []
    }, {
        status: 'failure',
        producerLifecycles: {
            'managed-production-build-gc': {
                status: 'failure',
                producerSpawnCount: 0
            }
        }
    }).includes('managed-production-build-gc'));
    for (const lifecycle of [
        { status: 'success' },
        { status: 'failure' },
        null
    ])
    {
        assert.throws(() => assertProductionFreshSchedulerProducerWiring({
            ...schedulerDeclarations,
            'managed-production-build-gc': [],
            'logical-tier-projection': []
        }, {
            status: 'failure',
            producerLifecycles: {
                'managed-production-build-gc': lifecycle
            }
        }), /missing=managed-production-build-gc/);
    }
});

test('failed-before-spawn scheduler sealing preserves the primary failure without a GC output', (t) =>
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-scheduler-sealing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const layout = createProductionFreshOutputRoot({ root, runId: 'fresh-run' });
    const before = captureProductionFreshOutputInventory(layout);
    const outputs = [
        'release-evidence/production-resource-utilization.json',
        'release-evidence/production-build-layout.json',
        'runtime/forbidden-output-observation.json',
        'runtime/runtime-cleanup.json',
        'release-evidence/sensitive-fixture-cleanup.json',
        'summary/run.json'
    ];
    for (const relative of outputs)
    {
        const file = path.join(layout.outputRoot, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{}\n');
    }
    for (const [relative, contents] of [
        ['runtime/acceptance-env/fresh-run.env', 'FSUSBLOG_TEST_RUN_ID=fresh-run\n'],
        [
            'runtime/acceptance-fixtures/fresh-run/planned-profile.json',
            '{"profile":"production"}\n'
        ]
    ])
    {
        const file = path.join(layout.outputRoot, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
    }
    const checkpoint = {
        status: 'failure',
        failure: {
            tierId: 'managed-production-build-gc',
            reason: 'fixture capacity live guard failed',
            producerSpawnCount: 0
        },
        failures: [{
            tierId: 'managed-production-build-gc',
            reason: 'fixture capacity live guard failed',
            producerSpawnCount: 0
        }],
        tiers: {
            'managed-production-build-gc': {
                status: 'failure',
                reason: 'fixture capacity live guard failed',
                producerSpawnCount: 0
            }
        }
    };
    const checkpointBefore = structuredClone(checkpoint);

    const declared = writeSchedulerProducerReceipts(layout, before, {
        runStatus: 'failure',
        checkpoint
    });

    assert.deepEqual(checkpoint, checkpointBefore);
    assert.deepEqual(declared.sort(), outputs.sort());
    assert.equal(fs.existsSync(path.join(
        layout.outputRoot,
        'artifacts/producer-receipts/scheduler/managed-production-build-gc.json'
    )), false);
    for (const producerId of [
        'production-resource-utilization',
        'production-build-layout',
        'forbidden-output-observation',
        'runtime-cleanup',
        'sensitive-fixture-cleanup',
        'run-summary'
    ])
    {
        assert.equal(fs.existsSync(path.join(
            layout.outputRoot,
            'artifacts/producer-receipts/scheduler',
            `${producerId}.json`
        )), true);
    }
    const receiptRoot = path.join(
        layout.outputRoot,
        'artifacts/producer-receipts/scheduler');
    const receipts = fs.readdirSync(receiptRoot)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => JSON.parse(fs.readFileSync(path.join(receiptRoot, name), 'utf8')));
    const aggregate = verifyProductionFreshReceiptInventory({
        layout,
        receipts,
        governanceOutputs: productionFreshGovernanceOutputs(layout)
    });
    assert.ok(aggregate.relativeOutputs.includes(
        'runtime/acceptance-fixtures/fresh-run/planned-profile.json'));
    assert.deepEqual(checkpoint, checkpointBefore);
});
