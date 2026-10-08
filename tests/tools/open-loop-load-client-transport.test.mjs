import assert from 'node:assert/strict';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { assertLoadTransportCohort, classifyLoadTransportFailure, createOpenLoopLoadClientTransport, resolveLoadTransportDns,
    validateLoadTransportPolicy, verifyLoadTransportObservation }
    = await import(new URL('../../tools/test/open-loop-load-client-transport.mjs', import.meta.url).href);
const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule }
    = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);

const documentBody = '<!doctype html><html><body>owned transport fixture</body></html>';
const arrival = { sampleId: 'arrival-0', sequence: 0, routeId: 'public-home', plannedAtMs: 0 };
const requestOptions = { requestTimeoutMs: 1000 };

function policy(changes = {})
{
    return { transportId: 'loopback-http', nodeVersion: process.versions.node, clientLibrary: 'node:http',
        clientVersion: process.versions.node, httpVersion: '1.1', allowH2: false, maxConnectionsPerOrigin: 1,
        maxPipelining: 1, keepAliveTimeoutMs: 500, connectTimeoutMs: 300, headersTimeoutMs: 300,
        bodyTimeoutMs: 300, connectionReusePolicy: 'keep-alive', dnsMode: 'literal',
        dnsResult: [{ address: '127.0.0.1', family: 4 }], proxyMode: 'direct-no-ambient', tlsPolicy: 'disabled-http', ...changes };
}

async function serverFixture(t, handler = (_request, response) =>
{
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(documentBody);
})
{
    let requests = 0;
    let connections = 0;
    const server = http.createServer((request, response) =>
    {
        requests += 1;
        handler(request, response);
    });
    server.on('connection', () => connections += 1);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return { endpoint: `http://127.0.0.1:${server.address().port}`, server,
        requests: () => requests, connections: () => connections };
}

async function transportFixture(t, fixture, changes = {}, options = {})
{
    const transport = await createOpenLoopLoadClientTransport({ policy: policy(changes), endpoint: fixture.endpoint,
        runBinding: { runId: 'fixture-run', invocationId: 'fixture-invocation', attemptId: 'fixture-attempt',
            backendOrigin: fixture.endpoint }, ...options });
    t.after(() => transport.close());
    return transport;
}

async function until(predicate)
{
    for (let index = 0; index < 100; index += 1)
    {
        if (predicate())
        {
            return;
        }
        await delay(5);
    }
    assert.fail('bounded fixture observation did not arrive');
}

test('real HTTP uses explicit Agent, preserves route semantics and observes sequential reuse', async (t) =>
{
    const fixture = await serverFixture(t);
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => assert.fail('default fetch dispatcher used');
    t.after(() => globalThis.fetch = originalFetch);
    const first = await transport.request(arrival, requestOptions);
    const second = await transport.request({ ...arrival, sampleId: 'arrival-1', sequence: 1 }, requestOptions);
    assert.ok(first.ok && second.ok);
    assert.equal(fixture.connections(), 1);
    assert.equal(first.transport.reusedSocket, false);
    assert.equal(second.transport.reusedSocket, true);
    assert.equal(first.transport.connectionId, second.transport.connectionId);
    assert.equal(second.transport.connectionRequestCount, 2);
    assert.equal(second.transport.httpVersion, '1.1');
    assert.equal(second.transport.remotePort, Number(new URL(fixture.endpoint).port));
    assert.equal(assertLoadTransportCohort(transport.identity, [first.transport, second.transport]), transport.identity.contentDigest);
    assert.ok(observations.some((row) => row.type === 'response-headers' && row.socketCount === 1));
    assert.ok(observations.every((row) => row.identityDigest === transport.identity.contentDigest && Number.isFinite(row.atMs)));
    assert.ok(Object.isFrozen(second.transport));
});

test('existing open-loop scheduler consumes the portable callback without a second runner', async (t) =>
{
    const fixture = await serverFixture(t);
    const transport = await transportFixture(t, fixture);
    const schedule = buildOpenLoopLoadSchedule({ schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'fixture',
        durationMs: 120, arrivalModel: 'constant', plannedRequestsPerSecond: 25, burstWindows: [], maximumInFlight: 2,
        requestTimeoutMs: 1000, routeMix: [{ routeId: 'public-home', weight: 1 }], scheduleSeed: 'fixture-seed',
        qualificationWindowMs: 120, offeredRateTolerance: 0 }, ['public-home']);
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: transport.request });
    assert.equal(fixture.requests(), schedule.plannedCount);
    assert.ok(result.timeline.records.every((record) => record.sample.ok));
    assert.equal(result.validation.qualificationEligible, false);
    assertLoadTransportCohort(transport.identity, result.timeline.records.map((record) => record.sample.transport));
});

test('max connections and keep-alive changes produce different identities and real pool behavior', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response) =>
    {
        const timer = setTimeout(() =>
        {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end(documentBody);
        }, 40);
        response.once('close', () => clearTimeout(timer));
    });
    const one = await transportFixture(t, fixture);
    const two = await transportFixture(t, fixture, { maxConnectionsPerOrigin: 2 });
    const close = await transportFixture(t, fixture, { connectionReusePolicy: 'close', keepAliveTimeoutMs: 0 });
    assert.equal(new Set([one, two, close].map((item) => item.identity.contentDigest)).size, 3);
    const first = await Promise.all(Array.from({ length: 3 }, (_, sequence) => one.request({ ...arrival, sequence }, requestOptions)));
    assert.equal(new Set(first.map((sample) => sample.transport.connectionId)).size, 1);
    const pooled = await Promise.all(Array.from({ length: 4 }, (_, sequence) => two.request({ ...arrival, sequence }, requestOptions)));
    assert.equal(new Set(pooled.map((sample) => sample.transport.connectionId)).size, 2);
    const separate = [await close.request(arrival, requestOptions), await close.request(arrival, requestOptions)];
    assert.ok(separate.every((sample) => sample.ok && !sample.transport.reusedSocket));
    assert.notEqual(separate[0].transport.connectionId, separate[1].transport.connectionId);
    assert.throws(() => assertLoadTransportCohort(one.identity, [first[0].transport, pooled[0].transport]), /differs/u);
    assert.throws(() => assertLoadTransportCohort(one.identity, [first[0].transport, separate[0].transport]), /differs/u);
});

test('different transport IDs cannot be combined even with otherwise equal policy', async (t) =>
{
    const fixture = await serverFixture(t);
    const first = await transportFixture(t, fixture);
    const second = await transportFixture(t, fixture, { transportId: 'another-http' });
    const rows = [await first.request(arrival, requestOptions), await second.request(arrival, requestOptions)];
    assert.throws(() => assertLoadTransportCohort(first.identity, rows.map((row) => row.transport)), /differs/u);
});

test('idle keep-alive TTL retires the actual owned socket', async (t) =>
{
    const fixture = await serverFixture(t);
    const transport = await transportFixture(t, fixture, { keepAliveTimeoutMs: 30 });
    const first = await transport.request(arrival, requestOptions);
    await until(() => transport.snapshot().socketCount === 0);
    const second = await transport.request(arrival, requestOptions);
    assert.notEqual(first.transport.connectionId, second.transport.connectionId);
    assert.equal(second.transport.reusedSocket, false);
});

test('ambient proxy is rejected both at creation and after measurement starts', async (t) =>
{
    const fixture = await serverFixture(t);
    const transport = await transportFixture(t, fixture);
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY'])
    {
        const previous = process.env[key];
        process.env[key] = 'fixture-proxy-present';
        try
        {
            await assert.rejects(transportFixture(t, fixture), /ambient proxy/u);
            await assert.rejects(transport.request(arrival, requestOptions), /ambient proxy/u);
        }
        finally
        {
            if (previous === undefined)
            {
                delete process.env[key];
            }
            else
            {
                process.env[key] = previous;
            }
        }
    }
    assert.equal(fixture.requests(), 0);
});

test('DNS is sealed before measurement and drift fails before further HTTP even on reused sockets', async (t) =>
{
    const fixture = await serverFixture(t);
    const endpoint = fixture.endpoint.replace('127.0.0.1', 'localhost');
    const actualDns = await resolveLoadTransportDns(endpoint);
    assert.ok(actualDns.every((row) => ['::1', '127.0.0.1'].includes(row.address)));
    let changed = false;
    const observations = [];
    const resolver = async (host, options) => changed ? [{ address: '127.0.0.2', family: 4 }] : lookup(host, options);
    const transport = await transportFixture(t, { endpoint }, { dnsMode: 'sealed-lookup', dnsResult: actualDns },
        { resolver, onObservation: (row) => observations.push(row) });
    assert.ok((await transport.request(arrival, requestOptions)).ok);
    changed = true;
    await assert.rejects(transport.request(arrival, requestOptions), /DNS drift/u);
    assert.equal(fixture.requests(), 1);
    assert.equal(observations.filter((row) => row.type === 'dns-verified').length, 2);
    await assert.rejects(transportFixture(t, { endpoint }, { dnsMode: 'sealed-lookup', dnsResult: actualDns }, { resolver }), /premeasurement seal/u);
});

test('required policy fields reject Node-only identity and unsupported modes before any request', () =>
{
    assert.throws(() => validateLoadTransportPolicy({ nodeVersion: process.versions.node }), /every explicit field/u);
    for (const changes of [{ httpVersion: '2' }, { allowH2: true }, { maxPipelining: 2 }, { tlsPolicy: 'insecure' },
        { proxyMode: 'ambient' }, { clientLibrary: 'fetch' }, { clientVersion: 'unknown' }, { nodeVersion: '0.0.0' },
        { dnsResult: [{ address: '192.0.2.1', family: 4 }] }, { keepAliveTimeoutMs: 0 }, { bodyTimeoutMs: 0 }])
    {
        assert.throws(() => validateLoadTransportPolicy(policy(changes)));
    }
});

test('observed H2, default dispatcher, missing reuse and changed endpoint fail identity checks', async (t) =>
{
    const firstFixture = await serverFixture(t);
    const secondFixture = await serverFixture(t);
    const first = await transportFixture(t, firstFixture);
    const second = await transportFixture(t, secondFixture);
    const sample = await first.request(arrival, requestOptions);
    for (const changes of [{ httpVersion: '2.0' }, { globalAgent: true }, { agentType: 'global-fetch' },
        { reusedSocket: undefined }, { connectionRequestCount: undefined }, { remotePort: sample.transport.remotePort + 1 },
        { nodeVersion: '0.0.0' }])
    {
        assert.throws(() => verifyLoadTransportObservation(first.identity, { ...sample.transport, ...changes }), /differs/u);
    }
    const another = await second.request(arrival, requestOptions);
    assert.throws(() => verifyLoadTransportObservation(first.identity, another.transport), /differs/u);
    await assert.rejects(transportFixture(t, secondFixture, {}, { runBinding: first.identity.runBinding }), /run binding/u);
});

test('real HTTP/1.0 peer fails the planned HTTP/1.1 contract', async (t) =>
{
    const server = net.createServer((socket) => socket.once('data', () => socket.end(
        `HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(documentBody)}\r\n\r\n${documentBody}`)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const transport = await transportFixture(t, { endpoint: `http://127.0.0.1:${server.address().port}` });
    const sample = await transport.request(arrival, requestOptions);
    assert.equal(sample.ok, false);
    assert.equal(sample.transport.httpVersion, '1.0');
});

test('real H2 cleartext peer cannot silently replace the planned HTTP/1.1 transport', async (t) =>
{
    const sessions = new Set();
    const server = http2.createServer();
    server.on('session', (session) =>
    {
        sessions.add(session);
        session.on('error', () =>
        {});
        session.once('close', () => sessions.delete(session));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        sessions.forEach((session) => session.destroy());
        await new Promise((resolve) => server.close(resolve));
    });
    const transport = await transportFixture(t, { endpoint: `http://127.0.0.1:${server.address().port}` });
    const sample = await transport.request(arrival, requestOptions);
    assert.equal(sample.ok, false);
    assert.equal(sample.transport.httpVersion, null);
    assert.equal(sample.transportFailureStage, 'request-failed');
    await until(() => transport.snapshot().socketCount === 0);
});

test('total request budget and bounded DNS timeout remain active beyond per-stage timers', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const transport = await transportFixture(t, fixture);
    const sample = await transport.request(arrival, { requestTimeoutMs: 40 });
    assert.equal(sample.failureKind, 'timeout');
    assert.equal(sample.transportFailureStage, 'request-timeout');
    await until(() => transport.snapshot().socketCount === 0);
    await assert.rejects(resolveLoadTransportDns(fixture.endpoint.replace('127.0.0.1', 'localhost'),
        { timeoutMs: 30, resolver: () => new Promise(() =>
        {}) }), /connect-timeout/u);
});

test('real missing headers and stalled body produce distinct bounded timeout stages', async (t) =>
{
    for (const stage of ['headers', 'body'])
    {
        const fixture = await serverFixture(t, (_request, response) =>
        {
            if (stage === 'body')
            {
                response.writeHead(200, { 'content-type': 'text/html' });
                response.flushHeaders();
                response.write('<!doctype html>');
            }
        });
        const transport = await transportFixture(t, fixture, { headersTimeoutMs: 40, bodyTimeoutMs: 40 });
        const sample = await transport.request(arrival, requestOptions);
        assert.equal(sample.ok, false);
        assert.equal(sample.failureKind, 'timeout');
        assert.equal(sample.transportFailureStage, `${stage}-timeout`);
        await until(() => transport.snapshot().socketCount === 0);
        assert.equal(transport.snapshot().activeRequests, 0);
    }
});

test('real pool wait times out without allocating another socket', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const transport = await transportFixture(t, fixture, { connectTimeoutMs: 40, headersTimeoutMs: 300 });
    const first = transport.request(arrival, requestOptions);
    await until(() => fixture.requests() === 1);
    const queued = await transport.request({ ...arrival, sampleId: 'arrival-1' }, requestOptions);
    assert.equal(queued.failureKind, 'timeout');
    assert.equal(queued.transportFailureStage, 'connect-timeout');
    assert.equal(queued.transport, null);
    await transport.close();
    assert.equal((await first).ok, false);
    assert.equal(fixture.connections(), 1);
    assert.equal(transport.snapshot().socketCount, 0);
    assert.equal(transport.snapshot().queuedRequests, 0);
});

test('external abort and owned close settle active and queued requests and destroy sockets', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const transport = await transportFixture(t, fixture);
    const controller = new AbortController();
    const first = transport.request(arrival, { ...requestOptions, signal: controller.signal });
    await until(() => fixture.requests() === 1);
    controller.abort();
    const cancelled = await first;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.failureKind, 'cancelled');
    await until(() => transport.snapshot().socketCount === 0);
    const tasks = [transport.request(arrival, requestOptions), transport.request(arrival, requestOptions)];
    await until(() => transport.snapshot().queuedRequests === 1);
    await transport.close();
    assert.ok((await Promise.all(tasks)).every((sample) => !sample.ok));
    assert.deepEqual(transport.snapshot(), { activeRequests: 0, socketCount: 0, freeSocketCount: 0, queuedRequests: 0, closed: true });
    await assert.rejects(transport.request(arrival, requestOptions), /closed/u);
});

test('redirects are not followed and route sampler failure remains visible', async (t) =>
{
    const destination = await serverFixture(t);
    const fixture = await serverFixture(t, (_request, response) =>
    {
        response.writeHead(302, { location: destination.endpoint, 'content-type': 'text/html' });
        response.end('redirect');
    });
    const transport = await transportFixture(t, fixture);
    const sample = await transport.request(arrival, requestOptions);
    assert.equal(sample.failureKind, 'redirect-forbidden');
    assert.equal(destination.requests(), 0);
    verifyLoadTransportObservation(transport.identity, sample.transport);
});

test('body bounds destroy oversized sockets without generic unbounded buffering', async (t) =>
{
    const fixture = await serverFixture(t, (_request, response) =>
    {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(Buffer.alloc(4 * 1024 * 1024));
    });
    const transport = await transportFixture(t, fixture);
    const sample = await transport.request(arrival, requestOptions);
    assert.equal(sample.ok, false);
    assert.equal(sample.transportFailureStage, 'body-size-out-of-bounds');
    await until(() => transport.snapshot().socketCount === 0);
});

test('observation port errors fail closed and pre-request authority overrides are rejected', async (t) =>
{
    const fixture = await serverFixture(t);
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) =>
    {
        if (row.type === 'dns-verified')
        {
            throw new Error('collector-failed');
        }
    } });
    await assert.rejects(transport.request(arrival, requestOptions), /collector-failed/u);
    const hostOverride = await transportFixture(t, fixture, {}, { headers: { Host: 'another-authority' } });
    await assert.rejects(hostOverride.request(arrival, requestOptions), /headers cannot override/u);
    const pathOverride = await transportFixture(t, fixture, {}, { requestPaths: { 'public-home': '//another-authority/' } });
    await assert.rejects(pathOverride.request(arrival, requestOptions), /cannot change transport authority/u);
    assert.equal(fixture.requests(), 0);
});

function failureRows(observations)
{
    return observations.filter((row) => row.type === 'request-error');
}

function assertRouteSampleShape(sample)
{
    const { transport, transportFailureStage, ...routeSample } = sample;
    assert.deepEqual(Object.keys(routeSample).sort(), ['routeId', 'contractDigest', 'status', 'contentType',
        'bodyBytes', 'frameType', 'latencyMs', 'failureKind', 'ok'].sort());
    assert.ok(Object.hasOwn(sample, 'transport') && Object.hasOwn(sample, 'transportFailureStage'));
    return { transport, transportFailureStage, routeSample };
}

test('real loopback reset preserves native code before the unchanged route oracle folds the error', async (t) =>
{
    const fixture = await serverFixture(t, (request) => request.socket.destroy());
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const sample = await transport.request(arrival, requestOptions);
    assertRouteSampleShape(sample);
    assert.equal(sample.failureKind, 'request-failed');
    const failures = failureRows(observations);
    assert.equal(failures.length, 1);
    const row = failures[0];
    assert.equal(row.sampleId, arrival.sampleId);
    assert.equal(row.sequence, arrival.sequence);
    assert.equal(row.identityDigest, transport.identity.contentDigest);
    assert.equal(row.failureFacts.stage, 'headers');
    assert.equal(row.failureFacts.event, 'native-error');
    assert.equal(row.failureFacts.error.code, 'ECONNRESET');
    assert.equal(row.failureFacts.cancellation.origin, 'none');
    assert.deepEqual(classifyLoadTransportFailure(row.failureFacts), {
        outcome: 'network-error', errorKind: 'reset', errorCode: 'ECONNRESET',
        errorDigest: classifyLoadTransportFailure(row.failureFacts).errorDigest
    });
    assert.ok(observations.indexOf(row) < observations.findIndex((event) => event.type === 'request-completed'));
    assert.ok(!Object.hasOwn(row.failureFacts.error, 'message'));
});

test('real partial-body reset preserves IncomingMessage ECONNRESET after its aborted event', async (t) =>
{
    const fixture = await serverFixture(t, (request, response) =>
    {
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': '1000' });
        response.write('<!doctype html>');
        const timer = setTimeout(() => request.socket.destroy(), 20);
        response.once('close', () => clearTimeout(timer));
    });
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const sample = await transport.request(arrival, requestOptions);
    assertRouteSampleShape(sample);
    const rows = failureRows(observations);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failureFacts.stage, 'body');
    assert.equal(rows[0].failureFacts.error.code, 'ECONNRESET');
    assert.equal(classifyLoadTransportFailure(rows[0].failureFacts).outcome, 'network-error');
});

test('real task-owned closed listener preserves ECONNREFUSED at TCP connect', async (t) =>
{
    const fixture = await serverFixture(t);
    await new Promise((resolve) => fixture.server.close(resolve));
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const sample = await transport.request(arrival, requestOptions);
    assert.equal(sample.ok, false);
    const facts = failureRows(observations)[0].failureFacts;
    assert.equal(facts.stage, 'connect');
    assert.equal(facts.error.code, 'ECONNREFUSED');
    assert.equal(facts.error.syscall, 'connect');
    assert.equal(classifyLoadTransportFailure(facts).errorKind, 'connect');
});

test('real stalled loopback response exposes owned total and stage deadline provenance', async (t) =>
{
    for (const stageDeadline of [false, true])
    {
        const fixture = await serverFixture(t, () =>
        {});
        const observations = [];
        const transport = await transportFixture(t, fixture, { headersTimeoutMs: stageDeadline ? 30 : 300 },
            { onObservation: (row) => observations.push(row) });
        const sample = await transport.request(arrival, { requestTimeoutMs: stageDeadline ? 1000 : 30 });
        assert.equal(sample.failureKind, 'timeout');
        const facts = failureRows(observations)[0].failureFacts;
        assert.equal(facts.cancellation.origin, stageDeadline ? 'transport-stage-deadline' : 'transport-request-deadline');
        assert.equal(facts.event, stageDeadline ? 'deadline' : 'signal-abort');
        assert.equal(classifyLoadTransportFailure(facts).outcome, 'timeout');
    }
});

test('real outer caller abort is cancellation even with a TimeoutError reason and misleading message', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const caller = new AbortController();
    const pending = transport.request(arrival, { ...requestOptions, signal: caller.signal, callerSignal: caller.signal });
    await until(() => fixture.requests() === 1);
    caller.abort(new DOMException('deadline timeout DNS reset', 'TimeoutError'));
    const sample = await pending;
    assert.equal(sample.failureKind, 'cancelled');
    assertRouteSampleShape(sample);
    const facts = failureRows(observations)[0].failureFacts;
    assert.equal(facts.error.name, 'TimeoutError');
    assert.equal(facts.cancellation.origin, 'caller');
    assert.equal(classifyLoadTransportFailure(facts).outcome, 'cancelled');
    await until(() => transport.snapshot().socketCount === 0);
});

test('unattributed real merged abort and conflicting pre-aborted origins refuse classification', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const merged = new AbortController();
    const pending = transport.request(arrival, { ...requestOptions, signal: merged.signal });
    await until(() => fixture.requests() === 1);
    merged.abort(new DOMException('timeout', 'TimeoutError'));
    await pending;
    const unknown = failureRows(observations)[0].failureFacts;
    assert.equal(unknown.cancellation.origin, 'unattributed');
    assert.throws(() => classifyLoadTransportFailure(unknown), /missing or ambiguous cancellation provenance/u);
    const caller = new AbortController();
    const deadline = new AbortController();
    caller.abort();
    deadline.abort();
    const ambiguousObservations = [];
    const ambiguous = await transportFixture(t, fixture, {}, { onObservation: (row) => ambiguousObservations.push(row) });
    await ambiguous.request(arrival, { ...requestOptions, callerSignal: caller.signal, deadlineSignal: deadline.signal });
    const conflicting = failureRows(ambiguousObservations)[0].failureFacts;
    assert.equal(conflicting.cancellation.origin, 'ambiguous');
    assert.throws(() => classifyLoadTransportFailure(conflicting), /missing or ambiguous cancellation provenance/u);
});

test('explicit dispatcher deadline port records its actual signal origin without message classification', async (t) =>
{
    const fixture = await serverFixture(t, () =>
    {});
    const observations = [];
    const transport = await transportFixture(t, fixture, {}, { onObservation: (row) => observations.push(row) });
    const deadline = new AbortController();
    const pending = transport.request(arrival, { ...requestOptions, signal: deadline.signal, deadlineSignal: deadline.signal });
    await until(() => fixture.requests() === 1);
    deadline.abort(new Error('caller cancellation'));
    await pending;
    const facts = failureRows(observations)[0].failureFacts;
    assert.equal(facts.cancellation.origin, 'dispatcher-deadline');
    assert.equal(classifyLoadTransportFailure(facts).outcome, 'timeout');
});

test('typed DNS failure before HTTP remains available in the existing observation sidecar', async (t) =>
{
    const fixture = await serverFixture(t);
    const endpoint = fixture.endpoint.replace('127.0.0.1', 'localhost');
    const dnsResult = await resolveLoadTransportDns(endpoint);
    let failed = false;
    const resolver = async (hostname, options) =>
    {
        if (failed)
        {
            const error = new Error('timeout TLS reset');
            error.code = 'EAI_AGAIN';
            error.syscall = 'getaddrinfo';
            throw error;
        }
        return lookup(hostname, options);
    };
    const observations = [];
    const transport = await transportFixture(t, { endpoint }, { dnsMode: 'sealed-lookup', dnsResult },
        { resolver, onObservation: (row) => observations.push(row) });
    failed = true;
    await assert.rejects(transport.request(arrival, requestOptions), { code: 'EAI_AGAIN' });
    const facts = failureRows(observations)[0].failureFacts;
    assert.equal(facts.stage, 'dns');
    assert.equal(facts.error.code, 'EAI_AGAIN');
    assert.equal(classifyLoadTransportFailure(facts).errorKind, 'dns');
    assert.equal(fixture.requests(), 0);
});

test('failure classifier refuses missing/contradictory provenance and preserves typed causes', () =>
{
    const base = { stage: 'connect', event: 'native-error',
        error: { name: 'Error', code: 'ECONNREFUSED', syscall: 'connect', cause: null },
        cancellation: { origin: 'none', abortedSignals: [] } };
    assert.equal(classifyLoadTransportFailure(base).outcome, 'network-error');
    for (const changes of [{ stage: null }, { event: null }, { cancellation: { origin: 'caller', abortedSignals: [] } },
        { error: { ...base.error, code: null } }, { error: { ...base.error, name: null } },
        { event: 'signal-abort', cancellation: { origin: 'dispatcher-deadline', abortedSignals: ['merged'] } },
        { event: 'deadline', cancellation: { origin: 'caller', abortedSignals: ['caller'] } },
        { event: 'deadline', cancellation: { origin: 'transport-stage-deadline', abortedSignals: [] } }])
    {
        assert.throws(() => classifyLoadTransportFailure({ ...base, ...changes }));
    }
    const nested = { ...base, error: { name: 'TypeError', code: null, syscall: null, cause: base.error } };
    assert.equal(classifyLoadTransportFailure(nested).errorCode, 'ECONNREFUSED');
    const tls = { ...base, error: { ...base.error, code: 'CERT_HAS_EXPIRED', syscall: null } };
    assert.equal(classifyLoadTransportFailure(tls).errorKind, 'tls');
    const kernelTimeout = { ...base, error: { ...base.error, code: 'ETIMEDOUT' } };
    assert.equal(classifyLoadTransportFailure(kernelTimeout).outcome, 'network-error');
    const ambiguous = { ...base, error: { ...base.error, cause: tls.error } };
    assert.throws(() => classifyLoadTransportFailure(ambiguous), /ambiguous typed network error code/u);
});
