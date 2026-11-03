import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url).href);
const { fetchRouteSample, routeContract } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url).href);
const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url).href);
const { buildLoadRequestObservations, buildLoadRequestSample, buildLoadResourceObservability,
    observeLoadIssuer, observeLoadRequestStart, observeLoadTransportError, readLoadTransportResponseFacts, validateLoadRequestSample,
    validateLoadWorkerRegistration, verifyLoadRequestObservations }
    = await import(new URL('../../tools/test/load-request-observations.mjs', import.meta.url).href);

const { evaluateLoadProfileThresholds } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url).href);

function registration()
{
    const issuer = observeLoadIssuer();
    // The fixture holder explicitly registers the actual Node issuer ID. This is not a fifty-worker barrier.
    return { workerId: String(issuer.threadId), issuer };
}

async function serverFixture(t, behavior)
{
    let requests = 0;
    const server = http.createServer((request, response) =>
    {
        requests += 1;
        behavior(request, response, requests);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return { endpoint: `http://127.0.0.1:${server.address().port}`, count: () => requests };
}

function success(response)
{
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(new Uint8Array(encodeAedsFrame(13, new Uint8Array(16))));
}

async function actualRequest(endpoint, sequence, { deadlineMs = 1000, outerSignal } = {})
{
    const arrival = { sampleId: `fixture-arrival-${sequence}`, sequence, routeId: 'system-seo', plannedAtMs: sequence };
    const start = observeLoadRequestStart(arrival, registration(), sequence);
    const controller = new AbortController();
    const deadlineReason = Object.assign(new DOMException('fixture deadline', 'AbortError'), { transportStage: 'request-timeout' });
    const timer = setTimeout(() => controller.abort(deadlineReason), deadlineMs);
    const signal = AbortSignal.any([controller.signal, ...(outerSignal ? [outerSignal] : [])]);
    let error = null;
    let response = { httpStatus: 0, bytes: 0, contentType: null, frameType: null };
    const routeSample = await fetchRouteSample({ routeId: arrival.routeId, baseUrl: endpoint, timeoutMs: 5000,
        fetchImpl: async (url, options) =>
        {
            try
            {
                const observed = await fetch(url, { ...options, signal });
                response = { httpStatus: observed.status, bytes: null, contentType: observed.headers.get('content-type'), frameType: null };
                return { status: observed.status, headers: observed.headers, arrayBuffer: async () =>
                {
                    try
                    {
                        const body = await observed.arrayBuffer();
                        response.bytes = body.byteLength;
                        return body;
                    }
                    catch (caught)
                    {
                        error = observeLoadTransportError(caught, signal.aborted
                            ? signal.reason === deadlineReason ? 'deadline' : 'scenario-cancel' : 'transport');
                        throw caught;
                    }
                } };
            }
            catch (caught)
            {
                error = observeLoadTransportError(caught, signal.aborted
                    ? signal.reason === deadlineReason ? 'deadline' : 'scenario-cancel' : 'transport');
                throw caught;
            }
        } });
    clearTimeout(timer);
    response.frameType = routeSample.frameType;
    const terminalControl = error?.origin === 'deadline' ? 'timeout' : error?.origin === 'scenario-cancel' ? 'cancelled' : 'completed';
    const sample = buildLoadRequestSample({ ...start, finishedMonotonicMs: performance.now(), routeSample, response,
        terminalControl, error });
    return { sample, expected: { sampleId: arrival.sampleId, workerId: start.registration.workerId,
        sequence, path: routeContract(arrival.routeId).pathTemplate }, error };
}

test('actual issuer binding refuses missing registration, invented ID and changed process before dispatch', () =>
{
    assert.throws(() => validateLoadWorkerRegistration(undefined), /held load worker registration/u);
    const held = registration();
    assert.equal(validateLoadWorkerRegistration(held).workerId, String(observeLoadIssuer().threadId));
    assert.throws(() => validateLoadWorkerRegistration({ ...held, workerId: 'invented-worker' }), /actual issuing/u);
    assert.throws(() => validateLoadWorkerRegistration({ ...held, issuer: { ...held.issuer, pid: held.issuer.pid + 1 } }), /actual issuing/u);
});

test('ninety-nine actual successes and one HTTP500 retain one hundred exact samples and error rate0.01', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response, count) =>
    {
        if (count === 100)
        {
            response.writeHead(500, { 'content-type': 'text/plain' });
            response.end('actual failure');
        }
        else
        {
            success(response);
        }
    });
    const rows = await Promise.all(Array.from({ length: 100 }, (_, sequence) => actualRequest(fixture.endpoint, sequence)));
    const inputs = { samples: rows.map((row) => row.sample), expectedRequests: rows.map((row) => row.expected) };
    const summary = buildLoadRequestObservations(inputs);
    assert.equal(fixture.count(), 100);
    assert.equal(summary.completed, 100);
    assert.equal(summary.failed, 1);
    assert.equal(summary.errorRate, 0.01);
    assert.equal(summary.timeoutRate, 0);
    assert.equal(evaluateLoadProfileThresholds({ p95Ms: 1, p99Ms: 1, errorRate: summary.errorRate, timeoutRate: summary.timeoutRate },
        { maxP95Ms: 3000, maxP99Ms: 3000, maxErrorRate: 0, maxTimeoutRate: 0 }).status, 'fail');
    assert.equal(rows.find((row) => row.sample.httpStatus === 500).sample.outcome, 'http-error');
    assert.equal(summary.qualificationEligible, false);
    assert.equal(summary.nativeWorkerAuthorityVerified, false);
    verifyLoadRequestObservations(summary, inputs);
    const forged = sealContentDigest({ ...summary, errorRate: 0 });
    assert.throws(() => verifyLoadRequestObservations(forged, inputs), /independently recomputed/u);
    assert.throws(() => buildLoadRequestObservations({ ...inputs, samples: inputs.samples.slice(0, 99) }), /exact dispatched/u);
    assert.equal(buildLoadRequestObservations({ ...inputs, samples: [...inputs.samples].reverse() }).contentDigest, summary.contentDigest);
});

test('actual deadline and outer cancellation have separate outcomes and completed denominators', async (t) =>
{
    const fixture = await serverFixture(t, async (_request, response) =>
    {
        await delay(150);
        if (!response.destroyed)
        {
            success(response);
        }
    });
    const timeout = await actualRequest(fixture.endpoint, 0, { deadlineMs: 30 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('outer timeout words are irrelevant', 'AbortError')), 30);
    t.after(() => clearTimeout(timer));
    const cancellation = await actualRequest(fixture.endpoint, 1, { outerSignal: controller.signal });
    assert.equal(timeout.sample.outcome, 'timeout');
    assert.equal(cancellation.sample.outcome, 'cancelled');
    const summary = buildLoadRequestObservations({ samples: [timeout.sample, cancellation.sample],
        expectedRequests: [timeout.expected, cancellation.expected] });
    assert.equal(summary.completed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.timeoutRate, 1);
    assert.equal(summary.errorRate, 0);
    assert.equal(summary.observationsComplete, false);
    const cancelledOnly = await actualRequest(fixture.endpoint, 0, { outerSignal: AbortSignal.abort(new DOMException('fixture cancellation', 'AbortError')) });
    const empty = buildLoadRequestObservations({ samples: [cancelledOnly.sample], expectedRequests: [cancelledOnly.expected] });
    assert.equal(empty.completed, 0);
    assert.equal(empty.errorRate, null);
    assert.equal(empty.timeoutRate, null);
    assert.equal(empty.observationsComplete, false);
});

test('real peer reset preserves actual exception cause code and is a network error without deadline', async (t) =>
{
    const fixture = await serverFixture(t, (request) => request.socket.destroy());
    const row = await actualRequest(fixture.endpoint, 0);
    assert.equal(row.sample.outcome, 'network-error');
    assert.ok(row.error.causes.some((cause) => cause.code !== null));
    assert.equal(row.sample.errorCode, row.error.code);
    assert.equal(row.sample.errorDigest, row.error.contentDigest);
    const summary = buildLoadRequestObservations({ samples: [row.sample], expectedRequests: [row.expected] });
    assert.equal(summary.errorRate, 1);
    assert.equal(summary.timeoutRate, 0);
});

test('request samples refuse unknown partial body bytes, lost transport exception and contradictory durations', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response) => success(response));
    const row = await actualRequest(fixture.endpoint, 0);
    assert.equal(Object.keys(row.sample).length, 15);
    assert.throws(() => validateLoadRequestSample({ ...row.sample, bytes: null }), /observed finite/u);
    assert.throws(() => validateLoadRequestSample({ ...row.sample, durationMs: 0 }), /actual timing/u);
    const start = observeLoadRequestStart({ sampleId: 'lost', sequence: 0, routeId: 'system-seo' }, registration(), 0);
    assert.throws(() => buildLoadRequestSample({ ...start, finishedMonotonicMs: performance.now(),
        routeSample: { routeId: 'system-seo', ok: false, failureKind: 'request-failed' },
        response: { httpStatus: 0, bytes: 0, contentType: null, frameType: null }, terminalControl: 'completed' }), /lost its typed/u);
});

test('backend availability refuses bare null, fake available values and missing reasons; defaults remain unavailable', () =>
{
    const unavailable = buildLoadResourceObservability();
    assert.equal(Object.keys(unavailable).length, 8);
    assert.ok(Object.values(unavailable).every((metric) => metric.status === 'unavailable' && metric.value === null && metric.reason));
    assert.throws(() => buildLoadResourceObservability({ rssBytes: null }), /availability/u);
    assert.throws(() => buildLoadResourceObservability({ rssBytes: { status: 'ok', value: null, unit: 'bytes', source: '/proc/held/status' } }), /observed finite/u);
    assert.throws(() => buildLoadResourceObservability({ rssBytes: { status: 'unavailable', value: null, reason: '', source: null } }), /explicit unavailable/u);
});


test('ninety-nine successes and one actual request deadline retain timeout rate0.01 and fail a zero budget', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response, count) =>
    {
        if (count < 100)
        {
            success(response);
        }
    });
    const rows = [];
    for (let sequence = 0; sequence < 99; sequence += 1)
    {
        rows.push(await actualRequest(fixture.endpoint, sequence));
    }
    rows.push(await actualRequest(fixture.endpoint, 99, { deadlineMs: 30 }));
    const summary = buildLoadRequestObservations({ samples: rows.map((row) => row.sample), expectedRequests: rows.map((row) => row.expected) });
    assert.equal(fixture.count(), 100);
    assert.equal(summary.completed, 100);
    assert.equal(summary.timeoutRate, 0.01);
    assert.equal(summary.errorRate, 0);
    assert.equal(evaluateLoadProfileThresholds({ p95Ms: 1, p99Ms: 1, errorRate: summary.errorRate, timeoutRate: summary.timeoutRate },
        { maxP95Ms: 3000, maxP99Ms: 3000, maxErrorRate: 0, maxTimeoutRate: 0 }).status, 'fail');
});

test('actual HTTP400 remains a retained sample; duplicate and missing worker sequence are refused', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response) =>
    {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('actual bad request');
    });
    const first = await actualRequest(fixture.endpoint, 0);
    const gap = await actualRequest(fixture.endpoint, 2);
    assert.equal(first.sample.outcome, 'http-error');
    assert.equal(first.sample.httpStatus, 400);
    assert.throws(() => buildLoadRequestObservations({ samples: [first.sample, first.sample],
        expectedRequests: [first.expected, first.expected] }), /exact dispatched/u);
    assert.throws(() => buildLoadRequestObservations({ samples: [first.sample, gap.sample],
        expectedRequests: [first.expected, gap.expected] }), /missing worker request sequence/u);
});

test('unavailable numbers and resource states cannot coerce an existing required threshold to pass', () =>
{
    const thresholds = { maxP95Ms: 3000, maxP99Ms: 3000, maxErrorRate: 0, maxTimeoutRate: 0, minRps: 1 };
    for (const unknown of [null, undefined, NaN, { status: 'unsupported', value: null, reason: 'no collector', source: null }])
    {
        const evaluated = evaluateLoadProfileThresholds({ p95Ms: unknown, p99Ms: unknown, errorRate: unknown, timeoutRate: unknown, rps: unknown }, thresholds);
        assert.equal(evaluated.status, 'fail');
        assert.ok(evaluated.checks.every((check) => check.status === 'fail'));
    }
});


test('typed exception observations refuse invented exceptions, cause cycles and message-based classification', () =>
{
    assert.throws(() => observeLoadTransportError({ name: 'Error', code: 'invented' }, 'transport'), /actual exception/u);
    const cyclic = new Error('actual cycle');
    cyclic.cause = cyclic;
    assert.throws(() => observeLoadTransportError(cyclic, 'transport'), /cause chain contains a cycle/u);
    const error = observeLoadTransportError(new Error('timeout text alone is irrelevant'), 'transport');
    assert.equal(error.origin, 'transport');
    assert.equal(error.code, null);
});


test('terminal response reader refuses unknown bytes and status instead of inferring zeros from the route failure', () =>
{
    const facts = { httpStatus: { status: 'ok', value: 200, source: 'node:http.IncomingMessage.statusCode' },
        contentType: { status: 'ok', value: 'application/octet-stream', source: 'node:http.IncomingMessage.headers.content-type' },
        bytesReceived: { status: 'ok', value: 8, unit: 'bytes', source: 'node:http.IncomingMessage.data' }, bodyState: 'partial' };
    const raw = { status: 0, bodyBytes: 0, contentType: null, frameType: null, ok: false };
    assert.deepEqual(readLoadTransportResponseFacts(facts, raw), { httpStatus: 200, bytes: 8, contentType: 'application/octet-stream', frameType: null });
    assert.throws(() => readLoadTransportResponseFacts({ ...facts, bytesReceived: { ...facts.bytesReceived, value: null } }, raw), /actual delivered byte count/u);
    assert.throws(() => readLoadTransportResponseFacts({ ...facts, httpStatus: { status: 'unavailable', value: null, reason: 'headers-lost', source: facts.httpStatus.source } }, raw), /actual HTTP status/u);
    assert.throws(() => readLoadTransportResponseFacts({ ...facts, bodyState: 'not-started' }, raw), /no-response sentinel/u);
    assert.throws(() => readLoadTransportResponseFacts({ ...facts, bodyState: 'complete' }, raw), /differs from actual route/u);
});
