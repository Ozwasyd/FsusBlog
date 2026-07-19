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
  createPublicRoutePrewarmer,
  resolvePublicRoutePrewarmTarget,
  type PublicNavigationSnapshotEnvelope
} from '@/router/publicRoutePreload'
import {
  computePublicSeoHeadDigest,
  resetPublicSeoHeadForTests,
  type PublicSeoHeadModel
} from '@/router/publicSeoHead'

function snapshotBytes(envelope: PublicNavigationSnapshotEnvelope): Uint8Array {
  return base64UrlToBytes(encodePublicAotPayload(envelope))
}

function base64UrlToBytes(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function createArchiveEnvelope(): Promise<PublicNavigationSnapshotEnvelope> {
  const bootstrap = {
    kind: 'Archive',
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
    articles: [],
    total: 0
  } as PublicAotBootstrapPayloadFor<'Archive'>
  const hydration = {
    pageKind: 'Archive',
    routeKey: 'archive',
    rendererVersion: PUBLIC_RENDERER_VERSION,
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
    locale: 'zh-CN',
    pageType: 'Archive',
    pageEntityId: 'http://127.0.0.1/archive',
    openGraph: {
      title: 'Archive - FsusBlog',
      description: 'Archive description',
      type: 'website',
      url: 'http://127.0.0.1/archive',
      locale: 'zh_CN',
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

  return {
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
    payloadHash: 'sha256-test',
    generatedAtUtc: '2026-06-18T00:00:00.0000000Z',
    bootstrapPayload: encodePublicAotPayload(bootstrap),
    hydrationPropsPayload: encodePublicAotPayload(hydration),
    seoHead
  }
}

describe('public route prewarm', () => {
  beforeEach(() => {
    resetPublicRouteSeedStoreForTests()
    resetPublicSeoHeadForTests()
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
