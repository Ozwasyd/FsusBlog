import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  ADMIN_ACTIVE_TTL_MS,
  AdminLogoutCleanupError,
  AdminLogoutUnconfirmedError,
  ADMIN_NEGATIVE_CACHE_MS,
  useAdminStore
} from '@/store/admin'
import { getAccountNavGroups } from '@/layouts/accountNav'

vi.mock('@/api/auth', () => ({
  getAdminMe: vi.fn(),
  logoutAdmin: vi.fn()
}))

vi.mock('@/services/serviceWorkerRuntime', () => ({
  clearPrivateBrowserState: vi.fn().mockResolvedValue(undefined)
}))

import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'
import { getAdminMe, logoutAdmin } from '@/api/auth'

const mockGetAdminMe = vi.mocked(getAdminMe)
const mockLogoutAdmin = vi.mocked(logoutAdmin)
const mockClearPrivateBrowserState = vi.mocked(clearPrivateBrowserState)

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error('Deferred resolver was not initialized')
  }
  let reject: (reason?: unknown) => void = () => {
    throw new Error('Deferred rejecter was not initialized')
  }
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return { promise, resolve, reject }
}

describe('useAdminStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
    mockLogoutAdmin.mockResolvedValue(null)
    mockClearPrivateBrowserState.mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not expose a legacy user-role admin bridge', () => {
    const store = useAdminStore()

    expect('syncLegacyAdminPrincipal' in store).toBe(false)
    expect(store.adminState).toBe('unknown')
    expect(store.adminSessionStatus).toBe('missing')
    expect(store.canManage).toBe(false)
    expect(store.permissions).toEqual([])
  })

  it('keeps independent admin principals separate from normal account role', () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['comment.moderate'],
      adminSessionStatus: 'active'
    })

    expect(store.canManage).toBe(true)
    expect(store.adminState).toBe('active')
    expect(store.hasPermission('comment.moderate')).toBe(true)
    expect(store.hasPermission('article.write')).toBe(false)
  })

  it('does not treat legacy.admin as a wildcard permission', () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['legacy.admin'],
      adminSessionStatus: 'active'
    })

    expect(store.canManage).toBe(true)
    expect(store.hasPermission('legacy.admin')).toBe(true)
    expect(store.hasPermission('system.config')).toBe(false)

    const groups = getAccountNavGroups({
      surface: 'manage',
      canManage: store.canManage,
      permissions: store.permissions,
      features: {
        anonymousCommentsEnabled: true,
        zkAnonymousEnabled: true,
        publicSendOptionEnabled: true
      },
      policies: {
        anonymousCommentGovernanceAvailable: true,
        zkAnonymousConfigurable: true
      }
    })
    const labels = groups.flatMap((group) => group.items.map((item) => item.label))

    expect(groups).toEqual([])
    expect(labels).not.toContain('仪表盘')
    expect(labels).not.toContain('安全系统')
    expect(labels).not.toContain('用户')
  })

  it('hydrates independent admin principals from the admin session endpoint', async () => {
    mockGetAdminMe.mockResolvedValue({
      id: '1',
      displayName: 'local-root',
      source: 'independent',
      permissions: ['admin.manage', 'article.write'],
      adminSessionStatus: 'active',
      totpStepUpRequired: false
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh(null)

    expect(mockGetAdminMe).toHaveBeenCalledTimes(1)
    expect(store.adminState).toBe('active')
    expect(store.canManage).toBe(true)
    expect(store.hasPermission('admin.manage')).toBe(true)
    expect(store.hasPermission('article.write')).toBe(true)
  })

  it('ensureAdminSessionFresh caches missing admin session after 401', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockRejectedValue({
      name: 'HttpApiError',
      message: 'unauthorized',
      status: 401
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()

    expect(mockGetAdminMe).toHaveBeenCalledTimes(1)
    expect(store.adminState).toBe('missing')
    expect(store.adminPrincipal).toBeNull()
    expect(store.adminCheckedAt).toBe(Date.now())
  })

  it('ensureAdminSessionFresh skips fresh missing state', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockRejectedValue({
      name: 'HttpApiError',
      message: 'unauthorized',
      status: 401
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()
    await store.ensureAdminSessionFresh()

    expect(mockGetAdminMe).toHaveBeenCalledTimes(1)
  })

  it('ensureAdminSessionFresh force bypasses missing cache', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockRejectedValue({
      name: 'HttpApiError',
      message: 'unauthorized',
      status: 401
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()
    await store.ensureAdminSessionFresh({ force: true })

    expect(mockGetAdminMe).toHaveBeenCalledTimes(2)
  })

  it('ensureAdminSessionFresh revalidates expired missing cache', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockRejectedValue({
      name: 'HttpApiError',
      message: 'unauthorized',
      status: 401
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()
    vi.setSystemTime(new Date(Date.now() + ADMIN_NEGATIVE_CACHE_MS + 1))
    await store.ensureAdminSessionFresh()

    expect(mockGetAdminMe).toHaveBeenCalledTimes(2)
  })

  it('reuses active admin session inside the short TTL', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockResolvedValue({
      id: '1',
      displayName: 'local-root',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()
    vi.setSystemTime(new Date(Date.now() + ADMIN_ACTIVE_TTL_MS - 1))
    await store.ensureAdminSessionFresh()

    expect(mockGetAdminMe).toHaveBeenCalledTimes(1)
    expect(store.canManage).toBe(true)
  })

  it('refreshes active admin session after the short TTL', async () => {
    vi.setSystemTime(new Date('2026-06-22T00:00:00Z'))
    mockGetAdminMe.mockResolvedValue({
      id: '1',
      displayName: 'local-root',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh()
    vi.setSystemTime(new Date(Date.now() + ADMIN_ACTIVE_TTL_MS + 1))
    await store.ensureAdminSessionFresh()

    expect(mockGetAdminMe).toHaveBeenCalledTimes(2)
  })

  it('canManage requires active state and permissions', () => {
    const store = useAdminStore()

    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: [],
      adminSessionStatus: 'active'
    })
    expect(store.canManage).toBe(false)

    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'expired'
    })
    expect(store.canManage).toBe(false)
  })

  it('step_up_required is not canManage', () => {
    const store = useAdminStore()

    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'step_up_required',
      totpStepUpRequired: true
    })

    expect(store.adminState).toBe('step_up_required')
    expect(store.canManage).toBe(false)
    expect(store.totpStepUpRequired).toBe(true)
  })

  it('network failure does not overwrite existing active principal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetAdminMe.mockRejectedValue(new Error('network down'))
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    await store.ensureAdminSessionFresh({ force: true })

    expect(store.adminState).toBe('active')
    expect(store.canManage).toBe(true)
    expect(store.adminPrincipal?.id).toBe('admin-principal')
    warnSpy.mockRestore()
  })

  it('forced revalidation consumes a missing cache before a network failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockGetAdminMe.mockRejectedValue(new Error('network down'))
    const store = useAdminStore()
    store.markMissing()

    await store.ensureAdminSessionFresh({ force: true })

    expect(store.adminState).toBe('unknown')
    expect(store.adminPrincipal).toBeNull()
    expect(store.adminCheckedAt).toBe(0)
    expect(store.canManage).toBe(false)
    warnSpy.mockRestore()
  })

  it('never grants permissions from a principal while the session is a negative cache', () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'stale-admin',
      displayName: 'Stale Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    store.adminState = 'missing'

    expect(store.permissions).toEqual([])
    expect(store.hasPermission('admin.manage')).toBe(false)
    expect(store.canManage).toBe(false)
  })

  it('revokes the server session before local cleanup and broadcast', async () => {
    const order: string[] = []
    mockLogoutAdmin.mockImplementation(async () => {
      order.push('server')
      return null
    })
    mockClearPrivateBrowserState.mockImplementation(async () => {
      order.push('private')
      return {} as never
    })
    const store = useAdminStore()
    store.setLogoutBroadcast(() => order.push('broadcast'))
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    const outcome = await store.logout()

    expect(outcome).toEqual({
      status: 'revoked',
      serverRevocationConfirmed: true,
      localCleanupComplete: true
    })
    expect(order).toEqual(['server', 'private', 'broadcast'])
    expect(clearPrivateBrowserState).toHaveBeenCalledWith('admin-logout')
    expect(store.adminState).toBe('missing')
    expect(store.adminPrincipal).toBeNull()
  })

  it('treats 401 as an already inactive server session', async () => {
    mockLogoutAdmin.mockRejectedValue({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'admin session missing'
    })
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    await expect(store.logout()).resolves.toEqual({
      status: 'already_inactive',
      serverRevocationConfirmed: true,
      localCleanupComplete: true
    })
    expect(store.adminState).toBe('missing')
  })

  it('fails closed without claiming success after a network failure', async () => {
    mockLogoutAdmin.mockRejectedValue({
      name: 'BinaryTransportError',
      kind: 'network',
      message: 'offline'
    })
    const broadcast = vi.fn()
    const store = useAdminStore()
    store.setLogoutBroadcast(broadcast)
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })

    await expect(store.logout()).rejects.toBeInstanceOf(AdminLogoutUnconfirmedError)

    expect(store.lastLogoutOutcome).toEqual({
      status: 'local_only',
      serverRevocationConfirmed: false,
      localCleanupComplete: true
    })
    expect(store.adminState).toBe('missing')
    expect(broadcast).toHaveBeenCalledOnce()
  })

  it('does not report a fully clean logout when private cleanup fails', async () => {
    mockClearPrivateBrowserState
      .mockRejectedValueOnce(new Error('private cleanup failed'))
      .mockResolvedValueOnce({} as never)
    const broadcast = vi.fn()
    const store = useAdminStore()
    store.setLogoutBroadcast(broadcast)

    await expect(store.logout()).rejects.toBeInstanceOf(AdminLogoutCleanupError)
    expect(store.lastLogoutOutcome).toEqual({
      status: 'revoked',
      serverRevocationConfirmed: true,
      localCleanupComplete: false
    })
    expect(broadcast).toHaveBeenCalledOnce()

    await expect(store.logout()).resolves.toEqual({
      status: 'revoked',
      serverRevocationConfirmed: true,
      localCleanupComplete: true
    })
    expect(mockLogoutAdmin).toHaveBeenCalledOnce()
    expect(mockClearPrivateBrowserState).toHaveBeenCalledTimes(2)
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('reports broadcast failure as incomplete local cleanup', async () => {
    const store = useAdminStore()
    store.setLogoutBroadcast(() => {
      throw new Error('broadcast unavailable')
    })

    await expect(store.logout()).rejects.toBeInstanceOf(AdminLogoutCleanupError)
    expect(store.lastLogoutOutcome).toEqual({
      status: 'revoked',
      serverRevocationConfirmed: true,
      localCleanupComplete: false
    })
  })

  it('deduplicates concurrent logout and reuses a confirmed result', async () => {
    const pendingLogout = createDeferred<null>()
    mockLogoutAdmin.mockReturnValue(pendingLogout.promise)
    const store = useAdminStore()

    const first = store.logout()
    const second = store.logout()
    expect(mockLogoutAdmin).toHaveBeenCalledTimes(1)
    pendingLogout.resolve(null)

    const [firstOutcome, secondOutcome] = await Promise.all([first, second])
    expect(firstOutcome).toEqual(secondOutcome)

    await store.logout()
    expect(mockLogoutAdmin).toHaveBeenCalledTimes(1)
  })

  it('cancels a stale admin snapshot before it can restore logged-out state', async () => {
    const pendingSnapshot = createDeferred<Awaited<ReturnType<typeof getAdminMe>>>()
    mockGetAdminMe.mockImplementation(({ signal } = {}) => {
      signal?.addEventListener('abort', () => pendingSnapshot.reject(new DOMException('aborted', 'AbortError')))
      return pendingSnapshot.promise
    })
    const store = useAdminStore()
    const refresh = store.ensureAdminSessionFresh({ force: true })

    await store.logout()
    pendingSnapshot.resolve({
      id: 'stale-admin',
      displayName: 'Stale Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    await refresh

    expect(store.adminState).toBe('missing')
    expect(store.adminPrincipal).toBeNull()
  })

  it('does not restore admin permissions after reload once the server session is revoked', async () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['admin.manage'],
      adminSessionStatus: 'active'
    })
    await store.logout()

    setActivePinia(createPinia())
    mockGetAdminMe.mockRejectedValue({
      name: 'BinaryTransportError',
      kind: 'auth_failed',
      message: 'admin session revoked'
    })
    const reloadedStore = useAdminStore()
    await reloadedStore.ensureAdminSessionFresh({ force: true })

    expect(reloadedStore.adminState).toBe('missing')
    expect(reloadedStore.adminPrincipal).toBeNull()
    expect(reloadedStore.canManage).toBe(false)
  })

  it('clears only the admin fixture marker during admin logout', async () => {
    sessionStorage.setItem('fsusblog_local_fixture_session', '1')
    sessionStorage.setItem('fsusblog_local_fixture_admin_session', '1')
    const store = useAdminStore()

    await store.logout()

    expect(sessionStorage.getItem('fsusblog_local_fixture_session')).toBe('1')
    expect(sessionStorage.getItem('fsusblog_local_fixture_admin_session')).toBeNull()
  })

  it('derives anonymous comment policy states for manage workspace controls', () => {
    const store = useAdminStore()

    store.setAnonymousCommentPolicy({
      anonymousCommentsEnabled: false,
      publicSendOptionEnabled: true,
      zkAnonymousEnabled: true
    })

    expect(store.publicOnlyMode).toBe(true)
    expect(store.anonymousCommentsEnabled).toBe(false)
    expect(store.zkAnonymousEnabled).toBe(true)
  })
})
