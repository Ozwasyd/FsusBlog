import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { buildResourceMetric } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url));
const { fetchRouteSample } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url));
const { createLoadExecutionPlan, loadWindowFailures, runLoadWindow } = await import(new URL('../../tools/test/load-profile-window.mjs', import.meta.url));
const { calculateLoadSampleMetrics, normalizeLoadResourceObservability } = await import(new URL('../../tools/test/load-sample-metrics.mjs', import.meta.url));
const { startResourceSampling } = await import(new URL('../../tools/test/runtime-resource-sampling.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url));
const { buildScenarioChildEnvironment, loadCatalog } = await import(new URL('../../tools/test/run-release-reliability-scenarios.mjs', import.meta.url));

async function fixture(context)
{
    let requests = 0;
    let inFlight = 0;
    let peak = 0;
    const server = http.createServer(async (request, response) =>
    {
        requests += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        response.once('close', () =>
        {
            inFlight -= 1;
        });
        const mode = new URL(request.url, 'http://127.0.0.1').searchParams.get('mode');
        if (mode === 'reset')
        {
            request.socket.destroy();
            return;
        }
        if (mode === 'partial')
        {
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.write(new Uint8Array([1, 2, 3, 4]));
            await delay(100);
            response.end();
            return;
        }
        await delay(mode === 'slow' ? 100 : 25);
        response.writeHead(mode === 'error' ? 500 : 200, { 'content-type': 'application/octet-stream' });
        response.end(new Uint8Array(encodeAedsFrame(13, new Uint8Array(16))));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return { baseUrl: `http://127.0.0.1:${server.address().port}`,
        counts: () => ({ requests, inFlight, peak }) };
}

function execution(runtime, overrides = {})
{
    return {
        plan: createLoadExecutionPlan({ concurrency: 4, rounds: 1, durationMs: 180 }, ['system-seo']),
        pathForRoute: () => '/api/binary/system/seo',
        verifyIdentity: async () => ({ ownedFixture: runtime.baseUrl }),
        request: (routeId, { signal }) => fetchRouteSample({ routeId, baseUrl: runtime.baseUrl,
            timeoutMs: 500, signal }),
        ...overrides
    };
}

test('real monotonic window keeps dispatching, closes deadline, and drains without new requests', async (context) =>
{
    const runtime = await fixture(context);
    const result = await runLoadWindow(execution(runtime));
    assert.equal(result.status, 'ok', result.failureReasons.join(';'));
    assert.ok(result.samples.length > 4);
    assert.equal(result.samples.length, runtime.counts().requests);
    assert.equal(result.window.peakInFlight, 4);
    assert.equal(runtime.counts().peak, 4);
    assert.ok(result.window.observedActiveWindowMs >= 180);
    assert.ok(result.samples.some((s) => s.finishedMonotonicMs > result.window.deadline));
    assert.ok(result.dispatches.every((d) => d.startedMonotonicMs < result.window.deadline));
    assert.deepEqual(loadWindowFailures(result), []);
});

test('barrier waits for identity confirmation and wall-clock reversal cannot shorten the window', async (context) =>
{
    const runtime = await fixture(context);
    let confirmed;
    let calls = 0;
    const oldDateNow = Date.now;
    Date.now = () => -100000;
    try
    {
        const result = await runLoadWindow(execution(runtime, { verifyIdentity: async () =>
        {
            calls += 1;
            await delay(30);
            confirmed ??= performance.now();
            return { stable: true };
        } }));
        assert.equal(result.status, 'ok');
        assert.equal(calls, 2);
        assert.ok(result.window.measurementStart >= confirmed);
        assert.ok(result.window.workers.every((w) => w.readyMonotonicMs <= result.window.measurementStart));
        assert.ok(result.window.observedActiveWindowMs >= 180);
    }
    finally
    {
        Date.now = oldDateNow;
    }
});

test('slow requests are drained but insufficient per-worker rounds fail without extending dispatch', async (context) =>
{
    const runtime = await fixture(context);
    const options = execution(runtime);
    options.plan = createLoadExecutionPlan({ concurrency: 4, rounds: 100, durationMs: 180 }, ['system-seo']);
    const result = await runLoadWindow(options);
    assert.equal(result.status, 'failed');
    assert.ok(result.failureReasons.includes('load-minimum-completed-requests-not-reached'));
    assert.ok(result.dispatches.every((d) => d.startedMonotonicMs < result.window.deadline));
    assert.ok(result.window.observedActiveWindowMs < 1000);
});

test('outer cancellation records cancelled requests, closes promptly, and cannot become timeout success', async (context) =>
{
    const runtime = await fixture(context);
    const cancellation = new AbortController();
    const timer = setTimeout(() => cancellation.abort(), 45);
    context.after(() => clearTimeout(timer));
    const result = await runLoadWindow(execution(runtime, { signal: cancellation.signal,
        request: (routeId, { signal }) => fetchRouteSample({ routeId, baseUrl: runtime.baseUrl,
            requestPath: '/api/binary/system/seo?mode=slow', timeoutMs: 500, signal }) }));
    assert.equal(result.status, 'failed');
    assert.ok(result.calculated.cancelledCount > 0);
    assert.equal(result.calculated.timeoutCount, 0);
    assert.ok(result.window.observedActiveWindowMs < 180);
    assert.equal(result.expectedRequests.length, result.samples.length);
});

test('generator budget fails with full dispatched membership instead of claiming a short window pass', async (context) =>
{
    const runtime = await fixture(context);
    const result = await runLoadWindow(execution(runtime, { maxRequests: 5 }));
    assert.equal(result.status, 'failed');
    assert.ok(result.failureReasons.includes('load-generator-sample-budget-exhausted'));
    assert.equal(result.dispatches.length, 5);
    assert.equal(result.samples.length, 5);
});

test('cancellation before the worker barrier sends no requests and never fabricates empty zero rates', async (context) =>
{
    const runtime = await fixture(context);
    const cancellation = new AbortController();
    cancellation.abort();
    const result = await runLoadWindow(execution(runtime, { signal: cancellation.signal }));
    assert.equal(result.status, 'failed');
    assert.equal(result.samples.length, 0);
    assert.equal(runtime.counts().requests, 0);
    assert.equal(result.calculated.errorRate, null);
    assert.equal(result.calculated.timeoutRate, null);
});

test('unexpected producer failure retains partial evidence and an independent missing-member ledger', async (context) =>
{
    const runtime = await fixture(context);
    let calls = 0;
    const original = execution(runtime);
    const result = await runLoadWindow({ ...original, request: async (...args) =>
    {
        calls += 1;
        if (calls === 6)
        {
            throw new TypeError('collector bug');
        }
        return original.request(...args);
    } });
    assert.equal(result.status, 'failed');
    assert.ok(result.expectedRequests.length > result.samples.length);
    assert.ok(result.samples.length > 0);
    assert.equal(result.calculated, null);
});

test('identity change fails the complete window without losing settled samples', async (context) =>
{
    const runtime = await fixture(context);
    let identity = 0;
    const result = await runLoadWindow(execution(runtime, { verifyIdentity: () => ({ generation: identity++ }) }));
    assert.equal(result.status, 'failed');
    assert.ok(result.failureReasons.includes('load-runtime-identity-changed'));
    assert.equal(result.expectedRequests.length, result.samples.length);
});

test('real HTTP, timeout, reset and partial-body failure preserve typed outcomes and response facts', async (context) =>
{
    const runtime = await fixture(context);
    for (const [mode, outcome, timeoutMs] of [['error', 'http-error', 500], ['slow', 'timeout', 35],
        ['reset', 'network-error', 500], ['partial', 'timeout', 35]])
    {
        const sample = await fetchRouteSample({ routeId: 'system-seo', baseUrl: runtime.baseUrl,
            requestPath: `/api/binary/system/seo?mode=${mode}`, timeoutMs });
        assert.equal(sample.outcome, outcome, mode);
        assert.match(sample.errorDigest, /^sha256:[0-9a-f]{64}$/u);
        if (mode === 'partial')
        {
            assert.equal(sample.status, 200);
            assert.equal(sample.bodyBytes, 4);
        }
        if (mode === 'reset')
        {
            assert.notEqual(sample.errorCode, null);
        }
    }
});

test('resource curve retains intermediate peaks and explicit failed reads; delta threshold is unchanged', async () =>
{
    let value = 10;
    const sampler = startResourceSampling(() => ({ status: 'ok', value, source: 'owned-test-process' }), 10);
    value = 100;
    await delay(30);
    value = 15;
    const readings = sampler.stop();
    const result = buildResourceMetric({ name: 'rss', unit: 'bytes', threshold: 6,
        thresholdKind: 'max_delta_bytes' }, { pid: process.pid, source: 'owned-test-process' }, readings);
    assert.equal(result.metric.maxValue, 100);
    assert.equal(result.metric.delta, 5);
    assert.equal(result.metric.status, 'ok');
    assert.ok(result.metric.sampleCount > 2);
    readings[1] = { ...readings[1], status: 'probe-failed', reason: 'sampling refused' };
    assert.equal(buildResourceMetric({ name: 'rss' }, {}, readings).metric, null);
    assert.throws(() => normalizeLoadResourceObservability({ cpuPercent: null }));
    assert.throws(() => normalizeLoadResourceObservability({ rssBytes: { status: 'ok', value: null, unit: 'bytes', source: 'fixture' } }));
    assert.equal(normalizeLoadResourceObservability().rssBytes.status, 'unavailable');
});

test('canonical metrics reject dropped failure samples and keep error/timeout denominators exact', () =>
{
    const samples = Array.from({ length: 100 }, (_, sequence) => ({
        sampleId: `worker-0:${sequence}`, workerId: 'worker-0', sequence, path: '/fixture',
        startedMonotonicMs: sequence, finishedMonotonicMs: sequence + 1, durationMs: 1,
        outcome: sequence === 99 ? 'http-error' : 'success', httpStatus: sequence === 99 ? 500 : 200,
        bytes: 1, contentType: 'application/octet-stream', frameType: 13,
        errorKind: sequence === 99 ? 'http-status' : null, errorCode: sequence === 99 ? 500 : null,
        errorDigest: sequence === 99 ? `sha256:${'a'.repeat(64)}` : null
    }));
    const expectedRequests = samples.map(({ sampleId, workerId, sequence, path }) => ({ sampleId, workerId, sequence, path }));
    assert.equal(calculateLoadSampleMetrics({ samples, expectedRequests, durationMs: 100 }).errorRate, 0.01);
    assert.throws(() => calculateLoadSampleMetrics({ samples: samples.slice(0, -1), expectedRequests }));
    samples[99] = { ...samples[99], outcome: 'timeout', httpStatus: 0, bytes: 0, contentType: null,
        frameType: null, errorKind: 'timeout', errorCode: null };
    assert.equal(calculateLoadSampleMetrics({ samples, expectedRequests, durationMs: 100 }).timeoutRate, 0.01);
    assert.throws(() => calculateLoadSampleMetrics({ samples: [samples[0], samples[0]], expectedRequests }));
});

test('actual child environment admission rejects ambient duration override before producer spawn', async (context) =>
{
    const catalog = loadCatalog();
    const scenario = catalog.scenarios.find((s) => s.id === 'release-load-peak');
    assert.throws(() => buildScenarioChildEnvironment({ catalog, scenario,
        ambientEnvironment: { FSUSBLOG_LOAD_PROFILE_DURATION_MS: '1' } }), /before producer spawn/u);
    const runtime = await fixture(context);
    const child = spawn(process.execPath, [new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url).pathname,
        'load-profile', 'expected-peak', '/tmp/rejected-load-no-summary.json'],
    { env: { ...process.env, FSUSBLOG_BASE_URL: runtime.baseUrl, FSUSBLOG_LOAD_PROFILE_DURATION_MS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', (data) =>
    {
        stderr += data;
    });
    const code = await new Promise((resolve, reject) =>
    {
        child.once('error', reject);
        child.once('exit', resolve);
    });
    assert.equal(code, 1);
    assert.match(stderr, /before dispatch/u);
    assert.equal(runtime.counts().requests, 0);
});
