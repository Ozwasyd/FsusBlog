import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { authSessionRuntime } from '@/services/authSessionRuntime'
import { useAdminStore } from '@/store/admin'
import { useUserStore } from '@/store/user'
import { getMe, refreshToken } from '@/api/auth'

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
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true })
    vi.mocked(refreshToken).mockReset().mockResolvedValue(null)
    vi.mocked(getMe).mockReset()
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

  it('schedules refresh from the server expiry instead of page startup time', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    const nextSnapshot = snapshot('2026-07-19T00:20:00.000Z')
    vi.mocked(getMe).mockResolvedValue(nextSnapshot)
    userStore.markAuthenticated(snapshot('2026-07-19T00:05:00.000Z'))

    authSessionRuntime.init(pinia)
    await vi.advanceTimersByTimeAsync(179_999)
    expect(refreshToken).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(50)

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(userStore.userInfo?.accessExpiresAtUtc).toBe(nextSnapshot.accessExpiresAtUtc)
  })

  it('uses bounded revalidation backoff after an ambiguous network failure without marking Guest', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    userStore.markAuthenticated(snapshot('2026-07-19T00:02:00.000Z'))
    vi.mocked(refreshToken).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(getMe).mockResolvedValue(snapshot('2026-07-19T00:02:00.000Z'))

    authSessionRuntime.init(pinia)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(50)
    expect(userStore.accountState).toBe('authenticated')
    expect(refreshToken).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(userStore.accountState).toBe('authenticated')
  })

  it('does not replay refresh when post-rotation session revalidation loses the network', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    const refreshedSnapshot = snapshot('2026-07-19T00:20:00.000Z')
    userStore.markAuthenticated(snapshot('2026-07-19T00:02:00.000Z'))
    vi.mocked(getMe)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(refreshedSnapshot)

    authSessionRuntime.init(pinia)
    await vi.advanceTimersByTimeAsync(1_050)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(userStore.accountState).toBe('authenticated')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(getMe).toHaveBeenCalledTimes(2)
    expect(userStore.userInfo?.accessExpiresAtUtc).toBe(refreshedSnapshot.accessExpiresAtUtc)
  })

  it('expires the session when bounded revalidation proves authentication failed', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const userStore = useUserStore(pinia)
    const generationBefore = userStore.authGeneration
    userStore.markAuthenticated(snapshot('2026-07-19T00:02:00.000Z'))
    vi.mocked(refreshToken).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(getMe).mockRejectedValueOnce({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'expired'
    })

    authSessionRuntime.init(pinia)
    await vi.advanceTimersByTimeAsync(1_050)
    expect(userStore.accountState).toBe('authenticated')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(userStore.accountState).toBe('guest')
    expect(userStore.authGeneration).not.toBe(generationBefore)
  })
})

function snapshot(accessExpiresAtUtc: string) {
  return {
    accountId: 7,
    identityKind: 'anonymous_account',
    publicHandle: 'reader',
    passkeyEnabled: true,
    recoveryEnabled: true,
    totpStepUpEnabled: null,
    anonymousCredentialStatus: null,
    anonymousCredentialLevel: null,
    status: 0,
    banReason: null,
    deletedAt: null,
    accessExpiresAtUtc
  }
}
