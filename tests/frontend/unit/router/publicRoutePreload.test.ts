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
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'
import {
  computePublicNavigationSnapshotPayloadHash,
  createPublicRoutePrewarmer,
  resolvePublicRoutePrewarmTarget,
  type PublicNavigationSnapshotEnvelope
} from '@/router/publicRoutePreload'
import { getLocaleDescriptor, LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import { locale, resetLocaleRuntimeForTests, type SupportedLocale } from '@/locales'
import {
  computePublicSeoHeadDigest,
  resetPublicSeoHeadForTests,
  type PublicSeoHeadModel
} from '@/router/publicSeoHead'

const RENDER_TIMESTAMP = '2026-06-18T00:00:00.000Z'

function snapshotBytes(envelope: PublicNavigationSnapshotEnvelope): Uint8Array {
  return base64UrlToBytes(encodePublicAotPayload(envelope))
}

function base64UrlToBytes(text: string): Uint8Array {
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

  const envelope = {
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
  const envelope = {
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
    expect(locale.value).toBe('ja-JP')
  })

  it('rejects a tampered locale identity before committing a route seed', async () => {
    const envelope = {
      ...await createArchiveEnvelope(),
      renderLocale: 'ja-JP'
    }
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
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
    expect(locale.value).toBe('zh-CN')
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
    const envelope = {
      ...await createArchiveEnvelope(),
      payloadHash: '0'.repeat(64)
    }
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
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

  it('deduplicates route component and snapshot seed work for the same target', async () => {
    const events: string[] = []
    const loadArchiveComponent = vi.fn(async () => ({ default: {} }))
    const envelope = await createArchiveEnvelope()
    const fetchSnapshot = vi.fn(async () => snapshotBytes(envelope))
    const prewarm = createPublicRoutePrewarmer({
      routePreloads: [{
        kind: 'Archive',
        name: 'Archive',
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
      'public_route_prewarm_hit',
      'public_route_prewarm_ready'
    ])

    const seed = consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_002 })
    expect(seed).toEqual({
      bootstrap: decodePublicAotPayload(envelope.bootstrapPayload),
      hydration: decodePublicAotPayload(envelope.hydrationPropsPayload)
    } satisfies PublicPageSeed<'Archive'>)
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
      error: 'chunk unavailable'
    })
    await expect(prewarm.prewarm('/archive', { reason: 'focus' })).resolves.toMatchObject({
      status: 'ready',
      routeComponentReady: true,
      seedReady: true
    })
    expect(loadArchiveComponent).toHaveBeenCalledTimes(2)
    expect(fetchSnapshot).toHaveBeenCalledTimes(1)
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
