import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';

import {
    admitPublicShellLocaleHarness,
    bindPublicShellLocaleResourceBarrier,
    createPublicShellLocaleResourceBarrier,
    observePublicShellLocaleProbe,
    projectPublicShellLocaleProbeObservation
// eslint-disable-next-line import-x/no-relative-parent-imports -- Exercise the canonical Browser Contract locale harness facade.
} from '../browser-contract/public-shell-locale-harness.mjs';

test('missing formal readiness rejects before any fixture/browser callback', async () =>
{
    for (const status of [undefined, 'preparing', 'prepare-failure', 'cleaned'])
    {
        await assert.rejects(admitPublicShellLocaleHarness({
            env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract' },
            prepared: { lifecycle: { status } }
        }), /formal host\/fixture preparation/u);
    }
    await assert.rejects(admitPublicShellLocaleHarness({
        env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'legacy-parallel' }
    }), /canonical browser-contract mode/u);
    await assert.rejects(admitPublicShellLocaleHarness({
        env: { FSUSBLOG_PLAYWRIGHT_SESSION_MODE: 'browser-contract' },
        prepared: { lifecycle: { status: 'prepared' } }
    }), /current-run prepared fixture identity/u);
});

test('probe serialization discards raw body, headers, cookies and custom text', () =>
{
    const catalog = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Localization/locale-catalog.json', import.meta.url)));
    const code = catalog.defaultCode;
    const secret = 'private-cookie-token-personal-data';
    const input = {
        firstResponse: {
            status: 200, contentType: `text/html; private=${secret}`, contentLanguage: code,
            bodyDigest: 'a'.repeat(64), bodyBytes: 100,
            body: secret, headers: { 'set-cookie': secret, authorization: secret }
        },
        observed: {
            language: code, title: secret, selectorLocales: [code], activeLocales: [code],
            hydrated: 'true', fontsStatus: 'loaded',
            fonts: [{ family: secret, weight: secret, status: 'loaded' }],
            resourceCount: 1, cookies: [{ value: secret }]
        }
    };
    const result = projectPublicShellLocaleProbeObservation(input, catalog);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(result.firstResponse.contentType, 'text/html');
    assert.equal(result.observed.titleDigest.length, 64);
    const invalidLocale = structuredClone(input);
    invalidLocale.firstResponse.contentLanguage = secret;
    assert.throws(() => projectPublicShellLocaleProbeObservation(invalidLocale, catalog), /noncatalog locale/u);
    const invalidType = structuredClone(input);
    invalidType.firstResponse.contentType = 'application/json';
    assert.throws(() => projectPublicShellLocaleProbeObservation(invalidType, catalog), /must be HTML/u);
});

test('observer event subscriptions are removed on explicit cleanup, page close and abort', async () =>
{
    // Only listener lifecycle is simulated here; no DOM/HTML or browser observations are fabricated.
    for (const end of ['dispose', 'close', 'abort'])
    {
        const events = new EventEmitter();
        const controller = new AbortController();
        const probe = observePublicShellLocaleProbe(events, {}, { signal: controller.signal });
        assert.equal(events.eventNames().length, 6);
        if (end === 'dispose')
        {
            probe.dispose();
        }
        if (end === 'close')
        {
            events.emit('close');
        }
        if (end === 'abort')
        {
            controller.abort();
        }
        assert.deepEqual(events.eventNames(), []);
        probe.dispose();
        await assert.rejects(probe.finish(), /already disposed/u);
    }
    const controller = new AbortController();
    controller.abort();
    const events = new EventEmitter();
    assert.throws(() => observePublicShellLocaleProbe(events, {}, { signal: controller.signal }), /after abort/u);
    assert.deepEqual(events.eventNames(), []);
});

// This is a loopback HTTP adapter for resource-boundary unit tests, not a browser receipt.
async function loopbackResourceContext(t)
{
    const bindings = [];
    const failures = [];
    const server = http.createServer((request, response) =>
    {
        const url = new URL(request.url, `http://127.0.0.1:${server.address().port}`);
        const binding = bindings.find((item) => item.matches(url));
        const original = () =>
        {
            response.writeHead(200, { 'Content-Type': 'text/plain' });
            response.end('original resource');
        };
        if (!binding)
        {
            original();
            return;
        }
        Promise.resolve(binding.handler({
            continue: original,
            abort: () => response.destroy(),
            fulfill: ({ status, contentType = 'text/plain', body }) =>
            {
                response.writeHead(status, { 'Content-Type': contentType });
                response.end(body);
            }
        })).catch((error) =>
        {
            failures.push(error);
            response.destroy();
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        assert.deepEqual(failures, []);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/locale-resource`,
        context: {
            route(matches, handler)
            {
                bindings.push({ matches, handler });
            },
            unroute(matches, handler)
            {
                const index = bindings.findIndex((item) => item.matches === matches && item.handler === handler);
                assert.notEqual(index, -1, 'cleanup must unregister the exact binding');
                bindings.splice(index, 1);
            }
        }
    };
}

for (const action of [
    { kind: 'continue' },
    { kind: 'http-error', status: 409 },
    { kind: 'invalid-content', body: '{invalid-artifact', contentType: 'application/json' },
    { kind: 'abort' }
])
{
    test(`HTTP binding executes ${action.kind} only for the exact resource and restores traffic on cleanup`, async (t) =>
    {
        const { context, url } = await loopbackResourceContext(t);
        const barrier = createPublicShellLocaleResourceBarrier();
        const cleanup = await bindPublicShellLocaleResourceBarrier(context, url, barrier);
        t.after(() => barrier.close());
        const unrelated = await fetch(`${url}?different-identity=1`);
        assert.equal(await unrelated.text(), 'original resource');
        let completed = false;
        const result = fetch(url).then(async (response) =>
        {
            completed = true;
            return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() };
        }, (error) =>
        {
            completed = true;
            return { error };
        });
        await barrier.entered;
        assert.equal(completed, false);
        barrier.release(action);
        const observed = await result;
        if (action.kind === 'abort')
        {
            assert.ok(observed.error);
        }
        else
        {
            assert.equal(observed.status, action.status ?? 200);
            assert.equal(observed.body, action.kind === 'continue' ? 'original resource' : action.body ?? '');
            assert.equal(observed.contentType, action.contentType ?? 'text/plain');
        }
        await cleanup();
        const restored = await fetch(url);
        assert.equal(restored.status, 200);
        assert.equal(await restored.text(), 'original resource');
    });
}

test('HTTP binding cleanup aborts a pending request without waiting for an artificial delay', async (t) =>
{
    const { context, url } = await loopbackResourceContext(t);
    const barrier = createPublicShellLocaleResourceBarrier();
    const cleanup = await bindPublicShellLocaleResourceBarrier(context, url, barrier);
    const outcome = fetch(url).then(() => 'unexpected-response', () => 'aborted');
    await barrier.entered;
    await cleanup();
    assert.equal(await outcome, 'aborted');
    assert.equal(await (await fetch(url)).text(), 'original resource');
});

test('resource barrier delays a real loopback HTTP response until explicitly released', async (t) =>
{
    const barrier = createPublicShellLocaleResourceBarrier();
    const server = http.createServer(async (_request, response) =>
    {
        const action = await barrier.wait();
        response.writeHead(action.kind === 'http-error' ? action.status : 200);
        response.end('local resource-boundary test');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () =>
    {
        barrier.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    let completed = false;
    const request = http.get(`http://127.0.0.1:${server.address().port}/domain-resource`);
    const responsePromise = once(request, 'response').then(([response]) =>
    {
        completed = true;
        response.resume();
        return response;
    });
    await barrier.entered;
    assert.equal(completed, false);
    barrier.release({ kind: 'http-error', status: 503 });
    const response = await responsePromise;
    assert.equal(response.statusCode, 503);
    await once(response, 'end');
    assert.equal(completed, true);
    await assert.rejects(barrier.wait(), /duplicate requests/u);
});

test('cleanup unblocks a pending resource and duplicate or invalid actions fail closed', async () =>
{
    const barrier = createPublicShellLocaleResourceBarrier();
    const pending = barrier.wait();
    await barrier.entered;
    assert.throws(() => barrier.release({ kind: 'unknown' }), /unknown resource action/u);
    assert.throws(() => barrier.release({ kind: 'http-error', status: 200 }), /failure status/u);
    barrier.close();
    assert.deepEqual(await pending, { kind: 'abort' });
    await assert.rejects(barrier.wait(), /closed/u);
    assert.throws(() => barrier.release(), /already settled/u);
});
