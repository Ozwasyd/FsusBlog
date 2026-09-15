import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertDedicatedRoots,
    createDataScaleRuntimePlan,
    validateDataScaleBackendConnection,
    validateDataScaleRuntimePlan
} from '../../tools/data-scale/runtime-plan.mjs';

import { DataScaleRuntimeProvisioner } from '../../tools/data-scale/runtime-provisioner.mjs';

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));

test('data-scale runtime isolation rejects dedicated roots pointing to shared wwwroot or global cache', () =>
{
    const runId = 'run-iso-01';

    // Root pointing to src/backend/wwwroot
    assert.throws(() =>
    {
        assertDedicatedRoots({
            aotRoot: 'src/backend/wwwroot',
            searchRoot: `.tmp/scale/${runId}/search`,
            hotReadRoot: `.tmp/scale/${runId}/hotread`,
            dataRoot: `.tmp/scale/${runId}/data`,
            dataScaleRunId: runId,
            repositoryRoot: root
        });
    }, /must reside under \.tmp\//);

    // Root pointing to .tmp/cache (global cache)
    assert.throws(() =>
    {
        assertDedicatedRoots({
            aotRoot: `.tmp/scale/${runId}/aot`,
            searchRoot: `.tmp/scale/${runId}/search`,
            hotReadRoot: `.tmp/cache/${runId}`,
            dataRoot: `.tmp/scale/${runId}/data`,
            dataScaleRunId: runId,
            repositoryRoot: root
        });
    }, /must not overlap with shared repository root/);
});

test('data-scale runtime isolation rejects roots that do not contain dataScaleRunId', () =>
{
    assert.throws(() =>
    {
        assertDedicatedRoots({
            aotRoot: '.tmp/scale/shared/aot',
            searchRoot: '.tmp/scale/shared/search',
            hotReadRoot: '.tmp/scale/shared/hotread',
            dataRoot: '.tmp/scale/shared/data',
            dataScaleRunId: 'run-iso-02',
            repositoryRoot: root
        });
    }, /must contain run-bound ID run-iso-02/);
});

test('data-scale runtime isolation rejects overlapping/duplicate roots', () =>
{
    const runId = 'run-iso-03';
    assert.throws(() =>
    {
        assertDedicatedRoots({
            aotRoot: `.tmp/scale/${runId}/shared-root`,
            searchRoot: `.tmp/scale/${runId}/shared-root`,
            hotReadRoot: `.tmp/scale/${runId}/hotread`,
            dataRoot: `.tmp/scale/${runId}/data`,
            dataScaleRunId: runId,
            repositoryRoot: root
        });
    }, /roots must be distinct/);
});

test('data-scale runtime provisioner fails when PostgreSQL volume comes from an old run', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-oldvol-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-vol-04',
        parentSchedulerRunId: 'sched-vol-04'
    });

    await assert.rejects(async () =>
    {
        await provisioner.provisionDedicatedResources({
            existingVolumeId: 'fsusblog-data-scale-pg-vol-old-run'
        });
    }, /PostgreSQL volume comes from old run/);
});

test('data-scale runtime provisioner fails when image digest mismatches', async (t) =>
{
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-img-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const provisioner = new DataScaleRuntimeProvisioner({
        repositoryRoot: temp,
        dataScaleRunId: 'run-img-05',
        parentSchedulerRunId: 'sched-img-05'
    });

    await assert.rejects(async () =>
    {
        await provisioner.provisionDedicatedResources({
            postgresImageDigest: 'sha256:9999999999999999999999999999999999999999999999999999999999999999'
        });
    }, /image digest mismatch/);
});

test('data-scale backend connection validator fails when backend connects to another DB/Redis container', () =>
{
    const plan = createDataScaleRuntimePlan({
        dataScaleRunId: 'run-conn-06',
        parentSchedulerRunId: 'sched-conn-06',
        repositoryRoot: root
    });

    // Wrong postgres container
    assert.throws(() =>
    {
        validateDataScaleBackendConnection({
            plan,
            configuredPostgresContainer: 'fsusblog-dev-postgres',
            configuredRedisContainer: plan.redis.containerName,
            configuredDatabase: plan.postgres.database
        });
    }, /backend connected to wrong postgres container/);

    // Wrong redis container
    assert.throws(() =>
    {
        validateDataScaleBackendConnection({
            plan,
            configuredPostgresContainer: plan.postgres.containerName,
            configuredRedisContainer: 'fsusblog-dev-redis',
            configuredDatabase: plan.postgres.database
        });
    }, /backend connected to wrong redis container/);

    // Wrong database
    assert.throws(() =>
    {
        validateDataScaleBackendConnection({
            plan,
            configuredPostgresContainer: plan.postgres.containerName,
            configuredRedisContainer: plan.redis.containerName,
            configuredDatabase: 'fsusblog_other'
        });
    }, /backend connected to wrong database/);
});

test('scheduler isolation fails if data-scale shares runtime with soak or load', () =>
{
    const catalogFile = path.join(root, 'config/testing/release-reliability-scenario-catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));

    const dataScaleScenario = catalog.scenarios.find((s) => s.id === 'release-data-scale-m');
    assert.ok(dataScaleScenario, 'release-data-scale-m must exist in scenario catalog');

    // Data-scale must declare exclusive resources that prevent co-scheduling with shared runtime
    const exclusive = dataScaleScenario.scheduler.exclusiveResources;
    assert.ok(exclusive.includes('data-scale-runtime'));
    assert.ok(exclusive.includes('data-scale-postgres'));
    assert.ok(exclusive.includes('data-scale-redis'));
    assert.ok(exclusive.includes('data-scale-artifacts'));

    // Check that soak/load scenarios do not acquire data-scale exclusive resources
    const soakScenario = catalog.scenarios.find((s) => s.id === 'release-soak-min');
    assert.ok(soakScenario);
    for (const res of exclusive)
    {
        assert.ok(!soakScenario.scheduler.exclusiveResources.includes(res), `soak must not share ${res}`);
    }
});

test('provisionLaneRuntime emits dedicated env and sanitizes shared forced containers', async (t) =>
{
    const { provisionLaneRuntime } = await import('../../tools/data-scale/runtime-provisioner.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-lane-api-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    const sanitized = await provisionLaneRuntime({
        repositoryRoot: temp,
        tier: 'scale-xs',
        dataScaleRunId: 'run-sanitize-01',
        parentSchedulerRunId: 'sched-sanitize-01',
        mode: 'plan-identity',
        emitEnvPath: path.join(temp, 'sanitized.env'),
        environment: {
            FSUSBLOG_POSTGRES_CONTAINER_NAME: 'fsusblog-dev-postgres'
        }
    });
    assert.match(
        sanitized.environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        /^fsusblog-data-scale-pg-run-sanitize-01$/
    );
    assert.notEqual(
        sanitized.environment.FSUSBLOG_POSTGRES_CONTAINER_NAME,
        'fsusblog-dev-postgres'
    );

    const result = await provisionLaneRuntime({
        repositoryRoot: temp,
        tier: 'scale-m',
        dataScaleRunId: 'run-lane-api-01',
        parentSchedulerRunId: 'sched-lane-api-01',
        mode: 'plan-identity',
        emitEnvPath: path.join(temp, 'dedicated.env'),
        environment: {}
    });

    assert.equal(result.plan.runtimeRequirement, 'dedicated-scenario');
    assert.deepEqual(result.exclusiveResources, [
        'data-scale-artifacts',
        'data-scale-postgres',
        'data-scale-redis',
        'data-scale-runtime'
    ]);
    assert.match(result.environment.FSUSBLOG_POSTGRES_CONTAINER_NAME, /^fsusblog-data-scale-pg-run-lane-api-01$/);
    assert.equal(fs.existsSync(path.join(temp, 'dedicated.env')), true);
    assert.equal(
        fs.existsSync(path.join(temp, result.planPath)),
        true
    );
});
