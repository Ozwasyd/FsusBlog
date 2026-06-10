import { describe, expect, it } from 'vitest'
import {
  getActiveNavForKind,
  resolvePublicPageKind,
  type PublicPageKind
} from '@/public-renderers/publicPageModel'
import { PUBLIC_PAGE_MANIFEST } from '@/public-renderers/generated/publicPageManifest'
import { getPublicSeoRouteNamesByKind } from '@/public-renderers/publicRouteRegistry'

describe('publicPageModel local route binding', () => {
  it('binds shared SEO kinds to frontend route names and active nav only', () => {
    const seoKinds = Object.values(PUBLIC_PAGE_MANIFEST)
      .filter((entry) => entry.seoEligible)
      .map((entry) => entry.kind as PublicPageKind)

    expect(seoKinds).toEqual(['Home', 'ArticleDetail', 'Filter', 'Archive', 'About', 'Privacy', 'Guidelines', 'Copyright'])

    const expectedActiveNavByKind: Record<PublicPageKind, string> = {
      Home: 'home',
      ArticleDetail: 'none',
      Filter: 'none',
      Archive: 'archive',
      About: 'about',
      Privacy: 'none',
      Guidelines: 'none',
      Copyright: 'none'
    }

    for (const kind of seoKinds) {
      expect(getActiveNavForKind(kind)).toBe(expectedActiveNavByKind[kind])
      expect(getPublicSeoRouteNamesByKind(kind).every((routeName) => resolvePublicPageKind(routeName) === kind)).toBe(true)
    }
  })
})
