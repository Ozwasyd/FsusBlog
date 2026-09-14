#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    bindResidentLeaseEnforcement,
    createResidentLeaseInventory,
    residentEnforcementScopeLimits,
    residentLeaseDigest,
    writeResidentLeaseDocument
} from './resident-resource-leases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function requiredEnvironment(env, name)
{
    const value = String(env[name] ?? '').trim();
    if (!value)
    {
        throw new Error(`${name} is required`);
    }
    return value;
}

function positiveEnvironment(env, name)
{
    const value = Number(requiredEnvironment(env, name));
    if (!Number.isFinite(value) || value <= 0)
    {
        throw new Error(`${name} must be positive`);
    }
    return value;
}

function positiveNumber(value, name)
{
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0)
    {
        throw new Error(`${name} must be positive`);
    }
    return normalized;
}

function processSnapshot(pidValue)
{
    const pid = Number(pidValue);
    if (!Number.isInteger(pid) || pid < 1)
    {
        throw new Error(`invalid resident process PID: ${pidValue}`);
    }
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingName = stat.lastIndexOf(')');
    if (closingName < 0)
    {
        throw new Error(`resident process stat is malformed: ${pid}`);
    }
    const fields = stat.slice(closingName + 2).trim().split(/\s+/u);
    const startTimeTicks = fields[19];
    if (!startTimeTicks)
    {
        throw new Error(`resident process start time is unavailable: ${pid}`);
    }
    const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').trim().split(/\s+/u);
    const residentPages = Number(statm[1]);
    let pageSize = 4096;
    try
    {
        const detected = Number(execFileSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).trim());
        if (Number.isInteger(detected) && detected > 0)
        {
            pageSize = detected;
        }
    }
    catch
    {}
    return {
        identity: { pid, startTimeTicks },
        observedRssBytes: Number.isFinite(residentPages) && residentPages >= 0
            ? residentPages * pageSize
            : 0
    };
}

function containerSnapshot(name)
{
    const document = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
    if (!document?.Id || !document?.Created || document?.State?.Running !== true)
    {
        throw new Error(`resident container is not running: ${name}`);
    }
    const process = processSnapshot(document.State.Pid);
    return {
        identity: { containerId: document.Id, createdAt: document.Created },
        observedRssBytes: process.observedRssBytes
    };
}

function service(id, kind, port, snapshot)
{
    return {
        id,
        kind,
        identity: snapshot.identity,
        port: Number(port),
        generation: residentLeaseDigest({ id, kind, identity: snapshot.identity }),
        health: { status: 'ready', checkedAt: new Date().toISOString() },
        observedRssBytes: snapshot.observedRssBytes
    };
}

function sumReservation(services)
{
    return {
        cpuUnits: services.reduce((sum, service) => sum + service.reservation.cpuUnits, 0),
        memoryGiB: services.reduce((sum, service) => sum + service.reservation.memoryGiB, 0)
    };
}

function enforceContainerReservation(name, service, limit)
{
    const memoryHighBytes = Math.max(1, Math.round(service.reservation.memoryGiB * (1024 ** 3)));
    const memoryMaxBytes = Math.max(memoryHighBytes, Math.round(limit.memoryGiB * (1024 ** 3)));
    execFileSync('docker', [
        'update',
        '--cpus', String(limit.cpuUnits),
        '--memory-reservation', String(memoryHighBytes),
        '--memory', String(memoryMaxBytes),
        name
    ], { stdio: 'pipe' });
    const document = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }))[0];
    return {
        status: 'enforced',
        containerId: document.Id,
        reservation: service.reservation,
        limit,
        observed: {
            cpuUnits: Number(document.HostConfig?.NanoCpus) / 1_000_000_000,
            memoryHighBytes: Number(document.HostConfig?.MemoryReservation),
            memoryMaxBytes: Number(document.HostConfig?.Memory)
        }
    };
}

export function publishResidentInventoryFromEnvironment({
    env = process.env,
    outputFile,
    snapshotProcess = processSnapshot,
    snapshotContainer = containerSnapshot,
    enforceContainer = enforceContainerReservation
} = {})
{
    const runId = requiredEnvironment(env, 'FSUSBLOG_TEST_RUN_ID');
    const namespace = requiredEnvironment(env, 'FSUSBLOG_TEST_NAMESPACE');
    const ownerBundleId = requiredEnvironment(env, 'FSUSBLOG_PHYSICAL_BUNDLE_ID');
    const services = [
        service('debug-backend', 'process', requiredEnvironment(env, 'FSUSBLOG_DEBUG_BACKEND_PORT'),
            snapshotProcess(requiredEnvironment(env, 'FSUSBLOG_RESIDENT_BACKEND_PID'))),
        service('debug-frontend', 'process', requiredEnvironment(env, 'FSUSBLOG_DEBUG_FRONTEND_PORT'),
            snapshotProcess(requiredEnvironment(env, 'FSUSBLOG_RESIDENT_FRONTEND_PID'))),
        service('release-preview', 'process', requiredEnvironment(env, 'FSUSBLOG_RELEASE_PREVIEW_PORT'),
            snapshotProcess(requiredEnvironment(env, 'FSUSBLOG_RESIDENT_PREVIEW_PID'))),
        service('postgres', 'container', requiredEnvironment(env, 'FSUSBLOG_POSTGRES_PORT'),
            snapshotContainer(requiredEnvironment(env, 'FSUSBLOG_POSTGRES_CONTAINER_NAME'))),
        service('redis', 'container', requiredEnvironment(env, 'FSUSBLOG_REDIS_PORT'),
            snapshotContainer(requiredEnvironment(env, 'FSUSBLOG_REDIS_CONTAINER_NAME')))
    ];
    const stepResourceGrant = {
        cpuUnits: positiveEnvironment(env, 'FSUSBLOG_STEP_CPU_BUDGET'),
        memoryGiB: positiveEnvironment(env, 'FSUSBLOG_STEP_MEMORY_GIB')
    };
    const grantFile = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_FILE ?? '').trim();
    const grantTierId = String(env.FSUSBLOG_SCHEDULER_RESOURCE_GRANT_TIER_ID ?? '').trim();
    if (Boolean(grantFile) !== Boolean(grantTierId))
    {
        throw new Error('scheduler resident lease binding requires both grant file and tier ID');
    }
    let schedulerResourceGrant = stepResourceGrant;
    let resourceBudget = schedulerResourceGrant;
    if (grantFile)
    {
        const grantDocument = JSON.parse(fs.readFileSync(path.resolve(grantFile), 'utf8'));
        if (grantDocument?.schema !== 'fsusblog.test-matrix.resource-grants.v1'
      || grantDocument.runId !== runId)
        {
            throw new Error('scheduler resident lease grant document identity mismatch');
        }
        schedulerResourceGrant = {
            cpuUnits: positiveNumber(grantDocument.grants?.[grantTierId]?.cpuUnits, 'schedulerGrant.cpuUnits'),
            memoryGiB: positiveNumber(grantDocument.grants?.[grantTierId]?.memoryGiB, 'schedulerGrant.memoryGiB')
        };
        resourceBudget = {
            cpuUnits: positiveNumber(grantDocument.resourceBudget?.cpuUnits, 'resourceBudget.cpuUnits'),
            memoryGiB: positiveNumber(grantDocument.resourceBudget?.memoryGiB, 'resourceBudget.memoryGiB')
        };
    }
    let inventory = createResidentLeaseInventory({
        runId,
        namespace,
        ownerBundleId,
        sourceState: {
            commit: requiredEnvironment(env, 'FSUSBLOG_TEST_SOURCE_COMMIT'),
            worktreeFingerprint: requiredEnvironment(env, 'FSUSBLOG_TEST_SOURCE_FINGERPRINT')
        },
        resourceGrant: stepResourceGrant,
        schedulerResourceGrant,
        resourceBudget,
        services
    });
    const processServices = inventory.services.filter((service) => service.kind === 'process');
    const containerNames = {
        postgres: requiredEnvironment(env, 'FSUSBLOG_POSTGRES_CONTAINER_NAME'),
        redis: requiredEnvironment(env, 'FSUSBLOG_REDIS_CONTAINER_NAME')
    };
    const containerServices = inventory.services.filter((service) => service.kind === 'container');
    const enforcementLimits = residentEnforcementScopeLimits(inventory);
    const containers = Object.fromEntries(containerServices.map((service) => [
        service.id,
        enforceContainer(containerNames[service.id], service, enforcementLimits.containers[service.id])
    ]));
    inventory = bindResidentLeaseEnforcement(inventory, {
        mode: requiredEnvironment(env, 'FSUSBLOG_CGROUP_ENFORCEMENT_MODE'),
        processScope: {
            status: requiredEnvironment(env, 'FSUSBLOG_CGROUP_ENFORCEMENT_MODE'),
            path: String(env.FSUSBLOG_CGROUP_BUNDLE_PATH ?? '').trim() || null,
            reservation: sumReservation(processServices)
        },
        containers,
        boundAt: new Date().toISOString()
    });
    const file = path.resolve(outputFile ?? path.join(root, '.tmp', 'test-runs', runId, 'resident-resource-leases.json'));
    writeResidentLeaseDocument(file, inventory);
    return { file, inventory };
}

function main(argv)
{
    if (argv[0] !== 'publish')
    {
        throw new Error('usage: resident-resource-leases-cli.mjs publish [--out file]');
    }
    const outputIndex = argv.indexOf('--out');
    const outputFile = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
    const result = publishResidentInventoryFromEnvironment({ outputFile });
    process.stdout.write(`${result.file}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[resident-resource-leases] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
