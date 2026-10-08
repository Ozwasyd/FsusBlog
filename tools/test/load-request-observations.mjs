import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { threadId } from 'node:worker_threads';

import { canonicalJson, digestCanonical, sealContentDigest } from './attempt-provenance.mjs';
import { routeContract } from './lanes/runtime-http-route-contract.mjs';
import { classifyLoadTransportFailure } from './open-loop-load-client-transport.mjs';

const sampleKeys = ['sampleId', 'workerId', 'sequence', 'path', 'startedMonotonicMs', 'finishedMonotonicMs',
    'durationMs', 'outcome', 'httpStatus', 'bytes', 'contentType', 'frameType', 'errorKind', 'errorCode', 'errorDigest'];
const outcomes = ['success', 'http-error', 'timeout', 'network-error', 'cancelled'];
const resourceUnits = { cpuPercent: 'percent', rssBytes: 'bytes', managedHeapBytes: 'bytes', gcCount: 'count',
    threadCount: 'count', socketCount: 'count', postgresPoolUsage: 'connections', redisLatencyMs: 'ms' };
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function exact(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    {
        throw new Error(`${label} requires exact explicit fields`);
    }
}

function finite(value, label, integer = false)
{
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
    {
        throw new Error(`${label} requires an observed finite non-negative ${integer ? 'integer' : 'number'}`);
    }
}

function freeze(value)
{
    if (value && typeof value === 'object')
    {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}

export function observeLoadIssuer()
{
    return freeze({ pid: process.pid, threadId, executable: process.execPath, nodeVersion: process.versions.node });
}

/** A caller registers the actual Node issuer before dispatch; this is not the native logical-worker barrier. */
export function validateLoadWorkerRegistration(registration)
{
    exact(registration, ['workerId', 'issuer'], 'held load worker registration');
    exact(registration.issuer, ['pid', 'threadId', 'executable', 'nodeVersion'], 'held load issuer');
    const actual = observeLoadIssuer();
    if (registration.workerId !== String(actual.threadId)
        || canonicalJson(registration.issuer) !== canonicalJson(actual))
    {
        throw new Error('held worker registration differs from the actual issuing Node thread/process');
    }
    return freeze({ workerId: registration.workerId, issuer: { ...actual } });
}

/** Preserve actual exception facts; the digest hashes messages, but classification never reads them. */
export function observeLoadTransportError(error, origin)
{
    if (!(error instanceof Error) || !['transport', 'deadline', 'scenario-cancel'].includes(origin))
    {
        throw new Error('transport error observation requires an actual exception and explicit control-flow origin');
    }
    const causes = [];
    const visited = new Set();
    for (let current = error; current instanceof Error; current = current.cause)
    {
        if (visited.has(current))
        {
            throw new Error('transport exception cause chain contains a cycle');
        }
        if (causes.length >= 8)
        {
            throw new Error('transport exception cause chain exceeds the bounded observation contract');
        }
        visited.add(current);
        const code = current.code ?? null;
        if (code !== null && typeof code !== 'string' && !Number.isSafeInteger(code))
        {
            throw new Error('transport exception code is not an observable scalar');
        }
        causes.push({ name: current.name, code, messageDigest: digestCanonical({ message: current.message }) });
    }
    return freeze(sealContentDigest({ schema: 'fsusblog.load-transport-error-observation.v1', origin, causes,
        code: causes.find((cause) => cause.code !== null)?.code ?? null }));
}

function validateError(error)
{
    exact(error, ['schema', 'origin', 'causes', 'code', 'contentDigest'], 'transport error observation');
    const { contentDigest, ...content } = error;
    if (error.schema !== 'fsusblog.load-transport-error-observation.v1'
        || !['transport', 'deadline', 'scenario-cancel'].includes(error.origin)
        || !Array.isArray(error.causes) || error.causes.length < 1 || error.causes.length > 8
        || contentDigest !== digestCanonical(content))
    {
        throw new Error('transport error observation has incomplete origin or content binding');
    }
    for (const cause of error.causes)
    {
        exact(cause, ['name', 'code', 'messageDigest'], 'observed exception cause');
        if (typeof cause.name !== 'string' || !cause.name || !digestPattern.test(cause.messageDigest)
            || cause.code !== null && typeof cause.code !== 'string' && !Number.isSafeInteger(cause.code))
        {
            throw new Error('observed exception name/code/digest is invalid');
        }
    }
    if (error.code !== (error.causes.find((cause) => cause.code !== null)?.code ?? null))
    {
        throw new Error('transport error code differs from its actual retained cause chain');
    }
}

export function validateLoadRequestSample(sample)
{
    exact(sample, sampleKeys, 'load request sample');
    if (typeof sample.sampleId !== 'string' || !sample.sampleId || typeof sample.workerId !== 'string' || !sample.workerId
        || typeof sample.path !== 'string' || !sample.path.startsWith('/') || sample.path.startsWith('//')
        || !outcomes.includes(sample.outcome))
    {
        throw new Error('load sample identity/path/outcome is incomplete');
    }
    for (const key of ['sequence', 'httpStatus', 'bytes'])
    {
        finite(sample[key], key, true);
    }
    for (const key of ['startedMonotonicMs', 'finishedMonotonicMs', 'durationMs'])
    {
        finite(sample[key], key);
    }
    if (sample.finishedMonotonicMs < sample.startedMonotonicMs
        || sample.durationMs !== sample.finishedMonotonicMs - sample.startedMonotonicMs
        || sample.httpStatus !== 0 && (sample.httpStatus < 100 || sample.httpStatus > 599)
        || sample.contentType !== null && typeof sample.contentType !== 'string'
        || sample.frameType !== null && (!Number.isSafeInteger(sample.frameType) || sample.frameType < 0 || sample.frameType > 65535)
        || sample.errorCode !== null && typeof sample.errorCode !== 'string' && !Number.isSafeInteger(sample.errorCode))
    {
        throw new Error('load sample observations contradict their actual timing/response');
    }
    if (sample.outcome === 'success'
        ? sample.httpStatus < 200 || sample.httpStatus >= 400 || sample.errorKind !== null || sample.errorCode !== null || sample.errorDigest !== null
        : typeof sample.errorKind !== 'string' || !sample.errorKind || !digestPattern.test(sample.errorDigest))
    {
        throw new Error('load sample error/outcome observations are incomplete');
    }
    return sample;
}

/** Build one exact sample from a registered issuer, real callback timing and separately retained response/error facts. */
export function buildLoadRequestSample({ arrival, registration, sequence, startedMonotonicMs, finishedMonotonicMs,
    routeSample, response, terminalControl, error = null, transportFailureFacts = null })
{
    validateLoadWorkerRegistration(registration);
    if (!arrival || !Number.isSafeInteger(sequence) || sequence < 0
        || typeof arrival.sampleId !== 'string' || !arrival.sampleId || routeSample?.routeId !== arrival.routeId)
    {
        throw new Error('request observations require the actual dispatched arrival identity');
    }
    exact(response, ['httpStatus', 'bytes', 'contentType', 'frameType'], 'actual response observation');
    if (!['completed', 'timeout', 'cancelled'].includes(terminalControl))
    {
        throw new Error('request observations require an explicit terminal control-flow result');
    }
    if (error !== null)
    {
        validateError(error);
    }
    let outcome;
    let errorKind = null;
    let errorCode = null;
    let errorDigest = null;
    if (transportFailureFacts !== null)
    {
        if (error !== null || routeSample.ok === true)
        {
            throw new Error('typed transport failure cannot duplicate another observation or contradict route success');
        }
        const classified = classifyLoadTransportFailure(transportFailureFacts);
        const expectedControl = classified.outcome === 'timeout' ? 'timeout' : classified.outcome === 'cancelled' ? 'cancelled' : 'completed';
        if (terminalControl !== expectedControl)
        {
            throw new Error('actual transport failure differs from dispatcher terminal control');
        }
        ({ outcome, errorKind, errorCode, errorDigest } = classified);
    }
    else if (terminalControl !== 'completed')
    {
        const origin = terminalControl === 'timeout' ? 'deadline' : 'scenario-cancel';
        if (error?.origin !== origin)
        {
            throw new Error('timeout/cancellation requires its actual independently retained abort observation');
        }
        outcome = terminalControl === 'timeout' ? 'timeout' : 'cancelled';
        errorKind = origin;
        errorCode = error.code;
        errorDigest = error.contentDigest;
    }
    else if (error !== null)
    {
        if (error.origin !== 'transport')
        {
            throw new Error('a deadline or cancellation cannot become an ordinary network error');
        }
        outcome = 'network-error';
        errorKind = 'transport';
        errorCode = error.code;
        errorDigest = error.contentDigest;
    }
    else if (response.httpStatus >= 100 && (response.httpStatus < 200 || response.httpStatus >= 400 || routeSample.ok !== true))
    {
        outcome = 'http-error';
        errorKind = response.httpStatus >= 400 ? 'http-status' : 'http-contract';
        errorDigest = digestCanonical({ response, routeFailure: routeSample.failureKind });
    }
    else if (routeSample.ok === true)
    {
        outcome = 'success';
    }
    else
    {
        throw new Error('failed transport result lost its typed exception observation; request evidence is incomplete');
    }
    const sample = { sampleId: arrival.sampleId, workerId: registration.workerId, sequence,
        path: routeContract(arrival.routeId).pathTemplate, startedMonotonicMs, finishedMonotonicMs,
        durationMs: finishedMonotonicMs - startedMonotonicMs, outcome, ...response, errorKind, errorCode, errorDigest };
    validateLoadRequestSample(sample);
    return freeze(sample);
}

export function buildLoadResourceObservability(observations = {})
{
    if (!observations || typeof observations !== 'object' || Array.isArray(observations)
        || Object.keys(observations).some((key) => !Object.hasOwn(resourceUnits, key)))
    {
        throw new Error('backend resource observations have an unsupported metric');
    }
    const result = {};
    for (const [metric, unit] of Object.entries(resourceUnits))
    {
        const observation = Object.hasOwn(observations, metric) ? observations[metric] : { status: 'unavailable', value: null,
            reason: `No held current-run backend lease/collector observation for ${metric}`, source: null };
        if (!observation || typeof observation !== 'object' || Array.isArray(observation))
        {
            throw new Error(`${metric} availability requires its explicit object`);
        }
        if (observation.status === 'ok')
        {
            exact(observation, ['status', 'value', 'unit', 'source'], `${metric} availability`);
            finite(observation.value, metric);
            if (observation.unit !== unit || typeof observation.source !== 'string' || !observation.source)
            {
                throw new Error(`${metric} requires its actual backend metric unit/source`);
            }
        }
        else
        {
            exact(observation, ['status', 'value', 'reason', 'source'], `${metric} availability`);
            if (!['unsupported', 'unavailable', 'probe-failed'].includes(observation.status) || observation.value !== null
                || typeof observation.reason !== 'string' || !observation.reason.trim()
                || observation.source !== null && (typeof observation.source !== 'string' || !observation.source))
            {
                throw new Error(`${metric} requires an explicit unavailable state/reason`);
            }
        }
        result[metric] = { ...observation };
    }
    return freeze(result);
}

/** Source accounting only: native worker/window/lease authority is a separate required gate. */
export function buildLoadRequestObservations({ samples, expectedRequests, resourceObservability = buildLoadResourceObservability() })
{
    if (!Array.isArray(samples) || !Array.isArray(expectedRequests))
    {
        throw new Error('load observations require explicit actual and expected dispatched membership');
    }
    const canonical = samples.map(validateLoadRequestSample).sort((a, b) => a.workerId.localeCompare(b.workerId) || a.sequence - b.sequence);
    const expected = expectedRequests.map((entry) =>
    {
        exact(entry, ['sampleId', 'workerId', 'sequence', 'path'], 'expected dispatched request');
        return { ...entry };
    }).sort((a, b) => a.workerId.localeCompare(b.workerId) || a.sequence - b.sequence);
    const membership = canonical.map(({ sampleId, workerId, sequence, path }) => ({ sampleId, workerId, sequence, path }));
    if (new Set(canonical.map((sample) => sample.sampleId)).size !== canonical.length
        || new Set(canonical.map((sample) => `${sample.workerId}:${sample.sequence}`)).size !== canonical.length
        || canonicalJson(membership) !== canonicalJson(expected))
    {
        throw new Error('load samples differ from exact dispatched request/worker sequence membership');
    }
    const nextSequences = new Map();
    for (const sample of canonical)
    {
        const next = nextSequences.get(sample.workerId) ?? 0;
        if (sample.sequence !== next)
        {
            throw new Error('load samples have a missing worker request sequence');
        }
        nextSequences.set(sample.workerId, next + 1);
    }
    const counts = Object.fromEntries(outcomes.map((outcome) => [outcome, canonical.filter((sample) => sample.outcome === outcome).length]));
    const completed = counts.success + counts['http-error'] + counts.timeout + counts['network-error'];
    const failed = counts['http-error'] + counts['network-error'];
    const latencies = canonical.filter((sample) => sample.outcome === 'success').map((sample) => sample.durationMs).sort((a, b) => a - b);
    const percentile = (p) => latencies.length ? latencies[Math.ceil(latencies.length * p) - 1] : null;
    const statuses = {};
    canonical.forEach((sample) => statuses[sample.httpStatus] = (statuses[sample.httpStatus] ?? 0) + 1);
    return freeze(sealContentDigest({ schema: 'fsusblog.load-request-observations.v1', samples: canonical,
        sampleCount: canonical.length, outcomeCounts: counts, completed, failed,
        errorRate: completed ? failed / completed : null, timeoutRate: completed ? counts.timeout / completed : null,
        latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) ?? null },
        statusDistribution: statuses, samplesDigest: digestCanonical(canonical), membershipDigest: digestCanonical(expected),
        resourceObservability: buildLoadResourceObservability(resourceObservability),
        observationsComplete: completed > 0 && counts.cancelled === 0,
        nativeWorkerAuthorityVerified: false, nativeResourceAuthorityVerified: false, qualificationEligible: false }));
}

export function verifyLoadRequestObservations(candidate, inputs)
{
    const actual = buildLoadRequestObservations(inputs);
    if (canonicalJson(candidate) !== canonicalJson(actual))
    {
        throw new Error('load request observations differ from independently recomputed samples/membership/resources');
    }
    return actual;
}

export function observeLoadRequestStart(arrival, registration, sequence)
{
    const worker = validateLoadWorkerRegistration(registration);
    finite(sequence, 'actual worker request sequence', true);
    return freeze({ arrival: { ...arrival }, registration: worker, sequence, startedMonotonicMs: performance.now() });
}
