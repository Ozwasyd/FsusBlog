import { describe, expect, it } from 'vitest'
import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'
import {
  isPublicSearchRouteName,
  isPublicSeoRouteName,
  isPublicShellRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'

describe('resolvePublicPageKind', () => {
  it('maps public route names to hydration kinds', () => {
    expect(resolvePublicPageKind('Home')).toBe('Home')
    expect(resolvePublicPageKind('ArticleDetail')).toBe('ArticleDetail')
    expect(resolvePublicPageKind('Archive')).toBe('Archive')
    expect(resolvePublicPageKind('About')).toBe('About')
    expect(resolvePublicPageKind('Privacy')).toBe('Privacy')
    expect(resolvePublicPageKind('Guidelines')).toBe('Guidelines')
    expect(resolvePublicPageKind('Copyright')).toBe('Copyright')
    expect(resolvePublicPageKind('Category')).toBe('Filter')
    expect(resolvePublicPageKind('TagById')).toBe('Filter')
    expect(resolvePublicPageKind('Tag')).toBe('Filter')
  })

  it('returns null for non-public routes', () => {
    expect(resolvePublicPageKind('Search')).toBeNull()
    expect(resolvePublicPageKind('Admin')).toBeNull()
    expect(resolvePublicPageKind(Symbol('Home'))).toBeNull()
    expect(resolvePublicPageKind(null)).toBeNull()
  })
})

describe('public route relation registry', () => {
  it('separates SEO routes from shell-only public routes', () => {
    expect(isPublicSeoRouteName('Home')).toBe(true)
    expect(isPublicSeoRouteName('Search')).toBe(false)
    expect(isPublicSeoRouteName('ManageDashboard')).toBe(false)

    expect(isPublicShellRouteName('Home')).toBe(true)
    expect(isPublicShellRouteName('Search')).toBe(true)
    expect(isPublicShellRouteName('ManageDashboard')).toBe(false)

    expect(isPublicSearchRouteName('Search')).toBe(true)
    expect(isPublicSearchRouteName('Home')).toBe(false)
  })
})

describe('createPublicShellViewState', () => {
  it('builds the SSR-compatible shell state for a public page', () => {
    const state = createPublicShellViewState({
      hydrationKind: 'Home',
      siteTitle: '  My Blog  '
    })

    expect(state).toMatchObject({
      hydrationKind: 'Home',
      siteTitle: 'My Blog',
      activeNav: 'home',
      authLabel: '登录',
      authHref: '/login',
      searchPlaceholder: '搜索',
      initialSearchQuery: '',
      spaSearch: false,
      showRuntime: false
    })
  })

  it('switches auth actions only after runtime-auth state is resolved', () => {
    expect(createPublicShellViewState({
      hydrationKind: 'About',
      siteTitle: 'Fsu',
      showRuntime: true,
      isRuntimeAuthResolved: false,
      isLoggedIn: true,
      isAdmin: true
    })).toMatchObject({
      authLabel: '登录',
      authHref: '/login'
    })

    expect(createPublicShellViewState({
      hydrationKind: 'About',
      siteTitle: 'Fsu',
      showRuntime: true,
      isRuntimeAuthResolved: true,
      isLoggedIn: true,
      isAdmin: false
    })).toMatchObject({
      authLabel: '账户',
      authHref: ACCOUNT_ROUTE_PATHS.profile
    })

    expect(createPublicShellViewState({
      hydrationKind: 'About',
      siteTitle: 'Fsu',
      showRuntime: true,
      isRuntimeAuthResolved: true,
      isLoggedIn: true,
      isAdmin: true
    })).toMatchObject({
      authLabel: '控制板',
      authHref: '/user/manage'
    })
  })

  it('builds search shell state from shared rules', () => {
    const state = createPublicShellViewState({
      siteTitle: 'Fsu',
      isSearchRoute: true,
      initialSearchQuery: 'vue hydration',
      spaSearch: true,
      showRuntime: true
    })

    expect(state.searchPlaceholder).toBe('搜索 (Ctrl+K)')
    expect(state.initialSearchQuery).toBe('vue hydration')
    expect(state.spaSearch).toBe(true)
    expect(state.showRuntime).toBe(true)
  })
})
