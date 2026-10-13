#!/usr/bin/env node

/* eslint-disable import-x/no-relative-parent-imports -- Integrate the existing canonical lifecycle and resource observer owners. */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    readDockerPostgresqlDatabaseState,
    readDockerPublicCacheState,
    resetDockerPublicCache
} from '../test-runtime/production-observer-ports.mjs';

import { readReleaseReliabilityEvidenceBinding } from './release-reliability-evidence-binding.mjs';
import {
    expandLifecycleTemplate,
    loadLifecycleActionContracts,
    ordinaryRuntimeResourceStateErrors
} from './release-reliability-lifecycle-actions.mjs';
import { digestValue, sealDocument } from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

function safeIdentifier(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!safeIdentifierPattern.test(normalized))
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function repositoryPath(repositoryRoot, value, label)
{
    const relative = String(value ?? '').trim().replaceAll('\\', '/')
        .replace(/^\.\//u, '');
    const segments = relative.split('/');
    if (!relative || path.posix.isAbsolute(relative)
        || path.posix.normalize(relative) !== relative
        || segments.some((segment) => !segment || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} is unsafe`);
    }
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute === repositoryRoot
        || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
    {
        throw new Error(`${label} escapes the repository`);
    }
    let cursor = absolute;
    while (cursor !== repositoryRoot)
    {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        {
            throw new Error(`${label} contains a symlink`);
        }
        cursor = path.dirname(cursor);
    }
    return { absolute, relative };
}

function writeJsonAtomic(file, value)
{
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
    });
    fs.renameSync(temporary, file);
}

function sha256(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function readMeasurementProcessTreeObservation(context)
{
    try
    {
        const configuredPath = String(
            context.environment
                .FSUSBLOG_RELEASE_RELIABILITY_PROCESS_TREE_RECEIPT_PATH ?? ''
        ).trim();
        if (!configuredPath)
        {
            throw new Error('measurement process-tree receipt path is required');
        }
        const scenario = context.contracts.catalog.scenarios.find(
            (candidate) => candidate.id === context.scenarioId
        );
        const measurementActionId = scenario?.isolation?.lifecycle?.measurement;
        const expectedPath =
            `.tmp/release-reliability/${context.invocationId}/process-trees/` +
            `${context.scenarioId}/${measurementActionId}.json`;
        if (configuredPath !== expectedPath)
        {
            throw new Error('measurement process-tree receipt path is not canonical');
        }
        const resolved = repositoryPath(
            context.repositoryRoot,
            configuredPath,
            'measurement process-tree receipt'
        );
        if (!fs.existsSync(resolved.absolute)
            || !fs.lstatSync(resolved.absolute).isFile())
        {
            throw new Error('measurement process-tree receipt is unavailable');
        }
        const bytes = fs.readFileSync(resolved.absolute);
        const document = JSON.parse(bytes.toString('utf8'));
        if (document.schema
                !== 'fsusblog.release-reliability-process-tree-receipt.v1'
            || document.invocationId !== context.invocationId
            || document.runId !== context.runId
            || document.scenarioId !== context.scenarioId
            || document.actionId !== measurementActionId
            || document.phase !== 'measurement'
            || document.identity?.path !== context.identityReference.path
            || document.identity?.contentDigest
                !== context.identityReference.contentDigest
            || JSON.stringify(document.physicalPolicy)
                !== JSON.stringify(context.identity.policy?.physicalExecution)
            || document.contentDigest !== digestValue(document))
        {
            throw new Error('measurement process-tree receipt identity is invalid');
        }
        const policy = repositoryPath(
            context.repositoryRoot,
            document.physicalPolicy.path,
            'physical execution policy'
        );
        const policyBytes = fs.readFileSync(policy.absolute);
        if (sha256(policyBytes) !== document.physicalPolicy.fileDigest
            || JSON.stringify(document.processTree?.policy)
                !== JSON.stringify(JSON.parse(policyBytes.toString('utf8'))))
        {
            throw new Error('measurement process-tree policy binding changed');
        }
        if (document.processTree?.postObservation !== 'zero-members'
            || document.logComplete !== true
            || document.processTree?.logComplete !== true)
        {
            throw new Error('measurement descendant zero-state is unproved');
        }
        return {
            status: 'zero',
            path: resolved.relative,
            schema: document.schema,
            actionId: measurementActionId,
            bytesDigest: sha256(bytes),
            contentDigest: document.contentDigest,
            physicalPolicy: document.physicalPolicy,
            postObservation: document.processTree.postObservation
        };
    }
    catch (error)
    {
        return {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error)
        };
    }
}

function inspectPath(repositoryRoot, relativePath)
{
    const resolved = repositoryPath(repositoryRoot, relativePath, 'observed path');
    if (!fs.existsSync(resolved.absolute))
    {
        return { path: resolved.relative, status: 'absent' };
    }
    const stat = fs.lstatSync(resolved.absolute);
    if (stat.isSymbolicLink())
    {
        throw new Error(`observed path is a symlink: ${resolved.relative}`);
    }
    if (stat.isFile())
    {
        return {
            path: resolved.relative,
            status: 'file',
            bytes: stat.size,
            bytesDigest: sha256(fs.readFileSync(resolved.absolute))
        };
    }
    if (stat.isDirectory())
    {
        return {
            path: resolved.relative,
            status: 'directory',
            directEntries: fs.readdirSync(resolved.absolute).sort()
        };
    }
    return { path: resolved.relative, status: 'other' };
}

function inspectContainer(containerId, spawnProcess, repositoryRoot)
{
    if (!/^[0-9a-f]{64}$/u.test(String(containerId ?? '')))
    {
        return { status: 'failed', reason: 'run-bound container identity is unavailable' };
    }
    const result = spawnProcess('docker', ['inspect', containerId], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        return { status: 'failed', reason: 'run-bound container inspection failed' };
    }
    try
    {
        const [container] = JSON.parse(result.stdout || '[]');
        if (container?.Id !== containerId || container.State?.Running !== true)
        {
            return { status: 'failed', reason: 'run-bound container identity changed' };
        }
        return {
            status: 'running',
            id: container.Id,
            hostPid: container.State.Pid,
            startedAt: container.State.StartedAt,
            image: container.Image,
            labels: container.Config?.Labels ?? {},
            volumeNames: (container.Mounts ?? [])
                .filter((mount) => mount.Type === 'volume')
                .map((mount) => mount.Name)
                .sort()
        };
    }
    catch
    {
        return { status: 'failed', reason: 'container inspection was not JSON' };
    }
}

function processStartTicks(pid)
{
    try
    {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const close = stat.lastIndexOf(')');
        const fields = stat.slice(close + 2).split(/\s+/u);
        return fields[19] ?? null;
    }
    catch
    {
        return null;
    }
}

export function inspectBackendIdentity(backend, spawnProcess, repositoryRoot)
{
    if (/^[0-9a-f]{64}$/u.test(String(backend.pidOrContainerId)))
    {
        const container = inspectContainer(
            backend.pidOrContainerId,
            spawnProcess,
            repositoryRoot
        );
        return {
            ...container,
            identityKind: 'container',
            startTicks: container.status === 'running'
                ? processStartTicks(container.hostPid)
                : null,
            executableOrImageDigest: container.image
        };
    }
    const pid = Number(backend.pidOrContainerId);
    if (!Number.isInteger(pid) || pid < 2)
    {
        return { status: 'failed', reason: 'data-scale backend identity is invalid' };
    }
    try
    {
        const executable = fs.readlinkSync(`/proc/${pid}/exe`);
        const startTicks = processStartTicks(pid);
        return {
            status: startTicks ? 'running' : 'failed',
            identityKind: 'pid',
            id: pid,
            hostPid: pid,
            startTicks,
            executableOrImageDigest: sha256(fs.readFileSync(executable))
        };
    }
    catch
    {
        return { status: 'failed', reason: 'PID-bound data-scale backend is unavailable' };
    }
}

function inspectNetwork(topology, spawnProcess, repositoryRoot)
{
    const network = topology?.runtime?.network;
    if (!/^[0-9a-f]{64}$/u.test(String(network?.id ?? '')))
    {
        return { status: 'failed', reason: 'run-bound network identity is unavailable' };
    }
    const result = spawnProcess('docker', ['network', 'inspect', network.id], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    if (result.status !== 0)
    {
        return { status: 'failed', reason: 'run-bound network inspection failed' };
    }
    try
    {
        const [actual] = JSON.parse(result.stdout || '[]');
        const expectedMembers = [
            topology.runtime.backendContainer.id,
            topology.postgres.instance,
            topology.redis.instance
        ].sort();
        const actualMembers = Object.keys(actual?.Containers ?? {}).sort();
        if (actual?.Id !== network.id
            || JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers))
        {
            return { status: 'failed', reason: 'run-bound network membership changed' };
        }
        return {
            status: 'bound',
            id: actual.Id,
            memberContainerIds: actualMembers
        };
    }
    catch
    {
        return { status: 'failed', reason: 'network inspection was not JSON' };
    }
}

function inspectResourceCounters(containerId, spawnProcess, repositoryRoot)
{
    const result = spawnProcess('docker', [
        'exec',
        containerId,
        'sh',
        '-c',
        `rss=$(awk '/^VmRSS:/ { print $2 * 1024; found=1 } END { if (!found) exit 1 }' /proc/1/status) || exit 1; count=0; for descriptor in /proc/1/fd/*; do [ -e "$descriptor" ] || continue; count=$((count + 1)); done; printf '%s %s\\n' "$rss" "$count"`
    ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
    const match = String(result.stdout ?? '').trim().match(/^(\d+)\s+(\d+)$/u);
    if (result.status !== 0 || !match)
    {
        return { status: 'failed', reason: 'run-bound resource counter read failed' };
    }
    return {
        status: 'observed',
        rssBytes: Number(match[1]),
        openFileDescriptors: Number(match[2])
    };
}

/** Observe actual fixture data using the sealed endpoint identities, never ambient names. */
export async function observeOrdinaryRuntimeResourceState({ topology, runId, repositoryRoot = root })
{
    const result = {};
    for (const kind of ['postgres', 'redis'])
    {
        try
        {
            const expected = topology?.[kind];
            const actual = inspectContainer(expected?.instance, spawnSync, repositoryRoot);
            if (topology?.runId !== runId || !topology?.namespace
                || actual.status !== 'running' || actual.image !== expected.imageId
                || actual.labels['io.fsusblog.test.run-id'] !== runId
                || actual.labels['io.fsusblog.test.namespace'] !== topology.namespace)
            {
                throw new Error('resource identity is not owned by the admitted run');
            }
            result[kind] = kind === 'postgres'
                ? readDockerPostgresqlDatabaseState({ container: actual.id })
                : await readDockerPublicCacheState({ container: actual.id,
                    namespacePrefix: topology.runtime?.environmentProjection?.effective
                        ?.RedisOptions__InstanceName });
        }
        catch
        {
            result[kind] = { status: 'failed', reason: 'run-bound native state observation failed' };
        }
    }
    return result;
}

async function inspectRuntime(context, { spawnProcess, fetchImpl })
{
    const topology = context.identity.fixture?.topology?.content;
    const backend = topology?.runtime?.backendContainer;
    const port = backend?.portBinding;
    const expectedBaseUrl = Number.isInteger(port?.hostPort)
        ? `http://${port.hostIp}:${port.hostPort}`
        : null;
    const configuredBaseUrl = String(
        context.environment.FSUSBLOG_DEBUG_BACKEND_URL ?? ''
    ).replace(/\/$/u, '');
    let live = {
        status: 'failed',
        reason: 'run-bound runtime URL is unavailable'
    };
    if (expectedBaseUrl && configuredBaseUrl === expectedBaseUrl)
    {
        try
        {
            const response = await fetchImpl(`${expectedBaseUrl}/health/live`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(3_000)
            });
            const document = response.ok ? await response.json() : null;
            live = {
                status: response.ok && document?.status === 'live'
                    ? 'live'
                    : 'failed',
                httpStatus: response.status,
                reportStatus: document?.status ?? null
            };
        }
        catch
        {
            live = { status: 'failed', reason: 'run-bound live probe failed' };
        }
    }
    let performanceCounters = null;
    if (context.action.stateDomains.includes('runtime.performance-counters'))
    {
        try
        {
            const scenario = context.contracts.catalog.scenarios.find(
                (candidate) => candidate.id === context.scenarioId
            );
            const evidence = repositoryPath(
                context.repositoryRoot,
                scenario.authoritativeEvidence.path,
                'performance counter authority'
            );
            const document = JSON.parse(fs.readFileSync(evidence.absolute, 'utf8'));
            performanceCounters = {
                status: scenario.authoritativeEvidence.expectedSchema.passStatusValues
                    .includes(document.status)
                    && document.metrics && typeof document.metrics === 'object'
                    ? 'observed'
                    : 'failed',
                path: evidence.relative,
                bytesDigest: sha256(fs.readFileSync(evidence.absolute))
            };
        }
        catch
        {
            performanceCounters = {
                status: 'failed',
                reason: 'performance counter authority is unavailable'
            };
        }
    }
    return {
        expectedBaseUrl,
        configuredBaseUrl,
        backend: inspectContainer(
            backend?.id,
            spawnProcess,
            context.repositoryRoot
        ),
        postgres: inspectContainer(
            topology?.postgres?.instance,
            spawnProcess,
            context.repositoryRoot
        ),
        redis: inspectContainer(
            topology?.redis?.instance,
            spawnProcess,
            context.repositoryRoot
        ),
        resourceCounters: context.action.stateDomains.includes(
            'runtime.backend-resource-counters'
        )
            ? inspectResourceCounters(
                backend?.id,
                spawnProcess,
                context.repositoryRoot
            )
            : null,
        performanceCounters,
        measurementDescendants: context.action.stateDomains.includes(
            'runtime.measurement-children'
        )
            ? readMeasurementProcessTreeObservation(context)
            : null,
        network: inspectNetwork(topology, spawnProcess, context.repositoryRoot),
        resourceState: await observeOrdinaryRuntimeResourceState({
            topology, runId: context.runId, repositoryRoot: context.repositoryRoot
        }),
        ...(context.action.targets ? { targets: context.action.targets.map(
            (target) => inspectPath(context.repositoryRoot, target)
        ) } : {}),
        live
    };
}

function directoryInventory(repositoryRoot, configuredPath, label)
{
    if (!configuredPath)
    {
        return { status: 'failed', reason: `${label} is unavailable` };
    }
    const rootPath = repositoryPath(repositoryRoot, configuredPath, label);
    if (!fs.existsSync(rootPath.absolute)
        || !fs.lstatSync(rootPath.absolute).isDirectory())
    {
        return { status: 'failed', reason: `${label} is not a directory` };
    }
    const entries = [];
    const visit = (directory) =>
    {
        for (const name of fs.readdirSync(directory).sort())
        {
            const absolute = path.join(directory, name);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink())
            {
                throw new Error(`${label} contains a symlink`);
            }
            const relative = path.relative(rootPath.absolute, absolute)
                .replaceAll(path.sep, '/');
            if (stat.isDirectory())
            {
                visit(absolute);
            }
            else if (stat.isFile())
            {
                entries.push({
                    path: relative,
                    bytes: stat.size,
                    digest: sha256(fs.readFileSync(absolute))
                });
            }
        }
    };
    visit(rootPath.absolute);
    return {
        status: 'observed',
        path: rootPath.relative,
        fileCount: entries.length,
        inventoryDigest: digestValue({ entries })
    };
}

function inspectMutation(context, spawnProcess)
{
    const commit = spawnProcess('git', ['rev-parse', 'HEAD'], {
        cwd: context.repositoryRoot,
        encoding: 'utf8'
    });
    const status = spawnProcess(
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: context.repositoryRoot, encoding: 'utf8' }
    );
    return {
        source: {
            status: commit.status === 0 && status.status === 0
                && commit.stdout.trim() === context.binding.sourceState.commit
                && status.stdout.trim() === ''
                ? 'clean'
                : 'failed',
            commit: commit.status === 0 ? commit.stdout.trim() : null,
            trackedDirty: status.status === 0 ? status.stdout.trim() !== '' : null
        },
        productionBuild: directoryInventory(
            context.repositoryRoot,
            context.environment.FSUSBLOG_PRODUCTION_BUILD_ROOT,
            'production build root'
        ),
        mutationOutput: inspectPath(
            context.repositoryRoot,
            '.tmp/mutation/backend-critical'
        ),
        measurementDescendants: context.action.stateDomains.includes(
            'runtime.measurement-children'
        )
            ? readMeasurementProcessTreeObservation(context)
            : null
    };
}

function originalReceiptBinding(repositoryRoot, resolved)
{
    const bytes = fs.readFileSync(resolved.absolute);
    const document = JSON.parse(bytes.toString('utf8'));
    if (document.contentDigest !== digestValue(document))
    {
        throw new Error('baseline action receipt content digest mismatch');
    }
    return {
        path: resolved.relative,
        bytesDigest: sha256(bytes),
        contentDigest: document.contentDigest,
        document
    };
}

function mutationBaseline(context)
{
    if (context.action.phase === 'precondition')
    {
        return null;
    }
    const scenario = context.contracts.catalog.scenarios.find(
        (candidate) => candidate.id === context.scenarioId
    );
    const actionId = scenario.isolation.lifecycle.preconditions[0];
    const action = context.contracts.actions.get(actionId);
    const resolved = repositoryPath(
        context.repositoryRoot,
        expandLifecycleTemplate(action.expectedReceiptPath, {
            actionId,
            invocationId: context.invocationId,
            runId: context.runId,
            scenarioId: context.scenarioId
        }),
        'mutation baseline receipt'
    );
    return originalReceiptBinding(context.repositoryRoot, resolved);
}

function runtimeBaseline(context)
{
    if (context.action.phase === 'precondition')
    {
        return null;
    }
    const scenario = context.contracts.catalog.scenarios.find(
        (candidate) => candidate.id === context.scenarioId
    );
    const actionId = scenario.isolation.lifecycle.preconditions[0];
    const action = context.contracts.actions.get(actionId);
    const resolved = repositoryPath(
        context.repositoryRoot,
        expandLifecycleTemplate(action.expectedReceiptPath, {
            actionId,
            invocationId: context.invocationId,
            runId: context.runId,
            scenarioId: context.scenarioId
        }),
        'runtime counter baseline receipt'
    );
    return originalReceiptBinding(context.repositoryRoot, resolved);
}

function dataScaleRuntimeBaseline(context)
{
    const scenario = context.contracts.catalog.scenarios.find(
        (candidate) => candidate.id === context.scenarioId
    );
    const actionId = scenario.isolation.lifecycle.preconditions[0];
    const action = context.contracts.actions.get(actionId);
    const resolved = repositoryPath(
        context.repositoryRoot,
        expandLifecycleTemplate(action.expectedReceiptPath, {
            actionId,
            invocationId: context.invocationId,
            runId: context.runId,
            scenarioId: context.scenarioId
        }),
        'data-scale runtime baseline receipt'
    );
    return originalReceiptBinding(context.repositoryRoot, resolved);
}

async function inspectDataScaleOwner(context, dependencies)
{
    const environmentName = context.action.ownerReceipt === 'data-scale-runtime'
        ? 'FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH'
        : 'FSUSBLOG_DATA_SCALE_TEARDOWN_RECEIPT_PATH';
    const configuredPath = String(context.environment[environmentName] ?? '').trim();
    if (!configuredPath)
    {
        throw new Error(`${environmentName} is required; no default owner receipt is allowed`);
    }
    const { verifyDataScaleOwnerReceipt } = await import(
        './verify-release-reliability-lifecycle-action.mjs'
    );
    const owner = verifyDataScaleOwnerReceipt({
        repositoryRoot: context.repositoryRoot,
        ownerReceipt: context.action.ownerReceipt,
        receiptPath: configuredPath,
        identity: context.identity,
        runId: context.runId,
        invocationId: context.invocationId,
        attemptId: context.environment.FSUSBLOG_RELEASE_RELIABILITY_ATTEMPT_ID
    });
    if (context.action.ownerReceipt === 'data-scale-teardown')
    {
        return {
            ownerReceipt: owner,
            teardown: {
                status: 'observed',
                resources: owner.document.resources,
                ports: owner.document.ports,
                leases: owner.document.leases,
                roots: owner.document.roots
            },
            measurementDescendants: context.action.stateDomains.includes(
                'runtime.measurement-children'
            )
                ? readMeasurementProcessTreeObservation(context)
                : null
        };
    }
    const runtime = owner.document;
    const spawnProcess = dependencies.spawnProcess ?? spawnSync;
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    const backendContainer = inspectBackendIdentity(
        runtime.backend,
        spawnProcess,
        context.repositoryRoot
    );
    const networkInspection = spawnProcess('docker', [
        'network', 'inspect', runtime.network.id
    ], {
        cwd: context.repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    let network = { status: 'failed' };
    try
    {
        const [document] = JSON.parse(networkInspection.stdout || '[]');
        const members = Object.keys(document?.Containers ?? {}).sort();
        const expectedMembers = [
            runtime.backend.pidOrContainerId,
            runtime.postgres.containerId,
            runtime.redis.containerId
        ].sort();
        network = networkInspection.status === 0
            && document?.Id === runtime.network.id
            && document?.Name === runtime.network.name
            && JSON.stringify(members) === JSON.stringify(expectedMembers)
            ? { status: 'bound', id: document.Id, name: document.Name, members }
            : { status: 'failed' };
    }
    catch
    {
        // Preserve the fail-closed observation above.
    }
    let live = { status: 'failed', reason: 'data-scale live probe failed' };
    try
    {
        const response = await fetchImpl(`${runtime.backend.baseUrl.replace(/\/$/u, '')}/health/live`, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(3_000)
        });
        const document = response.ok ? await response.json() : null;
        live = {
            status: response.ok && document?.status === 'live' ? 'live' : 'failed',
            httpStatus: response.status
        };
    }
    catch
    {
        // Preserve the fail-closed observation above.
    }
    return {
        ownerReceipt: owner,
        runtime: {
            backend: backendContainer,
            postgres: inspectContainer(
                runtime.postgres.containerId,
                spawnProcess,
                context.repositoryRoot
            ),
            redis: inspectContainer(
                runtime.redis.containerId,
                spawnProcess,
                context.repositoryRoot
            ),
            live,
            network,
            expected: {
                backend: runtime.backend,
                postgres: runtime.postgres,
                redis: runtime.redis,
                roots: [
                    runtime.aotRoot,
                    runtime.searchRoot,
                    runtime.hotReadRoot,
                    runtime.dataRoot
                ]
            },
            roots: [
                runtime.aotRoot,
                runtime.searchRoot,
                runtime.hotReadRoot,
                runtime.dataRoot
            ].map((target) => inspectPath(context.repositoryRoot, target))
        }
    };
}

export async function observeLifecycleAction(
    context,
    {
        spawnProcess = spawnSync,
        fetchImpl = fetch
    } = {}
)
{
    if (['observe-runtime', 'reset-runtime-state'].includes(context.action.operation))
    {
        return inspectRuntime(context, { spawnProcess, fetchImpl });
    }
    if (context.action.operation === 'observe-mutation'
        || context.action.operation === 'cleanup-mutation-output')
    {
        return inspectMutation(context, spawnProcess);
    }
    if ([
        'observe-data-scale-runtime',
        'provision-data-scale-runtime',
        'teardown-data-scale-runtime'
    ].includes(context.action.operation))
    {
        return inspectDataScaleOwner(context, { spawnProcess, fetchImpl });
    }
    return {
        targets: (context.action.targets ?? []).map(
            (target) => inspectPath(context.repositoryRoot, target)
        )
    };
}

function observationErrors(action, observation, context, operation)
{
    const errors = [];
    if (['observe-runtime', 'reset-runtime-state'].includes(action.operation))
    {
        if (observation.backend?.status !== 'running'
            || observation.live?.status !== 'live')
        {
            errors.push('run-bound backend identity/live observation failed');
        }
        if (action.stateDomains.some((domain) => domain.startsWith('postgres.'))
            && observation.postgres?.status !== 'running')
        {
            errors.push('run-bound PostgreSQL identity observation failed');
        }
        if (action.stateDomains.some((domain) => domain.startsWith('redis.'))
            && observation.redis?.status !== 'running')
        {
            errors.push('run-bound Redis identity observation failed');
        }
        if (action.stateDomains.includes('runtime.backend-resource-counters')
            && observation.resourceCounters?.status !== 'observed')
        {
            errors.push('run-bound resource counter observation failed');
        }
        if (action.stateDomains.includes('runtime.performance-counters')
            && observation.performanceCounters?.status !== 'observed')
        {
            errors.push('performance counter final observation failed');
        }
        if (action.stateDomains.includes('network.host-topology')
            && observation.network?.status !== 'bound')
        {
            errors.push('run-bound network topology observation failed');
        }
        if (action.stateDomains.includes('runtime.measurement-children')
            && observation.measurementDescendants?.status !== 'zero')
        {
            errors.push('measurement descendant zero-state is unproved');
        }
        errors.push(...ordinaryRuntimeResourceStateErrors({
            action, observation, topology: context.identity.fixture?.topology?.content,
            reset: operation.publicCacheReset
        }));
    }
    if (action.operation === 'observe-mutation'
        || action.operation === 'cleanup-mutation-output')
    {
        if (observation.source?.status !== 'clean')
        {
            errors.push('mutation source state is not clean/current');
        }
        if (observation.productionBuild?.status !== 'observed')
        {
            errors.push('mutation production build inventory is unavailable');
        }
        if (action.stateDomains.includes('runtime.measurement-children')
            && observation.measurementDescendants?.status !== 'zero')
        {
            errors.push('mutation measurement descendant zero-state is unproved');
        }
        if (action.operation === 'cleanup-mutation-output'
            && observation.mutationOutput?.status !== 'absent')
        {
            errors.push('mutation output cleanup final observation is not absent');
        }
    }
    if (['observe-data-scale-runtime', 'provision-data-scale-runtime']
        .includes(action.operation)
        && (observation.runtime?.backend?.status !== 'running'
            || String(observation.runtime.backend.id)
                !== String(observation.runtime.expected?.backend?.pidOrContainerId)
            || String(observation.runtime.backend.startTicks)
                !== String(observation.runtime.expected?.backend?.startTicks)
            || observation.runtime.backend.executableOrImageDigest
                !== observation.runtime.expected?.backend?.executableOrImageDigest
            || observation.runtime?.postgres?.status !== 'running'
            || observation.runtime.postgres.id
                !== observation.runtime.expected?.postgres?.containerId
            || observation.runtime.postgres.image
                !== observation.runtime.expected?.postgres?.imageDigest
            || !observation.runtime.postgres.volumeNames?.includes(
                observation.runtime.expected?.postgres?.volumeId
            )
            || observation.runtime?.redis?.status !== 'running'
            || observation.runtime.redis.id
                !== observation.runtime.expected?.redis?.containerId
            || observation.runtime.redis.image
                !== observation.runtime.expected?.redis?.imageDigest
            || !observation.runtime.redis.volumeNames?.includes(
                observation.runtime.expected?.redis?.volumeId
            )
            || observation.runtime?.live?.status !== 'live'
            || observation.runtime?.network?.status !== 'bound'
            || observation.runtime?.roots?.some(
                (rootObservation) => !['directory', 'file'].includes(
                    rootObservation.status
                )
            )
            || JSON.stringify(
                observation.runtime.roots.map((entry) => entry.path)
            ) !== JSON.stringify(observation.runtime.expected?.roots)))
    {
        errors.push('dedicated data-scale runtime final observation failed');
    }
    if (action.operation === 'teardown-data-scale-runtime')
    {
        if (observation.teardown?.status !== 'observed')
        {
            errors.push('data-scale teardown final observation failed');
        }
        if (action.stateDomains.includes('runtime.measurement-children')
            && observation.measurementDescendants?.status !== 'zero')
        {
            errors.push('data-scale measurement descendant zero-state is unproved');
        }
    }
    if (['prepare-evidence-files', 'reset-runtime-state'].includes(action.operation)
        && action.targets
        && observation.targets.some((target) => target.status !== 'absent'))
    {
        errors.push('evidence-file preparation left an owned output');
    }
    return errors;
}

function lifecycleContext({
    actionId,
    repositoryRoot = root,
    environment = process.env
})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const contracts = loadLifecycleActionContracts({
        repositoryRoot: resolvedRoot
    });
    const action = contracts.actions.get(safeIdentifier(actionId, 'actionId'));
    if (!action || ![
        'cleanup-mutation-output',
        'observe-data-scale-runtime',
        'provision-data-scale-runtime',
        'observe-mutation',
        'observe-runtime',
        'prepare-evidence-files',
        'reset-runtime-state',
        'teardown-data-scale-runtime'
    ]
        .includes(action.operation))
    {
        throw new Error('lifecycle action is not locally executable');
    }
    const binding = readReleaseReliabilityEvidenceBinding({
        repositoryRoot: resolvedRoot,
        environment
    });
    if (binding === null || binding.scenarioId !== action.scenarioId)
    {
        throw new Error('lifecycle action requires the exact producer binding');
    }
    const invocationId = safeIdentifier(binding.invocationId, 'invocationId');
    const runId = safeIdentifier(binding.runId, 'runId');
    const identityPath = repositoryPath(
        resolvedRoot,
        environment.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH,
        'run identity'
    );
    const identity = JSON.parse(fs.readFileSync(identityPath.absolute, 'utf8'));
    if (identity.contentDigest !== binding.identityContentDigest
        || identity.contentDigest !== digestValue(identity))
    {
        throw new Error('run identity content digest mismatch');
    }
    const receiptPath = repositoryPath(
        resolvedRoot,
        expandLifecycleTemplate(action.expectedReceiptPath, {
            actionId: action.actionId,
            invocationId,
            runId,
            scenarioId: action.scenarioId
        }),
        'lifecycle receipt'
    );
    return {
        action,
        binding,
        contracts,
        environment,
        identity,
        identityReference: {
            path: identityPath.relative,
            contentDigest: identity.contentDigest
        },
        invocationId,
        receiptPath,
        repositoryRoot: resolvedRoot,
        runId,
        scenarioId: action.scenarioId
    };
}

export async function runLifecycleAction({
    actionId,
    repositoryRoot = root,
    environment = process.env,
    observeState = observeLifecycleAction,
    dependencies = {}
})
{
    const context = lifecycleContext({
        actionId,
        repositoryRoot,
        environment
    });
    const startedAt = new Date().toISOString();
    const before = context.action.operation === 'provision-data-scale-runtime'
        ? { runtime: { status: 'absent' } }
        : await observeState(context, dependencies);
    const operation = {
        kind: context.action.operation,
        deleted: [],
        ...(['observe-mutation', 'cleanup-mutation-output']
            .includes(context.action.operation)
            && context.action.phase !== 'precondition'
            ? {
                baselineReceipt: (() =>
                {
                    const baseline = mutationBaseline(context);
                    return {
                        path: baseline.path,
                        bytesDigest: baseline.bytesDigest,
                        contentDigest: baseline.contentDigest,
                        inventoryDigest:
                            baseline.document.observations.after.productionBuild
                                .inventoryDigest
                    };
                })()
            }
            : {}),
        ...(['observe-runtime', 'reset-runtime-state'].includes(context.action.operation)
            && context.action.phase !== 'precondition'
            ? {
                runtimeBaselineReceipt: (() =>
                {
                    try
                    {
                        const baseline = runtimeBaseline(context);
                        return {
                            path: baseline.path,
                            bytesDigest: baseline.bytesDigest,
                            contentDigest: baseline.contentDigest,
                            resourceCounters:
                                baseline.document.observations.after.resourceCounters,
                            backend: baseline.document.observations.after.backend,
                            network: baseline.document.observations.after.network
                        };
                    }
                    catch (error)
                    {
                        if (!context.action.safeAfterFailure)
                        {
                            throw error;
                        }
                        return null;
                    }
                })()
            }
            : {}),
        ...(context.action.operation === 'teardown-data-scale-runtime'
            ? {
                dataScaleRuntimeReceipt: (() =>
                {
                    const baseline = dataScaleRuntimeBaseline(context);
                    return {
                        path: baseline.path,
                        bytesDigest: baseline.bytesDigest,
                        contentDigest: baseline.contentDigest,
                        dataScaleRunId:
                            baseline.document.ownerReceipt.dataScaleRunId
                    };
                })()
            }
            : {})
    };
    if (['prepare-evidence-files', 'reset-runtime-state'].includes(context.action.operation))
    {
        for (const target of context.action.targets ?? [])
        {
            const resolved = repositoryPath(
                context.repositoryRoot,
                target,
                'evidence preparation target'
            );
            const existed = fs.existsSync(resolved.absolute);
            if (existed)
            {
                fs.rmSync(resolved.absolute, { recursive: true, force: true });
            }
            operation.deleted.push({ path: resolved.relative, existed });
        }
    }
    if (context.action.operation === 'reset-runtime-state')
    {
        const topology = context.identity.fixture?.topology?.content;
        try
        {
            operation.publicCacheReset = await resetDockerPublicCache({
                container: topology?.redis?.instance, runId: context.runId,
                namespace: topology?.namespace,
                namespacePrefix: topology?.runtime?.environmentProjection?.effective
                    ?.RedisOptions__InstanceName
            });
        }
        catch
        {
            operation.publicCacheReset = { status: 'failed',
                reason: 'run-bound public cache reset failed' };
        }
    }
    if (context.action.operation === 'cleanup-mutation-output')
    {
        const mutationOutput = repositoryPath(
            context.repositoryRoot,
            '.tmp/mutation/backend-critical',
            'mutation output cleanup target'
        );
        const existed = fs.existsSync(mutationOutput.absolute);
        fs.rmSync(mutationOutput.absolute, { recursive: true, force: true });
        operation.deleted.push({
            path: mutationOutput.relative,
            existed
        });
    }
    if (context.action.operation === 'provision-data-scale-runtime')
    {
        const { provisionDataScaleRuntime } = await import(
            './data-scale-runtime-owner.mjs'
        );
        const produced = await provisionDataScaleRuntime({
            repositoryRoot: context.repositoryRoot,
            identity: context.identity,
            environment: context.environment,
            runtimeAdmission: dependencies.dataScaleRuntimeAdmission,
            execute: dependencies.spawnProcess,
            fetchImpl: dependencies.fetchImpl,
            wait: dependencies.wait,
            now: dependencies.now
        });
        context.environment.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH =
            produced.receiptPath;
        context.environment.FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH =
            produced.planPath;
        operation.ownerProducer = {
            runtimeReceipt: produced.receiptPath,
            runtimePlan: produced.planPath
        };
    }
    if (context.action.operation === 'teardown-data-scale-runtime')
    {
        const { teardownDataScaleRuntime } = await import(
            './data-scale-runtime-owner.mjs'
        );
        const planPath = repositoryPath(
            context.repositoryRoot,
            context.environment.FSUSBLOG_DATA_SCALE_RUNTIME_PLAN_PATH,
            'data-scale runtime plan'
        );
        const runtimePath = repositoryPath(
            context.repositoryRoot,
            context.environment.FSUSBLOG_DATA_SCALE_RUNTIME_RECEIPT_PATH,
            'data-scale runtime receipt'
        );
        const produced = await teardownDataScaleRuntime({
            repositoryRoot: context.repositoryRoot,
            plan: JSON.parse(fs.readFileSync(planPath.absolute, 'utf8')),
            runtimeReceipt: JSON.parse(
                fs.readFileSync(runtimePath.absolute, 'utf8')
            ),
            identity: context.identity,
            environment: context.environment,
            execute: dependencies.spawnProcess,
            now: dependencies.now
        });
        context.environment.FSUSBLOG_DATA_SCALE_TEARDOWN_RECEIPT_PATH =
            produced.receiptPath;
        operation.ownerProducer = { teardownReceipt: produced.receiptPath };
    }
    const after = await observeState(context, dependencies);
    const ownerReceipt = after.ownerReceipt
        ? {
            path: after.ownerReceipt.path,
            bytesDigest: after.ownerReceipt.bytesDigest,
            contentDigest: after.ownerReceipt.contentDigest,
            schema: after.ownerReceipt.schema,
            dataScaleRunId: after.ownerReceipt.dataScaleRunId,
            parentSchedulerRunId: after.ownerReceipt.parentSchedulerRunId,
            invocationId: after.ownerReceipt.document.invocationId,
            attemptId: after.ownerReceipt.document.attemptId
        }
        : null;
    if (after.ownerReceipt)
    {
        delete before.ownerReceipt;
        delete after.ownerReceipt;
    }
    const errors = observationErrors(context.action, after, context, operation);
    if (Object.hasOwn(operation, 'runtimeBaselineReceipt')
        && operation.runtimeBaselineReceipt === null)
    {
        errors.push('runtime baseline receipt is unavailable; safe cleanup was still attempted');
    }
    if (operation.baselineReceipt
        && operation.baselineReceipt.inventoryDigest
            !== after.productionBuild?.inventoryDigest)
    {
        errors.push('mutation production-build inventory changed');
    }
    const finalObservation = {
        status: errors.length === 0 ? 'passed' : 'failed',
        postStateDigest: digestValue({ state: after }),
        failures: errors
    };
    const receipt = sealDocument({
        schema: context.contracts.registry.receiptSchema,
        status: errors.length === 0 ? 'passed' : 'failed',
        actionId: context.action.actionId,
        phase: context.action.phase,
        scenarioId: context.scenarioId,
        invocationId: context.invocationId,
        runId: context.runId,
        identity: context.identityReference,
        stateDomains: context.action.stateDomains,
        operation,
        observations: {
            before,
            after
        },
        ...(ownerReceipt === null ? {} : { ownerReceipt }),
        finalObservation,
        startedAt,
        finishedAt: new Date().toISOString()
    });
    writeJsonAtomic(context.receiptPath.absolute, receipt);
    return receipt;
}

function parseArguments(argv)
{
    const [command, ...rest] = argv;
    if (command !== 'execute-action')
    {
        throw new Error('release reliability lifecycle command is invalid');
    }
    let actionId = null;
    for (let index = 0; index < rest.length; index += 1)
    {
        if (rest[index] === '--action-id')
        {
            actionId = rest[++index];
        }
        else
        {
            throw new Error(`unknown lifecycle argument: ${rest[index]}`);
        }
    }
    return { actionId };
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const receipt = await runLifecycleAction(options);
    if (receipt.status !== 'passed')
    {
        process.exitCode = 1;
    }
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(
            `[release-reliability-lifecycle] ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        process.exitCode = 1;
    });
}
