import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url).href);
const { fetchRouteSample, producerRouteIds, routeContract } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url).href);
const { buildOpenLoopLoadRouteStatistics, validateLoadRouteStatisticsPolicy, verifyOpenLoopLoadRouteStatistics } = await import(new URL('../../tools/test/open-loop-load-route-statistics.mjs', import.meta.url).href);
const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule } = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }).trim();
const fixtureRouteIds = ['system-seo', 'category-list'];
const thresholds = { latencyP95Ms: 300, latencyP99Ms: 300, latencyMaxMs: 300,
    errorRate: 0, timeoutRate: 0, dropRate: 0 };

function arrivalPolicy(changes = {})
{
    return { schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'fixture', durationMs: 400,
        arrivalModel: 'constant', plannedRequestsPerSecond: 10, burstWindows: [], maximumInFlight: 100,
        requestTimeoutMs: 1200, routeMix: fixtureRouteIds.map((routeId) => ({ routeId, count: 2 })),
        scheduleSeed: 'route-fixture', qualificationWindowMs: 400, offeredRateTolerance: 0, ...changes };
}

function routePolicy(routeIds = fixtureRouteIds, limits = thresholds)
{
    return { schema: 'fsusblog.release-load-route-statistics-policy.v1', routes: routeIds.map((routeId) =>
        ({ routeId, minimumValidSamples: 1, thresholds: { ...limits } })) };
}

async function localFixture(t, respond = () => ({ delayMs: 1 }))
{
    let requests = 0;
    const timers = new Set();
    const server = http.createServer((request, response) =>
    {
        const ordinal = ++requests;
        const routeId = fixtureRouteIds.find((id) => routeContract(id).pathTemplate === request.url);
        assert.ok(routeId, 'fixture only receives declared task-owned routes');
        const contract = routeContract(routeId);
        const specification = respond({ routeId, ordinal });
        const timer = setTimeout(() =>
        {
            timers.delete(timer);
            if (specification.reset)
            {
                response.destroy();
                return;
            }
            response.writeHead(specification.status ?? 200, { 'content-type': 'application/octet-stream' });
            response.end(new Uint8Array(encodeAedsFrame(specification.frameType ?? contract.expectedAedsFrameType,
                new Uint8Array(specification.payloadBytes ?? 16))));
        }, specification.delayMs);
        timers.add(timer);
        response.once('close', () =>
        {
            clearTimeout(timer);
            timers.delete(timer);
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        for (const timer of timers)
        {
            clearTimeout(timer);
        }
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return { requestCount: () => requests,
        request: (arrival, { signal, requestTimeoutMs }) => fetchRouteSample({
            routeId: arrival.routeId, baseUrl, timeoutMs: requestTimeoutMs,
            fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([signal, options.signal]) })
        }) };
}

async function observe(t, { policy = arrivalPolicy(), limits = routePolicy(), respond, requestTransform } = {})
{
    const fixture = await localFixture(t, respond);
    const expectedRouteIds = policy.routeMix.map((route) => route.routeId);
    const schedule = buildOpenLoopLoadSchedule(policy, expectedRouteIds);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: async (arrival, options) =>
    {
        const sample = await fixture.request(arrival, options);
        return requestTransform ? requestTransform(sample) : sample;
    } });
    return { fixture, schedule, timeline: result.timeline, routePolicy: limits, expectedRouteIds, sourceSha };
}

test('real HTTP produces complete independently verified route metrics with an optional aggregate', async (t) =>
{
    const inputs = await observe(t);
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    assert.equal(inputs.fixture.requestCount(), 4);
    assert.equal(summary.passed, true);
    assert.equal(summary.qualificationEligible, false);
    assert.equal(summary.sourceSha, sourceSha);
    assert.equal(summary.arrivalPolicyDigest, inputs.schedule.policyDigest);
    assert.equal(summary.scheduleDigest, inputs.schedule.contentDigest);
    assert.equal(summary.timelineDigest, inputs.timeline.contentDigest);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(summary, inputs), summary);
    assert.equal(Object.isFrozen(summary.routes[0].thresholds), true);
    for (const route of summary.routes)
    {
        assert.equal(route.plannedSamples, 2);
        assert.equal(route.dispatchedSamples, 2);
        assert.equal(route.completedSamples, 2);
        assert.equal(route.contractPassedSamples, 2);
        assert.equal(route.failedSamples, 0);
        assert.equal(route.timedOutSamples, 0);
        assert.equal(route.droppedSamples, 0);
        assert.equal(route.errorRate, 0);
        assert.equal(route.timeoutRate, 0);
        assert.equal(route.dropRate, 0);
        assert.equal(route.bodyBytesP50, inputs.timeline.records.find((row) => row.routeId === route.routeId).sample.bodyBytes);
        assert.equal(route.bodyBytesP99, route.bodyBytesP50);
        assert.equal(route.latencyP99Ms, route.latencyMaxMs);
        assert.equal(route.latencyP95Ms, route.latencyMaxMs);
        assert.equal(route.sampleMembership.length, 2);
        assert.match(route.membershipDigest, /^sha256:[0-9a-f]{64}$/u);
    }
    const withoutAggregate = buildOpenLoopLoadRouteStatistics({ ...inputs, includeAggregate: false });
    assert.equal(Object.hasOwn(withoutAggregate, 'aggregate'), false);
    assert.equal(withoutAggregate.passed, true);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(withoutAggregate, inputs), withoutAggregate);
    for (const key of ['latencyP95Ms', 'latencyP99Ms', 'latencyMaxMs'])
    {
        const limits = routePolicy();
        limits.routes[0].thresholds[key] = 0;
        const failed = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: limits });
        assert.deepEqual(failed.routes.find((route) => route.routeId === limits.routes[0].routeId).failures, [key]);
        assert.equal(failed.routes.find((route) => route.routeId === limits.routes[1].routeId).passed, true);
        assert.equal(failed.passed, false);
    }
    const minimum = routePolicy();
    minimum.routes[0].minimumValidSamples = 3;
    const insufficient = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: minimum });
    assert.deepEqual(insufficient.routes.find((route) => route.routeId === minimum.routes[0].routeId).failures,
        ['minimum-valid-samples']);
    assert.equal(insufficient.passed, false);
});

test('real 99 percent fast HTTP cannot mask the slow one-percent route even when global p99 passes', async (t) =>
{
    const inputs = await observe(t, { policy: arrivalPolicy({ durationMs: 1000, qualificationWindowMs: 1000,
        plannedRequestsPerSecond: 100, routeMix: [{ routeId: 'system-seo', weight: 99 }, { routeId: 'category-list', weight: 1 }] }),
    respond: ({ routeId }) => ({ delayMs: routeId === 'category-list' ? 800 : 1 }) });
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    const fast = summary.routes.find((route) => route.routeId === 'system-seo');
    const slow = summary.routes.find((route) => route.routeId === 'category-list');
    assert.equal(inputs.fixture.requestCount(), 100);
    assert.equal(fast.contractPassedSamples, 99);
    assert.equal(slow.contractPassedSamples, 1);
    assert.ok(summary.aggregate.latencyP99Ms < thresholds.latencyP99Ms);
    assert.ok(slow.latencyP99Ms > thresholds.latencyP99Ms);
    assert.equal(fast.passed, true);
    assert.equal(slow.passed, false);
    assert.ok(slow.failures.includes('latencyP99Ms'));
    assert.equal(summary.passed, false);
    assert.equal(summary.arrivalPassed, true);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(summary, inputs), summary);
    assert.equal(buildOpenLoopLoadRouteStatistics({ ...inputs, includeAggregate: false }).passed, false);
    const warningOnly = structuredClone(summary);
    warningOnly.passed = true;
    assert.throws(() => verifyOpenLoopLoadRouteStatistics(warningOnly, inputs));
    const insufficient = structuredClone(inputs.routePolicy);
    insufficient.routes.find((route) => route.routeId === 'category-list').minimumValidSamples = 2;
    const undersampled = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: insufficient });
    assert.ok(undersampled.routes.find((route) => route.routeId === 'category-list').failures.includes('minimum-valid-samples'));
    assert.equal(undersampled.passed, false);
    t.diagnostic(JSON.stringify({ globalP99Ms: summary.aggregate.latencyP99Ms, fastSamples: fast.contractPassedSamples,
        slowP99Ms: slow.latencyP99Ms, slowSamples: slow.contractPassedSamples, profilePassed: summary.passed }));
});

test('real failed, timed-out and dropped HTTP members never enter latency or body percentiles', async (t) =>
{
    const inputs = await observe(t, { policy: arrivalPolicy({ durationMs: 700, qualificationWindowMs: 700,
        plannedRequestsPerSecond: 10, routeMix: [{ routeId: 'system-seo', count: 7 }],
        maximumInFlight: 1, requestTimeoutMs: 260 }), limits: routePolicy(['system-seo']),
    respond: ({ ordinal }) => ({ delayMs: ordinal === 3 ? 600 : 1, status: ordinal === 2 ? 500 : 200,
        payloadBytes: ordinal === 2 ? 128 : 16 }) });
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    const route = summary.routes[0];
    const valid = inputs.timeline.records.filter((row) => row.outcome === 'completed' && row.sample.ok);
    const latency = valid.map((row) => row.sample.latencyMs).sort((a, b) => a - b);
    const bodyBytes = valid.map((row) => row.sample.bodyBytes).sort((a, b) => a - b);
    assert.equal(inputs.fixture.requestCount(), 5);
    assert.equal(route.plannedSamples, 7);
    assert.equal(route.dispatchedSamples, 5);
    assert.equal(route.completedSamples, 5);
    assert.equal(route.contractPassedSamples, 3);
    assert.equal(route.failedSamples, 1);
    assert.equal(route.timedOutSamples, 1);
    assert.equal(route.droppedSamples, 2);
    assert.equal(route.latencyP50Ms, latency[1]);
    assert.equal(route.latencyP95Ms, latency.at(-1));
    assert.equal(route.latencyP99Ms, latency.at(-1));
    assert.equal(route.latencyMaxMs, latency.at(-1));
    assert.equal(route.bodyBytesP50, bodyBytes[1]);
    assert.equal(route.bodyBytesP99, bodyBytes.at(-1));
    assert.equal(route.errorRate, 1 / 5);
    assert.equal(route.timeoutRate, 1 / 5);
    assert.equal(route.dropRate, 2 / 7);
    assert.deepEqual(route.failures, ['errorRate', 'timeoutRate', 'dropRate']);
    assert.equal(summary.passed, false);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(summary, inputs), summary);
    for (const key of ['errorRate', 'timeoutRate', 'dropRate'])
    {
        const limits = routePolicy(['system-seo'], { ...thresholds, errorRate: 1, timeoutRate: 1, dropRate: 1 });
        limits.routes[0].thresholds[key] = 0;
        const failed = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: limits });
        assert.deepEqual(failed.routes[0].failures, [key]);
        assert.equal(failed.passed, false);
    }
});

test('real cancellation fails a route even when its rate thresholds allow invalid samples', async (t) =>
{
    const fixture = await localFixture(t);
    const expectedRouteIds = ['system-seo'];
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy({ routeMix: [{ routeId: 'system-seo', count: 4 }] }), expectedRouteIds);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    let timeline;
    try
    {
        ({ timeline } = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request, signal: controller.signal }));
    }
    finally
    {
        clearTimeout(timer);
    }
    const inputs = { schedule, timeline, expectedRouteIds, sourceSha,
        routePolicy: routePolicy(expectedRouteIds, { ...thresholds, errorRate: 1, timeoutRate: 1, dropRate: 1 }) };
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    assert.equal(summary.routes[0].contractPassedSamples, 1);
    assert.equal(summary.routes[0].completedSamples, 1);
    assert.equal(summary.routes[0].failedSamples, 0);
    assert.equal(summary.routes[0].timedOutSamples, 0);
    assert.equal(summary.routes[0].errorRate, 0);
    assert.equal(summary.routes[0].timeoutRate, 0);
    assert.deepEqual(summary.routes[0].failures, ['cancelled-samples']);
    assert.equal(summary.passed, false);
});

test('real success, HTTP error, network reset, timeout, drop and cancellation retain independent counts and denominators', async (t) =>
{
    const fixture = await localFixture(t, ({ ordinal }) => ({ delayMs: [4, 6].includes(ordinal) ? 600 : 1,
        status: ordinal === 2 ? 500 : 200, reset: ordinal === 3 }));
    const expectedRouteIds = ['system-seo'];
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy({ durationMs: 1200, qualificationWindowMs: 1200,
        plannedRequestsPerSecond: 10, routeMix: [{ routeId: 'system-seo', count: 12 }],
        maximumInFlight: 1, requestTimeoutMs: 260 }), expectedRouteIds);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 850);
    let timeline;
    try
    {
        ({ timeline } = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request, signal: controller.signal }));
    }
    finally
    {
        clearTimeout(timer);
    }
    const inputs = { schedule, timeline, expectedRouteIds, sourceSha, routePolicy: routePolicy(expectedRouteIds) };
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    const route = summary.routes[0];
    assert.equal(fixture.requestCount(), 6);
    assert.equal(route.plannedSamples, 12);
    assert.equal(route.dispatchedSamples, 6);
    assert.equal(route.completedSamples, 5);
    assert.equal(route.contractPassedSamples, 2);
    assert.equal(route.failedSamples, 2);
    assert.equal(route.timedOutSamples, 1);
    assert.equal(route.droppedSamples, 3);
    assert.equal(timeline.records.filter((record) => record.outcome === 'cancelled').length, 4);
    assert.equal(timeline.records.find((record) => record.sample?.status === 0
        && record.outcome === 'completed').sample.failureKind, 'request-failed');
    assert.equal(route.errorRate, 2 / 5);
    assert.equal(route.timeoutRate, 1 / 5);
    assert.equal(route.dropRate, 3 / 12);
    assert.equal(summary.aggregate.errorRate, 2 / 5);
    assert.equal(summary.aggregate.timeoutRate, 1 / 5);
    assert.equal(summary.aggregate.dropRate, 3 / 12);
    const valid = timeline.records.filter((record) => record.outcome === 'completed' && record.sample.ok);
    assert.equal(route.latencyP99Ms, Math.max(...valid.map((record) => record.sample.latencyMs)));
    assert.equal(route.bodyBytesP99, Math.max(...valid.map((record) => record.sample.bodyBytes)));
    assert.deepEqual(route.failures, ['errorRate', 'timeoutRate', 'dropRate', 'cancelled-samples']);
    assert.equal(summary.passed, false);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(summary, inputs), summary);
    t.diagnostic(JSON.stringify({ completed: route.completedSamples, failed: route.failedSamples,
        timedOut: route.timedOutSamples, dropped: route.droppedSamples, cancelled: 4,
        errorRate: route.errorRate, timeoutRate: route.timeoutRate, dropRate: route.dropRate }));
});

test('zero completed requests retain null error and timeout rates and cannot pass', async (t) =>
{
    const fixture = await localFixture(t);
    const expectedRouteIds = ['system-seo'];
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy({ routeMix: [{ routeId: 'system-seo', count: 4 }] }), expectedRouteIds);
    const controller = new AbortController();
    controller.abort();
    const { timeline } = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request, signal: controller.signal });
    const inputs = { schedule, timeline, expectedRouteIds, sourceSha,
        routePolicy: routePolicy(expectedRouteIds, { ...thresholds, errorRate: 1, timeoutRate: 1, dropRate: 1 }) };
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    assert.equal(fixture.requestCount(), 0);
    assert.equal(summary.routes[0].completedSamples, 0);
    assert.equal(summary.routes[0].failedSamples, 0);
    assert.equal(summary.routes[0].timedOutSamples, 0);
    assert.equal(summary.routes[0].errorRate, null);
    assert.equal(summary.routes[0].timeoutRate, null);
    assert.equal(summary.aggregate.errorRate, null);
    assert.equal(summary.aggregate.timeoutRate, null);
    assert.ok(summary.routes[0].failures.includes('no-completed-samples'));
    assert.ok(summary.routes[0].failures.includes('errorRate'));
    assert.ok(summary.routes[0].failures.includes('timeoutRate'));
    assert.equal(summary.passed, false);
    assert.deepEqual(verifyOpenLoopLoadRouteStatistics(summary, inputs), summary);
});

test('zero valid HTTP samples fail minimum and retain null successful percentiles', async (t) =>
{
    const inputs = await observe(t, { respond: () => ({ delayMs: 1, frameType: 255 }) });
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    assert.equal(summary.passed, false);
    for (const route of summary.routes)
    {
        assert.equal(route.contractPassedSamples, 0);
        assert.equal(route.failedSamples, 2);
        assert.equal(route.latencyP50Ms, null);
        assert.equal(route.latencyP95Ms, null);
        assert.equal(route.latencyP99Ms, null);
        assert.equal(route.latencyMaxMs, null);
        assert.equal(route.bodyBytesP50, null);
        assert.equal(route.bodyBytesP99, null);
        assert.ok(route.failures.includes('minimum-valid-samples'));
    }
});

test('each threshold and the minimum are mandatory explicit finite inputs', () =>
{
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(), fixtureRouteIds);
    for (const routeIndex of [0, 1])
    {
        for (const key of Object.keys(thresholds))
        {
            for (const invalid of [undefined, null, NaN, Infinity, -1, '300'])
            {
                const candidate = routePolicy();
                candidate.routes[routeIndex].thresholds[key] = invalid;
                assert.throws(() => validateLoadRouteStatisticsPolicy(candidate, schedule, fixtureRouteIds));
            }
            const missing = routePolicy();
            delete missing.routes[routeIndex].thresholds[key];
            assert.throws(() => validateLoadRouteStatisticsPolicy(missing, schedule, fixtureRouteIds));
        }
        for (const invalid of [undefined, null, 0, -1, 1.5, Infinity])
        {
            const candidate = routePolicy();
            candidate.routes[routeIndex].minimumValidSamples = invalid;
            assert.throws(() => validateLoadRouteStatisticsPolicy(candidate, schedule, fixtureRouteIds));
        }
        const missing = routePolicy();
        missing.routes[routeIndex].thresholds = null;
        assert.throws(() => validateLoadRouteStatisticsPolicy(missing, schedule, fixtureRouteIds));
    }
    const globalOnly = { schema: routePolicy().schema, thresholds };
    assert.throws(() => validateLoadRouteStatisticsPolicy(globalOnly, schedule, fixtureRouteIds));
});

test('policy and schedule require exact known route sets with no missing, duplicate, extra or zero-sample route', () =>
{
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(), fixtureRouteIds);
    for (const ids of [['system-seo'], ['system-seo', 'system-seo'], [...fixtureRouteIds, 'tag-list'],
        ['system-seo', 'unknown-route']])
    {
        assert.throws(() => validateLoadRouteStatisticsPolicy(routePolicy(ids), schedule, fixtureRouteIds));
        assert.throws(() => validateLoadRouteStatisticsPolicy(routePolicy(), schedule, ids));
    }
    assert.throws(() => validateLoadRouteStatisticsPolicy(routePolicy(), schedule));
    assert.throws(() => validateLoadRouteStatisticsPolicy(routePolicy(), schedule, producerRouteIds('runtime-load-soak')));
    assert.throws(() => buildOpenLoopLoadSchedule(arrivalPolicy({ routeMix: [{ routeId: 'system-seo', count: 3 },
        { routeId: 'category-list', count: 2 }] }), fixtureRouteIds), /exact planned arrival count/u);
    assert.throws(() => buildOpenLoopLoadSchedule(arrivalPolicy({ routeMix: [{ routeId: 'system-seo', weight: 1000 },
        { routeId: 'category-list', weight: 1 }] }), fixtureRouteIds), /zero-sample/u);
});

test('route order preserves semantic digests while explicit policy or source changes alter candidate identity', async (t) =>
{
    const inputs = await observe(t);
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    const reordered = buildOpenLoopLoadRouteStatistics({ ...inputs, expectedRouteIds: [...fixtureRouteIds].reverse(),
        schedule: buildOpenLoopLoadSchedule({ ...inputs.schedule.policy, routeMix: [...inputs.schedule.policy.routeMix].reverse() }, fixtureRouteIds),
        routePolicy: { ...inputs.routePolicy, routes: [...inputs.routePolicy.routes].reverse() } });
    assert.deepEqual(reordered, summary);
    const changed = structuredClone(inputs.routePolicy);
    changed.routes[0].thresholds.latencyP99Ms += 1;
    const thresholdChange = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: changed });
    changed.routes[0].minimumValidSamples = 2;
    const minimumChange = buildOpenLoopLoadRouteStatistics({ ...inputs, routePolicy: changed });
    for (const alternate of [thresholdChange, minimumChange])
    {
        assert.notEqual(alternate.routePolicyDigest, summary.routePolicyDigest);
        assert.notEqual(alternate.policyDigest, summary.policyDigest);
        assert.notEqual(alternate.candidateIdentity, summary.candidateIdentity);
        assert.equal(alternate.arrivalPolicyDigest, summary.arrivalPolicyDigest);
        assert.equal(alternate.membershipDigest, summary.membershipDigest);
    }
    assert.notEqual(minimumChange.policyDigest, thresholdChange.policyDigest);
    const parentSha = execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: new URL('../../', import.meta.url), encoding: 'utf8' }).trim();
    assert.notEqual(buildOpenLoopLoadRouteStatistics({ ...inputs, sourceSha: parentSha }).candidateIdentity, summary.candidateIdentity);
    assert.throws(() => buildOpenLoopLoadRouteStatistics({ ...inputs, sourceSha: 'HEAD' }));
});

test('unknown, missing, duplicate and altered planned or actual sample membership fails closed', async (t) =>
{
    const inputs = await observe(t);
    const mutations = [
        (timeline) =>
        {
            timeline.records.pop();
        },
        (timeline) =>
        {
            timeline.records.push(structuredClone(timeline.records[0]));
        },
        (timeline) =>
        {
            timeline.records[1] = structuredClone(timeline.records[0]);
        },
        (timeline) =>
        {
            timeline.records[0].routeId = 'unknown-route';
        },
        (timeline) =>
        {
            timeline.records[0].sample.routeId = 'unknown-route';
        },
        (timeline) =>
        {
            timeline.records[0].sampleId = 'foreign-member';
        }
    ];
    for (const mutate of mutations)
    {
        const timeline = structuredClone(inputs.timeline);
        mutate(timeline);
        assert.throws(() => buildOpenLoopLoadRouteStatistics({ ...inputs, timeline }));
    }
    const schedule = structuredClone(inputs.schedule);
    schedule.arrivals[0].routeId = schedule.arrivals[0].routeId === 'system-seo' ? 'category-list' : 'system-seo';
    assert.throws(() => buildOpenLoopLoadRouteStatistics({ ...inputs, schedule }), /planned schedule differs/u);
});

test('verifier rejects missing per-route outputs, forged decisions and altered membership evidence', async (t) =>
{
    const inputs = await observe(t);
    const summary = buildOpenLoopLoadRouteStatistics(inputs);
    for (const key of Object.keys(summary.routes[0]))
    {
        const altered = structuredClone(summary);
        delete altered.routes[0][key];
        assert.throws(() => verifyOpenLoopLoadRouteStatistics(altered, inputs));
    }
    for (const mutate of [
        (value) =>
        {
            value.routes.pop();
        },
        (value) =>
        {
            value.routes.push(structuredClone(value.routes[0]));
        },
        (value) =>
        {
            value.routes[0].sampleMembership[0].sampleId = 'foreign-member';
        },
        (value) =>
        {
            value.routes[0].membershipDigest = value.routes[1].membershipDigest;
        },
        (value) =>
        {
            value.routes[0].latencyP99Ms = 0;
        },
        (value) =>
        {
            value.passed = false;
        },
        (value) =>
        {
            value.qualificationEligible = true;
        },
        (value) =>
        {
            delete value.routes;
        }
    ])
    {
        const altered = structuredClone(summary);
        mutate(altered);
        assert.throws(() => verifyOpenLoopLoadRouteStatistics(altered, inputs));
    }
    assert.throws(() => verifyOpenLoopLoadRouteStatistics(null, inputs));
});

test('actual HTTP sample port must preserve route catalog identity and valid numeric metrics', async (t) =>
{
    for (const requestTransform of [
        (sample) => ({ ...sample, contractDigest: 'missing-contract' }),
        (sample) => ({ ...sample, latencyMs: null }),
        (sample) => ({ ...sample, bodyBytes: -1 }),
        (sample) => ({ ...sample, frameType: 255 }),
        (sample) => ({ ...sample, status: 500 })
    ])
    {
        const inputs = await observe(t, { requestTransform });
        assert.throws(() => buildOpenLoopLoadRouteStatistics(inputs));
    }
});
