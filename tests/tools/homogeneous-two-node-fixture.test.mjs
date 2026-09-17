import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const {
    startHomogeneousTwoNodeFixture,
    validateHomogeneousTopology
} = await import(pathToFileURL(path.join(root, 'tools/test/homogeneous-two-node-fixture.mjs')).href);

function topologyEnvironment(overrides = {})
{
    return {
        FSUSBLOG_TEST_RUNTIME_MODE: 'static-role',
        FSUSBLOG_TEST_NODE_COUNT: '2',
        FSUSBLOG_TEST_ARTIFACT_STORAGE: 'shared-volume',
        FSUSBLOG_TEST_COORDINATION_STORE: 'redis',
        FSUSBLOG_TEST_CLUSTER_SCENARIO: 'convergence',
        FSUSBLOG_TEST_CLUSTER_BOOTSTRAP: 'homogeneous',
        FSUSBLOG_TEST_CLUSTER_FIXTURES: 'shared-postgres,shared-redis,shared-artifact-storage',
        ConnectionStrings__DefaultConnection: 'Host=127.0.0.1;Database=shared-cluster',
        ConnectionStrings__Redis: '127.0.0.1:6379',
        ...overrides
    };
}

test('homogeneous topology rejects single mode and missing shared fixtures', () =>
{
    const errors = validateHomogeneousTopology(topologyEnvironment({
        FSUSBLOG_TEST_RUNTIME_MODE: 'single',
        FSUSBLOG_TEST_NODE_COUNT: '1',
        FSUSBLOG_TEST_CLUSTER_FIXTURES: 'shared-postgres'
    })).join('\n');

    assert.match(errors, /static-role or adaptive/u);
    assert.match(errors, /exactly 2/u);
    assert.match(errors, /shared-redis/u);
    assert.match(errors, /shared-artifact-storage/u);
});

test('fixture rejects an artifact root that does not own the backend artifact', async () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-two-node-artifact-root-'));
    try
    {
        await assert.rejects(
            startHomogeneousTwoNodeFixture({
                environment: topologyEnvironment(),
                artifact: path.join(root, 'tests/tools/fixtures/homogeneous-two-node-fake-server.mjs'),
                artifactRoot: temp,
                frontendAssetSource: path.join(root, 'tests/matrix.yml'),
                outputRoot: path.join(temp, 'runtime')
            }),
            /backend artifact must belong to artifact root/u
        );
    }
    finally
    {
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('fixture launches two healthy nodes from one artifact and writes an isolated cluster summary', async () =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-two-node-fixture-'));
    const artifact = path.join(root, 'tests/tools/fixtures/homogeneous-two-node-fake-server.mjs');
    const frontendAssetSource = path.join(root, 'tests/matrix.yml');
    const outputRoot = path.join(temp, 'runtime');
    const summaryPath = path.join(temp, 'evidence', 'cluster-summary.json');
    let fixture;
    try
    {
        fixture = await startHomogeneousTwoNodeFixture({
            environment: topologyEnvironment(),
            artifact,
            artifactRoot: path.dirname(artifact),
            frontendAssetSource,
            outputRoot,
            summaryPath,
            cwd: root,
            command: process.execPath,
            commandArgs: [artifact],
            startupTimeoutMs: 10_000,
            nodeIdPrefix: 'fixture'
        });

        assert.equal(fixture.summary.schema, 'fsusblog.homogeneous-two-node-fixture.v1');
        assert.equal(fixture.summary.nodes.length, 2);
        assert.deepEqual(fixture.summary.nodes.map((node) => node.nodeId), ['fixture-a', 'fixture-b']);
        assert.equal(new Set(fixture.summary.nodes.map((node) => node.baseUrl)).size, 2);
        assert.equal(new Set(fixture.summary.nodes.map((node) => node.logPath)).size, 2);
        assert.ok(fixture.summary.nodes.every((node) => node.health.status === 'live'));
        assert.ok(fixture.summary.nodes.every((node) => node.health.nodeId === node.nodeId));
        assert.ok(fixture.summary.nodes.every((node) => node.health.runtimeMode === node.runtimeMode));
        assert.ok(fixture.summary.nodes.every((node) => node.appVersion === fixture.summary.build.appVersion));
        assert.ok(fixture.summary.nodes.every((node) => node.frontendAssetVersion === fixture.summary.frontendAssetVersion));
        assert.ok(fixture.summary.nodes.every((node) => node.runtimeMode === 'static-role'));
        assert.deepEqual(fixture.summary.invariants, {
            sameArtifact: true,
            sameAppVersion: true,
            sameFrontendAssetVersion: true,
            sameRuntimeMode: true,
            independentLogs: true,
            sharedPostgres: true,
            sharedRedis: true
        });
        assert.deepEqual(JSON.parse(fs.readFileSync(summaryPath, 'utf8')), fixture.summary);
        assert.ok(fixture.summary.nodes.every((node) => fs.existsSync(node.logPath)));
    }
    finally
    {
        await fixture?.stop();
        fs.rmSync(temp, { recursive: true, force: true });
    }
});
