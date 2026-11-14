import crypto from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { test, expect } from '@playwright/test'

const OLD_RELEASE = 'release-20260710-aaaaaa'
const NEW_RELEASE = 'release-20260711-bbbbbb'

type Phase = 'old' | 'new' | 'rollback'

interface RequestObservation {
  path: string
  requestedPhase: Phase
  responsePhase: Phase
  status: number
}

function releasePath(releaseId: string, relativePath: string): string {
  return `/release-assets/${releaseId}/${relativePath}`
}

function sha256(payload: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`
}

test.describe('release asset compatibility drill', () => {
  test.setTimeout(60_000)

  test('keeps a delayed N-1 page, old Service Worker cache and both backend directions alive through switch and GC', async ({ page, request, browser, browserName }) => {
    test.skip(browserName === 'webkit', 'WebKit Service Worker lifecycle is not deterministic in the release drill harness')

    const oldPaths = {
      index: releasePath(OLD_RELEASE, 'index.html'),
      javascript: releasePath(OLD_RELEASE, 'assets/app.aaaaaa.js'),
      stylesheet: releasePath(OLD_RELEASE, 'assets/app.aaaaaa.css'),
      wasm: releasePath(OLD_RELEASE, 'wasm/aeds.aaaaaa.wasm'),
      font: releasePath(OLD_RELEASE, 'fonts/blog.aaaaaa.woff2'),
      serviceWorker: `${releasePath(OLD_RELEASE, 'sw.js')}?build=${OLD_RELEASE}`
    }
    const newPaths = {
      index: releasePath(NEW_RELEASE, 'index.html'),
      javascript: releasePath(NEW_RELEASE, 'assets/app.bbbbbb.js')
    }
    const oldPayloads = new Map<string, Buffer>([
      [oldPaths.stylesheet, Buffer.from('@font-face{font-family:BlogFixture;src:url("../fonts/blog.aaaaaa.woff2")}body{font-family:BlogFixture,sans-serif}')],
      [oldPaths.wasm, Buffer.from('N-1 wasm bytes retained by release')],
      [oldPaths.font, Buffer.from('N-1 font bytes retained by release')]
    ])
    const observations: RequestObservation[] = []
    const consoleErrors: string[] = []
    const networkFailures: string[] = []
    const httpFailures: string[] = []
    page.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()) })
    page.on('pageerror', error => consoleErrors.push(error.message))
    page.on('requestfailed', request => networkFailures.push(`${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`))
    page.on('response', response => {
      if (response.status() >= 400) httpFailures.push(`${response.status()}:${response.url()}`)
    })
    const delayedRequestArrivals = new Set<string>()
    let oldServiceWorkerArrived = false
    const compatibilityCalls: Array<{ client: string | undefined, server: string }> = []
    let phase: Phase = 'old'
    let gcApplied = false
    let rejectOldAssetNetwork = false
    let releaseDelayedRequests!: () => void
    const delayedRequestGate = new Promise<void>((resolve) => {
      releaseDelayedRequests = () => resolve()
    })

    const oldApplication = Buffer.from(`
      const paths = ${JSON.stringify([oldPaths.javascript, oldPaths.stylesheet, oldPaths.wasm, oldPaths.font])}
      const digest = async (resource) => {
        const response = await fetch(resource)
        if (!response.ok) throw new Error(resource + ' returned ' + response.status)
        const bytes = await response.arrayBuffer()
        const hash = await crypto.subtle.digest('SHA-256', bytes)
        return 'sha256:' + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
      }
      const [hashes, backend] = await Promise.all([
        Promise.all(paths.map(async resource => [resource, await digest(resource)])),
        fetch('/api/compatibility', { headers: { 'x-client-release': '${OLD_RELEASE}' } }).then(async response => ({
          status: response.status,
          releaseId: response.headers.get('x-fsus-release-id'),
          body: await response.json()
        }))
      ])
      globalThis.__FSUS_ASSET_DRILL__ = { releaseId: '${OLD_RELEASE}', hashes: Object.fromEntries(hashes), backend }
    `)
    oldPayloads.set(oldPaths.javascript, oldApplication)
    const newApplication = Buffer.from(`
      const response = await fetch('/api/compatibility', { headers: { 'x-client-release': '${NEW_RELEASE}' } })
      globalThis.__FSUS_ROLLBACK_DRILL__ = {
        status: response.status,
        releaseId: response.headers.get('x-fsus-release-id'),
        body: await response.json()
      }
    `)
    const oldIndex = Buffer.from(`<!doctype html>
      <html><head>
        <meta charset="utf-8">
        <link rel="icon" href="data:,">
        <script>
          globalThis.__FSUS_INDEX_PHASE__ = 'before-switch'
          navigator.serviceWorker.register('${oldPaths.serviceWorker}', { scope: '/', updateViaCache: 'none' })
          globalThis.__FSUS_PRE_SWITCH_BINARY__ = Promise.all([
            '${oldPaths.wasm}',
            '${oldPaths.font}'
          ].map(path => fetch(path).then(async response => ({ path, status: response.status, bytes: (await response.arrayBuffer()).byteLength }))))
        </script>
        <link rel="stylesheet" href="${oldPaths.stylesheet}">
        <script type="module" src="${oldPaths.javascript}"></script>
      </head><body><main id="old-release">N-1 page</main></body></html>`)
    const newIndex = Buffer.from(`<!doctype html>
      <html><head><meta charset="utf-8"><link rel="icon" href="data:,"><script type="module" src="${newPaths.javascript}"></script></head>
      <body><main id="new-release">N page after rollback</main></body></html>`)
    const serviceWorker = Buffer.from(`
      const CACHE = 'fsus-static-v4:${OLD_RELEASE}'
      const STATIC = /\\.(?:css|js|mjs|wasm|woff2?|ttf|otf|eot)$/i
      self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
      self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
      self.addEventListener('fetch', event => {
        const url = new URL(event.request.url)
        if (event.request.method !== 'GET' || !url.pathname.startsWith('/release-assets/${OLD_RELEASE}/') || !STATIC.test(url.pathname)) return
        event.respondWith(caches.open(CACHE).then(async cache => {
          const cached = await cache.match(event.request)
          if (cached) return cached
          const response = await fetch(event.request)
          if (response.ok) await cache.put(event.request, response.clone())
          return response
        }))
      })
    `)

    const server = http.createServer((incoming, outgoing) => {
      void serve(incoming, outgoing).catch((error: unknown) => {
        if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain' })
        outgoing.end(error instanceof Error ? error.message : String(error))
      })
    })

    async function serve(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
      const requestUrl = new URL(incoming.url ?? '/', 'http://127.0.0.1')
      const requestedPhase = phase
      const requestPath = `${requestUrl.pathname}${requestUrl.search}`

      if (requestUrl.pathname === '/api/compatibility') {
        const serverRelease = phase === 'rollback' ? OLD_RELEASE : NEW_RELEASE
        const clientRelease = Array.isArray(incoming.headers['x-client-release'])
          ? incoming.headers['x-client-release'][0]
          : incoming.headers['x-client-release']
        compatibilityCalls.push({ client: clientRelease, server: serverRelease })
        send(outgoing, 200, Buffer.from(JSON.stringify({ clientRelease, serverRelease })), {
          'content-type': 'application/json',
          'x-fsus-release-id': serverRelease
        })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }

      if (requestUrl.pathname === oldPaths.index) {
        send(outgoing, 200, oldIndex, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }
      if (requestUrl.pathname === newPaths.index) {
        send(outgoing, 200, newIndex, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }
      if (requestUrl.pathname === newPaths.javascript) {
        send(outgoing, 200, newApplication, { 'content-type': 'text/javascript; charset=utf-8' })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }
      if (requestUrl.pathname === releasePath(OLD_RELEASE, 'sw.js')) {
        oldServiceWorkerArrived = true
        send(outgoing, 200, serviceWorker, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'service-worker-allowed': '/'
        })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }

      const payload = oldPayloads.get(requestUrl.pathname)
      if (payload) {
        if (requestedPhase === 'old' && [oldPaths.javascript, oldPaths.stylesheet, oldPaths.wasm, oldPaths.font].includes(requestUrl.pathname)) {
          delayedRequestArrivals.add(requestUrl.pathname)
          await delayedRequestGate
        }
        if (rejectOldAssetNetwork) {
          send(outgoing, 404, Buffer.from('network copy intentionally unavailable'), { 'content-type': 'text/plain' })
          observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 404 })
          return
        }
        send(outgoing, 200, payload, {
          'content-type': mediaType(requestUrl.pathname),
          'cache-control': 'public,max-age=31536000,immutable',
          'x-fsus-frontend-build': OLD_RELEASE,
          'x-fsus-gc-state': gcApplied ? 'retained-after-gc' : 'retained'
        })
        observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 200 })
        return
      }

      send(outgoing, 404, Buffer.from('not found'), { 'content-type': 'text/plain' })
      observations.push({ path: requestPath, requestedPhase, responsePhase: phase, status: 404 })
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('release asset fixture server did not expose a TCP address')
    const origin = `http://127.0.0.1:${address.port}`

    try {
      const navigation = page.goto(`${origin}${oldPaths.index}`, { waitUntil: 'commit' })
      await navigation
      await expect.poll(() => [...delayedRequestArrivals].sort()).toEqual(
        [oldPaths.javascript, oldPaths.stylesheet, oldPaths.wasm, oldPaths.font].sort())
      await expect.poll(() => oldServiceWorkerArrived).toBe(true)

      phase = 'new'
      releaseDelayedRequests?.()
      await expect(page.locator('#old-release')).toBeVisible()
      await expect.poll(async () => await page.evaluate(() => Boolean(
        (globalThis as typeof globalThis & { __FSUS_ASSET_DRILL__?: unknown }).__FSUS_ASSET_DRILL__
      ))).toBe(true)

      const delayed = observations.filter(item =>
        item.requestedPhase === 'old'
        && item.responsePhase === 'new'
        && [oldPaths.javascript, oldPaths.stylesheet, oldPaths.wasm, oldPaths.font].includes(item.path))
      expect(delayed.map(item => item.path).sort()).toEqual(
        [oldPaths.javascript, oldPaths.stylesheet, oldPaths.wasm, oldPaths.font].sort())
      expect(observations.some(item => item.path === oldPaths.index && item.responsePhase === 'old')).toBe(true)

      const browserEvidence = await page.evaluate(() => (
        (globalThis as typeof globalThis & {
          __FSUS_ASSET_DRILL__?: {
            releaseId: string
            hashes: Record<string, string>
            backend: { status: number, releaseId: string, body: { clientRelease: string, serverRelease: string } }
          }
        }).__FSUS_ASSET_DRILL__
      ))
      expect(browserEvidence?.releaseId).toBe(OLD_RELEASE)
      expect(browserEvidence?.backend).toEqual({
        status: 200,
        releaseId: NEW_RELEASE,
        body: { clientRelease: OLD_RELEASE, serverRelease: NEW_RELEASE }
      })
      for (const [assetPath, payload] of oldPayloads) {
        expect(browserEvidence?.hashes[assetPath], `${assetPath} content hash`).toBe(sha256(payload))
      }

      await page.evaluate(async () => {
        await navigator.serviceWorker.ready
      })
      await expect.poll(async () => await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
      await page.evaluate(async (paths) => {
        await Promise.all(paths.map(async assetPath => {
          const response = await fetch(assetPath)
          if (!response.ok) throw new Error(`${assetPath} cache warmup returned ${response.status}`)
          await response.arrayBuffer()
        }))
      }, [...oldPayloads.keys()])
      const cacheState = await page.evaluate(async () => ({
        controller: Boolean(navigator.serviceWorker.controller),
        names: await caches.keys(),
        cached: await Promise.all((await caches.keys()).map(async name => ({
          name,
          keys: (await (await caches.open(name)).keys()).map(item => new URL(item.url).pathname)
        })))
      }))
      expect(cacheState.controller).toBe(true)
      expect(cacheState.names).toContain(`fsus-static-v4:${OLD_RELEASE}`)
      expect(cacheState.cached.flatMap(cache => cache.keys)).toEqual(expect.arrayContaining([...oldPayloads.keys()]))

      const networkCountBeforeCacheRead = observations.length
      rejectOldAssetNetwork = true
      const cachedHash = await page.evaluate(async (assetPath) => {
        const response = await fetch(assetPath)
        const bytes = await response.arrayBuffer()
        const hash = await crypto.subtle.digest('SHA-256', bytes)
        return {
          status: response.status,
          sha256: `sha256:${[...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')}`
        }
      }, oldPaths.wasm)
      expect(cachedHash).toEqual({ status: 200, sha256: sha256(oldPayloads.get(oldPaths.wasm)!) })
      expect(observations.length).toBe(networkCountBeforeCacheRead)
      rejectOldAssetNetwork = false

      gcApplied = true
      for (const [assetPath, payload] of oldPayloads) {
        const response = await request.get(`${origin}${assetPath}`, { headers: { 'cache-control': 'no-cache' } })
        expect(response.status(), `${assetPath} after GC`).toBe(200)
        expect(response.headers()['x-fsus-gc-state']).toBe('retained-after-gc')
        expect(sha256(Buffer.from(await response.body())), `${assetPath} after GC hash`).toBe(sha256(payload))
      }
      expect(observations.filter(item => item.path.startsWith(`/release-assets/${OLD_RELEASE}/`) && item.status === 404)).toEqual([])

      phase = 'rollback'
      await page.goto(`${origin}${newPaths.index}`, { waitUntil: 'domcontentloaded' })
      await expect(page.locator('#new-release')).toBeVisible()
      await expect.poll(async () => await page.evaluate(() => Boolean(
        (globalThis as typeof globalThis & { __FSUS_ROLLBACK_DRILL__?: unknown }).__FSUS_ROLLBACK_DRILL__
      ))).toBe(true)
      const rollbackEvidence = await page.evaluate(() => (
        (globalThis as typeof globalThis & {
          __FSUS_ROLLBACK_DRILL__?: {
            status: number
            releaseId: string
            body: { clientRelease: string, serverRelease: string }
          }
        }).__FSUS_ROLLBACK_DRILL__
      ))
      expect(rollbackEvidence).toEqual({
        status: 200,
        releaseId: OLD_RELEASE,
        body: { clientRelease: NEW_RELEASE, serverRelease: OLD_RELEASE }
      })
      expect(compatibilityCalls).toEqual(expect.arrayContaining([
        { client: OLD_RELEASE, server: NEW_RELEASE },
        { client: NEW_RELEASE, server: OLD_RELEASE }
      ]))
      expect(browser.version()).not.toBe('')
      expect(observations.filter(item => item.status >= 400)).toEqual([])
      expect(httpFailures).toEqual([])
      expect(consoleErrors).toEqual([])
      expect(networkFailures).toEqual([])
    } finally {
      releaseDelayedRequests?.()
      await page.context().clearCookies()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})

function send(response: ServerResponse, status: number, payload: Buffer, headers: Record<string, string>): void {
  response.writeHead(status, { ...headers, 'content-length': String(payload.byteLength) })
  response.end(payload)
}

function mediaType(assetPath: string): string {
  if (assetPath.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (assetPath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (assetPath.endsWith('.wasm')) return 'application/wasm'
  if (assetPath.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}
