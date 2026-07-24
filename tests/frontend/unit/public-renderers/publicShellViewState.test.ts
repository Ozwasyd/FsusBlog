import { beforeEach, describe, expect, it } from 'vitest'
import {
  isPublicSearchRouteName,
  isPublicSeoRouteName,
  isPublicShellRouteName,
  resolvePublicPageKind
} from '@/public-renderers/publicPageModel'
import { createPublicShellViewState } from '@/public-renderers/publicShellViewState'
import {
  publicShellRuntimeAuthState,
  resetPublicShellRuntimeAuthState,
  resolvePublicShellRuntimeAuthState,
  setPublicShellRuntimeAuthState
} from '@/public-renderers/publicShellRuntimeState'

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
      siteTitle: '  My Blog  ',
      siteDescription: '  My description  ',
      renderYear: 2025
    })

    expect(state).toMatchObject({
      hydrationKind: 'Home',
      siteTitle: 'My Blog',
      siteDescription: 'My description',
      renderYear: 2025,
      activeNav: 'home',
      authAction: 'login',
      authHref: '/login',
      searchAction: 'search',
      initialSearchQuery: '',
      spaSearch: false,
      showRuntime: false
    })
    expect(state).not.toHaveProperty('authLabel')
    expect(state).not.toHaveProperty('searchPlaceholder')
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
      authAction: 'login',
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
      authAction: 'account',
      authHref: '/user/profile'
    })

    expect(createPublicShellViewState({
      hydrationKind: 'About',
      siteTitle: 'Fsu',
      showRuntime: true,
      isRuntimeAuthResolved: true,
      isLoggedIn: true,
      isAdmin: true
    })).toMatchObject({
      authAction: 'dashboard',
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

    expect(state.searchAction).toBe('search-shortcut')
    expect(state.initialSearchQuery).toBe('vue hydration')
    expect(state.spaSearch).toBe(true)
    expect(state.showRuntime).toBe(true)
  })
})

describe('publicShellRuntimeAuthState', () => {
  beforeEach(() => {
    resetPublicShellRuntimeAuthState()
  })

  it('starts and resets to the SSR-compatible anonymous auth action', () => {
    expect(publicShellRuntimeAuthState.value).toEqual({
      authAction: 'login',
      authHref: '/login'
    })

    setPublicShellRuntimeAuthState({
      authAction: 'account',
      authHref: '/user/identity'
    })
    resetPublicShellRuntimeAuthState()

    expect(publicShellRuntimeAuthState.value).toEqual({
      authAction: 'login',
      authHref: '/login'
    })
  })

  it('resolves anonymous and logged-in runtime account states', () => {
    expect(resolvePublicShellRuntimeAuthState(null)).toEqual({
      authAction: 'login',
      authHref: '/login'
    })
    expect(resolvePublicShellRuntimeAuthState({ accountId: 1 })).toEqual({
      authAction: 'account',
      authHref: '/user/profile'
    })
    expect(resolvePublicShellRuntimeAuthState({ accountId: 1, canManage: true })).toEqual({
      authAction: 'dashboard',
      authHref: '/user/manage'
    })
  })
})
