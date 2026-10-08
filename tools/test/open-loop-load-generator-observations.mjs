import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

import { canonicalJson, sealContentDigest } from './attempt-provenance.mjs';
import { readLoadTransportResponseFacts } from './load-request-observations.mjs';
import { classifyLoadTransportFailure, validateLoadTransportPolicy, verifyLoadTransportObservation } from './open-loop-load-client-transport.mjs';
import { verifyOpenLoopLoadSchedule, verifyOpenLoopLoadTimeline } from './open-loop-load-schedule.mjs';

export const loadGeneratorMetricNames = Object.freeze([
    'generatorCpuPercent', 'generatorUserCpuMs', 'generatorSystemCpuMs', 'generatorRssBytes',
    'generatorHeapUsedBytes', 'eventLoopLagP50Ms', 'eventLoopLagP95Ms', 'eventLoopLagP99Ms',
    'scheduleLagP50Ms', 'scheduleLagP95Ms', 'scheduleLagP99Ms', 'activeSockets', 'idleSockets',
    'newConnections', 'reusedConnections', 'pendingRequests', 'generatorBackpressureDrops'
]);
const policySchema = 'fsusblog.load-generator-observation-policy.v1';
const observationSchema = 'fsusblog.open-loop-load-generator-observations.v1';
const sourceDigest = `sha256:${createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex')}`;
const eventTypes = ['dns-verified', 'socket-assigned', 'response-headers', 'request-error', 'request-completed', 'transport-closed'];
const snapshotKeys = ['activeRequests', 'socketCount', 'freeSocketCount', 'queuedRequests', 'closed'];

function exact(value, keys, label)
{
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    {
        throw new Error(`${label} requires exact explicit fields`);
    }
}

function numeric(value, label, minimum = 0, integer = false)
{
    if (!Number.isFinite(value) || value < minimum || value > Number.MAX_SAFE_INTEGER
        || (integer && !Number.isSafeInteger(value)))
    {
        throw new Error(`${label} is unavailable or outside numeric bounds`);
    }
}

// Headers arrive before the route decoder. Validate live facts and progression
// here; the canonical terminal reader later checks the actual timeline sample.
function responseFacts(event, headers)
{
    const facts = event.responseFacts;
    exact(facts, ['httpStatus', 'contentType', 'bytesReceived', 'bodyState'], 'transport response facts');
    for (const [name, source] of [['httpStatus', 'node:http.IncomingMessage.statusCode'],
        ['contentType', 'node:http.IncomingMessage.headers.content-type']])
    {
        const field = facts[name];
        exact(field, field?.status === 'ok' ? ['status', 'value', 'source'] : ['status', 'value', 'reason', 'source'], name);
        if (field.source !== source || !['ok', 'unavailable'].includes(field.status)
            || field.status === 'unavailable' && (field.value !== null || typeof field.reason !== 'string' || !field.reason))
        {
            throw new Error('transport response facts require actual availability/source');
        }
    }
    const bytes = facts.bytesReceived;
    exact(bytes, ['status', 'value', 'unit', 'source'], 'received byte counter');
    if (bytes.status !== 'ok' || bytes.unit !== 'bytes' || bytes.source !== 'node:http.IncomingMessage.data')
    {
        throw new Error('actual delivered byte counter is unavailable');
    }
    numeric(bytes.value, 'actual delivered byte count', 0, true);
    if (facts.bodyState === 'not-started')
    {
        if (facts.httpStatus.status !== 'unavailable' || facts.contentType.status !== 'unavailable'
            || facts.httpStatus.reason !== 'response-headers-not-received'
            || facts.contentType.reason !== 'response-headers-not-received' || bytes.value !== 0)
        {
            throw new Error('response facts contradict the no-response sentinel');
        }
    }
    else if (!['partial', 'complete'].includes(facts.bodyState) || facts.httpStatus.status !== 'ok'
        || !Number.isSafeInteger(facts.httpStatus.value) || facts.httpStatus.value < 100 || facts.httpStatus.value > 599
        || (facts.contentType.status === 'ok' ? typeof facts.contentType.value !== 'string'
            : facts.contentType.reason !== 'content-type-header-absent'))
    {
        throw new Error('response facts require actual header/body observations');
    }
    if (event.type === 'response-headers')
    {
        if (headers.has(event.sampleId) || facts.bodyState !== 'partial' || bytes.value !== 0)
        {
            throw new Error('response header boundary requires one partial zero-byte observation');
        }
        headers.set(event.sampleId, freeze(structuredClone(facts)));
    }
    else
    {
        const header = headers.get(event.sampleId);
        if (header ? facts.bodyState === 'not-started' || ['httpStatus', 'contentType'].some((name) =>
            canonicalJson(header[name]) !== canonicalJson(facts[name])) : facts.bodyState !== 'not-started')
        {
            throw new Error('terminal response facts differ from the actual header boundary');
        }
    }
}

function requestError(event, identity, arrival, assigned)
{
    exact(event, ['type', 'atMs', 'identityDigest', ...snapshotKeys,
        'sampleId', 'sequence', 'routeId', 'transport', 'failureFacts', 'responseFacts'], 'request-error event');
    if (!arrival || event.sequence !== arrival.sequence || event.routeId !== arrival.routeId)
    {
        throw new Error('request-error event lacks actual arrival membership');
    }
    const classified = classifyLoadTransportFailure(event.failureFacts);
    if (event.transport === null)
    {
        // The Agent can fail before connected() reports an actual connection.
        // Retain its observed pool snapshot; never synthesize socket identity.
        if (assigned || !['dns', 'pool', 'connect', 'request'].includes(event.failureFacts.stage)
            || event.responseFacts.bodyState !== 'not-started')
        {
            throw new Error('request-error has missing actual connection fields');
        }
    }
    else
    {
        if (!assigned || event.transport?.connectionId !== assigned.connectionId)
        {
            throw new Error('request-error connection differs from actual assignment');
        }
        verifyLoadTransportObservation(identity, event.transport.httpVersion === null
            ? { ...event.transport, httpVersion: identity.policy.httpVersion } : event.transport);
    }
    return classified;
}

function completedFailure(event, error)
{
    if (error ? event.ok !== false || typeof event.failureStage !== 'string' || !event.failureStage
        || canonicalJson(error.responseFacts) !== canonicalJson(event.responseFacts)
        || canonicalJson(error.transport) !== canonicalJson(event.transport) : event.failureStage !== null)
    {
        throw new Error('completion differs from its actual request-error facts');
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

function digest(value)
{
    return sealContentDigest(value).contentDigest;
}

function sha(value, label)
{
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value))
    {
        throw new Error(`${label} requires a full source SHA`);
    }
}

/**
 * Every metric must declare a finite maximum or diagnostic-only status. CPU is
 * process CPU time / observed wall time (100% is one busy core), never divided
 * by a guessed host/core count. The two mandatory maxima cannot be diagnostic.
 * Sampling bounds are evidence-quality limits, not production defaults.
 * Limits apply both to each fixed window and to the active-window aggregate.
 * Aggregate CPU is the peak interval, user/system CPU are active totals, RSS/
 * heap are sampled peaks and event-loop percentiles are peak interval histogram
 * percentiles (not a merged distribution). Schedule percentiles use the verified
 * dispatch timeline. Socket/queue peaks use actual event/boundary snapshots;
 * reusedConnections counts observed reused assignments, not unique sockets.
 */
export function validateLoadGeneratorObservationPolicy(candidate)
{
    exact(candidate, ['schema', 'samplingIntervalMs', 'eventLoopResolutionMs', 'maximumSampleDelayMs',
        'maximumBoundaryDelayMs', 'maximumGeneratorCpuPercent', 'maximumGeneratorScheduleLagP99Ms', 'metrics'], 'collector policy');
    if (candidate.schema !== policySchema)
    {
        throw new Error('unsupported collector policy schema');
    }
    numeric(candidate.samplingIntervalMs, 'samplingIntervalMs', 20, true);
    numeric(candidate.eventLoopResolutionMs, 'eventLoopResolutionMs', 1, true);
    if (candidate.eventLoopResolutionMs * 2 > candidate.samplingIntervalMs
        || candidate.samplingIntervalMs > 60_000)
    {
        throw new Error('event-loop resolution must fit the bounded sampling interval');
    }
    for (const key of ['maximumSampleDelayMs', 'maximumBoundaryDelayMs',
        'maximumGeneratorCpuPercent', 'maximumGeneratorScheduleLagP99Ms'])
    {
        numeric(candidate[key], key);
    }
    exact(candidate.metrics, loadGeneratorMetricNames, 'metric policy');
    for (const name of loadGeneratorMetricNames)
    {
        const rule = candidate.metrics[name];
        exact(rule, rule?.classification === 'diagnostic-only' ? ['classification'] : ['classification', 'maximum'], name);
        if (!['qualification-required', 'diagnostic-only'].includes(rule.classification))
        {
            throw new Error(`${name} requires explicit qualification or diagnostic-only classification`);
        }
        if (rule.classification === 'qualification-required')
        {
            numeric(rule.maximum, `${name}.maximum`);
        }
    }
    for (const [name, key] of [['generatorCpuPercent', 'maximumGeneratorCpuPercent'],
        ['scheduleLagP99Ms', 'maximumGeneratorScheduleLagP99Ms']])
    {
        if (candidate.metrics[name].classification !== 'qualification-required'
            || candidate.metrics[name].maximum !== candidate[key])
        {
            throw new Error(`${key} must match its enforced qualification-required metric maximum`);
        }
    }
    return freeze(structuredClone(candidate));
}

function snapshot(value)
{
    exact(value, snapshotKeys, 'actual Agent snapshot');
    for (const key of snapshotKeys.slice(0, -1))
    {
        numeric(value[key], key, 0, true);
    }
    if (typeof value.closed !== 'boolean' || value.freeSocketCount > value.socketCount)
    {
        throw new Error('actual Agent snapshot is incomplete or contradictory');
    }
}

function transportIdentity(value)
{
    exact(value, ['schema', 'policy', 'runBinding', 'endpoint', 'agent', 'contentDigest'], 'transport identity');
    const policy = validateLoadTransportPolicy(value.policy);
    exact(value.runBinding, ['runId', 'invocationId', 'attemptId', 'backendOrigin'], 'transport run binding');
    const expectedAgent = { type: 'node:http.Agent', global: false,
        keepAlive: policy.connectionReusePolicy === 'keep-alive', maxSockets: policy.maxConnectionsPerOrigin,
        maxTotalSockets: policy.maxConnectionsPerOrigin, maxFreeSockets: policy.maxConnectionsPerOrigin, scheduling: 'fifo' };
    if (value.schema !== 'fsusblog.load-client-transport.v1' || digest(value) !== value.contentDigest
        || value.endpoint !== value.runBinding.backendOrigin
        || Object.values(value.runBinding).some((item) => typeof item !== 'string' || !item.trim())
        || canonicalJson(value.agent) !== canonicalJson(expectedAgent))
    {
        throw new Error('actual transport identity/configuration drift');
    }
}

function backendIdentity(value)
{
    exact(value, ['pid', 'sourceSha'], 'backend identity');
    numeric(value.pid, 'backend PID', 1, true);
    sha(value.sourceSha, 'backend identity');
    if (value.pid === process.pid)
    {
        throw new Error('backend and generator PID must be separate');
    }
}

function windowStart(value, schedule)
{
    exact(value, ['scheduleDigest', 'startedMonotonicMs', 'durationMs', 'plannedEndMonotonicMs',
        'transportIdentity', 'transportSnapshot'], 'measurement start');
    numeric(value.startedMonotonicMs, 'startedMonotonicMs');
    if (value.scheduleDigest !== schedule.contentDigest || value.durationMs !== schedule.policy.durationMs
        || value.plannedEndMonotonicMs !== value.startedMonotonicMs + value.durationMs)
    {
        throw new Error('collector window differs from the actual schedule');
    }
    transportIdentity(value.transportIdentity);
    snapshot(value.transportSnapshot);
    if (value.transportSnapshot.closed || value.transportSnapshot.activeRequests !== 0
        || value.transportSnapshot.socketCount !== 0 || value.transportSnapshot.queuedRequests !== 0)
    {
        throw new Error('collector requires a fresh actual transport before the first request');
    }
}

function windowEnd(value, start)
{
    exact(value, [...Object.keys(start), 'endedMonotonicMs', 'observedActiveWindowMs', 'cancelled'], 'measurement end');
    for (const key of Object.keys(start).filter((key) => key !== 'transportSnapshot'))
    {
        if (canonicalJson(value[key]) !== canonicalJson(start[key]))
        {
            throw new Error('measurement window or transport identity drift');
        }
    }
    numeric(value.endedMonotonicMs, 'endedMonotonicMs', start.startedMonotonicMs);
    numeric(value.observedActiveWindowMs, 'observedActiveWindowMs');
    if (typeof value.cancelled !== 'boolean'
        || value.observedActiveWindowMs !== value.endedMonotonicMs - start.startedMonotonicMs)
    {
        throw new Error('measurement end contradicts the actual active window');
    }
    snapshot(value.transportSnapshot);
    if (value.transportSnapshot.closed)
    {
        throw new Error('measurement end must precede transport drain/close');
    }
}

function percentile(values, fraction)
{
    if (values.length === 0)
    {
        throw new Error('collector percentile has no actual observations');
    }
    return [...values].sort((left, right) => left - right)[Math.ceil(values.length * fraction) - 1];
}

function maximum(rows, project)
{
    if (rows.length === 0)
    {
        throw new Error('collector maximum has no actual observations');
    }
    return rows.reduce((result, row) => Math.max(result, project(row)), -Infinity);
}

function poolMetrics(rows)
{
    return { activeSockets: maximum(rows, (row) => row.socketCount - row.freeSocketCount),
        idleSockets: maximum(rows, (row) => row.freeSocketCount), pendingRequests: maximum(rows, (row) => row.queuedRequests) };
}

/**
 * Portable synchronous callbacks for runOpenLoopRouteContractProbe. Pass the
 * three named callbacks directly, then finish with the probe's exact schedule,
 * timeline, measurementWindow and transportEvidence. Always dispose in finally.
 * Header/error/completion events retain the transport's actual responseFacts;
 * request-error uses its existing canonical typed failure classifier. The
 * shared probe also requires explicit registration from observeLoadIssuer().
 * No HTTP runner, arrival-rate change, backend observation or global dispatcher.
 * Timers use performance.now() in the scheduler's actual monotonic coordinate.
 */
export function createOpenLoopLoadGeneratorCollector({ policy: candidate, schedule, sourceSha, backendIdentity: backend })
{
    const policy = validateLoadGeneratorObservationPolicy(candidate);
    verifyOpenLoopLoadSchedule(schedule);
    sha(sourceSha, 'generator');
    backendIdentity(backend);
    if (schedule.policy.durationMs < policy.samplingIntervalMs * 2
        || Math.ceil(schedule.policy.durationMs / policy.samplingIntervalMs) > 100_000)
    {
        throw new Error('collector requires at least two bounded fixed sampling intervals');
    }
    const identity = freeze(sealContentDigest({ schema: 'fsusblog.load-generator-identity.v1',
        pid: process.pid, sourceSha, collectorSourceDigest: sourceDigest, nodeVersion: process.versions.node,
        executable: process.execPath, monotonicOriginMs: performance.timeOrigin,
        cpuSource: 'node:process.cpuUsage', memorySource: 'node:process.memoryUsage',
        eventLoopSource: 'node:perf_hooks.monitorEventLoopDelay', cpuNormalization: 'one-core-wall-time',
        backendIdentity: structuredClone(backend), policyDigest: digest(policy) }));
    const samples = [];
    const events = [];
    const responseHeaders = new Map();
    const requestErrors = new Map();
    const assignments = new Map();
    const arrivals = new Map(schedule.arrivals.map((arrival) => [arrival.sampleId, arrival]));
    let start;
    let end;
    let timer;
    let histogram;
    let disposed = false;
    let collectionError;
    let nextSlot = 1;

    function dispose()
    {
        clearTimeout(timer);
        histogram?.disable();
        disposed = true;
    }

    function sample(kind, scheduledMonotonicMs)
    {
        const atMs = performance.now();
        const cpu = process.cpuUsage();
        const memory = process.memoryUsage();
        const eventLoop = histogram.count > 0 ? { status: 'observed', count: histogram.count,
            minMs: histogram.min / 1e6, maxMs: histogram.max / 1e6,
            p50Ms: histogram.percentile(50) / 1e6, p95Ms: histogram.percentile(95) / 1e6,
            p99Ms: histogram.percentile(99) / 1e6 } : { status: 'unavailable', reason: 'no event-loop observations in this interval' };
        const row = { kind, scheduledMonotonicMs, atMs, pid: process.pid,
            userCpuUs: cpu.user, systemCpuUs: cpu.system, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, eventLoop };
        for (const key of ['atMs', 'userCpuUs', 'systemCpuUs', 'rssBytes', 'heapUsedBytes'])
        {
            numeric(row[key], key, key.endsWith('Bytes') ? 1 : 0);
        }
        const maximumDelay = kind === 'periodic' ? policy.maximumSampleDelayMs : policy.maximumBoundaryDelayMs;
        if (atMs < scheduledMonotonicMs || atMs > scheduledMonotonicMs + maximumDelay)
        {
            throw new Error(`actual ${kind} process collector is outside the shared monotonic window/capture bound: due=${scheduledMonotonicMs}, observed=${atMs}`);
        }
        if (kind === 'periodic' && atMs >= start.plannedEndMonotonicMs)
        {
            return;
        }
        samples.push(freeze(row));
        histogram.reset();
    }

    function arm()
    {
        const due = start.startedMonotonicMs + nextSlot * policy.samplingIntervalMs;
        if (due >= start.plannedEndMonotonicMs)
        {
            return;
        }
        function tick()
        {
            const remaining = due - performance.now();
            // Node timer buckets can wake slightly before a performance.now()
            // deadline. Re-arm the same slot; do not sample an earlier window.
            if (remaining > 0)
            {
                timer = setTimeout(tick, Math.ceil(remaining));
                return;
            }
            try
            {
                sample('periodic', due);
                nextSlot += 1;
                arm();
            }
            catch (error)
            {
                collectionError = error.message;
                dispose();
            }
        }
        timer = setTimeout(tick, Math.max(0, Math.ceil(due - performance.now())));
    }

    function onMeasurementStart(value)
    {
        if (disposed || start)
        {
            throw new Error('collector is disposed or has already started');
        }
        windowStart(value, schedule);
        start = freeze(structuredClone(value));
        try
        {
            histogram = monitorEventLoopDelay({ resolution: policy.eventLoopResolutionMs });
            histogram.enable();
            sample('start', start.startedMonotonicMs);
            arm();
        }
        catch (error)
        {
            dispose();
            throw error;
        }
    }

    function onMeasurementEnd(value)
    {
        if (!start || end || disposed)
        {
            throw new Error(`collector unavailable at active-window end${collectionError ? `: ${collectionError}` : ''}`);
        }
        try
        {
            windowEnd(value, start);
            end = freeze(structuredClone(value));
            sample('end', end.endedMonotonicMs);
        }
        finally
        {
            clearTimeout(timer);
            histogram.disable();
        }
    }

    function onTransportObservation(value)
    {
        if (!start || disposed)
        {
            // Canonical finally cleanup must not replace a prior collection
            // error. No closed-only ledger can produce a successful receipt.
            if (value?.type === 'transport-closed')
            {
                return;
            }
            throw new Error('transport collector unavailable/outside its invocation');
        }
        if (!eventTypes.includes(value?.type) || value.identityDigest !== start.transportIdentity.contentDigest)
        {
            throw new Error('transport event vocabulary or identity drift');
        }
        snapshot(Object.fromEntries(snapshotKeys.map((key) => [key, value[key]])));
        numeric(value.atMs, 'transport event atMs', start.startedMonotonicMs);
        if (value.type === 'request-error')
        {
            if (requestErrors.has(value.sampleId))
            {
                throw new Error('duplicate actual request-error event');
            }
            requestError(value, start.transportIdentity, arrivals.get(value.sampleId), assignments.get(value.sampleId));
        }
        if (['response-headers', 'request-error', 'request-completed'].includes(value.type))
        {
            responseFacts(value, responseHeaders);
        }
        if (value.type === 'request-completed')
        {
            completedFailure(value, requestErrors.get(value.sampleId));
        }
        const observed = freeze(structuredClone(value));
        if (value.type === 'socket-assigned')
        {
            assignments.set(value.sampleId, observed.transport);
        }
        if (value.type === 'request-error')
        {
            requestErrors.set(value.sampleId, observed);
        }
        events.push(observed);
    }

    function finish(inputs)
    {
        if (!start || !end || collectionError || disposed)
        {
            throw new Error('collector unavailable: both actual boundaries and periodic observations are required');
        }
        const facts = { schema: observationSchema, identity, policy, start, end, samples: [...samples], events: [...events],
            scheduleDigest: schedule.contentDigest, timelineDigest: inputs.timeline?.contentDigest,
            transportEvidenceDigest: inputs.transportEvidence?.contentDigest,
            measurementWindowDigest: inputs.measurementWindow?.contentDigest, qualificationEligible: false };
        const results = recompute(facts, { ...inputs, schedule, policy, generatorIdentity: identity });
        return freeze(sealContentDigest({ ...facts, ...results }));
    }

    return Object.freeze({ identity, onMeasurementStart, onMeasurementEnd, onTransportObservation, finish, dispose });
}

function resourceIntervals(facts, policy)
{
    const { start, end, samples, identity } = facts;
    const expectedSlots = [];
    for (let due = start.startedMonotonicMs + policy.samplingIntervalMs; due < Math.min(start.plannedEndMonotonicMs, end.endedMonotonicMs);
        due += policy.samplingIntervalMs)
    {
        expectedSlots.push(due);
    }
    if (!Array.isArray(samples) || samples.length !== expectedSlots.length + 2)
    {
        throw new Error('periodic collector unavailable: fixed sampling slots are missing');
    }
    const intervals = [];
    for (const [index, row] of samples.entries())
    {
        exact(row, ['kind', 'scheduledMonotonicMs', 'atMs', 'pid', 'userCpuUs', 'systemCpuUs',
            'rssBytes', 'heapUsedBytes', 'eventLoop'], 'process observation');
        const kind = index === 0 ? 'start' : index === samples.length - 1 ? 'end' : 'periodic';
        const due = kind === 'start' ? start.startedMonotonicMs : kind === 'end' ? end.endedMonotonicMs : expectedSlots[index - 1];
        const maximumDelay = kind === 'periodic' ? policy.maximumSampleDelayMs : policy.maximumBoundaryDelayMs;
        if (row.kind !== kind || row.pid !== identity.pid || row.scheduledMonotonicMs !== due
            || row.atMs < due || row.atMs > due + maximumDelay
            || (kind === 'periodic' && row.atMs >= end.endedMonotonicMs))
        {
            throw new Error(`process collector PID/window/cadence differs from actual measurement at ${index}: due=${due}, observed=${row.atMs}`);
        }
        for (const key of ['atMs', 'userCpuUs', 'systemCpuUs', 'rssBytes', 'heapUsedBytes'])
        {
            numeric(row[key], key, key.endsWith('Bytes') ? 1 : 0);
        }
        if (index === 0)
        {
            exact(row.eventLoop, ['status', 'reason'], 'initial event-loop observation');
            if (row.eventLoop.status !== 'unavailable' || typeof row.eventLoop.reason !== 'string' || !row.eventLoop.reason)
            {
                throw new Error('initial event-loop baseline cannot fabricate observations');
            }
            continue;
        }
        const previous = samples[index - 1];
        numeric(row.atMs - previous.atMs, 'actual sample interval', Number.MIN_VALUE);
        numeric(row.userCpuUs - previous.userCpuUs, 'observed user CPU delta');
        numeric(row.systemCpuUs - previous.systemCpuUs, 'observed system CPU delta');
        const loop = row.eventLoop;
        exact(loop, ['status', 'count', 'minMs', 'maxMs', 'p50Ms', 'p95Ms', 'p99Ms'], 'event-loop interval observation');
        numeric(loop.count, 'event-loop count', 1, true);
        for (const key of ['minMs', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs'])
        {
            numeric(loop[key], key);
        }
        if (loop.status !== 'observed' || loop.minMs > loop.p50Ms || loop.p50Ms > loop.p95Ms
            || loop.p95Ms > loop.p99Ms || loop.p99Ms > loop.maxMs)
        {
            throw new Error('event-loop collector unavailable or contradictory');
        }
        const userMs = (row.userCpuUs - previous.userCpuUs) / 1000;
        const systemMs = (row.systemCpuUs - previous.systemCpuUs) / 1000;
        intervals.push({ scheduledStartMonotonicMs: previous.scheduledMonotonicMs, scheduledEndMonotonicMs: due,
            observedStartMonotonicMs: previous.atMs, observedEndMonotonicMs: row.atMs,
            generatorCpuPercent: (userMs + systemMs) / (row.atMs - previous.atMs) * 100,
            generatorUserCpuMs: userMs, generatorSystemCpuMs: systemMs,
            generatorRssBytes: Math.max(previous.rssBytes, row.rssBytes),
            generatorHeapUsedBytes: Math.max(previous.heapUsedBytes, row.heapUsedBytes),
            eventLoopLagP50Ms: loop.p50Ms, eventLoopLagP95Ms: loop.p95Ms, eventLoopLagP99Ms: loop.p99Ms });
    }
    return intervals;
}

function transportFacts(facts, inputs)
{
    const { start, end, events } = facts;
    const evidence = inputs.transportEvidence;
    if (!evidence || evidence.schema !== 'fsusblog.release-load-transport-evidence.v1'
        || digest(evidence) !== evidence.contentDigest || evidence.contentDigest !== facts.transportEvidenceDigest
        || canonicalJson(evidence.identity) !== canonicalJson(start.transportIdentity)
        || canonicalJson(evidence.observations) !== canonicalJson(events) || !Array.isArray(events))
    {
        throw new Error('actual transport ledger or identity drift');
    }
    const active = [];
    const assignments = new Map();
    const connectionCounts = new Map();
    const arrivals = new Map(inputs.timeline.records.map((row) => [row.sampleId, row]));
    const lifecycle = new Map();
    const responseHeaders = new Map();
    const requestErrors = new Map();
    let lastAt = start.startedMonotonicMs;
    for (const event of events)
    {
        const additionalKeys = { 'dns-verified': ['sampleId', 'dnsResult'],
            'socket-assigned': ['sampleId', 'transport'], 'response-headers': ['sampleId', 'transport', 'responseFacts'],
            'request-error': ['sampleId', 'sequence', 'routeId', 'transport', 'failureFacts', 'responseFacts'],
            'request-completed': ['sampleId', 'transport', 'failureStage', 'ok', 'responseFacts'], 'transport-closed': [] };
        if (!eventTypes.includes(event.type) || event.identityDigest !== start.transportIdentity.contentDigest)
        {
            throw new Error('transport event vocabulary or identity drift');
        }
        exact(event, ['type', 'atMs', 'identityDigest', ...snapshotKeys, ...additionalKeys[event.type]], 'actual transport event');
        numeric(event.atMs, 'transport monotonic event', lastAt);
        lastAt = event.atMs;
        snapshot(Object.fromEntries(snapshotKeys.map((key) => [key, event[key]])));
        if (event.type === 'transport-closed')
        {
            if (!event.closed || event.atMs < end.endedMonotonicMs)
            {
                throw new Error('transport close crossed the active window');
            }
            continue;
        }
        const arrival = arrivals.get(event.sampleId);
        if (!arrival || arrival.dispatchedAtMs === null || event.closed
            || event.atMs < start.startedMonotonicMs + arrival.dispatchedAtMs)
        {
            throw new Error('transport event lacks actual arrival membership');
        }
        const seen = lifecycle.get(event.sampleId) ?? [];
        if (seen.includes(event.type) || seen.includes('request-completed')
            || seen.includes('request-error') && event.type !== 'request-completed'
            || (seen.length === 0 && event.type !== 'dns-verified'
                && !(event.type === 'request-error' && event.failureFacts?.stage === 'dns')))
        {
            throw new Error('actual transport lifecycle is incomplete or duplicated');
        }
        seen.push(event.type);
        lifecycle.set(event.sampleId, seen);
        if (['response-headers', 'request-error', 'request-completed'].includes(event.type))
        {
            responseFacts(event, responseHeaders);
        }
        if (event.type === 'dns-verified' && canonicalJson(event.dnsResult) !== canonicalJson(start.transportIdentity.policy.dnsResult))
        {
            throw new Error('actual transport DNS configuration drift');
        }
        if (event.type === 'socket-assigned' || event.type === 'response-headers')
        {
            const observed = event.transport;
            // HTTP version is not known at socket assignment; verify every actual
            // connection field now, then require the observed version at headers.
            verifyLoadTransportObservation(start.transportIdentity, event.type === 'socket-assigned'
                ? { ...observed, httpVersion: start.transportIdentity.policy.httpVersion } : observed);
            if (event.type === 'socket-assigned')
            {
                if (assignments.has(event.sampleId)
                    || observed.connectionRequestCount !== (connectionCounts.get(observed.connectionId) ?? 0) + 1)
                {
                    throw new Error('actual connection assignment/reuse sequence is incomplete');
                }
                assignments.set(event.sampleId, event);
                connectionCounts.set(observed.connectionId, observed.connectionRequestCount);
            }
            else if (assignments.get(event.sampleId)?.transport.connectionId !== observed.connectionId)
            {
                throw new Error('response connection identity differs from actual assignment');
            }
        }
        if (event.type === 'request-error')
        {
            const classified = requestError(event, start.transportIdentity, arrival, assignments.get(event.sampleId)?.transport);
            const outcome = { 'network-error': 'completed', timeout: 'timed-out', cancelled: 'cancelled' }[classified.outcome];
            if (arrival.outcome !== outcome || arrival.sample?.ok !== false)
            {
                throw new Error('actual request-error differs from dispatcher terminal control');
            }
            requestErrors.set(event.sampleId, event);
        }
        if (event.type === 'request-completed')
        {
            readLoadTransportResponseFacts(event.responseFacts, arrival.sample);
            const assigned = assignments.get(event.sampleId)?.transport;
            const error = requestErrors.get(event.sampleId);
            completedFailure(event, error);
            if (assigned ? !event.transport || event.transport.connectionId !== assigned.connectionId
                : !error || error.transport !== null || event.transport !== null)
            {
                throw new Error('completed request has missing actual connection fields');
            }
            if (typeof event.ok !== 'boolean' || event.ok !== arrival.sample?.ok
                || (event.failureStage !== null && typeof event.failureStage !== 'string'))
            {
                throw new Error('completed request has missing actual connection fields');
            }
            if (event.transport !== null)
            {
                verifyLoadTransportObservation(start.transportIdentity, event.transport.httpVersion === null
                    ? { ...event.transport, httpVersion: start.transportIdentity.policy.httpVersion } : event.transport);
            }
        }
        if (event.atMs <= end.endedMonotonicMs)
        {
            active.push(event);
        }
    }
    if (events.at(-1)?.type !== 'transport-closed'
        || events.filter((event) => event.type === 'transport-closed').length !== 1
        || inputs.timeline.records.filter((row) => row.dispatchedAtMs !== null)
            .some((row) => !lifecycle.get(row.sampleId)?.includes('request-completed')
                || !assignments.has(row.sampleId) && !requestErrors.has(row.sampleId)))
    {
        throw new Error('actual connection collector unavailable for dispatched requests or drain');
    }
    snapshot(evidence.finalSnapshot);
    if (canonicalJson(evidence.finalSnapshot) !== canonicalJson({ activeRequests: 0, socketCount: 0,
        freeSocketCount: 0, queuedRequests: 0, closed: true }))
    {
        throw new Error('actual transport drain snapshot is incomplete');
    }
    const snapshots = [start.transportSnapshot, end.transportSnapshot, ...active];
    return { ...poolMetrics(snapshots),
        newConnections: active.filter((row) => row.type === 'socket-assigned' && !row.transport.reusedSocket).length,
        reusedConnections: active.filter((row) => row.type === 'socket-assigned' && row.transport.reusedSocket).length };
}

function intervalMetrics(intervals, facts, inputs, policy)
{
    const eventBins = intervals.map(() => []);
    const recordBins = intervals.map(() => []);
    function bucket(at)
    {
        if (at < facts.start.startedMonotonicMs || at > facts.end.endedMonotonicMs)
        {
            return undefined;
        }
        return Math.min(intervals.length - 1, Math.floor((at - facts.start.startedMonotonicMs) / policy.samplingIntervalMs));
    }
    for (const event of facts.events)
    {
        const index = bucket(event.atMs);
        if (event.type !== 'transport-closed' && index !== undefined)
        {
            eventBins[index].push(event);
        }
    }
    for (const row of inputs.timeline.records)
    {
        const index = bucket(facts.start.startedMonotonicMs + (row.dispatchedAtMs ?? row.observedAtMs));
        if (index !== undefined)
        {
            recordBins[index].push(row);
        }
    }
    return intervals.map((interval, index) =>
    {
        const last = index === intervals.length - 1;
        const events = eventBins[index];
        const rows = recordBins[index];
        const lags = rows.filter((row) => row.dispatchedAtMs !== null).map((row) => row.scheduleLagMs);
        const snapshots = [...events, ...(index === 0 ? [facts.start.transportSnapshot] : []),
            ...(last ? [facts.end.transportSnapshot] : [])];
        const availability = {};
        const metrics = Object.fromEntries(loadGeneratorMetricNames.filter((name) => Object.hasOwn(interval, name))
            .map((name) => [name, interval[name]]));
        if (snapshots.length)
        {
            Object.assign(metrics, poolMetrics(snapshots));
        }
        else
        {
            for (const name of ['activeSockets', 'idleSockets', 'pendingRequests'])
            {
                availability[name] = 'unavailable: no actual Agent snapshot in this fixed window';
            }
        }
        for (const [name, fraction] of [['scheduleLagP50Ms', 0.5], ['scheduleLagP95Ms', 0.95], ['scheduleLagP99Ms', 0.99]])
        {
            if (lags.length)
            {
                metrics[name] = percentile(lags, fraction);
            }
            else
            {
                availability[name] = 'unavailable: no actual dispatch lag in this fixed window';
            }
        }
        // Zero counts are proven by the complete, validated event/timeline ledger;
        // they are never substituted for missing connection or process fields.
        metrics.newConnections = events.filter((event) => event.type === 'socket-assigned' && !event.transport.reusedSocket).length;
        metrics.reusedConnections = events.filter((event) => event.type === 'socket-assigned' && event.transport.reusedSocket).length;
        metrics.generatorBackpressureDrops = rows.filter((row) => row.failureKind === 'generator-backpressure-drop').length;
        for (const name of loadGeneratorMetricNames)
        {
            if (Object.hasOwn(metrics, name))
            {
                availability[name] = 'observed';
            }
            else if (policy.metrics[name].classification === 'qualification-required')
            {
                throw new Error(`${name} collector unavailable in fixed sampling window ${index}`);
            }
        }
        return { ...interval, metrics, availability };
    });
}

function recompute(facts, inputs)
{
    const policy = validateLoadGeneratorObservationPolicy(inputs.policy);
    verifyOpenLoopLoadSchedule(inputs.schedule);
    verifyOpenLoopLoadTimeline(inputs.schedule, inputs.timeline);
    backendIdentity(facts.identity.backendIdentity);
    const expectedIdentity = inputs.generatorIdentity;
    sha(inputs.sourceSha, 'expected generator source');
    if (!expectedIdentity || digest(facts.identity) !== facts.identity.contentDigest
        || canonicalJson(facts.identity) !== canonicalJson(expectedIdentity)
        || facts.identity.pid !== process.pid || facts.identity.collectorSourceDigest !== sourceDigest
        || facts.identity.sourceSha !== inputs.sourceSha
        || facts.identity.nodeVersion !== process.versions.node || facts.identity.monotonicOriginMs !== performance.timeOrigin
        || facts.identity.policyDigest !== digest(policy) || canonicalJson(facts.policy) !== canonicalJson(policy)
        || facts.schema !== observationSchema || facts.qualificationEligible !== false
        || facts.scheduleDigest !== inputs.schedule.contentDigest || facts.timelineDigest !== inputs.timeline.contentDigest)
    {
        throw new Error('generator source/PID/Node/collector policy identity drift');
    }
    sha(facts.identity.sourceSha, 'generator identity');
    windowStart(facts.start, inputs.schedule);
    windowEnd(facts.end, facts.start);
    const actual = inputs.measurementWindow;
    const expectedWindow = sealContentDigest({ schema: 'fsusblog.release-load-source-window.v1',
        ...Object.fromEntries(Object.entries(facts.end).filter(([key]) => !['transportIdentity', 'transportSnapshot'].includes(key))),
        qualificationEligible: false });
    if (canonicalJson(actual) !== canonicalJson(expectedWindow) || facts.measurementWindowDigest !== actual?.contentDigest
        || facts.end.observedActiveWindowMs !== inputs.timeline.observedActiveWindowMs)
    {
        throw new Error('collector window differs from exact shared measurement window/timeline');
    }
    if (facts.end.cancelled || facts.end.observedActiveWindowMs < inputs.schedule.policy.durationMs)
    {
        throw new Error('interrupted active window cannot claim nominal duration');
    }
    const transportMetrics = transportFacts(facts, inputs);
    const intervals = intervalMetrics(resourceIntervals(facts, policy), facts, inputs, policy);
    const lags = inputs.timeline.records.filter((row) => row.dispatchedAtMs !== null).map((row) => row.scheduleLagMs);
    const metrics = { generatorCpuPercent: maximum(intervals, (row) => row.generatorCpuPercent),
        generatorUserCpuMs: intervals.reduce((sum, row) => sum + row.generatorUserCpuMs, 0),
        generatorSystemCpuMs: intervals.reduce((sum, row) => sum + row.generatorSystemCpuMs, 0),
        generatorRssBytes: maximum(intervals, (row) => row.generatorRssBytes),
        generatorHeapUsedBytes: maximum(intervals, (row) => row.generatorHeapUsedBytes),
        eventLoopLagP50Ms: maximum(intervals, (row) => row.eventLoopLagP50Ms),
        eventLoopLagP95Ms: maximum(intervals, (row) => row.eventLoopLagP95Ms),
        eventLoopLagP99Ms: maximum(intervals, (row) => row.eventLoopLagP99Ms),
        scheduleLagP50Ms: percentile(lags, 0.5), scheduleLagP95Ms: percentile(lags, 0.95), scheduleLagP99Ms: percentile(lags, 0.99),
        ...transportMetrics,
        generatorBackpressureDrops: inputs.timeline.records.filter((row) => row.failureKind === 'generator-backpressure-drop').length };
    const exceeds = (values) => loadGeneratorMetricNames.filter((name) => policy.metrics[name].classification === 'qualification-required'
        && values[name] > policy.metrics[name].maximum);
    const windowFailures = intervals.map((interval, index) => ({ index, exceeded: exceeds(interval.metrics) }))
        .filter((window) => window.exceeded.length > 0);
    const aggregateExceeded = exceeds(metrics);
    const exceeded = loadGeneratorMetricNames.filter((name) => aggregateExceeded.includes(name)
        || windowFailures.some((window) => window.exceeded.includes(name)));
    return { metrics, intervals, exceeded, windowFailures, passed: exceeded.length === 0,
        failureKind: exceeded.length ? 'infra.load-generator-saturated' : null };
}

/**
 * Recompute all derived results from real sampled facts and independently passed
 * canonical probe evidence. Invalid/missing collectors fail closed. This local
 * verifier requires the collector's original process identity; persisted evidence
 * needs a separately trusted runtime verifier, never a claimed PID in a receipt.
 * If resources pass, preserve the original server failure without reclassifying
 * latency. This source evidence always has qualificationEligible: false.
 */
export function verifyOpenLoopLoadGeneratorObservations(receipt, inputs, { serverFailureKind = null } = {})
{
    try
    {
        exact(receipt, ['schema', 'identity', 'policy', 'start', 'end', 'samples', 'events', 'scheduleDigest',
            'timelineDigest', 'transportEvidenceDigest', 'measurementWindowDigest', 'qualificationEligible',
            'metrics', 'intervals', 'exceeded', 'windowFailures', 'passed', 'failureKind', 'contentDigest'], 'generator observations');
        if (digest(receipt) !== receipt.contentDigest || (serverFailureKind !== null
            && (typeof serverFailureKind !== 'string' || !serverFailureKind)))
        {
            throw new Error('generator observations digest or server failure classification differs');
        }
        const expected = recompute(receipt, inputs);
        for (const key of Object.keys(expected))
        {
            if (canonicalJson(receipt[key]) !== canonicalJson(expected[key]))
            {
                throw new Error(`generator derived ${key} differs from actual observations`);
            }
        }
        return freeze({ ...expected, passed: expected.passed && serverFailureKind === null,
            failureKind: expected.failureKind ?? serverFailureKind, generatorPassed: expected.passed,
            qualificationEligible: false });
    }
    catch (error)
    {
        return Object.freeze({ passed: false, generatorPassed: false, qualificationEligible: false,
            failureKind: 'infra.load-generator-collector-unavailable', reason: error.message });
    }
}
