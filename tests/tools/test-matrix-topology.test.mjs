import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    behaviorTest,
    concurrencyHarnessId,
    runRealConcurrencyHarness
} from '../../tools/contracts/behavior-test.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const { parseMatrix } = await import(pathToFileURL(path.join(root, 'tools/test-matrix/parse-matrix.mjs')).href);
const {
    defaultTierTopology,
    resolveTierTopology,
    topologyEnvironmentForTier,
    validateTierTopology
} = await import(pathToFileURL(path.join(root, 'tools/test-matrix/topology.mjs')).href);

function tier(overrides = {})
{
    return {
        id: 'cluster-fixture',
        services: ['postgres', 'redis', 'backend'],
        requiresBootstrap: 'full',
        selfBootstraps: true,
        ...overrides
    };
}

behaviorTest('browserless-production-correctness', 'positive', 'topology schema exposes optional single-mode defaults', () =>
{
    const schema = JSON.parse(fs.readFileSync(path.join(root, 'tests/matrix.schema.json'), 'utf8'));
    const properties = schema.properties.tiers.items.properties;

    assert.equal(properties.runtimeMode.default, 'single');
    assert.deepEqual(properties.runtimeMode.enum, ['single', 'static-role', 'adaptive']);
    assert.equal(properties.nodeCount.default, 1);
    assert.equal(properties.nodeCount.minimum, 1);
    assert.equal(properties.nodeCount.maximum, 3);
    assert.equal(properties.artifactStorage.default, 'local');
    assert.equal(properties.coordinationStore.default, 'none');
    assert.equal(properties.clusterScenario.default, 'none');
    assert.equal(properties.clusterBootstrap.default, 'none');
    assert.deepEqual(properties.clusterFixtures.default, []);
});

test('tiers without topology metadata preserve the single-node behavior', () =>
{
    assert.deepEqual(resolveTierTopology({ id: 'ordinary' }), defaultTierTopology);

    const matrix = parseMatrix(fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8'));
    const implicitSingleTier = matrix.tiers.find((current) => !Object.hasOwn(current, 'runtimeMode'));
    assert.ok(implicitSingleTier);
    assert.deepEqual(resolveTierTopology(implicitSingleTier), defaultTierTopology);
    assert.deepEqual(validateTierTopology(implicitSingleTier), []);
});

test('homogeneous multi-node topology closes shared service, storage, and bootstrap declarations', () =>
{
    const valid = tier({
        runtimeMode: 'adaptive',
        nodeCount: 2,
        artifactStorage: 'shared-volume',
        coordinationStore: 'redis',
        clusterScenario: 'convergence',
        clusterBootstrap: 'homogeneous',
        clusterFixtures: ['shared-postgres', 'shared-redis', 'shared-artifact-storage']
    });
    assert.deepEqual(validateTierTopology(valid), []);
    assert.deepEqual(topologyEnvironmentForTier(valid), {
        FSUSBLOG_TEST_RUNTIME_MODE: 'adaptive',
        FSUSBLOG_TEST_NODE_COUNT: '2',
        FSUSBLOG_TEST_ARTIFACT_STORAGE: 'shared-volume',
        FSUSBLOG_TEST_COORDINATION_STORE: 'redis',
        FSUSBLOG_TEST_CLUSTER_SCENARIO: 'convergence',
        FSUSBLOG_TEST_CLUSTER_BOOTSTRAP: 'homogeneous',
        FSUSBLOG_TEST_CLUSTER_FIXTURES: 'shared-postgres,shared-redis,shared-artifact-storage'
    });

    const invalid = tier({
        runtimeMode: 'single',
        nodeCount: 2,
        clusterScenario: 'notification',
        clusterFixtures: []
    });
    const errors = validateTierTopology(invalid).join('\n');
    assert.match(errors, /runtimeMode=single requires nodeCount=1/u);
    assert.match(errors, /clusterBootstrap=homogeneous/u);
    assert.match(errors, /artifactStorage=shared-volume/u);
    assert.match(errors, /coordinationStore=redis/u);
    assert.match(errors, /shared-postgres/u);
    assert.match(errors, /shared-redis/u);
    assert.match(errors, /shared-artifact-storage/u);
});

behaviorTest('browserless-production-correctness', 'negative', {
    title: 'shared stores fail closed when fixture and service declarations drift',
    invariantIds: ['matrix-topology-shared-store-consistency']
}, () =>
{
    const errors = validateTierTopology(tier({
        services: ['backend'],
        coordinationStore: 'redis',
        artifactStorage: 'shared-volume',
        clusterFixtures: ['shared-postgres']
    })).join('\n');

    assert.match(errors, /coordinationStore=redis requires services to include redis/u);
    assert.match(errors, /coordinationStore=redis requires clusterFixtures to include shared-redis/u);
    assert.match(errors, /shared-postgres requires services to include postgres/u);
    assert.match(errors, /shared-volume requires clusterFixtures to include shared-artifact-storage/u);
    assert.deepEqual(validateTierTopology(tier({ clusterFixtures: 42 })), ['cluster-fixture.clusterFixtures must be an array']);
});

behaviorTest('browserless-production-correctness', 'concurrency', {
    title: 'topology validation remains deterministic under real concurrent harness workers',
    concurrencyHarness: concurrencyHarnessId
}, async () =>
{
    const candidate = tier({
        runtimeMode: 'adaptive',
        nodeCount: 2,
        artifactStorage: 'shared-volume',
        coordinationStore: 'redis',
        clusterScenario: 'convergence',
        clusterBootstrap: 'homogeneous',
        clusterFixtures: ['shared-postgres', 'shared-redis', 'shared-artifact-storage']
    });
    const results = await runRealConcurrencyHarness([
        async () => validateTierTopology(candidate),
        async () => validateTierTopology(candidate),
        async () => validateTierTopology({
            ...candidate,
            runtimeMode: 'single',
            nodeCount: 2,
            clusterFixtures: []
        })
    ]);
    assert.deepEqual(results[0], []);
    assert.deepEqual(results[1], []);
    assert.ok(results[2].length > 0);
});

test('matrix validate command rejects incomplete multi-node metadata', () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-matrix-topology-'));
    try
    {
        const source = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
        const invalid = source.replace(
            '      runtimeMode: single\n      nodeCount: 1\n      artifactStorage: local\n      coordinationStore: none\n      clusterScenario: none\n      clusterBootstrap: none\n      clusterFixtures: []',
            '      runtimeMode: single\n      nodeCount: 2\n      artifactStorage: local\n      coordinationStore: none\n      clusterScenario: notification\n      clusterBootstrap: none\n      clusterFixtures: []'
        );
        assert.notEqual(invalid, source);
        const matrixFile = path.join(temp, 'matrix.yml');
        fs.writeFileSync(matrixFile, invalid);

        const result = spawnSync(process.execPath, [path.join(root, 'tools/run-test-matrix.mjs'), 'validate'], {
            cwd: root,
            env: { ...process.env, FSUSBLOG_MATRIX_FILE: matrixFile },
            encoding: 'utf8'
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /bootstrap\.runtimeMode=single requires nodeCount=1/u);
        assert.match(result.stderr, /bootstrap multi-node topology requires clusterBootstrap=homogeneous/u);
        assert.match(result.stderr, /bootstrap multi-node topology requires artifactStorage=shared-volume/u);
        assert.match(result.stderr, /bootstrap multi-node topology requires coordinationStore=redis/u);
        assert.match(result.stderr, /bootstrap multi-node topology requires clusterFixtures to include shared-postgres/u);
    }
    finally
    {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
