#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateMeasurementNoiseReceipt } from './measurement-noise-envelope.mjs';
import {
    expandLifecycleTemplate,
    loadLifecycleActionContracts
} from './release-reliability-lifecycle-actions.mjs';
import { digestValue } from './release-reliability-receipt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const isoTimePattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function rawDigest(bytes)
{
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function safeRelativePath(repositoryRoot, value, label)
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

function requireIsoTime(value, label)
{
    if (!isoTimePattern.test(String(value ?? ''))
        || !Number.isFinite(Date.parse(value)))
    {
        throw new Error(`${label} is not an ISO UTC time`);
    }
}

function requireFields(document, fields)
{
    const missing = fields.filter((field) => !Object.hasOwn(document, field));
    if (missing.length > 0)
    {
        throw new Error(`action receipt is missing required fields: ${missing.join(', ')}`);
    }
}

function verifyContentDigest(document)
{
    if (!digestPattern.test(String(document.contentDigest ?? ''))
        || document.contentDigest !== digestValue(document))
    {
        throw new Error('action receipt content digest mismatch');
    }
}

function requireExactKeys(document, keys, label)
{
    const actual = Object.keys(document).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
    {
        throw new Error(`${label} top-level fields mismatch`);
    }
}

function requireDigest(value, label)
{
    if (!digestPattern.test(String(value ?? '')))
    {
        throw new Error(`${label} digest is invalid`);
    }
}

function requireNonEmptyObject(value, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length === 0)
    {
        throw new Error(`${label} must be a non-empty object`);
    }
}

function requireExactItemKeys(value, keys, label)
{
    requireNonEmptyObject(value, label);
    requireExactKeys(value, keys, label);
}

export function verifyDataScaleOwnerReceipt({
    repositoryRoot = root,
    ownerReceipt,
    receiptPath,
    identity,
    runId,
    invocationId,
    attemptId,
    expectedBytesDigest = null
})
{
    const resolved = safeRelativePath(
        path.resolve(repositoryRoot),
        receiptPath,
        'data-scale owner receipt'
    );
    if (!fs.existsSync(resolved.absolute)
        || !fs.lstatSync(resolved.absolute).isFile())
    {
        throw new Error('data-scale owner receipt is missing');
    }
    const bytes = fs.readFileSync(resolved.absolute);
    const bytesDigest = rawDigest(bytes);
    if (expectedBytesDigest !== null && bytesDigest !== expectedBytesDigest)
    {
        throw new Error('data-scale owner receipt bytes digest mismatch');
    }
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch
    {
        throw new Error('data-scale owner receipt is not structured JSON');
    }
    if (ownerReceipt === 'data-scale-runtime')
    {
        requireExactKeys(document, [
            'aotRoot',
            'backend',
            'buildReceiptDigest',
            'contentDigest',
            'connections',
            'createdAt',
            'dataRoot',
            'dataScaleRunId',
            'envManifestDigest',
            'fixtureIdentityDigest',
            'hotReadRoot',
            'imageDigest',
            'invocationId',
            'lifecycle',
            'namespace',
            'network',
            'parentSchedulerRunId',
            'permissionHelper',
            'postgres',
            'redis',
            'schema',
            'searchRoot',
            'seedReceiptDigest',
            'seedReceiptPath',
            'seedSummary',
            'sourceCommit',
            'attemptId',
            'worktreeFingerprint'
        ], 'data-scale runtime receipt');
        if (document.schema !== 'fsusblog.data-scale-runtime.v2'
            || Object.hasOwn(document, 'status')
            || document.parentSchedulerRunId !== runId
            || document.invocationId !== invocationId
            || document.attemptId !== attemptId
            || document.sourceCommit !== identity.sourceState.commit
            || document.worktreeFingerprint
                !== identity.sourceState.worktreeFingerprint
            || document.buildReceiptDigest !== identity.build?.contentDigest
            || document.imageDigest !== identity.build?.imageDigest
            || document.fixtureIdentityDigest !== digestValue(identity.fixture))
        {
            throw new Error('data-scale runtime receipt identity mismatch');
        }
        for (const [value, label] of [
            [document.buildReceiptDigest, 'build receipt'],
            [document.imageDigest, 'image'],
            [document.envManifestDigest, 'environment manifest'],
            [document.fixtureIdentityDigest, 'fixture identity'],
            [document.seedReceiptDigest, 'seed receipt'],
            [document.worktreeFingerprint, 'worktree']
        ])
        {
            requireDigest(value, label);
        }
        for (const [value, label] of [
            [document.postgres, 'data-scale PostgreSQL identity'],
            [document.redis, 'data-scale Redis identity'],
            [document.backend, 'data-scale backend identity']
        ])
        {
            requireNonEmptyObject(value, label);
        }
        requireNonEmptyObject(
            document.connections,
            'data-scale backend connection identity'
        );
        requireExactItemKeys(document.postgres, [
            'containerId',
            'database',
            'imageDigest',
            'volumeId'
        ], 'data-scale PostgreSQL identity');
        requireExactItemKeys(document.redis, [
            'containerId',
            'imageDigest',
            'volumeId'
        ], 'data-scale Redis identity');
        requireExactItemKeys(document.backend, [
            'baseUrl',
            'executableOrImageDigest',
            'pidOrContainerId',
            'startTicks'
        ], 'data-scale backend identity');
        requireExactItemKeys(document.connections, [
            'postgres',
            'redis'
        ], 'data-scale backend connection identity');
        requireExactItemKeys(document.connections.postgres, [
            'applicationName',
            'backendAddress',
            'database',
            'foreignClientCount',
            'matchingClientCount'
        ], 'data-scale PostgreSQL connection identity');
        requireExactItemKeys(document.connections.redis, [
            'backendAddress',
            'clientName',
            'foreignClientCount',
            'matchingClientCount'
        ], 'data-scale Redis connection identity');
        requireExactItemKeys(document.network, ['id', 'name'],
            'data-scale network identity');
        requireExactItemKeys(document.permissionHelper, ['name', 'postExists'],
            'data-scale permission helper identity');
        requireExactItemKeys(document.lifecycle, [
            'postcondition',
            'readiness',
            'reset',
            'start'
        ], 'data-scale lifecycle state');
        requireExactItemKeys(document.seedSummary, [
            'declared',
            'expected',
            'namespace',
            'observed',
            'status',
            'tier'
        ], 'data-scale seed summary');
        const expectedClientName =
            `FsusBlogDataScale-${document.dataScaleRunId}`;
        if (!safeIdentifierPattern.test(String(document.dataScaleRunId ?? ''))
            || !safeIdentifierPattern.test(String(document.namespace ?? ''))
            || !/^[0-9a-f]{64}$/u.test(document.postgres.containerId)
            || !/^[0-9a-f]{64}$/u.test(document.redis.containerId)
            || !safeIdentifierPattern.test(String(document.postgres.volumeId ?? ''))
            || !safeIdentifierPattern.test(String(document.redis.volumeId ?? ''))
            || !/^[0-9a-f]{64}$/u.test(String(document.network.id ?? ''))
            || !safeIdentifierPattern.test(String(document.network.name ?? ''))
            || !safeIdentifierPattern.test(
                String(document.permissionHelper.name ?? '')
            )
            || document.permissionHelper.postExists !== false
            || typeof document.postgres.database !== 'string'
            || !document.postgres.database.trim()
            || document.connections.postgres.applicationName
                !== expectedClientName
            || document.connections.redis.clientName !== expectedClientName
            || document.connections.postgres.database
                !== document.postgres.database
            || document.connections.postgres.backendAddress
                !== document.connections.redis.backendAddress
            || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(
                String(document.connections.postgres.backendAddress ?? '')
            )
            || !Number.isSafeInteger(
                document.connections.postgres.matchingClientCount
            )
            || document.connections.postgres.matchingClientCount < 1
            || document.connections.postgres.foreignClientCount !== 0
            || !Number.isSafeInteger(
                document.connections.redis.matchingClientCount
            )
            || document.connections.redis.matchingClientCount < 1
            || document.connections.redis.foreignClientCount !== 0
            || !(/^[0-9a-f]{64}$/u.test(String(document.backend.pidOrContainerId))
                || Number.isInteger(document.backend.pidOrContainerId)
                    && document.backend.pidOrContainerId > 1)
            || !/^\d+$/u.test(String(document.backend.startTicks ?? ''))
            || Number(document.backend.startTicks) < 1
            || !/^https?:\/\/[^/]+/u.test(String(document.backend.baseUrl ?? ''))
            || typeof document.backend.executableOrImageDigest !== 'string'
            || !digestPattern.test(document.backend.executableOrImageDigest)
            || (/^[0-9a-f]{64}$/u.test(
                String(document.backend.pidOrContainerId)
            ) && document.backend.executableOrImageDigest !== document.imageDigest))
        {
            throw new Error('data-scale runtime resource identity is incomplete');
        }
        if (document.lifecycle.start !== 'complete'
            || document.lifecycle.reset !== 'complete'
            || document.lifecycle.readiness !== 'complete'
            || !['pending', 'complete'].includes(document.lifecycle.postcondition))
        {
            throw new Error('data-scale runtime lifecycle state is incomplete');
        }
        if (document.seedSummary.status !== 'ok'
            || document.seedSummary.tier !== 'scale-m'
            || document.seedSummary.namespace !== document.namespace
            || document.seedSummary.declared?.articles !== 10000
            || document.seedSummary.declared?.comments !== 100000
            || document.seedSummary.observed?.articles !== 10000
            || document.seedSummary.observed?.comments !== 100000)
        {
            throw new Error('data-scale seed summary does not bind scale-m');
        }
        for (const [value, label] of [
            [document.postgres.imageDigest, 'data-scale PostgreSQL image'],
            [document.redis.imageDigest, 'data-scale Redis image']
        ])
        {
            requireDigest(value, label);
        }
        const dedicatedRoots = [
            [document.aotRoot, 'data-scale AOT root'],
            [document.searchRoot, 'data-scale search root'],
            [document.hotReadRoot, 'data-scale HotRead root'],
            [document.dataRoot, 'data-scale data root']
        ];
        for (const [value, label] of dedicatedRoots)
        {
            const resolvedRoot = safeRelativePath(repositoryRoot, value, label);
            if (!resolvedRoot.relative.startsWith('.tmp/')
                || !resolvedRoot.relative.includes(document.dataScaleRunId))
            {
                throw new Error(`${label} is not dedicated to the data-scale run`);
            }
        }
        if (new Set(dedicatedRoots.map(([value]) => value)).size
            !== dedicatedRoots.length)
        {
            throw new Error('data-scale runtime roots must be distinct');
        }
        safeRelativePath(
            repositoryRoot,
            document.seedReceiptPath,
            'data-scale seed receipt'
        );
        const seedReceipt = safeRelativePath(
            repositoryRoot,
            document.seedReceiptPath,
            'data-scale seed receipt'
        );
        if (!fs.existsSync(seedReceipt.absolute)
            || !fs.lstatSync(seedReceipt.absolute).isFile()
            || rawDigest(fs.readFileSync(seedReceipt.absolute))
                !== document.seedReceiptDigest)
        {
            throw new Error('data-scale seed receipt path/digest binding mismatch');
        }
        requireIsoTime(document.createdAt, 'data-scale runtime createdAt');
    }
    else if (ownerReceipt === 'data-scale-teardown')
    {
        requireExactKeys(document, [
            'contentDigest',
            'dataScaleRunId',
            'failures',
            'invocationId',
            'leases',
            'parentSchedulerRunId',
            'ports',
            'resources',
            'roots',
            'runtimePlanDigest',
            'runtimeReceiptDigest',
            'schema',
            'sourceCommit',
            'attemptId',
            'startedAt',
            'status',
            'finishedAt'
        ], 'data-scale teardown receipt');
        if (document.schema !== 'fsusblog.data-scale-teardown.v2'
            || document.status !== 'complete'
            || document.parentSchedulerRunId !== runId
            || document.invocationId !== invocationId
            || document.attemptId !== attemptId
            || document.sourceCommit !== identity.sourceState.commit
            || !Array.isArray(document.failures)
            || document.failures.length !== 0)
        {
            throw new Error('data-scale teardown receipt identity/status mismatch');
        }
        requireDigest(document.runtimePlanDigest, 'data-scale runtime plan');
        requireDigest(document.runtimeReceiptDigest, 'data-scale runtime receipt');
        requireIsoTime(document.startedAt, 'data-scale teardown startedAt');
        requireIsoTime(document.finishedAt, 'data-scale teardown finishedAt');
        if (Date.parse(document.finishedAt) < Date.parse(document.startedAt))
        {
            throw new Error('data-scale teardown time order is invalid');
        }
        for (const field of ['resources', 'ports', 'leases', 'roots'])
        {
            if (!Array.isArray(document[field]) || document[field].length === 0)
            {
                throw new Error(`data-scale teardown ${field} must be a non-empty array`);
            }
        }
        for (const [index, resource] of document.resources.entries())
        {
            requireExactItemKeys(resource, [
                'action',
                'actionExit',
                'observedId',
                'ownershipStatus',
                'plannedId',
                'postObservation',
                'status'
            ], `data-scale teardown resource ${index}`);
            if (!resource.plannedId || resource.observedId !== resource.plannedId
                || resource.ownershipStatus !== 'owned'
                || !resource.action || resource.actionExit !== 0
                || resource.status !== 'complete'
                || !resource.postObservation
                || typeof resource.postObservation !== 'object'
                || Array.isArray(resource.postObservation)
                || !(
                    resource.postObservation.exists === false
                    || resource.postObservation.present === false
                    || resource.postObservation.memberCount === 0
                    || [
                        'absent',
                        'closed',
                        'not-found',
                        'released',
                        'removed',
                        'zero'
                    ].includes(resource.postObservation.status)
                ))
            {
                throw new Error('data-scale teardown resource final observation failed');
            }
        }
        for (const [index, port] of document.ports.entries())
        {
            requireExactItemKeys(port, [
                'port',
                'postListeningPids'
            ], `data-scale teardown port ${index}`);
            if (!Number.isInteger(port.port) || port.port < 1
                || !Array.isArray(port.postListeningPids)
                || port.postListeningPids.length !== 0)
            {
                throw new Error('data-scale teardown port remains owned');
            }
        }
        for (const [index, lease] of document.leases.entries())
        {
            requireExactItemKeys(lease, [
                'id',
                'postStatus'
            ], `data-scale teardown lease ${index}`);
            if (!lease.id || lease.postStatus !== 'released')
            {
                throw new Error('data-scale teardown lease remains held');
            }
        }
        for (const [index, rootObservation] of document.roots.entries())
        {
            requireExactItemKeys(rootObservation, [
                'path',
                'postExists'
            ], `data-scale teardown root ${index}`);
            safeRelativePath(
                repositoryRoot,
                rootObservation.path,
                'data-scale teardown root path'
            );
            if (rootObservation.postExists !== false)
            {
                throw new Error('data-scale teardown root still exists');
            }
        }
    }
    else
    {
        throw new Error('unknown data-scale owner receipt contract');
    }
    verifyContentDigest(document);
    return {
        path: resolved.relative,
        bytesDigest,
        contentDigest: document.contentDigest,
        schema: document.schema,
        dataScaleRunId: document.dataScaleRunId,
        parentSchedulerRunId: document.parentSchedulerRunId,
        sourceCommit: document.sourceCommit,
        document
    };
}

function verifyFinalObservation(document)
{
    if (!document.finalObservation
        || document.finalObservation.status !== 'passed'
        || !digestPattern.test(
            String(document.finalObservation.postStateDigest ?? '')
        )
        || !document.observations
        || document.finalObservation.postStateDigest !== digestValue({
            state: document.observations.after
        }))
    {
        throw new Error('action receipt final post-observation failed');
    }
}

function rereadBoundReceipt(repositoryRoot, binding, label)
{
    if (!binding || !binding.path || !binding.bytesDigest
        || !binding.contentDigest)
    {
        throw new Error(`${label} binding is incomplete`);
    }
    const resolved = safeRelativePath(repositoryRoot, binding.path, label);
    const bytes = fs.readFileSync(resolved.absolute);
    if (rawDigest(bytes) !== binding.bytesDigest)
    {
        throw new Error(`${label} bytes digest mismatch`);
    }
    const document = JSON.parse(bytes.toString('utf8'));
    if (document.contentDigest !== binding.contentDigest
        || document.contentDigest !== digestValue(document))
    {
        throw new Error(`${label} content digest mismatch`);
    }
    return document;
}

export function verifyMeasurementProcessTreeBinding({
    repositoryRoot,
    binding,
    actionReceipt,
    scenario,
    identity
})
{
    const measurementActionId = scenario.isolation.lifecycle.measurement;
    const expectedPath =
        `.tmp/release-reliability/${actionReceipt.invocationId}/process-trees/` +
        `${scenario.id}/${measurementActionId}.json`;
    if (binding?.status !== 'zero' || binding.path !== expectedPath
        || binding.actionId !== measurementActionId
        || binding.schema
            !== 'fsusblog.release-reliability-process-tree-receipt.v1')
    {
        throw new Error('measurement descendant receipt binding is incomplete');
    }
    const resolved = safeRelativePath(
        repositoryRoot,
        binding.path,
        'measurement process-tree receipt'
    );
    const bytes = fs.readFileSync(resolved.absolute);
    if (rawDigest(bytes) !== binding.bytesDigest)
    {
        throw new Error('measurement process-tree receipt bytes changed');
    }
    const receipt = JSON.parse(bytes.toString('utf8'));
    if (receipt.schema !== binding.schema
        || receipt.invocationId !== actionReceipt.invocationId
        || receipt.runId !== actionReceipt.runId
        || receipt.scenarioId !== scenario.id
        || receipt.actionId !== measurementActionId
        || receipt.phase !== 'measurement'
        || JSON.stringify(receipt.identity)
            !== JSON.stringify(actionReceipt.identity)
        || JSON.stringify(receipt.physicalPolicy)
            !== JSON.stringify(identity.policy?.physicalExecution)
        || receipt.contentDigest !== binding.contentDigest
        || receipt.contentDigest !== digestValue(receipt))
    {
        throw new Error('measurement process-tree receipt identity/content changed');
    }
    const policy = safeRelativePath(
        repositoryRoot,
        receipt.physicalPolicy.path,
        'physical execution policy'
    );
    const policyBytes = fs.readFileSync(policy.absolute);
    if (rawDigest(policyBytes) !== receipt.physicalPolicy.fileDigest
        || JSON.stringify(binding.physicalPolicy)
            !== JSON.stringify(receipt.physicalPolicy)
        || JSON.stringify(receipt.processTree?.policy)
            !== JSON.stringify(JSON.parse(policyBytes.toString('utf8'))))
    {
        throw new Error('measurement process-tree policy binding changed');
    }
    if (binding.postObservation !== 'zero-members'
        || receipt.processTree?.postObservation !== 'zero-members'
        || receipt.logComplete !== true
        || receipt.processTree?.logComplete !== true)
    {
        throw new Error('measurement descendant zero-state is unproved');
    }
}

export function verifyDataScaleTeardownRuntimeBinding({
    runtimeReceipt,
    teardownReceipt,
    operationBinding,
    expectedRuntimeActionId
})
{
    if (runtimeReceipt?.actionId !== expectedRuntimeActionId
        || runtimeReceipt.ownerReceipt?.dataScaleRunId
            !== teardownReceipt?.dataScaleRunId
        || operationBinding?.dataScaleRunId
            !== teardownReceipt?.dataScaleRunId
        || runtimeReceipt?.ownerReceipt?.contentDigest
            !== teardownReceipt?.runtimeReceiptDigest)
    {
        throw new Error('data-scale teardown targets another runtime owner');
    }
}

function verifyLifecycleOperation({
    repositoryRoot,
    action,
    scenario,
    document,
    identity,
    ownerDocument = null
})
{
    if (document.operation?.kind !== action.operation
        || !document.observations
        || !document.observations.before
        || !document.observations.after)
    {
        throw new Error('action receipt operation/observation contract mismatch');
    }
    const after = document.observations.after;
    if (action.stateDomains.includes('runtime.measurement-children'))
    {
        verifyMeasurementProcessTreeBinding({
            repositoryRoot,
            binding: after.measurementDescendants,
            actionReceipt: document,
            scenario,
            identity
        });
    }
    if (action.operation === 'prepare-evidence-files')
    {
        const deletedPaths = (document.operation.deleted ?? [])
            .map((entry) => entry.path).sort();
        if (JSON.stringify(deletedPaths) !== JSON.stringify(action.targets)
            || !Array.isArray(after.targets)
            || after.targets.some((target) => target.status !== 'absent'))
        {
            throw new Error('evidence-file preparation post-state is false');
        }
    }
    if (action.operation === 'observe-runtime')
    {
        const topology = identity.fixture?.topology?.content;
        const backend = topology?.runtime?.backendContainer;
        const port = backend?.portBinding;
        const expectedBaseUrl = Number.isInteger(port?.hostPort)
            ? `http://${port.hostIp}:${port.hostPort}`
            : null;
        if (after.backend?.status !== 'running' || after.live?.status !== 'live')
        {
            throw new Error('runtime action post-state is not live/current');
        }
        if (after.backend?.id !== backend?.id
            || after.postgres?.id !== topology?.postgres?.instance
            || after.redis?.id !== topology?.redis?.instance
            || after.expectedBaseUrl !== expectedBaseUrl
            || after.configuredBaseUrl !== expectedBaseUrl)
        {
            throw new Error('runtime action post-state is not bound to run identity');
        }
        if (action.stateDomains.some((domain) => domain.startsWith('postgres.'))
            && after.postgres?.status !== 'running')
        {
            throw new Error('runtime PostgreSQL post-state is not running');
        }
        if (action.stateDomains.some((domain) => domain.startsWith('redis.'))
            && after.redis?.status !== 'running')
        {
            throw new Error('runtime Redis post-state is not running');
        }
        if (action.stateDomains.includes('network.host-topology')
            && after.network?.status !== 'bound')
        {
            throw new Error('runtime network post-state is not bound');
        }
        if (action.stateDomains.includes('runtime.backend-resource-counters')
            && after.resourceCounters?.status !== 'observed')
        {
            throw new Error('runtime resource counter post-state is unavailable');
        }
        if (action.stateDomains.includes('runtime.performance-counters'))
        {
            if (after.performanceCounters?.status !== 'observed')
            {
                throw new Error('performance counter post-state is unavailable');
            }
            const evidence = safeRelativePath(
                repositoryRoot,
                after.performanceCounters.path,
                'performance counter authority'
            );
            if (rawDigest(fs.readFileSync(evidence.absolute))
                !== after.performanceCounters.bytesDigest)
            {
                throw new Error('performance counter authority bytes changed');
            }
        }
        if (action.stateDomains.includes('runtime.measurement-children')
            && after.measurementDescendants?.status !== 'zero')
        {
            throw new Error('measurement descendant zero-state is unproved');
        }
        if (action.phase !== 'precondition')
        {
            const baseline = rereadBoundReceipt(
                repositoryRoot,
                document.operation.runtimeBaselineReceipt,
                'runtime counter baseline receipt'
            );
            const baselineAfter = baseline.observations?.after;
            const sameContainerIdentity = (left, right) => (
                left?.id === right?.id
                && left?.hostPid === right?.hostPid
                && left?.startedAt === right?.startedAt
                && left?.image === right?.image
            );
            if (baseline.actionId !== scenario.isolation.lifecycle.preconditions[0]
                || baselineAfter?.expectedBaseUrl !== after.expectedBaseUrl
                || baselineAfter?.configuredBaseUrl !== after.configuredBaseUrl
                || !sameContainerIdentity(baselineAfter?.backend, after.backend)
                || !sameContainerIdentity(baselineAfter?.postgres, after.postgres)
                || !sameContainerIdentity(baselineAfter?.redis, after.redis)
                || baselineAfter?.network?.id !== after.network.id
                || JSON.stringify(baselineAfter?.network?.memberContainerIds)
                    !== JSON.stringify(after.network?.memberContainerIds))
            {
                throw new Error('runtime identity changed from lifecycle baseline');
            }
            if (action.stateDomains.includes('runtime.backend-resource-counters')
                && (baseline.observations?.after?.resourceCounters?.status
                    !== 'observed'
                    || after.resourceCounters?.status !== 'observed'))
            {
                throw new Error('runtime counter baseline/final observation is incomplete');
            }
        }
    }
    if (action.operation === 'observe-mutation'
        || action.operation === 'cleanup-mutation-output')
    {
        if (after.source?.status !== 'clean'
            || after.productionBuild?.status !== 'observed')
        {
            throw new Error('mutation source/build post-state is invalid');
        }
        if (action.phase !== 'precondition')
        {
            const baseline = rereadBoundReceipt(
                repositoryRoot,
                document.operation.baselineReceipt,
                'mutation production-build baseline receipt'
            );
            if (baseline.actionId !== scenario.isolation.lifecycle.preconditions[0]
                || baseline.observations?.after?.productionBuild?.inventoryDigest
                    !== after.productionBuild.inventoryDigest)
            {
                throw new Error('mutation production-build inventory changed');
            }
        }
        if (action.stateDomains.includes('runtime.measurement-children')
            && after.measurementDescendants?.status !== 'zero')
        {
            throw new Error('mutation measurement descendant zero-state is unproved');
        }
        if (action.operation === 'cleanup-mutation-output'
            && (after.mutationOutput?.status !== 'absent'
                || JSON.stringify(document.operation.deleted?.map(
                    (entry) => entry.path
                )) !== JSON.stringify(['.tmp/mutation/backend-critical'])))
        {
            throw new Error('mutation output cleanup final observation failed');
        }
    }
    if (['observe-data-scale-runtime', 'provision-data-scale-runtime']
        .includes(action.operation)
        && (after.runtime?.backend?.status !== 'running'
            || after.runtime?.postgres?.status !== 'running'
            || after.runtime?.redis?.status !== 'running'
            || after.runtime?.live?.status !== 'live'
            || after.runtime?.network?.status !== 'bound'
            || after.runtime?.roots?.some(
                (entry) => !['directory', 'file'].includes(entry.status)
            )))
    {
        throw new Error('data-scale runtime fresh post-observation failed');
    }
    if (['observe-data-scale-runtime', 'provision-data-scale-runtime']
        .includes(action.operation))
    {
        const expected = after.runtime.expected;
        if (!ownerDocument || JSON.stringify(expected) !== JSON.stringify({
            backend: ownerDocument.backend,
            postgres: ownerDocument.postgres,
            redis: ownerDocument.redis,
            roots: [
                ownerDocument.aotRoot,
                ownerDocument.searchRoot,
                ownerDocument.hotReadRoot,
                ownerDocument.dataRoot
            ]
        })
            || String(after.runtime.backend.id)
                !== String(ownerDocument.backend.pidOrContainerId)
            || String(after.runtime.backend.startTicks)
                !== String(ownerDocument.backend.startTicks)
            || after.runtime.backend.executableOrImageDigest
                !== ownerDocument.backend.executableOrImageDigest
            || after.runtime.postgres.id !== ownerDocument.postgres.containerId
            || after.runtime.postgres.image !== ownerDocument.postgres.imageDigest
            || !after.runtime.postgres.volumeNames?.includes(
                ownerDocument.postgres.volumeId
            )
            || after.runtime.redis.id !== ownerDocument.redis.containerId
            || after.runtime.redis.image !== ownerDocument.redis.imageDigest
            || !after.runtime.redis.volumeNames?.includes(
                ownerDocument.redis.volumeId
            ))
        {
            throw new Error('data-scale runtime observation does not match owner identity');
        }
    }
    if (action.operation === 'teardown-data-scale-runtime')
    {
        const runtimeBaseline = rereadBoundReceipt(
            repositoryRoot,
            document.operation.dataScaleRuntimeReceipt,
            'data-scale runtime baseline receipt'
        );
        if (after.teardown?.status !== 'observed')
        {
            throw new Error('data-scale teardown post-observation failed');
        }
        verifyDataScaleTeardownRuntimeBinding({
            runtimeReceipt: runtimeBaseline,
            teardownReceipt: ownerDocument,
            operationBinding: document.operation.dataScaleRuntimeReceipt,
            expectedRuntimeActionId:
                scenario.isolation.lifecycle.preconditions[0]
        });
        if (action.stateDomains.includes('runtime.measurement-children')
            && after.measurementDescendants?.status !== 'zero')
        {
            throw new Error('data-scale measurement descendant zero-state is unproved');
        }
    }
}

function expectedMeasurementBinding({
    invocationId,
    runId,
    scenarioId,
    identity
})
{
    return {
        invocationId,
        runId,
        scenarioId,
        identityContentDigest: identity.contentDigest,
        sourceState: identity.sourceState,
        buildContentDigest: identity.build.contentDigest
    };
}

function verifyMeasurement({
    document,
    action,
    scenario,
    invocationId,
    runId,
    identity
})
{
    const expectedSchema = scenario.authoritativeEvidence.expectedSchema;
    if (action.expectedReceiptSchema !== 'catalog-authoritative-evidence'
        && document.schema !== action.expectedReceiptSchema)
    {
        throw new Error('measurement receipt schema mismatch');
    }
    if (expectedSchema.schema !== undefined
        && document.schema !== expectedSchema.schema)
    {
        throw new Error('measurement authoritative schema mismatch');
    }
    if (!expectedSchema.passStatusValues.includes(document.status))
    {
        throw new Error('measurement receipt status is not passing');
    }
    if (JSON.stringify(document.releaseReliability)
        !== JSON.stringify(expectedMeasurementBinding({
            invocationId,
            runId,
            scenarioId: scenario.id,
            identity
        })))
    {
        throw new Error('measurement receipt identity mismatch');
    }
    if (Object.hasOwn(document, 'contentDigest'))
    {
        verifyContentDigest(document);
    }
    return document.observation?.final
        ?? document.cleanup
        ?? document.runtime
        ?? { status: 'verified-by-authoritative-schema' };
}

function verifyLifecycleOrOwner({
    repositoryRoot,
    document,
    action,
    scenario,
    invocationId,
    runId,
    scenarioId,
    identity,
    identityReference
})
{
    if (document.schema !== action.expectedReceiptSchema)
    {
        throw new Error('action receipt schema mismatch');
    }
    if (document.invocationId !== invocationId || document.runId !== runId
        || (Object.hasOwn(document, 'scenarioId')
            && document.scenarioId !== scenarioId))
    {
        throw new Error('action receipt run/invocation identity mismatch');
    }
    if (JSON.stringify(document.stateDomains)
        !== JSON.stringify(action.stateDomains))
    {
        throw new Error('action receipt state-domain identity mismatch');
    }
    if (document.actionId !== action.actionId
        || document.phase !== action.phase
        || document.identity?.path !== identityReference.path
        || document.identity?.contentDigest !== identityReference.contentDigest)
    {
        throw new Error('action receipt action/phase/identity mismatch');
    }
    requireIsoTime(document.startedAt, 'action receipt startedAt');
    requireIsoTime(document.finishedAt, 'action receipt finishedAt');
    if (Date.parse(document.finishedAt) < Date.parse(document.startedAt))
    {
        throw new Error('action receipt time order is invalid');
    }
    let ownerDocument = null;
    if (action.ownerReceipt)
    {
        if (!document.ownerReceipt
            || document.ownerReceipt.schema === action.expectedReceiptSchema)
        {
            throw new Error('lifecycle adapter does not bind original owner receipt');
        }
        const owner = verifyDataScaleOwnerReceipt({
            repositoryRoot,
            ownerReceipt: action.ownerReceipt,
            receiptPath: document.ownerReceipt.path,
            identity,
            runId,
            expectedBytesDigest: document.ownerReceipt.bytesDigest
        });
        if (owner.contentDigest !== document.ownerReceipt.contentDigest
            || owner.schema !== document.ownerReceipt.schema
            || owner.dataScaleRunId !== document.ownerReceipt.dataScaleRunId)
        {
            throw new Error('lifecycle adapter owner receipt binding mismatch');
        }
        ownerDocument = owner.document;
    }
    verifyLifecycleOperation({
        repositoryRoot,
        action,
        scenario,
        document,
        identity,
        ownerDocument
    });
    verifyFinalObservation(document);
    verifyContentDigest(document);
    return document.finalObservation;
}

export function verifyFailedMeasurementReceipt({
    repositoryRoot = root, action, scenario, invocationId, runId, identity
})
{
    if (action.phase !== 'measurement')
    {
        throw new Error('failure evidence requires a measurement action');
    }
    const expectedPath = expandLifecycleTemplate(action.expectedReceiptPath, {
        actionId: action.actionId, invocationId, runId, scenarioId: scenario.id
    });
    const resolved = safeRelativePath(path.resolve(repositoryRoot), expectedPath, 'failed measurement receipt');
    if (!fs.lstatSync(resolved.absolute).isFile())
    {
        throw new Error('failed measurement receipt is not a regular file');
    }
    const bytes = fs.readFileSync(resolved.absolute);
    const document = JSON.parse(bytes.toString('utf8'));
    const expected = scenario.authoritativeEvidence.expectedSchema;
    requireFields(document, [...action.requiredFields, ...expected.required]);
    if (expected.schema && document.schema !== expected.schema
        || action.expectedReceiptSchema !== 'catalog-authoritative-evidence'
        && document.schema !== action.expectedReceiptSchema
        || JSON.stringify(document.releaseReliability) !== JSON.stringify(expectedMeasurementBinding({
            invocationId, runId, scenarioId: scenario.id, identity
        })))
    {
        throw new Error('failed measurement schema or current-run identity mismatch');
    }
    if (Object.hasOwn(document, 'contentDigest'))
    {
        verifyContentDigest(document);
    }
    const noisy = document.status === 'infra-no-conclusion'
        || document.productConclusionEligible === false
        || document.qualificationEligible === false
        || document.classification === 'infra.noisy-measurement-window';
    if (!noisy && !['failed', 'fail'].includes(document.status))
    {
        throw new Error('measurement evidence has no attributable failure');
    }
    if (!noisy && !expected.schema && !document.measurementNoiseEnvelope)
    {
        throw new Error('runtime measurement failure has no qualified measurement-window evidence');
    }
    if (!noisy && document.measurementNoiseEnvelope)
    {
        if (document.measurementNoiseEnvelope.authority?.runId !== runId)
        {
            throw new Error('measurement failure window belongs to another run');
        }
        validateMeasurementNoiseReceipt(document.measurementNoiseEnvelope, {
            authoritySequence: document.measurementNoiseAuthoritySequence
        });
        if (document.measurementNoiseEnvelope.status !== 'clean'
            || document.measurementNoiseEnvelope.productConclusionEligible !== true)
        {
            throw new Error('measurement window is not eligible for product attribution');
        }
    }
    return {
        actionId: action.actionId, phase: action.phase, path: resolved.relative,
        schema: document.schema, status: document.status,
        bytesDigest: rawDigest(bytes), contentDigest: document.contentDigest ?? null,
        classification: noisy ? 'infra-no-conclusion' : 'product-failure'
    };
}

export function verifyLifecycleActionReceipt({
    repositoryRoot = root,
    action,
    scenario,
    invocationId,
    runId,
    identity,
    identityReference,
    expectedBytesDigest = null,
    processOutcome = null
})
{
    if (processOutcome?.timedOut === true)
    {
        throw new Error('timed out action cannot consume a receipt');
    }
    const expectedPath = expandLifecycleTemplate(
        action.expectedReceiptPath,
        {
            actionId: action.actionId,
            invocationId,
            runId,
            scenarioId: scenario.id
        }
    );
    const receiptPath = safeRelativePath(
        path.resolve(repositoryRoot),
        expectedPath,
        'action receipt'
    );
    if (!fs.existsSync(receiptPath.absolute)
        || !fs.lstatSync(receiptPath.absolute).isFile())
    {
        throw new Error(`action receipt is missing: ${receiptPath.relative}`);
    }
    const bytes = fs.readFileSync(receiptPath.absolute);
    const bytesDigest = rawDigest(bytes);
    if (expectedBytesDigest !== null && bytesDigest !== expectedBytesDigest)
    {
        throw new Error('action receipt bytes digest mismatch');
    }
    let document;
    try
    {
        document = JSON.parse(bytes.toString('utf8'));
    }
    catch
    {
        throw new Error('action receipt is not structured JSON');
    }
    if (!document || typeof document !== 'object' || Array.isArray(document))
    {
        throw new Error('action receipt must be a JSON object');
    }
    requireFields(document, action.requiredFields);
    if (!action.passStatusValues.includes(document.status))
    {
        throw new Error(`action receipt status is not passing: ${document.status ?? '<missing>'}`);
    }
    const finalObservation = action.phase === 'measurement'
        ? verifyMeasurement({
            document,
            action,
            scenario,
            invocationId,
            runId,
            identity
        })
        : verifyLifecycleOrOwner({
            repositoryRoot,
            document,
            action,
            scenario,
            invocationId,
            runId,
            scenarioId: scenario.id,
            identity,
            identityReference
        });
    return {
        actionId: action.actionId,
        phase: action.phase,
        path: receiptPath.relative,
        schema: document.schema ?? action.expectedReceiptSchema,
        status: document.status,
        stateDomains: action.stateDomains,
        bytesDigest,
        contentDigest: document.contentDigest ?? null,
        finalObservation
    };
}

function parseArguments(argv)
{
    const options = {};
    for (let index = 0; index < argv.length; index += 2)
    {
        const key = argv[index];
        const value = argv[index + 1];
        if (!key?.startsWith('--') || value === undefined)
        {
            throw new Error('lifecycle action verifier arguments must be --key value pairs');
        }
        options[key.slice(2)] = value;
    }
    return options;
}

function main()
{
    const options = parseArguments(process.argv.slice(2));
    const contracts = loadLifecycleActionContracts({ repositoryRoot: root });
    const action = contracts.actions.get(options['action-id']);
    const scenario = contracts.catalog.scenarios.find(
        (candidate) => candidate.id === action?.scenarioId
    );
    if (!action || !scenario)
    {
        throw new Error('lifecycle action is unavailable');
    }
    const identityFile = safeRelativePath(root, options['identity-path'], 'run identity');
    const identity = JSON.parse(fs.readFileSync(identityFile.absolute, 'utf8'));
    const reference = verifyLifecycleActionReceipt({
        repositoryRoot: root,
        action,
        scenario,
        invocationId: options['invocation-id'],
        runId: options['run-id'],
        identity,
        identityReference: {
            path: identityFile.relative,
            contentDigest: options['identity-digest']
        },
        expectedBytesDigest: options['expected-bytes-digest'] ?? null
    });
    process.stdout.write(`${JSON.stringify(reference)}\n`);
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    try
    {
        main();
    }
    catch (error)
    {
        console.error(
            `[release-reliability-lifecycle-verifier] ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        process.exitCode = 1;
    }
}
