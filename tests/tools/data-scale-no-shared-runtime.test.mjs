import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertDedicatedContainer,
    isForbiddenContainerName
} from '../../tools/data-scale/runtime-plan.mjs';

import { DataScaleRuntimeProvisioner } from '../../tools/data-scale/runtime-provisioner.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const seedScript = path.join(root, 'tools/data-scale/seed.sh');
const cleanupScript = path.join(root, 'tools/data-scale/cleanup.sh');
const dataScaleLane = path.join(root, 'tools/test/lanes/data-scale.sh');

test('data-scale seed rejects fsusblog-dev-postgres and fails closed without writing', () =>
{
    // When env missing or default fsusblog-dev-postgres passed
    const res = spawnSync('bash', [seedScript, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-dev-postgres',
            FSUSBLOG_PG_CONTAINER: ''
        },
        encoding: 'utf8'
    });

    assert.notEqual(res.status, 0, 'seed.sh must exit with non-zero status when given fsusblog-dev-postgres');
    assert.match(res.stderr, /prohibited from using shared or development postgres container/);
});

test('data-scale seed rejects current candidate shared PostgreSQL container', () =>
{
    const res = spawnSync('bash', [seedScript, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-test-postgres-candidate-42',
            FSUSBLOG_PG_CONTAINER: ''
        },
        encoding: 'utf8'
    });

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /prohibited from using shared or development postgres container/);
});

test('data-scale cleanup rejects fsusblog-dev-postgres and shared candidate containers', () =>
{
    const resDev = spawnSync('bash', [cleanupScript, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-dev-postgres'
        },
        encoding: 'utf8'
    });
    assert.notEqual(resDev.status, 0);
    assert.match(resDev.stderr, /prohibited from using shared or development postgres container/);

    const resCandidate = spawnSync('bash', [cleanupScript, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-test-postgres-candidate'
        },
        encoding: 'utf8'
    });
    assert.notEqual(resCandidate.status, 0);
    assert.match(resCandidate.stderr, /prohibited from using shared or development postgres container/);
});

test('data-scale lane ignores forced shared postgres and provisions dedicated identity', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-ignore-shared-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const probe = path.join(temp, 'probe.sh');
    fs.writeFileSync(probe, `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FSUSBLOG_DATA_SCALE_ROOT/scale-xs"
cat > "$FSUSBLOG_DATA_SCALE_ROOT/scale-xs/summary.json" <<'JSON'
{"schema":"fsusblog.data-scale-semantic-proof.v2","status":"ok","sampling":{"requests":1,"concurrency":1,"routeCount":1}}
JSON
`);
    fs.chmodSync(probe, 0o755);

    const res = spawnSync('bash', [dataScaleLane, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-dev-postgres',
            FSUSBLOG_DATA_SCALE_ROOT: path.join(temp, 'scale'),
            FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'plan-identity',
            FSUSBLOG_DATA_SCALE_PROBE_SCRIPT: probe,
            FSUSBLOG_TEST_RUN_ID: 'sched-ignore-shared-01'
        },
        encoding: 'utf8'
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stderr, /ignoring shared\/development container fsusblog-dev-postgres/);
    const envText = fs.readFileSync(path.join(temp, 'scale', 'scale-xs', 'dedicated-runtime.env'), 'utf8');
    assert.match(envText, /FSUSBLOG_POSTGRES_CONTAINER_NAME='fsusblog-data-scale-pg-/);
    assert.doesNotMatch(envText, /fsusblog-dev-postgres/);
});

test('data-scale lane invokes DataScaleRuntimeProvisioner and emits dedicated identity', (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-lane-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const probe = path.join(temp, 'probe.sh');
    fs.writeFileSync(probe, `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FSUSBLOG_DATA_SCALE_ROOT/scale-xs"
cat > "$FSUSBLOG_DATA_SCALE_ROOT/scale-xs/summary.json" <<'JSON'
{"schema":"fsusblog.data-scale-semantic-proof.v2","status":"ok","sampling":{"requests":1,"concurrency":1,"routeCount":1}}
JSON
`);
    fs.chmodSync(probe, 0o755);

    const res = spawnSync('bash', [dataScaleLane, 'scale-xs'], {
        cwd: root,
        env: {
            ...process.env,
            FSUSBLOG_DATA_SCALE_ROOT: path.join(temp, 'scale'),
            FSUSBLOG_DATA_SCALE_PROVISION_MODE: 'plan-identity',
            FSUSBLOG_DATA_SCALE_PROBE_SCRIPT: probe,
            FSUSBLOG_TEST_RUN_ID: 'sched-lane-wire-01',
            FSUSBLOG_TEST_NAMESPACE: 'data-scale'
        },
        encoding: 'utf8'
    });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout + res.stderr, /DataScaleRuntimeProvisioner|provisioning dedicated-scenario runtime/);

    const envFile = path.join(temp, 'scale', 'scale-xs', 'dedicated-runtime.env');
    assert.equal(fs.existsSync(envFile), true, 'lane must write provisioner env file');
    const envText = fs.readFileSync(envFile, 'utf8');
    assert.match(envText, /FSUSBLOG_POSTGRES_CONTAINER_NAME='fsusblog-data-scale-pg-/);
    assert.match(envText, /FSUSBLOG_REDIS_CONTAINER_NAME='fsusblog-data-scale-redis-/);
    assert.doesNotMatch(envText, /fsusblog-dev-postgres/);

    const projection = JSON.parse(fs.readFileSync(
        path.join(temp, 'scale', 'release-summaries', 'scale-xs.json'),
        'utf8'
    ));
    assert.equal(projection.status, 'ok');
    assert.deepEqual(projection.expectedSeed, { articles: 1, comments: 0 });
});

test('matrix data-scale-m uses dedicated exclusives without shared bootstrap', () =>
{
    const matrix = fs.readFileSync(path.join(root, 'tests/matrix.yml'), 'utf8');
    const match = matrix.match(/- id: data-scale-m\n([\s\S]*?)\n    - id: /);
    assert.ok(match, 'data-scale-m tier must exist');
    const block = match[1];
    assert.match(block, /requiresBootstrap: none/);
    assert.match(block, /services: \[\]/);
    assert.match(block, /executionDependsOn: \[behavior-doc-static-admission\]/);
    assert.match(block, /exclusiveResources: \[data-scale-artifacts, data-scale-postgres, data-scale-redis, data-scale-runtime\]/);
    assert.doesNotMatch(block, /requiresBootstrap: full/);
    assert.doesNotMatch(block, /services: \[postgres, redis\]/);
    assert.doesNotMatch(block, /exclusiveResources: \[scale-data\]/);
});

test('data-scale runtime provisioner fails if backend is running when raw seed is attempted', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-running-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-running-01'
    });

    await provisioner.provisionDedicatedResources();
    await provisioner.executeMigration();

    // Attempt seed with backendActive = true
    await assert.rejects(async () =>
    {
        await provisioner.executeOfflineSeed({ backendActive: true });
    }, /backend is already running; raw SQL seed is prohibited while backend is running/);
});

test('data-scale runtime provisioner fails if database is not empty or has active foreign connections', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-conn-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-conn-02'
    });

    await provisioner.provisionDedicatedResources();
    await provisioner.executeMigration();

    // Attempt seed with active foreign connections
    await assert.rejects(async () =>
    {
        await provisioner.executeOfflineSeed({ activeConnections: 3 });
    }, /active foreign connections; offline seed requires isolation/);
});

test('data-scale provision failure never falls back to local or dev containers', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-nofallback-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-fallback-03'
    });

    // Cause provision failure
    await assert.rejects(async () =>
    {
        await provisioner.provisionDedicatedResources({
            postgresImageDigest: 'sha256:bad0000000000000000000000000000000000000000000000000000000000000'
        });
    });

    // Ensure migration and seed cannot run after provision failure
    await assert.rejects(async () =>
    {
        await provisioner.executeMigration();
    }, /cannot execute migration after provision failure/);

    await assert.rejects(async () =>
    {
        await provisioner.executeOfflineSeed();
    }, /cannot seed after provision failure/);

    await assert.rejects(async () =>
    {
        await provisioner.startDedicatedBackend();
    }, /cannot start backend after provision failure/);
});

test('data-scale requires runtime identity receipt before starting HTTP verification', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-receipt-req-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-receipt-req-04'
    });

    await provisioner.provisionDedicatedResources();
    await provisioner.executeMigration();
    await provisioner.executeOfflineSeed();

    // Seed succeeded, but backend hasn't generated runtime identity receipt yet
    assert.throws(() =>
    {
        provisioner.assertReadyForHttpVerification();
    }, /data-scale runtime identity receipt is missing; cannot proceed to HTTP verification/);
});

test('external containers and processes are protected from mutation by data-scale', () =>
{
    // Check that isForbiddenContainerName rejects all external and shared container names
    const externalContainers = [
        'fsusblog-dev-postgres',
        'fsusblog-dev-redis',
        'fsusblog-test-postgres-local',
        'fsusblog-test-postgres-candidate',
        'fsusblog-test-redis-candidate',
        'fsusblog-candidate-backend'
    ];

    for (const name of externalContainers)
    {
        assert.ok(isForbiddenContainerName(name), `external container ${name} must be forbidden`);
        assert.throws(() =>
        {
            assertDedicatedContainer(name);
        }, /prohibited from using shared or development/);
    }
});
