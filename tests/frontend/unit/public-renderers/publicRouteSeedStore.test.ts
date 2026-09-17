import { beforeEach, describe, expect, it } from 'vitest'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import type {
  PublicAotBootstrapKind,
  PublicAotBootstrapPayloadFor,
  PublicHydrationPayloadFor
} from '@/public-renderers/publicPayloadTypes'
import {
  consumePublicRouteSeed,
  invalidatePublicRouteSeed,
  peekPublicRouteSeed,
  putPublicRouteSeed,
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'

type SeedKind = PublicPageKind & PublicAotBootstrapKind

function createSeed<TKind extends SeedKind>(
  kind: TKind,
  routeKey: string,
  rendererVersion = PUBLIC_RENDERER_VERSION
): PublicPageSeed<TKind> {
  return {
    bootstrap: {
      kind,
      pageKind: kind,
      routeKey,
      rendererVersion
    } as PublicAotBootstrapPayloadFor<TKind>,
    hydration: {
      pageKind: kind,
      routeKey,
      rendererVersion,
      title: `${kind} title`
    } as PublicHydrationPayloadFor<TKind>
  }
}

describe('public route seed store', () => {
  beforeEach(() => {
    resetPublicRouteSeedStoreForTests()
  })

  it('consumes entries by fullPath without leaking between public routes', () => {
    const homeSeed = createSeed('Home', 'home')
    const archiveSeed = createSeed('Archive', 'archive')
    const articleSeed = createSeed('ArticleDetail', 'article:42')
    const categorySeed = createSeed('Filter', 'category:7')
    const tagSeed = createSeed('Filter', 'tag-name:vue')

    putPublicRouteSeed({ kind: 'Home', fullPath: '/', routeKey: 'home', seed: homeSeed, nowMs: 1_000 })
    putPublicRouteSeed({ kind: 'Archive', fullPath: '/archive', routeKey: 'archive', seed: archiveSeed, nowMs: 1_000 })
    putPublicRouteSeed({ kind: 'ArticleDetail', fullPath: '/article/42', routeKey: 'article:42', seed: articleSeed, nowMs: 1_000 })
    putPublicRouteSeed({ kind: 'Filter', fullPath: '/category/7', routeKey: 'category:7', seed: categorySeed, nowMs: 1_000 })
    putPublicRouteSeed({ kind: 'Filter', fullPath: '/tag/vue', routeKey: 'tag-name:vue', seed: tagSeed, nowMs: 1_000 })

    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBe(archiveSeed)
    expect(consumePublicRouteSeed('Home', { fullPath: '/' }, { nowMs: 1_001 })).toBe(homeSeed)
    expect(consumePublicRouteSeed('ArticleDetail', { fullPath: '/article/42' }, { nowMs: 1_001 })).toBe(articleSeed)
    expect(consumePublicRouteSeed('Filter', { fullPath: '/category/7' }, { nowMs: 1_001 })).toBe(categorySeed)
    expect(consumePublicRouteSeed('Filter', { fullPath: '/tag/vue' }, { nowMs: 1_001 })).toBe(tagSeed)

    expect(consumePublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
    expect(peekPublicRouteSeed('Filter', { fullPath: '/archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('can consume by routeKey when the fullPath is not available yet', () => {
    const archiveSeed = createSeed('Archive', 'archive')
    putPublicRouteSeed({ kind: 'Archive', fullPath: '/archive', routeKey: 'archive', seed: archiveSeed, nowMs: 1_000 })

    expect(peekPublicRouteSeed('Archive', { routeKey: 'archive' }, { nowMs: 1_001 })).toBe(archiveSeed)
    expect(consumePublicRouteSeed('Archive', { routeKey: 'archive' }, { nowMs: 1_001 })).toBe(archiveSeed)
    expect(peekPublicRouteSeed('Archive', { routeKey: 'archive' }, { nowMs: 1_001 })).toBeNull()
  })

  it('ignores stale or renderer-incompatible entries and removes them from the store', () => {
    const staleSeed = createSeed('Archive', 'archive')
    putPublicRouteSeed({
      kind: 'Archive',
      fullPath: '/archive',
      routeKey: 'archive',
      seed: staleSeed,
      nowMs: 1_000,
      ttlMs: 10
    })

    expect(peekPublicRouteSeed('Archive', { fullPath: '/archive' }, { nowMs: 1_011 })).toBeNull()
    expect(peekPublicRouteSeed('Archive', { routeKey: 'archive' }, { nowMs: 1_011 })).toBeNull()

    const incompatibleSeed = createSeed('Home', 'home', 'old-renderer')
    putPublicRouteSeed({
      kind: 'Home',
      fullPath: '/',
      routeKey: 'home',
      seed: incompatibleSeed,
      nowMs: 2_000,
      rendererVersion: 'old-renderer'
    })

    expect(peekPublicRouteSeed('Home', { fullPath: '/' }, {
      nowMs: 2_001,
      rendererVersion: PUBLIC_RENDERER_VERSION
    })).toBeNull()
    expect(peekPublicRouteSeed('Home', { routeKey: 'home' }, { nowMs: 2_001 })).toBeNull()
  })

  it('invalidates a matched route without clearing other seeds', () => {
    const archiveSeed = createSeed('Archive', 'archive')
    const aboutSeed = createSeed('About', 'about')
    putPublicRouteSeed({ kind: 'Archive', fullPath: '/archive', routeKey: 'archive', seed: archiveSeed })
    putPublicRouteSeed({ kind: 'About', fullPath: '/about', routeKey: 'about', seed: aboutSeed })

    invalidatePublicRouteSeed({ fullPath: '/archive' })

    expect(peekPublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
    expect(peekPublicRouteSeed('About', { fullPath: '/about' })).toBe(aboutSeed)
  })

  it('clears all seeds when invalidated without a route lookup', () => {
    putPublicRouteSeed({ kind: 'Archive', fullPath: '/archive', routeKey: 'archive', seed: createSeed('Archive', 'archive') })
    putPublicRouteSeed({ kind: 'About', fullPath: '/about', routeKey: 'about', seed: createSeed('About', 'about') })

    invalidatePublicRouteSeed()

    expect(peekPublicRouteSeed('Archive', { fullPath: '/archive' })).toBeNull()
    expect(peekPublicRouteSeed('About', { fullPath: '/about' })).toBeNull()
  })
})
