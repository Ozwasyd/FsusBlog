import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { loadPublicShellLocaleDomainBindings, loadPublicShellLocalePreferenceBindings } = await import(new URL('../browser-contract/public-shell-locale-runtime-bindings.mjs', import.meta.url));
const {
    assertPublicShellLocaleFaultBinding, assertPublicShellLocaleFontIdentity, assertPublicShellLocaleHydrationMark,
    assertPublicShellLocaleNoBusinessRequests, assertPublicShellLocalePreferenceOutcome,
    assertPublicShellLocaleResourceWaterfall, bindPublicShellLocaleContextEvidence,
    bindPublicShellLocaleFault: bindFaultOwner, originalCaptureLimits, readPublicShellLocalePreference,
    validatePublicShellLocaleOriginalCaptureLimits, waitForPublicShellLocaleResourceEntry
} = await import(new URL('../browser-contract/public-shell-locale-lifecycle-evidence.mjs', import.meta.url));
const { assertPublicShellLocaleRollback, assertPublicShellLocaleResponseLossCompensation,
    assertPublicShellLocaleSupersededOutcome, createPublicShellLocaleFailureAction } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-actions.mjs', import.meta.url));
const { drivePublicShellLocaleInitialHydration, withPublicShellLocaleLifecycleScene } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-binding.mjs', import.meta.url));
const { installPublicShellLocaleLifecycleRecorder, originalBrowserRecordLimits } = await import(new URL('../browser-contract/public-shell-locale-lifecycle-evidence.mjs', import.meta.url));
const { encodeAedsFrame } = await import(new URL('../frontend/support/aeds-envelope.mjs', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const protocol = JSON.parse(readFileSync(new URL('../../src/shared/Contracts/Validation/aeds-protocol.json', import.meta.url)));
const preference = await loadPublicShellLocalePreferenceBindings(root);
const domains = await loadPublicShellLocaleDomainBindings(root);

test('original browser recorder exports unchanged limits and installer consumes the same values (Node model)', async () =>
{
    assert.deepEqual(originalBrowserRecordLimits, { frames: 2048, records: 4096, recordBytes: 65536, totalBytes: 16777216 });
    assert.equal(Object.isFrozen(originalBrowserRecordLimits), true);
    const { runInNewContext } = await import('node:vm');
    const callbacks = new Map();
    let frame;
    let tick = 0;
    const window = { TextEncoder, performance: { now: () => tick++ }, document: { querySelector: () => ({}) },
        requestAnimationFrame: callback =>
        {
            frame = callback;
            return 1;
        }, cancelAnimationFrame: () =>
        {}, addEventListener: (name, callback) => callbacks.set(name, callback), removeEventListener: name => callbacks.delete(name),
        PerformanceObserver: class
        {
            observe()
            {}
            disconnect()
            {}
        } };
    const accessed = new Set();
    const recordLimits = Object.fromEntries(Object.keys(originalBrowserRecordLimits).map(key => [key,
        { get: () =>
        {
            accessed.add(key);
            return originalBrowserRecordLimits[key];
        } }]));
    const policy = Object.defineProperties({}, recordLimits);
    runInNewContext(`(${installPublicShellLocaleLifecycleRecorder.toString()})(readDom,policy)`,
        { window, policy, readDom: () => ({ tick }) });
    for (let index = 0; index <= originalBrowserRecordLimits.frames; index += 1)
    {
        frame();
    }
    const state = window.__fsusblogLocaleLifecycleEvidence.state;
    assert.equal(state.frames.length, originalBrowserRecordLimits.frames);
    assert.equal(state.overflow, true);
    for (let index = 0; index <= originalBrowserRecordLimits.records; index += 1)
    {
        callbacks.get('fsus:telemetry')({ detail: { name: 'locale_runtime_phase', detail: { generation: index, locale: 'en-US' } } });
    }
    assert.equal(state.events.length, originalBrowserRecordLimits.records);
    assert.deepEqual([...accessed].sort(), Object.keys(originalBrowserRecordLimits).sort());
    window.__fsusblogLocaleLifecycleEvidence.dispose();
    assert.equal(callbacks.size, 0);
});

test('original browser installer receives the exact serialized authority and retains original overflow behavior (Node model)', async () =>
{
    const model = originalCaptureModel();
    let script;
    model.context.addInitScript = async ({ content }) => script = content;
    const observer = await bindPublicShellLocaleContextEvidence({ context: model.context, bindings: model.bindings, scene: model.scene });
    assert.ok(script.includes(`,${JSON.stringify(originalBrowserRecordLimits)});`));
    await observer.dispose();
    const { runInNewContext } = await import('node:vm');
    let frame;
    const window = { TextEncoder, document: { querySelector: () => ({}) }, performance: { now: () => 1 },
        requestAnimationFrame: callback => frame = callback, cancelAnimationFrame: () =>
        {}, addEventListener: () =>
        {}, removeEventListener: () =>
        {}, PerformanceObserver: class
        {
            observe()
            {}
            disconnect()
            {}
        } };
    runInNewContext(`(${installPublicShellLocaleLifecycleRecorder.toString()})(readDom,policy)`,
        { window, policy: originalBrowserRecordLimits, readDom: () => ({ title: 'x'.repeat(originalBrowserRecordLimits.recordBytes) }) });
    frame();
    assert.equal(window.__fsusblogLocaleLifecycleEvidence.state.frames.length, 0);
    assert.equal(window.__fsusblogLocaleLifecycleEvidence.state.overflow, true);
    window.__fsusblogLocaleLifecycleEvidence.dispose();
});

// Existing route models now supply the same observer capability and locked Playwright header accessors.
// These native-event adapters add no request, forwarding, retry or replacement assertion.
async function bindPublicShellLocaleFault(input)
{
    const model = originalCaptureModel();
    const context = input.context;
    const bindings = { ...input.bindings, preference: input.bindings.preference ?? preference,
        identity: input.bindings.identity ?? model.bindings.identity };
    const events = new Map();
    context.on = (name, callback) => events.set(name, callback);
    context.off = (name) => events.delete(name);
    context.pages = () => [];
    context.addInitScript = async () =>
    {};
    const apiHeaders = (response) =>
    {
        response.headersArray ??= () => Object.entries(response.headers()).map(([name, value]) => ({ name, value }));
        response.dispose ??= async () =>
        {};
        return response;
    };
    if (context.request)
    {
        const get = context.request.get;
        context.request.get = async (...args) => apiHeaders(await get(...args));
    }
    const route = context.route;
    context.route = async (matches, handler) => await route(matches, async (incoming) =>
    {
        const request = incoming.request();
        request.url ??= () => input.url;
        request.resourceType ??= () => 'fetch';
        request.headersArray ??= async () => Object.entries(request.allHeaders ? await request.allHeaders()
            : { Accept: preference.mediaType }).map(([name, value]) => ({ name, value }));
        // Abort-only legacy models previously did not expose a transport buffer.
        request.postDataBuffer ??= () => Buffer.from(preference.encodeRequest('fixed', input.scene?.locale ?? 'ja-JP', 0));
        incoming.request = () => request;
        events.get('request')(request);
        if (incoming.fetch)
        {
            const fetch = incoming.fetch;
            incoming.fetch = async (...args) => apiHeaders(await fetch(...args));
        }
        return await handler(incoming);
    });
    const observer = await bindPublicShellLocaleContextEvidence({ context, bindings,
        scene: { ...input.scene, id: input.scene?.id ?? 'legacy-route-model' } });
    const fault = await bindFaultOwner({ ...input, bindings, scene: input.scene ? { ...input.scene, id: observer.rawCapture.sceneId } : undefined,
        rawCapture: observer.rawCapture });
    let disposal;
    return { ...fault, modelObserver: observer, dispose: () =>
    {
        disposal ??= (async () =>
        {
            await fault.dispose();
            await observer.dispose();
        })();
        return disposal;
    } };
}

// These are deterministic checker self-tests, not evidence of an executed browser scene.
for (const locale of preference.locales)
{
    test(`real production request encoder/inspector round-trip: ${locale.code}`, () =>
    {
        assert.deepEqual(preference.inspectRequest(preference.encodeRequest('fixed', locale.code, 17)),
            { mode: 'fixed', fixedLocale: locale.code, expectedRevision: 17 });
    });
}

test('first-response HTTP capture drains original document bytes without any JavaScript recorder (Node model)', async () =>
{
    const model = originalCaptureModel();
    model.scene = { ...model.scene, issue: 2083, stage: 'first-response' };
    model.context.addInitScript = async () => assert.fail('JS-disabled scene must not install a recorder');
    model.page.evaluate = async () => assert.fail('JS-disabled scene must not evaluate a recorder or paints');
    const observer = await bindPublicShellLocaleContextEvidence(model);
    model.pages.push(model.page);
    model.listeners.get('page')(model.page);
    const request = model.request('GET', null, 'http://127.0.0.1/', 'document');
    const body = Promise.withResolvers();
    model.listeners.get('request')(request);
    model.listeners.get('response')(model.response(request, () => body.promise));
    const captured = observer.captureFirstResponse();
    body.resolve(Buffer.from('<html lang="ja-JP">original publication</html>'));
    const evidence = await captured;
    const originals = observer.rawCapture.snapshot(evidence.captureCut);

    assert.equal(evidence.requests.length, 1);
    assert.equal(evidence.responses.length, 1);
    assert.equal(evidence.responses[0].requestOrdinal, 0);
    assert.equal(Object.hasOwn(evidence, 'browser'), false);
    assert.equal(Object.hasOwn(evidence, 'checked'), false);
    assert.equal(JSON.stringify(evidence).includes('bodyBase64'), false);
    assert.equal(JSON.stringify(evidence).includes('private-a'), false);
    assert.equal(originals.captureCut, evidence.captureCut);
    assert.deepEqual(originals.binding.identity, model.bindings.identity);
    assert.equal(originals.binding.sceneId, model.scene.id);
    assert.equal(Buffer.from(originals.originals.find(item => item.kind === 'response').bodyBase64, 'base64').toString(),
        '<html lang="ja-JP">original publication</html>');
    assert.equal(Object.isFrozen(evidence.responses[0]), true);
    await observer.dispose();
    assert.equal(model.listeners.size, 0);
});

test('first-response HTTP capture freezes the actual cut and retains unfiltered warnings (Node model)', async () =>
{
    const model = originalCaptureModel();
    model.scene = { ...model.scene, issue: 2083, stage: 'first-response' };
    const callbacks = new Map();
    model.page.on = (name, callback) => callbacks.set(name, callback);
    model.page.off = name => callbacks.delete(name);
    model.page.evaluate = async () => assert.fail('no DOM/paint recorder on first response');
    const observer = await bindPublicShellLocaleContextEvidence(model);
    model.pages.push(model.page);
    model.listeners.get('page')(model.page);
    const request = model.request('GET', null, 'http://127.0.0.1/', 'document');
    model.listeners.get('request')(request);
    const body = Promise.withResolvers();
    model.listeners.get('response')(model.response(request, () => body.promise));
    callbacks.get('console')({ type: () => 'warning', text: () => 'original first-response warning', location: () => ({ url: '' }) });
    const capturing = observer.captureFirstResponse();
    const later = model.request('GET', null, 'http://127.0.0.1/about', 'document');
    model.listeners.get('request')(later);
    model.listeners.get('response')(model.response(later, Buffer.from('later publication')));
    body.resolve(Buffer.from('first publication'));
    const evidence = await capturing;
    assert.equal(evidence.requests.length, 1);
    assert.equal(evidence.responses.length, 1);
    assert.equal(evidence.issues.length, 1);
    assert.equal(evidence.issues[0].kind, 'warning');
    const saved = JSON.stringify(evidence);
    const original = observer.rawCapture.snapshot(evidence.captureCut);
    assert.equal(original.originals.filter(item => item.kind === 'response').length, 1);
    assert.equal((await observer.captureFirstResponse()).responses.length, 2);
    assert.equal(JSON.stringify(evidence), saved);
    await observer.dispose();
    assert.equal(callbacks.size, 0);
});

test('first-response HTTP capture retains incomplete raw evidence and cleanup failure without a recorder (Node model)', async () =>
{
    const model = originalCaptureModel();
    model.scene = { ...model.scene, issue: 2083, stage: 'first-response' };
    model.page.evaluate = async () => assert.fail('no recorder evaluation for failed first response');
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('GET', null, 'http://127.0.0.1/', 'document');
    model.listeners.get('request')(request);
    model.listeners.get('response')(model.response(request, () =>
    {
        throw new Error('actual document body read failed');
    }));
    await assert.rejects(observer.captureFirstResponse(), error =>
    {
        assert.equal(Object.hasOwn(error.evidence, 'browser'), false);
        const original = observer.rawCapture.snapshot(error.evidence.captureCut).originals.find(item => item.kind === 'response');
        assert.equal(original.captureState, 'read-failed');
        assert.equal(Object.hasOwn(original, 'bodyBase64'), false);
        assert.ok(original.headersArray.length > 0);
        return true;
    });
    await assert.rejects(observer.captureFirstResponse());
    await assert.rejects(observer.dispose());
    assert.equal(model.listeners.size, 0);
});

test('first-response HTTP capture cannot replace hydrated-stage recorder requirements (Node model)', async () =>
{
    const model = originalCaptureModel();
    model.scene = { ...model.scene, issue: 2084, stage: 'initial-hydration' };
    const observer = await bindPublicShellLocaleContextEvidence(model);
    await assert.rejects(observer.captureFirstResponse(), /first-response scene required/u);
    const first = new Error('real hydrated recorder unavailable');
    model.page.evaluate = async () =>
    {
        throw first;
    };
    await assert.rejects(observer.capture(model.page), error => error === first);
    await observer.dispose();
});

for (const fails of [false, true])
{
    test(`first-response HTTP capture wrapper preserves actual lease/read closure and original failure: ${fails} (Node model)`, async () =>
    {
        const model = originalCaptureModel();
        model.scene = { ...model.scene, issue: 2083, stage: 'first-response' };
        model.context.addInitScript = async () => assert.fail('first response must not install JavaScript');
        model.page.evaluate = async () => assert.fail('first response must not inspect JavaScript');
        const lease = Object.freeze({ id: 'actual-first-response-model-lease' });
        const readPublishedArtifact = async () => assert.fail('wrapper must pass the read closure, not invoke it');
        const first = new Error('first response product failure');
        const records = [];
        let closed = false;
        const harness = { identity: model.bindings.identity, withScene: async (_, factory, operation) =>
        {
            await factory(lease);
            try
            {
                return await operation({ context: model.context, fixture: {}, negotiation: {}, lease, readPublishedArtifact });
            }
            finally
            {
                closed = true;
            }
        } };
        const run = withPublicShellLocaleLifecycleScene({ harness, sceneId: model.scene.id,
            matrix: { contentDigest: model.bindings.identity.matrixDigest, scenes: [model.scene] }, bindings: model.bindings,
            createContext: async actualLease =>
            {
                assert.equal(actualLease, lease);
                return model.context;
            }, observe: async input =>
            {
                assert.equal(input.lease, lease);
                assert.equal(input.readPublishedArtifact, readPublishedArtifact);
                model.pages.push(model.page);
                model.listeners.get('page')(model.page);
                const request = model.request('GET', null, 'http://127.0.0.1/', 'document');
                model.listeners.get('request')(request);
                model.listeners.get('response')(model.response(request, Buffer.from('actual first response')));
                if (fails)
                {
                    throw first;
                }
                return 'observed-first-response';
            }, saveEvidence: async record =>
            {
                assert.equal(closed, false);
                assert.equal(record.lease, lease);
                assert.equal(Object.hasOwn(record.evidence, 'browser'), false);
                assert.equal(record.privateOriginals.captureCut, record.evidence.captureCut);
                records.push(record);
                if (fails)
                {
                    throw new Error('secondary evidence sink failure');
                }
            } });
        if (fails)
        {
            await assert.rejects(run, error => error === first);
        }
        else
        {
            assert.equal(await run, 'observed-first-response');
        }
        assert.equal(records.length, 2);
        assert.equal(records[0].evidence.responses.length, 1);
        assert.equal(records[1].evidence.phase, 'observer-disposal');
        assert.equal(closed, true);
        assert.equal(model.listeners.size, 0);
    });
}

function originalCaptureModel(limits)
{
    const listeners = new Map();
    const identity = { matrixDigest: 'original-capture-model' };
    const bindings = { identity, preference, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' };
    const pages = [];
    const context = { on: (name, callback) => listeners.set(name, callback), off: (name) => listeners.delete(name),
        pages: () => pages, addInitScript: async () =>
        {}, cookies: async () => [] };
    const page = { on: () =>
    {}, off: () =>
    {}, isClosed: () => false,
    evaluate: async (callback) => callback.toString().includes('performance:')
        ? { recorder: { frames: [], marks: [], events: [], errors: [], overflow: false }, performance: [], preloads: [] } : undefined };
    const request = (method, body = null, url = bindings.preferenceUrl, type = 'fetch') => ({
        method: () => method, postDataBuffer: () => body, url: () => url, resourceType: () => type,
        headersArray: async () => [{ name: 'Accept', value: preference.mediaType }] });
    const response = (request, body, status = 200) => ({ request: () => request, url: request.url, status: () => status,
        dispose: async () =>
        {},
        fromServiceWorker: () => false, headers: () => ({ 'content-type': preference.mediaType, 'cache-control': 'no-store' }),
        headersArray: async () => [{ name: 'Content-Type', value: preference.mediaType }, { name: 'Cache-Control', value: 'no-store' },
            { name: 'Set-Cookie', value: 'private-a' }, { name: 'Set-Cookie', value: 'private-b' }],
        body: async () => typeof body === 'function' ? await body() : body });
    return { context, page, pages, listeners, bindings, request, response, limits, scene: { id: 'original-capture-scene' } };
}

test('original capture retains aborted command bytes separately from public evidence', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const bytes = Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0));
    const original = Buffer.from(bytes);
    model.listeners.get('request')(model.request('PUT', bytes));
    bytes.fill(0);
    const evidence = await observer.capture(model.page);
    const privateOriginals = observer.rawCapture.snapshot(evidence.captureCut);
    assert.equal(privateOriginals.originals[0].bodyBase64, original.toString('base64'));
    assert.equal(JSON.stringify(evidence).includes('bodyBase64'), false);
    assert.equal(JSON.stringify(evidence).includes('private-a'), false);
    await observer.dispose();
});

test('original capture separates actual headers and error bytes before decoder failure', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
    model.listeners.get('request')(request);
    const malformed = Buffer.from([1, 2, 3]);
    model.listeners.get('response')(model.response(request, malformed, 409));
    await assert.rejects(observer.capture(model.page), (error) =>
    {
        const raw = observer.rawCapture.snapshot(error.evidence.captureCut);
        const response = raw.originals.find((item) => item.kind === 'response');
        assert.equal(response.bodyBase64, malformed.toString('base64'));
        assert.equal(response.headersArray.filter((item) => item.name === 'Set-Cookie').length, 2);
        assert.equal(response.status, 409);
        return true;
    });
    await assert.rejects(observer.dispose());
});

test('original capture cuts exclude new pending records and cannot mutate after await', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const first = model.request('GET');
    model.listeners.get('request')(first);
    const deferred = Promise.withResolvers();
    model.listeners.get('response')(model.response(first, () => deferred.promise));
    const captured = observer.capture(model.page);
    const second = model.request('GET');
    model.listeners.get('request')(second);
    model.listeners.get('response')(model.response(second, Buffer.from(responseFrame())));
    deferred.resolve(Buffer.from(responseFrame()));
    const evidence = await captured;
    assert.equal(evidence.responses.length, 1);
    const saved = JSON.stringify(evidence);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    await observer.capture(model.page);
    assert.equal(JSON.stringify(evidence), saved);
    assert.equal(raw.originals.filter((item) => item.kind === 'response').length, 1);
    assert.equal(Object.isFrozen(evidence.responses[0]), true);
    await observer.dispose();
});

test('original capture null command and overflow remain sticky fail closed', async () =>
{
    for (const body of [null, Buffer.alloc(65)])
    {
        const model = originalCaptureModel({ bodyBytes: 64 });
        const observer = await bindPublicShellLocaleContextEvidence(model);
        model.listeners.get('request')(model.request('PUT', body));
        await assert.rejects(observer.capture(model.page));
        model.listeners.get('request')(model.request('GET'));
        await assert.rejects(observer.capture(model.page));
        await assert.rejects(observer.dispose());
    }
});

test('original capture formal GET requires same context capability before any request', async () =>
{
    const model = originalCaptureModel();
    let gets = 0;
    model.context.request = { get: async () =>
    {
        gets += 1;
        return model.response(model.request('GET'), Buffer.from(responseFrame()));
    } };
    await assert.rejects(readPublicShellLocalePreference(model.context, model.bindings), /capture/u);
    assert.equal(gets, 0);
    const observer = await bindPublicShellLocaleContextEvidence(model);
    await readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: observer.rawCapture });
    const raw = observer.rawCapture.snapshot();
    assert.equal(raw.originals.find((item) => item.kind === 'response').source, 'api-request');
    await assert.rejects(readPublicShellLocalePreference({ ...model.context }, model.bindings, { rawCapture: observer.rawCapture }));
    assert.equal(gets, 1);
    await observer.dispose();
});

test('original capture initialization rollback detaches all installed listeners', async () =>
{
    const model = originalCaptureModel();
    const first = new Error('init failure');
    model.context.addInitScript = async () =>
    {
        throw first;
    };
    await assert.rejects(bindPublicShellLocaleContextEvidence(model), (error) => error === first);
    assert.equal(model.listeners.size, 0);
});

test('original capture HTML is byte exact and business response bodies are never read', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const document = model.request('GET', null, 'http://127.0.0.1/article', 'document');
    const html = Buffer.from('<html lang="ja"><body>原文\u0000</body></html>');
    model.listeners.get('request')(document);
    model.listeners.get('response')(model.response(document, html));
    const business = model.request('GET', null, 'http://127.0.0.1/api/binary/articles/1', 'fetch');
    let reads = 0;
    model.listeners.get('request')(business);
    model.listeners.get('response')(model.response(business, () =>
    {
        reads += 1;
        throw new Error('must not read business');
    }));
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    assert.equal(raw.originals.find((item) => item.kind === 'response').bodyBase64, html.toString('base64'));
    assert.equal(evidence.requests.length, 2);
    assert.equal(evidence.responses.length, 2);
    assert.equal(reads, 0);
    await observer.dispose();
});

test('original capture actual empty body is retained, not substituted for a missing command', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    model.listeners.get('request')(model.request('PUT', Buffer.alloc(0)));
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    assert.equal(raw.originals[0].bodyBase64, '');
    assert.equal(raw.originals[0].byteLength, 0);
    assert.equal(raw.originals[0].captureState, 'observed');
    await observer.dispose();
});

test('original capture missing header accessor is fatal but keeps actual body', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('GET');
    const response = model.response(request, Buffer.from(responseFrame()));
    delete response.headersArray;
    model.listeners.get('request')(request);
    model.listeners.get('response')(response);
    await assert.rejects(observer.capture(model.page));
    const captured = observer.rawCapture.snapshot().originals.find((item) => item.kind === 'response');
    assert.equal(captured.bodyBase64, Buffer.from(responseFrame()).toString('base64'));
    assert.equal(captured.captureState, 'read-failed');
    await assert.rejects(observer.dispose());
});

test('original capture repeated identical PUTs remain independent with actual request ordinals', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const command = Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0));
    for (let index = 0; index < 2; index += 1)
    {
        const request = model.request('PUT', command);
        model.listeners.get('request')(request);
        model.listeners.get('response')(model.response(request, Buffer.from(fixedResponseFrame('ja-JP', 0))));
    }
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    assert.deepEqual(raw.originals.filter((item) => item.kind === 'request').map((item) => item.requestOrdinal), [0, 1]);
    assert.deepEqual(evidence.responses.map((item) => item.requestOrdinal), [0, 1]);
    assert.equal(raw.originals.filter((item) => item.kind === 'request').length, 2);
    await observer.dispose();
});

test('original capture records API invocation before its asynchronous response resolves', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const result = Promise.withResolvers();
    model.context.request = { get: () => result.promise };
    const get = readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: observer.rawCapture });
    const pending = observer.rawCapture.snapshot();
    assert.equal(pending.originals[0].kind, 'invocation');
    assert.equal(pending.originals[0].captureState, 'pending');
    const capture = observer.capture(model.page);
    result.resolve(model.response(model.request('GET'), Buffer.from(responseFrame())));
    const [evidence, preferenceResult] = await Promise.all([capture, get]);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    const response = raw.originals.find((item) => item.kind === 'response');
    assert.equal(response.invocationOrdinal, preferenceResult.response.invocationOrdinal);
    await observer.dispose();
});

test('original capture leaf total header and metadata limits fail closed without truncated positives', async () =>
{
    for (const limits of [{ totalBytes: 32 }, { leaves: 1 }, { headers: 1 }, { headerBytes: 8 }, { records: 1 }])
    {
        const model = originalCaptureModel(limits);
        const observer = await bindPublicShellLocaleContextEvidence(model);
        for (let index = 0; index < 2; index += 1)
        {
            const request = model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
            model.listeners.get('request')(request);
            model.listeners.get('response')(model.response(request, Buffer.from(fixedResponseFrame('ja-JP', 0))));
        }
        await assert.rejects(observer.capture(model.page));
        const raw = observer.rawCapture.snapshot();
        assert.ok(raw.failures.length > 0);
        assert.ok(raw.originals.length <= (limits.leaves ?? 256));
        await assert.rejects(observer.dispose());
    }
});

test('original capture disposal drains through recorder failure and preserves actual failure', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const first = new Error('recorder dispose first');
    let secondDisposed = false;
    const firstPage = { ...model.page, evaluate: async () =>
    {
        throw first;
    } };
    const secondPage = { ...model.page, evaluate: async () =>
    {
        secondDisposed = true;
    } };
    model.listeners.get('page')(firstPage);
    model.listeners.get('page')(secondPage);
    const request = model.request('GET');
    model.listeners.get('request')(request);
    const body = Promise.withResolvers();
    model.listeners.get('response')(model.response(request, () => body.promise));
    const disposed = observer.dispose();
    assert.equal(observer.dispose(), disposed);
    body.resolve(Buffer.from(responseFrame()));
    await assert.rejects(disposed, (error) => error === first);
    assert.equal(secondDisposed, true);
    assert.equal(model.listeners.size, 0);
    assert.equal(observer.rawCapture.snapshot().originals.find((item) => item.kind === 'response').captureState, 'observed');
});

for (const mode of ['lost', 'stale', 'late'])
{
    test(`original capture native ${mode} keeps four calls and distinguishes original from supplied delivery`, async () =>
    {
        const input = nativeDeliveryFixture(mode);
        const action = await createPublicShellLocaleFailureAction(input);
        const fault = await bindPublicShellLocaleFault({ ...input, action });
        const work = input.handler()(input.route);
        const before = await fault.serverObserved;
        assert.deepEqual(before.nativeRequests.map((item) => item.method), ['GET', 'GET', 'PUT', 'GET']);
        assert.equal(input.forwards(), 1);
        fault.release();
        await fault.completed;
        await work;
        await fault.dispose();
        const raw = fault.modelObserver.rawCapture.snapshot();
        const original = raw.originals.filter((item) => item.kind === 'response');
        assert.equal(original.length, 4);
        assert.equal(new Set(original.map((item) => item.invocationOrdinal)).size, 4);
        assert.ok(original.every((item) => item.parentRequestOrdinal === 0));
        const supplied = raw.originals.filter((item) => item.kind === 'supplied-body');
        assert.equal(supplied.length, mode === 'stale' ? 1 : 0);
        if (mode === 'stale')
        {
            assert.equal(supplied[0].bodyBase64, original[0].bodyBase64);
            assert.notEqual(supplied[0].bodyBase64, original[2].bodyBase64);
            assert.equal(supplied[0].source, 'route-input');
        }
        assert.equal(JSON.stringify(before).includes('bodyBase64'), false);
        await fault.modelObserver.dispose();
    });
}

test('original capture conflict preserves real original and forwarded commands and 409 bytes', async () =>
{
    const input = nativeDeliveryFixture('stale');
    const action = { kind: 'revision-conflict', targetLocale: input.scene.locale, currentRevision: 7 };
    input.route.fetch = async (options) =>
    {
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxRedirects, 0);
        assert.equal(options.headers, undefined);
        assert.equal(preference.inspectRequest(new Uint8Array(options.postData)).expectedRevision, 6);
        return { status: () => 409, headers: () => ({ 'content-type': preference.mediaType }), body: async () => conflictFrame() };
    };
    const fault = await bindPublicShellLocaleFault({ ...input, scene: undefined, action });
    const work = input.handler()(input.route);
    await fault.entered;
    fault.release();
    await fault.completed;
    await work;
    const raw = fault.modelObserver.rawCapture.snapshot();
    const command = raw.originals.find((item) => item.kind === 'request');
    const forwarded = raw.originals.find((item) => item.purpose === 'forwarded-command');
    assert.notEqual(command.bodyBase64, forwarded.bodyBase64);
    assert.equal(preference.inspectRequest(new Uint8Array(Buffer.from(command.bodyBase64, 'base64'))).expectedRevision, 7);
    assert.equal(raw.originals.find((item) => item.status === 409).bodyBase64, Buffer.from(conflictFrame()).toString('base64'));
    await fault.dispose();
    await fault.modelObserver.dispose();
});

test('original capture fault disposal releases held route and waits for actual abort terminal', async () =>
{
    const input = faultFixture();
    let handler;
    const aborted = Promise.withResolvers();
    let finished = false;
    input.context = { route: async (_, callback) =>
    {
        handler = callback;
    }, unroute: async () =>
    {} };
    const fault = await bindPublicShellLocaleFault(input);
    const work = handler({ request: () => ({ method: () => 'GET' }), abort: async () =>
    {
        await aborted.promise;
        finished = true;
    } });
    await fault.entered;
    const dispose = fault.dispose();
    assert.equal(fault.dispose(), dispose);
    assert.equal(finished, false);
    aborted.resolve();
    await dispose;
    await work;
    assert.equal(finished, true);
    await fault.modelObserver.dispose();
});

test('original capture full headers override no stale lightweight header cache', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const response = model.response(model.request('GET'), Buffer.from(responseFrame()));
    response.headers = () => ({ 'content-type': 'stale/lightweight-cache' });
    model.context.request = { get: async () => response };
    await readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: observer.rawCapture });
    const original = observer.rawCapture.snapshot().originals.find((item) => item.kind === 'response');
    assert.equal(original.headersArray[0].value, preference.mediaType);
    await observer.dispose();
});

test('original capture warnings and failed requests retain causal ordinals and overflow is explicit', async () =>
{
    const model = originalCaptureModel({ records: 1 });
    const callbacks = new Map();
    model.page.on = (name, callback) => callbacks.set(name, callback);
    model.page.off = (name) => callbacks.delete(name);
    const observer = await bindPublicShellLocaleContextEvidence(model);
    model.listeners.get('page')(model.page);
    const request = model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
    request.failure = () => ({ errorText: 'aborted' });
    model.listeners.get('request')(request);
    callbacks.get('requestfailed')(request);
    await observer.capture(model.page);
    callbacks.get('console')({ type: () => 'warning', text: () => 'do not filter this warning', location: () => ({ url: '' }) });
    await assert.rejects(observer.capture(model.page), (error) =>
    {
        assert.equal(error.evidence.issues[0].kind, 'requestfailed');
        assert.equal(error.evidence.issues[0].requestOrdinal, 0);
        assert.equal(observer.rawCapture.snapshot().overflow, true);
        return true;
    });
    await assert.rejects(observer.dispose());
});

test('original capture pending budget is finite and later success cannot clear it', async () =>
{
    const model = originalCaptureModel({ pending: 1 });
    const header = Promise.withResolvers();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const first = model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
    first.headersArray = () => header.promise;
    model.listeners.get('request')(first);
    model.listeners.get('request')(model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0))));
    header.resolve([{ name: 'Accept', value: preference.mediaType }]);
    await assert.rejects(observer.capture(model.page));
    assert.equal(observer.rawCapture.snapshot().overflow, true);
    await assert.rejects(observer.dispose());
});

test('original capture init cleanup failure does not replace the first init failure', async () =>
{
    const model = originalCaptureModel();
    const first = new Error('first init failure');
    const detached = [];
    model.context.addInitScript = async () =>
    {
        throw first;
    };
    model.context.off = (name) =>
    {
        detached.push(name);
        if (name === 'page')
        {
            throw new Error('second off failure');
        }
        model.listeners.delete(name);
    };
    await assert.rejects(bindPublicShellLocaleContextEvidence(model), (error) => error === first);
    assert.deepEqual(detached, ['page', 'request', 'response']);
    assert.equal(first.cleanupFailure.name, 'Error');
});

test('original capture API disposal failure attempts remaining owned response cleanup', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    let calls = 0;
    let cleaned = 0;
    const failure = new Error('first APIResponse disposal failure');
    model.context.request = { get: async () =>
    {
        const response = model.response(model.request('GET'), Buffer.from(responseFrame()));
        const ordinal = calls++;
        response.dispose = async () =>
        {
            cleaned += 1;
            if (ordinal === 0)
            {
                throw failure;
            }
        };
        return response;
    } };
    await readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: observer.rawCapture });
    await readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: observer.rawCapture });
    await assert.rejects(observer.dispose(), (error) => error === failure);
    assert.equal(cleaned, 2);
    assert.equal(model.listeners.size, 0);
    assert.ok(observer.rawCapture.snapshot().failures.some((item) => item.reason === 'api-response-disposal-failed'));
});

test('original capture context save sink separates private bytes and preserves first operation failure', async () =>
{
    const model = originalCaptureModel();
    const first = new Error('first operation error');
    const records = [];
    let closed = false;
    const harness = { identity: model.bindings.identity, withScene: async (_, create, observe) =>
    {
        await create();
        try
        {
            return await observe({ context: model.context });
        }
        finally
        {
            closed = true;
        }
    } };
    await assert.rejects(withPublicShellLocaleLifecycleScene({ harness, matrix: { contentDigest: model.bindings.identity.matrixDigest,
        scenes: [model.scene] }, bindings: model.bindings, sceneId: model.scene.id, createContext: async () => model.context,
    observe: async () =>
    {
        model.pages.push(model.page);
        model.listeners.get('page')(model.page);
        model.listeners.get('request')(model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0))));
        throw first;
    }, saveEvidence: async (record) =>
    {
        assert.equal(closed, false);
        assert.equal(JSON.stringify(record.evidence).includes('bodyBase64'), false);
        records.push(record);
        throw new Error('second sink error');
    } }), (error) => error === first);
    assert.equal(records.length, 2);
    assert.ok(records.every((record) => record.privateOriginals.originals.some((item) => item.bodyBase64)));
    assert.equal(records[1].evidence.phase, 'observer-disposal');
    assert.equal(Object.hasOwn(records[1].evidence, 'ended'), false);
    assert.equal(closed, true);
    assert.equal(model.listeners.size, 0);
});

test('original capture forged capability and foreign scene cannot create any request or route', async () =>
{
    const model = originalCaptureModel();
    let requests = 0;
    let routes = 0;
    model.context.request = { get: async () =>
    {
        requests += 1;
    } };
    model.context.route = async () =>
    {
        routes += 1;
    };
    const forged = { requireContext: () =>
    {} };
    await assert.rejects(readPublicShellLocalePreference(model.context, model.bindings, { rawCapture: forged }));
    const observer = await bindPublicShellLocaleContextEvidence(model);
    await assert.rejects(bindFaultOwner({ context: model.context, bindings: model.bindings, url: model.bindings.preferenceUrl,
        scene: { ...model.scene, id: 'foreign-scene' }, action: { kind: 'abort' }, rawCapture: observer.rawCapture }));
    assert.equal(requests, 0);
    assert.equal(routes, 0);
    await observer.dispose();
});

test('original capture response admitted during DOM evaluation belongs only to the next cut', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const entered = Promise.withResolvers();
    const rendered = Promise.withResolvers();
    const evaluate = model.page.evaluate;
    model.page.evaluate = async (callback) =>
    {
        if (callback.toString().includes('performance:'))
        {
            entered.resolve();
            await rendered.promise;
        }
        return await evaluate(callback);
    };
    const capture = observer.capture(model.page);
    await entered.promise;
    const request = model.request('GET');
    model.listeners.get('request')(request);
    model.listeners.get('response')(model.response(request, Buffer.from(responseFrame())));
    rendered.resolve();
    const previous = await capture;
    assert.equal(previous.requests.length, 0);
    assert.equal(previous.responses.length, 0);
    assert.equal(observer.rawCapture.snapshot(previous.captureCut).originals.length, 0);
    assert.equal((await observer.capture(model.page)).responses.length, 1);
    await observer.dispose();
});

test('original capture rejects invalid limits and invented cut positions', async () =>
{
    for (const limits of [{ bodyBytes: 0 }, { bodyBytes: Infinity }, { leaves: 257 }, { unknown: 1 }])
    {
        const model = originalCaptureModel(limits);
        await assert.rejects(bindPublicShellLocaleContextEvidence(model));
        assert.equal(model.listeners.size, 0);
    }
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    for (const cut of [-1, 0.5, 1, Infinity])
    {
        assert.throws(() => observer.rawCapture.snapshot(cut));
    }
    await observer.dispose();
});

test('original capture browser delivered stale bytes stay distinct from native server bytes', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
    model.listeners.get('request')(request);
    const server = Buffer.from(fixedResponseFrame('ja-JP', 1));
    await observer.rawCapture.exchange(async () => model.response(request, server),
        { source: 'route-fetch', parentRequestOrdinal: 0, method: 'PUT', url: model.bindings.preferenceUrl });
    const delivered = Buffer.from(responseFrame());
    observer.rawCapture.supplied(delivered, { requestOrdinal: 0, purpose: 'stale-delivery-input' });
    model.listeners.get('response')(model.response(request, delivered));
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    const native = raw.originals.find((item) => item.source === 'route-fetch' && item.kind === 'response');
    const browser = raw.originals.find((item) => item.source === 'browser' && item.kind === 'response');
    const input = raw.originals.find((item) => item.kind === 'supplied-body');
    assert.notEqual(native.bodyBase64, browser.bodyBase64);
    assert.equal(input.bodyBase64, browser.bodyBase64);
    assert.equal(native.parentRequestOrdinal, browser.requestOrdinal);
    assert.equal(evidence.responses[0].contentDigest, browser.byteSha256);
    assert.equal(JSON.stringify(evidence).includes('headersArray'), false);
    await observer.dispose();
});

test('original capture nested tracking reserves its bounded slot before invoking an operation', async () =>
{
    const model = originalCaptureModel({ pending: 1 });
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const body = Promise.withResolvers();
    let nestedStarts = 0;
    const work = observer.rawCapture.track(observer.rawCapture.begin(), async () =>
    {
        await observer.rawCapture.track(observer.rawCapture.begin(), async () =>
        {
            nestedStarts += 1;
            await body.promise;
        });
    });
    body.resolve();
    await work;
    const raw = observer.rawCapture.snapshot();
    assert.equal(nestedStarts, 0, 'nested callback must not start without a reserved slot');
    assert.equal(raw.overflow, true);
    assert.ok(raw.failures.some((failure) => failure.reason === 'pending-overflow'));
    await assert.rejects(observer.dispose());
});

for (const method of ['document', 'PUT'])
{
    test(`original capture nested ${method} response refuses the last-slot overshoot`, async () =>
    {
        const model = originalCaptureModel({ pending: 1 });
        const observer = await bindPublicShellLocaleContextEvidence(model);
        const request = method === 'document'
            ? model.request('GET', null, 'http://127.0.0.1/article', 'document')
            : model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0)));
        model.listeners.get('request')(request);
        await observer.rawCapture.drain();
        const body = Promise.withResolvers();
        let reads = 0;
        model.listeners.get('response')(model.response(request, () =>
        {
            reads += 1;
            return body.promise;
        }));
        body.resolve(method === 'document' ? Buffer.from('<html>actual</html>') : Buffer.from(fixedResponseFrame('ja-JP', 0)));
        await assert.rejects(observer.capture(model.page));
        assert.equal(reads, 0, 'the refused inner slot must not invoke the body callback');
        assert.equal(observer.rawCapture.snapshot().overflow, true);
        assert.ok(observer.rawCapture.snapshot().failures.some((failure) => failure.reason === 'pending-overflow'));
        await assert.rejects(observer.dispose());
    });
}

for (const recorderFails of [false, true])
{
    test(`original capture disposal timeout remains sticky after late body success recorderFirst=${recorderFails}`, async (t) =>
    {
        const model = originalCaptureModel();
        const observer = await bindPublicShellLocaleContextEvidence(model);
        const recorderError = new Error('first recorder failure before drain timeout');
        if (recorderFails)
        {
            model.page.evaluate = async () =>
            {
                throw recorderError;
            };
            model.listeners.get('page')(model.page);
        }
        const request = model.request('GET', null, 'http://127.0.0.1/article', 'document');
        model.listeners.get('request')(request);
        await observer.rawCapture.drain();
        const body = Promise.withResolvers();
        let reads = 0;
        model.listeners.get('response')(model.response(request, () =>
        {
            reads += 1;
            return body.promise;
        }));
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const disposed = observer.dispose();
        assert.equal(observer.dispose(), disposed);
        // Permit recorder rejection to reach the original drain before advancing its unchanged deadline.
        await Promise.resolve();
        t.mock.timers.tick(15000);
        let externalFailure;
        await assert.rejects(disposed, (error) =>
        {
            externalFailure = error;
            assert.equal(recorderFails ? error === recorderError : error.message === 'formal resource interception was not observed', true);
            return true;
        });
        const tail = observer.rawCapture.snapshot();
        const frozenTail = JSON.stringify(tail);
        body.resolve(Buffer.from('<html>late actual body</html>'));
        await observer.rawCapture.drain();
        const late = observer.rawCapture.snapshot();
        assert.equal(reads, 1);
        assert.equal(model.listeners.size, 0);
        assert.equal(late.originals.filter((item) => item.kind === 'response')[0].captureState, 'observed');
        assert.ok(late.failures.some((failure) => failure.reason === 'drain-incomplete'), 'timeout must remain independently visible after completion');
        assert.equal(JSON.stringify(tail), frozenTail);
        assert.throws(() => observer.rawCapture.assertComplete());
        await assert.rejects(observer.dispose(), (error) => error === externalFailure);
        assert.equal(Object.hasOwn(late, 'ended'), false);
    });
}

test('resource original capture exports the frozen single bounds policy and pure validation', () =>
{
    assert.equal(Object.isFrozen(originalCaptureLimits), true);
    assert.equal(originalCaptureLimits.bodyBytes, 65536);
    assert.equal(originalCaptureLimits.totalBytes, 16777216);
    assert.equal(originalCaptureLimits.leaves, 256);
    const overrides = { totalBytes: 90000 };
    const limits = validatePublicShellLocaleOriginalCaptureLimits(overrides);
    assert.equal(Object.isFrozen(limits), true);
    assert.equal(limits.totalBytes, 90000);
    assert.equal(limits.bodyBytes, originalCaptureLimits.bodyBytes);
    assert.deepEqual(overrides, { totalBytes: 90000 });
    for (const invalid of [{ bodyBytes: 65537 }, { totalBytes: 16777217 }, { leaves: 257 }, { unknown: 1 }, { totalBytes: 0 }])
    {
        assert.throws(() => validatePublicShellLocaleOriginalCaptureLimits(invalid));
    }
});

for (const kind of ['domain', 'font', 'static'])
{
    test(`resource original capture ${kind} retains only actual delivered bytes and full headers with one body read`, async () =>
    {
        const model = originalCaptureModel();
        const url = `http://127.0.0.1/admitted-${kind}`;
        model.bindings.resources.push({ url, digest: 'sha256:expected-not-delivered', identities: [{ kind }] });
        model.bindings.readResource = async () => assert.fail('expected build bytes must not fill actual evidence');
        const observer = await bindPublicShellLocaleContextEvidence(model);
        const bytes = Buffer.alloc(70000, 173);
        bytes[0] = 0;
        bytes[bytes.length - 1] = 255;
        const original = Buffer.from(bytes);
        let reads = 0;
        const request = model.request('GET', null, url, kind === 'font' ? 'font' : 'script');
        const response = model.response(request, () =>
        {
            reads += 1;
            return bytes;
        });
        const actualHeaders = [{ name: 'Content-Type', value: kind === 'font' ? 'font/woff2' : 'text/javascript' },
            { name: 'X-Actual', value: 'first' }, { name: 'x-actual', value: 'second' }];
        response.headersArray = async () => actualHeaders;
        model.listeners.get('request')(request);
        model.listeners.get('response')(response);
        const evidence = await observer.capture(model.page);
        const privateOriginals = observer.rawCapture.snapshot(evidence.captureCut);
        await observer.dispose();
        const captured = privateOriginals.originals.find((item) => item.kind === 'response');
        assert.ok(captured, 'admitted delivered resource original must exist');
        assert.equal(reads, 1);
        assert.equal(captured.source, 'browser');
        assert.equal(captured.bodyBase64, original.toString('base64'));
        assert.equal(captured.byteLength, 70000);
        assert.deepEqual(captured.headersArray, actualHeaders);
        assert.equal(captured.requestOrdinal, evidence.responses[0].requestOrdinal);
        assert.equal(captured.byteSha256, evidence.responses[0].contentDigest);
        assert.notEqual(captured.byteSha256, evidence.responses[0].resource.digest);
        bytes.fill(0);
        actualHeaders[0].value = 'changed-after-cut';
        assert.equal(captured.bodyBase64, original.toString('base64'));
        assert.equal(captured.headersArray[0].value, kind === 'font' ? 'font/woff2' : 'text/javascript');
        assert.equal(Object.isFrozen(captured.headersArray[0]), true);
        assert.equal(JSON.stringify(evidence).includes('bodyBase64'), false);
        assert.equal(JSON.stringify(evidence).includes('headersArray'), false);
    });
}

test('resource original capture shares remaining scene budget without the preference per-body cap', async () =>
{
    const model = originalCaptureModel({ totalBytes: 140000 });
    const urls = ['http://127.0.0.1/one.js', 'http://127.0.0.1/two.woff2'];
    model.bindings.resources = urls.map((url) => ({ url, identities: [] }));
    const observer = await bindPublicShellLocaleContextEvidence(model);
    for (const url of urls)
    {
        const request = model.request('GET', null, url);
        model.listeners.get('request')(request);
        model.listeners.get('response')(model.response(request, Buffer.alloc(70000, 31)));
    }
    const evidence = await observer.capture(model.page);
    const originals = observer.rawCapture.snapshot(evidence.captureCut).originals;
    await observer.dispose();
    assert.equal(originals.length, 2);
    assert.deepEqual(originals.map((item) => item.byteLength), [70000, 70000]);
});

test('resource original capture cumulative overflow is sticky with no truncated positive', async () =>
{
    const model = originalCaptureModel({ totalBytes: 9 });
    const urls = ['http://127.0.0.1/one.js', 'http://127.0.0.1/two.js', 'http://127.0.0.1/empty.js'];
    model.bindings.resources = urls.map((url) => ({ url, identities: [] }));
    const observer = await bindPublicShellLocaleContextEvidence(model);
    let reads = 0;
    for (const url of urls.slice(0, 2))
    {
        const request = model.request('GET', null, url);
        model.listeners.get('request')(request);
        model.listeners.get('response')(model.response(request, () =>
        {
            reads += 1;
            return Buffer.alloc(5, 17);
        }));
    }
    await assert.rejects(observer.capture(model.page));
    const first = observer.rawCapture.snapshot();
    assert.equal(reads, 2);
    assert.equal(first.overflow, true);
    assert.equal(first.originals[0].byteLength, 5);
    assert.equal(first.originals[1].captureState, 'overflow');
    assert.equal(Object.hasOwn(first.originals[1], 'bodyBase64'), false);
    const empty = model.request('GET', null, urls[2]);
    model.listeners.get('request')(empty);
    model.listeners.get('response')(model.response(empty, Buffer.alloc(0)));
    await assert.rejects(observer.capture(model.page));
    assert.equal(observer.rawCapture.snapshot().overflow, true);
    await assert.rejects(observer.dispose());
});

test('resource original capture leaf overflow refuses another resource body read', async () =>
{
    const model = originalCaptureModel({ leaves: 1 });
    model.bindings.resources = ['http://127.0.0.1/one.js', 'http://127.0.0.1/two.js'].map((url) => ({ url, identities: [] }));
    const observer = await bindPublicShellLocaleContextEvidence(model);
    let reads = 0;
    for (const resource of model.bindings.resources)
    {
        const request = model.request('GET', null, resource.url);
        model.listeners.get('request')(request);
        model.listeners.get('response')(model.response(request, () =>
        {
            reads += 1;
            return Buffer.from('actual');
        }));
    }
    await assert.rejects(observer.capture(model.page));
    assert.equal(reads, 1);
    assert.equal(observer.rawCapture.snapshot().originals.length, 1);
    assert.equal(observer.rawCapture.snapshot().overflow, true);
    await assert.rejects(observer.dispose());
});

test('resource original capture one over-budget resource fails closed without retaining a prefix', async () =>
{
    const model = originalCaptureModel({ totalBytes: 7 });
    const url = 'http://127.0.0.1/too-large.woff2';
    model.bindings.resources.push({ url, identities: [] });
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('GET', null, url, 'font');
    let reads = 0;
    model.listeners.get('request')(request);
    model.listeners.get('response')(model.response(request, () =>
    {
        reads += 1;
        return Buffer.alloc(8);
    }));
    await assert.rejects(observer.capture(model.page));
    const raw = observer.rawCapture.snapshot();
    assert.equal(reads, 1);
    assert.equal(raw.overflow, true);
    assert.equal(raw.originals[0].captureState, 'overflow');
    assert.equal(Object.hasOwn(raw.originals[0], 'bodyBase64'), false);
    await assert.rejects(observer.dispose());
});

test('resource original capture keeps preference 64KiB even with a document classification', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('GET');
    let reads = 0;
    const response = model.response(request, () =>
    {
        reads += 1;
        return Buffer.alloc(65537);
    });
    await assert.rejects(observer.rawCapture.response(response, { source: 'browser', method: 'GET',
        url: model.bindings.preferenceUrl, document: true }));
    assert.equal(reads, 1);
    assert.equal(observer.rawCapture.snapshot().overflow, true);
    assert.equal(Object.hasOwn(observer.rawCapture.snapshot().originals[0], 'bodyBase64'), false);
    await assert.rejects(observer.dispose());
});

test('resource original capture freezes admitted URLs and never reads a later-added business stream', async () =>
{
    const model = originalCaptureModel();
    const admittedUrl = 'http://127.0.0.1/original.js';
    const laterUrl = 'http://127.0.0.1/api/binary/business.woff2';
    model.bindings.resources.push({ url: admittedUrl, identities: [{ kind: 'domain' }] });
    const observer = await bindPublicShellLocaleContextEvidence(model);
    model.bindings.resources[0].url = 'http://127.0.0.1/mutated.js';
    model.bindings.resources.push({ url: laterUrl, identities: [] });
    let originalReads = 0;
    let businessReads = 0;
    const original = model.request('GET', null, admittedUrl, 'script');
    model.listeners.get('request')(original);
    model.listeners.get('response')(model.response(original, () =>
    {
        originalReads += 1;
        return Buffer.from('actual admitted');
    }));
    const business = model.request('GET', null, laterUrl, 'fetch');
    const businessResponse = model.response(business, () =>
    {
        businessReads += 1;
        throw new Error('business body must not be read');
    });
    businessResponse.headersArray = async () => assert.fail('business response headers are not body capture admission');
    model.listeners.get('request')(business);
    model.listeners.get('response')(businessResponse);
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    await observer.dispose();
    assert.equal(originalReads, 1);
    assert.equal(businessReads, 0);
    assert.equal(raw.originals.length, 1);
    assert.equal(raw.originals[0].url, admittedUrl);
    assert.equal(evidence.responses.length, 2);
    assert.equal(evidence.responses[1].resource, null);
});

test('resource original capture explicitly rejects an unadmitted resource without a body read', async () =>
{
    const model = originalCaptureModel();
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const url = 'http://127.0.0.1/not-admitted.js';
    let reads = 0;
    const response = model.response(model.request('GET', null, url), () =>
    {
        reads += 1;
        return Buffer.from('must not read');
    });
    await assert.rejects(observer.rawCapture.response(response, { source: 'browser', method: 'GET', url }));
    assert.equal(reads, 0);
    assert.throws(() => observer.rawCapture.supplied(Buffer.from('not admitted'),
        { requestOrdinal: 0, purpose: 'resource-replacement-input', url, headersArray: [] }));
    assert.equal(observer.rawCapture.snapshot().failures.length > 0, true);
    await assert.rejects(observer.dispose());
});

test('resource original capture missing actual resource headers is fatal but retains original body once', async () =>
{
    const model = originalCaptureModel();
    const url = 'http://127.0.0.1/actual.js';
    model.bindings.resources.push({ url, identities: [] });
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const request = model.request('GET', null, url);
    let reads = 0;
    const response = model.response(request, () =>
    {
        reads += 1;
        return Buffer.from([0, 91, 255]);
    });
    delete response.headersArray;
    model.listeners.get('request')(request);
    model.listeners.get('response')(response);
    await assert.rejects(observer.capture(model.page));
    const captured = observer.rawCapture.snapshot().originals[0];
    assert.equal(reads, 1);
    assert.equal(captured.bodyBase64, Buffer.from([0, 91, 255]).toString('base64'));
    assert.equal(captured.captureState, 'read-failed');
    await assert.rejects(observer.dispose());
});

test('resource original capture replacement input is distinct from actual delivered body and headers', async () =>
{
    const model = originalCaptureModel();
    const url = 'http://127.0.0.1/actual-font.woff2';
    model.bindings.resources.push({ url, digest: 'sha256:expected', identities: [{ kind: 'font' }] });
    model.bindings.readResource = async () => assert.fail('observer must not reopen sealed files');
    let handler;
    model.context.route = async (_, callback) =>
    {
        handler = callback;
    };
    model.context.unroute = async () =>
    {};
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const input = Buffer.alloc(70000, 17);
    const delivered = Buffer.alloc(70000, 23);
    const fault = await bindFaultOwner({ context: model.context, bindings: model.bindings, url,
        action: { kind: 'resource-replacement', contentType: 'font/woff2', body: input }, rawCapture: observer.rawCapture });
    const request = model.request('GET', null, url, 'font');
    model.listeners.get('request')(request);
    let fulfills = 0;
    let reads = 0;
    const work = handler({ request: () => request, fulfill: async (options) =>
    {
        fulfills += 1;
        assert.deepEqual(options.body, input);
        assert.equal(options.contentType, 'font/woff2');
        const response = model.response(request, () =>
        {
            reads += 1;
            return delivered;
        });
        response.headersArray = async () => [{ name: 'Content-Type', value: 'font/woff2' }, { name: 'X-Delivered', value: 'actual' }];
        model.listeners.get('response')(response);
    }, abort: async () => assert.fail('within-budget replacement must fulfill') });
    await fault.entered;
    fault.release();
    const receipt = await fault.completed;
    await work;
    const evidence = await observer.capture(model.page);
    const raw = observer.rawCapture.snapshot(evidence.captureCut);
    await fault.dispose();
    await observer.dispose();
    const supplied = raw.originals.find((item) => item.kind === 'supplied-body');
    const browser = raw.originals.find((item) => item.kind === 'response');
    assert.ok(supplied && browser, 'input and actual-delivered originals must both exist');
    assert.equal(fulfills, 1);
    assert.equal(reads, 1);
    assert.equal(supplied.url, url);
    assert.equal(supplied.bodyBase64, input.toString('base64'));
    assert.equal(browser.bodyBase64, delivered.toString('base64'));
    assert.notEqual(browser.bodyBase64, supplied.bodyBase64);
    assert.equal(supplied.requestOrdinal, browser.requestOrdinal);
    assert.equal(supplied.sequence, receipt.suppliedBodySequence);
    assert.deepEqual(supplied.headersArray, [{ name: 'Content-Type', value: 'font/woff2' }]);
    assert.equal(browser.headersArray[1].name, 'X-Delivered');
    assert.notEqual(browser.byteSha256, model.bindings.resources[0].digest);
    assert.equal(JSON.stringify(receipt).includes('bodyBase64'), false);
    assert.equal(JSON.stringify(receipt).includes('headersArray'), false);
});

test('resource original capture replacement metadata cannot fall back to preference or omit input headers', async () =>
{
    for (const invalid of ['missing-url', 'preference-url', 'missing-headers'])
    {
        const model = originalCaptureModel();
        const url = 'http://127.0.0.1/resource.js';
        model.bindings.resources.push({ url, identities: [] });
        const observer = await bindPublicShellLocaleContextEvidence(model);
        const metadata = { requestOrdinal: 0, purpose: 'resource-replacement-input',
            headersArray: [{ name: 'Content-Type', value: 'text/javascript' }] };
        if (invalid !== 'missing-url')
        {
            metadata.url = invalid === 'preference-url' ? model.bindings.preferenceUrl : url;
        }
        if (invalid === 'missing-headers')
        {
            delete metadata.headersArray;
        }
        assert.throws(() => observer.rawCapture.supplied(Buffer.from('actual input'), metadata), invalid);
        assert.equal(observer.rawCapture.snapshot().failures.length > 0, true);
        await assert.rejects(observer.dispose());
    }
});

test('resource original capture over-budget replacement fails before fulfill without truncation', async () =>
{
    const model = originalCaptureModel({ totalBytes: 7 });
    const url = 'http://127.0.0.1/over-budget.js';
    model.bindings.resources.push({ url, identities: [] });
    let handler;
    model.context.route = async (_, callback) =>
    {
        handler = callback;
    };
    model.context.unroute = async () =>
    {};
    const observer = await bindPublicShellLocaleContextEvidence(model);
    const fault = await bindFaultOwner({ context: model.context, bindings: model.bindings, url,
        action: { kind: 'resource-replacement', contentType: 'text/javascript', body: Buffer.alloc(8) }, rawCapture: observer.rawCapture });
    const request = model.request('GET', null, url, 'script');
    model.listeners.get('request')(request);
    let fulfills = 0;
    let aborts = 0;
    const work = handler({ request: () => request, fulfill: async () =>
    {
        fulfills += 1;
    }, abort: async () =>
    {
        aborts += 1;
    } });
    await fault.entered;
    fault.release();
    await assert.rejects(fault.completed);
    await work;
    assert.equal(fulfills, 0);
    assert.equal(aborts, 1);
    const raw = observer.rawCapture.snapshot();
    assert.equal(raw.overflow, true);
    assert.equal(raw.originals[0].captureState, 'overflow');
    assert.equal(Object.hasOwn(raw.originals[0], 'bodyBase64'), false);
    await assert.rejects(observer.capture(model.page));
    await fault.dispose();
    await assert.rejects(observer.dispose());
});

test('preference operation paths/media type come from formal production owners', () =>
{
    assert.deepEqual(preference.operations.map((item) => [item.method, item.path, item.successStatus]),
        [['GET', '/api/binary/locale-preference', 200], ['PUT', '/api/binary/locale-preference', 200]]);
    assert.equal(preference.mediaType, 'application/octet-stream');
    assert.deepEqual(preference.inspectRequest(preference.encodeRequest('auto', null, 0)),
        { mode: 'auto', fixedLocale: null, expectedRevision: 0 });
    assert.ok(preference.refs.every((ref) => ref.digest.startsWith('sha256:')));
});

function responseFrame({ revision = 0n, reserved = 0 } = {})
{
    // Response POD fixture follows the actual mapper; canonical envelope owns CRC/header.
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    view.setBigInt64(0, revision, true);
    view.setBigInt64(8, 0n, true);
    payload[16] = 1;
    payload[19] = reserved;
    const type = protocol.frameTypes.find((item) => item.name === 'UserLocalePreference').value;
    return new Uint8Array(encodeAedsFrame(type, payload));
}

test('response decoder is the actual mapper and preserves anonymous epoch/revision zero', () =>
{
    assert.deepEqual(preference.decodeResponse(responseFrame()),
        { mode: 'auto', fixedLocale: null, revision: 0, updatedAt: '1970-01-01T00:00:00.000Z' });
});

for (const [name, frame] of [
    ['nonzero POD reserved bytes', responseFrame({ reserved: 1 })],
    ['unsafe response revision', responseFrame({ revision: 9007199254740992n })],
    ['negative response revision', responseFrame({ revision: -1n })]
])
{
    test(`production response rejects ${name}`, () => assert.throws(() => preference.decodeResponse(frame)));
}

for (const [name, mutate] of [
    ['inactive frame flags', (bytes) =>
    {
        bytes[6] = 1;
    }],
    ['CRC corruption', (bytes) =>
    {
        bytes[bytes.length - 1] ^= 1;
    }]
])
{
    test(`request inspector rejects ${name}`, () =>
    {
        const bytes = preference.encodeRequest('fixed', preference.locales[0].code, 0);
        mutate(bytes);
        assert.throws(() => preference.inspectRequest(bytes));
    });
}

test('validly framed request with nonzero reserved payload cannot bypass exact production encoding', () =>
{
    const bytes = preference.encodeRequest('auto', null, 0);
    const payload = bytes.slice(protocol.header.size);
    payload[payload.length - 1] = 1;
    const type = protocol.frameTypes.find((item) => item.name === 'UserLocalePreferenceUpdateRequest').value;
    assert.throws(() => preference.inspectRequest(new Uint8Array(encodeAedsFrame(type, payload))), /production preference encoder/u);
});

function commitFixture(auth = 'anonymous')
{
    const target = preference.locales[3].code;
    const before = { snapshot: { mode: 'auto', fixedLocale: null, revision: auth === 'anonymous' ? 0 : 7, updatedAt: 'epoch' }, cookies: [] };
    const after = { snapshot: { mode: 'fixed', fixedLocale: target, revision: auth === 'anonymous' ? 0 : 8,
        updatedAt: auth === 'anonymous' ? 'epoch' : 'actual-update' }, cookies: [{ locale: target, httpOnly: true }] };
    return { scene: { locale: target, authActionContext: auth }, before, after, outcome: 'commit', writes: [{ status: 200,
        command: { mode: 'fixed', fixedLocale: target, expectedRevision: before.snapshot.revision },
        preference: { ...after.snapshot, updatedAt: 'actual-update' } }] };
}

for (const auth of ['anonymous', 'user', 'admin'])
{
    test(`preference outcome honors ${auth} backend revision semantics`, () => assertPublicShellLocalePreferenceOutcome(commitFixture(auth)));
}

for (const [name, mutate] of [
    ['anonymous fictitious increment', (input) =>
    {
        input.after.snapshot.revision = 1;
    }],
    ['wrong target cookie', (input) =>
    {
        input.after.cookies[0].locale = 'wrong';
    }],
    ['stale expected revision', (input) =>
    {
        input.writes[0].command.expectedRevision = 1;
    }],
    ['unobserved PUT body', (input) =>
    {
        delete input.writes[0].command;
    }],
    ['multiple successful PUTs', (input) =>
    {
        input.writes.push(structuredClone(input.writes[0]));
    }],
    ['cookie privacy downgrade', (input) =>
    {
        input.after.cookies[0].httpOnly = false;
    }]
])
{
    test(`preference outcome rejects ${name}`, () =>
    {
        const input = commitFixture();
        mutate(input);
        assert.throws(() => assertPublicShellLocalePreferenceOutcome(input));
    });
}

test('rollback rejects a changed revision, changed cookie or a successful write', () =>
{
    const fixture = commitFixture();
    const input = { ...fixture, after: structuredClone(fixture.before), writes: [], outcome: 'rollback' };
    assertPublicShellLocalePreferenceOutcome(input);
    for (const mutate of [
        (copy) =>
        {
            copy.after.snapshot.revision = 9;
        },
        (copy) =>
        {
            copy.after.cookies = fixture.after.cookies;
        },
        (copy) =>
        {
            copy.writes = fixture.writes;
        }
    ])
    {
        const copy = structuredClone(input);
        mutate(copy);
        assert.throws(() => assertPublicShellLocalePreferenceOutcome(copy));
    }
});

function fontFixture()
{
    const font = { locale: 'ja-JP', script: 'Jpan', family: 'Noto Sans JP', weights: [400, 500, 700] };
    return { font, observation: { status: 'loaded', checks: font.weights.map((weight) => ({ weight, available: true })),
        faces: font.weights.map((weight) => ({ family: font.family, weight: String(weight), status: 'loaded' })) },
    responses: font.weights.map((weight) => ({ status: 200, contentDigest: 'sha256:expected', resource: {
        digest: 'sha256:expected', identities: [{ kind: 'font', locale: font.locale, script: font.script, weight }]
    } })) };
}

test('font check requires actual manifest identity, body digest, loaded faces and every weight', () =>
{
    assertPublicShellLocaleFontIdentity(fontFixture());
    for (const mutate of [
        (input) =>
        {
            input.responses[0].contentDigest = 'sha256:wrong';
        },
        (input) =>
        {
            input.responses.pop();
        },
        (input) =>
        {
            input.observation.faces[0].family = 'Fallback';
        },
        (input) =>
        {
            input.observation.checks[0].available = false;
        },
        (input) =>
        {
            input.responses[0].status = 404;
        },
        (input) =>
        {
            input.responses[0].resource.identities[0].script = 'Latn';
        }
    ])
    {
        const input = fontFixture();
        mutate(input);
        assert.throws(() => assertPublicShellLocaleFontIdentity(input));
    }
});

test('hydration mark rejects missing, repeated and callback-after-mount observations', () =>
{
    const mark = { name: 'fsus:start:public-hydrate:hydrate:start', snapshot: { dom: { hydrated: false } } };
    const evidence = (marks) => ({ browser: { recorder: { marks } } });
    assert.equal(assertPublicShellLocaleHydrationMark(evidence([mark])), mark.snapshot);
    for (const marks of [[], [mark, mark], [{ ...mark, snapshot: null }], [{ ...mark, snapshot: { dom: { hydrated: true } } }]])
    {
        assert.throws(() => assertPublicShellLocaleHydrationMark(evidence(marks)));
    }
});

test('rollback permits disclosure changes but forbids metadata/copy/font/business replacement', () =>
{
    const before = { dom: { language: 'en-US', direction: 'ltr', metadata: { title: 'actual' },
        copyNodes: [{ key: 'public.shell.home', text: 'Home', visible: false }], selectors: [{ active: 'en-US' }],
        geometry: [{ name: 'nav', fontFamily: 'Google Sans', visible: true }] },
    business: { nodeIdentity: 1, textDigest: 'actual', inputs: [], scroll: { x: 0, y: 0 } } };
    const after = structuredClone(before);
    after.dom.copyNodes[0].visible = true;
    assertPublicShellLocaleRollback({ before, after });
    for (const mutate of [
        (copy) =>
        {
            copy.dom.metadata.title = 'wrong';
        },
        (copy) =>
        {
            copy.dom.copyNodes[0].text = 'wrong';
        },
        (copy) =>
        {
            copy.dom.geometry[0].fontFamily = 'Fallback';
        },
        (copy) =>
        {
            copy.business.nodeIdentity = 2;
        },
        (copy) =>
        {
            copy.dom.selectors[0].active = 'ja-JP';
        }
    ])
    {
        const copy = structuredClone(after);
        mutate(copy);
        assert.throws(() => assertPublicShellLocaleRollback({ before, after: copy }));
    }
});

function faultFixture()
{
    return { bindings: { preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference', resources: [{ url: 'http://127.0.0.1/owned.js',
        identities: [{ kind: 'domain', locale: 'ja-JP', domain: 'public' }] }] },
    scene: { stage: 'domain-failure', locale: 'ja-JP', requiredDomains: ['public'], transition: { failureMode: 'non-2xx' } },
    url: 'http://127.0.0.1/owned.js', action: { kind: 'http-error', status: 503 } };
}

test('fault admission rejects wrong owner/target/domain and unsupported semantic labels', () =>
{
    assertPublicShellLocaleFaultBinding(faultFixture());
    for (const mutate of [
        (input) =>
        {
            input.url = 'http://127.0.0.1/unknown';
        },
        (input) =>
        {
            input.scene.locale = 'en-US';
        },
        (input) =>
        {
            input.scene.requiredDomains = ['admin'];
        },
        (input) =>
        {
            input.scene.transition.failureMode = 'timeout';
        },
        (input) =>
        {
            input.scene.transition.failureMode = 'invalid-digest';
        },
        (input) =>
        {
            input.action.status = 200;
        }
    ])
    {
        const input = faultFixture();
        mutate(input);
        assert.throws(() => assertPublicShellLocaleFaultBinding(input));
    }
});

test('network-failure binds only the formal preference endpoint and a genuine abort action', () =>
{
    const input = faultFixture();
    input.scene.stage = 'preference-failure';
    input.scene.transition.failureMode = 'network-failure';
    input.url = input.bindings.preferenceUrl;
    input.action = { kind: 'abort' };
    assertPublicShellLocaleFaultBinding(input);
    input.action = { kind: 'http-error', status: 503 };
    assert.throws(() => assertPublicShellLocaleFaultBinding(input));
});

test('fault route disposal is idempotent and does not leak a retry interception', async () =>
{
    let routes = 0;
    let unroutes = 0;
    const input = faultFixture();
    const context = { route: async () =>
    {
        routes += 1;
    }, unroute: async () =>
    {
        unroutes += 1;
    } };
    const fault = await bindPublicShellLocaleFault({ ...input, context });
    await fault.dispose();
    await fault.dispose();
    assert.equal(routes, 1);
    assert.equal(unroutes, 1);
});

test('interception deadline reports failure rather than advancing scene state', async () =>
{
    await waitForPublicShellLocaleResourceEntry(Promise.resolve(), 10);
    await assert.rejects(waitForPublicShellLocaleResourceEntry(new Promise(() =>
    {}), 1), /not observed/u);
});

test('formal scene interface fails before any context when runtime admission differs', async () =>
{
    let creates = 0;
    const harness = { identity: { matrixDigest: 'actual' }, withScene: async () =>
    {
        creates += 1;
    } };
    await assert.rejects(withPublicShellLocaleLifecycleScene({ harness, matrix: { contentDigest: 'actual' },
        bindings: { identity: { matrixDigest: 'wrong' } } }), /another admission/u);
    assert.equal(creates, 0);
});

test('first-html driver requires a receipted entry before creating any page', async () =>
{
    let pages = 0;
    await assert.rejects(drivePublicShellLocaleInitialHydration({ scene: { issue: 2084 },
        context: { newPage: async () =>
        {
            pages += 1;
        } }, bindings: { resources: [] }, saveStage: async () =>
        {} }), /entry-runtime/u);
    assert.equal(pages, 0);
});

for (const stage of ['domain-failure', 'font-failure', 'preference-failure'])
{
    test(`HTTP action uses actual transport timedout for ${stage}, never a diagnostic timer (Node self-test)`, async () =>
    {
        const input = faultFixture();
        input.scene = { ...input.scene, issue: 2087, stage, requiredFont: { script: 'Jpan' }, transition: { failureMode: 'timeout' } };
        if (stage === 'preference-failure')
        {
            input.url = input.bindings.preferenceUrl;
        }
        if (stage === 'font-failure')
        {
            input.bindings.resources[0].identities = [{ kind: 'font', locale: 'ja-JP', script: 'Jpan' }];
        }
        const action = await createPublicShellLocaleFailureAction(input);
        assert.deepEqual(action, { kind: 'abort', errorCode: 'timedout' });
        let handler;
        const context = { route: async (_, callback) =>
        {
            handler = callback;
        }, unroute: async () =>
        {} };
        const fault = await bindPublicShellLocaleFault({ ...input, context, action });
        const aborted = [];
        const work = handler({ request: () => ({ method: () => 'PUT' }), abort: async (code) => aborted.push(code) });
        await fault.entered;
        fault.release();
        assert.equal((await fault.completed).errorCode, 'timedout');
        await work;
        await fault.dispose();
        assert.deepEqual(aborted, ['timedout']);
        assert.throws(() => assertPublicShellLocaleFaultBinding({ ...input, action: { kind: 'abort', errorCode: 'failed' } }));
    });
}

function conflictFrame({ status = 409, message = 'locale_preference_revision_conflict', reserved = 0 } = {})
{
    // Error POD fixture only. The production HTTP action never encodes or fabricates this frame.
    const payload = new Uint8Array(584);
    payload[0] = 3;
    payload[1] = 5;
    payload[2] = reserved;
    new DataView(payload.buffer).setInt32(4, status, true);
    payload.set(new TextEncoder().encode(message), 8);
    const type = protocol.frameTypes.find((frame) => frame.name === 'ApiError').value;
    return new Uint8Array(encodeAedsFrame(type, payload));
}

test('canonical ApiError conflict decoder rejects reserved/CRC and does not expose details/trace values', () =>
{
    const decoded = preference.decodeError(conflictFrame());
    assert.equal(decoded.kind, 'revision-conflict');
    assert.equal(decoded.statusCode, 409);
    assert.equal(decoded.traceId, undefined);
    assert.equal(decoded.message, undefined);
    assert.throws(() => preference.decodeError(conflictFrame({ reserved: 1 })), /reserved/u);
    const corrupted = conflictFrame();
    corrupted[corrupted.length - 1] ^= 1;
    assert.throws(() => preference.decodeError(corrupted));
    assert.equal(preference.decodeError(conflictFrame({ message: 'another_conflict' })).kind, 'other');
});

for (const revision of [0, 7])
{
    test(`conflict forwards only a changed expectedRevision=${revision} and retains the backend 409 response (Node route self-test)`, async () =>
    {
        const targetLocale = preference.locales[3].code;
        const bindings = { preference, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' };
        const scene = { issue: 2087, stage: 'revision-conflict', locale: targetLocale, transition: { failureMode: 'conflict' } };
        const action = await createPublicShellLocaleFailureAction({ bindings, scene, url: bindings.preferenceUrl,
            beforePreference: { snapshot: { revision } } });
        const headers = { 'content-type': preference.mediaType, 'cache-control': 'no-store' };
        let handler;
        const context = { cookies: async () => [], request: { get: async () => ({ status: () => 200, headers: () => headers,
            body: async () => responseFrame({ revision: BigInt(revision) }) }) },
        route: async (_, callback) =>
        {
            handler = callback;
        }, unroute: async () =>
        {} };
        const serverResponse = { status: () => 409, headers: () => headers, body: async () => conflictFrame() };
        let forwarded;
        let fulfilled;
        const fault = await bindPublicShellLocaleFault({ context, bindings, scene, action, url: bindings.preferenceUrl });
        const work = handler({ request: () => ({ method: () => 'PUT',
            postDataBuffer: () => Buffer.from(preference.encodeRequest('fixed', targetLocale, revision)) }),
        fetch: async (options) =>
        {
            assert.equal(options.maxRetries, 0);
            assert.equal(options.maxRedirects, 0);
            assert.equal(options.headers, undefined);
            forwarded = preference.inspectRequest(new Uint8Array(options.postData));
            return serverResponse;
        }, fulfill: async (options) =>
        {
            fulfilled = options.response;
        }, abort: async () => assert.fail('no abort expected') });
        await fault.entered;
        fault.release();
        const receipt = await fault.completed;
        await work;
        await fault.dispose();
        assert.equal(fulfilled, serverResponse);
        assert.deepEqual(forwarded, { mode: 'fixed', fixedLocale: targetLocale, expectedRevision: revision === 0 ? 1 : revision - 1 });
        assert.equal(receipt.originalRevision, revision);
        assert.equal(receipt.status, 409);
        assert.equal(receipt.error.kind, 'revision-conflict');
    });
}

test('conflict fails before forwarding when the original product command is already stale (Node self-test)', async () =>
{
    let handler;
    let forwards = 0;
    const bindings = { preference, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' };
    const headers = { 'content-type': preference.mediaType, 'cache-control': 'no-store' };
    const context = { cookies: async () => [], request: { get: async () => ({ status: () => 200, headers: () => headers,
        body: async () => responseFrame({ revision: 7n }) }) }, route: async (_, callback) =>
    {
        handler = callback;
    }, unroute: async () =>
    {} };
    const targetLocale = preference.locales[3].code;
    const fault = await bindPublicShellLocaleFault({ context, bindings, url: bindings.preferenceUrl,
        action: { kind: 'revision-conflict', targetLocale, currentRevision: 7 } });
    const work = handler({ request: () => ({ method: () => 'PUT', postDataBuffer: () => preference.encodeRequest('fixed', targetLocale, 0) }),
        fetch: async () =>
        {
            forwards += 1;
        }, abort: async () =>
        {} });
    await fault.entered;
    fault.release();
    await assert.rejects(fault.completed, /original product request already has a stale revision/u);
    await work;
    await fault.dispose();
    assert.equal(forwards, 0);
});

function artifactActionFixture(mode)
{
    const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const bytes = [
        Buffer.from('export const localeDomainIdentity={locale:"ja-JP",domain:"public"};'),
        Buffer.from('export const localeDomainIdentity={locale:"en-US",domain:"public"};'),
        Buffer.from('export const localeDomainIdentity={locale:"ja-JP",domain:"admin"};')
    ];
    const resources = [
        { url: 'http://127.0.0.1/opaque-a.js', digest: digest(bytes[0]), identities: [{ kind: 'domain', locale: 'ja-JP', domain: 'public' }] },
        { url: 'http://127.0.0.1/opaque-b.js', digest: digest(bytes[1]), identities: [{ kind: 'domain', locale: 'en-US', domain: 'public' }] },
        { url: 'http://127.0.0.1/opaque-c.js', digest: digest(bytes[2]), identities: [{ kind: 'domain', locale: 'ja-JP', domain: 'admin' }] }
    ];
    return { bindings: { preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference', resources,
        identity: { buildDigest: 'sha256:current', sourceState: { commit: 'current', worktreeFingerprint: 'current' } },
        readResource: async (url) => bytes[resources.findIndex((resource) => resource.url === url)] },
    scene: { issue: 2087, stage: 'artifact-invalid', locale: 'ja-JP', requiredDomains: ['public'], transition: { failureMode: mode } },
    url: resources[0].url, replacementUrl: resources[mode === 'cross-domain' ? 2 : 1].url };
}

for (const mode of ['content-digest', 'cross-locale', 'cross-domain'])
{
    test(`artifact ${mode} action requires sealed source bytes, not a synthetic replacement claim (Node self-test)`, async () =>
    {
        const input = artifactActionFixture(mode);
        const action = await createPublicShellLocaleFailureAction(input);
        assertPublicShellLocaleFaultBinding({ ...input, action });
        const tampered = { ...action, body: new Uint8Array(Buffer.from('arbitrary invalid script')) };
        assert.throws(() => assertPublicShellLocaleFaultBinding({ ...input, action: tampered }));
        const same = { ...input, replacementUrl: input.url };
        if (mode !== 'content-digest')
        {
            await assert.rejects(createPublicShellLocaleFailureAction(same), /did not change|did not cross/u);
        }
    });
}

test('cross-version refuses implicit old build/worktree fallback and stale-response requires a real before GET', async () =>
{
    await assert.rejects(createPublicShellLocaleFailureAction(artifactActionFixture('cross-version')), /explicit immutable foreign build identity/u);
    await assert.rejects(createPublicShellLocaleFailureAction({ bindings: {}, scene: { issue: 2087, stage: 'revision-conflict',
        transition: { failureMode: 'stale-response' } } }), /real pre-click preference GET/u);
});

for (const [status, message] of [[200, 'locale_preference_revision_conflict'], [403, 'locale_preference_revision_conflict'], [409, 'another_conflict']])
{
    test(`native forwarding rejects status=${status}/message=${message} rather than claiming a revision conflict (Node self-test)`, async () =>
    {
        let handler;
        let fulfilled = false;
        const targetLocale = preference.locales[3].code;
        const bindings = { preference, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' };
        const headers = { 'content-type': preference.mediaType, 'cache-control': 'no-store' };
        const context = { cookies: async () => [], request: { get: async () => ({ status: () => 200,
            headers: () => headers, body: async () => responseFrame() }) },
        route: async (_, callback) =>
        {
            handler = callback;
        }, unroute: async () =>
        {} };
        const fault = await bindPublicShellLocaleFault({ context, bindings, url: bindings.preferenceUrl,
            action: { kind: 'revision-conflict', targetLocale, currentRevision: 0 } });
        const work = handler({ request: () => ({ method: () => 'PUT', postDataBuffer: () => preference.encodeRequest('fixed', targetLocale, 0) }),
            fetch: async () => ({ status: () => status, headers: () => headers, body: async () => conflictFrame({ status, message }) }),
            fulfill: async () =>
            {
                fulfilled = true;
            }, abort: async () =>
            {} });
        await fault.entered;
        fault.release();
        await assert.rejects(fault.completed, /formal backend did not/u);
        await work;
        await fault.dispose();
        assert.equal(fulfilled, false);
        assert.equal(fault.trace()[0].status, status);
    });
}

test('cancel and font load-failure have distinct transport actions; schema/digest labels require production bindings', async () =>
{
    const input = faultFixture();
    input.scene.issue = 2087;
    input.scene.stage = 'preference-failure';
    input.scene.transition.failureMode = 'cancel';
    input.url = input.bindings.preferenceUrl;
    assert.deepEqual(await createPublicShellLocaleFailureAction(input), { kind: 'abort', errorCode: 'aborted' });
    const font = faultFixture();
    font.scene = { ...font.scene, issue: 2087, stage: 'font-failure', requiredFont: { script: 'Jpan' }, transition: { failureMode: 'load-failure' } };
    font.bindings.resources[0].identities = [{ kind: 'font', locale: 'ja-JP', script: 'Jpan' }];
    assert.deepEqual(await createPublicShellLocaleFailureAction(font), { kind: 'abort', errorCode: 'failed' });
    for (const mode of ['invalid-content', 'invalid-schema', 'invalid-digest'])
    {
        const domain = faultFixture();
        domain.scene.issue = 2087;
        domain.scene.transition.failureMode = mode;
        domain.bindings.readResource = async () => Buffer.from('sealed');
        domain.bindings.resources[0].digest = `sha256:${createHash('sha256').update('sealed').digest('hex')}`;
        await assert.rejects(createPublicShellLocaleFailureAction(domain), /production domain bindings/u);
    }
});

const digestBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function domainMutationFixture(locale, mode, alias = false)
{
    const productionSource = stripTypeScriptTypes(readFileSync(new URL(`../../src/frontend/src/locales/${locale}/public.ts`, import.meta.url), 'utf8'));
    const source = alias ? productionSource.replace('export const publicMessages', 'const publicMessages')
        + '\nexport { publicMessages as publicMessages };\n' : productionSource;
    const body = Buffer.from(source);
    const url = 'http://127.0.0.1/actual-production-domain.js';
    return { bindings: { domains, resources: [{ url, digest: digestBytes(body), identities: [
        { kind: 'domain', locale, domain: 'public', exportName: domains.exportNames.public, schemaDigest: domains.schemaDigests.public }
    ] }], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference', readResource: async () => body },
    scene: { issue: 2087, stage: 'domain-failure', locale, requiredDomains: ['public'], transition: { failureMode: mode } }, url };
}

// Actual production TS data/validator, but no emitted build or real browser qualification.
for (const locale of preference.locales.map((item) => item.code))
{
    for (const mode of ['invalid-content', 'invalid-schema', 'invalid-digest'])
    {
        test(`production ${locale} ${mode} is an auditable sealed-source mutation, not another failure kind (Node self-test)`, async () =>
        {
            const input = domainMutationFixture(locale, mode, locale === 'ru-RU');
            const action = await createPublicShellLocaleFailureAction(input);
            assertPublicShellLocaleFaultBinding({ ...input, action });
            assert.equal(action.mutation.schemaDigest, domains.schemaDigests.public);
            if (mode === 'invalid-content')
            {
                assert.throws(() => domains.parse(Buffer.from(action.body).toString()));
                assert.ok(Buffer.from(action.body).subarray(0, action.mutation.originalLength).equals(await input.bindings.readResource(input.url)));
            }
            else
            {
                const result = await import(`data:text/javascript;base64,${Buffer.from(action.body).toString('base64')}`);
                assert.deepEqual(result.localeDomainIdentity, { locale, domain: 'public' });
                const computed = domains.schemaDigest(result.publicMessages);
                assert.equal(computed, action.mutation.mutatedSchemaDigest);
                if (mode === 'invalid-digest')
                {
                    assert.equal(computed, domains.schemaDigests.public);
                }
                else
                {
                    assert.notEqual(computed, domains.schemaDigests.public);
                }
            }
            let handler;
            const context = { route: async (_, callback) =>
            {
                handler = callback;
            }, unroute: async () =>
            {} };
            const fault = await bindPublicShellLocaleFault({ ...input, action, context });
            let delivered;
            const work = handler({ request: () => ({ method: () => 'GET' }), fulfill: async (options) =>
            {
                assert.equal(options.status, 200);
                delivered = options.body;
            }, abort: async () => assert.fail('domain bytes must be fulfilled, not network-aborted') });
            await fault.entered;
            fault.release();
            assert.equal((await fault.completed).contentDigest, digestBytes(action.body));
            await work;
            await fault.dispose();
            assert.ok(delivered.equals(Buffer.from(action.body)));
        });
    }
}

test('domain mutation refuses dependency failures, fabricated proofs and bytes replaced before binding', async () =>
{
    const input = domainMutationFixture('ru-RU', 'invalid-schema');
    const action = await createPublicShellLocaleFailureAction(input);
    let routes = 0;
    const context = { route: async () =>
    {
        routes += 1;
    } };
    await assert.rejects(bindPublicShellLocaleFault({ ...input, context,
        action: { ...action, body: new Uint8Array(Buffer.from('export const fake=true;')) } }), /sealed reconstruction/u);
    await assert.rejects(bindPublicShellLocaleFault({ ...input, context,
        action: { ...action, mutation: { ...action.mutation, edits: [] } } }), /sealed reconstruction/u);
    const dependent = domainMutationFixture('ru-RU', 'invalid-digest');
    const body = Buffer.from('import "./missing.js";\n' + (await dependent.bindings.readResource(dependent.url)).toString());
    dependent.bindings.readResource = async () => body;
    dependent.bindings.resources[0].digest = digestBytes(body);
    await assert.rejects(createPublicShellLocaleFailureAction(dependent), /standalone/u);
    assert.equal(routes, 0);
});

function fontMutationFixture(mode)
{
    // Sealed-byte protocol fixture only; real artifact admission supplies actual font binaries.
    const bodies = [Buffer.from('font-binary-a'), Buffer.from('font-binary-b')];
    const urls = ['http://127.0.0.1/a.woff2', 'http://127.0.0.1/b.woff2'];
    const identities = [
        { kind: 'font', locale: 'zh-Hant', script: 'Hant', family: 'Noto Sans TC', weight: 400, unicodeRange: 'U+4E00-9FFF' },
        { kind: 'font', locale: 'zh-CN', script: 'Hans', family: 'Noto Sans SC', weight: 400, unicodeRange: 'U+4E00-9FFF' }
    ];
    const resources = urls.map((url, index) => ({ url, identities: [identities[index]], digest: digestBytes(bodies[index]) }));
    return { bindings: { resources, preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference',
        readResource: async (url) => bodies[urls.indexOf(url)] }, url: urls[0], replacementUrl: urls[1],
    scene: { issue: 2087, locale: 'zh-Hant', stage: 'font-failure', requiredFont: { script: 'Hant' }, transition: { failureMode: mode } } };
}

for (const mode of ['wrong-face', 'wrong-script'])
{
    test(`${mode} fulfills the exact sealed replacement binary at the required font URL (Node route self-test)`, async () =>
    {
        const input = fontMutationFixture(mode);
        const action = await createPublicShellLocaleFailureAction(input);
        let handler;
        const context = { route: async (_, callback) =>
        {
            handler = callback;
        }, unroute: async () =>
        {} };
        const fault = await bindPublicShellLocaleFault({ ...input, action, context });
        let delivered;
        const work = handler({ request: () => ({ method: () => 'GET' }), fulfill: async (options) =>
        {
            assert.equal(options.contentType, 'font/woff2');
            delivered = options.body;
        }, abort: async () => assert.fail('wrong-font identity is not a load failure') });
        await fault.entered;
        fault.release();
        await fault.completed;
        await work;
        assert.equal(digestBytes(delivered), input.bindings.resources[1].digest);
        await fault.dispose();
        for (const change of ['same-body', 'same-identity', 'wrong-weight'])
        {
            const copy = fontMutationFixture(mode);
            if (change === 'same-body')
            {
                copy.replacementUrl = copy.url;
            }
            if (change === 'same-identity')
            {
                copy.bindings.resources[1].identities = copy.bindings.resources[0].identities;
            }
            if (change === 'wrong-weight')
            {
                copy.bindings.resources[1].identities[0].weight = 500;
            }
            await assert.rejects(createPublicShellLocaleFailureAction(copy));
        }
    });
}

function fixedResponseFrame(locale, revision)
{
    // POD fixture is checked by the real production decoder, never used in production injection.
    const bytes = responseFrame({ revision: BigInt(revision) });
    const payload = bytes.slice(protocol.header.size);
    payload[16] = 2;
    payload[17] = 1;
    payload[18] = preference.locales.findIndex((item) => item.code === locale) + 1;
    return new Uint8Array(encodeAedsFrame(protocol.frameTypes.find((item) => item.name === 'UserLocalePreference').value, payload));
}

function nativeDeliveryFixture(mode, authActionContext = 'authenticated', options = {})
{
    const source = 'en-US';
    const target = mode === 'late' ? 'ja-JP' : 'ru-RU';
    const initialRevision = authActionContext === 'anonymous' ? 0 : 7;
    const bindings = { preference, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' };
    const scene = { issue: 2087, locale: 'ru-RU', authActionContext,
        stage: mode === 'late' ? 'superseded-failure' : mode === 'stale' ? 'revision-conflict' : 'preference-failure',
        transition: { failureMode: mode === 'late' ? 'late-preference' : mode === 'stale' ? 'stale-response' : 'network-failure',
            rapidTargets: ['ja-JP', 'de-DE', 'ru-RU'] } };
    const headers = { 'content-type': preference.mediaType, 'cache-control': 'no-store' };
    let handler;
    let state = authActionContext === 'anonymous' ? responseFrame() : fixedResponseFrame(source, initialRevision);
    let forwards = 0;
    const deliveries = [];
    const context = { cookies: async () => [], request: { get: async () => ({ status: () => 200, headers: () => headers,
        body: async () => state }) }, route: async (_, callback) =>
    {
        handler = callback;
    }, unroute: async () =>
    {} };
    const requestBytes = preference.encodeRequest('fixed', target, initialRevision);
    const route = { request: () => ({ method: () => 'PUT', postDataBuffer: () => requestBytes }), fetch: async (fetchOptions) =>
    {
        forwards += 1;
        assert.equal(fetchOptions.postData, undefined, 'forward original production request unchanged');
        assert.equal(fetchOptions.headers, undefined, 'do not override auth/security headers');
        assert.equal(fetchOptions.maxRetries, 0);
        assert.equal(fetchOptions.maxRedirects, 0);
        const body = options.body ?? fixedResponseFrame(target, authActionContext === 'anonymous' ? 0 : initialRevision + 1);
        if (!options.keepOld && authActionContext !== 'anonymous')
        {
            state = body;
        }
        return { status: () => options.status ?? 200, headers: () => headers, body: async () => body };
    }, fulfill: async (value) => deliveries.push({ kind: 'fulfill', ...value }),
    abort: async (code) => deliveries.push({ kind: 'abort', code }) };
    return { bindings, scene, context, route, url: bindings.preferenceUrl,
        beforePreference: { snapshot: preference.decodeResponse(state) },
        delivery: mode === 'lost' ? 'server-committed-response-loss' : null,
        handler: () => handler, forwards: () => forwards, deliveries };
}

for (const auth of ['anonymous', 'authenticated', 'admin'])
{
    for (const mode of ['stale', 'late', 'lost'])
    {
        test(`native ${auth} ${mode} forwards unchanged PUT and decodes 200/GET before releasing response (Node route self-test)`, async () =>
        {
            const input = nativeDeliveryFixture(mode, auth);
            const action = await createPublicShellLocaleFailureAction(input);
            const fault = await bindPublicShellLocaleFault({ ...input, action });
            const work = input.handler()(input.route);
            const observed = await fault.serverObserved;
            await fault.entered;
            assert.equal(input.deliveries.length, 0, 'response was not held');
            assert.equal(observed.status, 200);
            assert.equal(observed.preference.fixedLocale, action.targetLocale);
            assert.equal(observed.preference.revision, auth === 'anonymous' ? 0 : 8);
            assert.deepEqual(observed.nativeRequests.map((request) => request.method), ['GET', 'GET', 'PUT', 'GET']);
            assert.equal(input.forwards(), 1);
            fault.release();
            const injection = await fault.completed;
            await work;
            await fault.dispose();
            if (mode === 'lost')
            {
                assert.deepEqual(input.deliveries, [{ kind: 'abort', code: 'failed' }]);
                assert.equal(injection.transport, 'failed-after-native-200');
            }
            else if (mode === 'stale')
            {
                assert.equal(digestBytes(input.deliveries[0].body), injection.preferenceBeforeDigest);
                assert.notEqual(injection.deliveredDigest, injection.contentDigest);
                assert.equal(injection.staleSemantics, auth === 'anonymous' ? 'older-device-state' : 'lower-account-revision');
                assert.equal(preference.decodeResponse(new Uint8Array(input.deliveries[0].body)).revision, auth === 'anonymous' ? 0 : 7);
            }
            else
            {
                assert.equal(input.deliveries[0].body, undefined);
                assert.equal(injection.deliveredDigest, injection.contentDigest);
            }
        });
    }
}

for (const [name, options] of [
    ['real 409, not a lost success', { status: 409, body: conflictFrame() }],
    ['real 403, not a lost success', { status: 403, body: conflictFrame({ status: 403 }) }],
    ['wrong target response', { body: fixedResponseFrame('de-DE', 8) }],
    ['stale response revision from server', { body: fixedResponseFrame('ru-RU', 7) }],
    ['GET never confirmed commit', { keepOld: true }],
    ['invalid AEDS bytes', { body: new Uint8Array([1, 2, 3]) }]
])
{
    test(`native success-loss rejects ${name} and retains original injection failure (Node self-test)`, async () =>
    {
        const input = nativeDeliveryFixture('lost', 'authenticated', options);
        const action = await createPublicShellLocaleFailureAction(input);
        const fault = await bindPublicShellLocaleFault({ ...input, action });
        const work = input.handler()(input.route);
        await assert.rejects(fault.completed);
        await work;
        await fault.dispose();
        const receipt = fault.trace()[0];
        assert.equal(receipt.status, options.status ?? 200);
        assert.ok(receipt.failure?.message);
        if (options.status === 409)
        {
            assert.equal(receipt.error.kind, 'revision-conflict');
        }
        await assert.rejects(fault.entered, (error) => error.message === receipt.failure.message,
            'native first failure must not become the diagnostic interception timeout');
        assert.equal(input.deliveries.some((item) => item.kind === 'fulfill'), false);
    });
}

test('preference GET pass-through retains the earlier missing-header handler (Node route self-test)', async () =>
{
    const input = nativeDeliveryFixture('lost');
    const action = await createPublicShellLocaleFailureAction(input);
    const fault = await bindPublicShellLocaleFault({ ...input, action });
    const original = { 'Accept-Language': 'en-US,en;q=0.9', accept: preference.mediaType,
        authorization: 'owned-model-auth', 'x-fsus-client': 'owned-model-client' };
    let earlierHandlerCalls = 0;
    let networkCalls = 0;
    let sent;
    const route = {
        request: () => ({ method: () => 'GET', allHeaders: async () => original }),
        continue: async (options) =>
        {
            networkCalls += 1;
            sent = options?.headers ?? original;
        },
        fallback: async () =>
        {
            earlierHandlerCalls += 1;
            const headers = { ...await route.request().allHeaders() };
            for (const name of Object.keys(headers))
            {
                if (name.toLowerCase() === 'accept-language')
                {
                    delete headers[name];
                }
            }
            await route.continue({ headers });
        },
        fetch: async () => assert.fail('GET pass-through must not issue a helper request'),
        fulfill: async () => assert.fail('GET pass-through must not inject a response'),
        abort: async () => assert.fail('GET pass-through must not abort the request')
    };
    try
    {
        await input.handler()(route);
        assert.equal(earlierHandlerCalls, 1, 'GET bypassed the earlier missing-header handler');
        assert.equal(networkCalls, 1);
        assert.deepEqual(sent, { accept: preference.mediaType,
            authorization: 'owned-model-auth', 'x-fsus-client': 'owned-model-client' });
        assert.equal(original['Accept-Language'], 'en-US,en;q=0.9');
        assert.equal(input.forwards(), 0);
        assert.deepEqual(fault.trace(), []);
    }
    finally
    {
        await fault.dispose();
    }
});

test('lost native response permits but records product compensation PUT; no helper sends a compensation command', async () =>
{
    const input = nativeDeliveryFixture('lost');
    const action = await createPublicShellLocaleFailureAction(input);
    const fault = await bindPublicShellLocaleFault({ ...input, action });
    const work = input.handler()(input.route);
    await fault.serverObserved;
    await fault.entered;
    fault.release();
    await fault.completed;
    await work;
    let continued = 0;
    let earlierHandlerCalls = 0;
    const compensation = preference.encodeRequest('fixed', 'en-US', 8);
    const compensationRoute = { request: () => ({ method: () => 'PUT', postDataBuffer: () => compensation }),
        continue: async () =>
        {
            continued += 1;
        },
        fallback: async () =>
        {
            earlierHandlerCalls += 1;
            await compensationRoute.continue();
        }, fetch: async () => assert.fail('helper must not forward/fabricate a second compensating command') };
    await input.handler()(compensationRoute);
    assert.equal(earlierHandlerCalls, 1, 'compensation bypassed the earlier route');
    assert.equal(continued, 1);
    assert.equal(input.forwards(), 1);
    assert.equal(fault.trace()[1].kind, 'pass-through-put');
    assert.deepEqual(fault.trace()[1].command, { mode: 'fixed', fixedLocale: 'en-US', expectedRevision: 8 });
    await fault.dispose();
});

test('compensation facts retain increased revisions and cannot pass the strict #2087 rollback contract', () =>
{
    const before = { snapshot: preference.decodeResponse(fixedResponseFrame('en-US', 7)), cookies: [] };
    const compensated = preference.decodeResponse(fixedResponseFrame('en-US', 9));
    const after = { snapshot: compensated, cookies: [] };
    const injection = { kind: 'preference-response', delivery: 'lost', status: 200,
        preference: preference.decodeResponse(fixedResponseFrame('ru-RU', 8)) };
    const writes = [{ status: 200, command: { mode: 'fixed', fixedLocale: 'en-US', expectedRevision: 8 },
        preference: compensated, contentDigest: digestBytes(fixedResponseFrame('en-US', 9)) }];
    const scene = { authActionContext: 'authenticated' };
    const facts = assertPublicShellLocaleResponseLossCompensation({ before, after, injection, writes, scene });
    assert.equal(facts.compensatedRevision, 9);
    assert.throws(() => assertPublicShellLocalePreferenceOutcome({ before, after, writes, scene, outcome: 'rollback' }), /changed authoritative/u);
    assert.throws(() => assertPublicShellLocaleResponseLossCompensation({ before, after, injection, writes: [], scene }), /compensating PUT/u);
    assert.throws(() => assertPublicShellLocaleResponseLossCompensation({ before, after, injection,
        writes: [{ ...writes[0], command: { ...writes[0].command, expectedRevision: 7 } }], scene }), /old revision/u);
});

test('rapid late-resource action holds original first-target bytes, rejects final-target or changed bytes', async () =>
{
    const input = artifactActionFixture('late-resource');
    input.scene.stage = 'superseded-failure';
    input.scene.locale = 'ru-RU';
    input.scene.transition.rapidTargets = ['ja-JP', 'de-DE', 'ru-RU'];
    const action = await createPublicShellLocaleFailureAction(input);
    assert.equal(digestBytes(action.body), input.bindings.resources[0].digest);
    assert.equal(action.mutation.recipe, 'hold-sealed-response');
    assert.throws(() => assertPublicShellLocaleFaultBinding({ ...input, action: { ...action, body: new Uint8Array([1]) } }));
    input.bindings.resources[0].identities[0].locale = 'ru-RU';
    await assert.rejects(createPublicShellLocaleFailureAction(input), /first superseded target/u);
});

test('late resource is fulfilled only after caller releases a real event barrier, with its sealed bytes unchanged (Node route self-test)', async () =>
{
    const input = artifactActionFixture('late-resource');
    input.scene = { ...input.scene, stage: 'superseded-failure', locale: 'ru-RU',
        transition: { failureMode: 'late-resource', rapidTargets: ['ja-JP', 'de-DE', 'ru-RU'] } };
    const action = await createPublicShellLocaleFailureAction(input);
    let handler;
    const context = { route: async (_, callback) =>
    {
        handler = callback;
    }, unroute: async () =>
    {} };
    const fault = await bindPublicShellLocaleFault({ ...input, context, action });
    const delivered = [];
    const work = handler({ request: () => ({ method: () => 'GET' }), fulfill: async (value) => delivered.push(value),
        abort: async () => assert.fail('late valid bytes are not a load failure') });
    await fault.entered;
    assert.equal(delivered.length, 0);
    fault.release();
    const injection = await fault.completed;
    await work;
    await fault.dispose();
    assert.equal(delivered.length, 1);
    assert.equal(digestBytes(delivered[0].body), input.bindings.resources[0].digest);
    assert.equal(injection.interceptedRequestOrdinal, 1);
    assert.deepEqual(injection.nativeRequests, []);
});

test('complete-preparation retry scene injects a real required-domain HTTP failure, not a success flag', async () =>
{
    const input = faultFixture();
    input.scene = { ...input.scene, issue: 2087, stage: 'retry', transition: { failureMode: 'complete-preparation' } };
    const action = await createPublicShellLocaleFailureAction(input);
    assert.deepEqual(action, { kind: 'http-error', status: 503 });
    assert.throws(() => assertPublicShellLocaleFaultBinding({ ...input, action: { kind: 'http-error', status: 200 } }));
});

test('latest-wins assertion rejects late overwrite, duplicate/old commits and stale winner revision (Node evidence self-test)', () =>
{
    const input = nativeDeliveryFixture('late');
    const business = { nodeIdentity: 1, textDigest: 'unchanged', scroll: { x: 0, y: 0 } };
    const before = { business, evidence: { responses: [], browser: { recorder: { events: [] } } } };
    const dom = { language: 'ru-RU', selectors: [{ active: 'ru-RU', pending: null }] };
    const snapshot = preference.decodeResponse(fixedResponseFrame('ru-RU', 9));
    const write = { url: input.url, method: 'PUT', status: 200, requestOrdinal: 1,
        command: { fixedLocale: 'ru-RU', expectedRevision: 8 }, preference: snapshot };
    const original = { url: input.url, method: 'PUT', status: 200, requestOrdinal: 0,
        command: { fixedLocale: 'ja-JP', expectedRevision: 7 }, preference: preference.decodeResponse(fixedResponseFrame('ja-JP', 8)),
        commandDigest: 'sha256:real-command', contentDigest: 'sha256:real-native' };
    const after = { business, dom, preference: { snapshot, cookies: [{ locale: 'ru-RU', httpOnly: true }] },
        evidence: { responses: [write, original], browser: { recorder: { events: [{ name: 'locale_runtime_committed', locale: 'ru-RU', generation: 4 }] } } } };
    const injection = { kind: 'preference-response', status: 200, preference: preference.decodeResponse(fixedResponseFrame('ja-JP', 8)),
        deliveredDigest: 'sha256:real-native', contentDigest: 'sha256:real-native', commandDigest: 'sha256:real-command' };
    const fixture = { bindings: { ...input.bindings, locales: preference.locales }, scene: input.scene, before,
        latestPending: { dom: { selectors: [{ pending: 'ru-RU' }] }, evidence: { requests: [{}], browser: { recorder: { events: [] } } } },
        superseded: { dom }, after, injection };
    assertPublicShellLocaleSupersededOutcome(fixture);
    for (const mutate of [
        (copy) => copy.after.dom.language = 'ja-JP',
        (copy) => copy.after.evidence.browser.recorder.events.push({ name: 'locale_runtime_committed', locale: 'ja-JP', generation: 3 }),
        (copy) => copy.after.preference.snapshot.fixedLocale = 'ja-JP',
        (copy) => copy.after.evidence.responses[0].command.expectedRevision = 7,
        (copy) => copy.after.business.nodeIdentity = 2,
        (copy) => copy.latestPending.evidence.requests.push({}),
        (copy) => copy.latestPending.evidence.browser.recorder.events.push(copy.after.evidence.browser.recorder.events[0]),
        (copy) => copy.injection.deliveredDigest = 'sha256:synthetic'
    ])
    {
        const copy = { ...fixture, before: structuredClone(before), after: structuredClone(after),
            latestPending: structuredClone(fixture.latestPending), superseded: structuredClone(fixture.superseded), injection: structuredClone(injection) };
        mutate(copy);
        assert.throws(() => assertPublicShellLocaleSupersededOutcome(copy));
    }
});

for (const authActionContext of ['anonymous', 'authenticated'])
{
    test(`repeated ja target retains both native ${authActionContext} PUTs and identifies latest by actual request cursor (Node evidence self-test)`, () =>
    {
        const input = nativeDeliveryFixture('late', authActionContext);
        const scene = { ...input.scene, locale: 'ja-JP', transition: { ...input.scene.transition, rapidTargets: ['ja-JP', 'de-DE', 'ru-RU', 'ja-JP'] } };
        const oldRevision = authActionContext === 'anonymous' ? 0 : 8;
        const newRevision = authActionContext === 'anonymous' ? 0 : 9;
        const oldBody = fixedResponseFrame('ja-JP', oldRevision);
        const oldCommand = preference.encodeRequest('fixed', 'ja-JP', authActionContext === 'anonymous' ? 0 : 7);
        const oldWrite = { url: input.url, method: 'PUT', status: 200, requestOrdinal: 0,
            command: preference.inspectRequest(oldCommand), commandDigest: digestBytes(oldCommand),
            contentDigest: digestBytes(oldBody), preference: preference.decodeResponse(oldBody) };
        const body = fixedResponseFrame('ja-JP', newRevision);
        const command = preference.encodeRequest('fixed', 'ja-JP', oldRevision);
        const newWrite = { url: input.url, method: 'PUT', status: 200, requestOrdinal: 4,
            command: preference.inspectRequest(command), contentDigest: digestBytes(body), preference: preference.decodeResponse(body) };
        const business = { identity: 1 };
        const before = { business, evidence: { responses: [], browser: { recorder: { events: [] } } } };
        const dom = { language: 'ja-JP', selectors: [{ active: 'ja-JP', pending: null }] };
        const after = { business, dom, preference: { snapshot: authActionContext === 'anonymous' ? preference.decodeResponse(responseFrame()) : newWrite.preference,
            cookies: [{ locale: 'ja-JP', httpOnly: true }] }, evidence: { responses: [oldWrite, newWrite],
            browser: { recorder: { events: [{ name: 'locale_runtime_committed', locale: 'ja-JP', generation: 7 }] } } } };
        const latestPending = { dom: { selectors: [{ pending: 'ja-JP' }] },
            evidence: { requests: [{}, {}, {}, {}], browser: { recorder: { events: [] } } } };
        const injection = { kind: 'preference-response', status: 200, preference: oldWrite.preference,
            commandDigest: oldWrite.commandDigest, contentDigest: oldWrite.contentDigest, deliveredDigest: oldWrite.contentDigest };
        const args = { bindings: { ...input.bindings, locales: preference.locales }, scene, before, latestPending, superseded: { dom }, after, injection };
        assertPublicShellLocaleSupersededOutcome(args);
        assert.equal(after.evidence.responses.length, 2, 'old response evidence must not be filtered away');
        assert.throws(() => assertPublicShellLocaleSupersededOutcome({ ...args,
            after: { ...after, evidence: { ...after.evidence, responses: [oldWrite] } } }), /missing native/u);
    });
}

function waterfallFixture()
{
    const fonts = fontFixture();
    const identity = { matrixDigest: 'actual' };
    const domain = { url: 'http://127.0.0.1/opaque-hash.js', digest: 'sha256:domain',
        identities: [{ kind: 'domain', locale: fonts.font.locale, domain: 'public' }] };
    const resources = [domain, ...fonts.responses.map((response, index) => ({
        ...response.resource, url: `http://127.0.0.1/opaque-${index}.woff2`
    }))];
    return { bindings: { identity, resources, preference, preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' },
        scene: { issue: 2085, stage: 'initial-network', locale: fonts.font.locale, requiredDomains: ['public'], requiredFont: fonts.font,
            networkPolicy: { includeCacheAndPreload: true, businessDataReRequests: 0 } },
        evidence: { identity, issues: [], requests: resources.map((resource, index) => ({ url: resource.url, urlDigest: String(index), method: 'GET' })),
            browser: { performance: [], preloads: [{ url: domain.url }] }, responses: [
                { status: 200, contentDigest: domain.digest, resource: domain },
                ...fonts.responses.map((response, index) => ({ ...response, resource: resources[index + 1] }))
            ] }, fontObservation: fonts.observation };
}

test('waterfall maps opaque hashed filenames through admitted manifest identity, including preload/cache', () =>
{
    const input = waterfallFixture();
    input.evidence.browser.performance.push({ url: input.bindings.resources[0].url, transferSize: 0 });
    assert.deepEqual(assertPublicShellLocaleResourceWaterfall(input), { observedDomains: ['public'], requestCount: 4 });
});

for (const [name, mutate] of [
    ['other locale', (input) =>
    {
        input.bindings.resources[0].identities[0].locale = 'en-US';
    }],
    ['unrelated domain', (input) =>
    {
        input.bindings.resources[0].identities[0].domain = 'admin';
    }],
    ['unregistered resource', (input) =>
    {
        input.evidence.requests.push({ url: 'http://127.0.0.1/unknown.js', method: 'GET' });
    }],
    ['missing body observation', (input) =>
    {
        input.evidence.responses.shift();
    }],
    ['filtered browser warning', (input) =>
    {
        input.evidence.issues.push({ kind: 'warning' });
    }],
    ['duplicate domain request', (input) =>
    {
        input.evidence.requests.push(structuredClone(input.evidence.requests[0]));
    }],
    ['unowned font request', (input) =>
    {
        const resource = { url: 'http://127.0.0.1/foreign.woff2', identities: [{ kind: 'static' }] };
        input.bindings.resources.push(resource);
        input.evidence.requests.push({ url: resource.url, method: 'GET', resourceType: 'font' });
    }]
])
{
    test(`waterfall fails closed on ${name}`, () =>
    {
        const input = waterfallFixture();
        mutate(input);
        assert.throws(() => assertPublicShellLocaleResourceWaterfall(input));
    });
}

test('transaction request cursor permits formal preference only, not business/unknown/document work', () =>
{
    const input = waterfallFixture();
    const before = input.evidence.requests.length;
    input.evidence.requests.push({ url: input.bindings.preferenceUrl, urlDigest: 'pref', method: 'PUT' });
    assertPublicShellLocaleNoBusinessRequests({ ...input, requestOffset: before });
    for (const request of [
        { url: 'http://127.0.0.1/api/binary/articles/1', method: 'GET' },
        { url: 'http://127.0.0.1/', method: 'GET', resourceType: 'document' }
    ])
    {
        assert.throws(() => assertPublicShellLocaleNoBusinessRequests({ ...input,
            evidence: { requests: [...input.evidence.requests, request] }, requestOffset: before }));
    }
    assert.throws(() => assertPublicShellLocaleNoBusinessRequests({ ...input, requestOffset: -1 }));
});

for (const stage of ['success', 'operation', 'capture', 'disposal', 'normal-sink', 'tail-sink', 'operation-and-cleanup', 'operation-without-page'])
{
    test(`lease passthrough keeps the actual callback reference at observe and both original sinks: ${stage}`, async () =>
    {
        const model = originalCaptureModel();
        const lease = Object.freeze({ leaseId: 'callback-model-lease', contextId: 'callback-model-context',
            actorId: 'callback-model-actor', sceneId: model.scene.id, role: 'model-only',
            owner: Object.freeze({ sameReference: Symbol('actual callback owner') }), authority: 'callback-model' });
        const fixture = Object.freeze({ originalFixture: true });
        const negotiation = Object.freeze({ originalNegotiation: true });
        const result = Object.freeze({ originalResult: true });
        const first = new Error(`first ${stage} failure`);
        const secondary = new Error('secondary cleanup or sink failure');
        const records = [];
        const observed = [];
        let closed = false;
        let created = 0;
        const evaluate = model.page.evaluate;
        model.page.evaluate = async (callback) =>
        {
            if (callback.toString().includes('performance:'))
            {
                if (stage === 'capture')
                {
                    throw first;
                }
            }
            else if (stage === 'disposal')
            {
                throw first;
            }
            else if (stage === 'operation-and-cleanup')
            {
                throw secondary;
            }
            return await evaluate(callback);
        };
        const harness = { identity: model.bindings.identity, withScene: async (sceneId, create, observe) =>
        {
            assert.equal(sceneId, model.scene.id);
            await create(lease);
            try
            {
                return await observe({ context: model.context, fixture, negotiation, lease });
            }
            finally
            {
                closed = true;
            }
        } };
        const run = withPublicShellLocaleLifecycleScene({ harness, matrix: { contentDigest: model.bindings.identity.matrixDigest,
            scenes: [model.scene] }, bindings: model.bindings, sceneId: model.scene.id,
        createContext: async (actualLease) =>
        {
            created += 1;
            assert.equal(actualLease, lease);
            return model.context;
        }, observe: async (input) =>
        {
            observed.push(input);
            if (stage !== 'operation-without-page')
            {
                model.pages.push(model.page);
                model.listeners.get('page')(model.page);
                model.listeners.get('request')(model.request('PUT', Buffer.from(preference.encodeRequest('fixed', 'ja-JP', 0))));
            }
            if (['operation', 'operation-and-cleanup', 'operation-without-page'].includes(stage))
            {
                throw first;
            }
            return result;
        }, saveEvidence: async (record) =>
        {
            assert.equal(closed, false);
            records.push(record);
            if (stage === 'operation-and-cleanup')
            {
                throw secondary;
            }
            if (stage === 'normal-sink' && records.length === 1 || stage === 'tail-sink' && records.length === 2)
            {
                throw first;
            }
        } });
        if (stage === 'success')
        {
            assert.equal(await run, result);
        }
        else
        {
            await assert.rejects(run, (error) => error === first);
        }
        assert.equal(created, 1);
        assert.equal(observed.length, 1);
        assert.equal(observed[0].lease, lease, 'observe must receive the same original lease, not a clone/inference');
        assert.equal(observed[0].context, model.context);
        assert.equal(observed[0].fixture, fixture);
        assert.equal(observed[0].negotiation, negotiation);
        assert.equal(records.length, 2);
        assert.ok(records.every((record) => record.lease === lease), 'both original sinks must receive the actual callback lease');
        assert.equal(records[1].evidence.phase, 'observer-disposal');
        assert.equal(Object.hasOwn(records[1].evidence, 'ended'), false);
        assert.ok(records.every((record) => Object.isFrozen(record.privateOriginals)));
        assert.ok(records.every((record) => record.privateOriginals.binding.sceneId === model.scene.id));
        assert.ok(records.every((record) => !Object.hasOwn(record.privateOriginals.binding, 'lease')));
        for (const record of records)
        {
            assert.deepEqual(record.privateOriginals.binding.identity, model.bindings.identity);
            assert.equal(record.privateOriginals.captureCut, record.evidence.captureCut ?? record.privateOriginals.captureCut);
            assert.equal(JSON.stringify(record.evidence).includes('leaseId'), false);
        }
        if (['operation', 'capture', 'operation-and-cleanup', 'operation-without-page'].includes(stage))
        {
            assert.ok(records.every((record) => record.failure.message === first.message));
        }
        if (stage === 'disposal')
        {
            assert.equal(records[0].failure, null);
            assert.equal(records[1].failure.message, first.message);
            assert.ok(records[1].privateOriginals.failures.some((failure) => failure.reason === 'recorder-dispose-failed'));
        }
        assert.equal(closed, true);
        assert.equal(model.listeners.size, 0);
    });
}

for (const stage of ['operation', 'capture'])
{
    test(`canonical lifecycle retains the first ${stage} failure and saves before closing (Node lifecycle self-test)`, async () =>
    {
        const listeners = new Map();
        let pages = [];
        let closed = false;
        let saved = false;
        const first = new Error('first scene failure');
        const context = {
            on: (name, callback) => listeners.set(name, callback), off: (name) => listeners.delete(name),
            addInitScript: async () =>
            {}, pages: () => pages
        };
        const identity = { matrixDigest: 'actual' };
        const harness = { identity, withScene: async (_, factory, observe) =>
        {
            await factory();
            try
            {
                return await observe({ context, fixture: {}, negotiation: {} });
            }
            finally
            {
                closed = true;
            }
        } };
        const page = { on: () =>
        {}, off: () =>
        {}, isClosed: () => false, evaluate: async (callback) =>
        {
            if (callback.toString().includes('performance:'))
            {
                if (stage === 'capture')
                {
                    throw first;
                }
                return { recorder: { errors: [], overflow: false }, performance: [], preloads: [] };
            }
        } };
        await assert.rejects(withPublicShellLocaleLifecycleScene({ harness, sceneId: 'actual-scene',
            matrix: { contentDigest: 'actual', scenes: [{ id: 'actual-scene' }] },
            bindings: { identity, resources: [], preferenceUrl: 'http://127.0.0.1/api/binary/locale-preference' },
            createContext: async () => context, observe: async () =>
            {
                pages = [page];
                listeners.get('page')(page);
                if (stage === 'operation')
                {
                    throw first;
                }
            }, saveEvidence: async ({ failure, page: observed }) =>
            {
                assert.equal(closed, false);
                assert.equal(observed, page);
                assert.equal(failure.message, first.message);
                saved = true;
                throw new Error('secondary evidence sink failure');
            } }), (error) => error === first);
        assert.equal(saved, true);
        assert.equal(closed, true);
        assert.equal(listeners.size, 0);
    });
}


for (const [name, revision] of [['negative', -1], ['fractional', 0.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['NaN', Number.NaN], ['string', '7']])
{
    test(`preference outcome rejects coherently forged ${name} CAS revisions`, () =>
    {
        const input = commitFixture('user');
        input.before.snapshot.revision = revision;
        input.writes[0].command.expectedRevision = revision;
        input.after.snapshot.revision = revision + 1;
        input.writes[0].preference.revision = revision + 1;
        assert.throws(() => assertPublicShellLocalePreferenceOutcome(input), /revision/u);
    });
}
