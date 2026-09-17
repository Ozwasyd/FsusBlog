#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_SCALE_RUNTIME_SCHEMA = 'fsusblog.data-scale-runtime.v1';
export const DATA_SCALE_SEED_RECEIPT_SCHEMA = 'fsusblog.data-scale-seed-receipt.v1';

export const FORBIDDEN_CONTAINER_PATTERNS = Object.freeze([
    /^fsusblog-dev-postgres$/u,
    /^fsusblog-dev-redis$/u,
    /^fsusblog-dev-/u,
    /^fsusblog-test-postgres-/u,
    /^fsusblog-test-redis-/u,
    /^fsusblog-candidate-/u
]);

export const DATA_SCALE_EXCLUSIVE_RESOURCES = Object.freeze([
    'data-scale-artifacts',
    'data-scale-postgres',
    'data-scale-redis',
    'data-scale-runtime'
]);

const safeIdPattern = /^[a-z0-9][a-z0-9_.-]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const hex64Pattern = /^[0-9a-f]{64}$/u;

function canonicalize(value)
{
    if (Array.isArray(value))
    {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object')
    {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
}

export function computeSha256(data)
{
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(canonicalize(data)), 'utf8');
    return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function isForbiddenContainerName(name)
{
    if (!name || typeof name !== 'string')
    {
        return true;
    }
    const trimmed = name.trim();
    return FORBIDDEN_CONTAINER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function assertDedicatedContainer(name, role = 'container')
{
    if (!name || typeof name !== 'string' || !name.trim())
    {
        throw new Error(`data-scale ${role} container name is required`);
    }
    const trimmed = name.trim();
    if (isForbiddenContainerName(trimmed))
    {
        throw new Error(`data-scale prohibited from using shared or development ${role}: ${trimmed}`);
    }
}

export function assertDedicatedRoots({ aotRoot, searchRoot, hotReadRoot, dataRoot, dataScaleRunId, repositoryRoot = '.' })
{
    const roots = [
        ['aotRoot', aotRoot],
        ['searchRoot', searchRoot],
        ['hotReadRoot', hotReadRoot],
        ['dataRoot', dataRoot]
    ];

    const seenPaths = new Set();
    for (const [label, rootPath] of roots)
    {
        if (!rootPath || typeof rootPath !== 'string')
        {
            throw new Error(`data-scale ${label} is required`);
        }
        const normalized = rootPath.trim().replaceAll('\\', '/').replace(/^\.\//u, '');
        if (!normalized.startsWith('.tmp/'))
        {
            throw new Error(`data-scale ${label} must reside under .tmp/: ${normalized}`);
        }
        if (!normalized.includes(dataScaleRunId))
        {
            throw new Error(`data-scale ${label} must contain run-bound ID ${dataScaleRunId}: ${normalized}`);
        }
        if (normalized.includes('..'))
        {
            throw new Error(`data-scale ${label} must not traverse directories: ${normalized}`);
        }
        if (seenPaths.has(normalized))
        {
            throw new Error(`data-scale runtime roots must be distinct; duplicate found for ${label}: ${normalized}`);
        }
        seenPaths.add(normalized);

        // Check resolved path does not escape or overlap with shared production roots
        const resolved = path.resolve(repositoryRoot, normalized);
        const forbiddenSharedRoots = [
            path.resolve(repositoryRoot, 'src/backend/wwwroot'),
            path.resolve(repositoryRoot, 'src/backend/wwwroot/search'),
            path.resolve(repositoryRoot, 'src/backend/wwwroot/aot-cache'),
            path.resolve(repositoryRoot, '.tmp/cache'),
            path.resolve(repositoryRoot, '.tmp/env')
        ];
        for (const forbidden of forbiddenSharedRoots)
        {
            if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`))
            {
                throw new Error(`data-scale ${label} must not overlap with shared repository root ${forbidden}: ${normalized}`);
            }
        }
    }
}

export function createDataScaleRuntimePlan({
    dataScaleRunId,
    parentSchedulerRunId,
    namespace = 'data-scale',
    tier = 'scale-m',
    repositoryRoot = '.',
    postgresDatabase = 'fsusblog_data_scale',
    imageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    postgresImageDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    redisImageDigest = 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
})
{
    if (!dataScaleRunId || !safeIdPattern.test(dataScaleRunId))
    {
        throw new Error(`invalid dataScaleRunId: ${dataScaleRunId}`);
    }
    if (!parentSchedulerRunId || typeof parentSchedulerRunId !== 'string')
    {
        throw new Error('parentSchedulerRunId is required');
    }
    if (!namespace || !safeIdPattern.test(namespace))
    {
        throw new Error(`invalid namespace: ${namespace}`);
    }

    const postgresContainer = `fsusblog-data-scale-pg-${dataScaleRunId}`;
    const redisContainer = `fsusblog-data-scale-redis-${dataScaleRunId}`;
    const backendContainer = `fsusblog-data-scale-backend-${dataScaleRunId}`;

    const postgresVolume = `fsusblog-data-scale-pg-vol-${dataScaleRunId}`;
    const redisVolume = `fsusblog-data-scale-redis-vol-${dataScaleRunId}`;

    assertDedicatedContainer(postgresContainer, 'postgres');
    assertDedicatedContainer(redisContainer, 'redis');
    assertDedicatedContainer(backendContainer, 'backend');

    const aotRoot = `.tmp/scale/${dataScaleRunId}/aot`;
    const searchRoot = `.tmp/scale/${dataScaleRunId}/search`;
    const hotReadRoot = `.tmp/scale/${dataScaleRunId}/hotread`;
    const dataRoot = `.tmp/scale/${dataScaleRunId}/data`;

    assertDedicatedRoots({ aotRoot, searchRoot, hotReadRoot, dataRoot, dataScaleRunId, repositoryRoot });

    const ownershipLabels = Object.freeze({
        'fsusblog.owner': 'data-scale',
        'fsusblog.dataScaleRunId': dataScaleRunId,
        'fsusblog.parentSchedulerRunId': parentSchedulerRunId,
        'fsusblog.scenario': 'release-data-scale-m',
        'fsusblog.tier': tier
    });

    const plan = {
        schema: 'fsusblog.data-scale-runtime-plan.v1',
        runtimeRequirement: 'dedicated-scenario',
        dataScaleRunId,
        parentSchedulerRunId,
        namespace,
        tier,
        postgres: {
            containerName: postgresContainer,
            volumeName: postgresVolume,
            database: postgresDatabase,
            imageDigest: postgresImageDigest
        },
        redis: {
            containerName: redisContainer,
            volumeName: redisVolume,
            imageDigest: redisImageDigest
        },
        backend: {
            containerName: backendContainer,
            imageDigest
        },
        roots: {
            aotRoot,
            searchRoot,
            hotReadRoot,
            dataRoot
        },
        ownershipLabels,
        exclusiveResources: [...DATA_SCALE_EXCLUSIVE_RESOURCES]
    };

    plan.contentDigest = computeSha256(plan);
    return Object.freeze(plan);
}

export function validateDataScaleRuntimePlan(plan, repositoryRoot = '.')
{
    if (!plan || typeof plan !== 'object')
    {
        throw new Error('data-scale runtime plan must be an object');
    }
    if (plan.runtimeRequirement !== 'dedicated-scenario')
    {
        throw new Error(`runtimeRequirement must be dedicated-scenario, got: ${plan.runtimeRequirement}`);
    }
    if (!plan.dataScaleRunId || !safeIdPattern.test(plan.dataScaleRunId))
    {
        throw new Error(`invalid dataScaleRunId in plan: ${plan.dataScaleRunId}`);
    }
    assertDedicatedContainer(plan.postgres?.containerName, 'postgres');
    assertDedicatedContainer(plan.redis?.containerName, 'redis');
    assertDedicatedRoots({
        aotRoot: plan.roots?.aotRoot,
        searchRoot: plan.roots?.searchRoot,
        hotReadRoot: plan.roots?.hotReadRoot,
        dataRoot: plan.roots?.dataRoot,
        dataScaleRunId: plan.dataScaleRunId,
        repositoryRoot
    });

    if (!plan.ownershipLabels || plan.ownershipLabels['fsusblog.owner'] !== 'data-scale')
    {
        throw new Error('plan missing required ownership label fsusblog.owner=data-scale');
    }
    if (plan.ownershipLabels['fsusblog.dataScaleRunId'] !== plan.dataScaleRunId)
    {
        throw new Error('plan ownership label dataScaleRunId mismatch');
    }
    return true;
}

import { digestValue } from '../test/release-reliability-receipt.mjs';

export function createDataScaleRuntimeReceipt({
    dataScaleRunId,
    parentSchedulerRunId,
    sourceCommit,
    worktreeFingerprint,
    buildReceiptDigest,
    imageDigest,
    namespace,
    postgres,
    redis,
    backend,
    aotRoot,
    searchRoot,
    hotReadRoot,
    dataRoot,
    envManifestDigest,
    seedReceiptPath,
    seedReceiptDigest,
    createdAt = new Date().toISOString()
})
{
    // Exact keys in exact expected order matching verifyDataScaleOwnerReceipt
    const receipt = {
        aotRoot,
        backend: {
            baseUrl: backend.baseUrl,
            executableOrImageDigest: backend.executableOrImageDigest,
            pidOrContainerId: backend.pidOrContainerId,
            startTicks: String(backend.startTicks)
        },
        buildReceiptDigest,
        contentDigest: null,
        createdAt,
        dataRoot,
        dataScaleRunId,
        envManifestDigest,
        hotReadRoot,
        imageDigest,
        namespace,
        parentSchedulerRunId,
        postgres: {
            containerId: postgres.containerId,
            database: postgres.database,
            imageDigest: postgres.imageDigest,
            volumeId: postgres.volumeId
        },
        redis: {
            containerId: redis.containerId,
            imageDigest: redis.imageDigest,
            volumeId: redis.volumeId
        },
        schema: DATA_SCALE_RUNTIME_SCHEMA,
        searchRoot,
        seedReceiptDigest,
        seedReceiptPath,
        sourceCommit,
        worktreeFingerprint
    };

    receipt.contentDigest = digestValue(receipt);
    return receipt;
}

export function validateDataScaleBackendConnection({ plan, configuredPostgresContainer, configuredRedisContainer, configuredDatabase })
{
    if (configuredPostgresContainer !== plan.postgres.containerName)
    {
        throw new Error(`backend connected to wrong postgres container: expected ${plan.postgres.containerName}, got ${configuredPostgresContainer}`);
    }
    if (configuredRedisContainer !== plan.redis.containerName)
    {
        throw new Error(`backend connected to wrong redis container: expected ${plan.redis.containerName}, got ${configuredRedisContainer}`);
    }
    if (configuredDatabase && configuredDatabase !== plan.postgres.database)
    {
        throw new Error(`backend connected to wrong database: expected ${plan.postgres.database}, got ${configuredDatabase}`);
    }
    return true;
}

export function computeDbSemanticDigest({
    tier,
    namespace,
    prefix,
    counts,
    canaries,
    businessEpochUtc = '2024-02-29T23:59:59.000Z',
    postgresTimezone = 'UTC'
})
{
    const payload = {
        tier,
        namespace,
        prefix,
        counts,
        canaries,
        temporal: {
            businessEpochUtc,
            postgresTimezone
        }
    };
    return computeSha256(payload);
}
