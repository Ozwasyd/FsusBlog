import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'

const bootstrap = vi.fn().mockResolvedValue(undefined)
const setRuntimePhase = vi.fn()
const syncAuthPhase = vi.fn()
const fetchSiteInfo = vi.fn().mockResolvedValue(undefined)
const fetchUserInfo = vi.fn().mockResolvedValue(undefined)
const ensureUserInfoFresh = vi.fn().mockResolvedValue(undefined)
const ensureAdminSessionFresh = vi.fn().mockResolvedValue(undefined)

vi.mock('@/store/appShell', () => ({
  useAppShellStore: vi.fn(() => ({
    isReady: false,
    bootstrap,
    setRuntimePhase,
    syncAuthPhase,
    markSessionRefreshing: vi.fn(),
    markSessionActive: vi.fn(),
    markSessionExpired: vi.fn(),
    setRiskPhase: vi.fn()
  }))
}))

vi.mock('@/store/site', () => ({
  useSiteStore: vi.fn(() => ({
    isLoaded: false,
    siteInfo: { title: 'Fsu' },
    fetchSiteInfo
  }))
}))

vi.mock('@/store/user', () => ({
  useUserStore: vi.fn(() => ({
    accountState: 'unknown',
    isAuthChecked: false,
    isLoggedIn: false,
    userInfo: null,
    fetchUserInfo,
    ensureUserInfoFresh
  }))
}))

vi.mock('@/store/admin', () => ({
  useAdminStore: vi.fn(() => ({
    ensureAdminSessionFresh
  }))
}))

describe('useSessionBootstrap', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('ensurePublicShell does not call fetchUserInfo', async () => {
    const bootstrapper = useSessionBootstrap()

    await bootstrapper.ensurePublicShell()

    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(setRuntimePhase).toHaveBeenCalledWith('shell-visible')
    expect(fetchUserInfo).not.toHaveBeenCalled()
  })

  it('ensurePublicShell does not call ensureAdminSessionFresh', async () => {
    const bootstrapper = useSessionBootstrap()

    await bootstrapper.ensurePublicShell()

    expect(ensureAdminSessionFresh).not.toHaveBeenCalled()
  })

  it('ensureAccountSession calls only account store', async () => {
    const bootstrapper = useSessionBootstrap()

    await bootstrapper.ensureAccountSession({ force: true, reason: 'route' })

    expect(fetchUserInfo).toHaveBeenCalledWith(true)
    expect(ensureAdminSessionFresh).not.toHaveBeenCalled()
    expect(syncAuthPhase).toHaveBeenCalledTimes(1)
  })

  it('ensureAccountSession can use freshness options without admin probing', async () => {
    const bootstrapper = useSessionBootstrap()

    await bootstrapper.ensureAccountSession({
      maxAgeMs: 30_000,
      forceWhenUnknown: true,
      reason: 'route'
    })

    expect(ensureUserInfoFresh).toHaveBeenCalledWith({
      maxAgeMs: 30_000,
      forceWhenUnknown: true
    })
    expect(ensureAdminSessionFresh).not.toHaveBeenCalled()
  })

  it('ensureAdminSession calls only admin store', async () => {
    const bootstrapper = useSessionBootstrap()

    await bootstrapper.ensureAdminSession({ reason: 'route' })

    expect(ensureAdminSessionFresh).toHaveBeenCalledTimes(1)
    expect(fetchUserInfo).not.toHaveBeenCalled()
    expect(ensureUserInfoFresh).not.toHaveBeenCalled()
  })

  it('needsBootstrap ignores account session state for public shell readiness', () => {
    const bootstrapper = useSessionBootstrap()

    expect(bootstrapper.needsBootstrap()).toBe(true)
  })
})
