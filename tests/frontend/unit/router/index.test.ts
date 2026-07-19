import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { createMemoryHistory } from 'vue-router'
import type { RouteRecordNormalized, Router } from 'vue-router'
import { APP_ROUTE_RECORDS, createAppRouter } from '@/router'

const ensureBootstrap = vi.fn<() => Promise<void>>()
const ensurePublicShell = vi.fn<() => Promise<void>>()
const ensureAccountSession = vi.fn<() => Promise<void>>()
const ensureAdminSession = vi.fn<() => Promise<void>>()
const syncDocumentTitle = vi.fn()
let hasServerAotShellResult = false
let publicRuntimeOwner: 'aot' | 'spa' = 'aot'

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

vi.mock('@/bootstrap/publicTakeoverState', () => ({
  getPublicRuntimeOwner: () => publicRuntimeOwner
}))

const routeComponentStub = { template: '<div />' }

vi.mock('@/layouts/BlogLayout.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/PublicAuthLayout.vue', () => ({ default: routeComponentStub }))
vi.mock('@/layouts/AccountLayout.vue', () => ({ default: routeComponentStub }))
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
    ssr: false
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
    publicRuntimeOwner = 'spa'
    const prewarmPublicRoute = vi.fn(async (target: string) => ({
      status: 'ready' as const,
      target,
      reason: 'atomic-navigation' as const,
      routeKind: 'Archive' as const,
      routeComponentReady: true,
      seedReady: true
    }))
    const router = createAppRouter({
      history: createMemoryHistory(),
      ssr: false,
      prewarmPublicRoute
    })

    await router.push('/archive')

    expect(prewarmPublicRoute).toHaveBeenCalledWith('/archive', {
      reason: 'atomic-navigation'
    })
    expect(router.currentRoute.value.name).toBe('Archive')
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

})
