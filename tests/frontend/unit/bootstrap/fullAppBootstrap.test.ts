import { beforeEach, describe, expect, it, vi } from 'vitest'

const appUse = vi.fn()
const appMount = vi.fn()
const fakeApp = {
  config: {
    globalProperties: {} as Record<string, unknown>
  },
  use: appUse,
  mount: appMount
}
const fakeRouter = {
  currentRoute: {
    value: {
      fullPath: '/'
    }
  },
  replace: vi.fn(async () => {}),
  push: vi.fn(async () => {}),
  isReady: vi.fn(async () => {})
}
const createApp = vi.fn(() => fakeApp)
const createPinia = vi.fn(() => ({ use: vi.fn() }))
const createHead = vi.fn(() => ({}))
const scheduleFullAppRuntime = vi.fn()
const scheduleNonCriticalResources = vi.fn()
const removeGlobalLoader = vi.fn()
const disposePublicHydrationApp = vi.fn()
const beginPublicTakeoverCommit = vi.fn(() => true)
const completePublicTakeoverCommit = vi.fn(() => true)
const resetPublicTakeover = vi.fn()
const abortPublicShellLifetime = vi.fn()
const markStartup = vi.fn()
const measureStartup = vi.fn()
const authSessionRuntimeInit = vi.fn()
const beginPublicTakeoverVisualGuard = vi.fn((options: { navigationId: string; timeoutMs?: number }) => ({
  navigationId: options.navigationId,
  timeoutMs: options.timeoutMs ?? 5000
}))
const waitForPublicTakeoverVisualReady = vi.fn(async () => {})

vi.mock('vue', () => ({
  createApp,
  ref: vi.fn((value) => ({ value })),
  shallowRef: vi.fn((value) => ({ value })),
  triggerRef: vi.fn()
}))
vi.mock('pinia', () => ({ createPinia }))
vi.mock('@unhead/vue/client', () => ({ createHead }))
vi.mock('pinia-plugin-persistedstate', () => ({ default: vi.fn() }))
vi.mock('@/App.vue', () => ({ default: {} }))
vi.mock('@/router', () => ({ default: fakeRouter }))
vi.mock('@/fsusui/appContext', () => ({ provideFsusUiAppContext: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({ installFsusUiLoading: vi.fn() }))
vi.mock('@/fsusui/motion', () => ({ FsuMotion: {} }))
vi.mock('@/bootstrap/nonCriticalResources', () => ({ scheduleNonCriticalResources }))
vi.mock('@/bootstrap/runtimeGate', () => ({ scheduleFullAppRuntime }))
vi.mock('@/bootstrap/publicShellPrimitives', () => ({ removeGlobalLoader }))
vi.mock('@/public-renderers/clientHydrate', () => ({ disposePublicHydrationApp }))
vi.mock('@/bootstrap/publicTakeoverState', () => ({
  beginPublicTakeoverCommit,
  completePublicTakeoverCommit,
  resetPublicTakeover
}))
vi.mock('@/bootstrap/publicShellLifetime', () => ({ abortPublicShellLifetime }))
vi.mock('@/bootstrap/startupProfiler', () => ({ markStartup, measureStartup }))
vi.mock('@/services/authSessionRuntime', () => ({
  authSessionRuntime: {
    init: authSessionRuntimeInit
  }
}))
vi.mock('@/bootstrap/publicTakeoverController', () => ({
  DEFAULT_PUBLIC_TAKEOVER_ROUTE_READY_TIMEOUT_MS: 5000,
  beginPublicTakeoverVisualGuard,
  waitForPublicTakeoverVisualReady
}))
vi.mock('@/assets/main.css', () => ({}))

describe('full app bootstrap prepare/commit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="app"><div id="fsus-aot-shell" data-public-hydration-kind="Home">AOT</div></div>'
    window.history.replaceState({}, '', '/current?from=aot')
    fakeRouter.currentRoute.value.fullPath = '/'
  })

  it('prepares the app without clearing or mounting over the public shell', async () => {
    const { prepareFullApp } = await import('@/bootstrap/fullApp')

    const prepared = prepareFullApp({ takeover: 'public-shell', deferRuntime: true })

    expect(prepared.router).toBe(fakeRouter)
    expect(document.querySelector('#app > #fsus-aot-shell')).not.toBeNull()
    expect(appMount).not.toHaveBeenCalled()
    expect(disposePublicHydrationApp).not.toHaveBeenCalled()
    expect(abortPublicShellLifetime).not.toHaveBeenCalled()
    expect(authSessionRuntimeInit).not.toHaveBeenCalled()
    expect(removeGlobalLoader).not.toHaveBeenCalled()
  })

  it('commits a prepared public takeover and replays a captured router intent after mount', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    appMount.mockImplementationOnce((selector: string) => {
      document.querySelector(selector)?.append(document.createElement('main'))
    })

    const prepared = prepareFullApp({ takeover: 'public-shell', deferRuntime: true })
    const currentRoute = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
    await commitPreparedFullApp(prepared, {
      navigationIntent: {
        to: '/archive',
        replace: false
      }
    })

    expect(beginPublicTakeoverCommit).toHaveBeenCalledWith({ reason: 'full-app-bootstrap' })
    expect(abortPublicShellLifetime).toHaveBeenCalledWith('full-app-bootstrap')
    expect(disposePublicHydrationApp).toHaveBeenCalledTimes(1)
    expect(appMount).toHaveBeenCalledWith('#app')
    expect(beginPublicTakeoverVisualGuard).toHaveBeenCalledWith({
      navigationId: '/archive',
      timeoutMs: 5000
    })
    expect(fakeRouter.replace).toHaveBeenCalledWith(currentRoute)
    expect(fakeRouter.push).toHaveBeenCalledWith('/archive')
    expect(fakeRouter.push.mock.invocationCallOrder[0]).toBeGreaterThan(appMount.mock.invocationCallOrder[0])
    expect(waitForPublicTakeoverVisualReady).toHaveBeenCalledWith({
      navigationId: '/archive',
      timeoutMs: 5000
    })
    expect(authSessionRuntimeInit).toHaveBeenCalledTimes(1)
    expect(completePublicTakeoverCommit).toHaveBeenCalledWith({ reason: 'full-app-mounted' })
    expect(scheduleFullAppRuntime).toHaveBeenCalledWith(true, {
      allowIdleActivation: false,
      allowScrollActivation: false
    })
  })

  it('leaves the public shell intact when prepare fails', async () => {
    const { prepareFullApp } = await import('@/bootstrap/fullApp')
    createApp.mockImplementationOnce(() => {
      throw new Error('prepare failed')
    })

    expect(() => prepareFullApp({ takeover: 'public-shell' })).toThrow('prepare failed')

    expect(document.querySelector('#app > #fsus-aot-shell')?.textContent).toBe('AOT')
    expect(disposePublicHydrationApp).not.toHaveBeenCalled()
    expect(appMount).not.toHaveBeenCalled()
    expect(resetPublicTakeover).not.toHaveBeenCalled()
  })

  it('resets public takeover state when commit fails', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    appMount.mockImplementationOnce(() => {
      throw new Error('mount failed')
    })

    const prepared = prepareFullApp({ takeover: 'public-shell' })
    await expect(commitPreparedFullApp(prepared)).rejects.toThrow('mount failed')

    expect(resetPublicTakeover).toHaveBeenCalledWith({ reason: 'full-app-bootstrap-failed' })
    expect(completePublicTakeoverCommit).not.toHaveBeenCalled()
  })

  it('resets public takeover state when route readiness times out during commit', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    waitForPublicTakeoverVisualReady.mockRejectedValueOnce(new Error('route readiness timeout'))

    const prepared = prepareFullApp({ takeover: 'public-shell' })
    await expect(commitPreparedFullApp(prepared)).rejects.toThrow('route readiness timeout')

    expect(resetPublicTakeover).toHaveBeenCalledWith({ reason: 'full-app-bootstrap-failed' })
    expect(completePublicTakeoverCommit).not.toHaveBeenCalled()
  })

  it('keeps the single-call direct SPA bootstrap API', async () => {
    const { bootstrapFullApp } = await import('@/bootstrap/fullApp')

    await expect(bootstrapFullApp()).resolves.toBe(fakeRouter)

    expect(createApp).toHaveBeenCalledTimes(1)
    expect(appMount).toHaveBeenCalledWith('#app')
    expect(removeGlobalLoader).toHaveBeenCalledTimes(1)
    expect(resetPublicTakeover).not.toHaveBeenCalled()
  })
})
