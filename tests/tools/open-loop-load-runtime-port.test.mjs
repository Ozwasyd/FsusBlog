import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url).href);
const { readLoadArrivalPolicy } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url).href);
const { fetchRouteSample, producerRouteIds } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url).href);
const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule } = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);

function policy(changes = {})
{
    return { schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'fixture', durationMs: 200,
        arrivalModel: 'constant', plannedRequestsPerSecond: 20, burstWindows: [], maximumInFlight: 10,
        requestTimeoutMs: 1000, routeMix: [{ routeId: 'system-seo', weight: 1 }], scheduleSeed: 'fixture-seed',
        qualificationWindowMs: 100, offeredRateTolerance: 0, ...changes };
}

async function serverFixture(t, responseDelayMs)
{
    let requests = 0;
    const timers = new Set();
    const server = http.createServer((request, response) =>
    {
        requests += 1;
        const timer = setTimeout(() =>
        {
            timers.delete(timer);
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(new Uint8Array(encodeAedsFrame(13, new Uint8Array(16))));
        }, responseDelayMs);
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
    return { baseUrl, requestCount: () => requests,
        request: (arrival, { signal, requestTimeoutMs }) => fetchRouteSample({
            routeId: arrival.routeId, baseUrl, timeoutMs: requestTimeoutMs,
            fetchImpl: (url, options) => fetch(url, { ...options,
                signal: AbortSignal.any([signal, options.signal]) })
        }) };
}

test('real HTTP responses at ten and five hundred milliseconds cannot change planned arrivals', async (t) =>
{
    const fast = await serverFixture(t, 10);
    const slow = await serverFixture(t, 500);
    const schedule = buildOpenLoopLoadSchedule(policy(), ['system-seo']);
    const fastResult = await dispatchOpenLoopLoadSchedule(schedule, { request: fast.request });
    const slowResult = await dispatchOpenLoopLoadSchedule(schedule, { request: slow.request });
    assert.equal(fast.requestCount(), 4);
    assert.equal(slow.requestCount(), 4);
    assert.deepEqual(fastResult.timeline.records.map((row) => row.plannedAtMs), slowResult.timeline.records.map((row) => row.plannedAtMs));
    assert.deepEqual(slowResult.timeline.records.map((row) => row.plannedAtMs), [0, 50, 100, 150]);
    assert.ok(slowResult.timeline.records[1].dispatchedAtMs < slowResult.timeline.records[0].completedAtMs);
    assert.ok(slowResult.timeline.records.every((row) => row.sample.ok && row.sample.contractDigest));
    assert.equal(slowResult.validation.qualificationEligible, false);
});

test('real slow HTTP plus maximum in flight retains explicit backpressure drops', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const schedule = buildOpenLoopLoadSchedule(policy({ maximumInFlight: 1 }), ['system-seo']);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request });
    assert.equal(fixture.requestCount(), 1);
    assert.equal(result.validation.counts.dispatched, 1);
    assert.equal(result.validation.counts.dropped, 3);
    assert.equal(result.timeline.records.filter((row) => row.failureKind === 'generator-backpressure-drop').length, 3);
    assert.equal(result.validation.passed, false);
});

test('real HTTP cancellation retains unsent plan members and settles the active request', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const schedule = buildOpenLoopLoadSchedule(policy(), ['system-seo']);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request, signal: controller.signal });
    clearTimeout(timer);
    assert.equal(result.timeline.records.length, 4);
    assert.equal(result.validation.counts.cancelled, 4);
    assert.equal(result.validation.counts.dispatched, 1);
    assert.equal(result.validation.passed, false);
    assert.ok(result.timeline.observedActiveWindowMs < schedule.policy.durationMs);
    assert.ok(result.timeline.records.slice(1).every((row) => row.sample === null && row.completedAtMs === null));
});

test('real HTTP timeout is classified from the settled route oracle result', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 100, qualificationWindowMs: 100,
        plannedRequestsPerSecond: 10, requestTimeoutMs: 30 }), ['system-seo']);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: fixture.request });
    assert.equal(result.validation.counts.timedOut, 1);
    assert.equal(result.timeline.records[0].sample.failureKind, 'timeout');
    assert.equal(result.timeline.records[0].sample.ok, false);
    assert.equal(result.validation.qualificationEligible, false);
});

test('canonical policy port requires explicit offered arrival declarations without inferred defaults', () =>
{
    assert.throws(() => readLoadArrivalPolicy('expected-peak'), /requires one explicit arrivalPolicy/u);
    assert.throws(() => readLoadArrivalPolicy('burst'), /requires one explicit arrivalPolicy/u);
    const arrival = policy({ profileId: 'expected-peak', plannedRequestsPerSecond: 40, routeMix: producerRouteIds('runtime-load-soak').map((routeId) => ({ routeId, weight: 1 })) });
    const text = `loadProfiles:\n  expected-peak:\n    durationMs: 200\n    arrivalPolicy: ${JSON.stringify(arrival)}\n`;
    assert.equal(readLoadArrivalPolicy('expected-peak', { policyText: text }).durationMs, 200);
    assert.throws(() => readLoadArrivalPolicy('expected-peak', { policyText: text.replace('durationMs: 200', 'durationMs: 300') }), /duration differs/u);
    assert.throws(() => readLoadArrivalPolicy('expected-peak', { policyText: text + `    arrivalPolicy: ${JSON.stringify(arrival)}\n` }), /one explicit/u);
});

test('canonical expected peak and burst commands refuse the current incomplete policy before any HTTP or receipt', async (t) =>
{
    const fixture = await serverFixture(t, 0);
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-load-arrival-source-'));
    t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
    for (const profile of ['expected-peak', 'burst'])
    {
        const outFile = path.join(outputRoot, `${profile}.json`);
        const child = spawn(process.execPath, ['tools/test/lanes/runtime-evidence-probe.mjs', 'load-profile', profile, outFile], {
            cwd: path.resolve(import.meta.dirname, '../..'),
            env: { FSUSBLOG_RELEASE_RELIABILITY_INVOCATION_ID: 'source-fixture', FSUSBLOG_BASE_URL: fixture.baseUrl },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', (chunk) =>
        {
            stderr += chunk;
        });
        const exit = await new Promise((resolve, reject) =>
        {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        assert.equal(exit, 1);
        assert.match(stderr, /requires one explicit arrivalPolicy/u);
        assert.equal(fs.existsSync(outFile), false);
    }
    await delay(10);
    assert.equal(fixture.requestCount(), 0);
});
