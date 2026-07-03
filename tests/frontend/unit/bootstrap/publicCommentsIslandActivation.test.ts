import { Window as HappyDomWindow } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mountArticleCommentsIsland = vi.fn<(...args: unknown[]) => Promise<void>>()
const unmountArticleCommentsIsland = vi.fn()
const hydratePublicPage = vi.fn<(...args: unknown[]) => Promise<void>>()
const getMe = vi.fn<() => Promise<null>>()
const prewarmPublicRoute = vi.fn<(...args: unknown[]) => Promise<{ status: 'ready' }>>()
const prepareFullApp = vi.fn<(...args: unknown[]) => unknown>()
const commitPreparedFullApp = vi.fn<(...args: unknown[]) => Promise<void>>()
const bootstrapFullApp = vi.fn<(...args: unknown[]) => Promise<void>>()

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
  ;(globalThis as { window?: Window }).window = unitWindow
  ;(globalThis as { document?: Document }).document = unitWindow.document
  ;(globalThis as { Element?: typeof Element }).Element = unitWindow.Element
  ;(globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement = unitWindow.HTMLElement
  ;(globalThis as { SVGElement?: typeof SVGElement }).SVGElement = unitWindow.SVGElement
  ;(globalThis as { localStorage?: Storage }).localStorage = unitWindow.localStorage
  ;(globalThis as { sessionStorage?: Storage }).sessionStorage = unitWindow.sessionStorage
  ;(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    (cb: FrameRequestCallback): number => setTimeout(() => cb(Date.now()), 0) as unknown as number
  ;(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame =
    (id: number): void => clearTimeout(id)
}

function restoreOriginalWindow(): void {
  ;(globalThis as { window?: Window }).window = originalGlobals.window
  ;(globalThis as { document?: Document }).document = originalGlobals.document
  ;(globalThis as { Element?: typeof Element }).Element = originalGlobals.Element
  ;(globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement = originalGlobals.HTMLElement
  ;(globalThis as { SVGElement?: typeof SVGElement }).SVGElement = originalGlobals.SVGElement
  ;(globalThis as { localStorage?: Storage }).localStorage = originalGlobals.localStorage
  ;(globalThis as { sessionStorage?: Storage }).sessionStorage = originalGlobals.sessionStorage
  ;(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
    originalGlobals.requestAnimationFrame
  ;(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame =
    originalGlobals.cancelAnimationFrame
}

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []

  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }

  trigger(entries: Partial<IntersectionObserverEntry>[]): void {
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver)
  }
}

const articlePayload = {
  pageKind: 'ArticleDetail',
  routeKey: 'article:101',
  rendererVersion: 'test-renderer',
  title: 'Fallback comments',
  articleId: 101,
  detailView: {
    id: 101,
    title: 'Fallback comments',
    summary: 'summary',
    content: 'content',
    views: 1,
    createTime: '2026-06-16T00:00:00Z',
    category: { id: 1, name: 'Category' },
    tags: []
  },
  commentsIsland: {
    articleId: 101
  }
}

const homePayload = {
  pageKind: 'Home',
  routeKey: 'home',
  rendererVersion: 'test-renderer',
  title: 'Home',
  currentPage: 1,
  pageSize: 10,
  total: 0,
  articles: [],
  view: {
    articles: [],
    pagination: {
      indicator: '1 / 1'
    }
  }
}

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

async function importPublicShell(): Promise<typeof import('@/bootstrap/publicShell')> {
  vi.resetModules()
  vi.doMock('@/bootstrap/publicHydrationBootstrap', () => ({
    readPublicHydrationPayloadAsync: vi.fn(async () => articlePayload),
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
    setThemeMode: vi.fn()
  }))
  vi.doMock('@/bootstrap/fullApp', () => ({
    bootstrapFullApp,
    commitPreparedFullApp,
    prepareFullApp
  }))
  vi.doMock('@/router/publicRoutePreload', () => ({
    prewarmPublicRoute,
    resolvePublicRoutePrewarmTarget: vi.fn(() => null)
  }))
  vi.doMock('@/public-renderers/publicShellRuntimeState', () => ({
    resetPublicShellRuntimeAuthState: vi.fn()
  }))
  vi.doMock('@/public-renderers/publicRouteSeedStore', () => ({
    putPublicRouteSeed: vi.fn()
  }))
  vi.doMock('@/bootstrap/publicTakeoverState', () => ({
    getPublicRuntimeOwner: vi.fn(() => 'public-shell'),
    markPublicTakeoverFallback: vi.fn()
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
    vi.spyOn(window, 'setTimeout').mockImplementation((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      globalThis.setTimeout(handler, timeout, ...args) as unknown as number
    )
    vi.spyOn(window, 'clearTimeout').mockImplementation((handle?: number) => {
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
