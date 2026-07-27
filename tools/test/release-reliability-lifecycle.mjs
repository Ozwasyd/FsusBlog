#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { readReleaseReliabilityEvidenceBinding } from './release-reliability-evidence-binding.mjs';
import { digestValue, sealDocument } from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogRelativePath = 'config/testing/release-reliability-scenario-catalog.json';
const lifecycleSchema = 'fsusblog.release-reliability-lifecycle-action.v1';
const markerSchema = 'fsusblog.release-reliability-measurement-start.v1';
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const runtimeDomains = new Set(['network', 'performance-counters', 'resource-counters', 'runtime-http']);
const databaseDomains = new Set(['database', 'fixture-data']);

const resetTargetsByScenario = {
    'release-soak-min': [
        '.tmp/soak/short/summary.json'
    ],
    'release-load-peak': [
        '.tmp/perf/load-expected-peak/summary.json',
        '.tmp/perf/release-summaries/load-expected-peak.json'
    ],
    'release-load-burst': [
        '.tmp/perf/load-burst/summary.json',
        '.tmp/perf/release-summaries/load-burst.json'
    ],
    'release-data-scale-m': [
        '.tmp/scale/scale-m/seed.json',
        '.tmp/scale/scale-m/summary.json',
        '.tmp/scale/scale-m/cleanup.json',
        '.tmp/scale/scale-m/artifact-rebuild.json',
        '.tmp/scale/release-summaries/scale-m.json'
    ],
    'release-mutation-critical-slice': [
        '.tmp/mutation/backend-critical'
    ],
    'release-memory-leak-budget': [
        '.tmp/release-resource-budget/memory-leak.json',
        '.tmp/release-evidence/memory-leak-summary.json'
    ],
    'release-open-handle-budget': [
        '.tmp/release-resource-budget/open-handle.json',
        '.tmp/release-evidence/open-handle-summary.json'
    ]
};

function safeIdentifier(value, label)
{
    const normalized = String(value ?? '').trim();
    if (!safeIdentifierPattern.test(normalized))
    {
        throw new Error(`${label} is invalid`);
    }
    return normalized;
}

function normalizedRelativePath(value, label)
{
    const normalized = String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//u, '');
    const segments = normalized.split('/');
    if (!normalized || path.posix.isAbsolute(normalized)
        || path.posix.normalize(normalized) !== normalized
        || segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
    {
        throw new Error(`${label} is unsafe`);
    }
    return normalized;
}

function repositoryPath(repositoryRoot, value, label)
{
    const relative = normalizedRelativePath(value, label);
    const absolute = path.resolve(repositoryRoot, relative);
    if (absolute === repositoryRoot || !absolute.startsWith(`${repositoryRoot}${path.sep}`))
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

function sha256(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

function readCatalog(repositoryRoot)
{
    const file = repositoryPath(repositoryRoot, catalogRelativePath, 'scenario catalog').absolute;
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (catalog?.schema !== 'fsusblog.release-reliability-scenario-catalog.v3'
        || catalog.lifecycleSchema !== lifecycleSchema
        || !Array.isArray(catalog.scenarios))
    {
        throw new Error('release reliability scenario catalog is invalid');
    }
    return catalog;
}

function stateDomains(scenario)
{
    return [...new Set([
        ...scenario.isolation.exclusiveResources,
        ...scenario.isolation.countableResources
    ])].sort();
}

function lifecycleContext({
    repositoryRoot = root,
    environment = process.env
} = {})
{
    const resolvedRoot = path.resolve(repositoryRoot);
    const binding = readReleaseReliabilityEvidenceBinding({
        repositoryRoot: resolvedRoot,
        environment
    });
    if (binding === null)
    {
        throw new Error('release reliability lifecycle requires a producer binding');
    }
    const invocationId = safeIdentifier(binding.invocationId, 'invocationId');
    const runId = safeIdentifier(binding.runId, 'runId');
    const scenarioId = safeIdentifier(binding.scenarioId, 'scenarioId');
    const expectedRoot = `.tmp/release-reliability/${invocationId}/lifecycle/${scenarioId}`;
    const configuredRoot = normalizedRelativePath(
        environment.FSUSBLOG_RELEASE_RELIABILITY_LIFECYCLE_ROOT,
        'lifecycle root'
    );
    if (configuredRoot !== expectedRoot)
    {
        throw new Error('release reliability lifecycle root is not canonical');
    }
    const catalog = readCatalog(resolvedRoot);
    const scenario = catalog.scenarios.find((candidate) => candidate.id === scenarioId);
    if (!scenario || !resetTargetsByScenario[scenarioId])
    {
        throw new Error('release reliability lifecycle scenario is unavailable');
    }
    const lifecycleRoot = repositoryPath(resolvedRoot, configuredRoot, 'lifecycle root').absolute;
    const identityPath = repositoryPath(
        resolvedRoot,
        environment.FSUSBLOG_RELEASE_RELIABILITY_IDENTITY_PATH,
        'run identity'
    );
    const identity = JSON.parse(fs.readFileSync(identityPath.absolute, 'utf8'));
    return {
        repositoryRoot: resolvedRoot,
        environment,
        invocationId,
        runId,
        scenarioId,
        binding,
        identity,
        identityReference: {
            path: identityPath.relative,
            contentDigest: binding.identityContentDigest
        },
        scenario,
        stateDomains: stateDomains(scenario),
        lifecycleRoot,
        resetTargets: resetTargetsByScenario[scenarioId]
    };
}

function inspectOutput(context, relativePath)
{
    const resolved = repositoryPath(context.repositoryRoot, relativePath, 'producer output');
    if (!fs.existsSync(resolved.absolute))
    {
        return { path: resolved.relative, status: 'absent' };
    }
    const stat = fs.lstatSync(resolved.absolute);
    if (stat.isSymbolicLink())
    {
        throw new Error(`producer output is a symlink: ${resolved.relative}`);
    }
    if (stat.isFile())
    {
        return {
            path: resolved.relative,
            status: 'file',
            sizeBytes: stat.size,
            fileDigest: sha256(fs.readFileSync(resolved.absolute))
        };
    }
    if (stat.isDirectory())
    {
        return {
            path: resolved.relative,
            status: 'directory',
            directEntryCount: fs.readdirSync(resolved.absolute).length
        };
    }
    return { path: resolved.relative, status: 'other' };
}

function inspectDockerContainer(containerId, spawnProcess, repositoryRoot)
{
    if (!/^[0-9a-f]{64}$/u.test(String(containerId ?? '')))
    {
        return { status: 'unavailable', reason: 'container identity is unavailable' };
    }
    const inspected = spawnProcess('docker', ['inspect', containerId], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024
    });
    if (inspected.status !== 0)
    {
        return { status: 'unavailable', reason: 'container inspection failed' };
    }
    try
    {
        const [container] = JSON.parse(inspected.stdout || '[]');
        if (container?.Id !== containerId)
        {
            return { status: 'unavailable', reason: 'container identity changed' };
        }
        return {
            status: container.State?.Running === true ? 'running' : 'stopped',
            id: container.Id,
            image: container.Image ?? null,
            hostPid: Number.isInteger(container.State?.Pid) ? container.State.Pid : null,
            startedAt: container.State?.StartedAt ?? null,
            exitCode: Number.isInteger(container.State?.ExitCode) ? container.State.ExitCode : null,
            oomKilled: container.State?.OOMKilled === true
        };
    }
    catch
    {
        return { status: 'unavailable', reason: 'container inspection was not JSON' };
    }
}

async function inspectRuntime(context, { spawnProcess, fetchImpl })
{
    const containerId = String(
        context.environment.FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID ?? ''
    ).trim();
    const expectedHostPid = Number.parseInt(
        String(context.environment.FSUSBLOG_RELEASE_RESOURCE_PID ?? ''),
        10
    );
    const container = inspectDockerContainer(
        containerId,
        spawnProcess,
        context.repositoryRoot
    );
    const baseUrl = String(
        context.environment.FSUSBLOG_BASE_URL
        ?? context.environment.FSUSBLOG_DEBUG_BACKEND_URL
        ?? ''
    ).trim().replace(/\/$/u, '');
    let live = { status: 'unavailable', reason: 'runtime base URL is unavailable' };
    if (baseUrl)
    {
        try
        {
            const response = await fetchImpl(`${baseUrl}/health/live`, {
                headers: { Accept: 'application/json' },
                signal: AbortSignal.timeout(3_000)
            });
            const document = response.ok ? await response.json() : null;
            live = {
                status: response.ok && document?.status === 'live' ? 'live' : 'failed',
                httpStatus: response.status,
                reportStatus: document?.status ?? null
            };
        }
        catch
        {
            live = { status: 'unavailable', reason: 'runtime live probe failed' };
        }
    }
    return {
        expectedContainerId: containerId || null,
        expectedHostPid: Number.isInteger(expectedHostPid) ? expectedHostPid : null,
        container,
        live
    };
}

function inspectResourceCounters(context, spawnProcess)
{
    const containerId = String(
        context.environment.FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID ?? ''
    ).trim();
    if (!/^[0-9a-f]{64}$/u.test(containerId))
    {
        return { status: 'unavailable', reason: 'resource container identity is unavailable' };
    }
    const result = spawnProcess('docker', [
        'exec',
        containerId,
        'sh',
        '-c',
        `rss=$(awk '/^VmRSS:/ { print $2 * 1024; found=1 } END { if (!found) exit 1 }' /proc/1/status) || exit 1; count=0; for descriptor in /proc/1/fd/*; do [ -e "$descriptor" ] || continue; count=$((count + 1)); done; printf '%s %s\\n' "$rss" "$count"`
    ], {
        cwd: context.repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024
    });
    const match = String(result.stdout ?? '').trim().match(/^(\d+)\s+(\d+)$/u);
    if (result.status !== 0 || !match)
    {
        return { status: 'unavailable', reason: 'resource counter read failed' };
    }
    return {
        status: 'observed',
        rssBytes: Number(match[1]),
        openFileDescriptors: Number(match[2])
    };
}

function inspectSourceState(context, spawnProcess)
{
    const commit = spawnProcess('git', ['rev-parse', 'HEAD'], {
        cwd: context.repositoryRoot,
        encoding: 'utf8'
    });
    const status = spawnProcess('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: context.repositoryRoot,
        encoding: 'utf8'
    });
    return {
        commit: commit.status === 0 ? commit.stdout.trim() : null,
        trackedDirty: status.status === 0 ? status.stdout.trim() !== '' : null
    };
}

function inspectDataScaleCleanup(context)
{
    if (context.scenarioId !== 'release-data-scale-m')
    {
        return null;
    }
    const file = repositoryPath(
        context.repositoryRoot,
        '.tmp/scale/scale-m/cleanup.json',
        'data scale cleanup'
    ).absolute;
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile())
    {
        return { status: 'absent', remaining: null };
    }
    try
    {
        const cleanup = JSON.parse(fs.readFileSync(file, 'utf8'));
        return {
            status: cleanup.status ?? 'invalid',
            remaining: cleanup.remaining ?? null
        };
    }
    catch
    {
        return { status: 'invalid', remaining: null };
    }
}

export async function observeLifecycleState(
    context,
    {
        spawnProcess = spawnSync,
        fetchImpl = fetch
    } = {}
)
{
    const includesRuntime = context.stateDomains.some((domain) => runtimeDomains.has(domain));
    const includesDatabase = context.stateDomains.some((domain) => databaseDomains.has(domain));
    const topology = context.identity.fixture?.topology?.content;
    return {
        observedAt: new Date().toISOString(),
        domains: context.stateDomains,
        outputs: context.resetTargets.map((target) => inspectOutput(context, target)),
        ...(includesRuntime
            ? { runtime: await inspectRuntime(context, { spawnProcess, fetchImpl }) }
            : {}),
        ...(includesDatabase
            ? {
                database: {
                    postgres: inspectDockerContainer(
                        topology?.postgres?.instance,
                        spawnProcess,
                        context.repositoryRoot
                    ),
                    redis: inspectDockerContainer(
                        topology?.redis?.instance,
                        spawnProcess,
                        context.repositoryRoot
                    )
                }
            }
            : {}),
        ...(context.stateDomains.includes('resource-counters')
            ? { resourceCounters: inspectResourceCounters(context, spawnProcess) }
            : {}),
        ...(context.stateDomains.some((domain) => ['build-artifacts', 'cpu'].includes(domain))
            ? {
                source: inspectSourceState(context, spawnProcess),
                cpu: {
                    logicalProcessors: os.cpus().length,
                    loadAverage1m: Number(os.loadavg()[0].toFixed(3))
                }
            }
            : {}),
        dataScaleCleanup: inspectDataScaleCleanup(context)
    };
}

function requireReadyState(context, state, phase)
{
    const errors = [];
    if (context.stateDomains.some((domain) => runtimeDomains.has(domain)))
    {
        const runtime = state.runtime;
        if (runtime?.container?.status !== 'running'
            || runtime.container.id !== runtime.expectedContainerId
            || runtime.container.hostPid !== runtime.expectedHostPid
            || runtime.live?.status !== 'live')
        {
            errors.push('runtime identity or live probe is unavailable');
        }
    }
    if (context.stateDomains.some((domain) => databaseDomains.has(domain))
        && (state.database?.postgres?.status !== 'running'
            || state.database?.redis?.status !== 'running'))
    {
        errors.push('database fixture containers are unavailable');
    }
    if (context.stateDomains.includes('resource-counters')
        && state.resourceCounters?.status !== 'observed')
    {
        errors.push('runtime resource counters are unavailable');
    }
    if (context.stateDomains.includes('build-artifacts')
        && (state.source?.commit !== context.binding.sourceState.commit
            || state.source?.trackedDirty !== false))
    {
        errors.push('build source state is not clean and current');
    }
    if (phase === 'postcondition' && context.scenarioId === 'release-data-scale-m')
    {
        const cleanup = state.dataScaleCleanup;
        if (cleanup?.status !== 'ok'
            || !cleanup.remaining
            || Object.values(cleanup.remaining).some((value) => value !== 0))
        {
            errors.push('data-scale namespace cleanup is incomplete');
        }
    }
    return errors;
}

function deleteResetTargets(context)
{
    const deleted = [];
    for (const target of context.resetTargets)
    {
        const resolved = repositoryPath(context.repositoryRoot, target, 'reset target');
        const existed = fs.existsSync(resolved.absolute);
        if (existed)
        {
            fs.rmSync(resolved.absolute, { recursive: true, force: true });
        }
        deleted.push({ path: resolved.relative, existed });
    }
    return deleted;
}

function dataScaleReset(context, spawnProcess)
{
    if (context.scenarioId !== 'release-data-scale-m')
    {
        return null;
    }
    const result = spawnProcess('bash', ['tools/data-scale/cleanup.sh', 'scale-m'], {
        cwd: context.repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: context.environment
    });
    const cleanupFile = repositoryPath(
        context.repositoryRoot,
        '.tmp/scale/scale-m/cleanup.json',
        'data scale reset summary'
    ).absolute;
    let cleanup = null;
    if (fs.existsSync(cleanupFile) && fs.lstatSync(cleanupFile).isFile())
    {
        cleanup = JSON.parse(fs.readFileSync(cleanupFile, 'utf8'));
    }
    if (result.status !== 0 || cleanup?.status !== 'ok'
        || !cleanup.remaining
        || Object.values(cleanup.remaining).some((value) => value !== 0))
    {
        throw new Error('data-scale namespace reset failed');
    }
    fs.rmSync(cleanupFile, { force: true });
    return {
        status: cleanup.status,
        strategy: cleanup.strategy ?? null,
        remaining: cleanup.remaining
    };
}

export async function performDefaultReset(
    context,
    { spawnProcess = spawnSync } = {}
)
{
    const deleted = deleteResetTargets(context);
    const dataScale = dataScaleReset(context, spawnProcess);
    return {
        action: 'delete-scenario-owned-output-and-reset-scenario-state',
        deleted,
        ...(dataScale === null ? {} : { dataScale })
    };
}

function receiptFile(context, phase)
{
    return path.join(context.lifecycleRoot, `${phase}.json`);
}

function measurementMarkerFile(context)
{
    return path.join(context.lifecycleRoot, '.measurement-start.json');
}

function phaseReceipt({
    context,
    phase,
    status,
    before,
    after,
    observations,
    startedAt,
    finishedAt
})
{
    return sealDocument({
        schema: lifecycleSchema,
        status,
        phase,
        scenarioId: context.scenarioId,
        invocationId: context.invocationId,
        runId: context.runId,
        identity: context.identityReference,
        declaration: context.scenario.isolation.lifecycle[phase],
        stateDomains: context.stateDomains,
        state: {
            before: digestValue({ state: before }),
            after: digestValue({ state: after })
        },
        observations,
        startedAt,
        finishedAt
    });
}

export async function runLifecycleCommand({
    command,
    phase = null,
    producerStatus = 0,
    repositoryRoot = root,
    environment = process.env,
    observeState = observeLifecycleState,
    resetState = performDefaultReset,
    dependencies = {}
})
{
    const context = lifecycleContext({ repositoryRoot, environment });
    if (command === 'phase')
    {
        if (!['precondition', 'reset', 'postcondition'].includes(phase))
        {
            throw new Error('lifecycle phase command is invalid');
        }
        const startedAt = new Date().toISOString();
        const before = await observeState(context, dependencies);
        let action = { action: `observe-${phase}-state` };
        let errors = phase === 'reset' ? [] : requireReadyState(context, before, phase);
        if (phase === 'reset')
        {
            action = await resetState(context, dependencies);
        }
        const after = await observeState(context, dependencies);
        if (phase === 'reset')
        {
            errors = [
                ...errors,
                ...after.outputs
                    .filter((output) => output.status !== 'absent')
                    .map((output) => `reset target remains: ${output.path}`),
                ...requireReadyState(context, after, phase)
            ];
        }
        else if (phase === 'postcondition' && producerStatus !== 0)
        {
            errors.push(`producer exited with status ${producerStatus}`);
        }
        const status = errors.length === 0 ? 'complete' : 'failed';
        const receipt = phaseReceipt({
            context,
            phase,
            status,
            before,
            after,
            observations: {
                action,
                checks: errors.length === 0 ? ['state requirements satisfied'] : errors
            },
            startedAt,
            finishedAt: new Date().toISOString()
        });
        writeJsonAtomic(receiptFile(context, phase), receipt);
        return receipt;
    }
    if (command === 'start-measurement')
    {
        const markerFile = measurementMarkerFile(context);
        if (fs.existsSync(markerFile))
        {
            throw new Error('measurement start marker already exists');
        }
        const before = await observeState(context, dependencies);
        const errors = requireReadyState(context, before, 'measurement');
        if (errors.length > 0)
        {
            throw new Error(`measurement precondition failed: ${errors.join('; ')}`);
        }
        const marker = sealDocument({
            schema: markerSchema,
            status: 'started',
            scenarioId: context.scenarioId,
            invocationId: context.invocationId,
            runId: context.runId,
            identity: context.identityReference,
            stateDomains: context.stateDomains,
            stateBefore: before,
            startedAt: new Date().toISOString()
        });
        writeJsonAtomic(markerFile, marker);
        return marker;
    }
    if (command === 'finish-measurement')
    {
        const markerFile = measurementMarkerFile(context);
        if (!fs.existsSync(markerFile) || !fs.lstatSync(markerFile).isFile()
            || fs.lstatSync(markerFile).isSymbolicLink())
        {
            throw new Error('measurement start marker is unavailable');
        }
        const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
        if (marker.schema !== markerSchema || marker.status !== 'started'
            || marker.scenarioId !== context.scenarioId
            || marker.invocationId !== context.invocationId
            || marker.runId !== context.runId
            || marker.contentDigest !== digestValue(marker))
        {
            throw new Error('measurement start marker is invalid');
        }
        const after = await observeState(context, dependencies);
        const errors = producerStatus === 0
            ? requireReadyState(context, after, 'measurement')
            : [`producer exited with status ${producerStatus}`];
        const evidence = inspectOutput(context, context.scenario.authoritativeEvidence.path);
        if (producerStatus === 0 && evidence.status !== 'file')
        {
            errors.push('authoritative evidence is unavailable after measurement');
        }
        const status = errors.length === 0 ? 'complete' : 'failed';
        const receipt = phaseReceipt({
            context,
            phase: 'measurement',
            status,
            before: marker.stateBefore,
            after,
            observations: {
                action: {
                    action: 'execute-catalog-declared-producer-window',
                    producerStatus,
                    evidence
                },
                checks: errors.length === 0 ? ['measurement window completed'] : errors
            },
            startedAt: marker.startedAt,
            finishedAt: new Date().toISOString()
        });
        writeJsonAtomic(receiptFile(context, 'measurement'), receipt);
        fs.rmSync(markerFile, { force: true });
        return receipt;
    }
    throw new Error('release reliability lifecycle command is invalid');
}

function parseArguments(argv)
{
    const [command, ...rest] = argv;
    let phase = null;
    let producerStatus = 0;
    for (let index = 0; index < rest.length; index += 1)
    {
        const value = rest[index];
        if (value === '--phase')
        {
            phase = rest[++index];
        }
        else if (value === '--producer-status')
        {
            producerStatus = Number.parseInt(rest[++index], 10);
        }
        else
        {
            throw new Error(`unknown lifecycle argument: ${value}`);
        }
    }
    if (!Number.isInteger(producerStatus) || producerStatus < 0 || producerStatus > 255)
    {
        throw new Error('producer status is invalid');
    }
    return { command, phase, producerStatus };
}

async function main()
{
    const options = parseArguments(process.argv.slice(2));
    const receipt = await runLifecycleCommand(options);
    if (receipt.status === 'failed')
    {
        process.exitCode = 1;
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    main().catch((error) =>
    {
        console.error(
            `[release-reliability-lifecycle] ${error instanceof Error ? error.message : String(error)}`
        );
        process.exitCode = 1;
    });
}
