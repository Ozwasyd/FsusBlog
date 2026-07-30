import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { loadCatalog } = await import(
    pathToFileURL(path.join(root, 'tools/test/run-release-reliability-scenarios.mjs')).href
);

test('release reliability catalog contains exactly 7 scenarios matching expected IDs 1:1', () => {
    const catalog = loadCatalog();
    assert.equal(catalog.catalogScenarioCount, 7);
    assert.equal(catalog.scenarios.length, 7);

    const expectedIds = [
        'release-soak-min',
        'release-load-peak',
        'release-load-burst',
        'release-data-scale-m',
        'release-mutation-critical-slice',
        'release-memory-leak-budget',
        'release-open-handle-budget'
    ];
    const actualIds = catalog.scenarios.map((s) => s.id);
    assert.deepEqual(actualIds, expectedIds);
});

test('release reliability catalog declares structured executable commands and evidence contracts', () => {
    const catalog = loadCatalog();
    assert.equal(
        catalog.childEnvironmentContract.schema,
        'fsusblog.release-reliability-child-environment.v1'
    );
    assert.deepEqual(
        catalog.childEnvironmentContract.requiredBaseKeys,
        ['HOME', 'PATH', 'XDG_RUNTIME_DIR']
    );
    assert.deepEqual(catalog.policyBindings, {
        loadProfile: 'tests/performance/perf-policy.yml',
        mutationSubset: 'config/testing/mutation/release-parity-subset.json',
        releaseResource: 'config/deployment/zero-downtime-resource-policy.json'
    });
    for (const scenario of catalog.scenarios) {
        assert.equal(typeof scenario.command.executable, 'string');
        assert.ok(Array.isArray(scenario.command.args));
        assert.equal(typeof scenario.command.cwd, 'string');
        assert.equal(typeof scenario.authoritativeEvidence.path, 'string');
        assert.ok(Array.isArray(scenario.authoritativeEvidence.expectedSchema.required));
        assert.ok(
            scenario.authoritativeEvidence.expectedSchema.required.includes(
                'releaseReliability'
            )
        );
    }
    for (const scenarioId of [
        'release-soak-min',
        'release-load-peak',
        'release-load-burst',
        'release-data-scale-m',
        'release-memory-leak-budget',
        'release-open-handle-budget'
    ]) {
        const inherited = catalog.scenarios.find(
            (scenario) => scenario.id === scenarioId
        ).command.inheritEnv.required;
        assert.ok(
            inherited.includes('FSUSBLOG_POSTGRES_CONTAINER_NAME'),
            `${scenarioId} must inherit the run-owned PostgreSQL container`
        );
        assert.ok(
            inherited.includes('FSUSBLOG_REDIS_CONTAINER_NAME'),
            `${scenarioId} must inherit the run-owned Redis container`
        );
    }
    assert.equal(
        catalog.scenarios.find((scenario) => scenario.id === 'release-soak-min').authoritativeEvidence.path,
        '.tmp/soak/short/summary.json'
    );
    assert.deepEqual(
        catalog.scenarios.find((scenario) => scenario.id === 'release-soak-min').authoritativeEvidence.expectedSchema,
        {
            required: [
                'status', 'durationSeconds', 'sampling', 'sampleCount', 'latencyMs', 'errorRate',
                'executionMode', 'countsAsReleaseFinal', 'resourceMetricSummary',
                'releaseReliability'
            ],
            passStatusValues: ['ok']
        }
    );
    assert.deepEqual(
        catalog.scenarios.find((scenario) => scenario.id === 'release-mutation-critical-slice').authoritativeEvidence.expectedSchema,
        {
            schema: 'fsusblog.stryker-authority.v1',
            required: [
                'schema', 'status', 'tierId', 'sliceId', 'producer', 'inventory',
                'testIdentities',
                'plannedMutantIds', 'executedMutantIds', 'compileErrorMutantIds',
                'ignoredMutantIds', 'noCoverageMutantIds', 'killedMutantIds',
                'survivedMutantIds', 'timeoutMutantIds', 'executedTestIds',
                'inventoryDigest', 'executionMatrixDigest', 'rawReport', 'rawTrace',
                'traceExecution', 'releaseQualification', 'releaseReliability'
            ],
            passStatusValues: ['success']
        }
    );
});

test('release reliability catalog rejects every weakened canonical qualification value', () => {
    const weakeningCases = [
        ['release-soak-min', 'FSUSBLOG_SOAK_SHORT_SECONDS', '1'],
        ['release-load-peak', 'FSUSBLOG_LOAD_PROFILE_CONCURRENCY', '1'],
        ['release-load-peak', 'FSUSBLOG_LOAD_PROFILE_ROUNDS', '1'],
        ['release-load-peak', 'FSUSBLOG_LOAD_PROFILE_DURATION_MS', '1'],
        ['release-memory-leak-budget', 'FSUSBLOG_RELEASE_RESOURCE_REQUESTS', '1'],
        ['release-memory-leak-budget', 'FSUSBLOG_RELEASE_RESOURCE_CONCURRENCY', '1'],
        [
            'release-memory-leak-budget',
            'FSUSBLOG_RELEASE_RESOURCE_RSS_DELTA_THRESHOLD_BYTES',
            '999999999999'
        ],
        ['release-data-scale-m', 'FSUSBLOG_SCALE_TIER', 'scale-xs'],
        ['release-data-scale-m', 'FSUSBLOG_DATA_SCALE_REQUESTS', '1'],
        ['release-data-scale-m', 'FSUSBLOG_DATA_SCALE_CONCURRENCY', '1'],
        [
            'release-mutation-critical-slice',
            'FSUSBLOG_MUTATION_RELEASE_SUBSET_POLICY',
            'config/testing/mutation/forged.json'
        ]
    ];
    for (const [scenarioId, key, value] of weakeningCases) {
        const catalog = structuredClone(loadCatalog());
        catalog.scenarios.find((scenario) => scenario.id === scenarioId).command.env[key] = value;
        const temporaryRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'fsusblog-release-reliability-catalog-')
        );
        assert.throws(
            () => {
                const temporary = path.join(temporaryRoot, 'catalog.json');
                try {
                    fs.writeFileSync(temporary, JSON.stringify(catalog));
                    loadCatalog({ catalogFile: temporary });
                } finally {
                    fs.rmSync(temporaryRoot, { recursive: true, force: true });
                }
            },
            /canonical command environment\/qualification contract mismatch/u,
            `${scenarioId}:${key}`
        );
    }
});

test('release reliability lifecycle declarations describe only producer-owned actions', () => {
    const catalog = loadCatalog();
    const lifecycleByScenario = Object.fromEntries(catalog.scenarios.map((scenario) => [
        scenario.id,
        scenario.isolation.lifecycle
    ]));
    assert.deepEqual(lifecycleByScenario, {
        'release-soak-min': {
            precondition: 'verify-runtime-database-and-resource-counter-readiness',
            reset: 'delete-short-soak-scenario-output',
            measurement: 'producer-owned-short-soak-window',
            postcondition: 'verify-runtime-database-and-resource-counter-stability'
        },
        'release-load-peak': {
            precondition: 'verify-runtime-readiness-before-network-performance-window',
            reset: 'delete-expected-peak-raw-and-projection-output',
            measurement: 'producer-owned-expected-peak-window',
            postcondition: 'verify-runtime-stability-after-network-performance-window'
        },
        'release-load-burst': {
            precondition: 'verify-runtime-readiness-before-network-performance-window',
            reset: 'delete-burst-raw-and-projection-output',
            measurement: 'producer-owned-burst-window',
            postcondition: 'verify-runtime-stability-after-network-performance-window'
        },
        'release-data-scale-m': {
            precondition: 'verify-runtime-and-database-fixture-readiness',
            reset: 'delete-scale-m-output-and-clean-data-scale-namespace',
            measurement: 'producer-owned-scale-m-window',
            postcondition: 'verify-runtime-database-and-data-scale-cleanup-stability'
        },
        'release-mutation-critical-slice': {
            precondition: 'verify-clean-source-and-record-host-cpu-state',
            reset: 'delete-critical-mutation-scenario-output',
            measurement: 'producer-owned-critical-mutation-window',
            postcondition: 'verify-clean-source-and-record-host-cpu-state'
        },
        'release-memory-leak-budget': {
            precondition: 'verify-runtime-database-and-resource-counter-readiness',
            reset: 'delete-memory-leak-raw-and-projection-output',
            measurement: 'producer-owned-memory-leak-window',
            postcondition: 'verify-runtime-database-and-resource-counter-stability'
        },
        'release-open-handle-budget': {
            precondition: 'verify-runtime-database-and-resource-counter-readiness',
            reset: 'delete-open-handle-raw-and-projection-output',
            measurement: 'producer-owned-open-handle-window',
            postcondition: 'verify-runtime-database-and-resource-counter-stability'
        }
    });
});
