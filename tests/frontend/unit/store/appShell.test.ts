import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAppShellStore } from '@/store/appShell'

vi.mock('@/store/site', () => ({
  useSiteStore: vi.fn().mockReturnValue({
    fetchSiteInfo: vi.fn().mockResolvedValue(undefined)
  })
}))

vi.mock('@/store/user', () => ({
  useUserStore: vi.fn().mockReturnValue({
    fetchUserInfo: vi.fn().mockResolvedValue(undefined),
    accountState: 'unknown',
    isLoggedIn: false
  })
}))

describe('useAppShellStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('initial state is idle', () => {
    const store = useAppShellStore()
    expect(store.bootstrapPhase).toBe('idle')
    expect(store.authPhase).toBe('unknown')
    expect(store.runtimePhase).toBe('shell-visible')
    expect(store.sessionPhase).toBe('active')
    expect(store.riskPhase).toBe('normal')
    expect(store.isReady).toBe(false)
  })

  it('bootstrap transitions to ready', async () => {
    const store = useAppShellStore()
    await store.bootstrap()
    expect(store.bootstrapPhase).toBe('ready')
    expect(store.isReady).toBe(true)
    expect(store.authPhase).toBe('unknown')
  })

  it('bootstrap caches the promise on second call', async () => {
    const { useSiteStore } = await import('@/store/site')
    const { useUserStore } = await import('@/store/user')
    const siteMock = vi.mocked(useSiteStore)
    const userMock = vi.mocked(useUserStore)

    const store = useAppShellStore()
    await store.bootstrap()
    await store.bootstrap() // second call should return cached promise
    expect(siteMock().fetchSiteInfo).toHaveBeenCalledTimes(1)
    expect(userMock().fetchUserInfo).not.toHaveBeenCalled()
  })

  it('bootstrap with force=true re-bootstraps', async () => {
    const store = useAppShellStore()
    await store.bootstrap()
    await store.bootstrap(true)
    // force re-run is allowed
    expect(store.bootstrapPhase).toBe('ready')
  })

  it('bootstrap transitions to error on failure', async () => {
    const { useSiteStore } = await import('@/store/site')
    vi.mocked(useSiteStore).mockReturnValue({
      fetchSiteInfo: vi.fn().mockRejectedValueOnce(new Error('fetch failed'))
    } as never)

    setActivePinia(createPinia()) // fresh pinia so mock takes effect
    const store = useAppShellStore()
    await store.bootstrap()
    expect(store.bootstrapPhase).toBe('error')
    expect(store.bootstrapError).toBeTruthy()
  })

  it('setRuntimePhase updates runtimePhase', () => {
    const store = useAppShellStore()
    store.setRuntimePhase('runtime-loading')
    expect(store.runtimePhase).toBe('runtime-loading')
    store.setRuntimePhase('runtime-ready')
    expect(store.runtimePhase).toBe('runtime-ready')
  })

  it('markSessionExpired sets session expired and authPhase to guest', () => {
    const store = useAppShellStore()
    store.markSessionExpired()
    expect(store.sessionPhase).toBe('expired')
    expect(store.authPhase).toBe('guest')
  })

  it('markSessionActive sets session active', () => {
    const store = useAppShellStore()
    store.markSessionExpired()
    store.markSessionActive()
    expect(store.sessionPhase).toBe('active')
  })

  it('markSessionRefreshing sets session refreshing', () => {
    const store = useAppShellStore()
    store.markSessionRefreshing()
    expect(store.sessionPhase).toBe('refreshing')
  })

  it('setRiskPhase updates riskPhase', () => {
    const store = useAppShellStore()
    store.setRiskPhase('elevated')
    expect(store.riskPhase).toBe('elevated')
    store.setRiskPhase('normal')
    expect(store.riskPhase).toBe('normal')
  })

  it('syncAuthPhase reflects user login status', async () => {
    const { useUserStore } = await import('@/store/user')
    vi.mocked(useUserStore).mockReturnValue({
      fetchUserInfo: vi.fn().mockResolvedValue(undefined),
      accountState: 'authenticated',
      isLoggedIn: true
    } as never)

    setActivePinia(createPinia())
    const store = useAppShellStore()
    store.syncAuthPhase()
    expect(store.authPhase).toBe('authenticated')
  })
})
