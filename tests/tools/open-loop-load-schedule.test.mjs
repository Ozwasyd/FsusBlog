import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url).href);
const {
    buildOpenLoopLoadSchedule,
    dispatchOpenLoopLoadSchedule,
    validateLoadArrivalPolicy,
    verifyOpenLoopLoadSchedule,
    verifyOpenLoopLoadTimeline
} = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);
const { validateJsonSchema } = await import(new URL('../../tools/test-matrix/schema-validator/validate.mjs', import.meta.url).href);

function policy(changes = {})
{
    return { schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'fixture', durationMs: 1000,
        arrivalModel: 'constant', plannedRequestsPerSecond: 10, burstWindows: [], maximumInFlight: 20,
        requestTimeoutMs: 100, routeMix: [{ routeId: 'system-seo', weight: 1 }], scheduleSeed: 'fixture-seed',
        qualificationWindowMs: 100, offeredRateTolerance: 0, ...changes };
}

// Explicit source-test observations; these are never runtime qualification evidence.
function timeline(schedule, changes = {})
{
    return sealContentDigest({ schema: 'fsusblog.release-load-arrival-timeline.v1',
        scheduleDigest: schedule.contentDigest, policyDigest: schedule.policyDigest,
        observedActiveWindowMs: schedule.policy.durationMs,
        records: schedule.arrivals.map((arrival) => ({ ...arrival, dispatchedAtMs: arrival.plannedAtMs,
            completedAtMs: arrival.plannedAtMs + 1, observedAtMs: arrival.plannedAtMs + 1, scheduleLagMs: 0,
            outcome: 'completed', failureKind: null, sample: { routeId: arrival.routeId, ok: true, failureKind: null } })), ...changes });
}

test('arrival structural schema compiles in the canonical strict validator and refuses incomplete windows', () =>
{
    const schema = JSON.parse(fs.readFileSync(new URL('../../config/schemas/release-load-arrival-policy.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateJsonSchema(policy(), schema), []);
    const burst = policy({ arrivalModel: 'burst', burstWindows: [
        { startMs: 200, endMs: 400, requestsPerSecond: 20, recoveryEndMs: 600 }
    ] });
    assert.deepEqual(validateJsonSchema(burst, schema), []);
    delete burst.burstWindows[0].recoveryEndMs;
    assert.ok(validateJsonSchema(burst, schema).length > 0);
    assert.ok(validateJsonSchema(policy({ routeMix: [{ routeId: 'system-seo', weight: 1, count: 1 }] }), schema).length > 0);
});

test('constant arrival policy materializes exactly six thousand half-open timestamps', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 60000, plannedRequestsPerSecond: 100 }));
    assert.equal(schedule.plannedCount, 6000);
    assert.equal(schedule.arrivals[0].plannedAtMs, 0);
    assert.equal(schedule.arrivals.at(-1).plannedAtMs, 59990);
    assert.ok(Object.isFrozen(schedule.arrivals));
    assert.equal(verifyOpenLoopLoadSchedule(schedule).contentDigest, schedule.contentDigest);
});

test('burst boundaries and recovery preserve the independently planned baseline arrivals', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy({ arrivalModel: 'burst', burstWindows: [
        { startMs: 200, endMs: 400, requestsPerSecond: 20, recoveryEndMs: 600 }
    ] }));
    assert.deepEqual(schedule.arrivals.map((row) => row.plannedAtMs), [0, 100, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900]);
    assert.equal(schedule.plannedCount, 12);
});

test('arrival construction refuses missing numeric qualification and unsupported closed-loop declarations', () =>
{
    const absent = policy();
    delete absent.offeredRateTolerance;
    assert.throws(() => buildOpenLoopLoadSchedule(absent), /requires every explicit/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ concurrency: 10 })), /unsupported shape/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ offeredRateTolerance: 1 })), /zero offered load/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ durationMs: '1000' })), /numeric bounds/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ profileId: undefined })), /profile/u);
});

test('arrival construction refuses request allocation and qualification window explosions before materialization', () =>
{
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ plannedRequestsPerSecond: 1000001 })), /materialized planned request count/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ durationMs: 86400000, qualificationWindowMs: 1 })), /qualification window count/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ plannedRequestsPerSecond: Infinity })), /numeric bounds/u);
});

test('arrival windows refuse overlap, absent recovery and a recovery crossing the next burst', () =>
{
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ arrivalModel: 'burst', burstWindows: [
        { startMs: 200, endMs: 400, requestsPerSecond: 20 }
    ] })), /recoveryEndMs/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ arrivalModel: 'burst', burstWindows: [
        { startMs: 200, endMs: 400, requestsPerSecond: 20, recoveryEndMs: 800 },
        { startMs: 700, endMs: 900, requestsPerSecond: 20, recoveryEndMs: 1000 }
    ] })), /overlap/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ arrivalModel: 'step', burstWindows: [
        { startMs: 200, endMs: 400, requestsPerSecond: 20, recoveryEndMs: 500 }
    ] })), /step windows/u);
});

test('canonical route membership refuses unknown duplicate zero-sample and mixed-count routes', () =>
{
    assert.throws(() => validateLoadArrivalPolicy(policy(), ['public-home']), /actual producer route contract/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ routeMix: [null] })), /unsupported shape/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ routeMix: [
        { routeId: 'system-seo', weight: 1 }, { routeId: 'system-seo', weight: 1 }
    ] })), /duplicate/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ routeMix: [
        { routeId: 'system-seo', count: 9 }
    ] })), /exact planned arrival count/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ routeMix: [
        { routeId: 'system-seo', weight: 999999 }, { routeId: 'public-home', weight: 1 }
    ] })), /zero-sample/u);
    assert.throws(() => buildOpenLoopLoadSchedule(policy({ routeMix: [
        { routeId: 'system-seo', weight: 1 }, { routeId: 'public-home', count: 1 }
    ] })), /unsupported shape/u);
});

test('schedule seed and route weights only change route assignment and preserve exact planned timestamps', () =>
{
    const first = buildOpenLoopLoadSchedule(policy({ routeMix: [
        { routeId: 'system-seo', weight: 3 }, { routeId: 'public-home', weight: 2 }
    ] }));
    const second = buildOpenLoopLoadSchedule({ ...first.policy, scheduleSeed: 'another-seed' });
    assert.deepEqual(first.arrivals.map((row) => row.plannedAtMs), second.arrivals.map((row) => row.plannedAtMs));
    assert.equal(first.arrivals.filter((row) => row.routeId === 'system-seo').length, 6);
    assert.equal(second.arrivals.filter((row) => row.routeId === 'public-home').length, 4);
    const reversed = buildOpenLoopLoadSchedule({ ...first.policy, routeMix: [...first.policy.routeMix].reverse() });
    assert.equal(reversed.contentDigest, first.contentDigest);
    assert.notEqual(second.contentDigest, first.contentDigest);
});

test('schedule verifier refuses both plain tampering and resealed altered timestamps', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const altered = structuredClone(schedule);
    altered.arrivals[0].plannedAtMs = 1;
    assert.throws(() => verifyOpenLoopLoadSchedule(altered), /exact policy/u);
    assert.throws(() => verifyOpenLoopLoadSchedule(sealContentDigest(altered)), /exact policy/u);
});

test('timeline counts every exact planned member and never issues runtime qualification', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const result = verifyOpenLoopLoadTimeline(schedule, timeline(schedule));
    assert.equal(result.passed, true);
    assert.equal(result.qualificationEligible, false);
    assert.deepEqual(result.counts, { planned: 10, dispatched: 10, completed: 10, timedOut: 0, dropped: 0, cancelled: 0 });
});

test('timeline refuses lost duplicate unknown and resealed lag observations', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const evidence = timeline(schedule);
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records: evidence.records.slice(1) })), /membership/u);
    const duplicate = structuredClone(evidence.records);
    duplicate[1] = duplicate[0];
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records: duplicate })), /membership/u);
    const altered = structuredClone(evidence.records);
    altered[0].scheduleLagMs = 99;
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records: altered })), /planned timestamp/u);
    altered[0].scheduleLagMs = 0;
    altered[0].routeId = 'unknown-route';
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records: altered })), /membership/u);
});

test('closed-loop shaped low offered rate fails explicit fixed-window tolerance', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const records = timeline(schedule).records.map((row, index) => ({ ...row,
        dispatchedAtMs: index * 100 + index * 8, completedAtMs: index * 100 + index * 8 + 1,
        observedAtMs: index * 100 + index * 8 + 1, scheduleLagMs: index * 8 }));
    records[1].dispatchedAtMs = 205;
    records[1].completedAtMs = records[1].observedAtMs = 206;
    records[1].scheduleLagMs = 105;
    const result = verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records }));
    assert.equal(result.passed, false);
    assert.ok(result.windows.some((window) => !window.passed));
});

test('timeline refuses claimed concurrency above the policy maximum in flight', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy({ maximumInFlight: 1 }));
    const records = timeline(schedule).records.map((row) => ({ ...row, completedAtMs: 1100, observedAtMs: 1100 }));
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records })), /maximumInFlight/u);
});

test('timeline refuses timeout and success reclassification even after content digest resealing', () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const records = structuredClone(timeline(schedule).records);
    records[0].sample.ok = false;
    records[0].sample.failureKind = 'timeout';
    records[0].failureKind = 'timeout';
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records })), /terminal classification/u);
    records[0].outcome = 'timed-out';
    assert.equal(verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records })).counts.timedOut, 1);
    records[0].sample.ok = true;
    assert.throws(() => verifyOpenLoopLoadTimeline(schedule, timeline(schedule, { records })), /route oracle/u);
});

test('dispatcher records sleep drift without shifting planned timestamps', async () =>
{
    let now = 0;
    const schedule = buildOpenLoopLoadSchedule(policy());
    const result = await dispatchOpenLoopLoadSchedule(schedule, {
        clock: () => now,
        sleep: async (ms) =>
        {
            now += ms + 3;
        },
        request: async (arrival) => ({ routeId: arrival.routeId, ok: true, failureKind: null })
    });
    assert.deepEqual(result.timeline.records.map((row) => row.plannedAtMs), schedule.arrivals.map((row) => row.plannedAtMs));
    assert.equal(result.timeline.records[1].scheduleLagMs, 3);
    assert.equal(result.validation.qualificationEligible, false);
});

test('measurement ports expose the same monotonic origin and active endpoint before adapter drain', async () =>
{
    let absolute = 7310;
    const calls = [];
    const pending = [];
    let settled = 0;
    const schedule = buildOpenLoopLoadSchedule(policy());
    const result = await dispatchOpenLoopLoadSchedule(schedule, { clock: () => absolute,
        sleep: async (ms) =>
        {
            absolute += ms;
        }, onMeasurementStart: (window) =>
        {
            assert.ok(Object.isFrozen(window));
            calls.push({ type: 'start', window });
        }, onMeasurementEnd: (window) =>
        {
            calls.push({ type: 'end', window });
            assert.equal(settled, 0, 'pending adapter drain must be outside the captured active window');
            absolute += 50;
            pending.forEach(({ resolve, routeId }) => resolve({ routeId, ok: true, failureKind: null }));
        }, request: (arrival) =>
        {
            assert.equal(calls[0].type, 'start');
            return new Promise((resolve) => pending.push({ resolve, routeId: arrival.routeId })).then((sample) =>
            {
                settled += 1;
                return sample;
            });
        } });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].window, { scheduleDigest: schedule.contentDigest, startedMonotonicMs: 7310,
        durationMs: 1000, plannedEndMonotonicMs: 8310 });
    assert.equal(calls[1].window.endedMonotonicMs, 8310);
    assert.equal(calls[1].window.observedActiveWindowMs, result.timeline.observedActiveWindowMs);
    assert.equal(calls[1].window.cancelled, false);
    assert.equal(settled, schedule.plannedCount);
    assert.ok(result.timeline.records.every((record) => record.completedAtMs === 1050));
});

test('pre-cancelled measurement reports an interrupted empty active window without fabricated duration', async () =>
{
    const controller = new AbortController();
    controller.abort();
    let terminal;
    const result = await dispatchOpenLoopLoadSchedule(buildOpenLoopLoadSchedule(policy()), { signal: controller.signal,
        clock: () => 7310, onMeasurementEnd: (window) =>
        {
            terminal = window;
        }, request: () => assert.fail('request after cancellation') });
    assert.equal(terminal.cancelled, true);
    assert.equal(terminal.endedMonotonicMs, terminal.startedMonotonicMs);
    assert.equal(terminal.observedActiveWindowMs, 0);
    assert.equal(result.validation.passed, false);
});

test('invalid asynchronous or failed measurement admission ports refuse before any request', async () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy());
    const request = () => assert.fail('HTTP before measurement admission');
    await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { request, onMeasurementStart: null }), /observable/u);
    await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { request, onMeasurementStart: () => Promise.resolve() }), /synchronously/u);
    const failure = new Error('fixture collector unavailable');
    await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { request, onMeasurementStart: () =>
    {
        throw failure;
    } }), (error) => error === failure);
});

test('dispatcher records request port entry rather than a deferred microtask reservation', async () =>
{
    let now = 0;
    const entries = new Map();
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 10, qualificationWindowMs: 10,
        plannedRequestsPerSecond: 1000 }));
    const result = await dispatchOpenLoopLoadSchedule(schedule, {
        clock: () => now,
        sleep: async (ms) =>
        {
            now += ms;
        },
        request: (arrival) =>
        {
            entries.set(arrival.sampleId, now);
            return Promise.resolve({ routeId: arrival.routeId, ok: true, failureKind: null });
        }
    });
    for (const record of result.timeline.records)
    {
        assert.equal(record.dispatchedAtMs, entries.get(record.sampleId), 'dispatch must observe actual adapter entry');
    }
});

test('dispatcher refuses an adapter entry crossing the active deadline during request setup', async () =>
{
    let clockReads = 0;
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 10, qualificationWindowMs: 10,
        plannedRequestsPerSecond: 1000 }));
    const result = await dispatchOpenLoopLoadSchedule(schedule, {
        clock: () => ++clockReads < 4 ? 0 : 20,
        request: () => assert.fail('expired request setup must never enter the adapter')
    });
    assert.equal(result.validation.counts.dispatched, 0);
    assert.equal(result.validation.counts.dropped, schedule.plannedCount);
    assert.ok(result.timeline.records.every((record) => record.failureKind === 'generator-schedule-expired'));
    assert.equal(result.validation.passed, false);
});

test('dispatcher rejects a backwards monotonic clock before dispatch', async () =>
{
    let calls = 0;
    await assert.rejects(dispatchOpenLoopLoadSchedule(buildOpenLoopLoadSchedule(policy()), {
        clock: () => ++calls === 1 ? 10 : 9,
        request: () => assert.fail('invalid clock must refuse before request')
    }), /moved backwards/u);
});

test('dispatcher preserves a pre-cancelled complete plan without requests or fabricated samples', async () =>
{
    const controller = new AbortController();
    controller.abort();
    const schedule = buildOpenLoopLoadSchedule(policy());
    const result = await dispatchOpenLoopLoadSchedule(schedule, {
        signal: controller.signal, request: () => assert.fail('cancelled plan cannot dispatch')
    });
    assert.equal(result.validation.counts.cancelled, 10);
    assert.equal(result.validation.counts.dispatched, 0);
    assert.equal(result.validation.passed, false);
    assert.ok(result.timeline.records.every((row) => row.sample === null));
});

test('dispatcher cannot pass arrival conformance after a request adapter failure', async () =>
{
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 10, qualificationWindowMs: 10,
        plannedRequestsPerSecond: 100 }));
    const result = await dispatchOpenLoopLoadSchedule(schedule, {
        request: async () =>
        {
            throw new Error('fixture adapter failure');
        }
    });
    assert.equal(result.validation.passed, false);
    assert.equal(result.timeline.records[0].failureKind, 'request-adapter-failed');
    assert.equal(result.timeline.records[0].sample, null);
    assert.equal(result.validation.qualificationEligible, false);
});

test('dispatcher refuses an uncooperative request port without fabricating terminal evidence', async () =>
{
    await assert.rejects(dispatchOpenLoopLoadSchedule(buildOpenLoopLoadSchedule(policy({
        durationMs: 10, qualificationWindowMs: 10, plannedRequestsPerSecond: 100, requestTimeoutMs: 10
    })), { request: () => new Promise(() =>
    {}) }), /did not settle/u);
});
