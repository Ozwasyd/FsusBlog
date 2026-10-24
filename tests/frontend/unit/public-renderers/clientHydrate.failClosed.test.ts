import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createSSRAppMock,
  normalizePublicHydrationPayloadMock,
  activateLocaleRuntimeMock,
  captureHydrationIdentityMock,
  verifyHydrationIdentityMock,
  beginHydrationMetricsMock,
  finishHydrationMetricsMock,
  markHydrationStepMock,
  createPublicHydrationRootComponentMock,
  renderPublicHydrationMarkdownMock,
  registerPublicStaticRouterLinkMock,
  provideFsusUiAppContextMock,
  hasCanonicalPublicSeedRenderTimestampMock,
  isSupportedLocaleMock,
  requiredLocaleDomainsForPublicPageMock
} = vi.hoisted(() => ({
  createSSRAppMock: vi.fn(),
  normalizePublicHydrationPayloadMock: vi.fn((payload) => payload),
  activateLocaleRuntimeMock: vi.fn(async () => undefined),
  captureHydrationIdentityMock: vi.fn(() => ({ identityMarker: 'Home:home' })),
  verifyHydrationIdentityMock: vi.fn(),
  beginHydrationMetricsMock: vi.fn(() => ({})),
  finishHydrationMetricsMock: vi.fn(),
  markHydrationStepMock: vi.fn(),
  createPublicHydrationRootComponentMock: vi.fn(() => ({ name: 'PublicHydrationRoot' })),
  renderPublicHydrationMarkdownMock: vi.fn(async () => null),
  registerPublicStaticRouterLinkMock: vi.fn(),
  provideFsusUiAppContextMock: vi.fn(),
  hasCanonicalPublicSeedRenderTimestampMock: vi.fn(() => true),
  isSupportedLocaleMock: vi.fn(() => true),
  requiredLocaleDomainsForPublicPageMock: vi.fn(() => [])
}))

vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue')
  return {
    ...actual,
    createSSRApp: createSSRAppMock,
    nextTick: async () => undefined
  }
})

vi.mock('pinia', () => ({
  createPinia: () => ({ use: vi.fn() })
}))

vi.mock('pinia-plugin-persistedstate', () => ({
  default: {}
}))

vi.mock('@/fsusui/appContext', () => ({
  provideFsusUiAppContext: provideFsusUiAppContextMock
}))

vi.mock('@/public-renderers/hydrationPerf', () => ({
  beginHydrationMetrics: beginHydrationMetricsMock,
  finishHydrationMetrics: finishHydrationMetricsMock,
  markHydrationStep: markHydrationStepMock
}))

vi.mock('@/public-renderers/hydrationIdentityGuard', () => ({
  captureHydrationIdentity: captureHydrationIdentityMock,
  verifyHydrationIdentity: verifyHydrationIdentityMock
}))

vi.mock('@/public-renderers/publicPayloadNormalizer', () => ({
  normalizePublicHydrationPayload: normalizePublicHydrationPayloadMock
}))

vi.mock('@/public-renderers/publicHydrationRoot', () => ({
  createPublicHydrationRootComponent: createPublicHydrationRootComponentMock,
  renderPublicHydrationMarkdown: renderPublicHydrationMarkdownMock
}))

vi.mock('@/public-renderers/publicStaticRouterLink', () => ({
  registerPublicStaticRouterLink: registerPublicStaticRouterLinkMock
}))

vi.mock('@/locales', () => ({
  activateLocaleRuntime: activateLocaleRuntimeMock,
  isSupportedLocale: isSupportedLocaleMock
}))

vi.mock('@/locales/routeLocaleDomains', () => ({
  requiredLocaleDomainsForPublicPage: requiredLocaleDomainsForPublicPageMock
}))

vi.mock('@/public-renderers/publicRenderClock', () => ({
  hasCanonicalPublicSeedRenderTimestamp: hasCanonicalPublicSeedRenderTimestampMock
}))

import {
  disposePublicHydrationApp,
  getPublicHydrationTakeoverHandle,
  hydratePublicPage
} from '@/public-renderers/clientHydrate'
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import type { PublicHydrationPayload } from '@/public-renderers/types'

function payload(): PublicHydrationPayload {
  return {
    pageKind: 'Home',
    routeKey: 'home',
    title: 'Home',
    localeCatalogDigest: LOCALE_CATALOG_DIGEST,
    currentPage: 1,
    pageSize: 10,
    total: 0,
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
    siteTitle: 'FsusBlog',
    siteDescription: 'desc',
    rendererVersion: 'test',
    renderLocale: 'zh-CN',
    renderTimestamp: '2026-01-01T00:00:00.000Z',
    featuredArticles: [],
    hotArticles: []
  }
}

function mountDocument(): HTMLElement {
  document.documentElement.lang = 'zh-CN'
  document.body.innerHTML = `
    <div id="app">
      <div id="fsus-aot-shell" data-public-hydration-kind="Home" data-public-render-locale="zh-CN">shell</div>
    </div>
  `
  return document.querySelector('#fsus-aot-shell') as HTMLElement
}

describe('clientHydrate fail-closed suppression erasure', () => {
  beforeEach(() => {
    disposePublicHydrationApp()
    vi.clearAllMocks()
    hasCanonicalPublicSeedRenderTimestampMock.mockReturnValue(true)
    isSupportedLocaleMock.mockReturnValue(true)
    normalizePublicHydrationPayloadMock.mockImplementation((value) => value)
    renderPublicHydrationMarkdownMock.mockResolvedValue(null)
    verifyHydrationIdentityMock.mockReset()
    createSSRAppMock.mockImplementation(() => {
      const app = {
        use: vi.fn(),
        mount: vi.fn(),
        unmount: vi.fn(),
        config: {
          warnHandler: undefined as ((message: string) => void) | undefined
        }
      }
      return app
    })
  })

  afterEach(() => {
    disposePublicHydrationApp()
    document.body.innerHTML = ''
  })

  it('sets hydrated only after identity verification succeeds', async () => {
    const shell = mountDocument()
    await hydratePublicPage(payload())
    expect(shell.dataset.publicHydrated).toBe('true')
    expect(getPublicHydrationTakeoverHandle()).not.toBeNull()
    expect(verifyHydrationIdentityMock).toHaveBeenCalledTimes(1)
  })

  it('blocks hydrated flag and FullApp takeover when identity verification fails', async () => {
    const shell = mountDocument()
    verifyHydrationIdentityMock.mockImplementation(() => {
      throw new Error('[public-hydrate] shell remount detected for Home (home) path=#app > #fsus-aot-shell')
    })

    await expect(hydratePublicPage(payload())).rejects.toThrow(/shell remount detected/u)
    expect(shell.dataset.publicHydrated).toBeUndefined()
    expect(getPublicHydrationTakeoverHandle()).toBeNull()
  })

  it('treats Vue hydration mismatch warnings as fatal and blocks takeover', async () => {
    const shell = mountDocument()
    createSSRAppMock.mockImplementation(() => {
      const app = {
        use: vi.fn(),
        mount: vi.fn(() => {
          app.config.warnHandler?.('Hydration node mismatch on tag: a vs button')
        }),
        unmount: vi.fn(),
        config: {
          warnHandler: undefined as ((message: string) => void) | undefined
        }
      }
      return app
    })

    await expect(hydratePublicPage(payload())).rejects.toThrow(/hydration mismatch/u)
    expect(shell.dataset.publicHydrated).toBeUndefined()
    expect(getPublicHydrationTakeoverHandle()).toBeNull()
    expect(verifyHydrationIdentityMock).not.toHaveBeenCalled()
  })

  it('does not patch DOM before compare (no mismatch-suppression attrs / whitespace helpers)', async () => {
    const shell = mountDocument()
    const appRoot = document.querySelector('#app') as HTMLElement
    const childCountBefore = appRoot.childNodes.length
    const retiredAttr = ['data', 'allow', 'mismatch'].join('-')
    await hydratePublicPage(payload())
    // Success only sets the post-verify hydrated flag; it must not rewrite children
    // or inject retired mismatch-suppression attributes before Vue compare.
    expect(appRoot.childNodes.length).toBe(childCountBefore)
    expect(appRoot.firstElementChild).toBe(shell)
    expect(shell.hasAttribute(retiredAttr)).toBe(false)
    expect(document.querySelector(`[${retiredAttr}]`)).toBeNull()
    expect(shell.dataset.publicHydrated).toBe('true')
  })

  it('fails closed on locale mismatch before mount', async () => {
    const shell = mountDocument()
    shell.dataset.publicRenderLocale = 'en-US'

    await expect(hydratePublicPage(payload())).rejects.toThrow('public_aot_hydration_locale_mismatch')
    expect(shell.dataset.publicHydrated).toBeUndefined()
    expect(createSSRAppMock).not.toHaveBeenCalled()
    expect(getPublicHydrationTakeoverHandle()).toBeNull()
  })

  it('does not create or mount the app when the hydration Markdown runtime fails', async () => {
    const shell = mountDocument()
    renderPublicHydrationMarkdownMock.mockRejectedValueOnce(
      new Error('markdown_runtime_authority_invalid')
    )

    await expect(hydratePublicPage(payload()))
      .rejects.toThrow('markdown_runtime_authority_invalid')
    expect(createSSRAppMock).not.toHaveBeenCalled()
    expect(shell.dataset.publicHydrated).toBeUndefined()
    expect(getPublicHydrationTakeoverHandle()).toBeNull()
  })
})
