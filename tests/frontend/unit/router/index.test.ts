import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const userStore = {
  isLoggedIn: true
}

const siteStore = {
  isLoaded: true
}

const adminStore = {
  adminState: 'unknown',
  canManage: false,
  hasPermission: vi.fn((permission: string) => permission === 'admin.manage')
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
    adminStore.hasPermission.mockClear()
    adminStore.hasPermission.mockImplementation((permission: string) => permission === 'admin.manage')
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

  it('classifies every account deep link and every manage permission in route meta', async () => {
    const router = await createTestRouter()
    const accountRoutes = router.getRoutes().filter((route) => route.path.startsWith('/user'))

    for (const route of accountRoutes) {
      const resolved = router.resolve(concretePath(route))
      expect(resolved.meta.requiresAuth, `${route.path} must inherit account authentication`).toBe(true)

      if (route.path.startsWith('/user/manage')) {
        expect(resolved.meta.accountArea, `${route.path} must stay in the manage surface`).toBe('manage')
        expect(resolved.meta.permissions, `${route.path} must declare a permission`).toEqual(
          expect.arrayContaining([expect.any(String)])
        )
      }
    }
  })

  it('keeps /user authenticated without legacy role meta', async () => {
    const userRoute = APP_ROUTE_RECORDS.find((route) => route.path === '/user')

    expect(userRoute?.meta).toMatchObject({
      requiresAuth: true,
      accountArea: 'self',
      accountContentMode: 'standard'
    })
    expect(userRoute?.meta).not.toHaveProperty('roles')
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
    adminStore.hasPermission.mockReturnValue(true)
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
    adminStore.canManage = true
    const router = await createTestRouter()

    await router.push('/user/manage')

    expect(ensureAccountSession).toHaveBeenCalledTimes(1)
    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).toHaveBeenCalledWith({ reason: 'route' })
    expect(ensureAdminSession).toHaveBeenCalledWith({ reason: 'route' })
  })

  it.each([
    { session: 'none', account: false, admin: false, target: '/login', expected: '/login' },
    { session: 'none', account: false, admin: false, target: '/user/identity', expected: '/login' },
    { session: 'none', account: false, admin: false, target: '/user/manage', expected: '/login' },
    { session: 'account', account: true, admin: false, target: '/login', expected: '/user/identity' },
    { session: 'account', account: true, admin: false, target: '/user/identity', expected: '/user/identity' },
    { session: 'account', account: true, admin: false, target: '/user/manage', expected: '/403' },
    { session: 'admin', account: false, admin: true, target: '/login', expected: '/login' },
    { session: 'admin', account: false, admin: true, target: '/user/identity', expected: '/user/identity' },
    { session: 'admin', account: false, admin: true, target: '/user/manage', expected: '/user/manage' },
    { session: 'dual', account: true, admin: true, target: '/login', expected: '/user/manage' },
    { session: 'dual', account: true, admin: true, target: '/user/identity', expected: '/user/identity' },
    { session: 'dual', account: true, admin: true, target: '/user/manage', expected: '/user/manage' }
  ])('enforces the $session session route matrix for $target', async ({ account, admin, target, expected }) => {
    userStore.isLoggedIn = account
    adminStore.adminState = admin ? 'active' : 'missing'
    adminStore.canManage = admin
    adminStore.hasPermission.mockReturnValue(admin)
    const router = await createTestRouter()

    await router.push(target)

    expect(router.currentRoute.value.path).toBe(expected)
  })

  it('strips undeclared private history fields before committing the route', async () => {
    const router = await createTestRouter()

    await router.push('/user/messagebox?filter=unread&token=secret&details=account-42#account-42')

    expect(router.currentRoute.value.fullPath).toBe('/user/messagebox?filter=unread')
    expect(router.options.history.location).toBe('/user/messagebox?filter=unread')
  })

  it('manage route checks required permissions after admin probe', async () => {
    adminStore.canManage = true
    adminStore.hasPermission.mockReturnValue(false)
    const router = await createTestRouter()

    await router.push('/user/manage/article/write')

    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(adminStore.hasPermission).toHaveBeenCalledWith('article.write')
    expect(router.currentRoute.value.path).toBe('/403')
  })

  it('allows an authorized admin dynamic deep link', async () => {
    adminStore.adminState = 'active'
    adminStore.canManage = true
    adminStore.hasPermission.mockReturnValue(true)
    const router = await createTestRouter()

    await router.push('/user/manage/article/edit/42')

    expect(router.currentRoute.value.name).toBe('ManageEditArticle')
    expect(router.currentRoute.value.params.id).toBe('42')
    expect(adminStore.hasPermission).toHaveBeenCalledWith('article.write')
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
    adminStore.canManage = true
    adminStore.hasPermission.mockImplementation((permission: string) => permission !== 'system.config')
    const router = await createTestRouter()

    await router.push('/user/manage/integrity-proof')

    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(adminStore.hasPermission).toHaveBeenCalledWith('system.config')
    expect(router.currentRoute.value.path).toBe('/403')
  })

})
