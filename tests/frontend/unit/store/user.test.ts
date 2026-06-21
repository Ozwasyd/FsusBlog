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
    sessionStorage.clear()
  })

  it('initial state is unauthenticated', () => {
    const store = useUserStore()
    expect(store.userInfo).toBeNull()
    expect(store.isAuthChecked).toBe(false)
    expect(store.isLoggedIn).toBe(false)
    expect(store.isAdmin).toBe(false)
    expect(store.isBanned).toBe(false)
    expect(store.isDeleted).toBe(false)
  })

  it('setUserInfo sets user and marks checked', () => {
    const store = useUserStore()
    const mockUser = anonymousUser(1)
    store.setUserInfo(mockUser)
    expect(store.userInfo).toStrictEqual(mockUser)
    expect(store.isAuthChecked).toBe(true)
    expect(store.isLoggedIn).toBe(true)
  })

  it('setUserInfo with null clears state', () => {
    const store = useUserStore()
    const mockUser = anonymousUser(1)
    store.setUserInfo(mockUser)
    store.setUserInfo(null)
    expect(store.userInfo).toBeNull()
    expect(store.isLoggedIn).toBe(false)
  })

  it('isAdmin stays false for anonymous account snapshots', () => {
    const store = useUserStore()
    store.setUserInfo(anonymousUser(1) as never)
    expect(store.isAdmin).toBe(false)
  })

  it('isBanned returns true for status 1', () => {
    const store = useUserStore()
    store.setUserInfo({ ...anonymousUser(1), status: 1, banReason: 'spam' } as never)
    expect(store.isBanned).toBe(true)
  })

  it('isDeleted returns true for status 2', () => {
    const store = useUserStore()
    store.setUserInfo({ ...anonymousUser(1), status: 2 } as never)
    expect(store.isDeleted).toBe(true)
  })

  it('fetchUserInfo sets userInfo on success', async () => {
    const mockUser = anonymousUser(1)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toEqual(mockUser)
    expect(store.isAuthChecked).toBe(true)
    expect(store.lastFetchedAt).toBeGreaterThan(0)
  })

  it('fetchUserInfo sets checked on 401 error', async () => {
    const { createAppError, AppErrorCode } = await import('@/utils/appError')
    const authErr = createAppError(AppErrorCode.Unauthorized, 'not authenticated')
    mockGetMe.mockRejectedValueOnce(authErr)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toBeNull()
    expect(store.isAuthChecked).toBe(true)
    expect(store.lastFetchedAt).toBeGreaterThan(0)
  })

  it('fetchUserInfo does nothing if already checked', async () => {
    mockGetMe.mockResolvedValueOnce({ id: 1 } as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    await store.fetchUserInfo() // should skip
    expect(mockGetMe).toHaveBeenCalledTimes(1)
  })

  it('fetchUserInfo refreshes when only bootstrap marker was restored', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.isAuthChecked = true
    store.userInfo = null

    await store.fetchUserInfo()

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('ensureUserInfoFresh reuses recent user info', async () => {
    const store = useUserStore()
    store.setUserInfo(anonymousUser(1) as never)

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000 })

    expect(mockGetMe).not.toHaveBeenCalled()
  })

  it('ensureUserInfoFresh refreshes stale user info', async () => {
    const mockUser = anonymousUser(2)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.setUserInfo(anonymousUser(1) as never)
    store.lastFetchedAt = Date.now() - 31_000

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000 })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('ensureUserInfoFresh fetches when only auth marker is known', async () => {
    const mockUser = anonymousUser(3)
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.isAuthChecked = true
    store.userInfo = null
    store.lastFetchedAt = 0

    await store.ensureUserInfoFresh({ maxAgeMs: 30_000, forceWhenUnknown: true })

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('updateStatus updates userInfo status', () => {
    const store = useUserStore()
    store.setUserInfo(anonymousUser(1) as never)
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
    store.setUserInfo(anonymousUser(1) as never)
    await store.logout()
    expect(mockLogout).toHaveBeenCalled()
    expect(store.userInfo).toBeNull()
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
