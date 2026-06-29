const STATIC_CACHE = 'fsus-static-v4'
const SHELL_CACHE = 'fsus-shell-v5'
const SEARCH_CACHE = 'fsus-search-v4'
const SEARCH_META_CACHE = 'fsus-search-meta-v4'
const SEARCH_ALIAS_PATH = '/search/index.bin'
const SEARCH_MANIFEST_PATH = '/search/index.manifest.aeds'
const SEARCH_MANIFEST_MAGIC = 0x4d495346
const SEARCH_MANIFEST_BINARY_VERSION = 1
const SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS = 30000
const SEARCH_ASSET_FETCH_CONCURRENCY = 3
const AEDS_BINARY_MEDIA_TYPE = 'application/octet-stream'
const DOTNET_EPOCH_OFFSET_MS = 62135596800000
const TEXT_DECODER = new TextDecoder()
let searchIndexUpdatePromise = null
let lastSearchManifestCheckAt = 0
const searchIndexTelemetry = {
  manifestCheckCount: 0,
  singleFlightJoinCount: 0,
  staleShardDeletedCount: 0,
  searchIndexUpdateElapsed: 0
}
const PUBLIC_SHELL_PATHS = [
  /^\/$/,
  /^\/about\/?$/,
  /^\/archive\/?$/,
  /^\/search\/?$/,
  /^\/article\/\d+\/?$/,
  /^\/category\/\d+\/?$/,
  /^\/tag\/\d+\/?$/
]
const STATIC_ASSET_PATTERN = /\.(?:css|js|mjs|wasm|woff2?|ttf|otf|eot|ico|svg|png|jpe?g|webp|avif)$/i
const WASM_RUNTIME_ASSET_PATTERN = /^\/wasm\/[^/]+\.(?:js|wasm)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyFsusCaches()
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message.type !== 'string') {
    return
  }

  event.waitUntil(handleControlMessage(message))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') {
    return
  }

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) {
    return
  }

  if (url.pathname.startsWith('/api/binary/')) {
    event.respondWith(handleBinaryApiRequest(request))
    return
  }

  if (url.pathname === SEARCH_ALIAS_PATH) {
    event.respondWith(handleSearchAliasRequest(request))
    return
  }

  if (url.pathname.startsWith('/search/index.') || url.pathname.startsWith('/search/patches/')) {
    event.respondWith(cacheSearchAsset(request))
    return
  }

  if (isPublicShellRequest(request, url)) {
    event.respondWith(networkFirstShell(request))
    return
  }

  if (WASM_RUNTIME_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(networkFirstStatic(request))
    return
  }

  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(cacheFirstStatic(request))
    return
  }
})

async function handleControlMessage(message) {
  switch (message.type) {
    case 'shell.invalidate':
      await invalidateShellCache()
      await broadcast({ type: 'shell-updated', scope: message.scope ?? null })
      break
    case 'search-index.updated':
      await ensureLatestSearchIndex({ force: true })
      break
    case 'asset.clear':
      await clearNamedCache(message.cache, message.keys ?? null)
      await broadcast({ type: 'cache-cleared', cache: message.cache ?? null })
      break
    default:
      break
  }
}

function networkErrorResponse(kind) {
  return new Response(kind, {
    status: 503,
    statusText: 'Service Unavailable',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Fsus-Service-Worker-Fallback': kind
    }
  })
}

function isPublicShellRequest(request, url) {
  if (request.mode !== 'navigate') {
    return false
  }

  return PUBLIC_SHELL_PATHS.some((pattern) => pattern.test(url.pathname))
}

async function handleBinaryApiRequest(request) {
  try {
    // Binary API artifacts stay network pass-through; server headers own browser cache policy.
    return await fetch(request)
  } catch {
    return networkErrorResponse('binary-network-unavailable')
  }
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }

  try {
    const response = await fetch(request)
    if (response.ok) {
      await putCacheEntry(cache, request, response)
    }
    return response
  } catch {
    return networkErrorResponse('static-network-unavailable')
  }
}

async function networkFirstStatic(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(STATIC_CACHE)
    return (await cache.match(request)) ?? networkErrorResponse('static-network-unavailable')
  }
}

async function putCacheEntry(cache, request, response) {
  try {
    await cache.put(request, response.clone())
  } catch {
    // Some browsers reject Cache API writes for module/Wasm-adjacent responses.
    // The network response is still valid and should not fail the intercepted fetch.
  }
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    // Public shell HTML must be fresh to keep SSR markup and SPA bundle in sync.
    const network = await fetch(request, { cache: 'no-store' })
    if (network.ok) {
      await cache.put(request, network.clone())
    }
    return network
  } catch {
    const cached = await cache.match(request)
    if (cached) {
      return withOfflineStaleHeaders(cached)
    }
  }

  return new Response('offline', { status: 503, statusText: 'Service Unavailable' })
}

function withOfflineStaleHeaders(response) {
  const headers = new Headers(response.headers)
  headers.set('X-Fsus-Offline-Stale', '1')
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

async function handleSearchAliasRequest(request) {
  const cache = await caches.open(SEARCH_CACHE)
  const cached = await cache.match(SEARCH_ALIAS_PATH)
  if (cached) {
    void ensureLatestSearchIndex()
    return cached
  }

  await ensureLatestSearchIndex()
  return (await cache.match(SEARCH_ALIAS_PATH)) ?? fetch(request)
}

async function cacheSearchAsset(request) {
  const cache = await caches.open(SEARCH_CACHE)
  const cached = await cache.match(request)
  if (cached) {
    return cached
  }

  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
  }
  return response
}

function ensureLatestSearchIndex(options = {}) {
  if (searchIndexUpdatePromise) {
    recordSearchIndexTelemetry('singleFlightJoinCount')
    return searchIndexUpdatePromise
  }

  const force = options.force === true
  const now = Date.now()
  if (!force && now - lastSearchManifestCheckAt < SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS) {
    return Promise.resolve()
  }

  searchIndexUpdatePromise = ensureLatestSearchIndexCore()
    .finally(() => {
      searchIndexUpdatePromise = null
    })
  return searchIndexUpdatePromise
}

async function ensureLatestSearchIndexCore() {
  const startedAt = Date.now()
  lastSearchManifestCheckAt = startedAt
  recordSearchIndexTelemetry('manifestCheckCount')
  try {
    const manifestResponse = await fetch(SEARCH_MANIFEST_PATH, {
      cache: 'no-store',
      headers: { Accept: AEDS_BINARY_MEDIA_TYPE }
    })
    if (!manifestResponse.ok) {
      throw new Error(`search_manifest_fetch_failed:${manifestResponse.status}`)
    }

    const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer())
    const manifest = decodeSearchManifest(manifestBytes)
    const meta = await readSearchMeta()
    if (meta?.currentVersion === manifest.currentVersion) {
      return
    }

    await storeSearchAssets(manifest, manifestBytes)
    await broadcast({ type: 'search-index-ready', version: manifest.currentVersion })
  } catch (error) {
    lastSearchManifestCheckAt = 0
    throw error
  } finally {
    recordSearchIndexTelemetry('searchIndexUpdateElapsed', Date.now() - startedAt)
  }
}

async function storeSearchAssets(manifest, manifestBytes) {
  const searchCache = await caches.open(SEARCH_CACHE)
  await searchCache.put(SEARCH_MANIFEST_PATH, new Response(manifestBytes.slice(0), {
    headers: { 'Content-Type': AEDS_BINARY_MEDIA_TYPE, 'Cache-Control': 'no-store' }
  }))

  const eagerRoles = new Set([
    ...(Array.isArray(manifest.initialRoles) ? manifest.initialRoles : []),
    ...(Array.isArray(manifest.backgroundRoles) ? manifest.backgroundRoles : [])
  ])

  const eagerShards = Array.isArray(manifest.shards)
    ? manifest.shards.filter((shard) => {
      const role = normalizeSearchRole(shard.role)
      return Boolean(role && eagerRoles.has(role))
    })
    : []

  await mapWithConcurrency(
    eagerShards,
    SEARCH_ASSET_FETCH_CONCURRENCY,
    (shard) => storeSearchShard(searchCache, manifest.currentVersion, shard)
  )
  await pruneStaleSearchShards(searchCache, manifest)
}

async function storeSearchShard(searchCache, currentVersion, shard) {
  const fullResponse = await fetch(shard.fullUrl, { cache: 'no-store' })
  if (!fullResponse.ok) {
    throw new Error(`search_full_fetch_failed:${fullResponse.status}`)
  }

  const fullBytes = new Uint8Array(await fullResponse.arrayBuffer())
  await verifySha256(fullBytes, shard.fullSha256, 'search_full_hash_mismatch')
  await searchCache.put(shard.fullUrl, new Response(fullBytes.slice(0), {
    headers: {
      'Content-Type': AEDS_BINARY_MEDIA_TYPE,
      'Cache-Control': 'public,max-age=31536000,immutable',
      'X-Fsus-Search-Version': currentVersion
    }
  }))

  if (shard.patchUrl) {
    const patchResponse = await fetch(shard.patchUrl, { cache: 'no-store' })
    if (patchResponse.ok) {
      const patchBytes = new Uint8Array(await patchResponse.arrayBuffer())
      if (shard.patchSha256) {
        await verifySha256(patchBytes, shard.patchSha256, 'search_patch_hash_mismatch')
      }

      await searchCache.put(shard.patchUrl, new Response(patchBytes.slice(0), {
        headers: {
          'Content-Type': AEDS_BINARY_MEDIA_TYPE,
          'Cache-Control': 'public,max-age=31536000,immutable',
          'X-Fsus-Search-Version': currentVersion
        }
      }))
    }
  }
}

async function pruneStaleSearchShards(searchCache, manifest) {
  const currentUrls = new Set()
  if (Array.isArray(manifest.shards)) {
    for (const shard of manifest.shards) {
      currentUrls.add(new URL(shard.fullUrl, self.location.origin).href)
      if (shard.patchUrl) {
        currentUrls.add(new URL(shard.patchUrl, self.location.origin).href)
      }
    }
  }

  let staleShardDeletedCount = 0
  const keys = await searchCache.keys()
  await Promise.all(keys.map(async (request) => {
    const url = new URL(request.url)
    const isSearchShard = url.pathname.startsWith('/search/index.') || url.pathname.startsWith('/search/patches/')
    if (!isSearchShard || url.pathname === SEARCH_MANIFEST_PATH || url.pathname === SEARCH_ALIAS_PATH) {
      return
    }

    const response = await searchCache.match(request)
    const cachedVersion = response?.headers.get('X-Fsus-Search-Version') ?? null
    if ((cachedVersion && cachedVersion !== manifest.currentVersion) || !currentUrls.has(url.href)) {
      if (await searchCache.delete(request)) {
        staleShardDeletedCount += 1
      }
    }
  }))
  if (staleShardDeletedCount > 0) {
    recordSearchIndexTelemetry('staleShardDeletedCount', staleShardDeletedCount)
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = []
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }))
  return results
}

function recordSearchIndexTelemetry(name, value = 1) {
  if (name === 'searchIndexUpdateElapsed') {
    searchIndexTelemetry.searchIndexUpdateElapsed = Math.max(0, Number(value) || 0)
    return
  }

  searchIndexTelemetry[name] = Math.max(0, (searchIndexTelemetry[name] ?? 0) + (Number(value) || 0))
}

async function readSearchMeta() {
  const cache = await caches.open(SEARCH_CACHE)
  const response = await cache.match(SEARCH_MANIFEST_PATH)
  if (!response) {
    return null
  }

  try {
    const manifest = decodeSearchManifest(new Uint8Array(await response.arrayBuffer()))
    return { currentVersion: manifest.currentVersion, updatedAt: manifest.generatedAt }
  } catch {
    return null
  }
}

function decodeSearchManifest(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const readUint32 = () => {
    if (offset + 4 > bytes.byteLength) throw new Error('search_manifest_truncated')
    const value = view.getUint32(offset, true)
    offset += 4
    return value
  }
  const readInt32 = () => {
    if (offset + 4 > bytes.byteLength) throw new Error('search_manifest_truncated')
    const value = view.getInt32(offset, true)
    offset += 4
    return value
  }
  const readInt64 = () => {
    if (offset + 8 > bytes.byteLength) throw new Error('search_manifest_truncated')
    const value = view.getBigInt64(offset, true)
    offset += 8
    return value
  }
  const readBool = () => {
    if (offset + 1 > bytes.byteLength) throw new Error('search_manifest_truncated')
    return bytes[offset++] !== 0
  }
  const readString = () => {
    const length = readInt32()
    if (length < 0 || length > 4096 || offset + length > bytes.byteLength) {
      throw new Error('search_manifest_string_invalid')
    }
    const value = TEXT_DECODER.decode(bytes.subarray(offset, offset + length))
    offset += length
    return value
  }
  const readNullableString = () => readBool() ? readString() : null
  const readStringList = () => {
    const count = readInt32()
    if (count < 0 || count > 32) {
      throw new Error('search_manifest_list_invalid')
    }
    return Array.from({ length: count }, () => readString())
  }

  if (readUint32() !== SEARCH_MANIFEST_MAGIC || readUint32() !== SEARCH_MANIFEST_BINARY_VERSION) {
    throw new Error('search_manifest_magic_invalid')
  }

  const schemaVersion = readInt32()
  const ticks = readInt64()
  const generatedAtMs = Number(ticks / 10000n) - DOTNET_EPOCH_OFFSET_MS
  const currentVersion = readString()
  const shardCount = readInt32()
  if (shardCount < 0 || shardCount > 32) {
    throw new Error('search_manifest_shards_invalid')
  }

  const shards = []
  for (let index = 0; index < shardCount; index += 1) {
    shards.push({
      role: readUint32(),
      fullUrl: readString(),
      fullSha256: readString(),
      patchUrl: readNullableString(),
      patchSha256: readNullableString(),
      loadPhase: readInt32()
    })
  }

  const manifest = {
    schemaVersion,
    currentVersion,
    generatedAt: new Date(generatedAtMs).toISOString(),
    shards,
    initialRoles: readStringList(),
    backgroundRoles: readStringList(),
    deepRoles: readStringList()
  }

  if (offset !== bytes.byteLength) {
    throw new Error('search_manifest_trailing_bytes')
  }
  return manifest
}

function normalizeSearchRole(role) {
  switch (role) {
    case 0:
    case 'core':
      return 'core'
    case 1:
    case 'recent':
      return 'recent'
    case 2:
    case 'archive':
      return 'archive'
    default:
      return null
  }
}

async function invalidateShellCache() {
  const cache = await caches.open(SHELL_CACHE)
  const keys = await cache.keys()
  await Promise.all(keys.map((key) => cache.delete(key)))
}

async function clearNamedCache(cacheName, keys) {
  if (!cacheName) {
    return
  }

  const cache = await caches.open(cacheName)
  if (!Array.isArray(keys) || keys.length === 0) {
    const requests = await cache.keys()
    await Promise.all(requests.map((request) => cache.delete(request)))
    return
  }

  await Promise.all(keys.map((key) => cache.delete(key)))
}

async function clearLegacyFsusCaches() {
  const keep = new Set([STATIC_CACHE, SHELL_CACHE, SEARCH_CACHE, SEARCH_META_CACHE])
  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((key) => key.startsWith('fsus-') && !keep.has(key))
      .map((key) => caches.delete(key))
  )
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  await Promise.all(clients.map((client) => client.postMessage(message)))
}

async function verifySha256(bytes, expected, errorCode) {
  const digest = await self.crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  if (hex !== String(expected || '').toLowerCase()) {
    throw new Error(errorCode)
  }
}
