import { describe, expect, it } from 'vitest'

import {
  buildPublicFixedPath,
  buildPublicFixedRouteKey,
  PUBLIC_FIXED_PAGE_KIND,
  PUBLIC_FIXED_PATHS,
  PUBLIC_FIXED_ROUTE_KEYS
} from '@/public-renderers/publicFixedPageSemantics'

describe('publicFixedPageSemantics', () => {
  it('keeps fixed public page kinds, route keys, and paths in one place', () => {
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.home)).toBe('home')
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.about)).toBe('about')
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.archive)).toBe('archive')
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.privacy)).toBe('privacy')
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.guidelines)).toBe('guidelines')
    expect(buildPublicFixedRouteKey(PUBLIC_FIXED_PAGE_KIND.copyright)).toBe('copyright')
    expect(PUBLIC_FIXED_ROUTE_KEYS).toEqual({
      home: 'home',
      about: 'about',
      archive: 'archive',
      privacy: 'privacy',
      guidelines: 'guidelines',
      copyright: 'copyright'
    })

    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.home)).toBe('/')
    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.about)).toBe('/about')
    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.archive)).toBe('/archive')
    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.privacy)).toBe('/privacy')
    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.guidelines)).toBe('/guidelines')
    expect(buildPublicFixedPath(PUBLIC_FIXED_PAGE_KIND.copyright)).toBe('/copyright')
    expect(PUBLIC_FIXED_PATHS).toEqual({
      home: '/',
      about: '/about',
      archive: '/archive',
      privacy: '/privacy',
      guidelines: '/guidelines',
      copyright: '/copyright'
    })
  })
})
