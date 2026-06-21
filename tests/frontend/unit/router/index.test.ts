import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import type { Router } from 'vue-router'

const ensureBootstrap = vi.fn<() => Promise<void>>()
const ensureUserInfoFresh = vi.fn<() => Promise<void>>()
const syncDocumentTitle = vi.fn()

const userStore = {
  isLoggedIn: true
}

const siteStore = {
  isLoaded: true
}

const adminStore = {
  canManage: false,
  hasPermission: vi.fn((permission: string) => permission === 'admin.manage')
}

vi.mock('@/composables/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    userStore,
    siteStore,
    needsBootstrap: () => false,
    ensureBootstrap,
    ensureUserInfoFresh,
    syncDocumentTitle
  })
}))

vi.mock('@/store/admin', () => ({
  useAdminStore: () => adminStore
}))

vi.mock('@/bootstrap/publicShellPrimitives', () => ({
  hasServerAotShell: () => false
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
    ensureUserInfoFresh.mockClear()
    syncDocumentTitle.mockClear()
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

  it('does not refresh user info for self-service account routes without manage semantics', async () => {
    const router = await createTestRouter()

    await router.push('/user/identity')

    expect(ensureUserInfoFresh).not.toHaveBeenCalled()
  })

  it('refreshes user info before entering manage account routes', async () => {
    adminStore.canManage = true
    const router = await createTestRouter()

    await router.push('/user/manage')

    expect(ensureUserInfoFresh).toHaveBeenCalledTimes(1)
    expect(ensureUserInfoFresh).toHaveBeenCalledWith({
      maxAgeMs: 30_000,
      forceWhenUnknown: true
    })
  })

  it('statically blocks legacy router role meta checks from returning', () => {
    const routerSourcePath = fileURLToPath(new URL('../../../../src/frontend/src/router/index.ts', import.meta.url))
    const routerSource = readFileSync(routerSourcePath, 'utf8')

    expect(routerSource).not.toMatch(/\bmeta\b[^\n]*\broles\b/)
    expect(routerSource).not.toContain('to.meta.roles')
  })
})
