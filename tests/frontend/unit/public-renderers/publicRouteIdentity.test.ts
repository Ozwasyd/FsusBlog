import { describe, expect, it } from 'vitest'
import {
  buildPublicAboutRouteKey,
  buildPublicArchiveRouteKey,
  buildPublicArticleHref,
  buildPublicArticleRouteKey,
  buildPublicFilterRouteKey,
  buildPublicHomeRouteKey,
  resolvePublicFilterIdentity
} from '@/public-renderers/publicRouteIdentity'
import { PUBLIC_FILTER_ROUTE_NAMES, PUBLIC_SEARCH_ROUTE_NAME } from '@/public-renderers/publicRouteRegistry'

describe('public route identity builders', () => {
  it('builds fixed public route keys from a single source', () => {
    expect(buildPublicHomeRouteKey()).toBe('home')
    expect(buildPublicAboutRouteKey()).toBe('about')
    expect(buildPublicArchiveRouteKey()).toBe('archive')
  })

  it('normalizes article route keys', () => {
    expect(buildPublicArticleRouteKey(12)).toBe('article:12')
    expect(buildPublicArticleRouteKey('42')).toBe('article:42')
    expect(buildPublicArticleRouteKey('oops')).toBe('article:0')
    expect(buildPublicArticleHref(12)).toBe('/article/12')
    expect(buildPublicArticleHref('oops')).toBe('/article/0')
  })

  it('derives filter route keys without duplicating page-specific rules in SSR builders', () => {
    expect(buildPublicFilterRouteKey({ filterType: 'category', filterId: 7 })).toBe('category:7')
    expect(buildPublicFilterRouteKey({ filterType: 'tag', filterId: 8 })).toBe('tag:8')
    expect(buildPublicFilterRouteKey({ filterType: 'tag', filterName: 'vue' })).toBe('tag-name:vue')
    expect(buildPublicFilterRouteKey({ searchKeyword: 'hydrate mismatch' })).toBe('search')
    expect(buildPublicFilterRouteKey({ routeKey: 'tag:99', filterType: 'tag', filterId: 10 })).toBe('tag:99')
  })

  it('resolves filter identity from route registry semantics instead of local route-name literals', () => {
    expect(resolvePublicFilterIdentity({ routeName: PUBLIC_SEARCH_ROUTE_NAME, searchKeyword: 'hydrate' })).toMatchObject({
      filterType: 'search',
      routeKey: 'search',
      filterName: 'hydrate'
    })
    expect(resolvePublicFilterIdentity({ routeName: PUBLIC_FILTER_ROUTE_NAMES.category, routeParam: '7' })).toMatchObject({
      filterType: 'category',
      routeKey: 'category:7',
      filterId: 7
    })
    expect(resolvePublicFilterIdentity({ routeName: PUBLIC_FILTER_ROUTE_NAMES.tagById, routeParam: '9' })).toMatchObject({
      filterType: 'tag',
      routeKey: 'tag:9',
      filterId: 9
    })
    expect(resolvePublicFilterIdentity({ routeName: PUBLIC_FILTER_ROUTE_NAMES.tag, routeParam: 'vue' })).toMatchObject({
      filterType: 'tag',
      routeKey: 'tag-name:vue',
      filterName: 'vue'
    })
  })
})
