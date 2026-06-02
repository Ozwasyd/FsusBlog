import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUserStore } from '@/store/user'

vi.mock('@/api/auth', () => ({
  getMe: vi.fn(),
  logout: vi.fn()
}))

vi.mock('@/services/sseRuntime', () => ({
  sseRuntime: {
    stop: vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('@/store/sse', () => ({
  useSseStore: vi.fn().mockReturnValue({
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
    const mockUser = { id: 1, username: 'alice', role: 'user', status: 0, banReason: null } as never
    store.setUserInfo(mockUser)
    expect(store.userInfo).toStrictEqual(mockUser)
    expect(store.isAuthChecked).toBe(true)
    expect(store.isLoggedIn).toBe(true)
  })

  it('setUserInfo with null clears state', () => {
    const store = useUserStore()
    const mockUser = { id: 1, username: 'alice', role: 'user', status: 0, banReason: null } as never
    store.setUserInfo(mockUser)
    store.setUserInfo(null)
    expect(store.userInfo).toBeNull()
    expect(store.isLoggedIn).toBe(false)
  })

  it('isAdmin returns true for admin role', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'admin', role: 'admin', status: 0, banReason: null } as never)
    expect(store.isAdmin).toBe(true)
  })

  it('isAdmin returns false for root role', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'root', role: 'root', status: 0, banReason: null } as never)
    expect(store.isAdmin).toBe(false)
  })

  it('isAdmin returns false for regular user', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'alice', role: 'user', status: 0, banReason: null } as never)
    expect(store.isAdmin).toBe(false)
  })

  it('isBanned returns true for status 1', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'alice', role: 'user', status: 1, banReason: 'spam' } as never)
    expect(store.isBanned).toBe(true)
  })

  it('isDeleted returns true for status 2', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'alice', role: 'user', status: 2, banReason: null } as never)
    expect(store.isDeleted).toBe(true)
  })

  it('fetchUserInfo sets userInfo on success', async () => {
    const mockUser = { id: 1, username: 'alice', role: 'user', status: 0, banReason: null }
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toEqual(mockUser)
    expect(store.isAuthChecked).toBe(true)
  })

  it('fetchUserInfo sets checked on 401 error', async () => {
    const { createAppError, AppErrorCode } = await import('@/utils/appError')
    const authErr = createAppError(AppErrorCode.Unauthorized, 'not authenticated')
    mockGetMe.mockRejectedValueOnce(authErr)
    const store = useUserStore()
    await store.fetchUserInfo()
    expect(store.userInfo).toBeNull()
    expect(store.isAuthChecked).toBe(true)
  })

  it('fetchUserInfo does nothing if already checked', async () => {
    mockGetMe.mockResolvedValueOnce({ id: 1 } as never)
    const store = useUserStore()
    await store.fetchUserInfo()
    await store.fetchUserInfo() // should skip
    expect(mockGetMe).toHaveBeenCalledTimes(1)
  })

  it('fetchUserInfo refreshes when only bootstrap marker was restored', async () => {
    const mockUser = { id: 2, username: 'admin', role: 'admin', status: 0, banReason: null }
    mockGetMe.mockResolvedValueOnce(mockUser as never)
    const store = useUserStore()
    store.isAuthChecked = true
    store.userInfo = null

    await store.fetchUserInfo()

    expect(mockGetMe).toHaveBeenCalledTimes(1)
    expect(store.userInfo).toEqual(mockUser)
  })

  it('updateStatus updates userInfo status', () => {
    const store = useUserStore()
    store.setUserInfo({ id: 1, username: 'alice', role: 'user', status: 0, banReason: null } as never)
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
    store.setUserInfo({ id: 1, username: 'alice', role: 'user', status: 0, banReason: null } as never)
    await store.logout()
    expect(mockLogout).toHaveBeenCalled()
    expect(store.userInfo).toBeNull()
  })
})
