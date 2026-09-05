#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    digestValue,
    sealDocument
} from './release-reliability-receipt.mjs';

export const DATA_SCALE_RUNTIME_SCHEMA = 'fsusblog.data-scale-runtime.v2';
export const DATA_SCALE_TEARDOWN_SCHEMA = 'fsusblog.data-scale-teardown.v2';

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const idPattern = /^[a-z0-9][a-z0-9_.-]*$/u;
const containerIdPattern = /^[0-9a-f]{64}$/u;

export const contentDigest = digestValue;

function requireIdentifier(value, label)
{
    if (!idPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} must be a canonical identifier`);
    }
    return String(value);
}

function requireDigest(value, label)
{
    if (!digestPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} must be a sha256 digest`);
    }
    return String(value);
}

function rawDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function writeJsonAtomic(file, document)
{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        mode: 0o600
    });
    fs.renameSync(temporary, file);
}

function run(command, args, {
    repositoryRoot,
    input = undefined,
    environment = undefined,
    execute = spawnSync
} = {})
{
    const result = execute(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        input,
        ...(environment === undefined ? {} : { env: environment }),
        maxBuffer: 64 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        const identity = `${path.basename(command)}${args[0] ? ` ${args[0]}` : ''}`;
        throw new Error(`${identity} failed with exit ${result.status}`);
    }
    return String(result.stdout ?? '').trim();
}

function inspectOne(target, options)
{
    const documents = JSON.parse(run('docker', ['inspect', target], options) || '[]');
    if (!Array.isArray(documents) || documents.length !== 1)
    {
        throw new Error(`docker inspection did not resolve one identity: ${target}`);
    }
    return documents[0];
}

function inspectImage(reference, options)
{
    const documents = JSON.parse(run('docker', ['image', 'inspect', reference], options) || '[]');
    if (!Array.isArray(documents) || documents.length !== 1
        || !/^sha256:[0-9a-f]{64}$/u.test(String(documents[0]?.Id ?? '')))
    {
        throw new Error(`runtime image inspection is invalid: ${reference}`);
    }
    return documents[0];
}

function containerStartTicks(container)
{
    const pid = Number(container?.State?.Pid);
    const stat = Number.isInteger(pid) && pid > 1
        ? fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        : '';
    const close = stat.lastIndexOf(')');
    const ticks = close < 0 ? null : stat.slice(close + 2).trim().split(/\s+/u)[19];
    if (!/^\d+$/u.test(String(ticks ?? '')))
    {
        throw new Error('backend container start ticks are unavailable');
    }
    return ticks;
}

function ownerLabels(plan)
{
    return [
        '--label', `io.fsusblog.test.run-id=${plan.parentSchedulerRunId}`,
        '--label', `io.fsusblog.test.namespace=${plan.namespace}`,
        '--label', `io.fsusblog.test.invocation-id=${plan.invocationId}`,
        '--label', `io.fsusblog.test.attempt-id=${plan.attemptId}`,
        '--label', `io.fsusblog.test.data-scale-run-id=${plan.dataScaleRunId}`
    ];
}

function ownedBinding(document, plan)
{
    const labels = document?.Config?.Labels ?? document?.Labels ?? {};
    return labels['io.fsusblog.test.run-id'] === plan.parentSchedulerRunId
        && labels['io.fsusblog.test.namespace'] === plan.namespace
        && labels['io.fsusblog.test.invocation-id'] === plan.invocationId
        && labels['io.fsusblog.test.attempt-id'] === plan.attemptId
        && labels['io.fsusblog.test.data-scale-run-id'] === plan.dataScaleRunId;
}

function ownedRoot(repositoryRoot, value, dataScaleRunId, label)
{
    const resolvedRepository = path.resolve(repositoryRoot);
    const resolved = path.resolve(resolvedRepository, String(value ?? ''));
    const relative = path.relative(resolvedRepository, resolved).replaceAll(path.sep, '/');
    if (!relative.startsWith('.tmp/')
        || !relative.split('/').includes(dataScaleRunId)
        || relative.includes('..'))
    {
        throw new Error(`${label} must be owned by the data-scale run under .tmp`);
    }
    return relative;
}

export function createDataScaleRuntimePlan({
    repositoryRoot,
    runId,
    invocationId,
    attemptId,
    sourceCommit,
    worktreeFingerprint,
    buildReceiptDigest,
    imageDigest,
    postgresImageDigest,
    redisImageDigest
})
{
    const parentSchedulerRunId = requireIdentifier(runId, 'runId');
    const invocation = requireIdentifier(invocationId, 'invocationId');
    const attempt = requireIdentifier(attemptId, 'attemptId');
    if (!/^[0-9a-f]{40}$/u.test(String(sourceCommit ?? '')))
    {
        throw new Error('sourceCommit must be a full lowercase commit');
    }
    const runToken = createHash('sha256')
        .update(`${parentSchedulerRunId}\0${invocation}\0${attempt}`)
        .digest('hex').slice(0, 20);
    const dataScaleRunId = `data-scale-${runToken}`;
    const namespace = `scale-${runToken}`;
    const runtimeRoot = `.tmp/data-scale-runtime/${dataScaleRunId}`;
    const plan = {
        schema: 'fsusblog.data-scale-runtime-plan.v1',
        parentSchedulerRunId,
        invocationId: invocation,
        attemptId: attempt,
        dataScaleRunId,
        namespace,
        sourceCommit: String(sourceCommit),
        worktreeFingerprint: requireDigest(worktreeFingerprint, 'worktreeFingerprint'),
        buildReceiptDigest: requireDigest(buildReceiptDigest, 'buildReceiptDigest'),
        imageDigest: requireDigest(imageDigest, 'imageDigest'),
        postgresImageDigest: requireDigest(postgresImageDigest, 'postgresImageDigest'),
        redisImageDigest: requireDigest(redisImageDigest, 'redisImageDigest'),
        resources: {
            postgresContainerName: `fsusblog-scale-postgres-${runToken}`,
            postgresVolumeName: `fsusblog-scale-postgres-data-${runToken}`,
            redisContainerName: `fsusblog-scale-redis-${runToken}`,
            redisVolumeName: `fsusblog-scale-redis-data-${runToken}`,
            backendContainerName: `fsusblog-scale-backend-${runToken}`,
            networkName: `fsusblog-scale-network-${runToken}`,
            permissionHelperContainerName: `fsusblog-scale-permissions-${runToken}`
        },
        roots: {
            aotRoot: `${runtimeRoot}/aot`,
            searchRoot: `${runtimeRoot}/search`,
            hotReadRoot: `${runtimeRoot}/hot-read`,
            dataRoot: `${runtimeRoot}/data`
        }
    };
    for (const [label, value] of Object.entries(plan.roots))
    {
        ownedRoot(repositoryRoot, value, dataScaleRunId, label);
    }
    return Object.freeze(sealDocument(plan));
}

export function validateDataScaleRuntimePlan(repositoryRoot, candidate)
{
    const allowed = [
        'attemptId', 'buildReceiptDigest', 'contentDigest', 'dataScaleRunId',
        'imageDigest', 'invocationId', 'namespace', 'parentSchedulerRunId',
        'postgresImageDigest', 'redisImageDigest', 'resources', 'roots',
        'schema', 'sourceCommit', 'worktreeFingerprint'
    ].sort();
    if (!candidate || JSON.stringify(Object.keys(candidate).sort())
        !== JSON.stringify(allowed)
        || candidate.schema !== 'fsusblog.data-scale-runtime-plan.v1'
        || candidate.contentDigest !== digestValue(candidate))
    {
        throw new Error('data-scale runtime plan schema/digest is invalid');
    }
    const expected = createDataScaleRuntimePlan({
        repositoryRoot,
        runId: candidate.parentSchedulerRunId,
        invocationId: candidate.invocationId,
        attemptId: candidate.attemptId,
        sourceCommit: candidate.sourceCommit,
        worktreeFingerprint: candidate.worktreeFingerprint,
        buildReceiptDigest: candidate.buildReceiptDigest,
        imageDigest: candidate.imageDigest,
        postgresImageDigest: candidate.postgresImageDigest,
        redisImageDigest: candidate.redisImageDigest
    });
    if (JSON.stringify(candidate) !== JSON.stringify(expected))
    {
        throw new Error('data-scale runtime plan is not deterministically derived');
    }
    return expected;
}

function requireContainerIdentity(value, label)
{
    if (!value || !containerIdPattern.test(String(value.containerId ?? ''))
        || !digestPattern.test(String(value.imageDigest ?? ''))
        || !idPattern.test(String(value.volumeId ?? '')))
    {
        throw new Error(`${label} identity is incomplete`);
    }
}

export function createDataScaleRuntimeReceipt({
    repositoryRoot,
    plan,
    postgres,
    redis,
    backend,
    network,
    permissionHelper,
    seedReceiptPath,
    seedReceiptDigest,
    seedSummary,
    envManifestDigest,
    fixtureIdentityDigest,
    lifecycle,
    createdAt
})
{
    requireContainerIdentity(postgres, 'PostgreSQL');
    requireContainerIdentity(redis, 'Redis');
    if (!backend || !containerIdPattern.test(String(backend.pidOrContainerId ?? ''))
        || !/^\d+$/u.test(String(backend.startTicks ?? ''))
        || !/^https?:\/\/[^/]+/u.test(String(backend.baseUrl ?? ''))
        || backend.executableOrImageDigest !== plan.imageDigest)
    {
        throw new Error('backend identity is incomplete');
    }
    if (!network || !containerIdPattern.test(String(network.id ?? ''))
        || network.name !== plan.resources.networkName
        || !permissionHelper
        || permissionHelper.name !== plan.resources.permissionHelperContainerName
        || permissionHelper.postExists !== false
        || JSON.stringify(lifecycle) !== JSON.stringify({
            start: 'complete',
            reset: 'complete',
            readiness: 'complete',
            postcondition: 'pending'
        }))
    {
        throw new Error('runtime topology/lifecycle identity is incomplete');
    }
    if (seedSummary?.status !== 'ok' || seedSummary.tier !== 'scale-m'
        || seedSummary.namespace !== plan.namespace
        || seedSummary.declared?.articles !== 10000
        || seedSummary.declared?.comments !== 100000
        || seedSummary.observed?.articles !== 10000
        || seedSummary.observed?.comments !== 100000)
    {
        throw new Error('data-scale seed summary is not the exact scale-m plan');
    }
    const receipt = {
        schema: DATA_SCALE_RUNTIME_SCHEMA,
        dataScaleRunId: plan.dataScaleRunId,
        parentSchedulerRunId: plan.parentSchedulerRunId,
        invocationId: plan.invocationId,
        attemptId: plan.attemptId,
        sourceCommit: plan.sourceCommit,
        worktreeFingerprint: plan.worktreeFingerprint,
        buildReceiptDigest: plan.buildReceiptDigest,
        imageDigest: plan.imageDigest,
        fixtureIdentityDigest: requireDigest(fixtureIdentityDigest, 'fixture identity'),
        namespace: plan.namespace,
        network: {
            id: network.id,
            name: network.name
        },
        permissionHelper,
        postgres: {
            containerId: postgres.containerId,
            imageDigest: postgres.imageDigest,
            volumeId: postgres.volumeId,
            database: postgres.database
        },
        redis: {
            containerId: redis.containerId,
            imageDigest: redis.imageDigest,
            volumeId: redis.volumeId
        },
        backend: {
            pidOrContainerId: backend.pidOrContainerId,
            startTicks: String(backend.startTicks),
            baseUrl: backend.baseUrl,
            executableOrImageDigest: backend.executableOrImageDigest
        },
        aotRoot: ownedRoot(repositoryRoot, plan.roots.aotRoot, plan.dataScaleRunId, 'aotRoot'),
        searchRoot: ownedRoot(repositoryRoot, plan.roots.searchRoot, plan.dataScaleRunId, 'searchRoot'),
        hotReadRoot: ownedRoot(repositoryRoot, plan.roots.hotReadRoot, plan.dataScaleRunId, 'hotReadRoot'),
        dataRoot: ownedRoot(repositoryRoot, plan.roots.dataRoot, plan.dataScaleRunId, 'dataRoot'),
        envManifestDigest: requireDigest(envManifestDigest, 'envManifestDigest'),
        seedReceiptPath: ownedRoot(repositoryRoot, seedReceiptPath, plan.dataScaleRunId, 'seedReceiptPath'),
        seedReceiptDigest: requireDigest(seedReceiptDigest, 'seedReceiptDigest'),
        seedSummary,
        lifecycle,
        createdAt: new Date(createdAt).toISOString()
    };
    return Object.freeze(sealDocument(receipt));
}

export function createDataScaleTeardownReceipt({
    plan,
    runtimeReceiptDigest,
    startedAt,
    finishedAt,
    resourceObservations,
    portObservations,
    rootObservations,
    leaseObservations,
    failures = []
})
{
    const resources = Object.values(plan.resources).map((plannedId) =>
    {
        const observation = resourceObservations.find((item) => item.plannedId === plannedId);
        return {
            plannedId,
            observedId: observation?.observedId ?? plannedId,
            ownershipStatus: observation?.ownershipStatus ?? 'unknown',
            action: observation?.action ?? null,
            actionExit: observation?.actionExit ?? null,
            status: observation?.postExists === false ? 'complete' : 'failed',
            postObservation: { exists: observation?.postExists ?? true }
        };
    });
    const roots = Object.values(plan.roots).map((rootPath) => ({
        path: rootPath,
        postExists: rootObservations.find((item) => item.path === rootPath)?.postExists ?? true
    }));
    const receipt = {
        schema: DATA_SCALE_TEARDOWN_SCHEMA,
        status: failures.length === 0
            && resources.every((item) => item.status === 'complete')
            && portObservations.every((item) => item.postListeningPids.length === 0)
            && roots.every((item) => item.postExists === false)
            && leaseObservations.every((item) => item.postStatus === 'released')
            ? 'complete'
            : 'blocked',
        dataScaleRunId: plan.dataScaleRunId,
        parentSchedulerRunId: plan.parentSchedulerRunId,
        invocationId: plan.invocationId,
        attemptId: plan.attemptId,
        sourceCommit: plan.sourceCommit,
        runtimePlanDigest: contentDigest(plan),
        runtimeReceiptDigest: requireDigest(
            runtimeReceiptDigest,
            'data-scale runtime receipt'
        ),
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        resources,
        ports: portObservations,
        roots,
        leases: leaseObservations,
        failures
    };
    return Object.freeze(sealDocument(receipt));
}

function runtimeInputs(repositoryRoot, identity, environment)
{
    if (identity?.status !== 'complete' || identity.fixture?.status !== 'complete')
    {
        throw new Error('current release identity and fixture identity must be complete');
    }
    const runtimeImageReference = String(
        environment.FSUSBLOG_RELEASE_RUNTIME_IMAGE ?? ''
    ).trim();
    const postgresImageReference = String(
        identity.fixture.topology?.content?.postgres?.imageId ?? ''
    ).trim();
    const redisImageReference = String(
        identity.fixture.topology?.content?.redis?.imageId ?? ''
    ).trim();
    const envFile = path.resolve(
        repositoryRoot,
        String(environment.FSUSBLOG_TEST_FIXTURE_CONFIG ?? '')
    );
    if (!runtimeImageReference
        || !digestPattern.test(postgresImageReference)
        || !digestPattern.test(redisImageReference)
        || !fs.existsSync(envFile)
        || !fs.lstatSync(envFile).isFile())
    {
        throw new Error('runtime image and canonical fixture environment are required');
    }
    return {
        runId: requireIdentifier(
            environment.FSUSBLOG_RELEASE_RELIABILITY_RUN_ID,
            'runId'
        ),
        invocationId: requireIdentifier(
            environment.FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID,
            'invocationId'
        ),
        attemptId: requireIdentifier(
            environment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID,
            'attemptId'
        ),
        runtimeImageReference,
        postgresImageReference,
        redisImageReference,
        envFile
    };
}

function ownerFiles(repositoryRoot, plan)
{
    const validated = validateDataScaleRuntimePlan(repositoryRoot, plan);
    const directory = path.join(
        repositoryRoot,
        '.tmp/release-reliability',
        validated.invocationId,
        'data-scale-owner'
    );
    return {
        plan: path.join(directory, `${validated.dataScaleRunId}.plan.json`),
        runtime: path.join(directory, `${validated.dataScaleRunId}.runtime.json`),
        teardown: path.join(directory, `${validated.dataScaleRunId}.teardown.json`)
    };
}

function runtimeRoot(repositoryRoot, plan)
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const validated = validateDataScaleRuntimePlan(resolvedRoot, plan);
    const target = path.resolve(
        resolvedRoot,
        '.tmp/data-scale-runtime',
        validated.dataScaleRunId
    );
    const ownerRoot = path.resolve(resolvedRoot, '.tmp/data-scale-runtime');
    if (path.dirname(target) !== ownerRoot)
    {
        throw new Error('data-scale runtime root is not an exact owned descendant');
    }
    return target;
}

function ownerMarker(repositoryRoot, plan)
{
    return path.join(runtimeRoot(repositoryRoot, plan), '.fsusblog-owner.json');
}

function verifyOwnerMarker(repositoryRoot, plan)
{
    const marker = ownerMarker(repositoryRoot, plan);
    if (!fs.existsSync(marker) || !fs.lstatSync(marker).isFile()
        || fs.lstatSync(marker).isSymbolicLink())
    {
        throw new Error('data-scale runtime owner marker is missing or unsafe');
    }
    const document = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (document.schema !== 'fsusblog.data-scale-runtime-owner-marker.v1'
        || document.dataScaleRunId !== plan.dataScaleRunId
        || document.planDigest !== plan.contentDigest
        || document.contentDigest !== digestValue(document))
    {
        throw new Error('data-scale runtime owner marker binding mismatch');
    }
    return marker;
}

function relativeTo(repositoryRoot, target)
{
    return path.relative(repositoryRoot, target).replaceAll(path.sep, '/');
}

async function waitUntilReady(check, {
    attempts = 120,
    wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {})
{
    let lastFailure = null;
    for (let attempt = 0; attempt < attempts; attempt += 1)
    {
        try
        {
            return await check();
        }
        catch (error)
        {
            lastFailure = error;
            if (attempt + 1 < attempts)
            {
                await wait(250);
            }
        }
    }
    throw lastFailure ?? new Error('runtime readiness did not complete');
}

export async function provisionDataScaleRuntime({
    repositoryRoot,
    identity,
    environment,
    execute = spawnSync,
    fetchImpl = fetch,
    wait,
    now = () => new Date().toISOString()
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const inputs = runtimeInputs(resolvedRoot, identity, environment);
    const commandOptions = { repositoryRoot: resolvedRoot, execute };
    const runtimeImage = inspectImage(inputs.runtimeImageReference, commandOptions);
    const postgresImage = inspectImage(inputs.postgresImageReference, commandOptions);
    const redisImage = inspectImage(inputs.redisImageReference, commandOptions);
    const plan = createDataScaleRuntimePlan({
        repositoryRoot: resolvedRoot,
        runId: inputs.runId,
        invocationId: inputs.invocationId,
        attemptId: inputs.attemptId,
        sourceCommit: identity.sourceState.commit,
        worktreeFingerprint: identity.sourceState.worktreeFingerprint,
        buildReceiptDigest: identity.build.contentDigest,
        imageDigest: runtimeImage.Id,
        postgresImageDigest: postgresImage.Id,
        redisImageDigest: redisImage.Id
    });
    const files = ownerFiles(resolvedRoot, plan);
    writeJsonAtomic(files.plan, plan);
    const ownedRuntimeRoot = runtimeRoot(resolvedRoot, plan);
    fs.mkdirSync(ownedRuntimeRoot, { recursive: true, mode: 0o700 });
    for (const relative of Object.values(plan.roots))
    {
        const absolute = path.join(resolvedRoot, relative);
        fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
    }
    writeJsonAtomic(ownerMarker(resolvedRoot, plan), sealDocument({
        schema: 'fsusblog.data-scale-runtime-owner-marker.v1',
        dataScaleRunId: plan.dataScaleRunId,
        planDigest: plan.contentDigest
    }));
    const labels = ownerLabels(plan);
    try
    {
        const runtimeUser = String(runtimeImage.Config?.User ?? '').trim();
        const match = runtimeUser.match(/^(\d+)(?::(\d+))?$/u);
        if (!match)
        {
            throw new Error('runtime image must declare a numeric UID/GID');
        }
        const runtimeUid = match[1];
        const runtimeGid = String(process.getgid?.() ?? match[2] ?? match[1]);
        run('docker', [
            'run', '--rm', '--name', plan.resources.permissionHelperContainerName,
            '--user', '0', '--entrypoint', '/bin/sh',
            ...labels,
            '-v', `${ownedRuntimeRoot}:/owned`,
            runtimeImage.Id,
            '-c', 'chown -R "$1:$2" /owned && chmod -R u=rwX,g=rwX,o= /owned',
            'fsusblog-owner-permissions', runtimeUid, runtimeGid
        ], commandOptions);
        const permissionHelperResidue = run('docker', [
            'ps', '-aq', '--no-trunc',
            '--filter', `name=^/${plan.resources.permissionHelperContainerName}$`
        ], commandOptions);
        if (permissionHelperResidue)
        {
            throw new Error('permission helper container left a residue');
        }
        const networkId = run('docker', [
            'network', 'create', '--driver', 'bridge', ...labels,
            plan.resources.networkName
        ], commandOptions);
        for (const volume of [
            plan.resources.postgresVolumeName,
            plan.resources.redisVolumeName
        ])
        {
            run('docker', ['volume', 'create', ...labels, volume], commandOptions);
        }
        const postgresId = run('docker', [
            'run', '-d', '--name', plan.resources.postgresContainerName,
            '--network', plan.resources.networkName, '--network-alias', 'postgres',
            ...labels,
            '-e', 'POSTGRES_USER=fsusblog',
            '-e', 'POSTGRES_PASSWORD=fsusblog_dev',
            '-e', 'POSTGRES_DB=fsusblog',
            '-v', `${plan.resources.postgresVolumeName}:/var/lib/postgresql/data`,
            inputs.postgresImageReference
        ], commandOptions);
        const redisId = run('docker', [
            'run', '-d', '--name', plan.resources.redisContainerName,
            '--network', plan.resources.networkName, '--network-alias', 'redis',
            ...labels,
            '-v', `${plan.resources.redisVolumeName}:/data`,
            inputs.redisImageReference
        ], commandOptions);
        await waitUntilReady(() => run('docker', [
            'exec', postgresId, 'pg_isready', '-U', 'fsusblog', '-d', 'fsusblog'
        ], commandOptions), { wait });
        const seedRoot = path.join(resolvedRoot, plan.roots.dataRoot);
        const backendId = run('docker', [
            'run', '-d', '--name', plan.resources.backendContainerName,
            '--network', plan.resources.networkName,
            '-p', '127.0.0.1::8080', '--env-file', inputs.envFile,
            ...labels,
            '-v', `${seedRoot}:/app/data`,
            '-v', `${path.join(resolvedRoot, plan.roots.aotRoot)}:/app/data/aot-cache`,
            '-v', `${path.join(resolvedRoot, plan.roots.searchRoot)}:/app/data/search`,
            '-v', `${path.join(resolvedRoot, plan.roots.hotReadRoot)}:/app/data/hot-read`,
            '-e', 'FSUSBLOG_DATA_ROOT=/app/data',
            '-e', 'FSUSBLOG_AOT_CACHE_DIR=/app/data/aot-cache',
            '-e', 'FSUSBLOG_PUBLIC_AOT_CACHE_DIR=/app/data/aot-cache',
            '-e', 'FSUSBLOG_SEARCH_DIR=/app/data/search',
            '-e', 'FSUSBLOG_SEARCH_INDEX_DIR=/app/data/search',
            '-e', 'FSUSBLOG_BACKEND_WEBROOT=/app/data/hot-read',
            '-e', 'FSUSBLOG_WEB_ROOT=/app/data/hot-read',
            '-e', 'ASPNETCORE_URLS=http://0.0.0.0:8080',
            '-e', 'AllowedHosts=127.0.0.1',
            '-e', 'ConnectionStrings__DefaultConnection=Host=postgres;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true',
            '-e', 'ConnectionStrings__Redis=redis:6379,abortConnect=false,connectTimeout=10000',
            '-e', 'RedisOptions__Configuration=redis:6379,abortConnect=false,connectTimeout=10000',
            '-e', `FSUSBLOG_TEST_RUN_ID=${plan.dataScaleRunId}`,
            '-e', `FSUSBLOG_TEST_NAMESPACE=${plan.namespace}`,
            runtimeImage.Id
        ], commandOptions);
        const backend = inspectOne(backendId, commandOptions);
        const hostPort = Number(
            backend.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort
        );
        if (!Number.isInteger(hostPort) || hostPort < 1)
        {
            throw new Error('dedicated backend port binding is unavailable');
        }
        const baseUrl = `http://127.0.0.1:${hostPort}`;
        await waitUntilReady(async () =>
        {
            const response = await fetchImpl(`${baseUrl}/health/ready`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(3_000)
            });
            const document = response.ok ? await response.json() : null;
            if (!response.ok || document?.status !== 'ready')
            {
                throw new Error('dedicated backend readiness did not complete');
            }
        }, { wait });
        run(path.join(resolvedRoot, 'tools/data-scale/seed.sh'), ['scale-m'], {
            ...commandOptions,
            environment: {
                ...environment,
                FSUSBLOG_POSTGRES_CONTAINER_NAME: postgresId,
                FSUSBLOG_TEST_NAMESPACE: plan.namespace,
                FSUSBLOG_DATA_SCALE_OUT_DIR: seedRoot
            }
        });
        const seedFile = path.join(seedRoot, 'seed.json');
        const seedDocument = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        const receipt = createDataScaleRuntimeReceipt({
            repositoryRoot: resolvedRoot,
            plan,
            postgres: {
                containerId: postgresId,
                imageDigest: postgresImage.Id,
                volumeId: plan.resources.postgresVolumeName,
                database: 'fsusblog'
            },
            redis: {
                containerId: redisId,
                imageDigest: redisImage.Id,
                volumeId: plan.resources.redisVolumeName
            },
            backend: {
                pidOrContainerId: backendId,
                startTicks: containerStartTicks(backend),
                baseUrl,
                executableOrImageDigest: runtimeImage.Id
            },
            network: { id: networkId, name: plan.resources.networkName },
            permissionHelper: {
                name: plan.resources.permissionHelperContainerName,
                postExists: false
            },
            seedReceiptPath: relativeTo(resolvedRoot, seedFile),
            seedReceiptDigest: rawDigest(fs.readFileSync(seedFile)),
            seedSummary: {
                status: seedDocument.status,
                tier: seedDocument.tier,
                namespace: seedDocument.namespace,
                declared: seedDocument.declared,
                expected: seedDocument.expected,
                observed: seedDocument.observed
            },
            envManifestDigest: rawDigest(fs.readFileSync(inputs.envFile)),
            fixtureIdentityDigest: digestValue(identity.fixture),
            lifecycle: {
                start: 'complete',
                reset: 'complete',
                readiness: 'complete',
                postcondition: 'pending'
            },
            createdAt: now()
        });
        writeJsonAtomic(files.runtime, receipt);
        return {
            plan,
            planPath: relativeTo(resolvedRoot, files.plan),
            receipt,
            receiptPath: relativeTo(resolvedRoot, files.runtime)
        };
    }
    catch (error)
    {
        await teardownDataScaleRuntime({
            repositoryRoot: resolvedRoot,
            plan,
            runtimeReceipt: null,
            execute,
            now
        }).catch(() => {});
        throw error;
    }
}

export async function verifyDataScaleRuntimeLiveness({
    repositoryRoot,
    runtimeReceipt,
    execute = spawnSync,
    fetchImpl = fetch
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const options = { repositoryRoot: resolvedRoot, execute };
    const inspectContainer = (identity, volumeId = null) =>
    {
        const container = inspectOne(identity, options);
        const volumeNames = (container.Mounts ?? [])
            .filter((mount) => mount.Type === 'volume')
            .map((mount) => mount.Name);
        if (container.Id !== identity || container.State?.Running !== true
            || (volumeId !== null && !volumeNames.includes(volumeId)))
        {
            throw new Error('dedicated runtime container is not live/current');
        }
        return container;
    };
    const postgres = inspectContainer(
        runtimeReceipt.postgres.containerId,
        runtimeReceipt.postgres.volumeId
    );
    const redis = inspectContainer(
        runtimeReceipt.redis.containerId,
        runtimeReceipt.redis.volumeId
    );
    const backend = inspectContainer(runtimeReceipt.backend.pidOrContainerId);
    if (postgres.Image !== runtimeReceipt.postgres.imageDigest
        || redis.Image !== runtimeReceipt.redis.imageDigest
        || backend.Image !== runtimeReceipt.backend.executableOrImageDigest
        || containerStartTicks(backend) !== runtimeReceipt.backend.startTicks)
    {
        throw new Error('dedicated runtime container identity drifted');
    }
    const network = JSON.parse(run('docker', [
        'network', 'inspect', runtimeReceipt.network.id
    ], options) || '[]')[0];
    const members = Object.keys(network?.Containers ?? {}).sort();
    const expectedMembers = [
        runtimeReceipt.backend.pidOrContainerId,
        runtimeReceipt.postgres.containerId,
        runtimeReceipt.redis.containerId
    ].sort();
    if (network?.Id !== runtimeReceipt.network.id
        || network?.Name !== runtimeReceipt.network.name
        || JSON.stringify(members) !== JSON.stringify(expectedMembers))
    {
        throw new Error('dedicated runtime network topology drifted');
    }
    for (const relative of [
        runtimeReceipt.aotRoot,
        runtimeReceipt.searchRoot,
        runtimeReceipt.hotReadRoot,
        runtimeReceipt.dataRoot
    ])
    {
        const target = path.resolve(resolvedRoot, relative);
        if (!target.startsWith(`${resolvedRoot}${path.sep}`)
            || !fs.existsSync(target)
            || !fs.lstatSync(target).isDirectory()
            || fs.lstatSync(target).isSymbolicLink())
        {
            throw new Error('dedicated runtime root is missing or unsafe');
        }
    }
    const response = await fetchImpl(
        `${runtimeReceipt.backend.baseUrl.replace(/\/$/u, '')}/health/ready`,
        {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(3_000)
        }
    );
    const readiness = response.ok ? await response.json() : null;
    if (!response.ok || readiness?.status !== 'ready')
    {
        throw new Error('dedicated runtime readiness is no longer complete');
    }
    return Object.freeze({ status: 'ready', members });
}

export async function teardownDataScaleRuntime({
    repositoryRoot,
    plan,
    runtimeReceipt,
    execute = spawnSync,
    now = () => new Date().toISOString()
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    plan = validateDataScaleRuntimePlan(resolvedRoot, plan);
    verifyOwnerMarker(resolvedRoot, plan);
    if (runtimeReceipt !== null
        && (runtimeReceipt.contentDigest !== digestValue(runtimeReceipt)
            || runtimeReceipt.dataScaleRunId !== plan.dataScaleRunId
            || runtimeReceipt.parentSchedulerRunId !== plan.parentSchedulerRunId
            || runtimeReceipt.invocationId !== plan.invocationId
            || runtimeReceipt.attemptId !== plan.attemptId
            || runtimeReceipt.sourceCommit !== plan.sourceCommit
            || runtimeReceipt.buildReceiptDigest !== plan.buildReceiptDigest
            || runtimeReceipt.imageDigest !== plan.imageDigest
            || runtimeReceipt.backend?.executableOrImageDigest !== plan.imageDigest
            || runtimeReceipt.network?.name !== plan.resources.networkName
            || runtimeReceipt.postgres?.volumeId
                !== plan.resources.postgresVolumeName
            || runtimeReceipt.redis?.volumeId !== plan.resources.redisVolumeName))
    {
        throw new Error('data-scale runtime receipt does not bind the validated plan');
    }
    const commandOptions = { repositoryRoot: resolvedRoot, execute };
    const startedAt = now();
    const failures = [];
    const targets = [
        ['container', plan.resources.permissionHelperContainerName],
        ['container', plan.resources.backendContainerName],
        ['container', plan.resources.postgresContainerName],
        ['container', plan.resources.redisContainerName],
        ['network', plan.resources.networkName],
        ['volume', plan.resources.postgresVolumeName],
        ['volume', plan.resources.redisVolumeName]
    ];
    const observations = [];
    for (const [kind, id] of targets)
    {
        let owned = false;
        let actionExit = 0;
        let exists = true;
        try
        {
            const inspectArgs = kind === 'network'
                ? ['network', 'inspect', id]
                : kind === 'volume'
                    ? ['volume', 'inspect', id]
                    : ['inspect', id];
            const documents = JSON.parse(run('docker', inspectArgs, commandOptions) || '[]');
            owned = documents.length === 1 && ownedBinding(documents[0], plan);
            if (!owned)
            {
                throw new Error(`refusing to remove unowned ${kind}: ${id}`);
            }
            run('docker', kind === 'network'
                ? ['network', 'rm', id]
                : kind === 'volume'
                    ? ['volume', 'rm', id]
                    : ['rm', '-f', '-v', id], commandOptions);
            try
            {
                run('docker', inspectArgs, commandOptions);
            }
            catch
            {
                exists = false;
            }
        }
        catch (error)
        {
            if (kind === 'container'
                && id === plan.resources.permissionHelperContainerName)
            {
                try
                {
                    const residue = run('docker', [
                        'ps', '-aq', '--no-trunc',
                        '--filter', `name=^/${id}$`
                    ], commandOptions);
                    if (!residue)
                    {
                        owned = true;
                        exists = false;
                    }
                    else
                    {
                        throw error;
                    }
                }
                catch (nested)
                {
                    actionExit = 1;
                    failures.push(nested instanceof Error
                        ? nested.message
                        : String(nested));
                }
            }
            else
            {
                actionExit = 1;
                failures.push(error instanceof Error ? error.message : String(error));
            }
        }
        observations.push({
            plannedId: id,
            observedId: id,
            ownershipStatus: owned ? 'owned' : 'unknown',
            action: `remove-${kind}`,
            actionExit,
            postExists: exists
        });
    }
    const ownedRuntimeRoot = runtimeRoot(resolvedRoot, plan);
    fs.rmSync(ownedRuntimeRoot, { recursive: true, force: true });
    const port = runtimeReceipt
        ? Number(new URL(runtimeReceipt.backend.baseUrl).port)
        : 1;
    let postListeningPids = [];
    try
    {
        const sockets = run('ss', [
            '-H', '-ltnp', `( sport = :${port} )`
        ], commandOptions);
        postListeningPids = [...sockets.matchAll(/pid=(\d+)/gu)]
            .map((match) => Number(match[1]));
    }
    catch (error)
    {
        failures.push(error instanceof Error ? error.message : String(error));
        postListeningPids = [-1];
    }
    const receipt = createDataScaleTeardownReceipt({
        plan,
        runtimeReceiptDigest: runtimeReceipt
            ? runtimeReceipt.contentDigest
            : `sha256:${'0'.repeat(64)}`,
        startedAt,
        finishedAt: now(),
        resourceObservations: observations,
        portObservations: [{ port, postListeningPids }],
        rootObservations: Object.values(plan.roots).map((relative) => ({
            path: relative,
            postExists: fs.existsSync(path.join(resolvedRoot, relative))
        })),
        leaseObservations: [{ id: plan.dataScaleRunId, postStatus: 'released' }],
        failures
    });
    const files = ownerFiles(resolvedRoot, plan);
    writeJsonAtomic(files.teardown, receipt);
    return { receipt, receiptPath: relativeTo(resolvedRoot, files.teardown) };
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain)
{
    const [operation, ...argumentsList] = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < argumentsList.length; index += 2)
    {
        const name = argumentsList[index];
        const value = argumentsList[index + 1];
        if (!name?.startsWith('--') || value === undefined)
        {
            throw new Error('data-scale runtime owner arguments must be name/value pairs');
        }
        options[name.slice(2)] = value;
    }
    const repositoryRoot = path.resolve(options.root ?? path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../..'
    ));
    const readDocument = (configured, label) =>
    {
        if (!configured)
        {
            throw new Error(`${label} path is required`);
        }
        const target = path.resolve(repositoryRoot, configured);
        if (!target.startsWith(`${repositoryRoot}${path.sep}`)
            || !fs.existsSync(target)
            || !fs.lstatSync(target).isFile()
            || fs.lstatSync(target).isSymbolicLink())
        {
            throw new Error(`${label} path is unsafe or unavailable`);
        }
        return JSON.parse(fs.readFileSync(target, 'utf8'));
    };
    const execute = operation === 'provision'
        ? provisionDataScaleRuntime({
            repositoryRoot,
            identity: readDocument(options.identity, 'identity'),
            environment: process.env
        })
        : operation === 'teardown'
            ? teardownDataScaleRuntime({
                repositoryRoot,
                plan: validateDataScaleRuntimePlan(
                    repositoryRoot,
                    readDocument(options.plan, 'plan')
                ),
                runtimeReceipt: readDocument(options.runtime, 'runtime receipt')
            })
            : Promise.reject(new Error(
                'data-scale runtime owner operation must be provision or teardown'
            ));
    execute.then((result) =>
    {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.receipt?.status === 'blocked')
        {
            process.exitCode = 1;
        }
    }).catch((error) =>
    {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
