/* global document */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the immutable production build admission authority.
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';

import {
    consumePublicShellLocaleScene,
    finishPublicShellLocaleScene,
    loadBrowserContractFixture,
    preparePublicShellLocaleScene,
    readPublicShellLocaleScenePublishedArtifact
} from './fixture.mjs';
import { validatePublicShellLocaleMatrix } from './public-shell-locale-matrix.mjs';

/** Consume the existing runner's prepared host; this facade never starts another lifecycle. */
export async function admitPublicShellLocaleHarness({ root, matrix, prepared, buildReceiptFile, env })
{
    assert.equal(env?.FSUSBLOG_PLAYWRIGHT_SESSION_MODE, 'browser-contract', 'canonical browser-contract mode required');
    assert.equal(prepared?.lifecycle?.status, 'prepared', 'formal host/fixture preparation must finish before locale admission');
    assert.ok(prepared.root && prepared.lifecycle.preparation?.id, 'current-run prepared fixture identity required');
    await validatePublicShellLocaleMatrix(matrix, root);
    const sourceState = {
        commit: matrix.identity.sourceCommit,
        worktreeFingerprint: matrix.identity.worktreeFingerprint
    };
    const verified = verifyProductionBuildReceipt({
        artifactRoot: path.dirname(buildReceiptFile),
        receiptFile: path.basename(buildReceiptFile),
        expectedSourceState: sourceState,
        repairReadOnlySeal: false
    });
    for (const domain of ['backend-runtime', 'frontend-dist', 'generated-contracts', 'wasm'])
    {
        assert.ok(verified.receipt.domains.some((item) => item.name === domain), `missing immutable build domain: ${domain}`);
    }
    const fixture = await loadBrowserContractFixture({
        repoRoot: root,
        env: { ...env, FSUSBLOG_TEST_SESSION: prepared.identity.namespace },
        fixtureRoot: prepared.root,
        lifecycle: prepared.lifecycle,
        expectedSourceState: sourceState,
        expectedBuild: { receiptContentDigest: verified.receipt.contentDigest }
    });
    assert.equal(fixture.testSession, null, 'locale harness cannot send a test-session header');
    let active = false;
    let boundBrowser = null;
    let boundFactory = null;
    let expectedHandle = null;
    const visited = new Set();
    return Object.freeze({
        identity: Object.freeze({
            matrixDigest: matrix.contentDigest,
            sourceState,
            buildDigest: verified.receipt.contentDigest,
            namespace: fixture.namespace,
            preparationId: prepared.lifecycle.preparation.id
        }),
        fixture,
        /** Bind the runner's existing Browser; the fixture owner creates each leased context. */
        contextFactory(browser)
        {
            assert.equal(active, false, 'cannot bind a Browser during an active locale scene');
            assert.equal(boundBrowser, null, 'locale Browser owner is already bound');
            assert.equal(typeof browser?.newContext, 'function', 'canonical Browser owner required');
            assert.equal(typeof browser?.contexts, 'function', 'canonical Browser context inventory required');
            boundBrowser = browser;
            boundFactory = async (handle) =>
            {
                assert.ok(expectedHandle && handle === expectedHandle, 'context creation requires the current scene lease');
                expectedHandle = null;
                return await consumePublicShellLocaleScene(prepared, handle, boundBrowser);
            };
            return boundFactory;
        },
        /** Reuse the formal scene lease; never copy fixed user/admin preference state. */
        async withScene(sceneId, createContext, observe)
        {
            assert.equal(active, false, 'locale scenes must run serially');
            assert.equal(visited.has(sceneId), false, 'locale scene retry is forbidden');
            assert.ok(boundFactory && createContext === boundFactory, 'canonical leased context factory required');
            assert.equal(typeof observe, 'function', 'locale scene observer required');
            const scene = matrix.scenes.find((item) => item.id === sceneId);
            assert.ok(scene, 'unknown locale scene');
            const negotiation = matrix.negotiationCases.find((item) => item.id === scene.negotiationId);
            assert.ok(negotiation, 'missing negotiation case');
            active = true;
            visited.add(sceneId);
            let handle;
            let context;
            let firstError;
            let result;
            try
            {
                handle = await preparePublicShellLocaleScene(prepared, { matrix, sceneId });
                if (handle.status === 'blocked')
                {
                    const error = new Error(`locale scene actor is blocked: ${handle.reason}`);
                    error.sceneBlocker = handle;
                    throw error;
                }
                expectedHandle = handle;
                context = await createContext(handle);
                result = await observe({ context, fixture, scene, negotiation, lease: handle,
                    readPublishedArtifact: (selectedPath) => readPublicShellLocaleScenePublishedArtifact(
                        prepared, handle, context, selectedPath) });
            }
            catch (error)
            {
                firstError = error;
            }
            expectedHandle = null;
            if (context)
            {
                try
                {
                    await finishPublicShellLocaleScene(prepared, handle, context, firstError);
                    active = false;
                }
                catch (error)
                {
                    if (firstError)
                    {
                        firstError.sceneCleanupError = error;
                    }
                    else
                    {
                        firstError = error;
                    }
                }
            }
            else if (!handle || handle.status === 'blocked')
            {
                active = false;
            }
            // Failed creation/close retains the active owner; never admit a later scene over it.
            if (firstError)
            {
                throw firstError;
            }
            return result;
        }
    });
}

/** An explicit event barrier at the resource boundary; no timers or product state hooks. */
export function createPublicShellLocaleResourceBarrier()
{
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let state = 'pending';
    let requests = 0;
    return Object.freeze({
        entered: entered.promise,
        async wait()
        {
            assert.notEqual(state, 'closed', 'resource barrier is closed');
            requests += 1;
            assert.equal(requests, 1, 'resource barrier cannot hide duplicate requests');
            entered.resolve();
            return await released.promise;
        },
        release(action = { kind: 'continue' })
        {
            assert.equal(state, 'pending', 'resource barrier is already settled');
            assert.ok(['continue', 'abort', 'http-error', 'invalid-content'].includes(action.kind), 'unknown resource action');
            if (action.kind === 'http-error')
            {
                assert.ok(Number.isInteger(action.status) && action.status >= 400 && action.status <= 599, 'failure status required');
            }
            if (action.kind === 'invalid-content')
            {
                assert.equal(typeof action.body, 'string', 'invalid-content bytes required');
                assert.equal(typeof action.contentType, 'string', 'invalid-content type required');
            }
            state = 'released';
            released.resolve(structuredClone(action));
        },
        close()
        {
            if (state === 'pending')
            {
                released.resolve({ kind: 'abort' });
            }
            state = 'closed';
        }
    });
}

/** Install on the existing context before navigation; exact URLs come from artifact identities. */
export async function bindPublicShellLocaleResourceBarrier(context, resourceUrl, barrier)
{
    const url = new URL(resourceUrl);
    assert.ok(['http:', 'https:'].includes(url.protocol), 'resource must use HTTP');
    assert.equal(url.username + url.password + url.hash, '', 'resource URL must not contain credentials or a fragment');
    const matches = (candidate) => candidate.href === url.href;
    const handler = async (route) =>
    {
        const action = await barrier.wait();
        if (action.kind === 'continue')
        {
            // Preserve earlier context routes, including actual missing Accept-Language removal.
            await route.fallback();
        }
        else if (action.kind === 'abort')
        {
            await route.abort('failed');
        }
        else if (action.kind === 'http-error')
        {
            await route.fulfill({ status: action.status, body: '' });
        }
        else
        {
            await route.fulfill({ status: 200, contentType: action.contentType, body: action.body });
        }
    };
    await context.route(matches, handler);
    return async () =>
    {
        barrier.close();
        await context.unroute(matches, handler);
    };
}

/** Observe the runner's real anonymous scenario without creating a page or advancing product state. */
export function observePublicShellLocaleProbe(page, identity, { signal, matrix, saveOriginalResponse = null } = {})
{
    assert.equal(signal?.aborted === true, false, 'locale probe cannot start after abort');
    assert.ok(saveOriginalResponse === null || typeof saveOriginalResponse === 'function', 'private probe sink required');
    const sha256 = (value) => createHash('sha256').update(value).digest('hex');
    const requests = [];
    const issues = [];
    let firstDocument = null;
    let capturedDocument = null;
    let originalPublication = null;
    let disposed = false;
    let finished = false;
    const onRequest = (request) =>
    {
        requests.push({
            resourceIdentity: sha256(request.url()),
            resourceType: request.resourceType(),
            method: request.method()
        });
    };
    const onResponse = (response) =>
    {
        if (firstDocument || response.request().resourceType() !== 'document'
            || response.request().frame() !== page.mainFrame())
        {
            return;
        }
        firstDocument = Promise.allSettled([
            Promise.resolve().then(() => response.body()),
            Promise.resolve().then(() => response.headersArray())
        ]).then(([bodyResult, headersResult]) =>
        {
            const body = bodyResult.status === 'fulfilled' && Buffer.isBuffer(bodyResult.value)
                ? bodyResult.value : null;
            const headersArray = headersResult.status === 'fulfilled' && Array.isArray(headersResult.value)
                ? headersResult.value : null;
            const withinBodyBound = body !== null && body.length <= 4 * 1024 * 1024;
            const withinHeaderBound = headersArray !== null && headersArray.length <= 128
                && headersArray.every((item) => typeof item?.name === 'string' && typeof item.value === 'string'
                    && Buffer.byteLength(item.name) <= 8192 && Buffer.byteLength(item.value) <= 8192)
                && headersArray.reduce((count, item) => count + Buffer.byteLength(item.name) + Buffer.byteLength(item.value), 0) <= 65536;
            const originals = {
                identity: structuredClone(identity),
                status: response.status(),
                representation: 'playwright-response-body',
                bodyEncoding: 'base64',
                bodyBase64: withinBodyBound ? body.toString('base64') : null,
                bodyBytes: body?.length ?? null,
                bodyDigest: body ? sha256(body) : null,
                headersArray: withinHeaderBound ? structuredClone(headersArray) : null,
                failures: [
                    ...(!withinBodyBound ? [body ? 'body-overflow' : 'body-unavailable'] : []),
                    ...(!withinHeaderBound ? [headersArray ? 'headers-invalid-or-overflow' : 'headers-unavailable'] : [])
                ]
            };
            const header = (name) => withinHeaderBound
                ? headersArray.filter((item) => item.name.toLowerCase() === name).map((item) => item.value).join(', ') || null
                : null;
            capturedDocument = { originals, firstResponse: {
                status: originals.status, contentType: header('content-type'), contentLanguage: header('content-language'),
                bodyDigest: originals.bodyDigest, bodyBytes: withinBodyBound ? originals.bodyBytes : null
            } };
            return capturedDocument;
        });
    };
    const onConsole = (message) =>
    {
        if (['warning', 'error'].includes(message.type()))
        {
            issues.push({ kind: `console-${message.type()}`, detailDigest: sha256(message.text()) });
        }
    };
    const onPageError = (error) => issues.push({ kind: 'page-error', detailDigest: sha256(String(error)) });
    const onRequestFailed = (request) => issues.push({ kind: 'request-failed', detailDigest: sha256(request.url()) });
    const listeners = [
        ['request', onRequest], ['response', onResponse], ['console', onConsole],
        ['pageerror', onPageError], ['requestfailed', onRequestFailed], ['close', dispose]
    ];
    function dispose()
    {
        if (disposed)
        {
            return;
        }
        for (const [event, listener] of listeners)
        {
            page.off(event, listener);
        }
        signal?.removeEventListener('abort', dispose);
        disposed = true;
    }
    for (const [event, listener] of listeners)
    {
        page.on(event, listener);
    }
    signal?.addEventListener('abort', dispose, { once: true });
    async function saveAvailableOriginal()
    {
        // Failure cleanup must not wait for a still-pending transport body or evaluate a closed page.
        if (!capturedDocument || !saveOriginalResponse)
        {
            return false;
        }
        originalPublication ??= Promise.resolve().then(() => saveOriginalResponse(capturedDocument.originals));
        await originalPublication;
        return true;
    }
    return {
        saveAvailableOriginal,
        async finish()
        {
            assert.equal(disposed, false, 'locale probe is already disposed');
            assert.equal(finished, false, 'locale probe cannot repeat its observation');
            finished = true;
            // #2082 requires a real document/selector probe, independently of later qualification.
            assert.ok(firstDocument, 'locale probe did not observe a real document response');
            const { firstResponse, originals } = await firstDocument;
            const captureError = originals.failures.length > 0
                ? new Error('locale probe original response capture is incomplete') : null;
            // Preserve available original bytes before an assertion or decoder rejects the response.
            if (saveOriginalResponse)
            {
                try
                {
                    await saveAvailableOriginal();
                }
                catch (error)
                {
                    if (captureError)
                    {
                        captureError.privateSinkError = error;
                        throw captureError;
                    }
                    throw error;
                }
            }
            if (captureError)
            {
                throw captureError;
            }
            assert.ok(firstResponse.bodyBytes > 0, 'locale probe could not read the document response');
            assert.equal(disposed, false, 'locale probe was disposed during response capture');
            const observed = await page.evaluate(() => ({
                language: document.documentElement.lang,
                title: document.title,
                selectorLocales: [...document.querySelectorAll('[data-locale-selector-item]')]
                    .map((item) => item.getAttribute('data-locale-code')),
                activeLocales: [...document.querySelectorAll('[data-locale-selector-runtime-adapter]')]
                    .map((item) => item.getAttribute('data-active-locale')),
                hydrated: document.querySelector('#fsus-aot-shell')?.getAttribute('data-public-hydrated'),
                fontsStatus: document.fonts.status,
                fonts: [...document.fonts].map((font) => ({ family: font.family, weight: font.weight, status: font.status })),
                resourceCount: performance.getEntriesByType('resource').length
            }));
            assert.ok(observed.activeLocales.length > 0, 'locale probe did not observe the real selector');
            const safeObservation = projectPublicShellLocaleProbeObservation({ firstResponse, observed }, matrix);
            const cookies = await page.context().cookies();
            return {
                schema: 'fsusblog.public-shell-locale-probe.v1',
                evidenceKind: 'diagnostic-probe',
                qualificationEligible: false,
                identity,
                ...safeObservation,
                preferenceCookiePresent: cookies.some((cookie) => cookie.name === 'fsusblog.locale'),
                requests,
                issues
            };
        },
        dispose
    };
}

/** Only catalog identities and digests cross the private-artifact serialization boundary. */
export function projectPublicShellLocaleProbeObservation({ firstResponse, observed }, matrix)
{
    const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
    const locales = new Set(matrix.locales.map((item) => item.code));
    const requireLocale = (value) =>
    {
        assert.ok(locales.has(value), 'probe contains a noncatalog locale identity');
        return value;
    };
    assert.equal(firstResponse.contentType?.split(';')[0].trim().toLowerCase(), 'text/html', 'probe response must be HTML');
    assert.ok(['loading', 'loaded'].includes(observed.fontsStatus), 'unknown font set status');
    assert.ok(['true', 'false', null].includes(observed.hydrated), 'unknown hydration observation');
    assert.ok(Number.isSafeInteger(observed.resourceCount) && observed.resourceCount >= 0, 'invalid resource count');
    return {
        firstResponse: {
            status: firstResponse.status,
            contentType: 'text/html',
            contentLanguage: requireLocale(firstResponse.contentLanguage),
            bodyDigest: firstResponse.bodyDigest,
            bodyBytes: firstResponse.bodyBytes
        },
        observed: {
            language: requireLocale(observed.language),
            titleDigest: sha256(observed.title),
            selectorLocales: observed.selectorLocales.map(requireLocale),
            activeLocales: observed.activeLocales.map(requireLocale),
            hydrated: observed.hydrated,
            fontsStatus: observed.fontsStatus,
            fonts: observed.fonts.map((font) =>
            {
                assert.ok(['unloaded', 'loading', 'loaded', 'error'].includes(font.status), 'unknown font face status');
                return { familyDigest: sha256(font.family), weightDigest: sha256(font.weight), status: font.status };
            }),
            resourceCount: observed.resourceCount
        }
    };
}
