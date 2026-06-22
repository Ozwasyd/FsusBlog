import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import type { Router } from 'vue-router'

const ensureBootstrap = vi.fn<() => Promise<void>>()
const ensurePublicShell = vi.fn<() => Promise<void>>()
const ensureAccountSession = vi.fn<() => Promise<void>>()
const ensureAdminSession = vi.fn<() => Promise<void>>()
const syncDocumentTitle = vi.fn()
let hasServerAotShellResult = false

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

function ensureBrowserLocation(): void {
  if (typeof globalThis.history === 'undefined' && typeof window !== 'undefined') {
    Object.defineProperty(globalThis, 'history', {
      value: window.history,
      configurable: true
    })
  }

  if (typeof globalThis.location === 'undefined') {
    Object.defineProperty(globalThis, 'location', {
      value: window.location,
      configurable: true
    })
  }
}

async function loadRouterModule() {
  ensureBrowserLocation()
  const originalWindow = globalThis.window
  Reflect.deleteProperty(globalThis, 'window')
  try {
    return await import('@/router')
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
  }
}

async function createTestRouter(): Promise<Router> {
  const { createAppRouter } = await loadRouterModule()
  return createAppRouter({
    history: createMemoryHistory(),
    ssr: false
  })
}

describe('account router meta and guards', () => {
  beforeEach(() => {
    ensureBootstrap.mockClear()
    ensurePublicShell.mockClear()
    ensureAccountSession.mockClear()
    ensureAdminSession.mockClear()
    syncDocumentTitle.mockClear()
    hasServerAotShellResult = false
    document.body.innerHTML = ''
    adminStore.adminState = 'unknown'
    adminStore.canManage = false
    adminStore.hasPermission.mockClear()
    userStore.isLoggedIn = true
    siteStore.isLoaded = true
  })

  it('keeps /user authenticated without legacy role meta', async () => {
    const { APP_ROUTE_RECORDS } = await loadRouterModule()
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

  it('guestOnly route probes account only', async () => {
    userStore.isLoggedIn = false
    const router = await createTestRouter()

    await router.push('/login')

    expect(ensureAccountSession).toHaveBeenCalledTimes(1)
    expect(ensureAccountSession).toHaveBeenCalledWith({ reason: 'route' })
    expect(ensureAdminSession).not.toHaveBeenCalled()
  }, 15_000)

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

  it('manage route checks required permissions after admin probe', async () => {
    adminStore.canManage = true
    adminStore.hasPermission.mockReturnValue(false)
    const router = await createTestRouter()

    await router.push('/user/manage/article/write')

    expect(ensureAdminSession).toHaveBeenCalledTimes(1)
    expect(adminStore.hasPermission).toHaveBeenCalledWith('article.write')
    expect(router.currentRoute.value.path).toBe('/403')
  })

  it('statically blocks legacy router role meta checks from returning', () => {
    const routerSourcePath = fileURLToPath(new URL('../../../../src/frontend/src/router/index.ts', import.meta.url))
    const routerSource = readFileSync(routerSourcePath, 'utf8')

    expect(routerSource).not.toMatch(/\bmeta\b[^\n]*\broles\b/)
    expect(routerSource).not.toContain('to.meta.roles')
  })
})
