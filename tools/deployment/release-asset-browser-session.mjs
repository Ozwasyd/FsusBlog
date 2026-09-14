import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ASSET_BROWSER_EVIDENCE_SCHEMA = 'fsusblog.release-asset-browser-evidence.v1';

export async function startReleaseAssetBrowserSession(input)
{
    const playwright = await import(pathToFileURL(input.playwrightModule).href);
    const browserType = playwright.chromium;
    const bundledExecutable = browserType.executablePath();
    const executablePath = input.executablePath
    ?? (fs.existsSync(bundledExecutable) ? bundledExecutable : [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ].find(candidate => fs.existsSync(candidate)));
    if (!executablePath)
    {
        throw new Error('no Chromium executable is available for asset browser evidence');
    }
    const launchOptions = {
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage']
    };
    const browser = await browserType.launch(launchOptions);
    const context = await browser.newContext({
        serviceWorkers: 'allow',
        ignoreHTTPSErrors: true,
        bypassCSP: false
    });
    context.setDefaultTimeout(input.timeoutMs);
    context.setDefaultNavigationTimeout(input.timeoutMs);
    const state = createState(input, browser, executablePath);
    let holdReleased = false;
    let blockOldAssetNetwork = false;
    let releaseHold;
    const holdGate = new Promise(resolve =>
    {
        releaseHold = resolve;
    });
    await context.route('**/*', async route =>
    {
        const url = new URL(route.request().url());
        const comparable = `${url.pathname}${url.search}`;
        const held = input.assets.find(asset => heldAssetUrl(asset.releaseUrl, input.holdToken) === comparable);
        if (held)
        {
            const arrival = {
                path: assetPath(held.releaseUrl),
                kind: held.kind,
                requestedAtUtc: new Date().toISOString(),
                releasedAtUtc: null
            };
            state.delayed.arrivals.push(arrival);
            await holdGate;
            arrival.releasedAtUtc = new Date().toISOString();
            await route.continue();
            return;
        }
        if (blockOldAssetNetwork && url.pathname.startsWith(`/release-assets/${input.scenario.oldReleaseId}/`))
        {
            state.network.blockedOldAssetRequests.push(url.pathname);
            await route.abort('blockedbyclient');
            return;
        }
        await route.continue();
    });

    const oldPage = await context.newPage();
    attachPageEvidence(oldPage, 'old-page', state);
    try
    {
        await oldPage.goto(resolveUrl(input.scenario.oldFrontendBaseUrl, input.scenario.oldIndexPath), {
            waitUntil: 'domcontentloaded',
            timeout: input.timeoutMs
        });
        const manifest = await browserFetchHash(oldPage, resolveUrl(input.scenario.oldFrontendBaseUrl, input.scenario.oldManifestPath));
        if (manifest.status !== 200 || manifest.sha256 !== input.manifestSha256)
        {
            state.errors.push(`browser old manifest mismatch: status=${manifest.status} expected=${input.manifestSha256} observed=${manifest.sha256}`);
        }
        state.beforeSwitch.manifest = manifest;
        state.beforeSwitch.page = await pageIdentity(oldPage);
        await oldPage.evaluate(async scriptPath =>
        {
            const registration = await navigator.serviceWorker.register(scriptPath, { scope: '/', updateViaCache: 'none' });
            await registration.update();
            await navigator.serviceWorker.ready;
        }, input.scenario.serviceWorker.scriptPath);
        if (!await oldPage.evaluate(() => Boolean(navigator.serviceWorker.controller)))
        {
            await oldPage.reload({ waitUntil: 'domcontentloaded', timeout: input.timeoutMs });
            await waitFor('old Service Worker controller', async () => await oldPage.evaluate(() => Boolean(navigator.serviceWorker.controller)), input.timeoutMs);
        }
        await oldPage.evaluate(async paths =>
        {
            for (const requestPath of paths)
            {
                const response = await fetch(requestPath, { cache: 'reload' });
                if (!response.ok)
                {
                    throw new Error(`${requestPath} cache warmup returned ${response.status}`);
                }
                await response.arrayBuffer();
            }
        }, input.cachePaths);
        state.beforeSwitch.serviceWorker = await serviceWorkerState(oldPage);
        validateCacheNamespace(state.beforeSwitch.serviceWorker, input.expectedCacheNamespace, state.errors, 'before-switch');

        await oldPage.evaluate(({ assets, holdToken }) =>
        {
            globalThis.__FSUS_RELEASE_ASSET_HOLD__ = Promise.all(assets.map(async asset =>
            {
                const url = new URL(asset.releaseUrl, location.origin);
                url.searchParams.set('__fsus_release_hold', holdToken);
                const response = await fetch(url, { cache: 'no-store' });
                const bytes = await response.arrayBuffer();
                const digest = await crypto.subtle.digest('SHA-256', bytes);
                return {
                    path: asset.releaseUrl,
                    kind: asset.kind,
                    status: response.status,
                    bytes: bytes.byteLength,
                    sha256: `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
                };
            }));
        }, { assets: input.assets, holdToken: input.holdToken });
        await waitFor(
            'all delayed JS/CSS/Wasm/font requests to enter the browser route gate',
            () => input.assets.every(asset => state.delayed.arrivals.some(item => item.path === assetPath(asset.releaseUrl))),
            input.timeoutMs);
        state.beforeSwitch.status = state.errors.length === 0 ? 'pass' : 'fail';
    }
    catch (error)
    {
        state.errors.push(`browser before-switch failed: ${message(error)}`);
        state.beforeSwitch.status = 'fail';
    }

    return {
        checkpoint: snapshot(state),
        async afterSwitch()
        {
            if (!holdReleased)
            {
                holdReleased = true;
                releaseHold();
            }
            try
            {
                const delayed = await oldPage.evaluate(async () => await globalThis.__FSUS_RELEASE_ASSET_HOLD__);
                state.delayed.resources = delayed.map(item => ({
                    ...item,
                    expectedSha256: input.assets.find(asset => assetPath(asset.releaseUrl) === assetPath(item.path))?.expectedSha256 ?? null,
                    hashMatches: input.assets.find(asset => assetPath(asset.releaseUrl) === assetPath(item.path))?.expectedSha256 === item.sha256
                }));
                for (const item of state.delayed.resources)
                {
                    if (item.status !== 200 || item.hashMatches !== true)
                    {
                        state.errors.push(`browser delayed ${item.kind} ${item.path} failed status/hash validation`);
                    }
                }
                state.afterSwitch.oldPage = await pageIdentity(oldPage);
                state.afterSwitch.serviceWorker = await serviceWorkerState(oldPage);
                state.compatibility.oldFrontendToNewBackend = await browserCompatibilityRequests(
                    oldPage,
                    input.scenario.compatibilityRequests.oldFrontendToNewBackend,
                    input.scenario.newBackendBaseUrl,
                    input.scenario.oldReleaseId,
                    input.scenario.newReleaseId,
                    input.timeoutMs);
                state.errors.push(...state.compatibility.oldFrontendToNewBackend.errors);

                const newPage = await context.newPage();
                attachPageEvidence(newPage, 'new-page', state);
                await newPage.goto(resolveUrl(input.newFrontendBaseUrl, input.newIndexPath), {
                    waitUntil: 'domcontentloaded',
                    timeout: input.timeoutMs
                });
                state.afterSwitch.newPage = await pageIdentity(newPage);
                state.compatibility.newFrontendToOldBackend = await browserCompatibilityRequests(
                    newPage,
                    input.scenario.compatibilityRequests.newFrontendToOldBackend,
                    input.scenario.oldBackendBaseUrl,
                    input.scenario.newReleaseId,
                    input.scenario.oldReleaseId,
                    input.timeoutMs);
                state.errors.push(...state.compatibility.newFrontendToOldBackend.errors);
                state.afterSwitch.status = state.errors.length === 0 ? 'pass' : 'fail';
            }
            catch (error)
            {
                state.errors.push(`browser after-switch failed: ${message(error)}`);
                state.afterSwitch.status = 'fail';
            }
            return snapshot(state);
        },
        async afterGc()
        {
            try
            {
                blockOldAssetNetwork = true;
                state.afterGc.serviceWorker = await serviceWorkerState(oldPage);
                validateCacheNamespace(state.afterGc.serviceWorker, input.expectedCacheNamespace, state.errors, 'after-gc');
                state.afterGc.cacheReads = await oldPage.evaluate(async paths => await Promise.all(paths.map(async requestPath =>
                {
                    const names = await caches.keys();
                    let cached = null;
                    for (const name of names)
                    {
                        cached = await (await caches.open(name)).match(requestPath);
                        if (cached)
                        {
                            break;
                        }
                    }
                    if (!cached)
                    {
                        return { path: requestPath, cacheHit: false, sha256: null, bytes: 0 };
                    }
                    const bytes = await cached.arrayBuffer();
                    const digest = await crypto.subtle.digest('SHA-256', bytes);
                    return {
                        path: requestPath,
                        cacheHit: true,
                        bytes: bytes.byteLength,
                        sha256: `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
                    };
                })), input.cachePaths);
                state.afterGc.controlledFetches = await oldPage.evaluate(async paths => await Promise.all(paths.map(async requestPath =>
                {
                    try
                    {
                        const response = await fetch(requestPath, { cache: 'force-cache' });
                        const bytes = await response.arrayBuffer();
                        const digest = await crypto.subtle.digest('SHA-256', bytes);
                        return {
                            path: requestPath,
                            status: response.status,
                            bytes: bytes.byteLength,
                            sha256: `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`,
                            error: null
                        };
                    }
                    catch (error)
                    {
                        return { path: requestPath, status: null, bytes: 0, sha256: null, error: String(error?.message ?? error) };
                    }
                })), input.cachePaths);
                const expected = new Map(input.assets.map(asset => [assetPath(asset.releaseUrl), asset.expectedSha256]));
                for (const item of [...state.afterGc.cacheReads, ...state.afterGc.controlledFetches])
                {
                    if (item.sha256 !== expected.get(assetPath(item.path)))
                    {
                        state.errors.push(`browser after-GC cache/page hash mismatch: ${item.path}`);
                    }
                }
                state.afterGc.oldPage = await pageIdentity(oldPage);
                if (!state.afterGc.oldPage.serviceWorkerControlled)
                {
                    state.errors.push('old page lost its Service Worker controller after GC');
                }
                state.afterGc.status = state.errors.length === 0 ? 'pass' : 'fail';
            }
            catch (error)
            {
                state.errors.push(`browser after-GC failed: ${message(error)}`);
                state.afterGc.status = 'fail';
            }
            return snapshot(state);
        },
        evidence()
        {
            return finalizeState(state);
        },
        async close()
        {
            if (!holdReleased)
            {
                releaseHold();
            }
            await context.close().catch(() =>
            {});
            await browser.close().catch(() =>
            {});
        }
    };
}

function createState(input, browser, executablePath)
{
    const binarySha256 = fs.existsSync(executablePath)
        ? sha256(fs.readFileSync(executablePath))
        : null;
    return {
        schema: ASSET_BROWSER_EVIDENCE_SCHEMA,
        status: 'running',
        browser: {
            name: 'chromium',
            version: browser.version(),
            executablePath,
            executableSha256: binarySha256
        },
        bindings: {
            drillId: input.scenario.drillId,
            rolloutId: input.rolloutId,
            sourceReleaseId: input.scenario.oldReleaseId,
            targetReleaseId: input.scenario.newReleaseId,
            scenarioSha256: input.scenarioSha256,
            manifestSha256: input.manifestSha256,
            gcEvidenceSha256: null
        },
        beforeSwitch: { status: 'running', manifest: null, page: null, serviceWorker: null },
        delayed: { arrivals: [], resources: [] },
        afterSwitch: { status: 'pending', oldPage: null, newPage: null, serviceWorker: null },
        compatibility: { oldFrontendToNewBackend: null, newFrontendToOldBackend: null },
        afterGc: { status: 'pending', serviceWorker: null, cacheReads: [], controlledFetches: [], oldPage: null },
        console: [],
        pageErrors: [],
        network: { responses: [], failures: [], blockedOldAssetRequests: [] },
        errors: []
    };
}

function attachPageEvidence(page, label, state)
{
    page.on('console', event =>
    {
        const text = redactDiagnostic(event.text());
        state.console.push({ page: label, type: event.type(), text, observedAtUtc: new Date().toISOString() });
        if (event.type() === 'error')
        {
            state.errors.push(`${label} console error: ${text}`);
        }
    });
    page.on('pageerror', error =>
    {
        const detail = redactDiagnostic(message(error));
        state.pageErrors.push({ page: label, message: detail, observedAtUtc: new Date().toISOString() });
        state.errors.push(`${label} page error: ${detail}`);
    });
    page.on('response', response =>
    {
        const url = new URL(response.url());
        state.network.responses.push({ page: label, path: `${url.pathname}${url.search}`, status: response.status(), fromServiceWorker: response.fromServiceWorker(), observedAtUtc: new Date().toISOString() });
    });
    page.on('requestfailed', request =>
    {
        const url = new URL(request.url());
        const failure = request.failure()?.errorText ?? 'unknown';
        state.network.failures.push({ page: label, path: `${url.pathname}${url.search}`, error: failure, observedAtUtc: new Date().toISOString() });
        if (!state.network.blockedOldAssetRequests.includes(url.pathname))
        {
            state.errors.push(`${label} network failure ${url.pathname}: ${failure}`);
        }
    });
}

async function browserCompatibilityRequests(page, requests, baseUrl, clientReleaseId, expectedServerReleaseId, timeoutMs)
{
    const results = await page.evaluate(async input => await Promise.all(input.requests.map(async request =>
    {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? input.timeoutMs);
        try
        {
            const headers = { ...request.headers, 'x-fsus-client-release': input.clientReleaseId };
            const response = await fetch(new URL(request.path, input.baseUrl), {
                method: request.method,
                headers,
                body: request.body,
                redirect: 'manual',
                signal: controller.signal
            });
            const bytes = await response.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return {
                id: request.id,
                status: response.status,
                serverReleaseId: response.headers.get('x-fsus-release-id'),
                sha256: `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`,
                headers: Object.fromEntries([...response.headers.entries()].filter(([name]) => ['content-type', 'etag', 'x-fsus-release-id', 'x-fsus-release-slot'].includes(name))),
                error: null
            };
        }
        catch (error)
        {
            return { id: request.id, status: null, serverReleaseId: null, sha256: null, headers: {}, error: String(error?.message ?? error) };
        }
        finally
        {
            clearTimeout(timer);
        }
    })), { requests, baseUrl, clientReleaseId, timeoutMs });
    const errors = [];
    for (const result of results)
    {
        const request = requests.find(item => item.id === result.id);
        if (result.error)
        {
            errors.push(`${result.id} browser request failed: ${result.error}`);
        }
        if (!request.expectedStatuses.includes(result.status))
        {
            errors.push(`${result.id} unexpected browser HTTP ${result.status}`);
        }
        if (result.serverReleaseId !== expectedServerReleaseId)
        {
            errors.push(`${result.id} expected browser server release ${expectedServerReleaseId}, observed ${result.serverReleaseId ?? 'missing'}`);
        }
        if (request.expectedSha256 && result.sha256 !== request.expectedSha256)
        {
            errors.push(`${result.id} browser response hash mismatch`);
        }
        for (const [name, value] of Object.entries(request.expectedHeaders))
        {
            if (result.headers[name] !== value)
            {
                errors.push(`${result.id} browser response header ${name} mismatch`);
            }
        }
    }
    return { status: errors.length === 0 ? 'pass' : 'fail', clientReleaseId, expectedServerReleaseId, requests: results, errors };
}

async function browserFetchHash(page, url)
{
    return await page.evaluate(async requestUrl =>
    {
        const response = await fetch(requestUrl, { cache: 'no-store' });
        const bytes = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return { status: response.status, bytes: bytes.byteLength, sha256: `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}` };
    }, url);
}

async function serviceWorkerState(page)
{
    return await page.evaluate(async () =>
    {
        const registration = await navigator.serviceWorker.ready;
        const names = await caches.keys();
        return {
            supported: 'serviceWorker' in navigator,
            controller: navigator.serviceWorker.controller
                ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state }
                : null,
            registration: { scope: registration.scope, activeScriptURL: registration.active?.scriptURL ?? null, activeState: registration.active?.state ?? null },
            cacheNamespaces: names,
            caches: await Promise.all(names.map(async name => ({
                name,
                entries: (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)
            })))
        };
    });
}

async function pageIdentity(page)
{
    return {
        url: page.url(),
        title: await page.title(),
        bodyTextSha256: sha256(await page.locator('body').innerText().catch(() => '')),
        serviceWorkerControlled: await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
    };
}

function validateCacheNamespace(value, expected, errors, phase)
{
    if (!value?.controller)
    {
        errors.push(`${phase} old page has no Service Worker controller`);
    }
    if (!value?.cacheNamespaces?.includes(expected))
    {
        errors.push(`${phase} cache namespace ${expected} is missing`);
    }
}

function finalizeState(state)
{
    const browserBound = Boolean(state.browser.version && state.browser.executablePath && state.browser.executableSha256);
    if (!browserBound)
    {
        state.errors.push('browser binary/version binding is incomplete');
    }
    const compatibilityPass = state.compatibility.oldFrontendToNewBackend?.status === 'pass'
    && state.compatibility.newFrontendToOldBackend?.status === 'pass';
    const status = state.beforeSwitch.status === 'pass'
    && state.afterSwitch.status === 'pass'
    && state.afterGc.status === 'pass'
    && compatibilityPass
    && state.errors.length === 0
        ? 'pass'
        : 'fail';
    return { ...snapshot(state), status, completedAtUtc: new Date().toISOString() };
}

function snapshot(state)
{
    return structuredClone(state);
}

function resolveUrl(baseUrl, requestPath)
{
    return new URL(requestPath, baseUrl).href;
}

function assetPath(value)
{
    const url = new URL(value, 'https://asset.invalid');
    return url.pathname;
}

function heldAssetUrl(value, holdToken)
{
    const url = new URL(value, 'https://asset.invalid');
    url.searchParams.set('__fsus_release_hold', holdToken);
    return `${url.pathname}${url.search}`;
}

async function waitFor(label, predicate, timeoutMs)
{
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline)
    {
        try
        {
            if (await predicate())
            {
                return;
            }
        }
        catch (error)
        {
            lastError = message(error);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`);
}

function sha256(value)
{
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function message(error)
{
    return error instanceof Error ? error.message : String(error);
}

function redactDiagnostic(value)
{
    return String(value)
        .replace(/Bearer\s+[^\s"']+/giu, 'Bearer [redacted]')
        .replace(/([?&](?:token|ticket|code|secret)=)[^&\s]+/giu, '$1[redacted]')
        .replace(/((?:cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/giu, '$1[redacted]');
}
