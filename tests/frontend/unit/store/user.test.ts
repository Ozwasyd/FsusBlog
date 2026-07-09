import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '@/store/user'

vi.mock('@/api/auth', () => ({
  getMe: vi.fn(),
  logout: vi.fn()
}))

vi.mock('@/services/notificationStreamRuntime', () => ({
  notificationStreamRuntime: {
    stop: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/store/notificationStream', () => ({
  useNotificationStreamStore: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    resetCursor: vi.fn(),
    setStatus: vi.fn()
  })
}))

import { getMe, logout as logoutApi } from '@/api/auth'
const mockGetMe = vi.mocked(getMe)
const mockLogout = vi.mocked(logoutApi)

describe('useUserStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    localStorage.clear()
    sessionStorage.clear()
  })

  it('initial state is unauthenticated', () => {
    const store = useUserStore()
    expect(store.userInfo).toBeNull()
    expect(store.accountState).toBe('unknown')
    expect(store.isAuthChecked).toBe(false)
    expect(store.isLoggedIn).toBe(false)
    expect(store.isAdmin).toBe(false)
    expect(store.isBanned).toBe(false)
    expect(store.isDeleted).toBe(false)
  })

  it('markAuthenticated sets user and marks checked', () => {
    const store = useUserStore()
    const mockUser = anonymousUser(1)
    store.markAuthenticated(mockUser)
    expect(store.userInfo).toStrictEqual(mockUser)
    expect(store.userInfo).toEqual(expect.objectContaining({
      accountId: 1,
      publicHandle: 'public-1',
      identityKind: 'anonymous_account'
    }))
    expect(Object.prototype.hasOwnProperty.call(store.userInfo, 'user' + 'Name')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(store.userInfo, 'User' + 'Id')).toBe(false)
    expect(store.accountState).toBe('authenticated')
    expect(store.isAuthChecked).toBe(true)
    expect(store.isLoggedIn).toBe(true)
  })

  it('markGuest clears user and records a checked guest state', () => {
    const store = useUserStore()
    const mockUser = anonymousUser(1)
    store.markAuthenticated(mockUser)
    store.markGuest()
    expect(store.userInfo).toBeNull()
    expect(store.accountState).toBe('guest')
    expect(store.isLoggedIn).toBe(false)
  })

  it('isAdmin stays false for anonymous account snapshots', () => {
    const store = useUserStore()
    store.markAuthenticated(anonymousUser(1) as never)
    expect(store.isAdmin).toBe(false)
  })

  it('isBanned returns true for status 1', () => {
    const store = useUserStore()
    store.markAuthenticated({ ...anonymousUser(1), status: 1, banReason: 'spam' } as never)
    expect(store.isBanned).toBe(true)
  })

  it('isDeleted returns true for status 2', () => {
    const store = useUserStore()
    store.markAuthenticated({ ...anonymousUser(1), status: 2 } as never)
    expect(store.isDeleted).toBe(true)
  })

  it('fetchUserInfo sets userInfo on success', async () => {
    const mockUser = anonymousUser(1)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toEqual(mockUser)
    expect(store.accountState).toBe('authenticated')
    expect(store.isAuthChecked).toBe(true)
    expect(store.lastFetchedAt).toBeGreaterThan(0)
    expect(store.lastVerifiedAt).toBeGreaterThan(0)
  })

  it('fetchUserInfo caches guest state after 401', async () => {
    const { createAppError, AppErrorCode } = await import('@/utils/appError')
    const authErr = createAppError(AppErrorCode.Unauthorized, 'not authenticated')
    mockGetMe.mockRejectedValueOnce(authErr)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toBeNull()
    expect(store.accountState).toBe('guest')
    expect(store.isAuthChecked).toBe(true)
    expect(store.lastFetchedAt).toBeGreaterThan(0)
    expect(store.lastVerifiedAt).toBeGreaterThan(0)
  })

  it('fetchUserInfo does nothing if already authenticated', async () => {
    mockGetMe.mockResolvedValueOnce(anonymousUser(1) as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    await store.fetchUserInfo() // should skip
    expect(mockGetMe).toHaveBeenCalledTimes(1)
  })

  it('fetchUserInfo skips fresh guest negative cache', async () => {
    const { createAppError, AppErrorCode } = await import('@/utils/appError')
    const authErr = createAppError(AppErrorCode.Unauthorized, 'not authenticated')
    mockGetMe.mockRejectedValueOnce(authErr)
    const store = useUserStore()

    await store.fetchUserInfo()
    await store.fetchUserInfo()

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.accountState).toBe('guest')
  })

  it('fetchUserInfo retries expired guest negative cache', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.markGuest()
    store.lastVerifiedAt = Date.now() - 301_000
    store.lastFetchedAt = store.lastVerifiedAt

    await store.fetchUserInfo()

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.accountState).toBe('authenticated')
    expect(store.userInfo).toEqual(mockUser)
  })

  it('fetchUserInfo force bypasses guest negative cache', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.markGuest()

    await store.fetchUserInfo(true)

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.accountState).toBe('authenticated')
    expect(store.userInfo).toEqual(mockUser)
  })

  it('network failure does not mark guest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetMe.mockRejectedValueOnce(new Error('network down'))
    const store = useUserStore()

    await store.fetchUserInfo()

    expect(store.userInfo).toBeNull()
    expect(store.accountState).toBe('unknown')
    expect(store.isAuthChecked).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[UserStore] Auth handshake failed:', 'network down')
    errorSpy.mockRestore()
  })

  it('legacy persisted isAuthChecked without accountState migrates to unknown', async () => {
    localStorage.setItem('fsus_user_storage', JSON.stringify({ isAuthChecked: true }))
    const store = useUserStore()
    expect(store.accountState).toBe('unknown')
    expect(store.isAuthChecked).toBe(false)
  })

  it('fetchUserInfo refreshes when only bootstrap marker was restored', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.accountState = 'unknown'
    store.userInfo = null

    await store.fetchUserInfo()

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('ensureUserInfoFresh reuses recent user info', async () => {
    const store = useUserStore()
    store.markAuthenticated(anonymousUser(1) as never)

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000 })

    expect(mockGetMe).not.toHaveBeenCalled()
  })

  it('ensureUserInfoFresh refreshes stale user info', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.markAuthenticated(anonymousUser(1) as never)
    store.lastVerifiedAt = Date.now() - 31_000
    store.lastFetchedAt = store.lastVerifiedAt

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000 })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('ensureUserInfoFresh fetches when only auth marker is known', async () => {
    const mockUser = anonymousUser(3)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.accountState = 'unknown'
    store.userInfo = null
    store.lastFetchedAt = 0

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('updateStatus updates userInfo status', () => {
    const store = useUserStore()
    store.markAuthenticated(anonymousUser(1) as never)
    store.updateStatus(1, 'spam')
    expect(store.userInfo?.status).toBe(1)
    expect(store.userInfo?.banReason).toBe('spam')
  })

  it('updateStatus does nothing when userInfo is null', () => {
    const store = useUserStore()
    expect(() => store.updateStatus(1, null)).not.toThrow()
  })

  it('logout calls logoutApi and clears state', async () => {
    mockLogout.mockResolvedValueOnce(undefined)
    const store = useUserStore()
    store.markAuthenticated(anonymousUser(1) as never)
    await store.logout()
    expect(mockLogout).toHaveBeenCalled()
    expect(store.userInfo).toBeNull()
    expect(store.accountState).toBe('guest')
  })
})

function anonymousUser(id: number) {
  return {
    accountId: id,
    identityKind: 'anonymous_account',
    publicHandle: `public-${id}`,
    passkeyEnabled: true,
    recoveryEnabled: true,
    totpStepUpEnabled: false,
    anonymousCredentialStatus: 'active',
    anonymousCredentialLevel: 'basic',
    status: 0,
    banReason: null,
    deletedAt: null
  }
}
