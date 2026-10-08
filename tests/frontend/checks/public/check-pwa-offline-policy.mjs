#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const manifestPath = resolve(root, 'public/manifest.webmanifest');
const serviceWorkerPath = resolve(root, 'public/sw.js');
const releaseIdContractPath = resolve(root, 'public/generated/release-id-contract.js');
const indexPath = resolve(root, 'index.html');

function assert(condition, message)
{
    if (!condition)
    {
        throw new Error(message);
    }
}

function read(path)
{
    assert(existsSync(path), `missing file: ${path}`);
    return readFileSync(path, 'utf8');
}

const manifest = JSON.parse(read(manifestPath));
const sw = read(serviceWorkerPath);
const releaseIdContract = read(releaseIdContractPath);
const index = read(indexPath);

assert(manifest.name === 'Fsu’s Blog.', 'static manifest must use the checked-in default brand name');
assert(manifest.short_name === 'FsuBlog', 'static manifest short_name must use the checked-in default brand short name');
assert(manifest.description === 'A personal blog under Fsu’s Club.', 'static manifest description must use the checked-in default brand description');
assert(manifest.theme_color === '#0B4F7A', 'static manifest theme_color must use the default brand primary blue');
assert(manifest.background_color === '#FFFFFF', 'static manifest background_color must use the default brand background');
assert(manifest.start_url === '/', 'manifest start_url must stay public');
assert(manifest.scope === '/', 'manifest scope must stay site-root');
assert(manifest.display === 'standalone', 'manifest display must support installability');
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest must expose icons');
assert(manifest.icons.some((icon) => icon.src === '/favicon/pwa-192x192.png'), 'manifest must expose the default 192px PWA icon');
assert(manifest.icons.some((icon) => icon.src === '/favicon/pwa-512x512.png'), 'manifest must expose the default 512px PWA icon');
assert(manifest.icons.some((icon) => icon.src === '/favicon/maskable-icon-512x512.png' && icon.purpose === 'maskable'), 'manifest must expose the default maskable icon');
assert(index.includes('rel="manifest" href="/manifest.webmanifest"'), 'index.html must discover the manifest');

const shellPathBlock = sw.slice(
    sw.indexOf('const PUBLIC_SHELL_PATHS'),
    sw.indexOf('const STATIC_ASSET_PATTERN')
);
assert(shellPathBlock.includes('/^\\/article\\/\\d+\\/?$/'), 'public article shell route must be cacheable');
assert(!shellPathBlock.includes('/user'), 'service worker must not cache /user shells');
assert(!shellPathBlock.includes('/admin'), 'service worker must not cache admin shells');
assert(!shellPathBlock.includes('/login'), 'service worker must not cache login shells');
assert(sw.includes("headers.set('X-Fsus-Offline-Stale', '1')"), 'offline shell responses must be marked stale');
assert(sw.includes("headers.set('Cache-Control', 'no-store')"), 'offline stale shell responses must not be re-cached by HTTP caches');
assert(sw.includes('const PRIVATE_OR_SENSITIVE_PATHS'), 'service worker must define a private and sensitive path denylist');
assert(sw.includes('/^\\/api(?:\\/|$)/i'), 'all API routes must stay network-only');
assert(sw.includes('isPrivateOrSensitiveRequest(request, url)'), 'fetch handling must apply the sensitive request gate before cache routing');
assert(sw.includes("fetch(request, { cache: 'no-store' })"), 'sensitive requests must bypass the HTTP cache while retaining their original credentials');
assert(sw.includes('const EXPLICIT_PUBLIC_STATIC_PATHS'), 'static caching must use an explicit public path allowlist');
assert(sw.includes('isExplicitPublicStaticRequest(url)'), 'a matching file extension alone must not make a request cacheable');
assert(sw.includes("directives.has('no-store') || directives.has('private')"), 'private and no-store responses must not enter Cache Storage');
assert(sw.includes('await requireCurrentReleaseBrowserAdmission()'), 'install and activate require current candidate admission');
assert(!sw.includes('clearLegacyFsusCaches'), 'worker lifecycle must not delete unowned old caches');
assert(sw.includes("case 'shell.invalidate':"), 'service worker must support explicit shell invalidation');
assert(sw.includes('invalidateShellCache(message.scope ?? null)'), 'shell.invalidate must pass message scope into shell cache invalidation');
assert(sw.includes('const SHELL_INVALIDATION_SCOPE_PATHS'), 'service worker must define shell invalidation scope to route mapping');
assert(sw.includes("about: ['/about']"), 'about shell invalidation must only target /about');
assert(sw.includes("archive: ['/archive']"), 'archive shell invalidation must only target /archive');
assert(sw.includes("case 'seo':"), 'seo shell invalidation must remain global');
assert(sw.includes('shellInvalidateTelemetry'), 'shell invalidation must record telemetry');
assert(sw.includes('shellDeletedCount'), 'shell invalidation telemetry must record deleted count');
assert(sw.includes('shellCacheSizeBefore'), 'shell invalidation telemetry must record cache size before');
assert(sw.includes('shellCacheSizeAfter'), 'shell invalidation telemetry must record cache size after');
assert(sw.includes("case 'search-index.updated':"), 'service worker must support search index refresh messages');
assert(sw.includes("case 'asset.clear':"), 'service worker must support targeted cache clearing');
assert(sw.includes("? 'binary-network-unavailable'"), 'binary API offline failures must not be cached as shells');
assert(sw.includes("case 'privacy.clear':"), 'service worker must support shared-device browser state cleanup');
assert(sw.includes('clearPrivateBrowserStateCaches'), 'privacy cleanup must delete offline history and sensitive legacy entries');
assert(sw.includes("type: 'private-state-cleared'"), 'privacy cleanup must notify every controlled tab');
assert(sw.includes("fetch(request, { cache: 'no-store' })"), 'public shell network refresh must bypass HTTP cache');
assert(sw.includes('WASM_RUNTIME_ASSET_PATTERN'), 'service worker must detect Wasm runtime assets separately');
assert(sw.includes('networkFirstStatic(request)'), 'Wasm runtime assets must stay network-first');
assert(sw.includes('putCacheEntry(cache, request, response, { requireImmutable: true })'), 'static cache writes must require public immutable responses');
assert(sw.includes('let staticCachePromise = null'), 'static Cache Storage opens must use single-flight state');
assert(sw.includes('cache = await openStaticCache()'), 'cache-first static requests must share the single-flight cache handle');
assert(sw.includes("return networkErrorResponse('static-network-unavailable')"), 'static cache failures must retain an explicit network fallback response');
assert(sw.includes('SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS'), 'search index manifest checks must be TTL throttled');
assert(sw.includes('let searchIndexUpdatePromise = null'), 'search index refresh must use single-flight promise state');
assert(sw.includes('.finally(() =>') && sw.includes('searchIndexUpdatePromise = null'), 'search index single-flight promise must clear after settle');
assert(sw.includes('lastSearchManifestCheckAt'), 'search index refresh must remember the last manifest check time');
assert(sw.includes('force: true'), 'search-index.updated messages must bypass the manifest TTL');
assert(sw.includes('recordSearchIndexTelemetry'), 'search index refresh must record SW telemetry counters');
assert(sw.includes('manifestCheckCount'), 'search index telemetry must count manifest checks');
assert(sw.includes('singleFlightJoinCount'), 'search index telemetry must count single-flight joins');
assert(sw.includes('staleShardDeletedCount'), 'search index telemetry must count stale shard deletions');
assert(sw.includes('searchIndexUpdateElapsed'), 'search index telemetry must record update elapsed time');
assert(sw.includes('pruneStaleSearchShards'), 'search index updates must prune stale cached shards');
assert(sw.includes("headers.get('X-Fsus-Search-Version')"), 'stale shard pruning must use cached search version headers');
assert(sw.includes('SEARCH_ASSET_FETCH_CONCURRENCY'), 'search shard fetches must have an explicit concurrency limit');
assert(sw.includes('mapWithConcurrency('), 'search shard fetches must use the concurrency limiter');

class MemoryCache
{
    constructor(paths)
    {
        this.entries = new Map(paths.map((path) =>
        {
            const request = new Request(new URL(path, 'https://example.test').href);
            return [request.url, request];
        }));
        this.responses = new Map();
        this.puts = [];
    }

    async keys()
    {
        return Array.from(this.entries.values());
    }

    async delete(request)
    {
        const url = typeof request === 'string' ? new URL(request, 'https://example.test').href : request.url;
        const existed = this.entries.has(url);
        this.entries.delete(url);
        this.responses.delete(url);
        return existed;
    }

    async match(request)
    {
        const url = typeof request === 'string' ? new URL(request, 'https://example.test').href : request.url;
        return this.responses.get(url);
    }

    async put(request, response)
    {
        const normalizedRequest = typeof request === 'string'
            ? new Request(new URL(request, 'https://example.test').href)
            : request;
        this.entries.set(normalizedRequest.url, normalizedRequest);
        this.responses.set(normalizedRequest.url, response);
        this.puts.push(normalizedRequest.url);
    }

    has(path)
    {
        return this.entries.has(new URL(path, 'https://example.test').href);
    }
}

function createServiceWorkerContext(initialPaths = [])
{
    const handlers = new Map();
    const context = {
        TextDecoder,
        URL,
        Request,
        Response,
        Headers,
        Date,
        Promise,
        Array,
        ArrayBuffer,
        Uint8Array,
        Set,
        Map,
        console,
        importScripts: () =>
        {},
        fetch: async () => new Response('ok', {
            headers: { 'Cache-Control': 'private,no-store' }
        }),
        self: {
            location: { origin: 'https://example.test', href: 'https://example.test/sw.js?build=test-build' },
            addEventListener(type, handler)
            {
                handlers.set(type, handler);
            },
            skipWaiting: async () =>
            {},
            clients: { claim: async () =>
            {}, matchAll: async () => [] },
            crypto: { subtle: { digest: async () => new ArrayBuffer(32) } }
        }
    };
    context.__cache = new MemoryCache(initialPaths);
    context.__handlers = handlers;
    context.caches = {
        open: async () => context.__cache,
        keys: async () => [],
        delete: async () => true
    };
    const sandbox = vm.createContext(context);
    vm.runInContext(releaseIdContract, sandbox, { filename: 'generated/release-id-contract.js' });
    vm.runInContext(sw, sandbox, { filename: 'sw.js' });
    return { context, sandbox };
}

async function runShellInvalidationBehaviorCheck(scope, initialPaths)
{
    const { context, sandbox } = createServiceWorkerContext(initialPaths);
    const result = await vm.runInContext(`invalidateShellCache(${JSON.stringify(scope)})`, sandbox);
    return { result, cache: context.__cache };
}

{
    const { context, sandbox } = createServiceWorkerContext(['/', '/about', '/archive']);
    const result = await vm.runInContext("handleControlMessage({ type: 'shell.invalidate', scope: 'about' })", sandbox);
    assert(result.deletedCount === 1, 'shell control must return its in-scope deletion result after broadcasting');
    assert(!context.__cache.has('/about'), 'shell control must invalidate the selected public scope');
    assert(context.__cache.has('/') && context.__cache.has('/archive'), 'shell control must preserve other public scopes');
}

async function runSensitiveFetchBehaviorCheck(path)
{
    const { context } = createServiceWorkerContext();
    let responsePromise = null;
    let fetchOptions = null;
    context.fetch = async (_request, options) =>
    {
        fetchOptions = options;
        return new Response('sensitive', {
            headers: { 'Cache-Control': 'private,no-store' }
        });
    };
    context.__handlers.get('fetch')({
        request: new Request(new URL(path, 'https://example.test').href),
        respondWith(promise)
        {
            responsePromise = promise;
        }
    });
    assert(responsePromise, `${path} must be intercepted as network-only`);
    await responsePromise;
    assert(fetchOptions?.cache === 'no-store', `${path} must bypass the HTTP cache`);
    assert(context.__cache.puts.length === 0, `${path} must never enter Cache Storage`);
}

async function runStaticFetchBehaviorCheck({ open, fetch })
{
    const { context, sandbox } = createServiceWorkerContext();
    context.caches.open = open;
    context.fetch = fetch;
    return await vm.runInContext(
        "cacheFirstStatic(new Request('https://example.test/assets/app.abcdef.js'))",
        sandbox
    );
}

for (const sensitivePath of [
    '/api/binary/auth/me.aeds',
    '/api/notifications/stream/preflight',
    '/user/manage/profile',
    '/admin/dashboard',
    '/login',
    '/private/avatar.png'
])
{
    await runSensitiveFetchBehaviorCheck(sensitivePath);
}

{
    const { sandbox } = createServiceWorkerContext();
    const privateResponseCacheable = vm.runInContext("responseCanEnterCache(new Response('private', { headers: { 'Cache-Control': 'private,max-age=60' } }))", sandbox);
    const noStoreResponseCacheable = vm.runInContext("responseCanEnterCache(new Response('secret', { headers: { 'Cache-Control': 'public,no-store' } }))", sandbox);
    const mutableResponseCacheable = vm.runInContext("responseCanEnterCache(new Response('asset', { headers: { 'Cache-Control': 'public,max-age=60' } }), { requireImmutable: true })", sandbox);
    const immutableResponseCacheable = vm.runInContext("responseCanEnterCache(new Response('asset', { headers: { 'Cache-Control': 'public,max-age=31536000,immutable' } }), { requireImmutable: true })", sandbox);
    const explicitAsset = vm.runInContext("isExplicitPublicStaticRequest(new URL('https://example.test/assets/app.abcdef.js'))", sandbox);
    const disguisedPrivateAsset = vm.runInContext("isExplicitPublicStaticRequest(new URL('https://example.test/private/account.png'))", sandbox);

    assert(!privateResponseCacheable, 'private responses must not enter Cache Storage');
    assert(!noStoreResponseCacheable, 'no-store responses must not enter Cache Storage');
    assert(!mutableResponseCacheable, 'mutable responses must not enter the immutable asset cache');
    assert(immutableResponseCacheable, 'explicit public immutable assets must remain cacheable');
    assert(explicitAsset, 'hashed public assets must remain cacheable');
    assert(!disguisedPrivateAsset, 'a private route with a static extension must not become cacheable');
}

{
    let openCount = 0;
    let releaseOpen;
    const cacheOpen = new Promise((resolve) =>
    {
        releaseOpen = resolve;
    });
    const { context, sandbox } = createServiceWorkerContext();
    context.caches.open = async () =>
    {
        openCount += 1;
        return await cacheOpen;
    };
    context.fetch = async () => new Response('module', {
        headers: {
            'Cache-Control': 'public,max-age=31536000,immutable',
            'Content-Type': 'application/javascript'
        }
    });

    const requests = Array.from({ length: 16 }, (_, index) => vm.runInContext(
        `cacheFirstStatic(new Request('https://example.test/assets/chunk-${index}.abcdef.js'))`,
        sandbox
    ));
    await Promise.resolve();
    assert(openCount === 1, 'concurrent static module requests must open Cache Storage once');
    releaseOpen(context.__cache);
    const responses = await Promise.all(requests);
    assert(responses.every((response) => response.ok), 'concurrent static module requests must all retain valid responses');
}

{
    let fetchCount = 0;
    const response = await runStaticFetchBehaviorCheck({
        open: async () =>
        {
            throw new Error('cache storage unavailable');
        },
        fetch: async () =>
        {
            fetchCount += 1;
            return new Response('network module', {
                headers: { 'Content-Type': 'application/javascript' }
            });
        }
    });
    assert(response.ok, 'static requests must stay network-available when Cache Storage open fails');
    assert(await response.text() === 'network module', 'cache-open failure must preserve the real network module response');
    assert(fetchCount === 1, 'cache-open failure must perform exactly one network request');
}

{
    let fetchCount = 0;
    const response = await runStaticFetchBehaviorCheck({
        open: async () => ({
            match: async () =>
            {
                throw new Error('cache match unavailable');
            }
        }),
        fetch: async () =>
        {
            fetchCount += 1;
            return new Response('network module', {
                headers: { 'Content-Type': 'application/javascript' }
            });
        }
    });
    assert(response.ok, 'static requests must stay network-available when Cache Storage match fails');
    assert(await response.text() === 'network module', 'cache-match failure must preserve the real network module response');
    assert(fetchCount === 1, 'cache-match failure must perform exactly one network request');
}

{
    const { result, cache } = await runShellInvalidationBehaviorCheck('about', ['/', '/about', '/archive']);
    assert(result.deletedCount === 1, 'about scope must delete exactly one shell entry');
    assert(!cache.has('/about'), 'about scope must delete /about shell');
    assert(cache.has('/'), 'about scope must preserve home shell');
    assert(cache.has('/archive'), 'about scope must preserve archive shell');
}

{
    const { result, cache } = await runShellInvalidationBehaviorCheck('seo', ['/', '/about', '/archive']);
    assert(result.deletedCount === 3, 'seo scope must retain global shell invalidation semantics');
    assert(!cache.has('/') && !cache.has('/about') && !cache.has('/archive'), 'seo scope must clear all shell entries');
}

{
    const { result, cache } = await runShellInvalidationBehaviorCheck('unknown-scope', ['/', '/about', '/archive']);
    assert(result.deletedCount === 3, 'unknown shell invalidation scope must fall back to global deletion');
    assert(!cache.has('/') && !cache.has('/about') && !cache.has('/archive'), 'unknown shell invalidation scope must clear all shell entries');
}




// Executable refusal controls, not successful browser activation evidence.
for (const lifecycle of ['install', 'activate'])
{
    const { context } = createServiceWorkerContext(['/assets/old.js']);
    const operations = [];
    context.self.skipWaiting = async () => operations.push('skipWaiting');
    context.self.clients.claim = async () => operations.push('claim');
    context.caches.open = async () => operations.push('cache-open');
    context.caches.delete = async () => operations.push('cache-delete');
    context.self.currentReleaseAdmission = {
        status: 'active', actualDatabaseObserved: true, nativeClaimEligible: true,
        candidateId: `sha256:${'a'.repeat(64)}`
    };
    for (let attempt = 0; attempt < 2; attempt += 1)
    {
        let pending;
        context.__handlers.get(lifecycle)({
            data: { status: 'verified-current', signed: true },
            waitUntil(promise)
            {
                pending = promise;
            }
        });
        assert(pending && typeof pending.then === 'function', `${lifecycle} must register its asynchronous admission gate`);
        let refused = false;
        try
        {
            await pending;
        }
        catch (error)
        {
            refused = error?.message === 'current_release_browser_admission_unconfigured';
        }
        assert(refused, `${lifecycle} must reject fixture/status grants without the actual public/native bridge`);
    }
    assert(operations.length === 0, `${lifecycle} refusal must leave active workers and every unowned cache untouched`);
    assert(context.__cache.has('/assets/old.js'), `${lifecycle} refusal must preserve preexisting cache bytes`);
}
console.log('current release worker admission refusal controls passed (source-only, native/browser activation unqualified)');
