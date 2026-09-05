/* global document */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

// eslint-disable-next-line import-x/no-relative-parent-imports -- Reuse the immutable production build admission authority.
import { verifyProductionBuildReceipt } from '../../tools/ci/production-build-artifacts.mjs';

import { loadBrowserContractFixture } from './fixture.mjs';
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
        expectedSourceState: sourceState
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
        /** The runner supplies its single browser context factory, preserving launch ownership. */
        async withScene(sceneId, createContext, observe)
        {
            assert.equal(active, false, 'locale scenes must run serially');
            assert.equal(visited.has(sceneId), false, 'locale scene retry is forbidden');
            const scene = matrix.scenes.find((item) => item.id === sceneId);
            assert.ok(scene, 'unknown locale scene');
            const negotiation = matrix.negotiationCases.find((item) => item.id === scene.negotiationId);
            assert.ok(negotiation, 'missing negotiation case');
            const storageState = scene.authActionContext === 'anonymous'
                ? { cookies: [], origins: [] }
                : structuredClone(scene.authActionContext === 'admin' ? fixture.admin.storageState : fixture.user.storageState);
            storageState.cookies = storageState.cookies.filter((item) => item.name !== 'fsusblog.locale');
            if (negotiation.cookie !== null)
            {
                storageState.cookies.push({
                    name: 'fsusblog.locale', value: negotiation.cookie, url: fixture.baseUrl,
                    httpOnly: true, secure: fixture.baseUrl.startsWith('https:'), sameSite: 'Lax'
                });
            }
            const options = {
                viewport: scene.viewport,
                storageState,
                serviceWorkers: 'block',
                extraHTTPHeaders: negotiation.header === null ? {} : { 'Accept-Language': negotiation.header }
            };
            active = true;
            visited.add(sceneId);
            let context;
            try
            {
                context = await createContext(options);
                return await observe({ context, fixture, scene, negotiation });
            }
            finally
            {
                try
                {
                    if (context)
                    {
                        await context.close();
                    }
                }
                finally
                {
                    active = false;
                }
            }
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
            await route.continue();
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
export function observePublicShellLocaleProbe(page, identity, { signal, matrix } = {})
{
    assert.equal(signal?.aborted === true, false, 'locale probe cannot start after abort');
    const sha256 = (value) => createHash('sha256').update(value).digest('hex');
    const requests = [];
    const issues = [];
    let firstDocument = null;
    let disposed = false;
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
        firstDocument = Promise.all([response.body(), response.allHeaders()]).then(([body, headers]) => ({
            status: response.status(),
            contentType: headers['content-type'] ?? null,
            contentLanguage: headers['content-language'] ?? null,
            bodyDigest: sha256(body),
            bodyBytes: body.length
        }), (error) => ({ errorDigest: sha256(String(error)) }));
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
    return {
        async finish()
        {
            assert.equal(disposed, false, 'locale probe is already disposed');
            // #2082 requires a real document/selector probe, independently of later qualification.
            assert.ok(firstDocument, 'locale probe did not observe a real document response');
            const firstResponse = await firstDocument;
            assert.ok(firstResponse.bodyBytes > 0, 'locale probe could not read the document response');
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
