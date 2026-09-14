#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    ROLLOUT_STAGES,
    readRolloutState,
    validateRolloutState
} from './release-rollout-lib.mjs';

export const NORMAL_WORKER_OBSERVER_PLAN_SCHEMA = 'fsusblog.release-worker-normal-observer-plan.v1';
export const NORMAL_WORKER_OBSERVER_SCHEMA = 'fsusblog.release-worker-normal-observer.v1';
export const NORMAL_WORKER_LEDGER_SCHEMA = 'fsusblog.release-worker-event-ledger.v1';
export const NORMAL_WORKER_KINDS = Object.freeze([
    'scheduled-publish',
    'article-mutation-outbox',
    'audit-writer',
    'visit-view-projection',
    'public-hot-aot',
    'upload-cleanup',
    'active-singleton-control',
    'multi-consumer-safe-control'
]);

const COMMAND_SCHEMA = 'fsusblog.release-worker-normal-observer-command.v1';
const OBSERVATION_SCHEMA = 'fsusblog.release-worker-normal-observation.v1';
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{7,127}$/u;
const SAFE_PROBE_ID = /^[a-z][a-z0-9._-]{2,63}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const DURABLE_REPLAY_SOURCES = new Set([
    'postgres-outbox',
    'postgres-row-lock',
    'redis-stream',
    'durable-upload-session'
]);
const OBSERVATION_SOURCES = new Set(['postgres', 'redis', 'runtime-control']);
const FINAL_OBSERVED_FIELDS = Object.freeze([
    'attemptCount',
    'finalEffectCount',
    'finalEffectKey',
    'finalReleaseId',
    'finalGeneration',
    'staleGenerationCommitCount'
]);
const ARMED_OBSERVED_FIELDS = Object.freeze([
    'logicalEventId',
    'pendingCountAtDrain',
    'durableReplaySource',
    'sourceReleaseId',
    'sourceGeneration'
]);

export class NormalWorkerObserverError extends Error
{
    constructor(errors)
    {
        const normalized = unique(errors.map(value => String(value)).filter(Boolean));
        super(normalized.join('; ') || 'normal worker observer failed');
        this.name = 'NormalWorkerObserverError';
        this.errors = normalized;
    }
}

export function normalizeNormalWorkerObserverPlan(value)
{
    const errors = [];
    if (!isObject(value))
    {
        throw new NormalWorkerObserverError(['plan must be a JSON object']);
    }
    if (value.schema !== NORMAL_WORKER_OBSERVER_PLAN_SCHEMA)
    {
        errors.push(`plan schema must be ${NORMAL_WORKER_OBSERVER_PLAN_SCHEMA}`);
    }

    let baseUrl = null;
    try
    {
        const parsed = new URL(String(value.baseUrl ?? ''));
        if (!['http:', 'https:'].includes(parsed.protocol)
      || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.pathname !== '/'
      || parsed.search || parsed.hash)
        {
            throw new Error('must be an exact loopback HTTP(S) origin');
        }
        baseUrl = parsed.origin;
    }
    catch (error)
    {
        errors.push(`plan.baseUrl ${error instanceof Error ? error.message : String(error)}`);
    }

    const paths = {};
    for (const name of ['startPath', 'statusPath', 'finalizePath'])
    {
        const candidate = String(value[name] ?? '');
        if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,500}$/u.test(candidate)
      || candidate.includes('..') || candidate.startsWith('//'))
        {
            errors.push(`plan.${name} must be a safe origin-relative path`);
        }
        else
        {
            paths[name] = candidate;
        }
    }
    if (Object.values(paths).length === 3 && new Set(Object.values(paths)).size !== 3)
    {
        errors.push('plan observer paths must be distinct');
    }
    if (!Array.isArray(value.requiredKinds)
    || value.requiredKinds.join('\n') !== NORMAL_WORKER_KINDS.join('\n'))
    {
        errors.push(`plan.requiredKinds must be the exact ordered normal set: ${NORMAL_WORKER_KINDS.join(', ')}`);
    }

    let timeoutMs = null;
    let pollMs = null;
    try
    {
        timeoutMs = boundedInteger(value.timeoutMs ?? 300_000, 10_000, 900_000, 'plan.timeoutMs');
    }
    catch (error)
    {
        errors.push(error.message);
    }
    try
    {
        pollMs = boundedInteger(value.pollMs ?? 250, 50, 10_000, 'plan.pollMs');
    }
    catch (error)
    {
        errors.push(error.message);
    }
    if (errors.length > 0)
    {
        throw new NormalWorkerObserverError(errors);
    }
    return {
        schema: NORMAL_WORKER_OBSERVER_PLAN_SCHEMA,
        baseUrl,
        ...paths,
        requiredKinds: [...NORMAL_WORKER_KINDS],
        timeoutMs,
        pollMs
    };
}

export async function runNormalWorkerObserver(input, dependencies = {})
{
    const deps = {
        fetchImpl: globalThis.fetch,
        now: () => new Date(),
        delay,
        readRolloutState,
        readJson,
        writeJsonExclusiveAtomic,
        ...dependencies
    };
    if (typeof deps.fetchImpl !== 'function')
    {
        throw new NormalWorkerObserverError(['fetch implementation is unavailable']);
    }

    const planPath = canonicalRegularFile(input.plan, 'observer plan');
    const plan = normalizeNormalWorkerObserverPlan(deps.readJson(planPath));
    const rolloutStatePath = path.resolve(requiredString(input.rolloutState, 'rollout-state'));
    const drainPath = path.resolve(requiredString(input.sourceDrain, 'source-drain'));
    const outputPath = path.resolve(requiredString(input.out, 'out'));
    const runId = requiredString(input.runId, 'run-id');
    if (!SAFE_ID.test(runId))
    {
        throw new NormalWorkerObserverError(['run-id must be a safe 8..128 character identity']);
    }
    const startStage = input.startStage ?? 'candidate-start';
    const startIndex = ROLLOUT_STAGES.indexOf(startStage);
    const candidateStartIndex = ROLLOUT_STAGES.indexOf('candidate-start');
    const drainIndex = ROLLOUT_STAGES.indexOf('source-drain');
    if (startIndex < candidateStartIndex || startIndex >= drainIndex)
    {
        throw new NormalWorkerObserverError(['start-stage must be candidate-start..public-verify']);
    }
    const timeoutMs = boundedInteger(input.timeoutMs ?? plan.timeoutMs, 10_000, 900_000, 'timeout-ms');
    const adminHeader = readPrivateAdminHeader(input.adminHeaderFile);
    const rollout = await waitForRolloutStart(
        rolloutStatePath,
        startStage,
        timeoutMs,
        plan.pollMs,
        deps);
    const binding = observerBinding(rollout, runId);
    const startedAtUtc = deps.now().toISOString();

    const started = await requestObserver(plan, plan.startPath, 'POST', {
        ...binding,
        action: 'start-normal-worker-observation',
        destructive: false,
        requiredKinds: NORMAL_WORKER_KINDS
    }, adminHeader, timeoutMs, deps.fetchImpl);
    assertObserverEnvelope(started, rollout, runId, ['accepted', 'armed'], 'observer start');
    const armed = started.status === 'armed'
        ? started
        : await pollObserver(plan, rollout, runId, adminHeader, timeoutMs, value => value.status === 'armed', deps);
    const armedResult = validateArmedNormalEvents(armed.events, rollout);
    if (armedResult.errors.length > 0)
    {
        throw new NormalWorkerObserverError(armedResult.errors);
    }

    const drain = await waitForPassingDrain(drainPath, rolloutStatePath, timeoutMs, plan.pollMs, deps);
    const drainMetadata = fileMetadata(drainPath, 'source drain evidence');
    const finalized = await requestObserver(plan, plan.finalizePath, 'POST', {
        ...binding,
        action: 'finalize-after-graceful-drain',
        destructive: false,
        sourceDrain: drainMetadata
    }, adminHeader, timeoutMs, deps.fetchImpl);
    assertObserverEnvelope(finalized, rollout, runId, ['accepted', 'pass'], 'observer finalize');
    const completed = finalized.status === 'pass'
        ? finalized
        : await pollObserver(plan, rollout, runId, adminHeader, timeoutMs, value => value.status === 'pass', deps);

    const result = buildNormalWorkerLedger({
        rollout,
        runId,
        planPath,
        plan,
        armed,
        completed,
        drain,
        drainMetadata,
        startedAtUtc,
        completedAtUtc: deps.now().toISOString()
    });
    if (result.errors.length > 0)
    {
        throw new NormalWorkerObserverError(result.errors);
    }
    deps.writeJsonExclusiveAtomic(outputPath, result.ledger);
    return result.ledger;
}

export function buildNormalWorkerLedger(input)
{
    const errors = [];
    let rollout;
    try
    {
        validateRolloutState(input.rollout);
        rollout = input.rollout;
    }
    catch (error)
    {
        errors.push(`rollout state: ${message(error)}`);
        return { ledger: null, errors };
    }
    const armedResult = validateArmedNormalEvents(input.armed?.events, rollout);
    errors.push(...armedResult.errors);
    const completedResult = validateCompletedNormalEvents(
        input.completed?.events,
        armedResult.events,
        rollout,
        input.drain);
    errors.push(...completedResult.errors);
    const ledger = {
        schema: NORMAL_WORKER_LEDGER_SCHEMA,
        mode: 'normal',
        status: errors.length === 0 ? 'pass' : 'fail',
        rolloutId: rollout.rolloutId,
        source: releaseIdentity(rollout.source),
        target: releaseIdentity(rollout.target),
        drill: {
            schema: OBSERVATION_SCHEMA,
            runId: input.runId,
            destructive: false,
            forcedSourceTermination: false,
            observerPlan: {
                path: path.resolve(input.planPath),
                sha256: hashFile(input.planPath)
            },
            sourceDrain: input.drainMetadata,
            armedAtUtc: input.armed?.observedAtUtc ?? null,
            drainCompletedAtUtc: drainCompletionTime(input.drain),
            startedAtUtc: input.startedAtUtc,
            completedAtUtc: input.completedAtUtc
        },
        events: completedResult.events,
        errors: unique(errors)
    };
    return { ledger, errors: ledger.errors };
}

export function validateArmedNormalEvents(value, rollout)
{
    const errors = [];
    const events = [];
    if (!Array.isArray(value))
    {
        return { events, errors: ['armed observer events must be an array'] };
    }
    if (value.length !== NORMAL_WORKER_KINDS.length)
    {
        errors.push(`armed observer must return exactly ${NORMAL_WORKER_KINDS.length} events`);
    }
    const ids = new Set();
    for (let index = 0; index < value.length; index += 1)
    {
        const event = value[index];
        const expectedKind = NORMAL_WORKER_KINDS[index];
        const label = `armed event[${index}]`;
        if (!isObject(event))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (event.kind !== expectedKind)
        {
            errors.push(`${label} kind must be ${expectedKind ?? '<none>'}`);
        }
        if (event.kind === 'forced-source-recovery' || event.forcedSourceTermination === true)
        {
            errors.push(`${label} attempted a destructive qualification action`);
        }
        const logicalEventId = String(event.logicalEventId ?? '');
        if (!SAFE_ID.test(logicalEventId) || ids.has(logicalEventId))
        {
            errors.push(`${label} logicalEventId is invalid or duplicate`);
        }
        ids.add(logicalEventId);
        if (!Number.isSafeInteger(event.pendingCountAtDrain) || event.pendingCountAtDrain < 1)
        {
            errors.push(`${label} must prove at least one durable pending item before drain`);
        }
        if (!DURABLE_REPLAY_SOURCES.has(event.durableReplaySource))
        {
            errors.push(`${label} durableReplaySource is invalid`);
        }
        if (event.sourceReleaseId !== rollout.source.releaseId
      || Number(event.sourceGeneration) !== rollout.source.runtimeGeneration)
        {
            errors.push(`${label} source release/generation does not match rollout`);
        }
        if (!isIsoUtc(event.observedAtUtc))
        {
            errors.push(`${label} observedAtUtc is invalid`);
        }
        errors.push(...validateBindings(event, ARMED_OBSERVED_FIELDS, null, label));
        events.push(event);
    }
    return { events, errors: unique(errors) };
}

export function validateCompletedNormalEvents(value, armedEvents, rollout, drain)
{
    const errors = [];
    const events = [];
    if (!Array.isArray(value))
    {
        return { events, errors: ['completed observer events must be an array'] };
    }
    if (value.length !== NORMAL_WORKER_KINDS.length)
    {
        errors.push(`completed observer must return exactly ${NORMAL_WORKER_KINDS.length} events`);
    }
    const ids = new Set();
    const effectKeys = new Set();
    const drainCompletedAtUtc = drainCompletionTime(drain);
    const drainCompletedAt = Date.parse(drainCompletedAtUtc ?? '');
    for (let index = 0; index < value.length; index += 1)
    {
        const event = value[index];
        const armed = armedEvents[index];
        const expectedKind = NORMAL_WORKER_KINDS[index];
        const label = `completed event[${index}]`;
        if (!isObject(event))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (event.kind !== expectedKind)
        {
            errors.push(`${label} kind must be ${expectedKind ?? '<none>'}`);
        }
        if (event.kind === 'forced-source-recovery' || event.forcedSourceTermination === true || event.recoveredByTarget !== undefined)
        {
            errors.push(`${label} contains a destructive qualification field`);
        }
        const logicalEventId = String(event.logicalEventId ?? '');
        if (!SAFE_ID.test(logicalEventId) || ids.has(logicalEventId))
        {
            errors.push(`${label} logicalEventId is invalid or duplicate`);
        }
        ids.add(logicalEventId);
        if (armed && logicalEventId !== armed.logicalEventId)
        {
            errors.push(`${label} logicalEventId changed after drain`);
        }
        if (!Number.isSafeInteger(event.attemptCount) || event.attemptCount < 1)
        {
            errors.push(`${label} attemptCount must be positive`);
        }
        if (event.finalEffectCount !== 1)
        {
            errors.push(`${label} finalEffectCount must be exactly one`);
        }
        const effectKey = String(event.finalEffectKey ?? '');
        if (!SAFE_ID.test(effectKey) || effectKeys.has(effectKey))
        {
            errors.push(`${label} finalEffectKey is invalid or duplicate`);
        }
        effectKeys.add(effectKey);
        if (event.finalReleaseId !== rollout.target.releaseId
      || Number(event.finalGeneration) !== rollout.target.runtimeGeneration)
        {
            errors.push(`${label} final release/generation does not match target`);
        }
        if (!Number.isSafeInteger(event.staleGenerationCommitCount) || event.staleGenerationCommitCount !== 0)
        {
            errors.push(`${label} staleGenerationCommitCount must be zero`);
        }
        if (!OBSERVATION_SOURCES.has(event.observationSource))
        {
            errors.push(`${label} observationSource is invalid`);
        }
        const requiredFields = [...FINAL_OBSERVED_FIELDS];
        if (event.kind === 'audit-writer')
        {
            requiredFields.push('expectedAuditCount', 'actualAuditCount');
            if (!Number.isSafeInteger(event.expectedAuditCount) || event.expectedAuditCount < 1
        || event.actualAuditCount !== event.expectedAuditCount)
            {
                errors.push(`${label} audit counts do not reconcile`);
            }
        }
        if (event.kind === 'visit-view-projection')
        {
            requiredFields.push('expectedProjectionCount', 'actualProjectionCount');
            if (!Number.isSafeInteger(event.expectedProjectionCount) || event.expectedProjectionCount < 1
        || event.actualProjectionCount !== event.expectedProjectionCount)
            {
                errors.push(`${label} visit/view projection counts do not reconcile`);
            }
        }
        errors.push(...validateBindings(event, requiredFields, drainCompletedAt, label));
        if (Array.isArray(event.errors) && event.errors.length > 0)
        {
            errors.push(...event.errors.map(error => `${label}: ${String(error)}`));
        }
        if (!armed)
        {
            continue;
        }
        events.push({
            logicalEventId,
            kind: event.kind,
            attemptCount: event.attemptCount,
            finalEffectCount: event.finalEffectCount,
            finalEffectKey: event.finalEffectKey,
            finalReleaseId: event.finalReleaseId,
            finalGeneration: Number(event.finalGeneration),
            staleGenerationCommitCount: event.staleGenerationCommitCount,
            pendingCountAtDrain: armed.pendingCountAtDrain,
            durableReplaySource: armed.durableReplaySource,
            ...(event.kind === 'audit-writer'
                ? { expectedAuditCount: event.expectedAuditCount, actualAuditCount: event.actualAuditCount }
                : {}),
            ...(event.kind === 'visit-view-projection'
                ? { expectedProjectionCount: event.expectedProjectionCount, actualProjectionCount: event.actualProjectionCount }
                : {}),
            observationSource: event.observationSource,
            observationBindings: {
                ...pickBindings(armed.observationBindings, ARMED_OBSERVED_FIELDS),
                ...pickBindings(event.observationBindings, requiredFields)
            },
            errors: []
        });
    }
    return { events, errors: unique(errors) };
}

async function waitForRolloutStart(file, startStage, timeoutMs, pollMs, deps)
{
    const wantedIndex = ROLLOUT_STAGES.indexOf(startStage);
    const drainIndex = ROLLOUT_STAGES.indexOf('source-drain');
    const deadline = Date.now() + timeoutMs;
    let lastError = 'rollout state not created';
    while (Date.now() < deadline)
    {
        try
        {
            const state = deps.readRolloutState(file);
            validateRolloutState(state);
            const completedCount = state.completedStages.length;
            const currentIndex = state.currentStage === null ? -1 : ROLLOUT_STAGES.indexOf(state.currentStage);
            if (completedCount > drainIndex || currentIndex >= drainIndex
        || ['completed', 'rolled_back', 'aborted', 'candidate_ready'].includes(state.status))
            {
                throw new NormalWorkerObserverError(['normal observer reached the rollout after its graceful-drain start boundary']);
            }
            if (state.status !== 'recovery_required' && (completedCount > wantedIndex || currentIndex >= wantedIndex))
            {
                return state;
            }
            lastError = `rollout status=${state.status} stage=${state.currentStage ?? '<none>'}`;
        }
        catch (error)
        {
            if (error instanceof NormalWorkerObserverError)
            {
                throw error;
            }
            lastError = message(error);
        }
        await deps.delay(pollMs);
    }
    throw new NormalWorkerObserverError([`timed out waiting for start-stage ${startStage}: ${lastError}`]);
}

async function waitForPassingDrain(drainFile, stateFile, timeoutMs, pollMs, deps)
{
    const deadline = Date.now() + timeoutMs;
    let lastError = 'source drain evidence not created';
    while (Date.now() < deadline)
    {
        try
        {
            const drain = deps.readJson(drainFile);
            const errors = validateDrain(drain);
            if (errors.length === 0)
            {
                return drain;
            }
            lastError = errors.join('; ');
            if (drain.status === 'fail')
            {
                throw new NormalWorkerObserverError(errors);
            }
        }
        catch (error)
        {
            if (error instanceof NormalWorkerObserverError)
            {
                throw error;
            }
            lastError = message(error);
        }
        try
        {
            const state = deps.readRolloutState(stateFile);
            if (state.status === 'recovery_required' || ['rolled_back', 'aborted'].includes(state.status))
            {
                throw new NormalWorkerObserverError([`rollout became ${state.status} before graceful drain completed`]);
            }
        }
        catch (error)
        {
            if (error instanceof NormalWorkerObserverError)
            {
                throw error;
            }
        }
        await deps.delay(pollMs);
    }
    throw new NormalWorkerObserverError([`timed out waiting for passing source drain: ${lastError}`]);
}

function validateDrain(value)
{
    const errors = [];
    if (!isObject(value))
    {
        return ['source drain evidence must be an object'];
    }
    if (value.schema !== 'fsusblog.release-rollout-gate.v1' || value.gate !== 'source-drain')
    {
        errors.push('source drain gate identity is invalid');
    }
    if (value.status !== 'pass')
    {
        errors.push('source drain gate did not pass');
    }
    const blockers = value.observations?.blockers;
    if (!Array.isArray(blockers) || blockers.length !== 0)
    {
        errors.push('source drain gate contains blockers');
    }
    if (Array.isArray(value.errors) && value.errors.length > 0)
    {
        errors.push(...value.errors.map(error => `source drain: ${String(error)}`));
    }
    if (!isIsoUtc(value.observedAtUtc))
    {
        errors.push('source drain observedAtUtc is invalid');
    }
    return unique(errors);
}

async function pollObserver(plan, rollout, runId, header, timeoutMs, predicate, deps)
{
    const deadline = Date.now() + timeoutMs;
    const pollErrors = [];
    while (Date.now() < deadline)
    {
        try
        {
            const value = await requestObserver(
                plan,
                plan.statusPath,
                'GET',
                observerBinding(rollout, runId),
                header,
                timeoutMs,
                deps.fetchImpl);
            assertObserverEnvelope(value, rollout, runId, ['accepted', 'armed', 'running', 'pass', 'fail'], 'observer status');
            if (value.status === 'fail')
            {
                throw new NormalWorkerObserverError([
                    'observer reported fail',
                    ...(Array.isArray(value.errors) ? value.errors : [])
                ]);
            }
            if (predicate(value))
            {
                return value;
            }
            pollErrors.push(`observer status remained ${value.status}`);
        }
        catch (error)
        {
            if (error instanceof NormalWorkerObserverError && error.errors.includes('observer reported fail'))
            {
                throw error;
            }
            pollErrors.push(...errorList(error));
        }
        await deps.delay(plan.pollMs);
    }
    throw new NormalWorkerObserverError(['observer timed out', ...pollErrors]);
}

async function requestObserver(plan, requestPath, method, payload, header, timeoutMs, fetchImpl)
{
    const url = new URL(requestPath, plan.baseUrl);
    if (url.origin !== plan.baseUrl)
    {
        throw new NormalWorkerObserverError(['observer request escaped configured loopback origin']);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000));
    try
    {
        const request = {
            method,
            headers: { accept: 'application/json', [header.name]: header.value },
            redirect: 'error',
            signal: controller.signal
        };
        if (method === 'GET')
        {
            url.searchParams.set('runId', payload.runId);
            url.searchParams.set('rolloutId', payload.rolloutId);
        }
        else
        {
            request.headers['content-type'] = 'application/json';
            request.body = JSON.stringify(payload);
        }
        const response = await fetchImpl(url, request);
        const text = await response.text();
        if (Buffer.byteLength(text) > 2 * 1024 * 1024)
        {
            throw new NormalWorkerObserverError(['observer response exceeds 2 MiB']);
        }
        let value;
        try
        {
            value = JSON.parse(text);
        }
        catch
        {
            throw new NormalWorkerObserverError([`observer returned non-JSON HTTP ${response.status}`]);
        }
        if (!response.ok)
        {
            throw new NormalWorkerObserverError([
                `observer returned HTTP ${response.status}`,
                ...(Array.isArray(value.errors) ? value.errors : [])
            ]);
        }
        return value;
    }
    finally
    {
        clearTimeout(timer);
    }
}

function assertObserverEnvelope(value, rollout, runId, statuses, label)
{
    const errors = [];
    if (!isObject(value))
    {
        throw new NormalWorkerObserverError([`${label} must be an object`]);
    }
    if (value.schema !== NORMAL_WORKER_OBSERVER_SCHEMA)
    {
        errors.push(`${label} schema is invalid`);
    }
    if (!statuses.includes(value.status))
    {
        errors.push(`${label} status is invalid`);
    }
    if (value.runId !== runId || value.rolloutId !== rollout.rolloutId)
    {
        errors.push(`${label} run/rollout identity mismatch`);
    }
    if (value.destructive !== false)
    {
        errors.push(`${label} must explicitly be non-destructive`);
    }
    if (!identityMatches(value.source, rollout.source) || !identityMatches(value.target, rollout.target))
    {
        errors.push(`${label} source/target identity mismatch`);
    }
    if (!isIsoUtc(value.observedAtUtc))
    {
        errors.push(`${label} observedAtUtc is invalid`);
    }
    if (Array.isArray(value.errors) && value.errors.length > 0)
    {
        errors.push(...value.errors.map(error => `${label}: ${String(error)}`));
    }
    if (errors.length > 0)
    {
        throw new NormalWorkerObserverError(errors);
    }
}

function validateBindings(event, fields, minimumTime, label)
{
    const errors = [];
    if (!isObject(event.observationBindings))
    {
        return [`${label} observationBindings are missing`];
    }
    for (const field of fields)
    {
        const binding = event.observationBindings[field];
        if (!isObject(binding))
        {
            errors.push(`${label} ${field} observation binding is missing`);
            continue;
        }
        if (!SAFE_PROBE_ID.test(String(binding.probe ?? '')))
        {
            errors.push(`${label} ${field} probe is invalid`);
        }
        if (!validJsonPointer(binding.pointer))
        {
            errors.push(`${label} ${field} pointer is invalid`);
        }
        if (!isIsoUtc(binding.observedAtUtc))
        {
            errors.push(`${label} ${field} observedAtUtc is invalid`);
        }
        const observedAt = Date.parse(binding.observedAtUtc ?? '');
        if (Number.isFinite(minimumTime) && (!Number.isFinite(observedAt) || observedAt < minimumTime))
        {
            errors.push(`${label} ${field} was not observed after graceful drain`);
        }
        const expectedHash = sha256Value(event[field]);
        if (binding.valueSha256 !== expectedHash)
        {
            errors.push(`${label} ${field} valueSha256 mismatch`);
        }
    }
    return errors;
}

function observerBinding(rollout, runId)
{
    return {
        schema: COMMAND_SCHEMA,
        runId,
        rolloutId: rollout.rolloutId,
        source: releaseIdentity(rollout.source),
        target: releaseIdentity(rollout.target)
    };
}

function releaseIdentity(value)
{
    return {
        releaseId: value.releaseId,
        imageDigest: value.imageDigest,
        slot: value.slot,
        generation: value.runtimeGeneration ?? value.generation
    };
}

function identityMatches(observed, expected)
{
    return observed?.releaseId === expected.releaseId
    && observed?.imageDigest === expected.imageDigest
    && observed?.slot === expected.slot
    && Number(observed?.generation) === Number(expected.runtimeGeneration ?? expected.generation);
}

function drainCompletionTime(value)
{
    return value?.observedAtUtc ?? value?.completedAtUtc ?? null;
}

function pickBindings(value, fields)
{
    if (!isObject(value))
    {
        return {};
    }
    return Object.fromEntries(fields.filter(field => isObject(value[field])).map(field => [field, value[field]]));
}

function readPrivateAdminHeader(file)
{
    const resolved = canonicalRegularFile(file, 'admin header file');
    const mode = fs.statSync(resolved).mode & 0o777;
    if (![0o400, 0o600].includes(mode))
    {
        throw new NormalWorkerObserverError(['admin header file must have mode 0400 or 0600']);
    }
    const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    if (lines.length !== 1)
    {
        throw new NormalWorkerObserverError(['admin header file must contain exactly one line']);
    }
    const match = /^(Authorization|Cookie): (\S(?:.*\S)?)$/u.exec(lines[0]);
    if (!match || (match[1] === 'Authorization' && !match[2].startsWith('Bearer ')))
    {
        throw new NormalWorkerObserverError(['admin header must be Authorization: Bearer or Cookie']);
    }
    return { name: match[1], value: match[2] };
}

function parseArgs(argv)
{
    const parsed = {};
    const allowed = new Set([
        'plan',
        'rollout-state',
        'source-drain',
        'admin-header-file',
        'out',
        'run-id',
        'start-stage',
        'timeout-ms'
    ]);
    for (let index = 0; index < argv.length; index += 2)
    {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith('--') || value === undefined || value.startsWith('--'))
        {
            throw new NormalWorkerObserverError([`invalid argument near ${name ?? '<end>'}`]);
        }
        const key = name.slice(2);
        if (!allowed.has(key))
        {
            throw new NormalWorkerObserverError([`unknown argument --${key}`]);
        }
        if (parsed[key] !== undefined)
        {
            throw new NormalWorkerObserverError([`duplicate argument --${key}`]);
        }
        parsed[key] = value;
    }
    const missing = ['plan', 'rollout-state', 'source-drain', 'admin-header-file', 'out', 'run-id']
        .filter(name => !parsed[name]);
    if (missing.length > 0)
    {
        throw new NormalWorkerObserverError(missing.map(name => `--${name} is required`));
    }
    return {
        plan: parsed.plan,
        rolloutState: parsed['rollout-state'],
        sourceDrain: parsed['source-drain'],
        adminHeaderFile: parsed['admin-header-file'],
        out: parsed.out,
        runId: parsed['run-id'],
        startStage: parsed['start-stage'] ?? 'candidate-start',
        timeoutMs: parsed['timeout-ms'] === undefined ? undefined : Number(parsed['timeout-ms'])
    };
}

function writeFailureEvidence(file, input, errors)
{
    if (!file || fs.existsSync(path.resolve(file)))
    {
        return;
    }
    const value = {
        schema: NORMAL_WORKER_LEDGER_SCHEMA,
        mode: 'normal',
        status: 'fail',
        rolloutId: null,
        source: null,
        target: null,
        drill: {
            schema: OBSERVATION_SCHEMA,
            runId: input?.runId ?? null,
            destructive: false,
            forcedSourceTermination: false
        },
        events: [],
        errors: unique(errors),
        completedAtUtc: new Date().toISOString()
    };
    writeJsonExclusiveAtomic(path.resolve(file), value);
}

function canonicalRegularFile(file, label)
{
    const resolved = path.resolve(requiredString(file, label));
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new NormalWorkerObserverError([`${label} must be a regular non-symlink file`]);
    }
    return fs.realpathSync(resolved);
}

function fileMetadata(file, label)
{
    const resolved = canonicalRegularFile(file, label);
    const bytes = fs.readFileSync(resolved);
    return { path: resolved, bytes: bytes.length, sha256: sha256(bytes) };
}

function hashFile(file)
{
    return sha256(fs.readFileSync(canonicalRegularFile(file, 'hashed file')));
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256Value(value)
{
    return sha256(JSON.stringify(value));
}

function readJson(file)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonExclusiveAtomic(file, value)
{
    const resolved = path.resolve(file);
    if (fs.existsSync(resolved))
    {
        throw new NormalWorkerObserverError([`output already exists: ${resolved}`]);
    }
    const directory = path.dirname(resolved);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${Date.now().toString(36)}.tmp`);
    let descriptor;
    try
    {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.linkSync(temporary, resolved);
        fs.unlinkSync(temporary);
        const directoryDescriptor = fs.openSync(directory, 'r');
        try
        {
            fs.fsyncSync(directoryDescriptor);
        }
        finally
        {
            fs.closeSync(directoryDescriptor);
        }
    }
    finally
    {
        if (descriptor !== undefined)
        {
            fs.closeSync(descriptor);
        }
        fs.rmSync(temporary, { force: true });
    }
}

function validJsonPointer(value)
{
    return typeof value === 'string'
    && value.startsWith('/')
    && !value.includes('\0')
    && value.split('/').slice(1).every(segment => !/~(?:[^01]|$)/u.test(segment));
}

function isIsoUtc(value)
{
    return ISO_UTC.test(String(value ?? '')) && Number.isFinite(Date.parse(value));
}

function requiredString(value, label)
{
    const result = String(value ?? '').trim();
    if (!result)
    {
        throw new NormalWorkerObserverError([`${label} is required`]);
    }
    return result;
}

function boundedInteger(value, minimum, maximum, label)
{
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    {
        throw new NormalWorkerObserverError([`${label} must be ${minimum}..${maximum}`]);
    }
    return parsed;
}

function isObject(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values)
{
    return [...new Set(values)];
}

function message(error)
{
    return error instanceof Error ? error.message : String(error);
}

function errorList(error)
{
    return error instanceof NormalWorkerObserverError ? error.errors : [message(error)];
}

function delay(milliseconds)
{
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main()
{
    let options = null;
    try
    {
        options = parseArgs(process.argv.slice(2));
        const ledger = await runNormalWorkerObserver(options);
        process.stdout.write(`${JSON.stringify(ledger)}\n`);
    }
    catch (error)
    {
        const errors = errorList(error);
        try
        {
            writeFailureEvidence(options?.out, options, errors);
        }
        catch (writeError)
        {
            errors.push(...errorList(writeError));
        }
        for (const item of unique(errors))
        {
            process.stderr.write(`[release-worker-normal-observer] ${item}\n`);
        }
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    await main();
}
