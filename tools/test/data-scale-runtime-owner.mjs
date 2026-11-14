#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createDataScaleRuntimeAdmission } from './data-scale-runtime-admission.mjs';
import {
    digestValue,
    sealDocument
} from './release-reliability-receipt.mjs';

// Capabilities stay inside the scheduler process; serialized evidence is not authority.
const activeAdmissions = new Map();

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

function sha256Text(value)
{
    return createHash('sha256').update(String(value)).digest('hex');
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

function resourceExists(kind, name, options)
{
    const args = kind === 'container'
        ? ['ps', '-a', '--format', '{{.Names}}']
        : [kind, 'ls', '--format', '{{.Name}}'];
    return run('docker', args, options).split(/\r?\n/u)
        .some((entry) => entry.trim() === name);
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

function connectionClientName(dataScaleRunId)
{
    return `FsusBlogDataScale-${requireIdentifier(
        dataScaleRunId,
        'dataScaleRunId'
    )}`;
}

function containerEnvironment(container)
{
    const result = new Map();
    for (const entry of container?.Config?.Env ?? [])
    {
        const separator = String(entry).indexOf('=');
        const key = separator < 0 ? String(entry) : String(entry).slice(0, separator);
        if (!key || result.has(key))
        {
            throw new Error('dedicated backend environment is ambiguous');
        }
        result.set(key, separator < 0 ? '' : String(entry).slice(separator + 1));
    }
    return result;
}

function parseConnectionCounts(value, label)
{
    const match = String(value).match(/^(\d+)\|(\d+)$/u);
    const matchingClientCount = Number(match?.[1]);
    const foreignClientCount = Number(match?.[2]);
    if (!Number.isSafeInteger(matchingClientCount) || matchingClientCount < 1
        || foreignClientCount !== 0)
    {
        throw new Error(`${label} does not bind the dedicated backend`);
    }
    return { matchingClientCount, foreignClientCount };
}

function redisClientFields(line)
{
    return Object.fromEntries(String(line).trim().split(/\s+/u).map((entry) =>
    {
        const separator = entry.indexOf('=');
        return separator < 1
            ? [entry, '']
            : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
}

function escapeRegExp(value)
{
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function observeBackendConnections({
    dataScaleRunId,
    networkId,
    networkName,
    database,
    backend,
    postgresContainerId,
    redisContainerId,
    options
})
{
    const clientName = connectionClientName(dataScaleRunId);
    const backendNetwork = backend.NetworkSettings?.Networks?.[networkName];
    const backendAddress = String(backendNetwork?.IPAddress ?? '');
    if (backendNetwork?.NetworkID !== networkId
        || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(backendAddress))
    {
        throw new Error('dedicated backend network address is unavailable');
    }
    const expectedPostgres = `Host=postgres;Port=5432;Database=${database};Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true;Application Name=${clientName}`;
    const expectedRedis = `redis:6379,abortConnect=false,connectTimeout=10000,name=${clientName}`;
    const environment = containerEnvironment(backend);
    if (environment.get('ConnectionStrings__DefaultConnection')
            !== expectedPostgres
        || environment.get('ConnectionStrings__Redis') !== expectedRedis
        || environment.get('RedisOptions__Configuration') !== expectedRedis)
    {
        throw new Error('dedicated backend dependency configuration drifted');
    }

    const postgresCounts = parseConnectionCounts(run('docker', [
        'exec', postgresContainerId,
        'psql', '--no-psqlrc', '--tuples-only', '--no-align',
        '--username', 'fsusblog', '--dbname', database,
        '--set', `application_name=${clientName}`,
        '--set', `backend_address=${backendAddress}`,
        '--command',
        "SELECT count(*) FILTER (WHERE datname = current_database() AND host(client_addr) = :'backend_address')::text || '|' || count(*) FILTER (WHERE datname IS DISTINCT FROM current_database() OR host(client_addr) IS DISTINCT FROM :'backend_address')::text FROM pg_stat_activity WHERE backend_type = 'client backend' AND application_name = :'application_name';"
    ], options), 'dedicated PostgreSQL connection identity');

    const redisNamePattern = new RegExp(
        `^${escapeRegExp(clientName)}(?:\\(SE\\.Redis-v\\d+(?:\\.\\d+)+\\))?$`,
        'u'
    );
    const redisClients = run('docker', [
        'exec', redisContainerId,
        'redis-cli', '--raw', 'CLIENT', 'LIST', 'TYPE', 'normal'
    ], options).split(/\r?\n/u).filter(Boolean).map(redisClientFields);
    const matchingRedisClients = redisClients.filter((client) =>
        redisNamePattern.test(String(client.name ?? '')));
    const redisCounts = parseConnectionCounts(
        `${matchingRedisClients.filter((client) =>
            String(client.addr ?? '').startsWith(`${backendAddress}:`)).length}|${matchingRedisClients.filter((client) =>
            !String(client.addr ?? '').startsWith(`${backendAddress}:`)).length}`,
        'dedicated Redis connection identity'
    );
    return {
        postgres: {
            applicationName: clientName,
            backendAddress,
            database,
            ...postgresCounts
        },
        redis: {
            clientName,
            backendAddress,
            ...redisCounts
        }
    };
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
    connections,
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
    const expectedClientName = connectionClientName(plan.dataScaleRunId);
    if (JSON.stringify(Object.keys(connections ?? {}).sort())
            !== JSON.stringify(['postgres', 'redis'])
        || JSON.stringify(Object.keys(connections?.postgres ?? {}).sort())
            !== JSON.stringify([
                'applicationName', 'backendAddress', 'database',
                'foreignClientCount', 'matchingClientCount'
            ])
        || JSON.stringify(Object.keys(connections?.redis ?? {}).sort())
            !== JSON.stringify([
                'backendAddress', 'clientName', 'foreignClientCount',
                'matchingClientCount'
            ]))
    {
        throw new Error('runtime dependency connection identity shape is invalid');
    }
    for (const [connection, expected] of [
        [connections?.postgres, {
            applicationName: expectedClientName,
            database: postgres.database
        }],
        [connections?.redis, { clientName: expectedClientName }]
    ])
    {
        if (!connection
            || Object.entries(expected).some(([key, value]) =>
                connection[key] !== value)
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(
                String(connection.backendAddress ?? '')
            )
            || !Number.isSafeInteger(connection.matchingClientCount)
            || connection.matchingClientCount < 1
            || connection.foreignClientCount !== 0)
        {
            throw new Error('runtime dependency connection identity is incomplete');
        }
    }
    if (connections.postgres.backendAddress !== connections.redis.backendAddress)
    {
        throw new Error('runtime dependency connection address is inconsistent');
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
        connections,
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
            status: observation?.postExists === false
                && observation.ownershipStatus === 'owned'
                && observation.actionExit === 0
                && typeof observation.observedId === 'string' && observation.observedId.length > 0
                && typeof observation.action === 'string' && observation.action.length > 0
                ? 'complete' : 'failed',
            postObservation: { exists: observation?.postExists ?? true }
        };
    });
    const roots = Object.values(plan.roots).map((rootPath) => ({
        path: rootPath,
        postExists: rootObservations.find((item) => item.path === rootPath)?.postExists ?? true
    }));
    const exactResourceRoster = resourceObservations.length === resources.length
        && new Set(resourceObservations.map((item) => item.plannedId)).size === resources.length
        && resourceObservations.every((item) => resources.some((resource) => resource.plannedId === item.plannedId));
    const exactRootRoster = rootObservations.length === roots.length
        && new Set(rootObservations.map((item) => item.path)).size === roots.length
        && rootObservations.every((item) => roots.some((root) => root.path === item.path));
    const distinctPorts = new Set(portObservations.map((item) => item.port)).size === portObservations.length;
    const distinctLeases = new Set(leaseObservations.map((item) => item.id)).size === leaseObservations.length;
    const receipt = {
        schema: DATA_SCALE_TEARDOWN_SCHEMA,
        status: failures.length === 0
            && exactResourceRoster && exactRootRoster && distinctPorts && distinctLeases
            && resources.every((item) => item.status === 'complete')
            && portObservations.every((item) => Number.isInteger(item.port) && item.port > 0 && item.port <= 65535
                && Array.isArray(item.postListeningPids) && item.postListeningPids.length === 0)
            && roots.every((item) => item.postExists === false)
            && leaseObservations.length > 0
            && leaseObservations.every((item) => typeof item.id === 'string' && item.id.length > 0
                && item.postStatus === 'released')
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
    const fixturePostgresImageDigest = String(
        identity.fixture.topology?.content?.postgres?.imageId ?? ''
    ).trim();
    const fixtureRedisImageDigest = String(
        identity.fixture.topology?.content?.redis?.imageId ?? ''
    ).trim();
    const envFile = path.resolve(
        repositoryRoot,
        String(environment.FSUSBLOG_TEST_FIXTURE_CONFIG ?? '')
    );
    const buildRoot = path.resolve(
        repositoryRoot,
        String(environment.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '')
    );
    const configuredCandidateAssembly = path.resolve(
        repositoryRoot,
        String(environment.FSUSBLOG_BACKEND_SERVER_DLL ?? '')
    );
    const canonicalBuildRoot = fs.existsSync(buildRoot)
        ? fs.realpathSync(buildRoot)
        : buildRoot;
    const candidateAssembly = fs.existsSync(configuredCandidateAssembly)
        ? fs.realpathSync(configuredCandidateAssembly)
        : configuredCandidateAssembly;
    const candidateRelative = path.relative(
        canonicalBuildRoot,
        candidateAssembly
    );
    const serviceCatalog = path.join(
        repositoryRoot,
        'config/testing/test-execution-service-catalog.json'
    );
    let serviceImages = null;
    try
    {
        const catalog = JSON.parse(fs.readFileSync(serviceCatalog, 'utf8'));
        serviceImages = {
            postgres: String(catalog.services?.postgres?.imageReference ?? ''),
            redis: String(catalog.services?.redis?.imageReference ?? '')
        };
    }
    catch
    {
        // The single validation failure below keeps malformed catalog details private.
    }
    if (!runtimeImageReference
        || !digestPattern.test(fixturePostgresImageDigest)
        || !digestPattern.test(fixtureRedisImageDigest)
        || !fs.existsSync(envFile)
        || !fs.lstatSync(envFile).isFile()
        || !String(environment.FSUSBLOG_PRODUCTION_BUILD_ROOT ?? '').trim()
        || !String(environment.FSUSBLOG_BACKEND_SERVER_DLL ?? '').trim()
        || !fs.existsSync(canonicalBuildRoot)
        || !fs.lstatSync(canonicalBuildRoot).isDirectory()
        || path.isAbsolute(candidateRelative)
        || candidateRelative.split(path.sep).includes('..')
        || !fs.existsSync(candidateAssembly)
        || !fs.lstatSync(candidateAssembly).isFile()
        || !fs.existsSync(serviceCatalog)
        || !fs.lstatSync(serviceCatalog).isFile()
        || fs.lstatSync(serviceCatalog).isSymbolicLink()
        || !serviceImages
        || !/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/u.test(serviceImages.postgres)
        || !/^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/u.test(serviceImages.redis))
    {
        throw new Error('source-bound runtime, candidate assembly, service catalog, and fixture environment are required');
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
        fixturePostgresImageDigest,
        fixtureRedisImageDigest,
        postgresImageReference: serviceImages.postgres,
        redisImageReference: serviceImages.redis,
        candidateAssembly,
        serviceCatalog,
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
    requireDirectoryAncestry(repositoryRoot, directory);
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
    requireDirectoryAncestry(resolvedRoot, target);
    return target;
}

function requireDirectoryAncestry(repositoryRoot, directory)
{
    const root = path.resolve(repositoryRoot);
    const relative = path.relative(root, directory);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..'))
    {
        throw new Error('data-scale owner directory escapes repository');
    }
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean))
    {
        current = path.join(current, segment);
        const metadata = fs.lstatSync(current, { throwIfNoEntry: false });
        if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink()))
        {
            throw new Error('data-scale owner directory ancestry is unsafe');
        }
    }
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

async function delegatedOwnerResult({ operation, repositoryRoot, identity, environment })
{
    const { delegateDataScaleRuntimeOperation } = await import('./data-scale-runtime-caller.mjs');
    const snapshot = await delegateDataScaleRuntimeOperation({
        operation, repositoryRoot, identity,
        environment: Object.fromEntries(['FSUSBLOG_DATA_SCALE_CALLER_JOURNAL',
            'FSUSBLOG_RELEASE_RELIABILITY_RUN_ID', 'FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID',
            'FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID'].map((key) => [key, environment[key]]))
    });
    const documents = {};
    for (const kind of operation === 'provision' ? ['plan', 'receipt'] : ['receipt'])
    {
        const relative = snapshot[`${kind}Path`];
        const resolved = path.resolve(repositoryRoot, relative);
        const ownerDirectory = path.join(repositoryRoot, '.tmp/release-reliability', identity.invocationId, 'data-scale-owner');
        requireDirectoryAncestry(repositoryRoot, ownerDirectory);
        if (path.dirname(resolved) !== ownerDirectory
            || !fs.lstatSync(resolved).isFile() || fs.lstatSync(resolved).isSymbolicLink())
        {
            throw new Error('delegated data-scale owner locator is unsafe');
        }
        const bytes = fs.readFileSync(resolved);
        if (rawDigest(bytes) !== snapshot[`${kind}BytesDigest`])
        {
            throw new Error('delegated data-scale owner bytes changed');
        }
        const document = JSON.parse(bytes);
        if (document.contentDigest !== digestValue(document)
            || document.parentSchedulerRunId !== identity.runId
            || document.invocationId !== identity.invocationId
            || document.attemptId !== environment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID
            || document.sourceCommit !== identity.sourceState.commit
            || (kind === 'plan' && document.worktreeFingerprint !== identity.sourceState.worktreeFingerprint))
        {
            throw new Error('delegated data-scale owner identity changed');
        }
        if (kind === 'plan')
        {
            validateDataScaleRuntimePlan(repositoryRoot, document);
        }
        else if (document.schema !== (operation === 'provision' ? DATA_SCALE_RUNTIME_SCHEMA : DATA_SCALE_TEARDOWN_SCHEMA))
        {
            throw new Error('delegated data-scale owner receipt schema is invalid');
        }
        const suffix = kind === 'plan' ? 'plan' : operation === 'provision' ? 'runtime' : 'teardown';
        if (path.basename(resolved) !== `${document.dataScaleRunId}.${suffix}.json`)
        {
            throw new Error('delegated data-scale owner locator does not bind the actual run');
        }
        documents[kind] = document;
    }
    return { ...snapshot, ...documents };
}

export async function provisionDataScaleRuntime({
    repositoryRoot,
    identity,
    environment,
    runtimeAdmission,
    onPlan,
    createAdmission = createDataScaleRuntimeAdmission,
    execute = spawnSync,
    fetchImpl = fetch,
    wait,
    now = () => new Date().toISOString()
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    if (runtimeAdmission === undefined && environment?.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL)
    {
        return delegatedOwnerResult({
            operation: 'provision', repositoryRoot: resolvedRoot, identity, environment
        });
    }
    const inputs = runtimeInputs(resolvedRoot, identity, environment);
    const commandOptions = { repositoryRoot: resolvedRoot, execute };
    const runtimeImage = inspectImage(inputs.runtimeImageReference, commandOptions);
    const postgresImage = inspectImage(inputs.postgresImageReference, commandOptions);
    const redisImage = inspectImage(inputs.redisImageReference, commandOptions);
    if (runtimeImage.Id !== identity.build?.imageDigest)
    {
        throw new Error('dedicated runtime image differs from the original build identity');
    }
    if (postgresImage.Id !== inputs.fixturePostgresImageDigest
        || redisImage.Id !== inputs.fixtureRedisImageDigest)
    {
        throw new Error('dedicated service image identity differs from the admitted fixture');
    }
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
    const ownedRuntimeRoot = runtimeRoot(resolvedRoot, plan);
    for (const target of [ownedRuntimeRoot, ...Object.values(files)])
    {
        if (fs.lstatSync(target, { throwIfNoEntry: false }))
        {
            throw new Error('data-scale attempt already has owner state');
        }
    }
    for (const [key, name] of Object.entries(plan.resources))
    {
        const kind = key.endsWith('ContainerName') ? 'container'
            : key.endsWith('VolumeName') ? 'volume' : 'network';
        if (resourceExists(kind, name, commandOptions))
        {
            throw new Error('data-scale attempt already has runtime resources');
        }
    }
    const admission = await createAdmission({
        ...runtimeAdmission, repositoryRoot: resolvedRoot, plan, execute
    });
    activeAdmissions.set(plan.contentDigest, admission);
    try
    {
        fs.mkdirSync(path.dirname(ownedRuntimeRoot), { recursive: true, mode: 0o700 });
        fs.mkdirSync(ownedRuntimeRoot, { mode: 0o700 });
        writeJsonAtomic(files.plan, plan);
        writeJsonAtomic(ownerMarker(resolvedRoot, plan), sealDocument({
            schema: 'fsusblog.data-scale-runtime-owner-marker.v1',
            dataScaleRunId: plan.dataScaleRunId,
            planDigest: plan.contentDigest
        }));
    }
    catch (error)
    {
        fs.rmSync(files.plan, { force: true });
        fs.rmSync(ownedRuntimeRoot, { recursive: true, force: true });
        const released = await admission.release({ cleanup: { status: 'complete' } });
        if (released.status === 'complete')
        {
            activeAdmissions.delete(plan.contentDigest);
        }
        else
        {
            throw new AggregateError([error, new Error(released.failures.join('; '))],
                'data-scale owner setup and admission cleanup failed', { cause: error });
        }
        throw error;
    }
    const labels = [...ownerLabels(plan), ...admission.labels()];
    try
    {
        await onPlan?.({ plan, planPath: relativeTo(resolvedRoot, files.plan) });
        for (const relative of Object.values(plan.roots))
        {
            fs.mkdirSync(path.join(resolvedRoot, relative), { recursive: true, mode: 0o700 });
        }
        const runtimeUser = String(runtimeImage.Config?.User ?? '').trim();
        const match = runtimeUser.match(/^(\d+)(?::(\d+))?$/u);
        if (!match)
        {
            throw new Error('runtime image must declare a numeric UID/GID');
        }
        const runtimeUid = match[1];
        const runtimeGid = String(process.getgid?.() ?? match[2] ?? match[1]);
        run('docker', [
            'run', '--rm', '--pull', 'never', '--name', plan.resources.permissionHelperContainerName,
            '--user', '0', '--entrypoint', '/bin/sh',
            ...labels, ...admission.labels('permission-helper'),
            ...admission.dockerArguments('debug-backend'),
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
            'network', 'create', '--driver', 'bridge', ...labels, ...admission.labels('network'),
            plan.resources.networkName
        ], commandOptions);
        for (const volume of [
            plan.resources.postgresVolumeName,
            plan.resources.redisVolumeName
        ])
        {
            run('docker', ['volume', 'create', ...labels, ...admission.labels('volume'), volume], commandOptions);
        }
        await admission.beginHandoff('postgres');
        const postgresId = run('docker', [
            'run', '-d', '--name', plan.resources.postgresContainerName,
            '--network', plan.resources.networkName, '--network-alias', 'postgres',
            '-p', `127.0.0.1:${admission.port('postgres')}:5432`,
            '--pull', 'never',
            ...labels, ...admission.labels('postgres'),
            ...admission.dockerArguments('postgres'),
            '-e', 'POSTGRES_USER=fsusblog',
            '-e', 'POSTGRES_PASSWORD=fsusblog_dev',
            '-e', 'POSTGRES_DB=fsusblog',
            '-v', `${plan.resources.postgresVolumeName}:/var/lib/postgresql/data`,
            inputs.postgresImageReference
        ], commandOptions);
        await admission.completeHandoff('postgres', postgresId);
        await admission.beginHandoff('redis');
        const redisId = run('docker', [
            'run', '-d', '--name', plan.resources.redisContainerName,
            '--network', plan.resources.networkName, '--network-alias', 'redis',
            '-p', `127.0.0.1:${admission.port('redis')}:6379`,
            '--pull', 'never',
            ...labels, ...admission.labels('redis'),
            ...admission.dockerArguments('redis'),
            '-v', `${plan.resources.redisVolumeName}:/data`,
            inputs.redisImageReference
        ], commandOptions);
        await admission.completeHandoff('redis', redisId);
        await waitUntilReady(() => run('docker', [
            'exec', postgresId, 'pg_isready', '-U', 'fsusblog', '-d', 'fsusblog'
        ], commandOptions), { wait });
        const seedRoot = path.join(resolvedRoot, plan.roots.dataRoot);
        const postgres = inspectOne(postgresId, commandOptions);
        const postgresBindings = postgres.NetworkSettings?.Ports?.['5432/tcp'];
        const postgresHostPort = Number(postgresBindings?.[0]?.HostPort);
        if (!Number.isInteger(postgresHostPort) || postgresHostPort !== admission.port('postgres')
            || !Array.isArray(postgresBindings)
            || postgresBindings.length !== 1
            || postgresBindings[0].HostIp !== '127.0.0.1')
        {
            throw new Error('dedicated PostgreSQL loopback binding is unavailable');
        }
        if (resourceExists(
            'container',
            plan.resources.backendContainerName,
            commandOptions
        ))
        {
            throw new Error('dedicated backend must be absent before schema and seed');
        }
        const schemaRunId = `${plan.dataScaleRunId}-schema`;
        const serviceEnvelope = path.join(seedRoot, 'current-schema-services.json');
        const schemaReceipt = path.join(
            seedRoot,
            `current-schema-test-materialization-${sha256Text(schemaRunId)}.json`
        );
        const schemaReadyReceipt = path.join(
            seedRoot,
            `current-schema-runtime-ready-${sha256Text(schemaRunId)}.json`
        );
        const connectionString = `Host=127.0.0.1;Port=${postgresHostPort};Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true;Search Path=public`;
        const envelopeTool = path.join(
            resolvedRoot,
            'tools/test/execution-envelope-services.mjs'
        );
        const schemaReceiptVerifier = path.join(
            resolvedRoot,
            'tools/db/verify-current-schema-test-materialization-receipt.mjs'
        );
        run(process.execPath, [
            envelopeTool,
            '--producer-id', 'data-scale-runtime-owner',
            '--run-id', schemaRunId,
            '--required-services', 'postgres',
            '--postgres-container', plan.resources.postgresContainerName,
            '--service-catalog', inputs.serviceCatalog,
            '--output', serviceEnvelope
        ], commandOptions);
        run(process.execPath, [
            envelopeTool,
            '--verify-envelope', serviceEnvelope,
            '--service-catalog', inputs.serviceCatalog
        ], commandOptions);
        run('dotnet', [
            inputs.candidateAssembly,
            'materialize-current-schema-test',
            '--run-id', schemaRunId,
            '--source-commit', plan.sourceCommit,
            '--service-envelope', serviceEnvelope,
            '--service-catalog', inputs.serviceCatalog
        ], {
            ...commandOptions,
            environment: {
                ...environment,
                ASPNETCORE_ENVIRONMENT: 'Test',
                FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION: '1',
                FSUSBLOG_CURRENT_SCHEMA_TEST_RECEIPT_ROOT: seedRoot,
                ConnectionStrings__DefaultConnection: connectionString
            }
        });
        run(process.execPath, [
            schemaReceiptVerifier,
            '--receipt-root', seedRoot,
            '--run-id', schemaRunId,
            '--source-commit', plan.sourceCommit,
            '--assembly', inputs.candidateAssembly,
            '--service-catalog', inputs.serviceCatalog,
            '--service-envelope', serviceEnvelope
        ], {
            ...commandOptions,
            environment: {
                ...environment,
                ConnectionStrings__DefaultConnection: connectionString
            }
        });
        for (const [file, expectedSchema] of [
            [schemaReceipt, 'fsusblog.current-schema-test-materialization-receipt.v1'],
            [schemaReadyReceipt, 'fsusblog.current-schema-runtime-ready.v1']
        ])
        {
            const document = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (document.schema !== expectedSchema || document.status !== 'verified'
                || document.qualificationEligible !== true
                || document.runId !== schemaRunId
                || document.sourceCommit !== plan.sourceCommit)
            {
                throw new Error('dedicated current-schema evidence is invalid');
            }
        }
        if (resourceExists(
            'container',
            plan.resources.backendContainerName,
            commandOptions
        ))
        {
            throw new Error('dedicated backend started before offline seed');
        }
        const unknownConnections = run('docker', [
            'exec', postgresId,
            'psql', '--no-psqlrc', '--tuples-only', '--no-align',
            '--username', 'fsusblog', '--dbname', 'fsusblog', '--command',
            "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid();"
        ], commandOptions);
        if (unknownConnections !== '0')
        {
            throw new Error('dedicated PostgreSQL has an unknown client connection before seed');
        }
        const redisDatabaseSize = run('docker', [
            'exec', redisId, 'redis-cli', '--raw', 'DBSIZE'
        ], commandOptions);
        if (redisDatabaseSize !== '0')
        {
            throw new Error('dedicated Redis is not pristine before backend start');
        }
        run(path.join(resolvedRoot, 'tools/data-scale/seed.sh'), ['scale-m'], {
            ...commandOptions,
            environment: {
                ...environment,
                FSUSBLOG_POSTGRES_CONTAINER_NAME: postgresId,
                FSUSBLOG_REDIS_CONTAINER_NAME: redisId,
                FSUSBLOG_DATA_SCALE_BACKEND_CONTAINER_NAME:
                    plan.resources.backendContainerName,
                FSUSBLOG_DATA_SCALE_REQUIRE_EMPTY: '1',
                FSUSBLOG_TEST_NAMESPACE: plan.namespace,
                FSUSBLOG_DATA_SCALE_OUT_DIR: seedRoot
            }
        });
        const seedFile = path.join(seedRoot, 'seed.json');
        const seedDocument = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        const envManifest = path.join(seedRoot, 'runtime-environment.json');
        writeJsonAtomic(envManifest, sealDocument({
            schema: 'fsusblog.data-scale-runtime-environment.v1',
            dataScaleRunId: plan.dataScaleRunId,
            sourceCommit: plan.sourceCommit,
            buildReceiptDigest: plan.buildReceiptDigest,
            imageDigest: plan.imageDigest,
            database: {
                host: '127.0.0.1',
                port: postgresHostPort,
                name: 'fsusblog',
                username: 'fsusblog',
                containerId: postgresId
            },
            redis: { containerId: redisId },
            roots: plan.roots,
            candidateAssemblyDigest: rawDigest(
                fs.readFileSync(inputs.candidateAssembly)
            ),
            serviceCatalogDigest: rawDigest(
                fs.readFileSync(inputs.serviceCatalog)
            ),
            serviceEnvelopeDigest: rawDigest(fs.readFileSync(serviceEnvelope)),
            schemaReceiptDigest: rawDigest(fs.readFileSync(schemaReceipt)),
            schemaReadyReceiptDigest: rawDigest(
                fs.readFileSync(schemaReadyReceipt)
            )
        }));
        const clientName = connectionClientName(plan.dataScaleRunId);
        const backendPostgresConnection = `Host=postgres;Port=5432;Database=fsusblog;Username=fsusblog;Password=fsusblog_dev;Include Error Detail=true;Application Name=${clientName}`;
        const backendRedisConnection = `redis:6379,abortConnect=false,connectTimeout=10000,name=${clientName}`;
        await admission.beginHandoff('debug-backend');
        const backendId = run('docker', [
            'run', '-d', '--name', plan.resources.backendContainerName,
            '--network', plan.resources.networkName,
            '-p', `127.0.0.1:${admission.port('debug-backend')}:8080`, '--env-file', inputs.envFile,
            ...labels, ...admission.labels('debug-backend'),
            ...admission.dockerArguments('debug-backend'),
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
            '-e', `ConnectionStrings__DefaultConnection=${backendPostgresConnection}`,
            '-e', `ConnectionStrings__Redis=${backendRedisConnection}`,
            '-e', `RedisOptions__Configuration=${backendRedisConnection}`,
            '-e', `FSUSBLOG_TEST_RUN_ID=${plan.dataScaleRunId}`,
            '-e', `FSUSBLOG_TEST_NAMESPACE=${plan.namespace}`,
            '-e', 'FSUSBLOG_RUNTIME_ROLE=backend',
            '-e', `FSUSBLOG_TEST_SOURCE_COMMIT=${plan.sourceCommit}`,
            '-e', `FSUSBLOG_TEST_SOURCE_FINGERPRINT=${plan.worktreeFingerprint}`,
            runtimeImage.Id
        ], commandOptions);
        await admission.completeHandoff('debug-backend', backendId);
        const backend = inspectOne(backendId, commandOptions);
        const hostPort = Number(
            backend.NetworkSettings?.Ports?.['8080/tcp']?.[0]?.HostPort
        );
        if (!Number.isInteger(hostPort) || hostPort !== admission.port('debug-backend')
            || backend.NetworkSettings?.Ports?.['8080/tcp']?.length !== 1
            || backend.NetworkSettings.Ports['8080/tcp'][0].HostIp !== '127.0.0.1')
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
        const connections = await waitUntilReady(() =>
            observeBackendConnections({
                dataScaleRunId: plan.dataScaleRunId,
                networkId,
                networkName: plan.resources.networkName,
                database: 'fsusblog',
                backend,
                postgresContainerId: postgresId,
                redisContainerId: redisId,
                options: commandOptions
            }), { wait });
        await admission.publishResident({ services: [
            { role: 'postgres', containerId: postgresId, health: { status: 'ready', checkedAt: now() } },
            { role: 'redis', containerId: redisId, health: { status: 'ready', checkedAt: now() } },
            { role: 'debug-backend', containerId: backendId, health: { status: 'ready', checkedAt: now() } }
        ] });
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
            connections,
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
            envManifestDigest: rawDigest(fs.readFileSync(envManifest)),
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
        try
        {
            const cleanup = await teardownDataScaleRuntime({
                repositoryRoot: resolvedRoot,
                plan,
                runtimeReceipt: null,
                execute,
                now
            });
            if (cleanup.receipt.status !== 'complete')
            {
                throw new Error('data-scale runtime cleanup remains incomplete', { cause: error });
            }
            if (error instanceof Error)
            {
                Object.defineProperty(error, 'dataScaleCleanup', { value: cleanup });
            }
        }
        catch (cleanupError)
        {
            throw new AggregateError([error, cleanupError],
                error instanceof Error ? error.message : 'data-scale runtime provision failed', { cause: cleanupError });
        }
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
    const connections = observeBackendConnections({
        dataScaleRunId: runtimeReceipt.dataScaleRunId,
        networkId: runtimeReceipt.network.id,
        networkName: runtimeReceipt.network.name,
        database: runtimeReceipt.postgres.database,
        backend,
        postgresContainerId: runtimeReceipt.postgres.containerId,
        redisContainerId: runtimeReceipt.redis.containerId,
        options
    });
    for (const kind of ['postgres', 'redis'])
    {
        const expected = runtimeReceipt.connections?.[kind];
        const observed = connections[kind];
        const identityKeys = kind === 'postgres'
            ? ['applicationName', 'backendAddress', 'database']
            : ['clientName', 'backendAddress'];
        if (!expected || identityKeys.some((key) => expected[key] !== observed[key]))
        {
            throw new Error('dedicated runtime connection identity drifted');
        }
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
    return Object.freeze({ status: 'ready', members, connections });
}

export async function teardownDataScaleRuntime({
    repositoryRoot,
    plan,
    runtimeReceipt,
    identity,
    environment,
    execute = spawnSync,
    now = () => new Date().toISOString()
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    if (environment?.FSUSBLOG_DATA_SCALE_CALLER_JOURNAL && !activeAdmissions.has(plan.contentDigest))
    {
        return delegatedOwnerResult({
            operation: 'teardown', repositoryRoot: resolvedRoot, identity, environment
        });
    }
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
    const allocatedPorts = new Set(runtimeReceipt
        ? [Number(new URL(runtimeReceipt.backend.baseUrl).port)]
        : []);
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
        let observedId = id;
        let actionExit = 0;
        let exists = true;
        try
        {
            if (!resourceExists(kind, id, commandOptions))
            {
                observations.push({
                    plannedId: id,
                    observedId: id,
                    ownershipStatus: 'owned',
                    action: 'observe-absent',
                    actionExit: 0,
                    postExists: false
                });
                continue;
            }

            const inspectArgs = kind === 'network'
                ? ['network', 'inspect', id]
                : kind === 'volume'
                    ? ['volume', 'inspect', id]
                    : ['inspect', id];
            const documents = JSON.parse(run('docker', inspectArgs, commandOptions) || '[]');
            const admission = activeAdmissions.get(plan.contentDigest);
            owned = documents.length === 1 && ownedBinding(documents[0], plan)
                && admission?.owns(documents[0]) === true;
            if (!owned)
            {
                throw new Error(`refusing to remove unowned ${kind}: ${id}`);
            }
            observedId = kind === 'volume' ? documents[0].Name : documents[0].Id;
            if (kind === 'volume' ? observedId !== id : !/^[a-f0-9]{64}$/u.test(observedId ?? ''))
            {
                throw new Error(`data-scale ${kind} stable identity is unavailable: ${id}`);
            }
            const expectedId = runtimeReceipt && (id === plan.resources.backendContainerName
                ? runtimeReceipt.backend.pidOrContainerId
                : id === plan.resources.postgresContainerName ? runtimeReceipt.postgres.containerId
                    : id === plan.resources.redisContainerName ? runtimeReceipt.redis.containerId
                        : kind === 'network' ? runtimeReceipt.network.id : null);
            if (expectedId && observedId !== expectedId)
            {
                throw new Error(`data-scale ${kind} identity differs from the creation receipt: ${id}`);
            }
            if (kind === 'container')
            {
                for (const bindings of Object.values(documents[0].NetworkSettings?.Ports ?? {}))
                {
                    for (const binding of bindings ?? [])
                    {
                        const port = Number(binding.HostPort);
                        if (!Number.isInteger(port) || port < 1 || port > 65535)
                        {
                            throw new Error('data-scale runtime allocated port is invalid');
                        }
                        allocatedPorts.add(port);
                    }
                }
            }
            run('docker', kind === 'network'
                ? ['network', 'rm', observedId]
                : kind === 'volume'
                    ? ['volume', 'rm', observedId]
                    : ['rm', '-f', '-v', observedId], commandOptions);
            exists = resourceExists(kind, id, commandOptions);
        }
        catch (error)
        {
            actionExit = 1;
            failures.push(error instanceof Error ? error.message : String(error));
        }
        observations.push({
            plannedId: id,
            observedId,
            ownershipStatus: owned ? 'owned' : 'unknown',
            action: `remove-${kind}`,
            actionExit,
            postExists: exists
        });
    }
    const ownedRuntimeRoot = runtimeRoot(resolvedRoot, plan);
    const portObservations = [];
    for (const port of allocatedPorts)
    {
        let postListeningPids;
        try
        {
            const sockets = run('ss', [
                '-H', '-ltnp', `( sport = :${port} )`
            ], commandOptions);
            postListeningPids = [...sockets.matchAll(/pid=(\d+)/gu)]
                .map((match) => Number(match[1]));
            if (sockets && postListeningPids.length === 0)
            {
                throw new Error('data-scale port remains listening without observable owner');
            }
        }
        catch (error)
        {
            failures.push(error instanceof Error ? error.message : String(error));
            postListeningPids = [-1];
        }
        portObservations.push({ port, postListeningPids });
    }
    const admission = activeAdmissions.get(plan.contentDigest);
    let leaseObservations = [];
    const resourcesAbsent = failures.length === 0
        && observations.every((item) => item.postExists === false)
        && portObservations.every((item) => item.postListeningPids.length === 0);
    if (resourcesAbsent)
    {
        try
        {
            if (!admission)
            {
                throw new Error('data-scale teardown requires the original scheduler admission capability');
            }
            const released = await admission.release({
                cleanup: { status: 'complete' },
                removedContainerIds: observations.filter((item) => item.action === 'remove-container')
                    .map((item) => item.observedId)
            });
            leaseObservations = released.leaseObservations;
            failures.push(...released.failures);
        }
        catch (error)
        {
            failures.push(error instanceof Error ? error.message : String(error));
        }
    }
    if (failures.length === 0
        && observations.every((item) => item.postExists === false)
        && portObservations.every((item) => item.postListeningPids.length === 0))
    {
        try
        {
            fs.rmSync(ownedRuntimeRoot, { recursive: true, force: true });
        }
        catch (error)
        {
            failures.push(error instanceof Error ? error.message : String(error));
        }
    }
    const receipt = createDataScaleTeardownReceipt({
        plan,
        runtimeReceiptDigest: runtimeReceipt
            ? runtimeReceipt.contentDigest
            : `sha256:${'0'.repeat(64)}`,
        startedAt,
        finishedAt: now(),
        resourceObservations: observations,
        portObservations,
        rootObservations: Object.values(plan.roots).map((relative) => ({
            path: relative,
            postExists: fs.existsSync(path.join(resolvedRoot, relative))
        })),
        leaseObservations,
        failures
    });
    const files = ownerFiles(resolvedRoot, plan);
    writeJsonAtomic(files.teardown, receipt);
    if (receipt.status === 'complete')
    {
        activeAdmissions.delete(plan.contentDigest);
    }
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
