import { describe, expect, it } from 'vitest'

import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import { normalizePublicHydrationPayload } from '@/public-renderers/publicPayloadNormalizer'
import type {
  PublicArticleDetailHydrationPayload,
  PublicHomeHydrationPayload,
  PublicHydrationPayload
} from '@/public-renderers/types'
import { createArticleListViewContract } from '@/view-contracts/articleList'
import { createArticleRightsViewContract, emptyArticleDetailPageView } from '@/view-contracts/articleDetail'
import { articleRightsFixture } from '../fixtures/articleRights'

const identity = {
  siteTitle: 'FsusBlog',
  siteDescription: 'desc',
  rendererVersion: 'test',
  renderLocale: 'zh-CN',
  localeCatalogDigest: LOCALE_CATALOG_DIGEST,
  title: ''
} as const

function homePayload(): PublicHomeHydrationPayload {
  return {
    ...identity,
    pageKind: 'Home',
    routeKey: 'home',
    currentPage: 1,
    pageSize: 10,
    total: 0,
    view: createArticleListViewContract({ items: [], total: 0 }, { currentPage: 1, pageSize: 10 }),
    featuredArticles: [],
    hotArticles: []
  }
}

function articlePayload(): PublicArticleDetailHydrationPayload {
  return {
    ...identity,
    pageKind: 'ArticleDetail',
    routeKey: 'article:7',
    articleId: 7,
    title: 'Article',
    bodyContent: '',
    rights: articleRightsFixture,
    detailView: {
      ...emptyArticleDetailPageView,
      rights: createArticleRightsViewContract(articleRightsFixture)
    },
    commentsIsland: { articleId: 7 }
  }
}

function withoutRouteKey(payload: PublicHydrationPayload): PublicHydrationPayload {
  const { routeKey: _routeKey, ...missingRouteKey } = payload
  // Deliberately omit this required field to exercise route-key recovery.
  return missingRouteKey as PublicHydrationPayload
}

describe('publicPayloadNormalizer', () => {
  it('uses shared fixed route helpers when routeKey is missing', () => {
    expect(normalizePublicHydrationPayload(withoutRouteKey(homePayload())).routeKey).toBe('home')

    expect(normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'About',
      routeKey: 'about'
    })).routeKey).toBe('about')

    expect(normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'Archive',
      routeKey: 'archive'
    })).routeKey).toBe('archive')

    for (const [pageKind, routeKey] of [
      ['Privacy', 'privacy'],
      ['Guidelines', 'guidelines'],
      ['Copyright', 'copyright']
    ] as const) {
      expect(normalizePublicHydrationPayload(withoutRouteKey({
        ...identity,
        pageKind,
        routeKey
      })).routeKey).toBe(routeKey)
    }
  })

  it('derives dynamic route keys from shared route identity helpers', () => {
    expect(normalizePublicHydrationPayload(withoutRouteKey(articlePayload())).routeKey).toBe('article:7')

    expect(normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'Filter',
      routeKey: 'tag-name:C#',
      filterType: 'tag',
      filterName: 'C#',
      title: 'Tag'
    })).routeKey).toBe('tag-name:C#')

    expect(normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'Filter',
      routeKey: 'search',
      title: 'Search'
    })).routeKey).toBe('search')
  })

  it('rejects missing required home secondary article arrays', () => {
    const { featuredArticles: _featuredArticles, hotArticles: _hotArticles, ...missingArrays } = homePayload()
    // Keep the malformed wire input at this single rejection-test boundary.
    expect(() => normalizePublicHydrationPayload(withoutRouteKey(missingArrays as PublicHomeHydrationPayload)))
      .toThrow('public_aot_payload_missing_array:Home.featuredArticles')
  })

  it('rejects ArticleDetail hydration payloads without required rights', () => {
    const { rights: _rights, ...missingRights } = articlePayload()
    expect(() => normalizePublicHydrationPayload(withoutRouteKey(missingRights as PublicArticleDetailHydrationPayload)))
      .toThrow('public_aot_payload_missing_object:ArticleDetail.rights')
  })

  it('normalizes filter payloads from the filter subobject', () => {
    const normalized = normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'Filter',
      routeKey: 'category:7',
      title: 'Category',
      filter: {
        filterType: 'category',
        filterKey: 'category:7',
        filterId: 7,
        filterName: 'Category',
        description: '  分类说明  ',
        isInvalidTarget: false,
        pageIndex: 2,
        pageSize: 10,
        total: 21
      }
    }))

    expect(normalized.routeKey).toBe('category:7')
    if (normalized.pageKind !== 'Filter') throw new Error('expected Filter payload')
    expect(normalized.filter?.filterType).toBe('category')
    expect(normalized.filter?.filterId).toBe(7)
    expect(normalized.filter?.description).toBe('分类说明')
  })

  it('keeps filter description null when taxonomy has none', () => {
    const normalized = normalizePublicHydrationPayload(withoutRouteKey({
      ...identity,
      pageKind: 'Filter',
      routeKey: 'tag:3',
      title: 'Tag',
      filter: {
        filterType: 'tag',
        filterKey: 'tag:3',
        filterId: 3,
        filterName: 'Tag',
        description: null,
        isInvalidTarget: false,
        pageIndex: 1,
        pageSize: 10,
        total: 0
      }
    }))

    if (normalized.pageKind !== 'Filter') throw new Error('expected Filter payload')
    expect(normalized.filter?.description).toBeNull()
  })
})
