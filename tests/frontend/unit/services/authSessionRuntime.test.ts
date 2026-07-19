import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import { useAdminStore } from '@/store/admin'
import { useUserStore } from '@/store/user'

vi.mock('@/api/auth', () => ({
  refreshToken: vi.fn(),
  getMe: vi.fn(),
  logout: vi.fn()
}))

vi.mock('@/services/localFixtureSession', () => ({
  isLocalFixtureSessionActive: vi.fn(() => false),
  ensureLocalFixtureSessionCookies: vi.fn().mockResolvedValue(false),
  clearLocalFixtureSession: vi.fn()
}))

vi.mock('@/services/notificationStreamRuntime', () => ({
  notificationStreamRuntime: {
    stop: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/services/serviceWorkerRuntime', () => ({
  clearPrivateBrowserState: vi.fn().mockResolvedValue(undefined)
}))

describe('authSessionRuntime negative-cache lifecycle', () => {
  beforeEach(() => {
    authSessionRuntime.dispose()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:00:00Z'))
  })

  afterEach(() => {
    authSessionRuntime.dispose()
    vi.useRealTimers()
  })

  it('invalidates account and admin negative caches immediately on focus', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()
    authSessionRuntime.init(pinia)

    window.dispatchEvent(new window.Event('focus'))

    expect(userStore.accountState).toBe('unknown')
    expect(userStore.lastVerifiedAt).toBe(0)
    expect(adminStore.adminState).toBe('unknown')
    expect(adminStore.adminCheckedAt).toBe(0)
  })

  it('invalidates account and admin negative caches when the page becomes visible', () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    const adminStore = useAdminStore(pinia)
    userStore.markGuest()
    adminStore.markMissing()
    authSessionRuntime.init(pinia)
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true
    })

    document.dispatchEvent(new window.Event('visibilitychange'))

    expect(userStore.accountState).toBe('unknown')
    expect(adminStore.adminState).toBe('unknown')
  })
})
