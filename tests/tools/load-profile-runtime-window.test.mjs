import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { readLoadProfilePolicy } = await import(new URL('../../tools/test/lanes/runtime-evidence-probe.mjs', import.meta.url));
const { producerRouteIds, routeContract } = await import(new URL('../../tools/test/lanes/runtime-http-route-contract.mjs', import.meta.url));
const { digestValue } = await import(new URL('../../tools/test/release-reliability-receipt.mjs', import.meta.url));
const { verifyLoadProfileMeasurement } = await import(new URL('../../tools/test/verify-load-profile-measurement.mjs', import.meta.url));
const { loadWindowFailures } = await import(new URL('../../tools/test/load-profile-window.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const profile of ['expected-peak', 'burst'])
{
    test(`real isolated HTTP runner executes the entire frozen ${profile} window`, { timeout: 100000 }, async (context) =>
    {
        const policy = readLoadProfilePolicy(profile);
        const routes = producerRouteIds('runtime-load-soak');
        const paths = routes.map((id) => routeContract(id).pathTemplate);
        let requests = 0;
        const server = http.createServer(async (request, response) =>
        {
            requests += 1;
            const index = paths.indexOf(request.url);
            assert.ok(index >= 0, request.url);
            // A bounded owned fixture sustains real concurrent HTTP work for the
            // unchanged policy duration; no sleep is added to the load generator.
            await delay(75);
            response.writeHead(200, { 'content-type': 'application/octet-stream' });
            response.end(new Uint8Array(encodeAedsFrame(routeContract(routes[index]).expectedAedsFrameType, new Uint8Array(16))));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        context.after(async () =>
        {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        });
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), `owned-load-${profile}-`));
        const output = path.join(directory, 'summary.json');
        context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        const env = { ...process.env, FSUSBLOG_BASE_URL: `http://127.0.0.1:${server.address().port}`,
            FSUSBLOG_TEST_NAMESPACE: `owned-load-${process.pid}`, FSUSBLOG_RELEASE_RESOURCE_PID: String(process.pid) };
        for (const key of Object.keys(env))
        {
            if (key.startsWith('FSUSBLOG_LOAD_PROFILE_') || key.startsWith('FSUSBLOG_RELEASE_RELIABILITY_')
                || key === 'FSUSBLOG_RELEASE_RESOURCE_CONTAINER_ID')
            {
                delete env[key];
            }
        }
        const child = spawn(process.execPath, ['tools/test/lanes/runtime-evidence-probe.mjs', 'load-profile', profile, output],
            { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        context.after(() =>
        {
            if (child.exitCode === null)
            {
                child.kill('SIGTERM');
            }
        });
        let stderr = '';
        child.stderr.on('data', (data) =>
        {
            stderr += data;
        });
        child.stdout.resume();
        const exit = await new Promise((resolve, reject) =>
        {
            child.once('error', reject);
            child.once('exit', (code) => resolve(code));
        });
        if (exit !== 0 && fs.existsSync(output))
        {
            const failed = JSON.parse(fs.readFileSync(output, 'utf8'));
            context.diagnostic(JSON.stringify({ profile, exit, failureReasons: failed.runtime.failureReasons,
                window: { ...failed.runtime.window, workers: undefined },
                deadlineDifferenceMs: failed.runtime.window.deadline - failed.runtime.window.measurementStart,
                requestedDurationMs: policy.declared.durationMs }));
        }
        assert.equal(exit, 0, stderr);
        const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
        const metrics = verifyLoadProfileMeasurement(summary, { routeIds: routes, paths, requireBoundIdentity: false });
        assert.equal(summary.sampling.durationMs, policy.declared.durationMs);
        assert.ok(summary.runtime.window.observedActiveWindowMs >= policy.declared.durationMs);
        assert.equal(summary.runtime.window.workerCount, policy.declared.concurrency);
        assert.equal(summary.runtime.window.peakInFlight, policy.declared.concurrency);
        assert.ok(metrics.completed >= policy.declared.concurrency * policy.declared.rounds);
        assert.equal(summary.sampleCount, requests);
        assert.equal(summary.qualificationEligible, false);
        assert.throws(() => verifyLoadProfileMeasurement(summary, { routeIds: routes, paths }), /cannot qualify/u);
        const shortWork = structuredClone(summary.runtime);
        const retained = new Set(shortWork.expectedRequests.slice(0, policy.declared.concurrency * policy.declared.rounds - 1).map((r) => r.sampleId));
        shortWork.samples = shortWork.samples.filter((s) => retained.has(s.sampleId));
        shortWork.expectedRequests = shortWork.expectedRequests.filter((r) => retained.has(r.sampleId));
        shortWork.dispatches = shortWork.dispatches.filter((r) => retained.has(r.sampleId));
        assert.ok(loadWindowFailures(shortWork).includes('load-minimum-completed-requests-not-reached'));
        for (const mutate of [
            (s) =>
            {
                s.runtime.window.observedActiveWindowMs = policy.declared.durationMs - 1;
            },
            (s) =>
            {
                s.runtime.window.peakInFlight /= 2;
            },
            (s) =>
            {
                s.runtime.window.workers[0].readyMonotonicMs = s.runtime.window.measurementStart + 1;
            },
            (s) =>
            {
                s.runtime.dispatches[0].startedMonotonicMs = s.runtime.window.deadline;
            },
            (s) =>
            {
                s.runtime.samples.pop();
            },
            (s) =>
            {
                s.runtime.dispatches[0].routeId = routes[1];
            },
            (s) =>
            {
                s.metrics.errorRate = 1;
            },
            (s) =>
            {
                s.resourceSamples[0].observedMonotonicMs = s.runtime.window.measurementStart + 1;
            },
            (s) =>
            {
                s.resourceSamples.at(-1).observedMonotonicMs = s.runtime.window.finishedMonotonicMs - 1;
            },
            (s) =>
            {
                s.resourceSamples[1].observedMonotonicMs =
                    (s.resourceSamples[0].observedMonotonicMs + s.runtime.window.measurementStart) / 2;
            }
        ])
        {
            const invalid = structuredClone(summary);
            mutate(invalid);
            invalid.contentDigest = digestValue(invalid);
            assert.throws(() => verifyLoadProfileMeasurement(invalid, { routeIds: routes, paths, requireBoundIdentity: false }));
        }
        context.diagnostic(JSON.stringify({ profile, workerCount: summary.runtime.window.workerCount,
            peakInFlight: summary.runtime.window.peakInFlight, observedActiveWindowMs: summary.runtime.window.observedActiveWindowMs,
            totalElapsedMs: summary.runtime.window.totalElapsedMs, sampleCount: summary.sampleCount, samplesDigest: summary.samplesDigest,
            resourceSampleCount: summary.resourceSamples.length, qualificationEligible: summary.qualificationEligible,
            rps: summary.metrics.rps, window: { ...summary.runtime.window, workers: undefined },
            resourceSamples: summary.resourceSamples, resourceObservability: summary.resourceObservability }));
        const shifted = structuredClone(summary);
        for (const reading of shifted.resourceSamples)
        {
            reading.observedMonotonicMs += 1000000;
        }
        shifted.contentDigest = digestValue(shifted);
        context.diagnostic(JSON.stringify({ profile, mutation: 'resource-curve-shifted-outside-window',
            window: summary.runtime.window, firstResourceMs: summary.resourceSamples[0].observedMonotonicMs,
            shiftedFirstResourceMs: shifted.resourceSamples[0].observedMonotonicMs }));
        assert.throws(() => verifyLoadProfileMeasurement(shifted, { routeIds: routes, paths,
            requireBoundIdentity: false }), /resource sample curve/u);
    });
}
