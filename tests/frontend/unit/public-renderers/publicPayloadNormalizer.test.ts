import { describe, expect, it } from 'vitest'

import { normalizePublicHydrationPayload } from '@/public-renderers/publicPayloadNormalizer'

describe('publicPayloadNormalizer', () => {
  it('uses shared fixed route helpers when routeKey is missing', () => {
    expect(normalizePublicHydrationPayload({
      pageKind: 'Home',
      siteTitle: 'FsusBlog',
      siteDescription: 'desc',
      rendererVersion: 'test'
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
      title: 'Article'
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
})