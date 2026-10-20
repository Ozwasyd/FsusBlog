import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import type { RouteRecordNormalized, RouteRecordRaw, Router } from 'vue-router'
import { APP_ROUTE_RECORDS, createAppRouter } from '@/router'
import type { PublicRoutePrewarmPort } from '@/router/publicRoutePreload'
import type { LocaleRoutePreparationPort } from '@/locales/routeLocaleDomains'
import {
  ACCOUNT_CONTENT_MODES,
  ACCOUNT_PAGE_KINDS,
  assertAccountLeafRouteMeta,
  isAccountPageKind
} from '@/router/accountRouteMeta'
import { resolveAccountPageKindClass } from '@/layouts/accountPageKind'

const ensureBootstrap = vi.fn<() => Promise<void>>()
const ensurePublicShell = vi.fn<() => Promise<void>>()
const ensureAccountSession = vi.fn<() => Promise<void>>()
const ensureAdminSession = vi.fn<() => Promise<void>>()
const syncDocumentTitle = vi.fn()
let hasServerAotShellResult = false
let publicRuntimeOwner: 'aot' | 'full-app' = 'aot'

const useRouterUserStoreMock = defineStore('router-user-session-mock', {
  state: () => ({ isLoggedIn: true })
})

const adminPermissionCheck = vi.fn<(permission: string) => boolean>()
const useRouterAdminStoreMock = defineStore('router-admin-session-mock', {
  state: () => ({
    adminState: 'unknown' as 'unknown' | 'missing' | 'active' | 'expired',
    canManage: false
  }),
  actions: {
    hasPermission(permission: string): boolean {
      return adminPermissionCheck(permission)
    }
  }
})

let userStore: ReturnType<typeof useRouterUserStoreMock>
let adminStore: ReturnType<typeof useRouterAdminStoreMock>

const siteStore = {
  isLoaded: true
}

vi.mock('@/composables/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    userStore,
    siteStore,
    needsBootstrap: () => false,
    ensureBootstrap,
    ensurePublicShell,
    ensureAccountSession,
    ensureAdminSession,
    syncDocumentTitle
  })
}))

vi.mock('@/store/admin', () => ({
  useAdminStore: () => adminStore
}))

vi.mock('@/bootstrap/publicShellPrimitives', () => ({
  hasServerAotShell: () => hasServerAotShellResult
}))

const showNavigationProgress = vi.fn()
const hideNavigationProgress = vi.fn()
vi.mock('@/services/navigationProgress', () => ({
  showNavigationProgress: (...args: unknown[]) => showNavigationProgress(...args),
  hideNavigationProgress: (...args: unknown[]) => hideNavigationProgress(...args)
}))

const routeComponentStub = { template: '<div />' }

vi.mock('@/layouts/BlogLayout.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/PublicAuthLayout.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/AccountLayout.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/AccountIdentityFrame.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/AdminWorkspaceFrame.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/AccountFrameMobileAction.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/Home.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/ArticleDetail.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/Archive.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/PublicDynamicPage.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/FilterView.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/auth/Login.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/auth/Register.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/auth/Recover.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/user/Profile.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/user/Comments.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/user/Messages.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/user/IdentityCenter.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/admin/Dashboard.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/admin/article/Write.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/admin/article/List.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/error/403.vue', () => ({ default: routeComponentStub }))
vi.mock('@/views/error/404.vue', () => ({ default: routeComponentStub }))

async function createTestRouter(): Promise<Router> {
  return createAppRouter({
    history: createMemoryHistory(),
    ssr: false,
    getPublicActivationOwner: () => publicRuntimeOwner
  })
}

function concretePath(route: RouteRecordNormalized): string {
  if (route.name === 'NotFound') {
    return '/missing/deep-link'
  }

  return route.path.replace(/:([A-Za-z][A-Za-z0-9_]*)(?:\([^)]*\))?[?+*]?/gu, (_match, parameter: string) =>
    parameter === 'pathMatch' ? 'missing/deep-link' : '42'
  )
}

function deepLinkParams(route: RouteRecordNormalized): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {}
  for (const match of route.path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/gu)) {
    const parameter = match[1]!
    params[parameter] = parameter === 'pathMatch'
      ? ['missing', 'deep-link']
      : route.name === 'Tag'
        ? 'legacy-tag-name'
        : '42'
  }
  return params
}

describe('account router meta and guards', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    userStore = useRouterUserStoreMock()
    adminStore = useRouterAdminStoreMock()
    ensureBootstrap.mockClear()
    ensurePublicShell.mockClear()
    ensureAccountSession.mockClear()
    ensureAdminSession.mockClear()
    syncDocumentTitle.mockClear()
    showNavigationProgress.mockClear()
    hideNavigationProgress.mockClear()
    hasServerAotShellResult = false
    publicRuntimeOwner = 'aot'
    document.body.innerHTML = ''
    adminStore.adminState = 'unknown'
    adminStore.canManage = false
    adminPermissionCheck.mockReset()
    adminPermissionCheck.mockImplementation((permission: string) => permission === 'admin.manage')
    userStore.isLoggedIn = true
    siteStore.isLoaded = true
  })

  it('keeps every named route and canonical path unique', async () => {
    const router = await createTestRouter()
    const namedRoutes = router.getRoutes().filter((route) => route.name)
    const names = namedRoutes.map((route) => String(route.name))
    const canonicalPaths = namedRoutes
      .filter((route) => route.name !== 'NotFound')
      .map((route) => route.path)

    expect(new Set(names).size).toBe(names.length)
    expect(new Set(canonicalPaths).size).toBe(canonicalPaths.length)
  })

  it('classifies every named route for the static URL-state gate', async () => {
    const router = await createTestRouter()
    const allowed = new Set([
      'public-shareable',
      'private-recoverable',
      'session-sensitive',
      'memory-only'
    ])

    for (const route of router.getRoutes().filter((candidate) => candidate.name)) {
      expect(allowed.has(String(route.meta.routeState)), `${String(route.name)} must classify URL state`).toBe(true)
      if (route.meta.routeState === 'private-recoverable') {
        expect(route.meta.allowLoginRedirect, `${String(route.name)} must explicitly allow login recovery`).toBe(true)
      }
    }
  })

  it('classifies every account leaf by an explicit page kind and content mode', async () => {
    expect(() => assertAccountLeafRouteMeta(APP_ROUTE_RECORDS)).not.toThrow()

    const router = await createTestRouter()
    const accountLeaves = router.getRoutes().filter((route) => (
      route.name !== undefined && route.path.startsWith('/user/')
    ))

    expect(accountLeaves.length).toBeGreaterThan(0)
    for (const route of accountLeaves) {
      expect(ACCOUNT_PAGE_KINDS, `${String(route.name)} must declare a typed page kind`)
        .toContain(route.meta.accountPageKind)
      expect(ACCOUNT_CONTENT_MODES, `${String(route.name)} must declare a typed content mode`)
        .toContain(route.meta.accountContentMode)
    }
  })

  it('resolves identity and manage leaves through distinct nested frames', async () => {
    const router = await createTestRouter()
    const identity = router.resolve('/user/identity')
    const manage = router.resolve('/user/manage/article/list')
    const identityFrame = identity.matched[1]
    const manageFrame = manage.matched[1]

    expect(identity.matched.map((record) => record.path)).toEqual([
      '/user',
      '/user',
      '/user/identity'
    ])
    expect(manage.matched.map((record) => record.path)).toEqual([
      '/user',
      '/user/manage',
      '/user/manage/article/list'
    ])
    expect(identityFrame?.components).toHaveProperty('default')
    expect(identityFrame?.components).toHaveProperty('accountMobileAction')
    expect(manageFrame?.components).toHaveProperty('default')
    expect(manageFrame?.components).toHaveProperty('accountMobileAction')
    expect(identityFrame?.components?.default).not.toBe(manageFrame?.components?.default)
  })

  it('fails closed when a new account leaf omits its composition contract', () => {
    const invalidRecords: RouteRecordRaw[] = [{
      path: '/user',
      component: routeComponentStub,
      children: [{
        path: 'missing-kind',
        name: 'MissingAccountPageKind',
        component: routeComponentStub,
        meta: { accountArea: 'self', accountContentMode: 'standard' }
      }]
    }]

    expect(() => assertAccountLeafRouteMeta(invalidRecords))
      .toThrow('MissingAccountPageKind (/user/missing-kind) must declare a valid accountPageKind')
  })

  it('preserves every account leaf shell class from the route-name inference baseline', async () => {
    const router = await createTestRouter()
    const accountLeaves = router.getRoutes().filter((route) => (
      route.name !== undefined && route.path.startsWith('/user/')
    ))

    for (const route of accountLeaves) {
      expect(isAccountPageKind(route.meta.accountPageKind)).toBe(true)
      if (!isAccountPageKind(route.meta.accountPageKind)) continue

      const area = route.meta.accountArea === 'manage' ? 'manage' : 'self'
      // Assert the resolver is total and stable for every leaf kind; class tokens are owned by accountPageKind.ts.
      const resolved = resolveAccountPageKindClass(area, route.meta.accountPageKind)
      expect(resolved, String(route.name)).toEqual(expect.any(String))
      if (area === 'self' && String(route.meta.accountPageKind) !== 'overview') {
        expect(resolved, String(route.name)).toMatch(/^identity-page-shell/)
      }
      if (area === 'manage') {
        expect(resolved, String(route.name)).toMatch(/^admin-page-shell/)
      }
    }
  })

  it('resolves every named deep link without browser navigation', async () => {
    const router = await createTestRouter()

    for (const route of router.getRoutes().filter((candidate) => candidate.name)) {
      const resolved = router.resolve({
        name: route.name!,
        params: deepLinkParams(route)
      })
      const parsed = router.resolve(resolved.fullPath)

      expect(resolved.matched.length, `${String(route.name)} must resolve by name`).toBeGreaterThan(0)
      expect(parsed.name, `${String(route.name)} must own ${resolved.fullPath}`).toBe(route.name)
    }
  })

  it('classifies every account deep link by an explicit, non-substitutable session requirement', async () => {
    const router = await createTestRouter()
    const accountRoutes = router.getRoutes().filter((route) => route.path.startsWith('/user'))

    for (const route of accountRoutes) {
      const resolved = router.resolve(concretePath(route))
      if (route.path === '/user') {
        expect(resolved.meta.requiresConfirmedIdentity).toBe(true)
        expect(resolved.meta.requiresAccountSession).not.toBe(true)
        expect(resolved.meta.requiresAdminSession).not.toBe(true)
      } else if (route.path.startsWith('/user/manage')) {
        expect(resolved.meta.accountArea, `${route.path} must stay in the manage surface`).toBe('manage')
        expect(resolved.meta.requiresConfirmedIdentity, `${route.path} must not inherit the root redirect rule`).toBe(false)
        expect(resolved.meta.requiresAdminSession, `${route.path} must require the admin session`).toBe(true)
        expect(resolved.meta.requiresAccountSession, `${route.path} must not inherit the account session`).not.toBe(true)
        expect(resolved.meta.requiresAuth, `${route.path} must not use the legacy auth union`).not.toBe(true)
        expect(resolved.meta.requiredAdminPermissions, `${route.path} must declare an admin permission`).toEqual(
          expect.arrayContaining([expect.any(String)])
        )
      } else {
        expect(resolved.meta.accountArea, `${route.path} must stay in the self surface`).toBe('self')
        expect(resolved.meta.requiresConfirmedIdentity, `${route.path} must not inherit the root redirect rule`).toBe(false)
        expect(resolved.meta.requiresAccountSession, `${route.path} must require the account session`).toBe(true)
        expect(resolved.meta.requiresAdminSession, `${route.path} must not accept the admin session`).not.toBe(true)
        expect(resolved.meta.requiresAuth, `${route.path} must not use the legacy auth union`).not.toBe(true)
        expect(resolved.meta.requiredAdminPermissions).toBeUndefined()
      }
    }
  })

  it('keeps /user as a confirmed-identity redirect without a substitutable auth union', async () => {
    const userRoute = APP_ROUTE_RECORDS.find((route) => route.path === '/user')

    expect(userRoute?.meta).toMatchObject({
      requiresConfirmedIdentity: true,
      accountArea: 'self',
      accountContentMode: 'standard'
    })
    expect(userRoute?.meta).not.toHaveProperty('roles')
    expect(userRoute?.meta).not.toHaveProperty('requiresAuth')
  })

  it('public route does not probe account or admin session', async () => {
    const router = await createTestRouter()

    await router.push('/')

    expect(ensurePublicShell).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).not.toHaveBeenCalled()
    expect(ensureAdminSession).not.toHaveBeenCalled()
  }, 15_000)

  it('shouldDeferPublicBootstrap keeps AOT route zero-auth-probe', async () => {
    hasServerAotShellResult = true
    document.body.innerHTML = '<div id="app"></div>'
    const router = await createTestRouter()

    await router.push('/')

    expect(ensurePublicShell).not.toHaveBeenCalled()
    expect(ensureAccountSession).not.toHaveBeenCalled()
    expect(ensureAdminSession).not.toHaveBeenCalled()
  }, 15_000)

  it('uses the injected prewarm port when the SPA owns public navigation', async () => {
    publicRuntimeOwner = 'full-app'
    const prewarmPublicRoute = vi.fn<PublicRoutePrewarmPort>(async (target) => ({
      status: 'ready' as const,
      target: String(target),
      reason: 'atomic-navigation' as const,
      routeKind: 'Archive' as const,
      routeComponentReady: true,
      seedReady: true
    }))
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      getPublicActivationOwner: () => publicRuntimeOwner,
      prewarmPublicRoute
    })

    await router.push('/archive')

    expect(prewarmPublicRoute).toHaveBeenCalledWith('/archive', {
      reason: 'atomic-navigation'
    })
    expect(router.currentRoute.value.name).toBe('Archive')
  })

  it('passes the staged locale snapshot into atomic prewarm without nesting a locale commit', async () => {
    publicRuntimeOwner = 'full-app'
    const localeTransaction = {
      snapshot: {
        locale: 'en-US',
        domains: ['common', 'layout', 'public'] as const
      },
      commit: vi.fn(),
      rollback: vi.fn()
    }
    const prewarmPublicRoute = vi.fn(async () => ({
      status: 'ready' as const,
      target: '/archive',
      reason: 'atomic-navigation' as const,
      routeKind: 'Archive' as const,
      routeComponentReady: true,
      seedReady: true
    }))
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      getPublicActivationOwner: () => publicRuntimeOwner,
      prepareLocaleDomains: vi.fn(async () => localeTransaction),
      prewarmPublicRoute
    })

    await router.push('/archive')

    expect(prewarmPublicRoute).toHaveBeenCalledWith('/archive', {
      reason: 'atomic-navigation',
      preparedLocaleSnapshot: localeTransaction.snapshot
    })
    expect(localeTransaction.commit).toHaveBeenCalledOnce()
    expect(localeTransaction.rollback).not.toHaveBeenCalled()
  })

  it('renders the initial SPA fallback without entering the atomic AOT prewarm path', async () => {
    document.body.innerHTML = '<div id="app"></div>'
    const prewarmPublicRoute = vi.fn<PublicRoutePrewarmPort>(async (target) => ({
      status: 'timeout' as const,
      target: String(target),
      reason: 'atomic-navigation' as const,
      routeKind: 'Home' as const,
      routeComponentReady: true,
      seedReady: false,
      error: 'cold snapshot unavailable'
    }))
    const router = createAppRouter({
      ssr: false,
      prewarmPublicRoute
    })

    await router.push('/')

    expect(prewarmPublicRoute).not.toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe('Home')
    expect(ensurePublicShell).toHaveBeenCalledTimes(1)
  })

  it('guestOnly route probes account only', async () => {
    userStore.isLoggedIn = false
    const router = await createTestRouter()

    await router.push('/login')

    expect(ensureAccountSession).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).toHaveBeenCalledWith({ reason: 'route' })
    expect(ensureAdminSession).not.toHaveBeenCalled()
  }, 15_000)

  it('redirects signed-in guest-only routes to the correct account surface', async () => {
    const accountRouter = await createTestRouter()
    await accountRouter.push('/login')
    expect(accountRouter.currentRoute.value.path).toBe('/user/identity')

    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(true)
    const adminRouter = await createTestRouter()
    await adminRouter.push('/register')
    expect(adminRouter.currentRoute.value.path).toBe('/user/manage')
  })

  it('redirects anonymous account deep links to login with the exact return target', async () => {
    userStore.isLoggedIn = false
    const router = await createTestRouter()

    await router.push('/user/messagebox?filter=unread')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/user/messagebox?filter=unread')
  })

  it('rolls back staged locale domains for a redirected guard and commits only the final route', async () => {
    userStore.isLoggedIn = false
    const transactions: Array<{
      domains: readonly string[]
      commit: ReturnType<typeof vi.fn>
      rollback: ReturnType<typeof vi.fn>
    }> = []
    const prepareLocaleDomains = vi.fn(async (domains: readonly string[]) => {
      const transaction = {
        domains,
        snapshot: { locale: 'en-US', domains },
        commit: vi.fn(),
        rollback: vi.fn()
      }
      transactions.push(transaction)
      return transaction
    })
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      prepareLocaleDomains: prepareLocaleDomains as never
    })

    await router.push('/user/messagebox?filter=unread')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(transactions).toHaveLength(2)
    expect(transactions[0]?.rollback).toHaveBeenCalledOnce()
    expect(transactions[0]?.commit).not.toHaveBeenCalled()
    expect(transactions[1]?.commit).toHaveBeenCalledOnce()
    expect(transactions[1]?.rollback).not.toHaveBeenCalled()
  })

  it('rolls back staged locale domains when a later guard fails', async () => {
    userStore.isLoggedIn = false
    ensureAccountSession.mockRejectedValueOnce(new Error('session-probe-failed'))
    const transaction = {
      snapshot: { locale: 'en-US', domains: ['common', 'layout', 'auth'] },
      commit: vi.fn(),
      rollback: vi.fn()
    } satisfies Awaited<ReturnType<LocaleRoutePreparationPort>>
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      prepareLocaleDomains: vi.fn(async () => transaction)
    })

    await expect(router.push('/login')).rejects.toThrow('session-probe-failed')

    expect(transaction.commit).not.toHaveBeenCalled()
    expect(transaction.rollback).toHaveBeenCalled()
  })

  it('removes malicious login redirect details before committing auth history', async () => {
    userStore.isLoggedIn = false
    const router = await createTestRouter()

    await router.push('/login?redirect=https://attacker.test/private&token=secret#account-42')

    expect(router.currentRoute.value.fullPath).toBe('/login')
    expect(router.options.history.location).toBe('/login')
  })

  it('account route probes account only', async () => {
    const router = await createTestRouter()

    await router.push('/user/identity')

    expect(ensureAccountSession).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).toHaveBeenCalledWith({ reason: 'route' })
    expect(ensureAdminSession).not.toHaveBeenCalled()
  }, 15_000)

  it('manage route probes account and admin', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(true)
    const router = await createTestRouter()

    await router.push('/user/manage')

    expect(ensureAccountSession).toHaveBeenCalledTimes(1)
    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).toHaveBeenCalledWith({ reason: 'route' })
    expect(ensureAdminSession).toHaveBeenCalledWith({ reason: 'route' })
  })

  it.each([
    { session: 'none', account: false, admin: 'missing' as const, permission: false, target: '/user', expected: '/login' },
    { session: 'none', account: false, admin: 'missing' as const, permission: false, target: '/user/identity', expected: '/login' },
    { session: 'none', account: false, admin: 'missing' as const, permission: false, target: '/user/manage', expected: '/login' },
    { session: 'account', account: true, admin: 'missing' as const, permission: false, target: '/user', expected: '/user/identity' },
    { session: 'account', account: true, admin: 'missing' as const, permission: false, target: '/user/identity', expected: '/user/identity' },
    { session: 'account', account: true, admin: 'missing' as const, permission: false, target: '/user/manage', expected: '/403' },
    { session: 'admin', account: false, admin: 'active' as const, permission: true, target: '/user', expected: '/user/manage' },
    { session: 'admin', account: false, admin: 'active' as const, permission: true, target: '/user/identity', expected: '/login' },
    { session: 'admin', account: false, admin: 'active' as const, permission: true, target: '/user/manage', expected: '/user/manage' },
    { session: 'dual', account: true, admin: 'active' as const, permission: true, target: '/user', expected: '/user/manage' },
    { session: 'dual', account: true, admin: 'active' as const, permission: true, target: '/user/identity', expected: '/user/identity' },
    { session: 'dual', account: true, admin: 'active' as const, permission: true, target: '/user/manage', expected: '/user/manage' },
    { session: 'account-expired', account: false, admin: 'missing' as const, permission: false, target: '/user', expected: '/login' },
    { session: 'account-expired', account: false, admin: 'missing' as const, permission: false, target: '/user/identity', expected: '/login' },
    { session: 'account-expired', account: false, admin: 'missing' as const, permission: false, target: '/user/manage', expected: '/login' },
    { session: 'admin-expired', account: true, admin: 'expired' as const, permission: false, target: '/user', expected: '/user/identity' },
    { session: 'admin-expired', account: true, admin: 'expired' as const, permission: false, target: '/user/identity', expected: '/user/identity' },
    { session: 'admin-expired', account: true, admin: 'expired' as const, permission: false, target: '/user/manage', expected: '/403' },
    { session: 'permission-insufficient', account: false, admin: 'active' as const, permission: false, target: '/user', expected: '/403' },
    { session: 'permission-insufficient', account: false, admin: 'active' as const, permission: false, target: '/user/identity', expected: '/login' },
    { session: 'permission-insufficient', account: false, admin: 'active' as const, permission: false, target: '/user/manage', expected: '/403' }
  ])('enforces the $session session route matrix for $target', async ({ account, admin, permission, target, expected }) => {
    userStore.isLoggedIn = account
    adminStore.adminState = admin
    adminStore.canManage = admin === 'active'
    adminPermissionCheck.mockReturnValue(permission)
    const router = await createTestRouter()

    await router.push(target)

    expect(router.currentRoute.value.path).toBe(expected)
  })

  it('confirms both identity domains before resolving the /user root', async () => {
    const router = await createTestRouter()

    await router.push('/user')

    // The root probes both identities. Its redirect may then hit the account
    // guard again, where the real store serves the already-confirmed snapshot.
    expect(ensureAccountSession).toHaveBeenCalled()
    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/user/identity')
  })

  it('rejects admin-only self navigation before the protected target can resolve or enter history', async () => {
    userStore.isLoggedIn = false
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(true)
    const router = await createTestRouter()
    const resolvedPaths: string[] = []
    router.beforeResolve((to) => {
      resolvedPaths.push(to.path)
      return true
    })

    await router.push('/user/identity?token=private#account-record')

    expect(resolvedPaths).not.toContain('/user/identity')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/user/identity')
    expect(router.options.history.location).toBe('/login?redirect=/user/identity')
    expect(userStore.isLoggedIn).toBe(false)
    expect(adminStore.adminState).toBe('active')
  })

  it('strips undeclared private history fields before committing the route', async () => {
    const router = await createTestRouter()

    await router.push('/user/messagebox?filter=unread&token=secret&details=account-42#account-42')

    expect(router.currentRoute.value.fullPath).toBe('/user/messagebox?filter=unread')
    expect(router.options.history.location).toBe('/user/messagebox?filter=unread')
  })

  it('strips a private fragment even when every query field is allowlisted', async () => {
    const router = await createTestRouter()

    await router.push('/user/messagebox?filter=unread#conversation-account-42')

    expect(router.currentRoute.value.fullPath).toBe('/user/messagebox?filter=unread')
    expect(router.options.history.location).toBe('/user/messagebox?filter=unread')
  })

  it('does not resurrect discarded private state through back and forward history', async () => {
    const router = await createTestRouter()
    await router.push('/user/identity')
    await router.push('/user/messagebox?filter=unread&conversation=account-42#account-42')

    router.back()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/user/identity'))
    router.forward()
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/user/messagebox?filter=unread'))
    expect(router.options.history.location).not.toContain('account-42')
  })

  it('degrades an anonymous memory-only object route to the admin landing page', async () => {
    userStore.isLoggedIn = false
    adminStore.adminState = 'missing'
    const router = await createTestRouter()

    await router.push('/user/manage/article/edit/987654?preview=private&proof=secret#draft')

    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/user/manage')
    expect(router.options.history.location).not.toContain('987654')
    expect(router.options.history.location).not.toContain('secret')
  })

  it('manage route checks required permissions after admin probe', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(false)
    const router = await createTestRouter()

    await router.push('/user/manage/article/write')

    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(adminPermissionCheck).toHaveBeenCalledWith('article.write')
    expect(router.currentRoute.value.path).toBe('/403')
  })

  it('does not copy manage query or fragment details onto a 403 route', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(false)
    const router = await createTestRouter()

    await router.push('/user/manage/article/write?preview=1&token=private#draft-42')

    expect(router.currentRoute.value.fullPath).toBe('/403')
    expect(router.options.history.location).toBe('/403')
  })

  it('allows an authorized admin dynamic deep link', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockReturnValue(true)
    const router = await createTestRouter()

    await router.push('/user/manage/article/edit/42')

    expect(router.currentRoute.value.name).toBe('ManageEditArticle')
    expect(router.currentRoute.value.params.id).toBe('42')
    expect(adminPermissionCheck).toHaveBeenCalledWith('article.write')
  })

  it('resolves account redirects, forbidden, and not-found routes in memory', async () => {
    const router = await createTestRouter()

    await router.push('/user/profile')
    expect(router.currentRoute.value.name).toBe('UserIdentityOverview')

    await router.push('/403')
    expect(router.currentRoute.value.name).toBe('Forbidden')

    await router.push('/missing/deep-link')
    expect(router.currentRoute.value.name).toBe('NotFound')
  })

  it('integrity proof console is denied unless the admin has system.config', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminPermissionCheck.mockImplementation((permission: string) => permission !== 'system.config')
    const router = await createTestRouter()

    await router.push('/user/manage/integrity-proof')

    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(adminPermissionCheck).toHaveBeenCalledWith('system.config')
    expect(router.currentRoute.value.path).toBe('/403')
  })

  it('suppresses SPA nprogress when the injected takeover progress policy requests it', async () => {
    publicRuntimeOwner = 'full-app'
    hasServerAotShellResult = false
    userStore.isLoggedIn = false
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      getPublicActivationOwner: () => publicRuntimeOwner,
      shouldSuppressNavigationProgress: () => true
    })

    await router.push('/login')

    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 120)).toBe(false)
    expect(showNavigationProgress).not.toHaveBeenCalled()
    expect(document.getElementById('nprogress')).toBeNull()
    setTimeoutSpy.mockRestore()
  })

  it('allows SPA nprogress scheduling after interactive ownership without suppress policy', async () => {
    publicRuntimeOwner = 'full-app'
    hasServerAotShellResult = false
    userStore.isLoggedIn = false
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout')
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      getPublicActivationOwner: () => publicRuntimeOwner
    })

    await router.push('/login')

    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 120)).toBe(true)
    setTimeoutSpy.mockRestore()
  })

})
