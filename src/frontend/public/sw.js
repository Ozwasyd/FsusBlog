importScripts('/generated/release-id-contract.js');

const BUILD_ID_CANDIDATE = new URL(self.location.href).searchParams.get('build') ?? '';
const FRONTEND_BUILD_ID = self.FsusReleaseIdContract.isCanonicalReleaseId(BUILD_ID_CANDIDATE)
    ? BUILD_ID_CANDIDATE
    : '';
const CACHE_NAMESPACE = FRONTEND_BUILD_ID ? `:${FRONTEND_BUILD_ID}` : '';
const STATIC_CACHE = `fsus-static-v5${CACHE_NAMESPACE}`;
const SHELL_CACHE = `fsus-shell-v6${CACHE_NAMESPACE}`;
const SEARCH_CACHE = `fsus-search-v5${CACHE_NAMESPACE}`;
const SEARCH_PUBLIC_BASE = FRONTEND_BUILD_ID
    ? `/release-derived/${FRONTEND_BUILD_ID}/search`
    : '/search';
const SEARCH_ALIAS_PATH = `${SEARCH_PUBLIC_BASE}/index.bin`;
const SEARCH_MANIFEST_PATH = `${SEARCH_PUBLIC_BASE}/index.manifest.aeds`;
const SEARCH_MANIFEST_MAGIC = 0x4d495346;
const SEARCH_MANIFEST_BINARY_VERSION = 1;
const SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS = 30000;
const SEARCH_ASSET_FETCH_CONCURRENCY = 3;
const AEDS_BINARY_MEDIA_TYPE = 'application/octet-stream';
const DOTNET_EPOCH_OFFSET_MS = 62135596800000;
const TEXT_DECODER = new TextDecoder();
let searchIndexUpdatePromise = null;
let staticCachePromise = null;
let lastSearchManifestCheckAt = 0;
let currentSearchVersion = null;
const searchIndexTelemetry = {
    manifestCheckCount: 0,
    singleFlightJoinCount: 0,
    staleShardDeletedCount: 0,
    searchIndexUpdateElapsed: 0
};
const shellInvalidateTelemetry = {
    shellInvalidateScope: null,
    shellDeletedCount: 0,
    shellCacheSizeBefore: 0,
    shellCacheSizeAfter: 0
};
const SHELL_INVALIDATION_SCOPE_PATHS = Object.freeze({
    about: ['/about'],
    archive: ['/archive'],
    search: ['/search'],
    privacy: ['/privacy'],
    guidelines: ['/guidelines'],
    copyright: ['/copyright']
});
const PUBLIC_SHELL_PATHS = [
    /^\/$/,
    /^\/about\/?$/,
    /^\/archive\/?$/,
    /^\/search\/?$/,
    /^\/article\/\d+\/?$/,
    /^\/category\/\d+\/?$/,
    /^\/tag\/\d+\/?$/
];
const STATIC_ASSET_PATTERN = /\.(?:css|js|mjs|wasm|woff2?|ttf|otf|eot|ico|svg|png|jpe?g|webp|avif)$/i;
const WASM_RUNTIME_ASSET_PATTERN = /^\/wasm\/[^/]+\.(?:js|wasm|json)$/i;
const IMMUTABLE_RELEASE_WASM_ASSET_PATTERN = /^\/release-assets\/([^/]+)\/wasm\/[^/]+\.(?:js|wasm|json)$/i;
const IMMUTABLE_RELEASE_ASSET_PATTERN = /^\/release-assets\/([^/]+)\/[0-9A-Za-z][0-9A-Za-z._/-]*$/i;
const PRIVATE_OR_SENSITIVE_PATHS = [
    /^\/api(?:\/|$)/i,
    /^\/(?:user|admin|login|account|manage|author|private)(?:\/|$)/i,
    /^\/notifications?(?:\/|$)/i
];
const EXPLICIT_PUBLIC_STATIC_PATHS = [
    /^\/assets\/[0-9A-Za-z][0-9A-Za-z._/-]*$/i,
    /^\/favicon\/[0-9A-Za-z][0-9A-Za-z._/-]*$/i,
    /^\/wasm\/[0-9A-Za-z][0-9A-Za-z._/-]*$/i,
    /^\/favicon\.ico$/i
];
const PRIVATE_BROWSER_CACHE_NAME_PATTERN = /^fsus-(?:shell|search|search-meta)-/i;
const SENSITIVE_REQUEST_HEADERS = [
    'Authorization',
    'X-Fsus-Access-Token',
    'X-Fsus-Bearer-Token',
    'X-Fsus-Session-Id',
    'X-Fsus-Mfa-Proof'
];

self.addEventListener('install', (event) =>
{
    event.waitUntil((async () =>
    {
        await requireCurrentReleaseBrowserAdmission();
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) =>
{
    event.waitUntil((async () =>
    {
        await requireCurrentReleaseBrowserAdmission();
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) =>
{
    const message = event.data;
    if (!message || typeof message.type !== 'string')
    {
        return;
    }

    event.waitUntil(handleControlMessage(message).then((result) =>
    {
        event.ports?.[0]?.postMessage({
            type: 'control-complete',
            controlType: message.type,
            result
        });
    }));
});

self.addEventListener('fetch', (event) =>
{
    const request = event.request;
    if (request.method !== 'GET')
    {
        return;
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin)
    {
        return;
    }

    if (isPrivateOrSensitiveRequest(request, url))
    {
        const failureKind = url.pathname.startsWith('/api/binary/')
            ? 'binary-network-unavailable'
            : 'private-network-unavailable';
        event.respondWith(networkOnlyRequest(request, failureKind));
        return;
    }

    if (url.pathname === SEARCH_ALIAS_PATH)
    {
        event.respondWith(handleSearchAliasRequest(request));
        return;
    }

    if (url.pathname.startsWith(`${SEARCH_PUBLIC_BASE}/index.`) || url.pathname.startsWith(`${SEARCH_PUBLIC_BASE}/patches/`))
    {
        event.respondWith(cacheSearchAsset(request));
        return;
    }

    if (isPublicShellRequest(request, url))
    {
        event.respondWith(networkFirstShell(request));
        return;
    }

    if (isCanonicalReleaseAssetPath(url.pathname, IMMUTABLE_RELEASE_WASM_ASSET_PATTERN))
    {
        event.respondWith(cacheFirstStatic(request));
        return;
    }

    if (WASM_RUNTIME_ASSET_PATTERN.test(url.pathname))
    {
        event.respondWith(networkFirstStatic(request));
        return;
    }

    if (isExplicitPublicStaticRequest(url))
    {
        event.respondWith(cacheFirstStatic(request));
        return;
    }
});

async function handleControlMessage(message)
{
    switch (message.type)
    {
        case 'shell.invalidate':
        {
            const result = await invalidateShellCache(message.scope ?? null);
            await broadcast({
                type: 'shell-updated',
                scope: message.scope ?? null,
                deletedCount: result.deletedCount
            });
            return result;
        }
        case 'search-index.updated':
            await ensureLatestSearchIndex({ force: true });
            return { updated: true };
        case 'asset.clear':
            await clearNamedCache(message.cache, message.keys ?? null);
            await broadcast({ type: 'cache-cleared', cache: message.cache ?? null });
            return { cleared: true };
        case 'privacy.clear':
        {
            const result = await clearPrivateBrowserStateCaches(message.reason);
            await broadcast({ type: 'private-state-cleared' });
            return result;
        }
        default:
            return { ignored: true };
    }
}

function networkErrorResponse(kind)
{
    return new Response(kind, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Fsus-Service-Worker-Fallback': kind
        }
    });
}

function isPublicShellRequest(request, url)
{
    if (request.mode !== 'navigate')
    {
        return false;
    }

    return PUBLIC_SHELL_PATHS.some((pattern) => pattern.test(url.pathname));
}

function isPrivateOrSensitiveRequest(request, url)
{
    if (PRIVATE_OR_SENSITIVE_PATHS.some((pattern) => pattern.test(url.pathname)))
    {
        return true;
    }

    if (request.cache === 'no-store')
    {
        return true;
    }

    return SENSITIVE_REQUEST_HEADERS.some((header) => request.headers.has(header));
}

function isExplicitPublicStaticRequest(url)
{
    return STATIC_ASSET_PATTERN.test(url.pathname)
    && (EXPLICIT_PUBLIC_STATIC_PATHS.some((pattern) => pattern.test(url.pathname))
      || isCanonicalReleaseAssetPath(url.pathname, IMMUTABLE_RELEASE_ASSET_PATTERN));
}

function isCanonicalReleaseAssetPath(pathname, pattern)
{
    const match = pattern.exec(pathname);
    return match !== null && self.FsusReleaseIdContract.isCanonicalReleaseId(match[1]);
}

async function networkOnlyRequest(request, failureKind)
{
    try
    {
    // Sensitive requests retain credentials but bypass both Service Worker and HTTP caches.
        return await fetch(request, { cache: 'no-store' });
    }
    catch
    {
        return networkErrorResponse(failureKind);
    }
}

async function cacheFirstStatic(request)
{
    let cache = null;
    try
    {
        cache = await openStaticCache();
        const cached = await matchCacheableResponse(cache, request, { requireImmutable: true });
        if (cached)
        {
            return cached;
        }
    }
    catch
    {
    // Cache Storage is an optimization boundary. Firefox can transiently
    // reject concurrent cache opens/matches while a worker takes control;
    // static module delivery must still fall through to the network.
    }

    try
    {
        const response = await fetch(request);
        if (cache)
        {
            await putCacheEntry(cache, request, response, { requireImmutable: true });
        }
        return response;
    }
    catch
    {
        return networkErrorResponse('static-network-unavailable');
    }
}

async function networkFirstStatic(request)
{
    try
    {
        const response = await fetch(request);
        try
        {
            const cache = await openStaticCache();
            await putCacheEntry(cache, request, response, { requireImmutable: true });
        }
        catch
        {
            // A valid network response must not be rejected because Cache Storage
            // is temporarily unavailable.
        }
        return response;
    }
    catch
    {
        try
        {
            const cache = await openStaticCache();
            return (await matchCacheableResponse(cache, request, { requireImmutable: true }))
        ?? networkErrorResponse('static-network-unavailable');
        }
        catch
        {
            return networkErrorResponse('static-network-unavailable');
        }
    }
}

function openStaticCache()
{
    if (!staticCachePromise)
    {
        staticCachePromise = caches.open(STATIC_CACHE).catch((error) =>
        {
            staticCachePromise = null;
            throw error;
        });
    }
    return staticCachePromise;
}

function responseCanEnterCache(response, options = {})
{
    if (!response?.ok || response.type === 'opaque')
    {
        return false;
    }

    const cacheControl = (response.headers.get('Cache-Control') ?? '').toLowerCase();
    const directives = new Set(cacheControl
        .split(',')
        .map((item) => item.trim().split('=', 1)[0].trim())
        .filter(Boolean));
    if (directives.has('no-store') || directives.has('private'))
    {
        return false;
    }

    const vary = (response.headers.get('Vary') ?? '').toLowerCase();
    if (vary === '*' || /(?:^|,)\s*(?:cookie|authorization)\s*(?:,|$)/i.test(vary))
    {
        return false;
    }

    if (response.headers.has('Set-Cookie') || !directives.has('public'))
    {
        return false;
    }

    return options.requireImmutable !== true || directives.has('immutable');
}

async function matchCacheableResponse(cache, request, options = {})
{
    const cached = await cache.match(request);
    if (!cached)
    {
        return null;
    }

    if (responseCanEnterCache(cached, options))
    {
        return cached;
    }

    await cache.delete(request);
    return null;
}

async function putCacheEntry(cache, request, response, options = {})
{
    if (!responseCanEnterCache(response, options))
    {
        return false;
    }

    try
    {
        await cache.put(request, response.clone());
        return true;
    }
    catch
    {
    // Some browsers reject Cache API writes for module/Wasm-adjacent responses.
    // The network response is still valid and should not fail the intercepted fetch.
        return false;
    }
}

async function networkFirstShell(request)
{
    const cache = await caches.open(SHELL_CACHE);
    try
    {
    // Public shell HTML must be fresh to keep SSR markup and SPA bundle in sync.
        const network = await fetch(request, { cache: 'no-store' });
        await putCacheEntry(cache, request, network);
        return network;
    }
    catch
    {
        const cached = await matchCacheableResponse(cache, request);
        if (cached)
        {
            return withOfflineStaleHeaders(cached);
        }
    }

    return new Response('offline', { status: 503, statusText: 'Service Unavailable' });
}

function withOfflineStaleHeaders(response)
{
    const headers = new Headers(response.headers);
    headers.set('X-Fsus-Offline-Stale', '1');
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    });
}

async function handleSearchAliasRequest(request)
{
    const cache = await caches.open(SEARCH_CACHE);
    const cached = await matchCacheableResponse(cache, SEARCH_ALIAS_PATH, { requireImmutable: true });
    if (cached)
    {
        void ensureLatestSearchIndex();
        return cached;
    }

    await ensureLatestSearchIndex();
    return (await cache.match(SEARCH_ALIAS_PATH)) ?? fetch(request);
}

async function cacheSearchAsset(request)
{
    const cache = await caches.open(SEARCH_CACHE);
    const cached = await matchCacheableResponse(cache, request, { requireImmutable: true });
    if (cached)
    {
        return cached;
    }

    const response = await fetch(request);
    await putCacheEntry(cache, request, response, { requireImmutable: true });
    return response;
}

function ensureLatestSearchIndex(options = {})
{
    if (searchIndexUpdatePromise)
    {
        recordSearchIndexTelemetry('singleFlightJoinCount');
        return searchIndexUpdatePromise;
    }

    const force = options.force === true;
    const now = Date.now();
    if (!force && now - lastSearchManifestCheckAt < SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS)
    {
        return Promise.resolve();
    }

    searchIndexUpdatePromise = ensureLatestSearchIndexCore()
        .finally(() =>
        {
            searchIndexUpdatePromise = null;
        });
    return searchIndexUpdatePromise;
}

async function ensureLatestSearchIndexCore()
{
    const startedAt = Date.now();
    lastSearchManifestCheckAt = startedAt;
    recordSearchIndexTelemetry('manifestCheckCount');
    try
    {
        const manifestResponse = await fetch(SEARCH_MANIFEST_PATH, {
            cache: 'no-store',
            headers: { Accept: AEDS_BINARY_MEDIA_TYPE }
        });
        if (!manifestResponse.ok)
        {
            throw new Error(`search_manifest_fetch_failed:${manifestResponse.status}`);
        }

        const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
        const manifest = decodeSearchManifest(manifestBytes);
        const meta = await readSearchMeta();
        if (meta?.currentVersion === manifest.currentVersion)
        {
            return;
        }

        await storeSearchAssets(manifest);
        currentSearchVersion = manifest.currentVersion;
        await broadcast({ type: 'search-index-ready', version: manifest.currentVersion });
    }
    catch (error)
    {
        lastSearchManifestCheckAt = 0;
        throw error;
    }
    finally
    {
        recordSearchIndexTelemetry('searchIndexUpdateElapsed', Date.now() - startedAt);
    }
}

async function storeSearchAssets(manifest)
{
    const searchCache = await caches.open(SEARCH_CACHE);

    const eagerRoles = new Set([
        ...(Array.isArray(manifest.initialRoles) ? manifest.initialRoles : []),
        ...(Array.isArray(manifest.backgroundRoles) ? manifest.backgroundRoles : [])
    ]);

    const eagerShards = Array.isArray(manifest.shards)
        ? manifest.shards.filter((shard) =>
{
      const role = normalizeSearchRole(shard.role);
      return Boolean(role && eagerRoles.has(role));
    })
        : [];

    await mapWithConcurrency(
        eagerShards,
        SEARCH_ASSET_FETCH_CONCURRENCY,
        (shard) => storeSearchShard(searchCache, manifest.currentVersion, shard)
    );
    await pruneStaleSearchShards(searchCache, manifest);
}

async function storeSearchShard(searchCache, currentVersion, shard)
{
    const fullResponse = await fetch(shard.fullUrl, { cache: 'no-store' });
    if (!fullResponse.ok)
    {
        throw new Error(`search_full_fetch_failed:${fullResponse.status}`);
    }

    const fullBytes = new Uint8Array(await fullResponse.arrayBuffer());
    await verifySha256(fullBytes, shard.fullSha256, 'search_full_hash_mismatch');
    const fullStored = await putCacheEntry(searchCache, shard.fullUrl, new Response(fullBytes.slice(0), {
        headers: copySearchAssetHeaders(fullResponse.headers, currentVersion)
    }), { requireImmutable: true });
    if (!fullStored)
    {
        throw new Error('search_full_not_public_immutable');
    }

    if (shard.patchUrl)
    {
        const patchResponse = await fetch(shard.patchUrl, { cache: 'no-store' });
        if (patchResponse.ok)
        {
            const patchBytes = new Uint8Array(await patchResponse.arrayBuffer());
            if (shard.patchSha256)
            {
                await verifySha256(patchBytes, shard.patchSha256, 'search_patch_hash_mismatch');
            }

            const patchStored = await putCacheEntry(searchCache, shard.patchUrl, new Response(patchBytes.slice(0), {
                headers: copySearchAssetHeaders(patchResponse.headers, currentVersion)
            }), { requireImmutable: true });
            if (!patchStored)
            {
                throw new Error('search_patch_not_public_immutable');
            }
        }
    }
}

function copySearchAssetHeaders(sourceHeaders, currentVersion)
{
    const headers = new Headers();
    const contentType = sourceHeaders.get('Content-Type');
    const cacheControl = sourceHeaders.get('Cache-Control');
    if (contentType)
    {
        headers.set('Content-Type', contentType);
    }
    if (cacheControl)
    {
        headers.set('Cache-Control', cacheControl);
    }
    headers.set('X-Fsus-Search-Version', currentVersion);
    return headers;
}

async function pruneStaleSearchShards(searchCache, manifest)
{
    const currentUrls = new Set();
    if (Array.isArray(manifest.shards))
    {
        for (const shard of manifest.shards)
        {
            currentUrls.add(new URL(shard.fullUrl, self.location.origin).href);
            if (shard.patchUrl)
            {
                currentUrls.add(new URL(shard.patchUrl, self.location.origin).href);
            }
        }
    }

    let staleShardDeletedCount = 0;
    const keys = await searchCache.keys();
    await Promise.all(keys.map(async (request) =>
    {
        const url = new URL(request.url);
        const isSearchShard = url.pathname.startsWith(`${SEARCH_PUBLIC_BASE}/index.`) || url.pathname.startsWith(`${SEARCH_PUBLIC_BASE}/patches/`);
        if (!isSearchShard || url.pathname === SEARCH_MANIFEST_PATH || url.pathname === SEARCH_ALIAS_PATH)
        {
            return;
        }

        const response = await searchCache.match(request);
        const cachedVersion = response?.headers.get('X-Fsus-Search-Version') ?? null;
        if ((cachedVersion && cachedVersion !== manifest.currentVersion) || !currentUrls.has(url.href))
        {
            if (await searchCache.delete(request))
            {
                staleShardDeletedCount += 1;
            }
        }
    }));
    if (staleShardDeletedCount > 0)
    {
        recordSearchIndexTelemetry('staleShardDeletedCount', staleShardDeletedCount);
    }
}

async function mapWithConcurrency(items, limit, mapper)
{
    const results = [];
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, async () =>
    {
        while (nextIndex < items.length)
        {
            const currentIndex = nextIndex;
            nextIndex += 1;
            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    }));
    return results;
}

function recordSearchIndexTelemetry(name, value = 1)
{
    if (name === 'searchIndexUpdateElapsed')
    {
        searchIndexTelemetry.searchIndexUpdateElapsed = Math.max(0, Number(value) || 0);
        return;
    }

    searchIndexTelemetry[name] = Math.max(0, (searchIndexTelemetry[name] ?? 0) + (Number(value) || 0));
}

async function readSearchMeta()
{
    return currentSearchVersion ? { currentVersion: currentSearchVersion } : null;
}

function decodeSearchManifest(bytes)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    const readUint32 = () =>
    {
        if (offset + 4 > bytes.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getUint32(offset, true);
        offset += 4;
        return value;
    };
    const readInt32 = () =>
    {
        if (offset + 4 > bytes.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getInt32(offset, true);
        offset += 4;
        return value;
    };
    const readInt64 = () =>
    {
        if (offset + 8 > bytes.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        const value = view.getBigInt64(offset, true);
        offset += 8;
        return value;
    };
    const readBool = () =>
    {
        if (offset + 1 > bytes.byteLength)
        {
            throw new Error('search_manifest_truncated');
        }
        return bytes[offset++] !== 0;
    };
    const readString = () =>
    {
        const length = readInt32();
        if (length < 0 || length > 4096 || offset + length > bytes.byteLength)
        {
            throw new Error('search_manifest_string_invalid');
        }
        const value = TEXT_DECODER.decode(bytes.subarray(offset, offset + length));
        offset += length;
        return value;
    };
    const readNullableString = () => readBool() ? readString() : null;
    const readStringList = () =>
    {
        const count = readInt32();
        if (count < 0 || count > 32)
        {
            throw new Error('search_manifest_list_invalid');
        }
        return Array.from({ length: count }, () => readString());
    };

    if (readUint32() !== SEARCH_MANIFEST_MAGIC || readUint32() !== SEARCH_MANIFEST_BINARY_VERSION)
    {
        throw new Error('search_manifest_magic_invalid');
    }

    const schemaVersion = readInt32();
    const ticks = readInt64();
    const generatedAtMs = Number(ticks / 10000n) - DOTNET_EPOCH_OFFSET_MS;
    const currentVersion = readString();
    const shardCount = readInt32();
    if (shardCount < 0 || shardCount > 32)
    {
        throw new Error('search_manifest_shards_invalid');
    }

    const shards = [];
    for (let index = 0; index < shardCount; index += 1)
    {
        shards.push({
            role: readUint32(),
            fullUrl: readString(),
            fullSha256: readString(),
            patchUrl: readNullableString(),
            patchSha256: readNullableString(),
            loadPhase: readInt32()
        });
    }

    const manifest = {
        schemaVersion,
        currentVersion,
        generatedAt: new Date(generatedAtMs).toISOString(),
        shards,
        initialRoles: readStringList(),
        backgroundRoles: readStringList(),
        deepRoles: readStringList()
    };

    if (offset !== bytes.byteLength)
    {
        throw new Error('search_manifest_trailing_bytes');
    }
    return manifest;
}

function normalizeSearchRole(role)
{
    switch (role)
    {
        case 0:
        case 'core':
            return 'core';
        case 1:
        case 'recent':
            return 'recent';
        case 2:
        case 'archive':
            return 'archive';
        default:
            return null;
    }
}

async function invalidateShellCache(scope = null)
{
    const cache = await caches.open(SHELL_CACHE);
    const keys = await cache.keys();
    const targets = resolveShellInvalidationTargets(scope, keys);
    const deleted = await Promise.all(targets.map((key) => cache.delete(key)));
    const deletedCount = deleted.filter(Boolean).length;
    const shellCacheSizeBefore = keys.length;
    const shellCacheSizeAfter = Math.max(0, shellCacheSizeBefore - deletedCount);
    const result = {
        scope: normalizeShellInvalidationScope(scope),
        deletedCount,
        shellCacheSizeBefore,
        shellCacheSizeAfter
    };
    recordShellInvalidateTelemetry(result);
    return result;
}

function resolveShellInvalidationTargets(scope, keys)
{
    const normalizedScope = normalizeShellInvalidationScope(scope);
    switch (normalizedScope)
    {
        case 'seo':
        case 'compliance':
        case null:
            return keys;
        default:
            break;
    }

    const paths = SHELL_INVALIDATION_SCOPE_PATHS[normalizedScope];
    if (!paths)
    {
        return keys;
    }

    const targetPaths = new Set(paths.map((path) => normalizeShellPath(path)));
    return keys.filter((key) => targetPaths.has(normalizeShellPath(key.url)));
}

function normalizeShellInvalidationScope(scope)
{
    if (typeof scope !== 'string')
    {
        return null;
    }

    const normalized = scope.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function normalizeShellPath(value)
{
    const pathname = new URL(value, self.location.origin).pathname.replace(/\/+$/, '');
    return pathname.length > 0 ? pathname : '/';
}

function recordShellInvalidateTelemetry(result)
{
    shellInvalidateTelemetry.shellInvalidateScope = result.scope;
    shellInvalidateTelemetry.shellDeletedCount = result.deletedCount;
    shellInvalidateTelemetry.shellCacheSizeBefore = result.shellCacheSizeBefore;
    shellInvalidateTelemetry.shellCacheSizeAfter = result.shellCacheSizeAfter;
}

async function clearNamedCache(cacheName, keys)
{
    if (!cacheName)
    {
        return;
    }

    const cache = await caches.open(cacheName);
    if (!Array.isArray(keys) || keys.length === 0)
    {
        const requests = await cache.keys();
        await Promise.all(requests.map((request) => cache.delete(request)));
        return;
    }

    await Promise.all(keys.map((key) => cache.delete(key)));
}

async function requireCurrentReleaseBrowserAdmission()
{
    // The operational manifest contains private DB identities and host paths.
    // No signed public projection or native exact-candidate health bridge exists.
    // A build label, message or cached document cannot supply that admission.
    throw new Error('current_release_browser_admission_unconfigured');
}

async function clearPrivateBrowserStateCaches(reason)
{
    const cacheNames = await caches.keys();
    let deletedCacheCount = 0;
    let deletedEntryCount = 0;

    await Promise.all(cacheNames.map(async (cacheName) =>
    {
        if (reason === 'panic' && cacheName.startsWith('fsus-'))
        {
            if (await caches.delete(cacheName))
            {
                if (cacheName === STATIC_CACHE)
                {
                    staticCachePromise = null;
                }
                deletedCacheCount += 1;
            }
            return;
        }
        if (PRIVATE_BROWSER_CACHE_NAME_PATTERN.test(cacheName))
        {
            if (await caches.delete(cacheName))
            {
                deletedCacheCount += 1;
            }
            return;
        }

        if (!cacheName.startsWith('fsus-'))
        {
            return;
        }

        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        await Promise.all(requests.map(async (request) =>
        {
            const url = new URL(request.url);
            if (PRIVATE_OR_SENSITIVE_PATHS.some((pattern) => pattern.test(url.pathname))
        && await cache.delete(request))
            {
                deletedEntryCount += 1;
            }
        }));
    }));

    currentSearchVersion = null;
    lastSearchManifestCheckAt = 0;
    return { deletedCacheCount, deletedEntryCount };
}

async function broadcast(message)
{
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(clients.map((client) => client.postMessage(message)));
}

async function verifySha256(bytes, expected, errorCode)
{
    const digest = await self.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    if (hex !== String(expected || '').toLowerCase())
    {
        throw new Error(errorCode);
    }
}
