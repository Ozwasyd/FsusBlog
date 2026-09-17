import { describe, expect, it } from 'vitest'

import {
  createPublicArticleDetailNavigationTarget,
  createPublicHomeNavigationTarget
} from '@/public-renderers/publicNavigationTargets'
import { PUBLIC_SEO_ROUTE_NAMES } from '@/public-renderers/publicRouteRegistry'

describe('publicNavigationTargets', () => {
  it('builds article detail navigation targets from the shared route control plane', () => {
    expect(createPublicArticleDetailNavigationTarget(12)).toEqual({
      href: '/article/12',
      route: {
        name: PUBLIC_SEO_ROUTE_NAMES.articleDetail,
        params: {
          id: '12'
        }
      }
    })

    expect(createPublicArticleDetailNavigationTarget('oops')).toEqual({
      href: '/article/0',
      route: {
        name: PUBLIC_SEO_ROUTE_NAMES.articleDetail,
        params: {
          id: '0'
        }
      }
    })
  })

  it('builds the home navigation target from the shared route control plane', () => {
    expect(createPublicHomeNavigationTarget()).toEqual({
      href: '/',
      route: {
        name: PUBLIC_SEO_ROUTE_NAMES.home
      }
    })
  })
})