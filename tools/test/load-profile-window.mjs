import { createHash } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { calculateLoadSampleMetrics, canonicalizeLoadSamples } from './load-sample-metrics.mjs';

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Freeze policy and the route iterator before workers can dispatch any work. */
export function createLoadExecutionPlan({ concurrency, rounds, durationMs }, routes)
{
    for (const [name, value] of Object.entries({ concurrency, rounds, durationMs }))
    {
        if (!Number.isSafeInteger(value) || value <= 0)
        {
            throw new Error(`load plan requires positive integer ${name}`);
        }
    }
    if (!Array.isArray(routes) || routes.length === 0
        || new Set(routes).size !== routes.length || routes.some((route) => typeof route !== 'string' || !route))
    {
        throw new Error('load plan requires unique routes');
    }
    const plan = {
        concurrency, rounds, durationMs,
        minimumCompletedRequests: concurrency * rounds,
        maximumDispatchedRequests: 250000,
        routes: Object.freeze([...routes]),
        distribution: 'dispatch-ordinal-round-robin'
    };
    if (!Number.isSafeInteger(plan.minimumCompletedRequests))
    {
        throw new Error('load minimum work exceeds integer precision');
    }
    return Object.freeze({ ...plan, contentDigest: digest(plan) });
}

/**
 * Run a real monotonic window. The callback must settle every dispatched request
 * on cancellation; deadline closure only stops dispatch and never aborts a drain.
 * The independent dispatch ledger is retained even if a callback throws.
 * maxRequests bounds generator memory; hitting it fails the run, never truncates
 * a successful measurement. It is not a policy minimum or a timing override.
 */
export async function runLoadWindow({
    plan, pathForRoute, request, verifyIdentity,
    signal = null, maxRequests = plan.maximumDispatchedRequests
})
{
    if (JSON.stringify(plan) !== JSON.stringify(createLoadExecutionPlan(plan, plan.routes))
        || typeof verifyIdentity !== 'function' || !Number.isSafeInteger(maxRequests)
        || maxRequests < 1 || maxRequests > plan.maximumDispatchedRequests)
    {
        throw new Error('load execution plan or generator budget is invalid');
    }
    const controller = new AbortController();
    // Each in-flight fetch owns one removable listener, bounded by the worker roster.
    setMaxListeners(plan.concurrency, controller.signal);
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
    {
        abort();
    }
    let release;
    const barrier = new Promise((resolve) =>
    {
        release = resolve;
    });
    const workers = Array.from({ length: plan.concurrency }, (_, index) => ({
        workerId: `worker-${index}`, readyMonotonicMs: performance.now(), dispatched: 0, completed: 0
    }));
    const expectedRequests = [];
    const dispatches = [];
    const samples = [];
    const routeFailures = [];
    const failures = [];
    let inFlight = 0;
    let peakInFlight = 0;
    let measurementStart = null;
    let deadline = null;
    let dispatchClosed = null;
    let identityBefore = null;
    let identityAfter = null;
    function closeDispatch()
    {
        dispatchClosed ??= performance.now();
    }
    const tasks = workers.map(async (worker) =>
    {
        await barrier;
        if (measurementStart === null)
        {
            return;
        }
        while (!controller.signal.aborted && dispatchClosed === null)
        {
            const startedMonotonicMs = performance.now();
            if (startedMonotonicMs >= deadline)
            {
                closeDispatch();
                break;
            }
            if (dispatches.length >= maxRequests)
            {
                failures.push('load-generator-sample-budget-exhausted');
                closeDispatch();
                controller.abort(new Error('load generator sample budget exhausted'));
                break;
            }
            const ordinal = dispatches.length;
            const routeId = plan.routes[ordinal % plan.routes.length];
            const membership = {
                sampleId: `${worker.workerId}:${worker.dispatched}`,
                workerId: worker.workerId, sequence: worker.dispatched, path: pathForRoute(routeId)
            };
            expectedRequests.push(membership);
            dispatches.push({ ordinal, routeId, ...membership, startedMonotonicMs });
            worker.dispatched += 1;
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            try
            {
                const observed = await request(routeId, { signal: controller.signal });
                const finishedMonotonicMs = performance.now();
                samples.push({
                    ...membership, startedMonotonicMs, finishedMonotonicMs,
                    durationMs: finishedMonotonicMs - startedMonotonicMs,
                    outcome: observed.outcome, httpStatus: observed.status,
                    bytes: observed.bodyBytes, contentType: observed.contentType, frameType: observed.frameType,
                    errorKind: observed.errorKind, errorCode: observed.errorCode, errorDigest: observed.errorDigest
                });
                if (!observed.ok)
                {
                    routeFailures.push({ sampleId: membership.sampleId, routeId, failureKind: observed.failureKind });
                }
                if (observed.outcome !== 'cancelled')
                {
                    worker.completed += 1;
                }
            }
            catch (error)
            {
                // Programming/collector failures do not erase the dispatch ledger.
                failures.push(`load-request-producer-failed:${error?.code ?? error?.name ?? 'unknown'}`);
                closeDispatch();
                controller.abort(error);
            }
            finally
            {
                inFlight -= 1;
            }
            // Also yield for immediately-settled transports: timers, budget and
            // cancellation must not be starved by a microtask-only worker loop.
            await yieldTurn();
        }
    });
    let deadlineTimer;
    const armDeadline = () =>
    {
        const remaining = deadline - performance.now();
        if (remaining > 0 && dispatchClosed === null)
        {
            deadlineTimer = setTimeout(armDeadline, Math.ceil(remaining));
        }
        else
        {
            closeDispatch();
        }
    };
    try
    {
        identityBefore = await verifyIdentity();
        if (controller.signal.aborted)
        {
            throw new Error('load-cancelled-before-measurement');
        }
        measurementStart = performance.now();
        deadline = measurementStart + plan.durationMs;
        armDeadline();
        release();
        await Promise.all(tasks);
        closeDispatch();
        identityAfter = await verifyIdentity();
        if (JSON.stringify(identityBefore) !== JSON.stringify(identityAfter))
        {
            failures.push('load-runtime-identity-changed');
        }
    }
    catch (error)
    {
        failures.push(error.message);
        closeDispatch();
        controller.abort(error);
    }
    finally
    {
        release();
        await Promise.all(tasks);
        clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', abort);
    }
    const finishedMonotonicMs = performance.now();
    let calculated = null;
    try
    {
        calculated = calculateLoadSampleMetrics({ samples, expectedRequests,
            durationMs: measurementStart === null ? null : finishedMonotonicMs - measurementStart });
    }
    catch (error)
    {
        failures.push(error.message);
    }
    const window = {
        measurementStart, deadline, dispatchClosed, finishedMonotonicMs,
        observedActiveWindowMs: measurementStart === null ? 0 : dispatchClosed - measurementStart,
        totalElapsedMs: measurementStart === null ? 0 : finishedMonotonicMs - measurementStart,
        drainMs: finishedMonotonicMs - dispatchClosed,
        peakInFlight, workerCount: workers.length, workers
    };
    failures.push(...loadWindowFailures({ plan, window, dispatches, samples, expectedRequests }));
    if (controller.signal.aborted)
    {
        failures.push('load-window-cancelled');
    }
    if (routeFailures.length > 0)
    {
        failures.push('load-route-contract-failed');
    }
    return {
        status: failures.length === 0 ? 'ok' : 'failed', plan, window,
        generatorBudget: { maxDispatchedRequests: maxRequests },
        expectedRequests, dispatches, samples, routeFailures,
        calculated, identityBefore, identityAfter,
        failureReasons: [...new Set(failures)]
    };
}

/** Recheck observed timing, worker membership, dispatch order and minimum work. */
export function loadWindowFailures({ plan, window, dispatches, samples, expectedRequests })
{
    const failures = [];
    const fail = (condition, reason) =>
    {
        if (!condition)
        {
            failures.push(reason);
        }
    };
    fail(JSON.stringify(plan) === JSON.stringify(createLoadExecutionPlan(plan, plan.routes)), 'load-plan-digest-mismatch');
    fail(Number.isFinite(window.measurementStart) && Number.isFinite(window.deadline)
        && window.deadline - window.measurementStart >= plan.durationMs
        && window.observedActiveWindowMs >= plan.durationMs
        && window.observedActiveWindowMs === window.dispatchClosed - window.measurementStart
        && window.totalElapsedMs === window.finishedMonotonicMs - window.measurementStart
        && window.drainMs === window.finishedMonotonicMs - window.dispatchClosed
        && window.finishedMonotonicMs >= window.dispatchClosed, 'load-window-duration-not-reached');
    fail(window.workerCount === plan.concurrency && window.workers.length === plan.concurrency
        && new Set(window.workers.map((w) => w.workerId)).size === plan.concurrency
        && window.workers.every((w, index) => w.workerId === `worker-${index}`
            && w.readyMonotonicMs <= window.measurementStart), 'load-worker-barrier-incomplete');
    fail(window.peakInFlight === plan.concurrency, 'load-generator-concurrency-not-reached');
    fail(dispatches.length === expectedRequests.length && dispatches.every((d, index) =>
        d.ordinal === index && d.routeId === plan.routes[index % plan.routes.length]
        && d.startedMonotonicMs >= window.measurementStart && d.startedMonotonicMs < window.deadline
        && ['sampleId', 'workerId', 'sequence', 'path'].every((key) => d[key] === expectedRequests[index]?.[key])),
    'load-dispatch-plan-mismatch');
    try
    {
        const canonical = canonicalizeLoadSamples(samples, expectedRequests);
        const byId = new Map(dispatches.map((d) => [d.sampleId, d]));
        const completedByWorker = new Map();
        const events = [];
        for (const sample of canonical)
        {
            events.push([sample.startedMonotonicMs, 1], [sample.finishedMonotonicMs, -1]);
            if (sample.outcome !== 'cancelled')
            {
                completedByWorker.set(sample.workerId, (completedByWorker.get(sample.workerId) ?? 0) + 1);
            }
        }
        let observedInFlight = 0;
        let observedPeak = 0;
        for (const [, change] of events.sort((left, right) => left[0] - right[0] || left[1] - right[1]))
        {
            observedInFlight += change;
            observedPeak = Math.max(observedPeak, observedInFlight);
        }
        fail(observedPeak === window.peakInFlight, 'load-observed-concurrency-mismatch');
        fail(window.workers.every((w) => w.completed === (completedByWorker.get(w.workerId) ?? 0)
            && w.dispatched === canonical.filter((s) => s.workerId === w.workerId).length), 'load-worker-counts-mismatch');
        fail(canonical.filter((s) => s.outcome !== 'cancelled').length >= plan.minimumCompletedRequests
            && window.workers.every((w) => (completedByWorker.get(w.workerId) ?? 0) >= plan.rounds),
        'load-minimum-completed-requests-not-reached');
        fail(canonical.every((s) => s.outcome !== 'cancelled'
            && window.workers.some((w) => s.workerId === w.workerId)
            && s.startedMonotonicMs === byId.get(s.sampleId)?.startedMonotonicMs
            && s.finishedMonotonicMs <= window.finishedMonotonicMs), 'load-sample-window-mismatch');
    }
    catch (error)
    {
        failures.push(error.message);
    }
    return failures;
}
