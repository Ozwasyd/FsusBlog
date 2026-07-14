import { beforeEach, describe, expect, it } from 'vitest'
import {
  decodePublicAotPayload,
  decodePublicAotPayloadBytes,
  encodePublicAotPayload
} from '@/bootstrap/publicAotBinaryPayload'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import type {
  PublicAotBootstrapPayloadFor,
  PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes'
import {
  consumePublicRouteSeed,
  putPublicRouteSeed,
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'

type PublicNavigationSnapshotEnvelope = Readonly<{
  kind: string
  pageKind: 'Archive'
  pageId: number
  routeKey: string
  path: string
  queryString: string
  fullPath: string
  canonicalPath: string
  rendererVersion: string
  frontendAssetVersion: string
  payloadHash: string
  generatedAtUtc: string
  bootstrapPayload: string
  hydrationPropsPayload: string
  seoHead: Readonly<Record<string, unknown>>
}>

function base64UrlToBytes(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

describe('public navigation snapshot contract', () => {
  beforeEach(() => {
    resetPublicRouteSeedStoreForTests()
  })

  it('decodes the endpoint AEDS envelope and inserts route seeds', () => {
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
    const encodedEnvelope = encodePublicAotPayload({
      kind: 'public-navigation-snapshot',
      pageKind: 'Archive',
      pageId: 2,
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
      seoHead: {
        schema: 'fsusblog.public-seo-head',
        version: 1,
        digest: 'sha256-head'
      }
    })

    const envelope = decodePublicAotPayloadBytes<PublicNavigationSnapshotEnvelope>(
      base64UrlToBytes(encodedEnvelope)
    )
    expect(envelope).toMatchObject({
      kind: 'public-navigation-snapshot',
      pageKind: 'Archive',
      routeKey: 'archive',
      fullPath: '/archive',
      rendererVersion: PUBLIC_RENDERER_VERSION
    })
    expect(envelope?.seoHead).toMatchObject({
      schema: 'fsusblog.public-seo-head',
      version: 1
    })

    const seed: PublicPageSeed<'Archive'> = {
      bootstrap: decodePublicAotPayload<PublicAotBootstrapPayloadFor<'Archive'>>(
        envelope!.bootstrapPayload
      ),
      hydration: decodePublicAotPayload<PublicHydrationPayloadFor<'Archive'>>(
        envelope!.hydrationPropsPayload
      )
    }
    putPublicRouteSeed({
      kind: 'Archive',
      fullPath: envelope!.fullPath,
      routeKey: envelope!.routeKey,
      rendererVersion: envelope!.rendererVersion,
      seed,
      nowMs: 1_000
    })

    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toEqual(seed)
  })
})
