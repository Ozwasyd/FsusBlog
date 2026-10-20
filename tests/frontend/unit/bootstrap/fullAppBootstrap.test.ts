import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouterFactoryOptions } from '@/router'
import type { PublicHomeHydrationPayload } from '@/public-renderers/types'
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'

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
  isReady: vi.fn(async () => {}),
  resolve: vi.fn(() => ({
    name: 'Home',
    path: '/',
    meta: { routeState: 'public-shareable' }
  }))
}
const createAppRouter = vi.fn((_options: RouterFactoryOptions) => fakeRouter)
const prewarmPublicRoute = vi.fn()
const beginLocaleRouteTransaction = vi.fn(async () => ({
  snapshot: { locale: 'zh-CN', domains: ['common'] },
  commit: vi.fn(),
  rollback: vi.fn()
}))
const activateLocaleRuntime = vi.fn(async () => 'zh-CN')
const isSupportedLocale = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const createApp = vi.fn(() => fakeApp)
const fakePinia = { use: vi.fn() }
const createPinia = vi.fn(() => fakePinia)
const createHead = vi.fn(() => ({}))
const scheduleRuntimeActivation = vi.fn()
const scheduleNonCriticalResources = vi.fn()
const removeGlobalLoader = vi.fn()
const activatePublicTakeover = vi.fn(async () => {})
const publicHydrationTakeoverHandle = {
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
    view: {
      items: [],
      pagination: {
        previous: { label: '上一页', href: '/', disabled: true },
        next: { label: '下一页', href: '/', disabled: true },
        indicator: '1 / 1'
      },
      showPagination: false,
      emptyState: { title: 'empty' },
      searchKeyword: ''
    },
    currentPage: 1,
    pageSize: 10,
    total: 0,
    renderLocale: 'en-US',
    rendererVersion: 'test',
    localeCatalogDigest: LOCALE_CATALOG_DIGEST
  } satisfies PublicHomeHydrationPayload,
  activate: activatePublicTakeover
}
const getPublicHydrationTakeoverHandle = vi.fn<() => typeof publicHydrationTakeoverHandle | null>(
  () => publicHydrationTakeoverHandle
)
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
  defineAsyncComponent: vi.fn((loader: unknown) => loader),
  defineComponent: vi.fn((options: { setup?: () => unknown }) => options),
  Fragment: Symbol('Fragment'),
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
vi.mock('@/locales', () => ({
  DEFAULT_LOCALE: 'zh-CN',
  isSupportedLocale,
  beginLocaleRouteTransaction,
  activateLocaleRuntime
}))
vi.mock('@/locales/routeLocaleDomains', () => ({
  requiredLocaleDomainsForRoute: vi.fn(() => ['common', 'layout', 'public'])
}))
vi.mock('@/router/publicRoutePreload', () => ({ prewarmPublicRoute }))
vi.mock('@/fsusui/appContext', () => ({ provideFsusUiAppContext: vi.fn() }))
vi.mock('@/fsusui/feedback', () => ({ installFsusUiLoading: vi.fn() }))
vi.mock('@/fsusui/motion', () => ({ FsuMotion: {} }))
vi.mock('@/bootstrap/nonCriticalResources', () => ({ scheduleNonCriticalResources }))
vi.mock('@/bootstrap/runtimeActivation', () => ({
  runtimeActive: { value: true },
  scheduleRuntimeActivation
}))
vi.mock('@/bootstrap/publicShellPrimitives', () => ({ removeGlobalLoader }))
vi.mock('@/public-renderers/clientHydrate', () => ({ getPublicHydrationTakeoverHandle }))
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

    const prepared = prepareFullApp({ takeover: 'public-shell' })

    expect(prepared.router).toBe(fakeRouter)
    expect(createAppRouter).toHaveBeenCalledWith({
      getPublicActivationOwner: expect.any(Function),
      prepareLocaleDomains: beginLocaleRouteTransaction,
      prewarmPublicRoute,
      shouldSuppressNavigationProgress: undefined
    })
    await createAppRouter.mock.calls[0]?.[0].prepareLocaleDomains!(
      ['common'],
      undefined
    )
    expect(beginLocaleRouteTransaction).toHaveBeenCalledWith(['common'], undefined)
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
    const prepared = prepareFullApp({ takeover: 'public-shell' })
    const currentRoute = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/'
    await commitPreparedFullApp(prepared, {
      navigationIntent: {
        to: '/archive',
        replace: false
      }
    })

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
    expect(scheduleRuntimeActivation).toHaveBeenCalledWith('takeover')
  })

  it('leaves the public shell intact when prepare fails', async () => {
    const { prepareFullApp } = await import('@/bootstrap/fullApp')
    getPublicHydrationTakeoverHandle.mockReturnValueOnce(null)

    expect(() => prepareFullApp({ takeover: 'public-shell' })).toThrow('public takeover requires the mounted hydration app')

    expect(document.querySelector('#app > #fsus-aot-shell')?.textContent).toBe('AOT')
    expect(appMount).not.toHaveBeenCalled()
  })

  it('resets public takeover state when commit fails', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    activatePublicTakeover.mockImplementationOnce(async () => {
      throw new Error('mount failed')
    })

    const prepared = prepareFullApp({ takeover: 'public-shell' })
    await expect(commitPreparedFullApp(prepared)).rejects.toThrow('mount failed')

  })

  it('resets public takeover state when route readiness times out during commit', async () => {
    const { prepareFullApp, commitPreparedFullApp } = await import('@/bootstrap/fullApp')
    waitForPublicTakeoverVisualReady.mockRejectedValueOnce(new Error('route readiness timeout'))

    const prepared = prepareFullApp({ takeover: 'public-shell' })
    await expect(commitPreparedFullApp(prepared)).rejects.toThrow('route readiness timeout')

  })

  it('deduplicates repeated direct SPA bootstrap calls', async () => {
    const { bootstrapFullApp } = await import('@/bootstrap/fullApp')
    document.getElementById('app')?.replaceChildren()

    const first = bootstrapFullApp()
    const second = bootstrapFullApp()

    expect(second).toBe(first)
    await expect(first).resolves.toBe(fakeRouter)

    expect(createApp).toHaveBeenCalledTimes(1)
    expect(activateLocaleRuntime).toHaveBeenCalledWith(
      undefined,
      ['common', 'layout', 'public']
    )
    expect(activateLocaleRuntime.mock.invocationCallOrder[0])
      .toBeLessThan(appMount.mock.invocationCallOrder[0]!)
    expect(appMount).toHaveBeenCalledWith('#app')
    expect(removeGlobalLoader).toHaveBeenCalledTimes(1)
    expect(scheduleRuntimeActivation).toHaveBeenCalledWith('after-first-paint')
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
  })
})
