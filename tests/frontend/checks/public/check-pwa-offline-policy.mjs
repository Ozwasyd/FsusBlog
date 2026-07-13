#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const manifestPath = resolve(root, 'public/manifest.webmanifest')
const serviceWorkerPath = resolve(root, 'public/sw.js')
const indexPath = resolve(root, 'index.html')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function read(path) {
  assert(existsSync(path), `missing file: ${path}`)
  return readFileSync(path, 'utf8')
}

const manifest = JSON.parse(read(manifestPath))
const sw = read(serviceWorkerPath)
const index = read(indexPath)

assert(manifest.name === 'Fsu’s Blog.', 'static manifest must use the checked-in default brand name')
assert(manifest.short_name === 'FsuBlog', 'static manifest short_name must use the checked-in default brand short name')
assert(manifest.description === 'A personal blog under Fsu’s Club.', 'static manifest description must use the checked-in default brand description')
assert(manifest.theme_color === '#0B4F7A', 'static manifest theme_color must use the default brand primary blue')
assert(manifest.background_color === '#FFFFFF', 'static manifest background_color must use the default brand background')
assert(manifest.start_url === '/', 'manifest start_url must stay public')
assert(manifest.scope === '/', 'manifest scope must stay site-root')
assert(manifest.display === 'standalone', 'manifest display must support installability')
assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest must expose icons')
assert(manifest.icons.some((icon) => icon.src === '/favicon/pwa-192x192.png'), 'manifest must expose the default 192px PWA icon')
assert(manifest.icons.some((icon) => icon.src === '/favicon/pwa-512x512.png'), 'manifest must expose the default 512px PWA icon')
assert(manifest.icons.some((icon) => icon.src === '/favicon/maskable-icon-512x512.png' && icon.purpose === 'maskable'), 'manifest must expose the default maskable icon')
assert(index.includes('rel="manifest" href="/manifest.webmanifest"'), 'index.html must discover the manifest')

const shellPathBlock = sw.slice(
  sw.indexOf('const PUBLIC_SHELL_PATHS'),
  sw.indexOf('const STATIC_ASSET_PATTERN')
)
assert(shellPathBlock.includes('/^\\/article\\/\\d+\\/?$/'), 'public article shell route must be cacheable')
assert(!shellPathBlock.includes('/user'), 'service worker must not cache /user shells')
assert(!shellPathBlock.includes('/admin'), 'service worker must not cache admin shells')
assert(!shellPathBlock.includes('/login'), 'service worker must not cache login shells')
assert(sw.includes("headers.set('X-Fsus-Offline-Stale', '1')"), 'offline shell responses must be marked stale')
assert(sw.includes("headers.set('Cache-Control', 'no-store')"), 'offline stale shell responses must not be re-cached by HTTP caches')
assert(sw.includes("url.pathname.startsWith('/api/binary/')"), 'binary API requests must stay outside shell cache handling')
assert(sw.includes('clearLegacyFsusCaches'), 'service worker activate must clear legacy fsus caches')
assert(sw.includes("key.startsWith('fsus-') && !keep.has(key)"), 'service worker must preserve only current cache names')
assert(sw.includes("case 'shell.invalidate':"), 'service worker must support explicit shell invalidation')
assert(sw.includes('invalidateShellCache(message.scope ?? null)'), 'shell.invalidate must pass message scope into shell cache invalidation')
assert(sw.includes('const SHELL_INVALIDATION_SCOPE_PATHS'), 'service worker must define shell invalidation scope to route mapping')
assert(sw.includes("about: ['/about']"), 'about shell invalidation must only target /about')
assert(sw.includes("archive: ['/archive']"), 'archive shell invalidation must only target /archive')
assert(sw.includes("case 'seo':"), 'seo shell invalidation must remain global')
assert(sw.includes('shellInvalidateTelemetry'), 'shell invalidation must record telemetry')
assert(sw.includes('shellDeletedCount'), 'shell invalidation telemetry must record deleted count')
assert(sw.includes('shellCacheSizeBefore'), 'shell invalidation telemetry must record cache size before')
assert(sw.includes('shellCacheSizeAfter'), 'shell invalidation telemetry must record cache size after')
assert(sw.includes("case 'search-index.updated':"), 'service worker must support search index refresh messages')
assert(sw.includes("case 'asset.clear':"), 'service worker must support targeted cache clearing')
assert(sw.includes("networkErrorResponse('binary-network-unavailable')"), 'binary API offline failures must not be cached as shells')
assert(sw.includes("fetch(request, { cache: 'no-store' })"), 'public shell network refresh must bypass HTTP cache')
assert(sw.includes('WASM_RUNTIME_ASSET_PATTERN'), 'service worker must detect Wasm runtime assets separately')
assert(sw.includes('networkFirstStatic(request)'), 'Wasm runtime assets must stay network-first')
assert(sw.includes('putCacheEntry(cache, request, response)'), 'static cache writes must not fail intercepted responses')
assert(sw.includes('SEARCH_MANIFEST_MIN_CHECK_INTERVAL_MS'), 'search index manifest checks must be TTL throttled')
assert(sw.includes('let searchIndexUpdatePromise = null'), 'search index refresh must use single-flight promise state')
assert(sw.includes('.finally(() =>') && sw.includes('searchIndexUpdatePromise = null'), 'search index single-flight promise must clear after settle')
assert(sw.includes('lastSearchManifestCheckAt'), 'search index refresh must remember the last manifest check time')
assert(sw.includes('force: true'), 'search-index.updated messages must bypass the manifest TTL')
assert(sw.includes('recordSearchIndexTelemetry'), 'search index refresh must record SW telemetry counters')
assert(sw.includes('manifestCheckCount'), 'search index telemetry must count manifest checks')
assert(sw.includes('singleFlightJoinCount'), 'search index telemetry must count single-flight joins')
assert(sw.includes('staleShardDeletedCount'), 'search index telemetry must count stale shard deletions')
assert(sw.includes('searchIndexUpdateElapsed'), 'search index telemetry must record update elapsed time')
assert(sw.includes('pruneStaleSearchShards'), 'search index updates must prune stale cached shards')
assert(sw.includes("headers.get('X-Fsus-Search-Version')"), 'stale shard pruning must use cached search version headers')
assert(sw.includes('SEARCH_ASSET_FETCH_CONCURRENCY'), 'search shard fetches must have an explicit concurrency limit')
assert(sw.includes('mapWithConcurrency('), 'search shard fetches must use the concurrency limiter')

class MemoryCache {
  constructor(paths) {
    this.entries = new Map(paths.map((path) => {
      const request = new Request(new URL(path, 'https://example.test').href)
      return [request.url, request]
    }))
  }

  async keys() {
    return Array.from(this.entries.values())
  }

  async delete(request) {
    const url = typeof request === 'string' ? new URL(request, 'https://example.test').href : request.url
    const existed = this.entries.has(url)
    this.entries.delete(url)
    return existed
  }

  has(path) {
    return this.entries.has(new URL(path, 'https://example.test').href)
  }
}

async function runShellInvalidationBehaviorCheck(scope, initialPaths) {
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
    self: {
      location: { origin: 'https://example.test', href: 'https://example.test/sw.js?build=test-build' },
      addEventListener() {},
      skipWaiting: async () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      crypto: { subtle: { digest: async () => new ArrayBuffer(32) } }
    }
  }
  context.__cache = new MemoryCache(initialPaths)
  context.caches = {
    open: async () => context.__cache,
    keys: async () => [],
    delete: async () => true
  }
  const sandbox = vm.createContext(context)
  vm.runInContext(sw, sandbox, { filename: 'sw.js' })
  const result = await vm.runInContext(`invalidateShellCache(${JSON.stringify(scope)})`, sandbox)
  return { result, cache: context.__cache }
}

{
  const { result, cache } = await runShellInvalidationBehaviorCheck('about', ['/', '/about', '/archive'])
  assert(result.deletedCount === 1, 'about scope must delete exactly one shell entry')
  assert(!cache.has('/about'), 'about scope must delete /about shell')
  assert(cache.has('/'), 'about scope must preserve home shell')
  assert(cache.has('/archive'), 'about scope must preserve archive shell')
}

{
  const { result, cache } = await runShellInvalidationBehaviorCheck('seo', ['/', '/about', '/archive'])
  assert(result.deletedCount === 3, 'seo scope must retain global shell invalidation semantics')
  assert(!cache.has('/') && !cache.has('/about') && !cache.has('/archive'), 'seo scope must clear all shell entries')
}

{
  const { result, cache } = await runShellInvalidationBehaviorCheck('unknown-scope', ['/', '/about', '/archive'])
  assert(result.deletedCount === 3, 'unknown shell invalidation scope must fall back to global deletion')
  assert(!cache.has('/') && !cache.has('/about') && !cache.has('/archive'), 'unknown shell invalidation scope must clear all shell entries')
}

console.log('[check-pwa-offline-policy] ok')
