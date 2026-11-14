import { createHash } from 'node:crypto';

/** @typedef {'success' | 'http-error' | 'timeout' | 'network-error' | 'cancelled'} LoadSampleOutcome */

/**
 * Terminal facts supplied by the caller; this module does not classify exceptions
 * or observe requests. A zero HTTP status means explicitly observed no response,
 * never an unknown status. Failure kinds/codes/digests retain the caller's facts.
 * @typedef {object} LoadSample
 * @property {string} sampleId
 * @property {string} workerId
 * @property {number} sequence Zero-based sequence within the registered worker.
 * @property {string} path
 * @property {number} startedMonotonicMs
 * @property {number} finishedMonotonicMs
 * @property {number} durationMs Exact difference of the supplied monotonic times.
 * @property {LoadSampleOutcome} outcome
 * @property {number} httpStatus
 * @property {number} bytes Observed bytes, including partial responses.
 * @property {string | null} contentType
 * @property {number | null} frameType
 * @property {string | null} errorKind
 * @property {string | number | null} errorCode
 * @property {string | null} errorDigest
 */

/**
 * Caller-owned dispatched membership, supplied independently of actual samples.
 * @typedef {object} ExpectedLoadRequest
 * @property {string} sampleId
 * @property {string} workerId
 * @property {number} sequence
 * @property {string} path
 */

/**
 * @typedef {{status: 'ok', value: number, unit: string, source: string} |
 * {status: 'unsupported' | 'unavailable' | 'probe-failed', value: null, reason: string, source: string | null}} LoadResourceObservation
 */

const sampleKeys = ['sampleId', 'workerId', 'sequence', 'path', 'startedMonotonicMs',
    'finishedMonotonicMs', 'durationMs', 'outcome', 'httpStatus', 'bytes', 'contentType',
    'frameType', 'errorKind', 'errorCode', 'errorDigest'];
const membershipKeys = ['sampleId', 'workerId', 'sequence', 'path'];
const outcomes = ['success', 'http-error', 'timeout', 'network-error', 'cancelled'];
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const resourceUnits = {
    cpuPercent: 'percent',
    rssBytes: 'bytes',
    managedHeapBytes: 'bytes',
    gcCount: 'count',
    threadCount: 'count',
    socketCount: 'count',
    postgresPoolUsage: 'connections',
    redisLatencyMs: 'ms'
};

/**
 * @param {*} value Untrusted boundary value.
 * @param {string[]} keys
 * @param {string} label
 */
function exactKeys(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    {
        throw new Error(`${label} requires exact explicit fields`);
    }
}

/** @param {*} value */
function nonemptyText(value)
{
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * @param {*} value Untrusted boundary value.
 * @param {string} label
 * @param {boolean} [integer]
 */
function finiteNonnegative(value, label, integer = false)
{
    if (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
    {
        throw new Error(`${label} requires an observed finite non-negative ${integer ? 'integer' : 'number'}`);
    }
}

/** @param {ExpectedLoadRequest} entry */
function validateMembership(entry)
{
    if (!nonemptyText(entry.sampleId) || !nonemptyText(entry.workerId)
        || typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.startsWith('//'))
    {
        throw new Error('load request identity/path is incomplete');
    }
    finiteNonnegative(entry.sequence, 'worker sequence', true);
}

/**
 * Reject malformed or contradictory terminal facts; never coerce unknown values.
 * An http-error requires a terminal HTTP status from 400 through 599.
 * This validates representation only, not the provenance of a typed outcome.
 * @param {LoadSample} sample
 * @returns {LoadSample} A detached immutable copy.
 */
export function validateLoadSample(sample)
{
    exactKeys(sample, sampleKeys, 'load sample');
    validateMembership(sample);
    if (!outcomes.includes(sample.outcome))
    {
        throw new Error('load sample requires a typed terminal outcome');
    }
    finiteNonnegative(sample.startedMonotonicMs, 'startedMonotonicMs');
    finiteNonnegative(sample.finishedMonotonicMs, 'finishedMonotonicMs');
    finiteNonnegative(sample.durationMs, 'durationMs');
    finiteNonnegative(sample.httpStatus, 'httpStatus', true);
    finiteNonnegative(sample.bytes, 'bytes', true);
    if (sample.finishedMonotonicMs < sample.startedMonotonicMs
        || sample.durationMs !== sample.finishedMonotonicMs - sample.startedMonotonicMs
        || sample.httpStatus !== 0 && (sample.httpStatus < 100 || sample.httpStatus > 599)
        || sample.contentType !== null && typeof sample.contentType !== 'string'
        || sample.frameType !== null && (!Number.isSafeInteger(sample.frameType) || sample.frameType < 0 || sample.frameType > 65535)
        || sample.errorCode !== null && !nonemptyText(sample.errorCode) && !Number.isSafeInteger(sample.errorCode))
    {
        throw new Error('load sample contains contradictory timing/response/error facts');
    }
    if (sample.httpStatus === 0 && (sample.bytes !== 0 || sample.contentType !== null || sample.frameType !== null))
    {
        throw new Error('explicit no-response status contradicts received response facts');
    }
    if (sample.outcome === 'success')
    {
        if (sample.httpStatus < 200 || sample.httpStatus >= 400
            || sample.errorKind !== null || sample.errorCode !== null || sample.errorDigest !== null)
        {
            throw new Error('successful load sample contradicts response/error facts');
        }
    }
    else if (!nonemptyText(sample.errorKind) || typeof sample.errorDigest !== 'string' || !digestPattern.test(sample.errorDigest)
        || sample.outcome === 'http-error' && (sample.httpStatus < 400 || sample.httpStatus > 599))
    {
        throw new Error('failed load sample requires explicit response/error facts');
    }
    return Object.freeze({ ...sample });
}

/**
 * @param {ExpectedLoadRequest} left
 * @param {ExpectedLoadRequest} right
 */
function compareRequests(left, right)
{
    // Ordinal comparison keeps canonical membership independent of host locale.
    return (left.workerId < right.workerId ? -1 : Number(left.workerId > right.workerId))
        || left.sequence - right.sequence;
}

/**
 * @param {ExpectedLoadRequest[]} entries
 * @param {string} label
 */
function checkUniqueSequences(entries, label)
{
    const sampleIds = new Set();
    const nextSequences = new Map();
    for (const entry of entries)
    {
        if (sampleIds.has(entry.sampleId))
        {
            throw new Error(`${label} contains a duplicate sampleId`);
        }
        sampleIds.add(entry.sampleId);
        if (entry.sequence !== (nextSequences.get(entry.workerId) ?? 0))
        {
            throw new Error(`${label} contains a duplicate or missing worker sequence`);
        }
        nextSequences.set(entry.workerId, entry.sequence + 1);
    }
}

/**
 * Require exact dispatched membership, including trailing failures/cancellations.
 * Validate both sets independently so an invalid expected set cannot hide gaps.
 * Membership does not establish worker registration, native concurrency or a
 * measurement window; those remain the caller's responsibilities.
 * @param {LoadSample[]} samples
 * @param {ExpectedLoadRequest[]} expectedRequests Independent dispatched roster.
 * @returns Detached samples in worker/sequence order, frozen at runtime.
 */
export function canonicalizeLoadSamples(samples, expectedRequests)
{
    if (!Array.isArray(samples) || !Array.isArray(expectedRequests))
    {
        throw new Error('load samples require explicit actual and expected membership arrays');
    }
    const canonical = samples.map(validateLoadSample).sort(compareRequests);
    const expected = expectedRequests.map((entry) =>
    {
        exactKeys(entry, membershipKeys, 'expected load request');
        validateMembership(entry);
        const { sampleId, workerId, sequence, path } = entry;
        return { sampleId, workerId, sequence, path };
    }).sort(compareRequests);
    checkUniqueSequences(canonical, 'actual load samples');
    checkUniqueSequences(expected, 'expected load requests');
    if (canonical.length !== expected.length || canonical.some((sample, index) =>
        sample.sampleId !== expected[index].sampleId || sample.workerId !== expected[index].workerId
        || sample.sequence !== expected[index].sequence || sample.path !== expected[index].path))
    {
        throw new Error('load samples differ from exact dispatched membership');
    }
    return Object.freeze(canonical);
}

/**
 * @param {*} value Validated scalar sample tree only.
 * @returns {string}
 */
function canonicalJson(value)
{
    if (Array.isArray(value))
    {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value !== null && typeof value === 'object')
    {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

/**
 * @param {number[]} sorted
 * @param {number} fraction
 */
function percentile(sorted, fraction)
{
    return sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1];
}

/**
 * Recompute every metric from one validated canonical set; no producer totals
 * are accepted. Completed = success + http-error + timeout + network-error;
 * failed = http-error + network-error. Cancellation stays visible and is excluded
 * from both rate denominators and latency. Latency uses all completed durations,
 * including failures/timeouts, with nearest-rank percentiles and no rounding.
 * An absent duration or empty completed set yields null plus a reason, never a
 * fabricated zero. A supplied duration is arithmetic input, not window evidence.
 * Returns arithmetic only: no threshold, summary status or qualification result.
 * @param {object} input
 * @param {LoadSample[]} input.samples
 * @param {ExpectedLoadRequest[]} input.expectedRequests
 * @param {number | null} [input.durationMs] Caller-observed elapsed duration.
 * @returns {object} Recalculated metrics and the canonical sample digest.
 */
export function calculateLoadSampleMetrics({ samples, expectedRequests, durationMs = null })
{
    const canonical = canonicalizeLoadSamples(samples, expectedRequests);
    if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0))
    {
        throw new Error('durationMs requires a positive observed duration or explicit null');
    }
    const outcomeCounts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0]));
    /** @type {{[key: string]: number}} */
    const statusDistribution = {};
    const latencies = [];
    for (const sample of canonical)
    {
        outcomeCounts[sample.outcome] += 1;
        const status = String(sample.httpStatus);
        statusDistribution[status] = (statusDistribution[status] ?? 0) + 1;
        if (sample.outcome !== 'cancelled')
        {
            latencies.push(sample.durationMs);
        }
    }
    latencies.sort((left, right) => left - right);
    const completed = outcomeCounts.success + outcomeCounts['http-error'] + outcomeCounts.timeout + outcomeCounts['network-error'];
    const failed = outcomeCounts['http-error'] + outcomeCounts['network-error'];
    const rateReason = completed === 0 ? 'no-completed-samples' : null;
    const rpsReason = rateReason ?? (durationMs === null ? 'duration-unavailable' : null);
    const rps = completed > 0 && durationMs !== null ? completed / durationMs * 1000 : null;
    if (rps !== null && !Number.isFinite(rps))
    {
        throw new Error('observed count/duration produces a non-finite RPS');
    }
    return Object.freeze({
        sampleCount: canonical.length,
        outcomeCounts: Object.freeze(outcomeCounts),
        completed,
        failed,
        timeoutCount: outcomeCounts.timeout,
        cancelledCount: outcomeCounts.cancelled,
        statusDistribution: Object.freeze(statusDistribution),
        errorRate: completed === 0 ? null : failed / completed,
        timeoutRate: completed === 0 ? null : outcomeCounts.timeout / completed,
        latencySampleCount: latencies.length,
        latencyMs: Object.freeze({
            min: latencies[0] ?? null,
            p50: percentile(latencies, 0.5),
            p95: percentile(latencies, 0.95),
            p99: percentile(latencies, 0.99),
            max: latencies.at(-1) ?? null
        }),
        durationMs,
        rps,
        unavailableReasons: Object.freeze({ rates: rateReason, latencyMs: rateReason, rps: rpsReason }),
        samplesDigest: `sha256:${createHash('sha256').update(canonicalJson(canonical)).digest('hex')}`
    });
}

/**
 * Copy explicit resource availability, filling omitted observations as unavailable
 * with a reason. Bare null, unknown fields/statuses, unavailable-without-reason,
 * and ok-without-value/unit/source are rejected. No collectors or thresholds run.
 * @param {{[key: string]: LoadResourceObservation}} [observations] Caller-supplied resource observations.
 * @returns {object} All resource fields with explicit availability.
 */
export function normalizeLoadResourceObservability(observations = {})
{
    if (!observations || typeof observations !== 'object' || Array.isArray(observations)
        || Object.keys(observations).some((key) => !Object.hasOwn(resourceUnits, key)))
    {
        throw new Error('resource observations require known explicit metric fields');
    }
    /** @type {{[key: string]: LoadResourceObservation}} */
    const result = {};
    for (const [metric, unit] of Object.entries(resourceUnits))
    {
        /** @type {LoadResourceObservation} */
        const observation = Object.hasOwn(observations, metric) ? observations[metric] : {
            status: 'unavailable', value: null, reason: `No observation supplied for ${metric}`, source: null
        };
        if (observation?.status === 'ok')
        {
            exactKeys(observation, ['status', 'value', 'unit', 'source'], metric);
            finiteNonnegative(observation.value, metric, ['bytes', 'count'].includes(unit));
            if (observation.unit !== unit || !nonemptyText(observation.source))
            {
                throw new Error(`${metric} requires its metric unit and observation source`);
            }
        }
        else
        {
            exactKeys(observation, ['status', 'value', 'reason', 'source'], metric);
            if (!['unsupported', 'unavailable', 'probe-failed'].includes(observation.status)
                || observation.value !== null || !nonemptyText(observation.reason)
                || observation.source !== null && !nonemptyText(observation.source))
            {
                throw new Error(`${metric} requires explicit unavailability and a non-empty reason`);
            }
        }
        result[metric] = Object.freeze({ ...observation });
    }
    return Object.freeze(result);
}
