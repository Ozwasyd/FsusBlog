import { Window as HappyDomWindow } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { articleRightsFixture } from '../fixtures/articleRights'
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import type { PublicArticleDetailHydrationPayload, PublicHomeHydrationPayload } from '@/public-renderers/types'
import { createArticleListViewContract } from '@/view-contracts/articleList'
import { createArticleRightsViewContract, emptyArticleDetailPageView } from '@/view-contracts/articleDetail'

const mountArticleCommentsIsland = vi.fn<(...args: unknown[]) => Promise<void>>()
const unmountArticleCommentsIsland = vi.fn()
const hydratePublicPage = vi.fn<(...args: unknown[]) => Promise<void>>()
const getMe = vi.fn<() => Promise<null>>()
const prewarmPublicRoute = vi.fn<(...args: unknown[]) => Promise<{ status: 'ready' }>>()
const prepareFullApp = vi.fn<(...args: unknown[]) => unknown>()
const commitPreparedFullApp = vi.fn<(...args: unknown[]) => Promise<void>>()
const bootstrapFullApp = vi.fn<(...args: unknown[]) => Promise<void>>()
const RENDER_TIMESTAMP = '2026-06-18T00:00:00.000Z'
const PUBLIC_PAYLOAD_IDENTITY = {
  renderTimestamp: RENDER_TIMESTAMP,
  renderLocale: 'zh-CN',
  localeCatalogDigest: LOCALE_CATALOG_DIGEST
} as const

const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Element: globalThis.Element,
  HTMLElement: globalThis.HTMLElement,
  SVGElement: globalThis.SVGElement,
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame
}

function installIsolatedWindow(): void {
  const unitWindow = new HappyDomWindow()
  Object.assign(globalThis, {
    window: unitWindow,
    document: unitWindow.document,
    Element: unitWindow.Element,
    HTMLElement: unitWindow.HTMLElement,
    SVGElement: unitWindow.SVGElement,
    localStorage: unitWindow.localStorage,
    sessionStorage: unitWindow.sessionStorage,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id)
  })
}

function restoreOriginalWindow(): void {
  Object.assign(globalThis, originalGlobals)
}

class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = []

  readonly root = null
  readonly rootMargin = '0px'
  readonly scrollMargin = '0px'
  readonly thresholds = [0]
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()
  readonly unobserve = vi.fn()
  readonly takeRecords = vi.fn((): IntersectionObserverEntry[] => [])
  private readonly callback: IntersectionObserverCallback

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }

  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.callback(entries.map((entry) => {
      const target = entry.target ?? document.createElement('div')
      const bounds = target.getBoundingClientRect()
      return {
        time: 0,
        target,
        rootBounds: null,
        boundingClientRect: bounds,
        intersectionRect: bounds,
        isIntersecting: false,
        intersectionRatio: 0,
        ...entry
      }
    }), this)
  }
}

const articlePayload = {
  ...PUBLIC_PAYLOAD_IDENTITY,
  pageKind: 'ArticleDetail',
  routeKey: 'article:101',
  rendererVersion: 'test-renderer',
  title: 'Fallback comments',
  bodyContent: '',
  articleId: 101,
  rights: articleRightsFixture,
  detailView: {
    ...emptyArticleDetailPageView,
    rights: createArticleRightsViewContract(articleRightsFixture)
  },
  commentsIsland: {
    articleId: 101
  }
} satisfies PublicArticleDetailHydrationPayload

const homePayload = {
  ...PUBLIC_PAYLOAD_IDENTITY,
  pageKind: 'Home',
  routeKey: 'home',
  rendererVersion: 'test-renderer',
  title: 'Home',
  currentPage: 1,
  pageSize: 10,
  total: 0,
  featuredArticles: [],
  hotArticles: [],
  view: createArticleListViewContract({ items: [], total: 0 }, { currentPage: 1, pageSize: 10 })
} satisfies PublicHomeHydrationPayload

function resetDocument(url = 'http://127.0.0.1:7568/article/101'): void {
  window.location.href = url
  document.head.innerHTML = ''
  document.body.innerHTML = `
    <div id="app">
      <div id="fsus-aot-shell">
        <article>
          <div id="fsus-comments-island" data-article-id="101">
            <div id="fsus-comments-island-content"></div>
          </div>
        </article>
      </div>
    </div>
  `
  document.body.setAttribute('data-fsusblog-public-shell', 'true')
}

async function importPublicShell(
  hydrationPayload: Record<string, unknown> = articlePayload
): Promise<typeof import('@/bootstrap/publicShell')> {
  vi.resetModules()
  vi.doMock('@/bootstrap/publicHydrationBootstrap', () => ({
    readPublicHydrationPayloadAsync: vi.fn(async () => hydrationPayload),
    readPublicHydrationPayloadFromUrl: vi.fn(),
    replacePublicHydrationPayloadBinary: vi.fn(() => homePayload),
    replacePublicHydrationPayloadSnapshot: vi.fn()
  }))
  vi.doMock('@/public-renderers', () => ({
    hydratePublicPage
  }))
  vi.doMock('@/public-renderers/clientHydrate', () => ({
    disposePublicHydrationApp: vi.fn()
  }))
  vi.doMock('@/bootstrap/publicShellPrimitives', () => ({
    isPublicSeoPath: vi.fn(() => true),
    removeGlobalLoader: vi.fn()
  }))
  vi.doMock('@/bootstrap/aotActionEvent', () => ({
    dispatchAotActionEvent: vi.fn()
  }))
  vi.doMock('@/services/telemetryBus', () => ({
    emitRumMetric: vi.fn(),
    emitTelemetry: vi.fn()
  }))
  vi.doMock('@/services/themeRuntime', () => ({
    ensureThemeRuntime: vi.fn(),
    reconcileThemeRuntimeAfterHydration: vi.fn(),
    setThemeMode: vi.fn()
  }))
  vi.doMock('@/bootstrap/fullApp', () => ({
    bootstrapFullApp,
    commitPreparedFullApp,
    prepareFullApp
  }))
  vi.doMock('@/router/publicRoutePreload', () => ({
    resolvePublicRoutePrewarmTarget: vi.fn(() => null)
  }))
  vi.doMock('@/public-renderers/publicShellRuntimeState', () => ({
    resetPublicShellRuntimeAuthState: vi.fn()
  }))
  vi.doMock('@/public-renderers/publicRouteSeedStore', () => ({
    putPublicRouteSeed: vi.fn()
  }))
  vi.doMock('@/bootstrap/publicActivationRuntime', () => ({
    adoptPublicBootIntent: vi.fn(),
    getPublicActivationOwner: vi.fn(() => 'aot'),
    submitPublicActivationIntent: vi.fn(async () => ({ status: 'interactive' })),
    warmPublicActivation: prewarmPublicRoute,
    warmPublicFullAppCore: vi.fn(async () => ({ ready: true }))
  }))
  vi.doMock('@/bootstrap/publicNavigationIntent', () => ({
    classifyPublicNavigationIntent: vi.fn(() => ({ kind: 'comments-island' }))
  }))
  vi.doMock('@/api/auth', () => ({
    getMe
  }))
  vi.doMock('@/composables/useMotionPreference', () => ({
    getPrefersReducedMotion: vi.fn(() => false),
    resolveMotionScrollBehavior: vi.fn(() => 'auto')
  }))
  vi.doMock('@/public-renderers/commentsIsland', () => ({
    mountArticleCommentsIsland,
    unmountArticleCommentsIsland
  }))

  vi.useRealTimers()
  const publicShellModule = await import('@/bootstrap/publicShell')
  vi.useFakeTimers()
  return publicShellModule
}

async function bootstrapAndSettleInitialStyles(): Promise<void> {
  const { bootstrapPublicShell } = await importPublicShell()
  const bootstrapTask = bootstrapPublicShell()
  vi.advanceTimersByTime(1_000)
  await Promise.resolve()
  await bootstrapTask
  await vi.dynamicImportSettled()
  expect(hydratePublicPage).toHaveBeenCalledTimes(1)
}

describe.sequential('public comments island activation', () => {
  beforeEach(() => {
    installIsolatedWindow()
    vi.useFakeTimers()
    FakeIntersectionObserver.instances = []
    mountArticleCommentsIsland.mockResolvedValue(undefined)
    hydratePublicPage.mockResolvedValue(undefined)
    getMe.mockResolvedValue(null)
    prewarmPublicRoute.mockResolvedValue({ status: 'ready' })
    prepareFullApp.mockReturnValue({})
    commitPreparedFullApp.mockResolvedValue(undefined)
    bootstrapFullApp.mockResolvedValue(undefined)
    unmountArticleCommentsIsland.mockReset()
    mountArticleCommentsIsland.mockClear()
    hydratePublicPage.mockClear()
    getMe.mockClear()
    prewarmPublicRoute.mockClear()
    prepareFullApp.mockClear()
    commitPreparedFullApp.mockClear()
    bootstrapFullApp.mockClear()
    vi.stubGlobal('history', window.history)
    vi.stubGlobal('HTMLLinkElement', window.HTMLLinkElement)
    vi.stubGlobal('HTMLAnchorElement', window.HTMLAnchorElement)
    vi.stubGlobal('IntersectionObserver', undefined)
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) =>
      globalThis.setTimeout(handler, timeout, ...args)
    )
    vi.spyOn(window, 'clearTimeout').mockImplementation((handle) => {
      globalThis.clearTimeout(handle)
    })
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    resetDocument()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    restoreOriginalWindow()
  })

  it('does not duplicate mount when a manual comments request wins the no-IntersectionObserver fallback race', async () => {
    await bootstrapAndSettleInitialStyles()
    expect(mountArticleCommentsIsland).not.toHaveBeenCalled()

    const button = document.createElement('button')
    button.dataset.aotAction = 'activate-comments'
    button.dataset.aotValue = '101'
    document.body.appendChild(button)
    button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    await Promise.resolve()
    await vi.dynamicImportSettled()

    expect(mountArticleCommentsIsland).toHaveBeenCalledTimes(1)
    expect(mountArticleCommentsIsland).toHaveBeenCalledWith(101)

    vi.advanceTimersByTime(2_500)
    expect(mountArticleCommentsIsland).toHaveBeenCalledTimes(1)

    const invalidPayload: Record<string, unknown> = { ...articlePayload }
    delete invalidPayload.renderTimestamp
    delete invalidPayload.renderLocale
    delete invalidPayload.localeCatalogDigest
    hydratePublicPage.mockClear()
    resetDocument()
    const { bootstrapPublicShell } = await importPublicShell(invalidPayload)
    const invalidBootstrap = bootstrapPublicShell()
    vi.advanceTimersByTime(1_000)
    await invalidBootstrap
    expect(hydratePublicPage).not.toHaveBeenCalled()
  }, 10_000)

  it('cancels a scheduled no-IntersectionObserver fallback when SPA takeover aborts the public shell lifetime', async () => {
    await bootstrapAndSettleInitialStyles()
    expect(mountArticleCommentsIsland).not.toHaveBeenCalled()

    const { abortPublicShellLifetime } = await import('@/bootstrap/publicShellLifetime')
    abortPublicShellLifetime('test-spa-takeover')

    await vi.advanceTimersByTimeAsync(2_500)

    expect(mountArticleCommentsIsland).not.toHaveBeenCalled()
  })

  it('loads article comments through a bounded fallback when IntersectionObserver is unavailable', async () => {
    await bootstrapAndSettleInitialStyles()
    expect(mountArticleCommentsIsland).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_500)

    expect(mountArticleCommentsIsland).toHaveBeenCalledTimes(1)
    expect(mountArticleCommentsIsland).toHaveBeenCalledWith(101)
  })

  it('loads article comments when the observed island enters the viewport', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

    await bootstrapAndSettleInitialStyles()
    expect(mountArticleCommentsIsland).not.toHaveBeenCalled()
    expect(FakeIntersectionObserver.instances).toHaveLength(1)

    FakeIntersectionObserver.instances[0]?.trigger([{ isIntersecting: true, intersectionRatio: 0 }])
    await vi.advanceTimersByTimeAsync(0)

    expect(mountArticleCommentsIsland).toHaveBeenCalledTimes(1)
    expect(mountArticleCommentsIsland).toHaveBeenCalledWith(101)
  })

  it('loads article comments immediately for direct #comments links', async () => {
    resetDocument('http://127.0.0.1:7568/article/101#comments')

    await bootstrapAndSettleInitialStyles()

    expect(mountArticleCommentsIsland).toHaveBeenCalledTimes(1)
    expect(mountArticleCommentsIsland).toHaveBeenCalledWith(101)
  })
})
