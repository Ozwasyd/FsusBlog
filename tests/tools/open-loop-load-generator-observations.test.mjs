import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const { sealContentDigest } = await import(new URL('../../tools/test/attempt-provenance.mjs', import.meta.url).href);
const { createOpenLoopLoadGeneratorCollector, loadGeneratorMetricNames, validateLoadGeneratorObservationPolicy,
    verifyOpenLoopLoadGeneratorObservations } = await import(new URL('../../tools/test/open-loop-load-generator-observations.mjs', import.meta.url).href);
const { createOpenLoopLoadClientTransport } = await import(new URL('../../tools/test/open-loop-load-client-transport.mjs', import.meta.url).href);
const { buildOpenLoopLoadSchedule, dispatchOpenLoopLoadSchedule } = await import(new URL('../../tools/test/open-loop-load-schedule.mjs', import.meta.url).href);
const { runOpenLoopRouteContractProbe } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url).href);
const { producerRouteIds, routeContract } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url).href);
const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url).href);

const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();

function collectorPolicy(limits = {})
{
    const metrics = Object.fromEntries(loadGeneratorMetricNames.map((name) => [name, { classification: 'diagnostic-only' }]));
    Object.assign(limits, { generatorCpuPercent: limits.generatorCpuPercent ?? 1000, scheduleLagP99Ms: limits.scheduleLagP99Ms ?? 500 });
    for (const [name, maximum] of Object.entries(limits))
    {
        metrics[name] = { classification: 'qualification-required', maximum };
    }
    return { schema: 'fsusblog.load-generator-observation-policy.v1', samplingIntervalMs: 80, eventLoopResolutionMs: 2,
        maximumSampleDelayMs: 75, maximumBoundaryDelayMs: 20,
        maximumGeneratorCpuPercent: limits.generatorCpuPercent, maximumGeneratorScheduleLagP99Ms: limits.scheduleLagP99Ms, metrics };
}

function arrivalPolicy(routeIds, changes = {})
{
    return { schema: 'fsusblog.release-load-arrival-policy.v1', profileId: 'generator-fixture', durationMs: 320,
        arrivalModel: 'constant', plannedRequestsPerSecond: 75, burstWindows: [], maximumInFlight: 32,
        requestTimeoutMs: 1500, routeMix: routeIds.map((routeId) => ({ routeId, weight: 1 })), scheduleSeed: 'generator-fixture',
        qualificationWindowMs: 160, offeredRateTolerance: 0, ...changes };
}

function transportPolicy(changes = {})
{
    return { transportId: 'generator-fixture-http', nodeVersion: process.versions.node, clientLibrary: 'node:http',
        clientVersion: process.versions.node, httpVersion: '1.1', allowH2: false, maxConnectionsPerOrigin: 8,
        maxPipelining: 1, keepAliveTimeoutMs: 1000, connectTimeoutMs: 1000, headersTimeoutMs: 1000,
        bodyTimeoutMs: 1000, connectionReusePolicy: 'keep-alive', dnsMode: 'literal',
        dnsResult: [{ address: '127.0.0.1', family: 4 }], proxyMode: 'direct-no-ambient', tlsPolicy: 'disabled-http', ...changes };
}

async function backendFixture(t, { delayMs = 0, bodyBytes = 0 } = {})
{
    const routes = Object.fromEntries(producerRouteIds('runtime-load-soak').map((id) =>
    {
        const contract = routeContract(id);
        return [contract.pathTemplate, Buffer.from(encodeAedsFrame(contract.expectedAedsFrameType, new Uint8Array(16))).toString('base64')];
    }));
    // A separate task-owned process prevents backend CPU/RSS from entering the
    // actual generator observations. Only its ephemeral loopback server is used.
    const script = `
        import http from 'node:http';
        const config = JSON.parse(process.argv[1]);
        const timers = new Set();
        const server = http.createServer((request, response) => {
            const timer = setTimeout(() => {
                timers.delete(timer);
                if (request.url === '/') {
                    response.writeHead(200, { 'content-type': 'text/html' });
                    response.end('<!doctype html><html><body>' + 'a'.repeat(config.bodyBytes || 64) + '</body></html>');
                } else {
                    response.writeHead(200, { 'content-type': 'application/octet-stream' });
                    response.end(Buffer.from(config.routes[request.url], 'base64'));
                }
            }, config.delayMs);
            timers.add(timer);
            response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        });
        server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, pid: process.pid }));
        process.on('message', () => {
            for (const timer of timers) clearTimeout(timer);
            server.closeAllConnections();
            server.close(() => process.exit(0));
        });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ routes, delayMs, bodyBytes })], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
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
        const exited = once(child, 'exit');
        const timer = setTimeout(() => child.kill(), 2000);
        child.send('close');
        await exited;
        clearTimeout(timer);
    });
    const message = await Promise.race([once(child, 'message').then(([value]) => value),
        once(child, 'exit').then(() => assert.fail(`loopback backend exited: ${stderr}`))]);
    clearTimeout(startupTimer);
    assert.equal(message.pid, child.pid);
    assert.notEqual(child.pid, process.pid);
    return { endpoint: `http://127.0.0.1:${message.port}`, identity: { pid: child.pid, sourceSha } };
}

function binding(endpoint)
{
    return { runId: 'generator-source-fixture', invocationId: 'generator-source-invocation',
        attemptId: 'generator-source-attempt', backendOrigin: endpoint };
}

function burnCpu(ms)
{
    const until = performance.now() + ms;
    while (performance.now() < until)
    {
        Math.sqrt(performance.now());
    }
}

async function canonicalRun(t, { limits = {}, backend = {}, blockMs = 0, slowBudget = false, signal,
    scheduleChanges = {}, transportChanges = {} } = {})
{
    const fixture = await backendFixture(t, backend);
    const routeIds = producerRouteIds('runtime-load-soak');
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(routeIds, scheduleChanges), routeIds);
    const policy = collectorPolicy(limits);
    const collector = createOpenLoopLoadGeneratorCollector({ policy, schedule, sourceSha, backendIdentity: fixture.identity });
    t.after(collector.dispose);
    const routePolicy = { schema: 'fsusblog.release-load-route-statistics-policy.v1', routes: routeIds.map((routeId) => ({
        routeId, minimumValidSamples: 1, thresholds: { latencyP95Ms: slowBudget ? 20 : 1200,
            latencyP99Ms: slowBudget ? 20 : 1200, latencyMaxMs: slowBudget ? 20 : 1200, errorRate: 0, timeoutRate: 0, dropRate: 0 }
    })) };
    let timer;
    t.after(() => clearTimeout(timer));
    const probe = await runOpenLoopRouteContractProbe(schedule, { sourceSha, routePolicy, requestBaseUrl: fixture.endpoint,
        transportPolicy: transportPolicy(transportChanges), runBinding: binding(fixture.endpoint), signal,
        onMeasurementStart: (window) =>
        {
            collector.onMeasurementStart(window);
            if (blockMs)
            {
                timer = setTimeout(() => burnCpu(blockMs), 25);
            }
        }, onMeasurementEnd: collector.onMeasurementEnd, onTransportObservation: collector.onTransportObservation });
    const inputs = { sourceSha, schedule, timeline: probe.openLoop.timeline, measurementWindow: probe.measurementWindow,
        transportEvidence: probe.transportEvidence, policy, generatorIdentity: collector.identity };
    return { collector, probe, inputs, fixture };
}

function reseal(value)
{
    return sealContentDigest(value);
}

test('explicit policy requires every metric classification and both enforced maxima', () =>
{
    const policy = collectorPolicy();
    assert.deepEqual(validateLoadGeneratorObservationPolicy(policy), policy);
    for (const name of loadGeneratorMetricNames)
    {
        const missing = structuredClone(policy);
        delete missing.metrics[name];
        assert.throws(() => validateLoadGeneratorObservationPolicy(missing), /exact explicit fields/u);
        const unbounded = structuredClone(policy);
        unbounded.metrics[name] = { classification: 'qualification-required', maximum: null };
        assert.throws(() => validateLoadGeneratorObservationPolicy(unbounded), /unavailable/u);
    }
    for (const name of ['generatorCpuPercent', 'scheduleLagP99Ms'])
    {
        const diagnostic = structuredClone(policy);
        diagnostic.metrics[name] = { classification: 'diagnostic-only' };
        assert.throws(() => validateLoadGeneratorObservationPolicy(diagnostic), /enforced/u);
    }
    const mismatched = structuredClone(policy);
    mismatched.maximumGeneratorCpuPercent += 1;
    assert.throws(() => validateLoadGeneratorObservationPolicy(mismatched), /must match/u);
    assert.throws(() => validateLoadGeneratorObservationPolicy({ ...policy, eventLoopResolutionMs: 50 }), /resolution/u);
});

test('canonical callbacks collect real generator resources, sockets and reuse before drain', async (t) =>
{
    const run = await canonicalRun(t, { backend: { delayMs: 90 } });
    const receipt = run.collector.finish(run.inputs);
    const result = verifyOpenLoopLoadGeneratorObservations(receipt, run.inputs);
    assert.equal(result.passed, true, result.reason);
    assert.equal(result.qualificationEligible, false);
    assert.equal(receipt.identity.pid, process.pid);
    assert.equal(receipt.identity.backendIdentity.pid, run.fixture.identity.pid);
    assert.equal(receipt.identity.nodeVersion, process.versions.node);
    assert.equal(receipt.start.transportIdentity.contentDigest, run.probe.transportEvidence.identity.contentDigest);
    assert.equal(receipt.end.endedMonotonicMs, run.probe.measurementWindow.endedMonotonicMs);
    assert.equal(receipt.end.observedActiveWindowMs, run.inputs.timeline.observedActiveWindowMs);
    assert.equal(receipt.end.transportSnapshot.closed, false);
    assert.equal(receipt.events.at(-1).type, 'transport-closed');
    assert.ok(receipt.events.some((row) => row.atMs > receipt.end.endedMonotonicMs && row.type === 'request-completed'));
    assert.equal(receipt.samples.filter((row) => row.kind === 'periodic').length, 3);
    assert.deepEqual(Object.keys(receipt.metrics).sort(), [...loadGeneratorMetricNames].sort());
    assert.ok(receipt.metrics.generatorUserCpuMs > 0);
    assert.ok(receipt.metrics.generatorSystemCpuMs > 0);
    assert.ok(receipt.metrics.generatorRssBytes > receipt.metrics.generatorHeapUsedBytes);
    assert.ok(receipt.metrics.eventLoopLagP99Ms > 0);
    assert.ok(receipt.metrics.activeSockets > 0 && receipt.metrics.idleSockets > 0);
    assert.ok(receipt.metrics.newConnections > 0 && receipt.metrics.reusedConnections > 0);
    assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.samples[0]));
    for (const interval of receipt.intervals)
    {
        const cpuMs = interval.generatorUserCpuMs + interval.generatorSystemCpuMs;
        assert.equal(interval.generatorCpuPercent, cpuMs / (interval.observedEndMonotonicMs - interval.observedStartMonotonicMs) * 100);
    }
    const lags = run.inputs.timeline.records.map((row) => row.scheduleLagMs).sort((left, right) => left - right);
    assert.equal(receipt.metrics.scheduleLagP99Ms, lags[Math.ceil(lags.length * 0.99) - 1]);
});

test('bounded real generator CPU saturation defeats fast server latency', async (t) =>
{
    const run = await canonicalRun(t, { limits: { generatorCpuPercent: 15 }, blockMs: 40 });
    const receipt = run.collector.finish(run.inputs);
    assert.equal(run.probe.routeStatistics.passed, true);
    assert.ok(receipt.metrics.generatorCpuPercent > 15);
    const result = verifyOpenLoopLoadGeneratorObservations(receipt, run.inputs, { serverFailureKind: 'server.latency-failed' });
    assert.equal(result.failureKind, 'infra.load-generator-saturated');
    assert.ok(result.exceeded.includes('generatorCpuPercent'));
});

test('real blocked loop and shared schedule lag enforce independent maxima', async (t) =>
{
    const run = await canonicalRun(t, { limits: { eventLoopLagP99Ms: 10, scheduleLagP99Ms: 5 }, blockMs: 40 });
    const receipt = run.collector.finish(run.inputs);
    assert.equal(run.probe.routeStatistics.passed, true);
    assert.ok(receipt.metrics.eventLoopLagP99Ms > 10);
    assert.ok(receipt.metrics.scheduleLagP99Ms > 5);
    assert.equal(receipt.failureKind, 'infra.load-generator-saturated');
    assert.ok(receipt.exceeded.includes('eventLoopLagP99Ms'));
    assert.ok(receipt.exceeded.includes('scheduleLagP99Ms'));
    assert.deepEqual(run.inputs.schedule.arrivals.map((row) => row.plannedAtMs),
        buildOpenLoopLoadSchedule(run.inputs.schedule.policy).arrivals.map((row) => row.plannedAtMs));
});

test('separate slow backend retains server latency failure when generator passes', async (t) =>
{
    const run = await canonicalRun(t, { backend: { delayMs: 120 }, slowBudget: true });
    const receipt = run.collector.finish(run.inputs);
    assert.equal(run.probe.routeStatistics.passed, false);
    const result = verifyOpenLoopLoadGeneratorObservations(receipt, run.inputs, { serverFailureKind: 'server.latency-failed' });
    assert.equal(result.generatorPassed, true, result.reason);
    assert.equal(result.failureKind, 'server.latency-failed');
    assert.equal(result.passed, false);
});

test('real Agent queue and scheduler backpressure retain original drops and enforce resource budgets', async (t) =>
{
    const run = await canonicalRun(t, { backend: { delayMs: 50 }, scheduleChanges: { maximumInFlight: 3 },
        transportChanges: { maxConnectionsPerOrigin: 1 }, limits: { pendingRequests: 0, generatorBackpressureDrops: 0,
            activeSockets: 0, newConnections: 0, reusedConnections: 0, generatorHeapUsedBytes: 0 } });
    const receipt = run.collector.finish(run.inputs);
    assert.equal(run.probe.openLoop.validation.passed, false);
    assert.ok(run.probe.openLoop.validation.counts.dropped > 0);
    assert.equal(receipt.metrics.generatorBackpressureDrops, run.inputs.timeline.records
        .filter((row) => row.failureKind === 'generator-backpressure-drop').length);
    assert.ok(receipt.metrics.pendingRequests > 0);
    assert.equal(receipt.failureKind, 'infra.load-generator-saturated');
    for (const metric of ['pendingRequests', 'generatorBackpressureDrops', 'activeSockets', 'newConnections',
        'reusedConnections', 'generatorHeapUsedBytes'])
    {
        assert.ok(receipt.exceeded.includes(metric), metric);
    }
    assert.ok(receipt.windowFailures.length > 0);
    for (const interval of receipt.intervals)
    {
        for (const metric of loadGeneratorMetricNames)
        {
            assert.ok(interval.availability[metric]);
            assert.equal(typeof interval.metrics[metric], 'number');
        }
    }
});

test('actual large HTTP bodies trigger sampled generator RSS policy without backend PID mixing', async (t) =>
{
    if (process.env.FSUSBLOG_GENERATOR_RSS_FIXTURE_CHILD !== '1')
    {
        // Isolate this memory control from earlier probes' heap/allocator peaks.
        const childEnvironment = { ...process.env, FSUSBLOG_GENERATOR_RSS_FIXTURE_CHILD: '1' };
        delete childEnvironment.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ['--expose-gc', '--test', '--test-name-pattern',
            '^actual large HTTP bodies', '--test-reporter=tap', import.meta.filename], {
            env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe']
        });
        let output = '';
        child.stdout.on('data', (chunk) => output += chunk);
        child.stderr.on('data', (chunk) => output += chunk);
        const timer = setTimeout(() => child.kill(), 10_000);
        t.after(() => clearTimeout(timer));
        const [code] = await once(child, 'exit');
        assert.equal(code, 0, output);
        assert.match(output, /# pass 1\b/u);
        return;
    }
    const fixture = await backendFixture(t, { bodyBytes: 1_500_000 });
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(['public-home'], { plannedRequestsPerSecond: 50 }));
    assert.equal(typeof globalThis.gc, 'function');
    globalThis.gc();
    await delay(100);
    globalThis.gc();
    await delay(100);
    const maximumRss = process.memoryUsage().rss + 1_000_000;
    const policy = collectorPolicy({ generatorRssBytes: maximumRss });
    const collector = createOpenLoopLoadGeneratorCollector({ policy, schedule, sourceSha, backendIdentity: fixture.identity });
    t.after(collector.dispose);
    const observations = [];
    const transport = await createOpenLoopLoadClientTransport({ policy: transportPolicy(), endpoint: fixture.endpoint,
        runBinding: binding(fixture.endpoint), onObservation: (value) =>
        {
            observations.push(value);
            collector.onTransportObservation(value);
        } });
    t.after(() => transport.snapshot().closed ? undefined : transport.close());
    let start;
    let end;
    const bodyWorkspaces = [];
    const result = await dispatchOpenLoopLoadSchedule(schedule, { request: async (arrival, options) =>
    {
        const sample = await transport.request(arrival, options);
        // Model bounded body-processing retention in the generator, in addition
        // to the real client's HTTP buffering. At most 48 MiB in this fixture.
        bodyWorkspaces.push(Buffer.alloc(sample.bodyBytes * 2, 1));
        return sample;
    },
    onMeasurementStart: (window) =>
    {
        start = window;
        collector.onMeasurementStart({ ...window, transportIdentity: transport.identity, transportSnapshot: transport.snapshot() });
    }, onMeasurementEnd: (window) =>
    {
        end = window;
        collector.onMeasurementEnd({ ...window, transportIdentity: transport.identity, transportSnapshot: transport.snapshot() });
    } });
    await transport.close();
    assert.ok(start && end);
    assert.ok(result.timeline.records.every((row) => row.sample.ok && row.sample.bodyBytes > 1_500_000));
    const transportEvidence = reseal({ schema: 'fsusblog.release-load-transport-evidence.v1', identity: transport.identity,
        observations, requestTransports: result.timeline.records.map((row) => ({ sampleId: row.sampleId, routeId: row.routeId,
            transport: row.sample.transport, failureStage: row.sample.transportFailureStage })),
        finalSnapshot: transport.snapshot(), runtimeLeaseVerified: false, qualificationEligible: false });
    const measurementWindow = reseal({ schema: 'fsusblog.release-load-source-window.v1', ...start, ...end, qualificationEligible: false });
    const inputs = { sourceSha, schedule, timeline: result.timeline, measurementWindow, transportEvidence, policy, generatorIdentity: collector.identity };
    const receipt = collector.finish(inputs);
    assert.ok(receipt.metrics.generatorRssBytes > maximumRss, JSON.stringify({ maximumRss,
        sampled: receipt.samples.map((row) => row.rssBytes), now: process.memoryUsage(), retained: bodyWorkspaces.length }));
    assert.ok(receipt.samples.filter((row) => row.kind === 'periodic').some((row) => row.rssBytes > maximumRss));
    const verified = verifyOpenLoopLoadGeneratorObservations(receipt, inputs);
    assert.equal(verified.failureKind, 'infra.load-generator-saturated');
    assert.ok(verified.exceeded.includes('generatorRssBytes'));
    assert.ok(bodyWorkspaces.reduce((sum, value) => sum + value.length, 0) < 48 * 1024 * 1024);
});

test('missing collector samples, wrong windows, PID confusion and derived substitutions fail closed', async (t) =>
{
    const run = await canonicalRun(t);
    const receipt = run.collector.finish(run.inputs);
    const mutations = [
        (value) => delete value.metrics.generatorRssBytes,
        (value) => value.metrics.generatorCpuPercent = 0,
        (value) => value.metrics.generatorRssBytes = null,
        (value) => value.samples.splice(1, 1),
        (value) => value.samples = [value.samples.at(-1)],
        (value) => value.samples[1].atMs = value.samples[1].scheduledMonotonicMs - 0.1,
        (value) => value.samples[1].atMs = value.end.endedMonotonicMs + 100,
        (value) => value.samples[1].pid = run.fixture.identity.pid,
        (value) => value.start.startedMonotonicMs += 500,
        (value) => value.end.observedActiveWindowMs += 1,
        (value) => value.identity = reseal({ ...value.identity, pid: run.fixture.identity.pid }),
        (value) => value.identity = reseal({ ...value.identity, nodeVersion: '0.0.0' }),
        (value) => value.identity = reseal({ ...value.identity, policyDigest: 'sha256:' + '0'.repeat(64) }),
        (value) => value.samples[1].eventLoop = { status: 'unavailable', reason: 'collector missing' }
    ];
    for (const mutate of mutations)
    {
        const changed = structuredClone(receipt);
        mutate(changed);
        const result = verifyOpenLoopLoadGeneratorObservations(reseal(changed), run.inputs);
        assert.equal(result.passed, false);
        assert.equal(result.failureKind, 'infra.load-generator-collector-unavailable');
    }
    assert.equal(verifyOpenLoopLoadGeneratorObservations(undefined, run.inputs).passed, false);
    assert.equal(verifyOpenLoopLoadGeneratorObservations(receipt, { ...run.inputs, generatorIdentity: undefined }).passed, false);
    assert.equal(verifyOpenLoopLoadGeneratorObservations(receipt, { ...run.inputs, sourceSha: '0'.repeat(40) }).passed, false);
    assert.throws(() => createOpenLoopLoadGeneratorCollector({ policy: run.inputs.policy, schedule: run.inputs.schedule,
        sourceSha, backendIdentity: { pid: process.pid, sourceSha } }), /separate/u);
});

test('missing actual connection fields, pool snapshots and transport identity drift are rejected', async (t) =>
{
    const run = await canonicalRun(t);
    const receipt = run.collector.finish(run.inputs);
    for (const key of ['connectionId', 'connectionRequestCount', 'reusedSocket', 'nodeReusedSocket',
        'localAddress', 'localPort', 'remoteAddress', 'remotePort'])
    {
        const changed = structuredClone(receipt);
        const event = changed.events.find((row) => row.type === 'socket-assigned');
        event.transport[key] = null;
        const evidence = reseal({ ...run.inputs.transportEvidence, observations: changed.events });
        changed.transportEvidenceDigest = evidence.contentDigest;
        assert.equal(verifyOpenLoopLoadGeneratorObservations(reseal(changed), { ...run.inputs, transportEvidence: evidence }).passed, false, key);
    }
    for (const key of ['socketCount', 'freeSocketCount', 'queuedRequests'])
    {
        const changed = structuredClone(receipt);
        changed.start.transportSnapshot[key] = null;
        assert.equal(verifyOpenLoopLoadGeneratorObservations(reseal(changed), run.inputs).passed, false, key);
    }
    const drift = structuredClone(receipt);
    drift.end.transportIdentity.policy.maxConnectionsPerOrigin += 1;
    assert.equal(verifyOpenLoopLoadGeneratorObservations(reseal(drift), run.inputs).passed, false);
    assert.throws(() => run.collector.onTransportObservation({ ...receipt.events[0], identityDigest: 'drift' }), /identity drift/u);
});

test('cancelled real window retains observed duration and cannot fabricate nominal resource evidence', async (t) =>
{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240);
    t.after(() => clearTimeout(timer));
    const run = await canonicalRun(t, { signal: controller.signal, backend: { delayMs: 400 } });
    assert.ok(run.probe.measurementWindow.observedActiveWindowMs < run.inputs.schedule.policy.durationMs);
    assert.equal(run.probe.measurementWindow.cancelled, true);
    assert.throws(() => run.collector.finish(run.inputs), /interrupted/u);
});

test('collector lifecycle is synchronous, refuses missing boundaries and cleans up owned timers', async (t) =>
{
    const fixture = await backendFixture(t);
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(['public-home']));
    const collector = createOpenLoopLoadGeneratorCollector({ policy: collectorPolicy(), schedule, sourceSha, backendIdentity: fixture.identity });
    t.after(collector.dispose);
    assert.throws(() => collector.finish({}), /unavailable/u);
    assert.throws(() => collector.onMeasurementEnd({}), /unavailable/u);
    let requests = 0;
    await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { request: () => requests += 1,
        onMeasurementStart: async () =>
        {} }), /synchronously/u);
    assert.equal(requests, 0);
    collector.dispose();
    assert.throws(() => collector.onMeasurementStart({}), /disposed/u);
});

test('wrong monotonic measurement origin is refused synchronously before actual HTTP', async (t) =>
{
    const fixture = await backendFixture(t);
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(['public-home']));
    const collector = createOpenLoopLoadGeneratorCollector({ policy: collectorPolicy(), schedule, sourceSha, backendIdentity: fixture.identity });
    t.after(collector.dispose);
    const transport = await createOpenLoopLoadClientTransport({ policy: transportPolicy(), endpoint: fixture.endpoint,
        runBinding: binding(fixture.endpoint), onObservation: collector.onTransportObservation });
    let requests = 0;
    try
    {
        await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { clock: () => 0, request: () => requests += 1,
            onMeasurementStart: (window) => collector.onMeasurementStart({ ...window,
                transportIdentity: transport.identity, transportSnapshot: transport.snapshot() }) }), /shared monotonic window/u);
    }
    finally
    {
        await transport.close();
    }
    assert.equal(requests, 0);
    assert.throws(() => collector.finish({}), /unavailable/u);
});

test('unavailable real process collector aborts before the first HTTP request and preserves its error', async (t) =>
{
    const fixture = await backendFixture(t);
    const schedule = buildOpenLoopLoadSchedule(arrivalPolicy(['public-home']));
    const collector = createOpenLoopLoadGeneratorCollector({ policy: collectorPolicy(), schedule, sourceSha, backendIdentity: fixture.identity });
    t.after(collector.dispose);
    const transport = await createOpenLoopLoadClientTransport({ policy: transportPolicy(), endpoint: fixture.endpoint,
        runBinding: binding(fixture.endpoint), onObservation: collector.onTransportObservation });
    let requests = 0;
    const originalCpuUsage = process.cpuUsage;
    try
    {
        process.cpuUsage = () => undefined;
        await assert.rejects(dispatchOpenLoopLoadSchedule(schedule, { request: () => requests += 1,
            onMeasurementStart: (window) => collector.onMeasurementStart({ ...window,
                transportIdentity: transport.identity, transportSnapshot: transport.snapshot() }) }), /user/u);
    }
    finally
    {
        process.cpuUsage = originalCpuUsage;
        await transport.close();
    }
    assert.equal(requests, 0);
    assert.throws(() => collector.finish({}), /unavailable/u);
});
