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
const createAppRouter = vi.fn(() => fakeRouter)
const prewarmPublicRoute = vi.fn()
const createApp = vi.fn(() => fakeApp)
const fakePinia = { use: vi.fn() }
const createPinia = vi.fn(() => fakePinia)
const createHead = vi.fn(() => ({}))
const scheduleFullAppRuntime = vi.fn()
const scheduleNonCriticalResources = vi.fn()
const removeGlobalLoader = vi.fn()
const activatePublicTakeover = vi.fn(async () => {})
const getPublicHydrationTakeoverHandle = vi.fn(() => ({
  app: fakeApp,
  pinia: fakePinia,
  payload: {
    pageKind: 'Home',
    routeKey: 'home',
    title: 'FsusBlog',
    siteTitle: 'FsusBlog',
    siteDescription: 'Test',
    featuredArticles: [],
    hotArticles: [],
    view: {},
    currentPage: 1,
    pageSize: 10,
    total: 0
  },
  activate: activatePublicTakeover
}))
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
  computed: vi.fn((getter: () => unknown) => ({
    get value() {
      return getter()
    }
  })),
  createApp,
  h: vi.fn(),
  readonly: vi.fn((value) => value),
  ref: vi.fn((value) => ({ value })),
  shallowRef: vi.fn((value) => ({ value })),
  triggerRef: vi.fn()
}))
vi.mock('pinia', () => ({ createPinia }))
vi.mock('@unhead/vue/client', () => ({ createHead }))
vi.mock('pinia-plugin-persistedstate', () => ({ default: vi.fn() }))
vi.mock('@/App.vue', () => ({ default: {} }))
vi.mock('@/components/public/PublicBlogLayoutShell.vue', () => ({ default: {} }))
vi.mock('@/router', () => ({ createAppRouter }))
vi.mock('@/router/publicRoutePreload', () => ({ prewarmPublicRoute }))
vi.mock('@/fsusui/appContext', () => ({ provideFsusUiAppContext: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({ installFsusUiLoading: vi.fn() }))
vi.mock('@/fsusui/motion', () => ({ FsuMotion: {} }))
vi.mock('@/bootstrap/nonCriticalResources', () => ({ scheduleNonCriticalResources }))
vi.mock('@/bootstrap/runtimeGate', () => ({ runtimeReady: { value: true }, scheduleFullAppRuntime }))
vi.mock('@/bootstrap/publicShellPrimitives', () => ({ removeGlobalLoader }))
vi.mock('@/public-renderers/clientHydrate', () => ({ getPublicHydrationTakeoverHandle }))
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
    vi.resetModules()
    vi.clearAllMocks()
    document.body.innerHTML = '<div id="app"><div id="fsus-aot-shell" data-public-hydration-kind="Home">AOT</div></div>'
    window.history.replaceState({}, '', '/current?from=aot')
    fakeRouter.currentRoute.value.fullPath = '/'
  })

  it('prepares the app without clearing or mounting over the public shell', async () => {
    const { prepareFullApp } = await import('@/bootstrap/fullApp')

    const prepared = prepareFullApp({ takeover: 'public-shell', deferRuntime: true })

    expect(prepared.router).toBe(fakeRouter)
    expect(createAppRouter).toHaveBeenCalledWith({ prewarmPublicRoute })
    expect(createApp).not.toHaveBeenCalled()
    expect(document.querySelector('#app > #fsus-aot-shell')).not.toBeNull()
    expect(appMount).not.toHaveBeenCalled()
    expect(getPublicHydrationTakeoverHandle).toHaveBeenCalledTimes(1)
    expect(abortPublicShellLifetime).not.toHaveBeenCalled()
    expect(authSessionRuntimeInit).not.toHaveBeenCalled()
    expect(removeGlobalLoader).not.toHaveBeenCalled()
  })

  it('commits a prepared public takeover and replays a captured router intent after mount', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
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
    expect(activatePublicTakeover).toHaveBeenCalledTimes(1)
    expect(appMount).not.toHaveBeenCalled()
    expect(beginPublicTakeoverVisualGuard).toHaveBeenCalledWith({
      navigationId: '/archive',
      timeoutMs: 5000
    })
    expect(fakeRouter.replace).toHaveBeenCalledWith(currentRoute)
    expect(fakeRouter.push).toHaveBeenCalledWith('/archive')
    expect(fakeRouter.push.mock.invocationCallOrder[0]).toBeGreaterThan(activatePublicTakeover.mock.invocationCallOrder[0])
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
    getPublicHydrationTakeoverHandle.mockReturnValueOnce(null)

    expect(() => prepareFullApp({ takeover: 'public-shell' })).toThrow('public takeover requires the mounted hydration app')

    expect(document.querySelector('#app > #fsus-aot-shell')?.textContent).toBe('AOT')
    expect(appMount).not.toHaveBeenCalled()
    expect(resetPublicTakeover).not.toHaveBeenCalled()
  })

  it('resets public takeover state when commit fails', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    activatePublicTakeover.mockImplementationOnce(async () => {
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

  it('deduplicates repeated direct SPA bootstrap calls', async () => {
    const { bootstrapFullApp } = await import('@/bootstrap/fullApp')
    document.getElementById('app')?.replaceChildren()

    const first = bootstrapFullApp()
    const second = bootstrapFullApp()

    expect(second).toBe(first)
    await expect(first).resolves.toBe(fakeRouter)

    expect(createApp).toHaveBeenCalledTimes(1)
    expect(beginPublicTakeoverCommit).toHaveBeenCalledWith({ reason: 'direct-spa-bootstrap' })
    expect(completePublicTakeoverCommit).toHaveBeenCalledWith({ reason: 'direct-spa-mounted' })
    expect(appMount).toHaveBeenCalledWith('#app')
    expect(removeGlobalLoader).toHaveBeenCalledTimes(1)
    expect(resetPublicTakeover).not.toHaveBeenCalled()
  })

  it('clears failed bootstrap ownership so a later call can retry', async () => {
    const { bootstrapFullApp } = await import('@/bootstrap/fullApp')
    document.getElementById('app')?.replaceChildren()
    appMount.mockImplementationOnce(() => {
      throw new Error('mount failed')
    })

    await expect(bootstrapFullApp()).rejects.toThrow('mount failed')
    await expect(bootstrapFullApp()).resolves.toBe(fakeRouter)

    expect(createApp).toHaveBeenCalledTimes(2)
    expect(appMount).toHaveBeenCalledTimes(2)
    expect(resetPublicTakeover).toHaveBeenCalledWith({ reason: 'full-app-bootstrap-failed' })
  })
})
