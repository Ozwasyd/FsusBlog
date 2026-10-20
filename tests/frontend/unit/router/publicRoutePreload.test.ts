import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import type {
  PublicAotBootstrapPayloadFor,
  PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes'
import {
  consumePublicRouteSeed,
  peekPublicRouteSeed,
  putPublicRouteSeed,
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'
import {
  computePublicNavigationSnapshotPayloadHash,
  createPublicRoutePrewarmer,
  resolvePublicRoutePrewarmTarget,
  type PublicNavigationSnapshotEnvelope
} from '@/router/publicRoutePreload'
import { getLocaleDescriptor, LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import {
  activateLocaleRuntime,
  activeLocale,
  resetLocaleRuntimeForTests,
  type SupportedLocale
} from '@/locales'
import {
  computePublicSeoHeadDigest,
  resetPublicSeoHeadForTests,
  type PublicSeoHeadModel
} from '@/router/publicSeoHead'

const RENDER_TIMESTAMP = '2026-06-18T00:00:00.000Z'

function deferredMarker() {
  let mark!: () => void
  let started = false
  const promise = new Promise<void>((resolve) => {
    mark = () => {
      started = true
      resolve()
    }
  })
  return {
    get started() {
      return started
    },
    mark: () => mark(),
    promise
  }
}

function snapshotBytes(envelope: PublicNavigationSnapshotEnvelope): Uint8Array<ArrayBuffer> {
  return base64UrlToBytes(encodePublicAotPayload(envelope))
}

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function createArchiveEnvelope(
  renderLocale: SupportedLocale = 'zh-CN',
  renderTimestamp: string | null = RENDER_TIMESTAMP
): Promise<PublicNavigationSnapshotEnvelope> {
  const localeDescriptor = getLocaleDescriptor(renderLocale)
  const bootstrap = {
    kind: 'Archive',
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    ...(renderTimestamp === null ? {} : { renderTimestamp }),
    renderLocale,
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    articles: [],
    total: 0
  } as PublicAotBootstrapPayloadFor<'Archive'>
  const hydration = {
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    ...(renderTimestamp === null ? {} : { renderTimestamp }),
    renderLocale,
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    title: 'Archive'
  } as PublicHydrationPayloadFor<'Archive'>

  const unsignedHead = {
    schema: 'fsusblog.public-seo-head',
    version: 1,
    digest: '',
    documentTitle: 'Archive - FsusBlog',
    description: 'Archive description',
    canonicalUrl: 'http://127.0.0.1/archive',
    publicOrigin: 'http://127.0.0.1',
    robots: 'index,follow',
    locale: localeDescriptor.documentLanguage,
    pageType: 'Archive',
    pageEntityId: 'http://127.0.0.1/archive',
    openGraph: {
      title: 'Archive - FsusBlog',
      description: 'Archive description',
      type: 'website',
      url: 'http://127.0.0.1/archive',
      locale: localeDescriptor.openGraphLocale,
      imageUrl: null
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Archive - FsusBlog',
      description: 'Archive description',
      imageUrl: null
    },
    jsonLdGraph: '{"@context":"https://schema.org","@graph":[{"@type":"WebPage","url":"http://127.0.0.1/archive"}]}',
    articlePublishedAtUtc: null,
    articleModifiedAtUtc: null,
    articleAuthor: null,
    articleImageUrl: null
  } satisfies PublicSeoHeadModel
  const seoHead = {
    ...unsignedHead,
    digest: await computePublicSeoHeadDigest(unsignedHead)
  }

  const envelope: PublicNavigationSnapshotEnvelope = {
    kind: 'public-navigation-snapshot',
    pageKind: 'Archive',
    pageId: 4,
    routeKey: 'archive',
    path: '/archive',
    queryString: '',
    fullPath: '/archive',
    canonicalPath: '/archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    frontendAssetVersion: 'test-assets',
    renderLocale,
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    payloadHash: '',
    generatedAtUtc: '2026-06-18T00:00:00.0000000Z',
    bootstrapPayload: encodePublicAotPayload(bootstrap),
    hydrationPropsPayload: encodePublicAotPayload(hydration),
    seoHead
  }
  return {
    ...envelope,
    payloadHash: await computePublicNavigationSnapshotPayloadHash(envelope)
  }
}

async function createHomeEnvelope(): Promise<PublicNavigationSnapshotEnvelope> {
  const bootstrap = {
    kind: 'Home',
    pageKind: 'Home',
    routeKey: 'home',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    renderTimestamp: RENDER_TIMESTAMP,
    renderLocale: 'zh-CN',
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    articles: [],
    featuredArticles: [],
    hotArticles: [],
    total: 0
  } as PublicAotBootstrapPayloadFor<'Home'>
  const hydration = {
    pageKind: 'Home',
    routeKey: 'home',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    renderTimestamp: RENDER_TIMESTAMP,
    renderLocale: 'zh-CN',
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    title: 'Home'
  } as PublicHydrationPayloadFor<'Home'>
  const unsignedHead = {
    schema: 'fsusblog.public-seo-head',
    version: 1,
    digest: '',
    documentTitle: 'Home - FsusBlog',
    description: 'Home description',
    canonicalUrl: 'http://127.0.0.1/',
    publicOrigin: 'http://127.0.0.1',
    robots: 'index,follow',
    locale: 'zh-CN',
    pageType: 'Home',
    pageEntityId: 'http://127.0.0.1/',
    openGraph: {
      title: 'Home - FsusBlog',
      description: 'Home description',
      type: 'website',
      url: 'http://127.0.0.1/',
      locale: 'zh_CN',
      imageUrl: null
    },
    twitter: {
      card: 'summary_large_image',
      title: 'Home - FsusBlog',
      description: 'Home description',
      imageUrl: null
    },
    jsonLdGraph: '{"@context":"https://schema.org","@graph":[{"@type":"WebPage","url":"http://127.0.0.1/"}]}',
    articlePublishedAtUtc: null,
    articleModifiedAtUtc: null,
    articleAuthor: null,
    articleImageUrl: null
  } satisfies PublicSeoHeadModel
  const seoHead = {
    ...unsignedHead,
    digest: await computePublicSeoHeadDigest(unsignedHead)
  }
  const envelope: PublicNavigationSnapshotEnvelope = {
    kind: 'public-navigation-snapshot',
    pageKind: 'Home',
    pageId: 1,
    routeKey: 'home',
    path: '/',
    queryString: '',
    fullPath: '/',
    canonicalPath: '/',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    frontendAssetVersion: 'test-assets',
    renderLocale: 'zh-CN',
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    payloadHash: '',
    generatedAtUtc: '2026-06-18T00:00:00.0000000Z',
    bootstrapPayload: encodePublicAotPayload(bootstrap),
    hydrationPropsPayload: encodePublicAotPayload(hydration),
    seoHead
  }
  return {
    ...envelope,
    payloadHash: await computePublicNavigationSnapshotPayloadHash(envelope)
  }
}

describe('public route prewarm', () => {
  beforeEach(() => {
    resetPublicRouteSeedStoreForTests()
    resetPublicSeoHeadForTests()
    resetLocaleRuntimeForTests()
  })

  it('prepares the exact snapshot locale before committing the route seed', async () => {
    const envelope = await createArchiveEnvelope('ja-JP')
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(activeLocale.value).toBe('ja-JP')
  })

  it('binds the server-resolved document locale to the navigation snapshot request', async () => {
    document.documentElement.lang = 'zh-CN'
    const envelope = await createArchiveEnvelope('zh-CN')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      snapshotBytes(envelope),
      { status: 200 }
    ))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    try {
      await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
        status: 'ready',
        seedReady: true
      })
      const request = fetchSpy.mock.calls[0]
      expect(new Headers(request?.[1]?.headers).get('Accept-Language')).toBe('zh-CN')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('accepts a matching staged route-locale snapshot without a nested runtime commit', async () => {
    await activateLocaleRuntime('zh-CN', ['common', 'layout', 'public'])
    const envelope = await createArchiveEnvelope('ja-JP')
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', {
      reason: 'atomic-navigation',
      preparedLocaleSnapshot: {
        locale: 'ja-JP',
        domains: ['common', 'layout', 'public', 'security']
      }
    })).resolves.toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(activeLocale.value).toBe('zh-CN')
  })

  it('rejects a staged route-locale snapshot that omits a required domain', async () => {
    const envelope = await createArchiveEnvelope('ja-JP')
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', {
      reason: 'atomic-navigation',
      preparedLocaleSnapshot: {
        locale: 'ja-JP',
        domains: ['common', 'layout']
      }
    })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false,
      error: 'route-snapshot-decode-failed: navigation snapshot locale domains missing:public,security'
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
  })

  it('rejects a tampered locale identity before committing a route seed', async () => {
    const envelope: PublicNavigationSnapshotEnvelope = {
      ...await createArchiveEnvelope(),
      renderLocale: 'ja-JP'
    }
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false
    })
    expect(activeLocale.value).toBe('zh-CN')
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
  })

  it.each([
    ['missing', null],
    ['blank', ''],
    ['invalid', 'not-a-date'],
    ['noncanonical', '2026-06-18T00:00:00Z']
  ])('rejects a self-consistent snapshot with a %s render timestamp before committing any seed', async (
    _label,
    renderTimestamp
  ) => {
    const envelope = await createArchiveEnvelope('zh-CN', renderTimestamp)
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false
    })
    expect(consumePublicRouteSeed('Home', { fullPath: '/' })).toBeNull()
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
    expect(consumePublicRouteSeed('Filter', { routeKey: 'category:7' })).toBeNull()
  })

  it('rejects a tampered snapshot payload hash before committing a route seed', async () => {
    const envelope: PublicNavigationSnapshotEnvelope = {
      ...await createArchiveEnvelope(),
      payloadHash: '0'.repeat(64)
    }
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
  })

  it('rejects a self-consistent Home snapshot sent to the Archive route before committing a seed', async () => {
    const envelope = await createHomeEnvelope()
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
    expect(consumePublicRouteSeed('Home', { fullPath: '/' })).toBeNull()
  })

  it('deduplicates route component and snapshot seed work for the same target while in-flight', async () => {
    const events: string[] = []
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const envelope = await createArchiveEnvelope()
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent,
        criticalStyleHrefs: ['/assets/archive.css']
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name)
    })

    const first = prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })
    const second = prewarm.prewarm('/archive', { reason: 'focus', nowMs: 1_001 })

    expect(first).toBe(second)
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({
      status: 'ready',
      routeComponentReady: true,
      seedReady: true,
      routeKind: 'Archive'
    })
    expect(secondResult).toBe(firstResult)
    expect(loadArchiveComponent).toHaveBeenCalledTimes(1)
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'public_route_prewarm_start',
      'public_route_prewarm_inflight_hit',
      'public_route_prewarm_ready'
    ])

    const seed = consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_002 })
    expect(seed).toEqual({
      bootstrap: decodePublicAotPayload(envelope.bootstrapPayload),
      hydration: decodePublicAotPayload(envelope.hydrationPropsPayload)
    } satisfies PublicPageSeed<'Archive'>)
  })

  it('reuses currently consumable seed/head as artifact-ready without a historical ready Promise', async () => {
    const events: string[] = []
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const envelope = await createArchiveEnvelope()
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name),
      lifetimeSignal: () => new AbortController().signal
    })

    const firstResult = await prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })
    expect(firstResult.status).toBe('ready')
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)

    const secondResult = await prewarm.prewarm('/archive', { reason: 'focus', nowMs: 1_001 })
    expect(secondResult).toMatchObject({
      status: 'ready',
      seedReady: true,
      routeComponentReady: true
    })
    expect(secondResult).not.toBe(firstResult)
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(loadArchiveComponent).toHaveBeenCalledTimes(1)
    expect(events).toContain('public_route_prewarm_artifact_ready')
    expect(events).not.toContain('public_route_prewarm_hit')
    expect(peekPublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_002 })).not.toBeNull()
  })

  it('re-runs the snapshot producer after the one-shot seed is consumed', async () => {
    const events: string[] = []
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const firstEnvelope = await createArchiveEnvelope()
    const secondEnvelope = {
      ...firstEnvelope,
      generatedAtUtc: '2026-06-18T00:00:01.0000000Z',
      payloadHash: ''
    }
    secondEnvelope.payloadHash = await computePublicNavigationSnapshotPayloadHash(secondEnvelope)
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce(snapshotBytes(firstEnvelope))
      .mockResolvedValueOnce(snapshotBytes(secondEnvelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name),
      lifetimeSignal: () => new AbortController().signal
    })

    const firstResult = await prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })
    expect(firstResult.status).toBe('ready')
    const firstSeed = consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })
    expect(firstSeed).not.toBeNull()
    expect(peekPublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()

    const secondResult = await prewarm.prewarm('/archive', { reason: 'atomic-navigation', nowMs: 1_002 })
    expect(secondResult).toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(secondResult).not.toBe(firstResult)
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(loadArchiveComponent).toHaveBeenCalledTimes(2)
    expect(events.filter((name) => name === 'public_route_prewarm_start')).toHaveLength(2)
    expect(events).not.toContain('public_route_prewarm_artifact_ready')

    const secondSeed = consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_003 })
    expect(secondSeed).not.toBeNull()
    expect(secondSeed).not.toBe(firstSeed)
  })

  it('does not treat expired seed TTL as historical ready', async () => {
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const envelope = await createArchiveEnvelope()
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })).resolves.toMatchObject({
      status: 'ready'
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)

    // Default seed TTL is 5 minutes; read past expiry must re-fetch.
    await expect(prewarm.prewarm('/archive', {
      reason: 'focus',
      nowMs: 1_000 + (5 * 60 * 1_000) + 1
    })).resolves.toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(loadArchiveComponent).toHaveBeenCalledTimes(2)
  })

  it('does not treat a renderer-version mismatched seed as historical ready', async () => {
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const envelope = await createArchiveEnvelope()
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })).resolves.toMatchObject({
      status: 'ready'
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)

    // Simulate a build/renderer identity cutover leaving a stale seed entry.
    const staleSeed = consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })
    expect(staleSeed).not.toBeNull()
    putPublicRouteSeed({
      kind: 'Archive',
      fullPath: '/archive',
      routeKey: 'archive',
      seed: staleSeed!,
      rendererVersion: 'stale-renderer@test',
      nowMs: 1_001
    })

    await expect(prewarm.prewarm('/archive', { reason: 'focus', nowMs: 1_002 })).resolves.toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
  })

  it('allows immediate retry after cancel without resurrecting a consumed attempt', async () => {
    const events: string[] = []
    const envelope = await createArchiveEnvelope()
    let attempt = 0
    let markFetchParked!: () => void
    const fetchParked = new Promise<void>((resolve) => {
      markFetchParked = resolve
    })
    const fetchSnapshot = vi.fn((_target: URL, signal: AbortSignal) => {
      attempt += 1
      if (attempt === 1) {
        markFetchParked()
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }

      return Promise.resolve(snapshotBytes(envelope))
    })
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name),
      lifetimeSignal: () => new AbortController().signal
    })

    const controller = new AbortController()
    const first = prewarm.prewarm('/archive', {
      reason: 'pointerenter',
      signal: controller.signal,
      nowMs: 1_000
    })
    await fetchParked
    controller.abort('test-cancel')
    await expect(first).resolves.toMatchObject({
      status: 'cancelled',
      seedReady: false
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()

    await expect(prewarm.prewarm('/archive', { reason: 'focus', nowMs: 1_002 })).resolves.toMatchObject({
      status: 'ready',
      seedReady: true
    })
    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(events).toContain('public_route_prewarm_cancel')
    expect(events).toContain('public_route_prewarm_ready')
  })

  it('does not commit seed/head when a late snapshot arrives after abort', async () => {
    const envelope = await createArchiveEnvelope()
    let resolveComponent!: () => void
    let resolveSnapshot!: (value: Uint8Array) => void
    const componentStarted = deferredMarker()
    const snapshotStarted = deferredMarker()
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(() => {
          componentStarted.mark()
          return new Promise((resolve) => {
            resolveComponent = () => resolve({ default: {} })
          })
        })
      }],
      fetchNavigationSnapshot: vi.fn((_target, signal) => {
        snapshotStarted.mark()
        return new Promise<Uint8Array>((resolve, reject) => {
          resolveSnapshot = resolve
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
      }),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    const controller = new AbortController()
    const task = prewarm.prewarm('/archive', {
      reason: 'atomic-navigation',
      signal: controller.signal,
      nowMs: 1_000
    })
    await Promise.all([componentStarted.promise, snapshotStarted.promise])

    // Snapshot network returns first; abort before component finishes so commit is skipped.
    resolveSnapshot(snapshotBytes(envelope))
    await Promise.resolve()
    controller.abort('late-abort')
    resolveComponent()

    await expect(task).resolves.toMatchObject({
      status: 'cancelled',
      seedReady: false
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('cancels pending work when the public shell lifetime is aborted', async () => {
    const events: string[] = []
    const controller = new AbortController()
    let markFetchStarted: () => void = () => {}
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve
    })
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn((_target, signal) => new Promise<Uint8Array>((resolve, reject) => {
        markFetchStarted()
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })),
      emitTelemetry: (name) => events.push(name)
    })

    const task = prewarm.prewarm('/archive', {
      reason: 'idle',
      signal: controller.signal,
      nowMs: 1_000
    })
    await fetchStarted
    controller.abort('test')

    await expect(task).resolves.toMatchObject({
      status: 'cancelled',
      routeComponentReady: true,
      seedReady: false
    })
    expect(events).toContain('public_route_prewarm_cancel')
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('evicts failed component work so a later prewarm can retry', async () => {
    const envelope = await createArchiveEnvelope()
    const loadArchiveComponent = vi.fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValue({ default: {} })
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: loadArchiveComponent
      }],
      fetchNavigationSnapshot: fetchSnapshot,
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'pointerenter' })).resolves.toMatchObject({
      status: 'failure',
      routeComponentReady: false,
      seedReady: false,
      error: 'route-component-failed: chunk unavailable'
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
    await expect(prewarm.prewarm('/archive', { reason: 'focus' })).resolves.toMatchObject({
      status: 'ready',
      routeComponentReady: true,
      seedReady: true
    })
    expect(loadArchiveComponent).toHaveBeenCalledTimes(2)
    // Component and snapshot start in parallel, so a failed first attempt still
    // starts a snapshot fetch (often aborted) and the retry starts another.
    expect(fetchSnapshot.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('starts component import and snapshot fetch before either resolves', async () => {
    const events: string[] = []
    let resolveComponent!: () => void
    let resolveSnapshot!: (value: Uint8Array) => void
    const componentStarted = deferredMarker()
    const snapshotStarted = deferredMarker()
    const envelope = await createArchiveEnvelope()
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(() => {
          componentStarted.mark()
          return new Promise((resolve) => {
            resolveComponent = () => resolve({ default: {} })
          })
        })
      }],
      fetchNavigationSnapshot: vi.fn(() => {
        snapshotStarted.mark()
        return new Promise<Uint8Array>((resolve) => {
          resolveSnapshot = resolve
        })
      }),
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name),
      lifetimeSignal: () => new AbortController().signal
    })

    const task = prewarm.prewarm('/archive', { reason: 'atomic-navigation', nowMs: 1_000 })
    await Promise.all([componentStarted.promise, snapshotStarted.promise])
    // Promise barrier: both producers must have started before either resolves.
    expect(componentStarted.started && snapshotStarted.started).toBe(true)

    resolveComponent()
    resolveSnapshot(snapshotBytes(envelope))
    await expect(task).resolves.toMatchObject({
      status: 'ready',
      routeComponentReady: true,
      seedReady: true
    })
    expect(events).toContain('public_route_prewarm_ready')
  })

  it('times out when a non-abortable component import never settles', async () => {
    const events: string[] = []
    const envelope = await createArchiveEnvelope()
    const componentStarted = deferredMarker()
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(() => {
          componentStarted.mark()
          return new Promise(() => {})
        })
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      emitTelemetry: (name) => events.push(name),
      lifetimeSignal: () => new AbortController().signal,
      timeoutMs: 10
    })

    const task = prewarm.prewarm('/archive', {
      reason: 'atomic-navigation',
      nowMs: 1_000
    })
    await componentStarted.promise

    await expect(task).resolves.toMatchObject({
      status: 'timeout',
      routeComponentReady: false,
      seedReady: false
    })
    expect(events).toContain('public_route_prewarm_timeout')
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('does not leave a consumable seed when the component producer fails after snapshot starts', async () => {
    const envelope = await createArchiveEnvelope()
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => {
          throw new Error('chunk-broken')
        })
      }],
      fetchNavigationSnapshot: vi.fn(async () => snapshotBytes(envelope)),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'pointerenter', nowMs: 1_000 })).resolves.toMatchObject({
      status: 'failure',
      seedReady: false,
      error: 'route-component-failed: chunk-broken'
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('does not return ready when snapshot fails after the component is cached', async () => {
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
        path: '/archive',
        match: (url) => url.pathname === '/archive',
        preloadComponent: vi.fn(async () => ({ default: {} }))
      }],
      fetchNavigationSnapshot: vi.fn(async () => {
        throw new Error('snapshot-http-500')
      }),
      preloadStyle: vi.fn(async () => {}),
      lifetimeSignal: () => new AbortController().signal
    })

    await expect(prewarm.prewarm('/archive', { reason: 'atomic-navigation' })).resolves.toMatchObject({
      status: 'failure',
      routeComponentReady: true,
      seedReady: false,
      error: 'route-snapshot-failed: snapshot-http-500'
    })
    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
  })

  it('resolves only same-origin unmodified public route anchors', () => {
    const anchor = document.createElement('a')
    anchor.href = `${window.location.origin}/archive`

    expect(resolvePublicRoutePrewarmTarget(anchor)).toBe('/archive')
    expect(resolvePublicRoutePrewarmTarget(anchor, {
      button: 0,
      ctrlKey: true,
      defaultPrevented: false,
      metaKey: false,
      shiftKey: false,
      altKey: false
    } as unknown as Event)).toBeNull()

    anchor.href = 'https://example.test/archive'
    expect(resolvePublicRoutePrewarmTarget(anchor)).toBeNull()

    anchor.href = 'http://127.0.0.1/api/public/navigation-snapshot.aeds'
    expect(resolvePublicRoutePrewarmTarget(anchor)).toBeNull()
  })
})
