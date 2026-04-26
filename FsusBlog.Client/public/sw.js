const STATIC_CACHE = 'fsus-static-v3'
const SHELL_CACHE = 'fsus-shell-v3'
const SEARCH_CACHE = 'fsus-search-v2'
const SEARCH_META_CACHE = 'fsus-search-meta-v2'
const SEARCH_ALIAS_PATH = '/search/index.bin'
const SEARCH_META_KEY = '/search/index.meta.json'
const SEARCH_MANIFEST_PATH = '/search/index.manifest.json'
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

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request))
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
    event.respondWith(staleWhileRevalidateShell(request))
    return
  }

  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(cacheFirstStatic(request))
  }
})

async function handleControlMessage(message) {
  switch (message.type) {
    case 'shell.invalidate':
      await invalidateShellCache()
      await broadcast({ type: 'shell-updated', scope: message.scope ?? null })
      break
    case 'search-index.updated':
      await ensureLatestSearchIndex()
      break
    case 'asset.clear':
      await clearNamedCache(message.cache, message.keys ?? null)
      await broadcast({ type: 'cache-cleared', cache: message.cache ?? null })
      break
    default:
      break
  }
}

function isPublicShellRequest(request, url) {
  if (request.mode !== 'navigate') {
    return false
  }

  return PUBLIC_SHELL_PATHS.some((pattern) => pattern.test(url.pathname))
}

async function cacheFirstStatic(request) {
  const cache = await caches.open(STATIC_CACHE)
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

async function staleWhileRevalidateShell(request) {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  const networkPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      await cache.put(request, response.clone())
    }
    return response
  }).catch(() => null)

  if (cached) {
    void networkPromise
    return cached
  }

  const network = await networkPromise
  if (network) {
    return network
  }

  return new Response('offline', { status: 503, statusText: 'Service Unavailable' })
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

async function ensureLatestSearchIndex() {
  const manifestResponse = await fetch(SEARCH_MANIFEST_PATH, { cache: 'no-store' })
  if (!manifestResponse.ok) {
    throw new Error(`search_manifest_fetch_failed:${manifestResponse.status}`)
  }

  const manifest = await manifestResponse.json()
  const meta = await readSearchMeta()
  if (meta?.currentVersion === manifest.currentVersion) {
    return
  }

  await storeSearchAssets(manifest)
  await broadcast({ type: 'search-index-ready', version: manifest.currentVersion })
}

async function storeSearchAssets(manifest) {
  const searchCache = await caches.open(SEARCH_CACHE)
  const metaCache = await caches.open(SEARCH_META_CACHE)
  await searchCache.put(SEARCH_MANIFEST_PATH, new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  }))

  const eagerRoles = new Set([
    ...(Array.isArray(manifest.initialRoles) ? manifest.initialRoles : []),
    ...(Array.isArray(manifest.backgroundRoles) ? manifest.backgroundRoles : [])
  ])

  if (Array.isArray(manifest.shards)) {
    for (const shard of manifest.shards) {
      if (!eagerRoles.has(shard.role)) {
        continue
      }

      const fullResponse = await fetch(shard.fullUrl, { cache: 'no-store' })
      if (!fullResponse.ok) {
        throw new Error(`search_full_fetch_failed:${fullResponse.status}`)
      }

      const fullBytes = new Uint8Array(await fullResponse.arrayBuffer())
      await verifySha256(fullBytes, shard.fullSha256, 'search_full_hash_mismatch')
      await searchCache.put(shard.fullUrl, new Response(fullBytes.slice(0), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'public,max-age=31536000,immutable',
          'X-Fsus-Search-Version': manifest.currentVersion
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
              'Content-Type': 'application/octet-stream',
              'Cache-Control': 'public,max-age=31536000,immutable',
              'X-Fsus-Search-Version': manifest.currentVersion
            }
          }))
        }
      }
    }
  }

  await metaCache.put(
    SEARCH_META_KEY,
    new Response(JSON.stringify({
      currentVersion: manifest.currentVersion,
      updatedAt: manifest.generatedAt
    }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    })
  )
}

async function readSearchMeta() {
  const cache = await caches.open(SEARCH_META_CACHE)
  const response = await cache.match(SEARCH_META_KEY)
  if (!response) {
    return null
  }

  try {
    return await response.json()
  } catch {
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
