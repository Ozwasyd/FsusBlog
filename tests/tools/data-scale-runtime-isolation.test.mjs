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

test('provisionLaneRuntime mode=full runs migrate+seed before backend and binds live digests', async (t) =>
{
    const { spawnSync } = await import('node:child_process');
    const { provisionLaneRuntime, teardownDedicatedRuntime } = await import('../../tools/data-scale/runtime-provisioner.mjs');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-ds-full-'));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

    fs.mkdirSync(path.join(temp, 'config/testing'), { recursive: true });
    fs.copyFileSync(
        path.join(root, 'config/testing/test-execution-service-catalog.json'),
        path.join(temp, 'config/testing/test-execution-service-catalog.json')
    );
    fs.mkdirSync(path.join(temp, 'tools/data-scale'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'tools/test'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'src/backend/bin/Release/net10.0'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'src/backend/bin/Release/net10.0/FsusBlog.Server.dll'), 'dll');
    fs.writeFileSync(
        path.join(temp, 'tools/data-scale/seed.sh'),
        '#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p \"$FSUSBLOG_DATA_SCALE_OUT_DIR\"\n'
        + 'printf \'{"schema":"fsusblog.data-scale-seed-receipt.v1","ok":true}\\n\' '
        + '>\"$FSUSBLOG_DATA_SCALE_OUT_DIR/seed-receipt.json\"\n'
    );
    fs.chmodSync(path.join(temp, 'tools/data-scale/seed.sh'), 0o755);
    fs.writeFileSync(path.join(temp, 'tools/test/execution-envelope-services.mjs'), 'console.log("ok");\n');

    spawnSync('git', ['init'], { cwd: temp, encoding: 'utf8' });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init'], {
        cwd: temp,
        encoding: 'utf8'
    });

    const state = {
        volumes: new Set(),
        containers: new Map()
    };
    const hex = (seed) => Buffer.from(String(seed).padEnd(32, 'x')).toString('hex').slice(0, 64);

    const dockerRunner = (args) =>
    {
        const joined = args.join(' ');
        if (args[0] === 'image' && args[1] === 'inspect')
        {
            return { status: 0, stdout: `sha256:${hex(args[2])}\n`, stderr: '' };
        }
        if (args[0] === 'volume' && args[1] === 'create')
        {
            const name = args[args.length - 1];
            state.volumes.add(name);
            return { status: 0, stdout: `${name}\n`, stderr: '' };
        }
        if (args[0] === 'volume' && args[1] === 'inspect')
        {
            const name = args[2];
            if (!state.volumes.has(name))
            {
                return { status: 1, stdout: '', stderr: 'missing' };
            }
            return {
                status: 0,
                stdout: `${name}|{"fsusblog.owner":"data-scale","fsusblog.dataScaleRunId":"run-full-01"}\n`,
                stderr: ''
            };
        }
        if (args[0] === 'volume' && args[1] === 'rm')
        {
            state.volumes.delete(args[args.length - 1]);
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'run' && args[1] === '--detach')
        {
            const name = args[args.indexOf('--name') + 1];
            const id = hex(`run-${name}`);
            state.containers.set(name, { id, running: true, image: hex(`img-${name}`) });
            return { status: 0, stdout: `${id}\n`, stderr: '' };
        }
        if (args[0] === 'create')
        {
            const name = args[args.indexOf('--name') + 1];
            const id = hex(`create-${name}`);
            state.containers.set(name, { id, running: false, image: hex(`img-${name}`) });
            return { status: 0, stdout: `${id}\n`, stderr: '' };
        }
        if (args[0] === 'start')
        {
            const container = state.containers.get(args[1]);
            if (!container)
            {
                return { status: 1, stdout: '', stderr: 'missing' };
            }
            container.running = true;
            return { status: 0, stdout: `${args[1]}\n`, stderr: '' };
        }
        if (args[0] === 'rm')
        {
            state.containers.delete(args[args.length - 1]);
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'exec')
        {
            return {
                status: 0,
                stdout: args.includes('redis-cli') ? 'PONG\n' : 'accepting connections\n',
                stderr: ''
            };
        }
        if (args[0] === 'inspect')
        {
            const container = state.containers.get(args[1]);
            if (!container)
            {
                return { status: 1, stdout: '', stderr: 'missing' };
            }
            if (joined.includes('HostPort'))
            {
                return { status: 0, stdout: '55432\n', stderr: '' };
            }
            if (joined.includes('Config.Labels'))
            {
                return {
                    status: 0,
                    stdout: `sha256:${container.id}|${container.running}|`
                        + '{"fsusblog.owner":"data-scale","fsusblog.dataScaleRunId":"run-full-01"}'
                        + `|sha256:${container.image}\n`,
                    stderr: ''
                };
            }
            if (joined.includes('.Image'))
            {
                return {
                    status: 0,
                    stdout: `sha256:${container.id}|${container.running}|sha256:${container.image}\n`,
                    stderr: ''
                };
            }
            return { status: 0, stdout: `sha256:${container.id}\n`, stderr: '' };
        }
        return { status: 1, stdout: '', stderr: `unexpected docker args: ${joined}` };
    };

    const processRunner = (command, args, options = {}) =>
    {
        if (command === 'node' && String(args[0]).endsWith('execution-envelope-services.mjs'))
        {
            const output = args[args.indexOf('--output') + 1];
            fs.mkdirSync(path.dirname(output), { recursive: true });
            fs.writeFileSync(output, '{"schema":"envelope","status":"ok"}\n');
            return { status: 0, stdout: 'ok\n', stderr: '' };
        }
        if (command === 'dotnet')
        {
            return { status: 0, stdout: 'migrated\n', stderr: '' };
        }
        if (command === 'bash')
        {
            return spawnSync(command, args, {
                encoding: 'utf8',
                cwd: options.cwd,
                env: { ...process.env, ...(options.env || {}) }
            });
        }
        return { status: 1, stdout: '', stderr: `unexpected process ${command}` };
    };

    const result = await provisionLaneRuntime({
        repositoryRoot: temp,
        tier: 'scale-xs',
        dataScaleRunId: 'run-full-01',
        parentSchedulerRunId: 'sched-full-01',
        mode: 'full',
        emitEnvPath: path.join(temp, 'dedicated.env'),
        environment: {},
        dockerRunner,
        processRunner
    });

    assert.equal(result.mode, 'full');
    assert.ok(result.receiptPath);
    assert.ok(result.liveIdentity.postgres.containerId);
    assert.ok(result.liveIdentity.redis.containerId);
    assert.ok(result.liveIdentity.backend.containerId);
    assert.match(result.liveIdentity.postgres.imageDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.provisioner.state.migrationCompleted, true);
    assert.equal(result.provisioner.state.seedCompleted, true);
    assert.equal(result.provisioner.state.backendRunning, true);
    assert.equal(result.provisioner.state.stepIndex, 6);

    const receipt = JSON.parse(fs.readFileSync(path.join(temp, result.receiptPath), 'utf8'));
    assert.equal(receipt.postgres.containerId, result.liveIdentity.postgres.containerId);
    assert.equal(receipt.redis.volumeId, result.liveIdentity.redis.volumeId);
    assert.equal(receipt.backend.pidOrContainerId, result.liveIdentity.backend.containerId);

    teardownDedicatedRuntime(result.provisioner);
    assert.equal(state.containers.size, 0);
});
