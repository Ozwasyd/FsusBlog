import { describe, expect, it } from 'vitest'

import { normalizePublicHydrationPayload } from '@/public-renderers/publicPayloadNormalizer'
import { articleRightsFixture } from '../fixtures/articleRights'

describe('publicPayloadNormalizer', () => {
  it('uses shared fixed route helpers when routeKey is missing', () => {
    expect(normalizePublicHydrationPayload({
      pageKind: 'Home',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      featuredArticles: [],
      hotArticles: []
    }).routeKey).toBe('home')

    expect(normalizePublicHydrationPayload({
      pageKind: 'About',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test'
    }).routeKey).toBe('about')

    expect(normalizePublicHydrationPayload({
      pageKind: 'Archive',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test'
    }).routeKey).toBe('archive')
  })

  it('derives dynamic route keys from shared route identity helpers', () => {
    expect(normalizePublicHydrationPayload({
      pageKind: 'ArticleDetail',
      articleId: 7,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      title: 'Article',
      rights: articleRightsFixture,
      detailView: {
        rights: articleRightsFixture
      }
    }).routeKey).toBe('article:7')

    expect(normalizePublicHydrationPayload({
      pageKind: 'Filter',
      filterType: 'tag',
      filterName: 'C#',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      title: 'Tag'
    }).routeKey).toBe('tag-name:C#')

    expect(normalizePublicHydrationPayload({
      pageKind: 'Filter',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      title: 'Search'
    }).routeKey).toBe('search')
  })

  it('rejects missing required home secondary article arrays', () => {
    expect(() => normalizePublicHydrationPayload({
      pageKind: 'Home',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test'
    })).toThrow('public_aot_payload_missing_array:Home.featuredArticles')
  })

  it('rejects ArticleDetail hydration payloads without required rights', () => {
    expect(() => normalizePublicHydrationPayload({
      pageKind: 'ArticleDetail',
      articleId: 7,
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      title: 'Article'
    })).toThrow('public_aot_payload_missing_object:ArticleDetail.rights')
  })

  it('normalizes filter payloads from the filter subobject', () => {
    const normalized = normalizePublicHydrationPayload({
      pageKind: 'Filter',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test',
      title: 'Category',
      filter: {
        filterType: 'category',
        filterKey: 'category:7',
        filterId: 7,
        filterName: 'Category',
        isInvalidTarget: false,
        pageIndex: 2,
        pageSize: 10,
        total: 21
      }
    })

    expect(normalized.routeKey).toBe('category:7')
    expect(normalized.filter?.filterType).toBe('category')
    expect(normalized.filter?.filterId).toBe(7)
  })
})
