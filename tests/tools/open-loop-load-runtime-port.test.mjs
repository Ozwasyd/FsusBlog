import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url).href);
const { readLoadArrivalPolicy, readLoadGeneratorPolicy, readLoadRouteStatisticsPolicy, readLoadTransportPolicy, runOpenLoopLoadGeneratorProbe, runOpenLoopRouteContractProbe } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url).href);
const { fetchRouteSample, producerRouteIds, routeContract } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url).href);
const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule } = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);
const { createOpenLoopLoadClientTransport } = await import(new URL('../../tools/test/open-loop-load-client-transport.mjs', import.meta.url).href);
const { loadGeneratorMetricNames } = await import(new URL('../../tools/test/open-loop-load-generator-observations.mjs', import.meta.url).href);
const { observeLoadIssuer } = await import(new URL('../../tools/test/load-request-observations.mjs', import.meta.url).href);
const { digestCanonical } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url).href);

function fixtureWorkerRegistration()
{
    const issuer = observeLoadIssuer();
    return { workerId: String(issuer.threadId), issuer };
}

function transportPolicy(changes = {})
{
    return { transportId: 'source-http', nodeVersion: process.versions.node, clientLibrary: 'node:http',
        clientVersion: process.versions.node, httpVersion: '1.1', allowH2: false, maxConnectionsPerOrigin: 10,
        maxPipelining: 1, keepAliveTimeoutMs: 1000, connectTimeoutMs: 1000, headersTimeoutMs: 1000,
        bodyTimeoutMs: 1000, connectionReusePolicy: 'keep-alive', dnsMode: 'literal',
        dnsResult: [{ address: '127.0.0.1', family: 4 }], proxyMode: 'direct-no-ambient', tlsPolicy: 'disabled-http', ...changes };
}

function fixtureRunBinding(endpoint)
{
    return { runId: 'source-fixture-run', invocationId: 'source-fixture-invocation', attemptId: 'source-fixture-attempt',
        backendOrigin: endpoint };
}

async function explicitTransportFixture(t, fixture)
{
    const transport = await createOpenLoopLoadClientTransport({ policy: transportPolicy(), endpoint: fixture.baseUrl,
        runBinding: fixtureRunBinding(fixture.baseUrl) });
    t.after(() => transport.close());
    return transport;
}

function policy(changes = {})
{
    return { schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'fixture', durationMs: 200,
        arrivalModel: 'constant', plannedRequestsPerSecond: 20, burstWindows: [], maximumInFlight: 10,
        requestTimeoutMs: 1000, routeMix: [{ routeId: 'system-seo', weight: 1 }], scheduleSeed: 'fixture-seed',
        qualificationWindowMs: 100, offeredRateTolerance: 0, ...changes };
}

async function serverFixture(t, responseDelayMs, responseFor = () => ({ frameType: 13 }))
{
    let requests = 0;
    const timers = new Set();
    const server = http.createServer((request, response) =>
    {
        requests += 1;
        const specification = responseFor(request);
        const timer = setTimeout(() =>
        {
            timers.delete(timer);
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(new Uint8Array(encodeAedsFrame(specification.frameType, new Uint8Array(16))));
        }, specification.delayMs ?? responseDelayMs);
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

function canonicalFixturePolicies()
{
    const routeIds = producerRouteIds('runtime-load-soak');
    const arrival = policy({ durationMs: 200, plannedRequestsPerSecond: 60, routeMix: routeIds.map((routeId) => ({ routeId, weight: 1 })) });
    const schedule = buildOpenLoopLoadSchedule(arrival, routeIds);
    const routePolicy = { schema: 'fsusblog.release-load-route-statistics-policy.v1', routes: routeIds.map((routeId) => ({
        routeId, minimumValidSamples: 1,
        thresholds: { latencyP95Ms: 1000, latencyP99Ms: 1000, latencyMaxMs: 1000, errorRate: 0, timeoutRate: 0, dropRate: 0 }
    })) };
    return { schedule, routePolicy, routeIds };
}

test('canonical per-route policy reader refuses absent global-only duplicate and incomplete budgets', () =>
{
    const { schedule, routePolicy } = canonicalFixturePolicies();
    const profile = schedule.policy.profileId;
    const prefix = `loadProfiles:\n  ${profile}:\n    durationMs: 200\n    maxP95Ms: 3000\n`;
    assert.throws(() => readLoadRouteStatisticsPolicy(profile, schedule, { policyText: prefix }), /one explicit routeStatisticsPolicy/u);
    const text = `${prefix}    routeStatisticsPolicy: ${JSON.stringify(routePolicy)}\n`;
    assert.equal(readLoadRouteStatisticsPolicy(profile, schedule, { policyText: text }).routes.length, 6);
    assert.throws(() => readLoadRouteStatisticsPolicy(profile, schedule, { policyText: text + `    routeStatisticsPolicy: ${JSON.stringify(routePolicy)}\n` }), /one explicit/u);
    const incomplete = structuredClone(routePolicy);
    delete incomplete.routes[0].thresholds.timeoutRate;
    assert.throws(() => readLoadRouteStatisticsPolicy(profile, schedule, { policyText: `${prefix}    routeStatisticsPolicy: ${JSON.stringify(incomplete)}\n` }), /exact explicit fields/u);
});

test('canonical open-loop callback gates route failure and propagates combined source identity from real HTTP', async (t) =>
{
    const { schedule, routePolicy, routeIds } = canonicalFixturePolicies();
    routePolicy.routes.find((route) => route.routeId === 'system-seo').thresholds = {
        latencyP95Ms: 10, latencyP99Ms: 10, latencyMaxMs: 10, errorRate: 0, timeoutRate: 0, dropRate: 0
    };
    const fixture = await serverFixture(t, 1, (request) =>
    {
        const routeId = routeIds.find((id) => routeContract(id).pathTemplate === request.url);
        assert.ok(routeId);
        return { frameType: routeContract(routeId).expectedAedsFrameType, delayMs: routeId === 'system-seo' ? 80 : 1 };
    });
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const collected = [];
    const measured = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('canonical open-loop used ambient fetch');
    t.after(() => globalThis.fetch = originalFetch);
    const probe = await runOpenLoopRouteContractProbe(schedule, { routePolicy, sourceSha, requestBaseUrl: fixture.baseUrl,
        transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(fixture.baseUrl), workerRegistration: fixtureWorkerRegistration(),
        onTransportObservation: (observation) => collected.push(observation),
        onMeasurementStart: (window) => measured.push(window), onMeasurementEnd: (window) => measured.push(window) });
    assert.equal(fixture.requestCount(), schedule.plannedCount);
    assert.equal(probe.failures.length, 0, 'all actual samples pass their unchanged payload oracle');
    assert.ok(probe.latencyMs.p99 < 3000, 'legacy global fixture budget passes');
    assert.equal(probe.status, 'failed', 'an independent route budget must defeat global success');
    assert.equal(probe.routeStatistics.routes.find((route) => route.routeId === 'system-seo').passed, false);
    assert.equal(probe.candidateIdentity, probe.candidateBinding.contentDigest);
    assert.equal(probe.requestAvailability.complete, true);
    assert.equal(probe.loadRequestObservations.sampleCount, schedule.plannedCount);
    assert.equal(probe.loadRequestObservations.errorRate, 0);
    assert.equal(probe.candidateBinding.loadRequestObservationsDigest, probe.loadRequestObservations.contentDigest);
    assert.equal(probe.candidateBinding.requestAvailabilityDigest, probe.requestAvailability.contentDigest);
    assert.equal(probe.candidateBinding.routeStatisticsIdentity, probe.routeStatistics.candidateIdentity);
    assert.equal(probe.candidateBinding.transportIdentityDigest, probe.transportEvidence.identity.contentDigest);
    assert.equal(probe.candidateBinding.transportEvidenceDigest, probe.transportEvidence.contentDigest);
    assert.equal(probe.candidateBinding.measurementWindowDigest, probe.measurementWindow.contentDigest);
    assert.equal(measured.length, 2);
    assert.equal(measured[0].startedMonotonicMs, probe.measurementWindow.startedMonotonicMs);
    assert.equal(measured[1].endedMonotonicMs, probe.measurementWindow.endedMonotonicMs);
    assert.equal(probe.measurementWindow.observedActiveWindowMs, probe.openLoop.timeline.observedActiveWindowMs);
    assert.equal(probe.measurementWindow.qualificationEligible, false);
    assert.ok(measured.every((window) => window.transportIdentity.contentDigest === probe.transportEvidence.identity.contentDigest));
    assert.equal(probe.candidateBinding.policyDigest, digestCanonical({ arrivalPolicyDigest: schedule.policyDigest,
        routePolicyDigest: probe.routeStatistics.routePolicyDigest, transportPolicyDigest: digestCanonical(transportPolicy()) }));
    assert.deepEqual(collected, probe.transportEvidence.observations, 'actual collector port receives the same bound event ledger');
    assert.equal(collected.at(-1).type, 'transport-closed');
    assert.deepEqual(probe.transportEvidence.finalSnapshot, { activeRequests: 0, socketCount: 0, freeSocketCount: 0, queuedRequests: 0, closed: true });
    assert.equal(probe.transportEvidence.requestTransports.length, schedule.plannedCount);
    assert.ok(probe.openLoop.timeline.records.every((record) => Object.keys(record.sample).length === 9));
    assert.equal(probe.routeStatistics.sourceSha, sourceSha);
    assert.equal(probe.baseUrl, fixture.baseUrl);
    assert.equal(probe.qualificationEligible, false);
});

test('canonical open-loop callback refuses incomplete route or source identity before HTTP', async (t) =>
{
    const fixture = await serverFixture(t, 0);
    const { schedule, routePolicy } = canonicalFixturePolicies();
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { routePolicy, sourceSha: 'missing', requestBaseUrl: fixture.baseUrl }), /full source SHA before HTTP/u);
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { routePolicy: {}, sourceSha: 'missing', requestBaseUrl: fixture.baseUrl }), /exact explicit fields/u);
    assert.equal(fixture.requestCount(), 0);
});

test('canonical transport policy and caller binding refuse missing authority and unsupported timeouts before HTTP', async (t) =>
{
    const fixture = await serverFixture(t, 0);
    const { schedule, routePolicy, routeIds } = canonicalFixturePolicies();
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const options = { routePolicy, sourceSha, requestBaseUrl: fixture.baseUrl, transportPolicy: transportPolicy(),
        runBinding: fixtureRunBinding(fixture.baseUrl), workerRegistration: fixtureWorkerRegistration() };
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { ...options, workerRegistration: undefined }), /held load worker registration/u);
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { ...options, transportPolicy: undefined }), /every explicit field/u);
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { ...options, runBinding: {} }), /run binding/u);
    await assert.rejects(runOpenLoopRouteContractProbe(schedule, { ...options, runBinding: fixtureRunBinding('http://127.0.0.1:1') }), /run binding/u);
    const oversized = buildOpenLoopLoadSchedule({ ...schedule.policy, requestTimeoutMs: 60_001 }, routeIds);
    await assert.rejects(runOpenLoopRouteContractProbe(oversized, options), /supported request timeout/u);
    const text = `loadProfiles:\n  fixture:\n    transportPolicy: ${JSON.stringify(transportPolicy())}\n`;
    assert.deepEqual(readLoadTransportPolicy('fixture', { policyText: text }), transportPolicy());
    assert.throws(() => readLoadTransportPolicy('fixture', { policyText: 'loadProfiles:\n  fixture:\n' }), /one explicit transportPolicy/u);
    assert.equal(fixture.requestCount(), 0);
});

test('explicit client observes scheduler deadline as timeout and outer cancellation as cancellation', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const transport = await explicitTransportFixture(t, fixture);
    const timeoutSchedule = buildOpenLoopLoadSchedule(policy({ durationMs: 100, qualificationWindowMs: 100,
        plannedRequestsPerSecond: 10, requestTimeoutMs: 30 }), ['system-seo']);
    const deadline = await dispatchOpenLoopLoadSchedule(timeoutSchedule, { request: transport.request });
    assert.equal(deadline.validation.counts.timedOut, 1);
    assert.equal(deadline.validation.counts.cancelled, 0);
    assert.equal(deadline.timeline.records[0].sample.transportFailureStage, 'request-timeout');
    assert.equal(deadline.timeline.records[0].sample.failureKind, 'timeout');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('fixture caller cancellation')), 30);
    t.after(() => clearTimeout(timer));
    const cancelled = await dispatchOpenLoopLoadSchedule(buildOpenLoopLoadSchedule(policy(), ['system-seo']), {
        request: transport.request, signal: controller.signal
    });
    assert.equal(cancelled.validation.counts.cancelled, 4);
    assert.equal(cancelled.validation.counts.timedOut, 0);
    assert.equal(cancelled.timeline.records[0].sample.failureKind, 'cancelled');
    assert.equal(cancelled.timeline.records[0].sample.transportFailureStage, 'aborted');
    assert.ok(cancelled.timeline.records.slice(1).every((record) => record.sample === null));
    await transport.close();
    assert.deepEqual(transport.snapshot(), { activeRequests: 0, socketCount: 0, freeSocketCount: 0, queuedRequests: 0, closed: true });
});

test('late caller cancellation cannot rewrite an earlier actual transport deadline before adapter settlement', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const transport = await explicitTransportFixture(t, fixture);
    const controller = new AbortController();
    const schedule = buildOpenLoopLoadSchedule(policy({ durationMs: 100, qualificationWindowMs: 100,
        plannedRequestsPerSecond: 10, requestTimeoutMs: 30 }), ['system-seo']);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { signal: controller.signal,
        request: async (arrival, options) =>
        {
            const sample = await transport.request(arrival, options);
            if (!options.signal.aborted)
            {
                await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
            }
            assert.equal(options.signal.reason.transportStage, 'request-timeout');
            controller.abort(new Error('caller cancellation after deadline settlement'));
            return sample;
        } });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.validation.counts.timedOut, 1);
    assert.equal(result.validation.counts.cancelled, 0);
    assert.equal(result.timeline.records[0].failureKind, 'timeout');
    assert.equal(result.timeline.records[0].sample.transportFailureStage, 'request-timeout');
    assert.equal(result.validation.passed, false);
});

test('canonical interrupted flow retains complete membership and actual post-cleanup transport evidence', async (t) =>
{
    const { schedule, routePolicy } = canonicalFixturePolicies();
    const fixture = await serverFixture(t, 500);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    t.after(() => clearTimeout(timer));
    const probe = await runOpenLoopRouteContractProbe(schedule, { routePolicy,
        sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), requestBaseUrl: fixture.baseUrl,
        transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(fixture.baseUrl), workerRegistration: fixtureWorkerRegistration(), signal: controller.signal });
    assert.equal(probe.status, 'failed');
    assert.equal(probe.requestAvailability.complete, true);
    assert.equal(probe.loadRequestObservations.outcomeCounts.cancelled, probe.openLoop.validation.counts.dispatched);
    assert.equal(probe.loadRequestObservations.completed, 0);
    assert.equal(probe.loadRequestObservations.timeoutRate, null);
    assert.equal(probe.loadRequestObservations.observationsComplete, false);
    assert.equal(probe.openLoop.timeline.records.length, schedule.plannedCount);
    assert.equal(probe.openLoop.validation.counts.cancelled, schedule.plannedCount);
    assert.equal(probe.transportEvidence.requestTransports.length, probe.openLoop.validation.counts.dispatched);
    assert.equal(probe.transportEvidence.observations.at(-1).type, 'transport-closed');
    assert.deepEqual(probe.transportEvidence.finalSnapshot, { activeRequests: 0, socketCount: 0, freeSocketCount: 0, queuedRequests: 0, closed: true });
    assert.equal(probe.candidateBinding.runtimeLeaseVerified, false);
    assert.equal(probe.candidateBinding.qualificationEligible, false);
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


test('canonical callback retains actual pre-header reset and partial response status and bytes', async (t) =>
{
    for (const partialStatus of [null, 200, 500])
    {
        const partial = partialStatus !== null;
        const server = http.createServer((request, response) =>
        {
            if (!partial)
            {
                request.socket.destroy();
                return;
            }
            response.writeHead(partialStatus, { 'content-type': 'application/octet-stream' });
            response.write(new Uint8Array(8));
            setTimeout(() => response.destroy(), 10);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        t.after(async () =>
        {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });
        const endpoint = `http://127.0.0.1:${server.address().port}`;
        const { schedule, routePolicy } = canonicalFixturePolicies();
        const probe = await runOpenLoopRouteContractProbe(schedule, { routePolicy,
            sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), requestBaseUrl: endpoint,
            transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(endpoint), workerRegistration: fixtureWorkerRegistration() });
        assert.equal(probe.status, 'failed');
        assert.equal(probe.requestAvailability.complete, true);
        assert.equal(probe.requestAvailability.expectedRequests.length, schedule.plannedCount);
        assert.equal(probe.requestAvailability.unavailableSamples.length, 0);
        assert.equal(probe.loadRequestObservations.sampleCount, schedule.plannedCount);
        const outcome = partialStatus === 500 ? 'http-error' : 'network-error';
        assert.equal(probe.loadRequestObservations.outcomeCounts[outcome], schedule.plannedCount);
        assert.equal(probe.loadRequestObservations.errorRate, 1);
        assert.equal(probe.loadRequestObservations.timeoutRate, 0);
        assert.ok(probe.loadRequestObservations.samples.every((sample) => sample.errorCode === 'ECONNRESET'
            && sample.httpStatus === (partialStatus ?? 0) && sample.bytes === (partial ? 8 : 0)));
        assert.ok(probe.transportEvidence.observations.filter((event) => event.type === 'request-completed')
            .every((event) => event.responseFacts.bodyState === (partial ? 'partial' : 'not-started')));
        assert.equal(probe.transportEvidence.finalSnapshot.closed, true);
        assert.equal(probe.transportEvidence.finalSnapshot.activeRequests, 0);
    }
});


test('canonical actual dispatcher deadline retains typed provenance and counts every dispatched timeout', async (t) =>
{
    const fixture = await serverFixture(t, 500);
    const { schedule: original, routePolicy, routeIds } = canonicalFixturePolicies();
    const schedule = buildOpenLoopLoadSchedule({ ...original.policy, requestTimeoutMs: 30 }, routeIds);
    const probe = await runOpenLoopRouteContractProbe(schedule, { routePolicy,
        sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), requestBaseUrl: fixture.baseUrl,
        transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(fixture.baseUrl), workerRegistration: fixtureWorkerRegistration() });
    assert.equal(probe.requestAvailability.complete, true);
    assert.equal(probe.loadRequestObservations.completed, probe.openLoop.validation.counts.dispatched);
    assert.equal(probe.loadRequestObservations.outcomeCounts.timeout, probe.openLoop.validation.counts.dispatched);
    assert.equal(probe.loadRequestObservations.timeoutRate, 1);
    assert.equal(probe.loadRequestObservations.errorRate, 0);
    assert.ok(probe.loadRequestObservations.samples.every((sample) => sample.outcome === 'timeout' && sample.errorKind === 'dispatcher-deadline'));
    assert.equal(probe.status, 'failed');
    assert.equal(probe.candidateBinding.qualificationEligible, false);
});


function fixtureGeneratorPolicy(maximumGeneratorCpuPercent = 10000)
{
    const metrics = Object.fromEntries(loadGeneratorMetricNames.map((metric) => [metric, { classification: 'diagnostic-only' }]));
    metrics.generatorCpuPercent = { classification: 'qualification-required', maximum: maximumGeneratorCpuPercent };
    metrics.scheduleLagP99Ms = { classification: 'qualification-required', maximum: 500 };
    return { schema: 'fsusblog.load-generator-observation-policy.v1', samplingIntervalMs: 80,
        eventLoopResolutionMs: 2, maximumSampleDelayMs: 75, maximumBoundaryDelayMs: 20,
        maximumGeneratorCpuPercent, maximumGeneratorScheduleLagP99Ms: 500, metrics };
}

async function separateGeneratorBackendFixture(t, sourceSha, mode)
{
    const routes = Object.fromEntries(producerRouteIds('runtime-load-soak').map((id) =>
    {
        const route = routeContract(id);
        return [route.pathTemplate, Buffer.from(encodeAedsFrame(route.expectedAedsFrameType, new Uint8Array(16))).toString('base64')];
    }));
    const script = `
        import http from 'node:http';
        const config = JSON.parse(process.argv[1]);
        const timers = new Set();
        const server = http.createServer((request, response) => {
            if (config.mode === 'reset') { request.socket.destroy(); return; }
            const timer = setTimeout(() => {
                timers.delete(timer);
                response.writeHead(200, { 'content-type': 'application/octet-stream' });
                response.end(Buffer.from(config.routes[request.url], 'base64'));
            }, config.mode === 'slow' ? 100 : 1);
            timers.add(timer);
            response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        });
        server.listen(0, '127.0.0.1', () => process.send({ pid: process.pid, port: server.address().port }));
        process.on('message', () => {
            for (const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            server.close(() => process.exit(0));
        });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ routes, mode })],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => stderr += chunk);
    const startupTimer = setTimeout(() => child.kill(), 3000);
    t.after(async () =>
    {
        clearTimeout(startupTimer);
        if (child.exitCode !== null || child.signalCode !== null)
        {
            return;
        }
        const exited = new Promise((resolve) => child.once('exit', resolve));
        const timer = setTimeout(() => child.kill(), 2000);
        child.send('close');
        await exited;
        clearTimeout(timer);
    });
    const ready = await new Promise((resolve, reject) =>
    {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`fixture backend exited: ${stderr}`)));
    });
    clearTimeout(startupTimer);
    assert.equal(ready.pid, child.pid);
    assert.notEqual(ready.pid, process.pid);
    return { endpoint: `http://127.0.0.1:${ready.port}`, backendIdentity: { pid: ready.pid, sourceSha } };
}

async function actualGeneratorProbe(t, { mode = 'fast', maximumCpu = 10000, signal } = {})
{
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const fixture = await separateGeneratorBackendFixture(t, sourceSha, mode);
    const { schedule: original, routePolicy, routeIds } = canonicalFixturePolicies();
    const schedule = buildOpenLoopLoadSchedule({ ...original.policy, durationMs: 320, qualificationWindowMs: 160 }, routeIds);
    if (mode === 'slow')
    {
        routePolicy.routes.forEach((route) => Object.assign(route.thresholds, { latencyP95Ms: 20, latencyP99Ms: 20, latencyMaxMs: 20 }));
    }
    const probe = await runOpenLoopLoadGeneratorProbe(schedule, { sourceSha, routePolicy,
        requestBaseUrl: fixture.endpoint, transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(fixture.endpoint),
        workerRegistration: fixtureWorkerRegistration(), generatorPolicy: fixtureGeneratorPolicy(maximumCpu),
        backendIdentity: fixture.backendIdentity, signal });
    return { probe, schedule, fixture };
}

test('canonical generator policy requires explicit seventeen classifications and both mandatory maxima', () =>
{
    const policy = fixtureGeneratorPolicy();
    const text = `loadProfiles:\n  fixture:\n    generatorObservationPolicy: ${JSON.stringify(policy)}\n`;
    assert.deepEqual(readLoadGeneratorPolicy('fixture', { policyText: text }), policy);
    assert.throws(() => readLoadGeneratorPolicy('fixture', { policyText: 'loadProfiles:\n  fixture:\n' }), /one explicit generatorObservationPolicy/u);
    assert.throws(() => readLoadGeneratorPolicy('fixture', { policyText: text + `    generatorObservationPolicy: ${JSON.stringify(policy)}\n` }), /one explicit/u);
    const incomplete = structuredClone(policy);
    delete incomplete.metrics.idleSockets;
    assert.throws(() => readLoadGeneratorPolicy('fixture', { policyText: `loadProfiles:\n  fixture:\n    generatorObservationPolicy: ${JSON.stringify(incomplete)}\n` }), /exact explicit fields/u);
});

test('canonical generator integration binds actual process intervals and Agent ledger without backend substitution', async (t) =>
{
    const { probe, schedule, fixture } = await actualGeneratorProbe(t);
    assert.equal(probe.generatorEvidence.status, 'observed');
    assert.equal(probe.generatorEvidence.validation.generatorPassed, true);
    assert.equal(probe.generatorEvidence.validation.qualificationEligible, false);
    const receipt = probe.generatorEvidence.observations;
    assert.equal(receipt.identity.pid, process.pid);
    assert.equal(receipt.identity.backendIdentity.pid, fixture.backendIdentity.pid);
    assert.ok(receipt.samples.length >= 5);
    assert.ok(receipt.intervals.every((interval) => interval.metrics.generatorRssBytes > 0));
    assert.ok(loadGeneratorMetricNames.every((metric) => Number.isFinite(receipt.metrics[metric])));
    assert.deepEqual(receipt.events, probe.transportEvidence.observations);
    assert.equal(probe.loadRequestObservations.sampleCount, schedule.plannedCount);
    assert.equal(probe.candidateBinding.generatorEvidenceDigest, probe.generatorEvidence.contentDigest);
    assert.equal(probe.candidateBinding.generatorIdentityDigest, receipt.identity.contentDigest);
    assert.equal(probe.generatorEvidence.runtimeLeaseVerified, false);
    assert.equal(probe.status, 'ok');
});

test('canonical generator saturation and slow-server route failure preserve separate measured origins', async (t) =>
{
    const saturated = await actualGeneratorProbe(t, { maximumCpu: 0 });
    assert.equal(saturated.probe.generatorEvidence.validation.failureKind, 'infra.load-generator-saturated');
    assert.equal(saturated.probe.serverProbeStatus, 'ok');
    assert.equal(saturated.probe.status, 'failed');
    const slow = await actualGeneratorProbe(t, { mode: 'slow' });
    assert.equal(slow.probe.generatorEvidence.validation.generatorPassed, true);
    assert.equal(slow.probe.generatorEvidence.validation.failureKind, null);
    assert.equal(slow.probe.serverProbeStatus, 'failed');
    assert.equal(slow.probe.status, 'failed');
});

test('canonical collector vocabulary gap and interruption retain requests and cleanup while failing qualification', async (t) =>
{
    const reset = await actualGeneratorProbe(t, { mode: 'reset' });
    assert.equal(reset.probe.generatorEvidence.status, 'probe-failed');
    assert.equal(reset.probe.generatorEvidence.validation.failureKind, 'infra.load-generator-collector-unavailable');
    assert.match(reset.probe.generatorEvidence.reason, /vocabulary/u);
    assert.equal(reset.probe.loadRequestObservations.sampleCount, reset.schedule.plannedCount);
    assert.equal(reset.probe.loadRequestObservations.errorRate, 1);
    assert.equal(reset.probe.transportEvidence.finalSnapshot.activeRequests, 0);
    assert.equal(reset.probe.transportEvidence.finalSnapshot.socketCount, 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 140);
    t.after(() => clearTimeout(timer));
    const interrupted = await actualGeneratorProbe(t, { mode: 'slow', signal: controller.signal });
    assert.equal(interrupted.probe.status, 'failed');
    assert.equal(interrupted.probe.generatorEvidence.validation.passed, false);
    assert.ok(interrupted.probe.openLoop.timeline.observedActiveWindowMs < interrupted.schedule.policy.durationMs);
    assert.equal(interrupted.probe.transportEvidence.finalSnapshot.closed, true);
});


test('canonical partial-body deadline and caller abort keep actual response facts and separate counts', async (t) =>
{
    const server = http.createServer((_request, response) =>
    {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.write(new Uint8Array(8));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const { schedule: original, routePolicy, routeIds } = canonicalFixturePolicies();
    const options = { routePolicy, sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        requestBaseUrl: endpoint, transportPolicy: transportPolicy(), runBinding: fixtureRunBinding(endpoint),
        workerRegistration: fixtureWorkerRegistration() };
    const timed = await runOpenLoopRouteContractProbe(buildOpenLoopLoadSchedule({ ...original.policy, requestTimeoutMs: 40 }, routeIds), options);
    assert.equal(timed.requestAvailability.complete, true);
    assert.equal(timed.loadRequestObservations.timeoutRate, 1);
    assert.equal(timed.loadRequestObservations.errorRate, 0);
    assert.ok(timed.loadRequestObservations.samples.every((sample) => sample.outcome === 'timeout' && sample.httpStatus === 200 && sample.bytes === 8));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    t.after(() => clearTimeout(timer));
    const cancelled = await runOpenLoopRouteContractProbe(original, { ...options, signal: controller.signal });
    assert.equal(cancelled.requestAvailability.complete, true);
    assert.equal(cancelled.loadRequestObservations.completed, 0);
    assert.equal(cancelled.loadRequestObservations.timeoutRate, null);
    assert.ok(cancelled.loadRequestObservations.samples.every((sample) => sample.outcome === 'cancelled' && sample.httpStatus === 200 && sample.bytes === 8));
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.transportEvidence.finalSnapshot.socketCount, 0);
});
