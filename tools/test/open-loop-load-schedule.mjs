import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sealContentDigest } from './attempt-provenance.mjs';

const schema = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '../../config/schemas/release-load-arrival-policy.schema.json'), 'utf8'));
export const maximumMaterializedLoadRequests = 1_000_000;
export const maximumQualificationWindows = 100_000;
const scheduleSchema = 'fsusblog.release-load-arrival-schedule.v1';
const timelineSchema = 'fsusblog.release-load-arrival-timeline.v1';

function object(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => !keys.includes(key)))
    {
        throw new Error(`${label} has an invalid or unsupported shape`);
    }
}

function number(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER, integer = false)
{
    if (!Number.isFinite(value) || value < minimum || value > maximum
        || (integer && !Number.isSafeInteger(value)))
    {
        throw new Error(`${label} is outside its declared numeric bounds`);
    }
}

function freeze(value)
{
    if (value && typeof value === 'object')
    {
        for (const item of Object.values(value))
        {
            freeze(item);
        }
        Object.freeze(value);
    }
    return value;
}

export function validateLoadArrivalPolicy(candidate, expectedRouteIds)
{
    object(candidate, Object.keys(schema.properties), 'arrival policy');
    if (schema.required.some((key) => !Object.hasOwn(candidate, key)))
    {
        throw new Error('arrival policy requires every explicit declaration; closed-loop fields are insufficient');
    }
    if (candidate.schema !== schema.$id || typeof candidate.profileId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(candidate.profileId)
        || !schema.properties.arrivalModel.enum.includes(candidate.arrivalModel))
    {
        throw new Error('arrival policy schema, profile or arrival model is invalid');
    }
    for (const key of ['durationMs', 'maximumInFlight', 'requestTimeoutMs', 'qualificationWindowMs'])
    {
        const definition = schema.properties[key];
        number(candidate[key], key, definition.minimum, definition.maximum ?? candidate.durationMs, true);
    }
    number(Math.ceil(candidate.durationMs / candidate.qualificationWindowMs),
        'qualification window count', 1, maximumQualificationWindows, true);
    number(candidate.plannedRequestsPerSecond, 'plannedRequestsPerSecond', Number.MIN_VALUE);
    number(candidate.offeredRateTolerance, 'offeredRateTolerance', 0, 1);
    if (candidate.offeredRateTolerance === 1)
    {
        throw new Error('offeredRateTolerance cannot admit zero offered load');
    }
    const seed = candidate.scheduleSeed;
    if (!(typeof seed === 'string' && seed.length > 0 && seed.length <= 128)
        && !(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff))
    {
        throw new Error('scheduleSeed must be an explicit bounded string or unsigned integer');
    }
    if (!Array.isArray(candidate.burstWindows) || candidate.burstWindows.length > 256
        || (candidate.arrivalModel === 'constant' && candidate.burstWindows.length !== 0)
        || (candidate.arrivalModel !== 'constant' && candidate.burstWindows.length === 0))
    {
        throw new Error('arrival model requires its exact bounded window declarations');
    }
    const windows = candidate.burstWindows.map((window) =>
    {
        object(window, ['startMs', 'endMs', 'requestsPerSecond', 'recoveryEndMs'], 'arrival window');
        number(window.startMs, 'window.startMs', 0, candidate.durationMs, true);
        number(window.endMs, 'window.endMs', 1, candidate.durationMs, true);
        number(window.requestsPerSecond, 'window.requestsPerSecond', Number.MIN_VALUE);
        if (window.startMs >= window.endMs)
        {
            throw new Error('arrival window must have a positive half-open interval');
        }
        if (candidate.arrivalModel === 'burst')
        {
            number(window.recoveryEndMs, 'window.recoveryEndMs', 1, candidate.durationMs, true);
            if (window.recoveryEndMs <= window.endMs
                || window.requestsPerSecond <= candidate.plannedRequestsPerSecond)
            {
                throw new Error('burst requires a higher rate and explicit positive recovery interval');
            }
        }
        else if (Object.hasOwn(window, 'recoveryEndMs'))
        {
            throw new Error('step windows cannot declare burst recovery');
        }
        return { ...window };
    }).sort((left, right) => left.startMs - right.startMs);
    for (let index = 1; index < windows.length; index += 1)
    {
        if (windows[index].startMs < (windows[index - 1].recoveryEndMs ?? windows[index - 1].endMs))
        {
            throw new Error('arrival windows or burst recovery intervals overlap');
        }
    }
    if (!Array.isArray(candidate.routeMix) || candidate.routeMix.length < 1 || candidate.routeMix.length > 256)
    {
        throw new Error('routeMix must be a bounded non-empty explicit membership');
    }
    object(candidate.routeMix[0], ['routeId', 'weight', 'count'], 'route mix member');
    const mode = Object.hasOwn(candidate.routeMix[0], 'weight') ? 'weight' : 'count';
    const routes = candidate.routeMix.map((route) =>
    {
        object(route, ['routeId', mode], 'route mix member');
        if (typeof route.routeId !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(route.routeId))
        {
            throw new Error('route mix requires a canonical routeId');
        }
        number(route[mode], `route.${mode}`, 1, maximumMaterializedLoadRequests, true);
        return { ...route };
    }).sort((left, right) => left.routeId < right.routeId ? -1 : Number(left.routeId > right.routeId));
    if (new Set(routes.map((route) => route.routeId)).size !== routes.length)
    {
        throw new Error('route mix contains duplicate membership');
    }
    if (expectedRouteIds !== undefined)
    {
        if (!Array.isArray(expectedRouteIds) || new Set(expectedRouteIds).size !== expectedRouteIds.length
            || canonicalJson([...expectedRouteIds].sort()) !== canonicalJson(routes.map((route) => route.routeId)))
        {
            throw new Error('arrival route mix differs from the actual producer route contract');
        }
    }
    return freeze({ ...candidate, burstWindows: windows, routeMix: routes });
}

function segments(policy)
{
    const boundaries = [...new Set([0, policy.durationMs,
        ...policy.burstWindows.flatMap((window) => [window.startMs, window.endMs])])].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((startMs, index) =>
    {
        const window = policy.burstWindows.find((item) => item.startMs <= startMs && startMs < item.endMs);
        return { startMs, endMs: boundaries[index + 1], rate: window?.requestsPerSecond ?? policy.plannedRequestsPerSecond };
    });
}

function routeAssignments(policy, count)
{
    const mode = Object.hasOwn(policy.routeMix[0], 'weight') ? 'weight' : 'count';
    const total = policy.routeMix.reduce((sum, route) => sum + route[mode], 0);
    const shares = policy.routeMix.map((route) =>
    {
        const exact = mode === 'count' ? route.count : count * route.weight / total;
        return { routeId: route.routeId, count: Math.floor(exact), remainder: exact % 1 };
    });
    let missing = count - shares.reduce((sum, route) => sum + route.count, 0);
    if (mode === 'count' && missing !== 0)
    {
        throw new Error('explicit route counts do not equal the exact planned arrival count');
    }
    const ranked = [...shares].sort((a, b) => b.remainder - a.remainder
        || (a.routeId < b.routeId ? -1 : Number(a.routeId > b.routeId)));
    for (let index = 0; missing > 0; index += 1, missing -= 1)
    {
        ranked[index].count += 1;
    }
    if (shares.some((route) => route.count === 0))
    {
        throw new Error('arrival route mix would create a zero-sample route');
    }
    const assignments = shares.flatMap((route) => Array(route.count).fill(route.routeId));
    let state = createHash('sha256').update(String(policy.scheduleSeed)).digest().readUInt32LE(0);
    for (let index = assignments.length - 1; index > 0; index -= 1)
    {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        const other = state % (index + 1);
        [assignments[index], assignments[other]] = [assignments[other], assignments[index]];
    }
    return assignments;
}

export function buildOpenLoopLoadSchedule(candidate, expectedRouteIds)
{
    const policy = validateLoadArrivalPolicy(candidate, expectedRouteIds);
    const phases = segments(policy).map((phase) => ({ ...phase, count: Math.ceil((phase.endMs - phase.startMs) * phase.rate / 1000) }));
    const count = phases.reduce((sum, phase) => sum + phase.count, 0);
    number(count, 'materialized planned request count', 1, maximumMaterializedLoadRequests, true);
    const routes = routeAssignments(policy, count);
    const arrivals = [];
    for (const phase of phases)
    {
        for (let index = 0; index < phase.count; index += 1)
        {
            const plannedAtMs = phase.startMs + index * 1000 / phase.rate;
            if (plannedAtMs >= phase.endMs)
            {
                throw new Error('arrival timestamp cannot be represented inside its half-open phase');
            }
            const sequence = arrivals.length;
            arrivals.push({ sampleId: `arrival-${sequence}`, sequence, routeId: routes[sequence], plannedAtMs });
        }
    }
    return freeze(sealContentDigest({ schema: scheduleSchema, policy,
        policyDigest: sealContentDigest(policy).contentDigest, plannedCount: count, arrivals }));
}

export function verifyOpenLoopLoadSchedule(schedule, expectedRouteIds)
{
    object(schedule, ['schema', 'policy', 'policyDigest', 'plannedCount', 'arrivals', 'contentDigest'], 'arrival schedule');
    const expected = buildOpenLoopLoadSchedule(schedule.policy, expectedRouteIds);
    if (canonicalJson(schedule) !== canonicalJson(expected))
    {
        throw new Error('planned schedule differs from its exact policy, membership or digest');
    }
    return expected;
}

export function verifyOpenLoopLoadTimeline(schedule, timeline)
{
    verifyOpenLoopLoadSchedule(schedule);
    object(timeline, ['schema', 'scheduleDigest', 'policyDigest', 'observedActiveWindowMs', 'records', 'contentDigest'], 'arrival timeline');
    if (timeline.schema !== timelineSchema || timeline.scheduleDigest !== schedule.contentDigest
        || timeline.policyDigest !== schedule.policyDigest || sealContentDigest(timeline).contentDigest !== timeline.contentDigest
        || !Array.isArray(timeline.records) || timeline.records.length !== schedule.plannedCount)
    {
        throw new Error('arrival timeline identity, membership or digest is incomplete');
    }
    number(timeline.observedActiveWindowMs, 'observedActiveWindowMs');
    for (const record of timeline.records)
    {
        object(record, ['sampleId', 'sequence', 'routeId', 'plannedAtMs', 'dispatchedAtMs', 'completedAtMs', 'observedAtMs',
            'scheduleLagMs', 'outcome', 'failureKind', 'sample'], 'arrival observation');
        number(record.sequence, 'sequence', 0, schedule.plannedCount - 1, true);
    }
    const records = [...timeline.records].sort((a, b) => a.sequence - b.sequence);
    const windows = Array.from({ length: Math.ceil(schedule.policy.durationMs / schedule.policy.qualificationWindowMs) }, (_, index) =>
    {
        const startMs = index * schedule.policy.qualificationWindowMs;
        return { startMs, endMs: Math.min(schedule.policy.durationMs, startMs + schedule.policy.qualificationWindowMs),
            planned: 0, dispatched: 0, passed: false };
    });
    const events = [];
    const counts = { planned: records.length, dispatched: 0, completed: 0, timedOut: 0, dropped: 0, cancelled: 0 };
    for (const [index, record] of records.entries())
    {
        object(record, ['sampleId', 'sequence', 'routeId', 'plannedAtMs', 'dispatchedAtMs', 'completedAtMs', 'observedAtMs',
            'scheduleLagMs', 'outcome', 'failureKind', 'sample'], 'arrival observation');
        const planned = schedule.arrivals[index];
        if (['sampleId', 'sequence', 'routeId', 'plannedAtMs'].some((key) => record[key] !== planned[key])
            || !['completed', 'timed-out', 'dropped', 'cancelled'].includes(record.outcome))
        {
            throw new Error('actual arrival membership or terminal classification differs from the plan');
        }
        number(record.observedAtMs, 'observedAtMs');
        if (!Object.hasOwn(record, 'sample') || !Object.hasOwn(record, 'failureKind')
            || (record.failureKind !== null && typeof record.failureKind !== 'string'))
        {
            throw new Error('actual arrival requires explicit sample availability and failure classification');
        }
        windows[Math.floor(record.plannedAtMs / schedule.policy.qualificationWindowMs)].planned += 1;
        if (record.dispatchedAtMs !== null)
        {
            number(record.dispatchedAtMs, 'dispatchedAtMs', record.plannedAtMs);
            number(record.completedAtMs, 'completedAtMs', record.dispatchedAtMs);
            number(record.scheduleLagMs, 'scheduleLagMs');
            if (record.dispatchedAtMs >= schedule.policy.durationMs
                || record.scheduleLagMs !== record.dispatchedAtMs - record.plannedAtMs || record.outcome === 'dropped')
            {
                throw new Error('dispatch crossed the deadline or altered its original planned timestamp');
            }
            if (record.observedAtMs < record.completedAtMs)
            {
                throw new Error('terminal observation predates its actual completion');
            }
            if (record.completedAtMs > record.dispatchedAtMs)
            {
                events.push({ at: record.dispatchedAtMs, delta: 1 }, { at: record.completedAtMs, delta: -1 });
            }
            windows[Math.floor(record.dispatchedAtMs / schedule.policy.qualificationWindowMs)].dispatched += 1;
            counts.dispatched += 1;
        }
        else if (record.completedAtMs !== null || record.scheduleLagMs !== null || record.sample !== null
            || !['dropped', 'cancelled'].includes(record.outcome))
        {
            throw new Error('undispatched arrival cannot fabricate a completion, lag or response sample');
        }
        if (record.outcome === 'dropped' && !['generator-backpressure-drop', 'generator-schedule-expired'].includes(record.failureKind))
        {
            throw new Error('dropped arrival requires its actual generator refusal reason');
        }
        if (record.outcome === 'cancelled' && record.failureKind !== 'scenario-cancelled'
            || record.outcome === 'dropped' && record.observedAtMs < record.plannedAtMs)
        {
            throw new Error('cancellation or drop observation contradicts its actual terminal reason');
        }
        if (record.sample !== null && (record.sample.routeId !== record.routeId || typeof record.sample.ok !== 'boolean'
            || !Object.hasOwn(record.sample, 'failureKind')
            || record.sample.ok !== (record.sample.failureKind === null)))
        {
            throw new Error('actual response sample is not bound to its planned route oracle');
        }
        if (record.sample !== null && ['completed', 'timed-out'].includes(record.outcome)
            && (record.failureKind !== record.sample.failureKind
                || (record.outcome === 'timed-out') !== (record.sample.failureKind === 'timeout')))
        {
            throw new Error('terminal classification contradicts the actual settled route oracle result');
        }
        if (record.outcome === 'timed-out' && record.sample?.failureKind !== 'timeout'
            || record.outcome === 'completed' && record.sample === null && record.failureKind !== 'request-adapter-failed')
        {
            throw new Error('completion classification requires an actual settled response or adapter failure');
        }
        counts[{ completed: 'completed', 'timed-out': 'timedOut', dropped: 'dropped', cancelled: 'cancelled' }[record.outcome]] += 1;
    }
    let active = 0;
    for (const event of events.sort((a, b) => a.at - b.at || a.delta - b.delta))
    {
        active += event.delta;
        if (active > schedule.policy.maximumInFlight)
        {
            throw new Error('actual timeline exceeds maximumInFlight');
        }
    }
    for (const window of windows)
    {
        const seconds = (window.endMs - window.startMs) / 1000;
        window.plannedRequestsPerSecond = window.planned / seconds;
        window.dispatchedRequestsPerSecond = window.dispatched / seconds;
        window.passed = Math.abs(window.dispatched - window.planned)
            <= window.planned * schedule.policy.offeredRateTolerance;
    }
    return { qualificationEligible: false, counts, windows,
        passed: timeline.observedActiveWindowMs >= schedule.policy.durationMs && counts.cancelled === 0
            && counts.dropped === 0 && records.every((record) => record.failureKind !== 'request-adapter-failed')
            && windows.every((window) => window.passed) };
}

export async function dispatchOpenLoopLoadSchedule(schedule, {
    request, signal, clock = () => performance.now(), sleep = (ms, options) => delay(ms, undefined, options),
    onMeasurementStart = () =>
    {}, onMeasurementEnd = () =>
    {}
})
{
    verifyOpenLoopLoadSchedule(schedule);
    if ([request, clock, sleep, onMeasurementStart, onMeasurementEnd].some((port) => typeof port !== 'function'))
    {
        throw new Error('open-loop dispatcher requires observable request and monotonic clock ports');
    }
    let lastClock = -Infinity;
    function now()
    {
        const value = clock();
        number(value, 'monotonic clock');
        if (value < lastClock)
        {
            throw new Error('monotonic clock moved backwards');
        }
        lastClock = value;
        return value;
    }
    async function wait(ms)
    {
        try
        {
            await sleep(Math.max(0, ms), { signal });
        }
        catch (error)
        {
            if (!signal?.aborted)
            {
                throw error;
            }
        }
    }
    const start = now();
    const records = [];
    const pending = new Set();
    const requestTimers = new Set();
    const scope = new AbortController();
    const measurement = freeze({ scheduleDigest: schedule.contentDigest, startedMonotonicMs: start,
        durationMs: schedule.policy.durationMs, plannedEndMonotonicMs: start + schedule.policy.durationMs });
    function observeMeasurement(port, observation)
    {
        const result = port(freeze(observation));
        if (result && typeof result.then === 'function')
        {
            throw new Error('measurement collector ports must complete synchronously');
        }
    }
    try
    {
        observeMeasurement(onMeasurementStart, measurement);
        for (const arrival of schedule.arrivals)
        {
            while (!signal?.aborted && now() - start < arrival.plannedAtMs)
            {
                await wait(arrival.plannedAtMs - (now() - start));
            }
            const at = now() - start;
            const record = { ...arrival, dispatchedAtMs: null, completedAtMs: null, observedAtMs: at,
                scheduleLagMs: null, outcome: 'cancelled', failureKind: 'scenario-cancelled', sample: null };
            records.push(record);
            if (signal?.aborted)
            {
                continue;
            }
            if (at >= schedule.policy.durationMs || pending.size >= schedule.policy.maximumInFlight)
            {
                record.outcome = 'dropped';
                record.failureKind = at >= schedule.policy.durationMs ? 'generator-schedule-expired' : 'generator-backpressure-drop';
                continue;
            }
            const timeout = new AbortController();
            const deadlineReason = Object.assign(
                new DOMException('load request deadline expired', 'AbortError'), { transportStage: 'request-timeout' }
            );
            const requestTimer = setTimeout(() => timeout.abort(deadlineReason), schedule.policy.requestTimeoutMs);
            requestTimers.add(requestTimer);
            const requestSignal = AbortSignal.any([scope.signal, ...(signal ? [signal] : []), timeout.signal]);
            const dispatchedAtMs = now() - start;
            record.observedAtMs = dispatchedAtMs;
            if (signal?.aborted || dispatchedAtMs >= schedule.policy.durationMs)
            {
                clearTimeout(requestTimer);
                requestTimers.delete(requestTimer);
                if (!signal?.aborted)
                {
                    record.outcome = 'dropped';
                    record.failureKind = 'generator-schedule-expired';
                }
                continue;
            }
            record.dispatchedAtMs = dispatchedAtMs;
            record.scheduleLagMs = dispatchedAtMs - arrival.plannedAtMs;
            let response;
            try
            {
                response = request(arrival, { signal: requestSignal, callerSignal: signal, deadlineSignal: timeout.signal,
                    requestTimeoutMs: schedule.policy.requestTimeoutMs });
            }
            catch (error)
            {
                response = Promise.reject(error);
            }
            const task = Promise.resolve(response)
                .then((sample) =>
                {
                    record.sample = { ...sample };
                    const callerCancelled = signal?.aborted && requestSignal.reason === signal.reason;
                    record.outcome = callerCancelled ? 'cancelled' : sample.failureKind === 'timeout' ? 'timed-out' : 'completed';
                    record.failureKind = callerCancelled ? 'scenario-cancelled' : sample.failureKind;
                }).catch(() =>
                {
                    const callerCancelled = signal?.aborted && requestSignal.reason === signal.reason;
                    record.outcome = callerCancelled ? 'cancelled' : 'completed';
                    record.failureKind = callerCancelled ? 'scenario-cancelled' : 'request-adapter-failed';
                }).finally(() =>
                {
                    record.completedAtMs = now() - start;
                    record.observedAtMs = record.completedAtMs;
                    pending.delete(task);
                    clearTimeout(requestTimer);
                    requestTimers.delete(requestTimer);
                });
            pending.add(task);
        }
        while (!signal?.aborted && now() - start < schedule.policy.durationMs)
        {
            await wait(schedule.policy.durationMs - (now() - start));
        }
        const observedActiveWindowMs = now() - start;
        observeMeasurement(onMeasurementEnd, { ...measurement, endedMonotonicMs: start + observedActiveWindowMs,
            observedActiveWindowMs, cancelled: signal?.aborted === true });
        // This is an adapter cleanup bound, not a fabricated HTTP timeout/completion.
        // A non-cooperating adapter produces no terminal timeline or qualification result.
        let drainTimer;
        try
        {
            await Promise.race([Promise.allSettled([...pending]), new Promise((_, reject) =>
            {
                drainTimer = setTimeout(() => reject(new Error('request adapter did not settle within its timeout cleanup bound')),
                    schedule.policy.requestTimeoutMs);
            })]);
        }
        finally
        {
            clearTimeout(drainTimer);
        }
        const timeline = freeze(sealContentDigest({ schema: timelineSchema, scheduleDigest: schedule.contentDigest,
            policyDigest: schedule.policyDigest, observedActiveWindowMs, records }));
        return { schedule, timeline, validation: verifyOpenLoopLoadTimeline(schedule, timeline) };
    }
    finally
    {
        scope.abort();
        for (const timer of requestTimers)
        {
            clearTimeout(timer);
        }
    }
}
