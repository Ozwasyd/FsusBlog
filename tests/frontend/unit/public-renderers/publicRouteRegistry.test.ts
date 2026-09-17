import { describe, expect, it } from 'vitest'

import {
  getPublicNonAotRoutePolicy,
  getPublicSeoRouteNamesByKind,
  PUBLIC_BLOG_CHILD_ROUTES,
  PUBLIC_FILTER_ROUTE_NAMES,
  PUBLIC_NON_AOT_ROUTE_POLICIES,
  PUBLIC_SEARCH_ROUTE_NAME,
  PUBLIC_SHELL_ONLY_ROUTE_NAMES,
  resolvePublicFilterRouteMode
} from '@/public-renderers/publicRouteRegistry'

describe('publicRouteRegistry', () => {
  it('groups SEO route names by page kind and keeps search shell-only', () => {
    expect(getPublicSeoRouteNamesByKind('Home')).toEqual(['Home'])
    expect(getPublicSeoRouteNamesByKind('ArticleDetail')).toEqual(['ArticleDetail'])
    expect(getPublicSeoRouteNamesByKind('Filter')).toEqual([
      PUBLIC_FILTER_ROUTE_NAMES.category,
      PUBLIC_FILTER_ROUTE_NAMES.tagById,
      PUBLIC_FILTER_ROUTE_NAMES.tag
    ])
    expect(getPublicSeoRouteNamesByKind('Archive')).toEqual(['Archive'])
    expect(getPublicSeoRouteNamesByKind('About')).toEqual(['About'])
    expect(getPublicSeoRouteNamesByKind('Privacy')).toEqual(['Privacy'])
    expect(getPublicSeoRouteNamesByKind('Guidelines')).toEqual(['Guidelines'])
    expect(getPublicSeoRouteNamesByKind('Copyright')).toEqual(['Copyright'])

    expect(PUBLIC_SHELL_ONLY_ROUTE_NAMES).toEqual([PUBLIC_SEARCH_ROUTE_NAME])
    expect(PUBLIC_BLOG_CHILD_ROUTES.map((route) => route.name)).toEqual([
      'Home',
      'ArticleDetail',
      'Archive',
      'About',
      'Privacy',
      'Guidelines',
      'Copyright',
      PUBLIC_FILTER_ROUTE_NAMES.category,
      PUBLIC_FILTER_ROUTE_NAMES.tagById,
      PUBLIC_FILTER_ROUTE_NAMES.tag,
      'Search'
    ])
  })

  it('owns the route-name to filter-mode mapping used by filter identity resolution', () => {
    expect(resolvePublicFilterRouteMode(PUBLIC_SEARCH_ROUTE_NAME)).toBe('search')
    expect(resolvePublicFilterRouteMode(PUBLIC_FILTER_ROUTE_NAMES.category)).toBe('category')
    expect(resolvePublicFilterRouteMode(PUBLIC_FILTER_ROUTE_NAMES.tagById)).toBe('tag-id')
    expect(resolvePublicFilterRouteMode(PUBLIC_FILTER_ROUTE_NAMES.tag)).toBe('tag')
    expect(resolvePublicFilterRouteMode('Home')).toBeNull()
  })

  it('declares non-AOT route eligibility boundaries for search and account', () => {
    expect(PUBLIC_NON_AOT_ROUTE_POLICIES.Search).toEqual({
      routeName: 'Search',
      kind: 'Search',
      path: '/search',
      seoEligible: false,
      aotShellReady: false,
      requiresUserState: false,
      fallbackBehavior: 'spa-public-search-fallback'
    })
    expect(getPublicNonAotRoutePolicy('Account')).toEqual({
      routeName: 'Account',
      kind: 'Account',
      path: '/user/profile',
      seoEligible: false,
      aotShellReady: false,
      requiresUserState: true,
      fallbackBehavior: 'user-state-runtime-only'
    })
  })
})
