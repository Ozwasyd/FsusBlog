import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    DATA_SCALE_RUNTIME_SCHEMA,
    DATA_SCALE_TEARDOWN_SCHEMA,
    contentDigest,
    createDataScaleRuntimePlan,
    createDataScaleRuntimeReceipt,
    createDataScaleTeardownReceipt,
    provisionDataScaleRuntime,
    teardownDataScaleRuntime
} from '../../tools/test/data-scale-runtime-owner.mjs';

const sha = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;

function temporaryRoot(context)
{
    const root = mkdtempSync(path.join(os.tmpdir(), 'fsus-scale-owner-'));
    context.after(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

function plan(root)
{
    return createDataScaleRuntimePlan({
        repositoryRoot: root,
        runId: 'release-run',
        invocationId: 'invocation-a',
        attemptId: 'attempt-1',
        sourceCommit: 'a'.repeat(40),
        worktreeFingerprint: sha('b'),
        buildReceiptDigest: sha('c'),
        imageDigest: sha('d'),
        postgresImageDigest: sha('e'),
        redisImageDigest: sha('f')
    });
}

function runtimeReceipt(root, ownerPlan)
{
    return createDataScaleRuntimeReceipt({
        repositoryRoot: root,
        plan: ownerPlan,
        postgres: {
            containerId: '1'.repeat(64),
            imageDigest: ownerPlan.postgresImageDigest,
            volumeId: ownerPlan.resources.postgresVolumeName,
            database: 'fsusblog'
        },
        redis: {
            containerId: '2'.repeat(64),
            imageDigest: ownerPlan.redisImageDigest,
            volumeId: ownerPlan.resources.redisVolumeName
        },
        backend: {
            pidOrContainerId: '3'.repeat(64),
            startTicks: '17',
            baseUrl: 'http://127.0.0.1:49152',
            executableOrImageDigest: ownerPlan.imageDigest
        },
        network: {
            id: '6'.repeat(64),
            name: ownerPlan.resources.networkName
        },
        permissionHelper: {
            name: ownerPlan.resources.permissionHelperContainerName,
            postExists: false
        },
        seedReceiptPath: `${ownerPlan.roots.dataRoot}/seed.json`,
        seedReceiptDigest: sha('4'),
        seedSummary: scaleSummary(ownerPlan.namespace),
        envManifestDigest: sha('5'),
        fixtureIdentityDigest: sha('6'),
        lifecycle: {
            start: 'complete',
            reset: 'complete',
            readiness: 'complete',
            postcondition: 'pending'
        },
        createdAt: '2026-09-04T00:00:00.000Z'
    });
}

function scaleSummary(namespace)
{
    return {
        status: 'ok',
        tier: 'scale-m',
        namespace,
        declared: { articles: 10000, comments: 100000 },
        expected: { articles: 10000, comments: 100000 },
        observed: { articles: 10000, comments: 100000 }
    };
}

test('runtime plan is deterministic and binds current run, invocation, and attempt', (context) =>
{
    const root = temporaryRoot(context);
    const first = plan(root);
    const second = plan(root);
    assert.deepEqual(first, second);
    assert.equal(first.parentSchedulerRunId, 'release-run');
    assert.equal(first.invocationId, 'invocation-a');
    assert.equal(first.attemptId, 'attempt-1');
    assert.match(first.dataScaleRunId, /^data-scale-[0-9a-f]{20}$/u);
    assert.equal(new Set(Object.values(first.resources)).size, 7);
    assert.ok(Object.values(first.roots).every((value) =>
        value.includes(first.dataScaleRunId)));
});

test('runtime receipt binds exact owner identities and sealed digest', (context) =>
{
    const root = temporaryRoot(context);
    const receipt = runtimeReceipt(root, plan(root));
    assert.equal(receipt.schema, DATA_SCALE_RUNTIME_SCHEMA);
    assert.equal(receipt.invocationId, 'invocation-a');
    assert.equal(receipt.attemptId, 'attempt-1');
    assert.equal(receipt.contentDigest, contentDigest(receipt));
    assert.equal(receipt.backend.executableOrImageDigest, receipt.imageDigest);
});

test('runtime authority rejects cross-run identity, unsafe roots, and image drift', (context) =>
{
    const root = temporaryRoot(context);
    assert.throws(() => createDataScaleRuntimePlan({
        ...plan(root),
        repositoryRoot: root,
        runId: '../foreign'
    }), /runId must be a canonical identifier/u);
    const ownerPlan = plan(root);
    assert.throws(() => createDataScaleRuntimeReceipt({
        repositoryRoot: root,
        plan: { ...ownerPlan, roots: { ...ownerPlan.roots, dataRoot: '.tmp/shared' } },
        postgres: { containerId: '1'.repeat(64), imageDigest: sha('e'), volumeId: 'pg', database: 'fsusblog' },
        redis: { containerId: '2'.repeat(64), imageDigest: sha('f'), volumeId: 'redis' },
        backend: { pidOrContainerId: '3'.repeat(64), startTicks: '1', baseUrl: 'http://127.0.0.1:1', executableOrImageDigest: sha('d') },
        network: { id: '6'.repeat(64), name: ownerPlan.resources.networkName }, permissionHelper: { name: ownerPlan.resources.permissionHelperContainerName, postExists: false },
        seedReceiptPath: `${ownerPlan.roots.dataRoot}/seed.json`, seedReceiptDigest: sha('4'), seedSummary: scaleSummary(ownerPlan.namespace), envManifestDigest: sha('5'), fixtureIdentityDigest: sha('6'), lifecycle: { start: 'complete', reset: 'complete', readiness: 'complete', postcondition: 'pending' }, createdAt: '2026-09-04T00:00:00Z'
    }), /dataRoot must be owned/u);
    assert.throws(() => createDataScaleRuntimeReceipt({
        repositoryRoot: root,
        plan: ownerPlan,
        postgres: { containerId: '1'.repeat(64), imageDigest: sha('e'), volumeId: 'pg', database: 'fsusblog' },
        redis: { containerId: '2'.repeat(64), imageDigest: sha('f'), volumeId: 'redis' },
        backend: { pidOrContainerId: '3'.repeat(64), startTicks: '1', baseUrl: 'http://127.0.0.1:1', executableOrImageDigest: sha('9') },
        network: { id: '6'.repeat(64), name: ownerPlan.resources.networkName }, permissionHelper: { name: ownerPlan.resources.permissionHelperContainerName, postExists: false },
        seedReceiptPath: `${ownerPlan.roots.dataRoot}/seed.json`, seedReceiptDigest: sha('4'), seedSummary: scaleSummary(ownerPlan.namespace), envManifestDigest: sha('5'), fixtureIdentityDigest: sha('6'), lifecycle: { start: 'complete', reset: 'complete', readiness: 'complete', postcondition: 'pending' }, createdAt: '2026-09-04T00:00:00Z'
    }), /backend identity is incomplete/u);
});

test('teardown receipt is complete only after every owned resource is absent', (context) =>
{
    const root = temporaryRoot(context);
    const ownerPlan = plan(root);
    const observations = Object.values(ownerPlan.resources).map((plannedId) => ({
        plannedId,
        observedId: plannedId,
        ownershipStatus: 'owned',
        action: 'remove',
        actionExit: 0,
        postExists: false
    }));
    const receipt = createDataScaleTeardownReceipt({
        plan: ownerPlan,
        runtimeReceiptDigest: sha('7'),
        startedAt: '2026-09-04T00:01:00Z',
        finishedAt: '2026-09-04T00:02:00Z',
        resourceObservations: observations,
        portObservations: [{ port: 49152, postListeningPids: [] }],
        rootObservations: Object.values(ownerPlan.roots).map((value) => ({ path: value, postExists: false })),
        leaseObservations: [{ id: ownerPlan.dataScaleRunId, postStatus: 'released' }]
    });
    assert.equal(receipt.schema, DATA_SCALE_TEARDOWN_SCHEMA);
    assert.equal(receipt.status, 'complete');
    assert.equal(receipt.contentDigest, contentDigest(receipt));

    const leaked = createDataScaleTeardownReceipt({
        plan: ownerPlan,
        runtimeReceiptDigest: sha('7'),
        startedAt: '2026-09-04T00:01:00Z',
        finishedAt: '2026-09-04T00:02:00Z',
        resourceObservations: observations.map((item, index) => index === 0
            ? { ...item, postExists: true }
            : item),
        portObservations: [{ port: 49152, postListeningPids: [777] }],
        rootObservations: Object.values(ownerPlan.roots).map((value, index) => ({ path: value, postExists: index === 0 })),
        leaseObservations: [{ id: ownerPlan.dataScaleRunId, postStatus: 'held' }]
    });
    assert.equal(leaked.status, 'blocked');
});

test('provision and teardown execute the dedicated topology and leave zero residue', async (context) =>
{
    const root = temporaryRoot(context);
    const envFile = path.join(root, '.tmp/env/runtime.env');
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, 'ASPNETCORE_ENVIRONMENT=Test\n');
    const sourcePostgresId = 'a'.repeat(64);
    const sourceRedisId = 'b'.repeat(64);
    const ids = {
        postgres: '1'.repeat(64),
        redis: '2'.repeat(64),
        backend: '3'.repeat(64),
        network: '4'.repeat(64)
    };
    const imageIds = {
        'fsusblog/runtime:test': sha('d'),
        [sha('e')]: sha('e'),
        [sha('f')]: sha('f')
    };
    const removed = new Set();
    const created = new Set();
    let helperResidue = '';
    const calls = [];
    let ownerPlan = plan(root);
    const labels = () => ({
        'io.fsusblog.test.run-id': ownerPlan.parentSchedulerRunId,
        'io.fsusblog.test.namespace': ownerPlan.namespace,
        'io.fsusblog.test.invocation-id': ownerPlan.invocationId,
        'io.fsusblog.test.attempt-id': ownerPlan.attemptId,
        'io.fsusblog.test.data-scale-run-id': ownerPlan.dataScaleRunId
    });
    const execute = (command, args, options) =>
    {
        calls.push([command, ...args]);
        if (command.endsWith('/tools/data-scale/seed.sh'))
        {
            mkdirSync(options.env.FSUSBLOG_DATA_SCALE_OUT_DIR, { recursive: true });
            writeFileSync(
                path.join(options.env.FSUSBLOG_DATA_SCALE_OUT_DIR, 'seed.json'),
                `${JSON.stringify(scaleSummary(ownerPlan.namespace))}\n`
            );
            return { status: 0, stdout: '', stderr: '' };
        }
        if (command === 'ss')
        {
            return { status: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect')
        {
            return {
                status: 0,
                stdout: JSON.stringify([{
                    Id: imageIds[args[2]],
                    Config: { User: '1654' }
                }]),
                stderr: ''
            };
        }
        if (args[0] === 'network' && args[1] === 'create')
        {
            created.add(`network:${args.at(-1)}`);
            return { status: 0, stdout: ids.network, stderr: '' };
        }
        if (args[0] === 'volume' && args[1] === 'create')
        {
            created.add(`volume:${args.at(-1)}`);
            return { status: 0, stdout: args.at(-1), stderr: '' };
        }
        if (args[0] === 'run')
        {
            if (args.includes('--rm'))
            {
                const name = args[args.indexOf('--name') + 1];
                removed.add(`container:${name}`);
                return { status: 0, stdout: '', stderr: '' };
            }
            const name = args[args.indexOf('--name') + 1];
            created.add(`container:${name}`);
            const id = name.includes('postgres') ? ids.postgres
                : name.includes('redis') ? ids.redis : ids.backend;
            return { status: 0, stdout: id, stderr: '' };
        }
        if (args[0] === 'exec' && args.includes('pg_dump'))
        {
            return { status: 0, stdout: 'CREATE TABLE fixture(id integer);', stderr: '' };
        }
        if (args[0] === 'exec')
        {
            return { status: 0, stdout: '', stderr: '' };
        }
        if ((args[0] === 'ps' && args.includes('--format')) || args[1] === 'ls')
        {
            const kind = args[0] === 'ps' ? 'container' : args[0];
            const names = Object.entries(ownerPlan.resources)
                .filter(([key, name]) => (kind === 'container' ? key.endsWith('ContainerName')
                    : kind === 'network' ? key === 'networkName' : key.endsWith('VolumeName'))
                    && created.has(`${kind}:${name}`) && !removed.has(`${kind}:${name}`))
                .map(([, name]) => name);
            return { status: 0, stdout: names.join('\n'), stderr: '' };
        }
        if (args[0] === 'ps')
        {
            return { status: 0, stdout: helperResidue, stderr: '' };
        }
        const inspectKind = args[0] === 'network' ? 'network'
            : args[0] === 'volume' ? 'volume' : 'container';
        if (args.includes('inspect'))
        {
            const target = args.at(-1);
            if (removed.has(`${inspectKind}:${target}`))
            {
                return { status: 1, stdout: '', stderr: 'not found' };
            }
            if (target === sourcePostgresId)
            {
                return { status: 0, stdout: JSON.stringify([{ Id: target, Config: { Image: 'postgres:test' } }]), stderr: '' };
            }
            if (target === sourceRedisId)
            {
                return { status: 0, stdout: JSON.stringify([{ Id: target, Config: { Image: 'redis:test' } }]), stderr: '' };
            }
            if (target === ids.backend)
            {
                return { status: 0, stdout: JSON.stringify([{
                    Id: target,
                    State: { Pid: process.pid, Running: true },
                    NetworkSettings: { Ports: { '8080/tcp': [{ HostPort: '49152' }] } },
                    Config: { Labels: labels() }
                }]), stderr: '' };
            }
            const document = inspectKind === 'network'
                ? { Id: ids.network, Name: target, Labels: labels() }
                : inspectKind === 'volume'
                    ? { Name: target, Labels: labels() }
                    : { Id: target, Config: { Labels: labels() } };
            return { status: 0, stdout: JSON.stringify([document]), stderr: '' };
        }
        if ((args[0] === 'rm')
            || (args[0] === 'network' && args[1] === 'rm')
            || (args[0] === 'volume' && args[1] === 'rm'))
        {
            const kind = args[0] === 'network' ? 'network'
                : args[0] === 'volume' ? 'volume' : 'container';
            removed.add(`${kind}:${args.at(-1)}`);
            return { status: 0, stdout: args.at(-1), stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unexpected command' };
    };
    const identity = {
        status: 'complete',
        sourceState: { commit: 'a'.repeat(40), worktreeFingerprint: sha('b') },
        build: { contentDigest: sha('c'), imageDigest: sha('d') },
        fixture: {
            status: 'complete',
            topology: { content: {
                postgres: { instance: sourcePostgresId, imageId: sha('e') },
                redis: { instance: sourceRedisId, imageId: sha('f') }
            } }
        }
    };
    const environment = {
        FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: 'release-run',
        FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: 'invocation-a',
        FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-1',
        FSUSBLOG_RELEASE_RUNTIME_IMAGE: 'fsusblog/runtime:test',
        FSUSBLOG_TEST_FIXTURE_CONFIG: '.tmp/env/runtime.env'
    };
    created.add(`network:${ownerPlan.resources.networkName}`);
    await assert.rejects(provisionDataScaleRuntime({
        repositoryRoot: root, identity, environment, execute
    }), /attempt already has runtime resources/u);
    assert.equal(existsSync(path.join(root, '.tmp/data-scale-runtime')), false);
    assert.ok(!calls.some((call) => call[1] === 'run' || call[2] === 'create'));
    created.clear();
    const provisioned = await provisionDataScaleRuntime({
        repositoryRoot: root,
        identity,
        environment,
        execute,
        fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ready' }) }),
        wait: async () => {}
    });
    ownerPlan = provisioned.plan;
    assert.equal(provisioned.receipt.lifecycle.readiness, 'complete');
    assert.ok(!calls.some((call) => call.includes('pg_dump')));
    assert.ok(calls.some((call) => call.includes('fsusblog-owner-permissions')));
    assert.ok(!calls.flat().includes('0777'));
    const backendRun = calls.find((call) =>
        call[1] === 'run' && call.includes(provisioned.plan.resources.backendContainerName));
    for (const rootPath of Object.values(provisioned.plan.roots))
    {
        assert.ok(backendRun.some((argument) => argument.startsWith(
            `${path.join(root, rootPath)}:`
        )));
    }
    assert.ok(calls.some((call) => call[0].endsWith('/tools/data-scale/seed.sh')));
    const unavailable = await teardownDataScaleRuntime({
        repositoryRoot: root,
        plan: provisioned.plan,
        runtimeReceipt: provisioned.receipt,
        execute: (command, args, options) => (args.includes('--format') || args[1] === 'ls')
            ? { status: 1, stdout: '', stderr: 'daemon unavailable' }
            : execute(command, args, options)
    });
    assert.equal(unavailable.receipt.status, 'blocked');
    assert.ok(unavailable.receipt.roots.every((item) => item.postExists));
    assert.equal(removed.size, 1, 'failed observation must retain resources and their cleanup owner');
    const tornDown = await teardownDataScaleRuntime({
        repositoryRoot: root,
        plan: provisioned.plan,
        runtimeReceipt: provisioned.receipt,
        execute
    });
    assert.equal(tornDown.receipt.status, 'complete');
    assert.equal(tornDown.receipt.runtimeReceiptDigest, provisioned.receipt.contentDigest);
    assert.equal(
        removed.size,
        7,
        'transient helper plus three containers, one network, and two volumes must be absent'
    );

    const previousCalls = calls.length;
    await assert.rejects(provisionDataScaleRuntime({
        repositoryRoot: root, identity, environment, execute
    }), /attempt already has owner state/u);
    assert.ok(calls.slice(previousCalls).every((call) => call[1] === 'image' && call[2] === 'inspect'));

    ownerPlan = createDataScaleRuntimePlan({
        ...plan(root), repositoryRoot: root, runId: 'release-run', attemptId: 'attempt-2'
    });
    helperResidue = '9'.repeat(64);
    await assert.rejects(
        provisionDataScaleRuntime({
            repositoryRoot: root,
            identity,
            environment: { ...environment, FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-2' },
            execute,
            fetchImpl: async () => ({
                ok: true,
                json: async () => ({ status: 'ready' })
            }),
            wait: async () => {}
        }),
        /permission helper container left a residue/u
    );
});

test('tampered plan and escaped CLI paths fail before any destructive command', async (context) =>
{
    const root = temporaryRoot(context);
    const sentinel = path.join(root, 'sentinel');
    writeFileSync(sentinel, 'keep');
    const valid = plan(root);
    const tampered = {
        ...valid,
        dataScaleRunId: '../../outside',
        contentDigest: null
    };
    tampered.contentDigest = contentDigest(tampered);
    let commandCount = 0;
    await assert.rejects(
        teardownDataScaleRuntime({
            repositoryRoot: root,
            plan: tampered,
            runtimeReceipt: null,
            execute: () =>
            {
                commandCount += 1;
                return { status: 0, stdout: '', stderr: '' };
            }
        }),
        /not deterministically derived/u
    );
    assert.equal(commandCount, 0);
    assert.equal(existsSync(sentinel), true);

    const outside = temporaryRoot(context);
    const escapedPlan = path.join(outside, 'plan.json');
    const escapedRuntime = path.join(outside, 'runtime.json');
    writeFileSync(escapedPlan, JSON.stringify(valid));
    writeFileSync(escapedRuntime, '{}');
    const cli = spawnSync(process.execPath, [
        path.join(process.cwd(), 'tools/test/data-scale-runtime-owner.mjs'),
        'teardown', '--root', root, '--plan', escapedPlan,
        '--runtime', escapedRuntime
    ], { encoding: 'utf8' });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /plan path is unsafe/u);

    const envFile = path.join(root, '.tmp/env/runtime.env');
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, 'SECRET=do-not-print\n');
    await assert.rejects(
        provisionDataScaleRuntime({
            repositoryRoot: root,
            identity: {
                status: 'complete',
                sourceState: {
                    commit: 'a'.repeat(40),
                    worktreeFingerprint: sha('b')
                },
                build: { contentDigest: sha('c'), imageDigest: sha('d') },
                fixture: {
                    status: 'complete',
                    topology: { content: {
                        postgres: { instance: 'a'.repeat(64), imageId: sha('e') },
                        redis: { instance: 'b'.repeat(64), imageId: sha('f') }
                    } }
                }
            },
            environment: {
                FSUSBLOG_RELEASE_RELIABILITY_RUN_ID: 'release-run',
                FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: 'invocation-a',
                FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID: 'attempt-1',
                FSUSBLOG_RELEASE_RUNTIME_IMAGE: 'runtime:secret',
                FSUSBLOG_TEST_FIXTURE_CONFIG: '.tmp/env/runtime.env'
            },
            execute: () => ({
                status: 1,
                stdout: '',
                stderr: 'password=super-secret'
            })
        }),
        (error) => error.message === 'docker image failed with exit 1'
            && !error.message.includes('super-secret')
    );
});
