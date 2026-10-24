import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { putPublicRouteSeed, resetPublicRouteSeedStoreForTests } from '@/public-renderers/publicRouteSeedStore'
import { useHomeView } from '@/composables/useHomeView'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import { LOCALE_CATALOG_DIGEST } from '@/locales/localeCatalog'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import { createArticleListViewContract } from '@/view-contracts/articleList'

const mocks = vi.hoisted(() => ({
  getPublicArticleCardProjections: vi.fn(),
  getFeaturedArticles: vi.fn(),
  getHotArticles: vi.fn()
}))

vi.mock('@/api/article', () => ({
  getPublicArticleCardProjections: mocks.getPublicArticleCardProjections,
  getFeaturedArticles: mocks.getFeaturedArticles,
  getHotArticles: mocks.getHotArticles
}))

async function createHomeRouter(initialPath: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'home', component: { template: '<div />' } }]
  })
  await router.push(initialPath)
  await router.isReady()
  return router
}

function mountHomeView(router: Router) {
  let api: ReturnType<typeof useHomeView> | null = null
  const wrapper = mount(defineComponent({
    setup() {
      api = useHomeView()
      return api
    },
    template: '<div />'
  }), {
    global: {
      plugins: [router, createPinia()]
    }
  })

  return {
    wrapper,
    api: () => {
      if (!api) {
        throw new Error('useHomeView was not created')
      }
      return api
    }
  }
}

function createHomeSeed(
  featuredArticles: readonly FeaturedArticleItem[],
  hotArticles: readonly PopularArticleSummaryResponse[]
): PublicPageSeed<'Home'> {
  return {
    bootstrap: Object.freeze({
      kind: 'Home',
      renderLocale: 'zh-CN',
      localeCatalogDigest: LOCALE_CATALOG_DIGEST,
      total: 0,
      articles: Object.freeze([]),
      featuredArticles,
      hotArticles
    }),
    hydration: Object.freeze({
      pageKind: 'Home',
      routeKey: 'home',
      rendererVersion: PUBLIC_RENDERER_VERSION,
      title: '首页',
      renderLocale: 'zh-CN',
      localeCatalogDigest: LOCALE_CATALOG_DIGEST,
      currentPage: 1,
      pageSize: 10,
      total: 0,
      view: createArticleListViewContract({ items: [], total: 0 }, { currentPage: 1, pageSize: 10 }),
      featuredArticles,
      hotArticles
    })
  }
}

const featuredSeed: FeaturedArticleItem = Object.freeze({
  id: 1,
  title: 'Featured seed',
  coverImageUrl: '',
  views: 10,
  createTime: '2026-10-01T00:00:00Z',
  category: Object.freeze({ id: 1, name: '分类' })
})
const hotSeed: PopularArticleSummaryResponse = Object.freeze({ id: 2, title: 'Hot seed', views: 20 })

describe('useHomeView cursor-only pagination', () => {
  beforeEach(() => {
    resetPublicRouteSeedStoreForTests()
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
    mocks.getPublicArticleCardProjections.mockReset()
    mocks.getFeaturedArticles.mockReset()
    mocks.getHotArticles.mockReset()
  })

  afterEach(() => {
    resetPublicRouteSeedStoreForTests()
    vi.clearAllMocks()
  })

  it('uses response cursors for forward navigation and browser back', async () => {
    mocks.getPublicArticleCardProjections
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: true, nextCursor: 'cursor_home_2' })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: true, nextCursor: 'cursor_home_2' })

    const router = await createHomeRouter('/')
    const { wrapper, api } = mountHomeView(router)
    await flushPromises()

    expect(mocks.getPublicArticleCardProjections).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1, cursor: null }),
      expect.any(Object)
    )
    expect(api().canGoNext.value).toBe(true)
    expect(api().listView.value.pagination.next.href).toBe('/?page=2&cursor=cursor_home_2')

    api().handlePageChange(2)
    await flushPromises()

    expect(router.currentRoute.value.query).toMatchObject({ page: '2', cursor: 'cursor_home_2' })
    expect(mocks.getPublicArticleCardProjections).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2, cursor: 'cursor_home_2' }),
      expect.any(Object)
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })

    router.back()
    await flushPromises()

    expect(router.currentRoute.value.query.page).toBeUndefined()
    expect(router.currentRoute.value.query.cursor).toBeUndefined()
    expect(mocks.getPublicArticleCardProjections).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ page: 1, cursor: null }),
      expect.any(Object)
    )
    wrapper.unmount()
  })

  it('restores a refreshed cursor URL and rejects a cursor-less deep URL before API dispatch', async () => {
    mocks.getPublicArticleCardProjections.mockResolvedValue({
      items: [],
      total: 20,
      hasMore: false,
      nextCursor: null
    })

    const cursorRouter = await createHomeRouter('/?page=2&cursor=cursor_home_2')
    const cursorMount = mountHomeView(cursorRouter)
    await flushPromises()
    expect(cursorMount.api().currentPage.value).toBe(2)
    expect(mocks.getPublicArticleCardProjections).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, cursor: 'cursor_home_2' }),
      expect.any(Object)
    )
    cursorMount.wrapper.unmount()

    mocks.getPublicArticleCardProjections.mockClear()
    const missingRouter = await createHomeRouter('/?page=2')
    const missingMount = mountHomeView(missingRouter)
    await flushPromises()
    expect(missingMount.api().currentPage.value).toBe(2)
    expect(missingMount.api().isError.value).toBe(true)
    expect(mocks.getPublicArticleCardProjections).not.toHaveBeenCalled()
    missingMount.wrapper.unmount()

    const unexpectedRouter = await createHomeRouter('/?cursor=cursor_home_2')
    const unexpectedMount = mountHomeView(unexpectedRouter)
    await flushPromises()
    expect(unexpectedMount.api().currentPage.value).toBe(1)
    expect(unexpectedMount.api().isError.value).toBe(true)
    expect(mocks.getPublicArticleCardProjections).not.toHaveBeenCalled()
    unexpectedMount.wrapper.unmount()
  })

  it('copies frozen hydration arrays before bootstrap candidates into mutable local state', async () => {
    const featured = Object.freeze([featuredSeed])
    const hot = Object.freeze([hotSeed])
    const hydrationSeed = createHomeSeed(featured, hot)
    const bootstrapSeed = createHomeSeed(
      Object.freeze([{ ...featuredSeed, id: 3 }]),
      Object.freeze([{ ...hotSeed, id: 4 }])
    )
    putPublicRouteSeed({
      kind: 'Home', fullPath: '/',
      seed: { hydration: hydrationSeed.hydration, bootstrap: bootstrapSeed.bootstrap }
    })

    const { wrapper, api } = mountHomeView(await createHomeRouter('/'))
    await flushPromises()

    expect(api().featuredArticles.value).toEqual(featured)
    expect(api().hotArticles.value).toEqual(hot)
    expect(api().featuredArticles.value).not.toBe(featured)
    expect(api().hotArticles.value).not.toBe(hot)
    expect(api().featuredArticles.value[0]).toBe(featuredSeed)
    expect(api().hotArticles.value[0]).toBe(hotSeed)
    api().featuredArticles.value.push({ ...featuredSeed, id: 5 })
    api().hotArticles.value.push({ ...hotSeed, id: 6 })
    expect(featured).toEqual([featuredSeed])
    expect(hot).toEqual([hotSeed])
    expect(mocks.getPublicArticleCardProjections).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('selects frozen bootstrap arrays when the hydration candidate is absent', async () => {
    const featured = Object.freeze([featuredSeed])
    const hot = Object.freeze([hotSeed])
    const seed = createHomeSeed(featured, hot)
    putPublicRouteSeed({ kind: 'Home', fullPath: '/', seed: { bootstrap: seed.bootstrap, hydration: null } })

    const { wrapper, api } = mountHomeView(await createHomeRouter('/'))
    await flushPromises()

    expect(api().featuredArticles.value).toEqual(featured)
    expect(api().hotArticles.value).toEqual(hot)
    expect(api().featuredArticles.value).not.toBe(featured)
    expect(api().hotArticles.value).not.toBe(hot)
    api().featuredArticles.value.pop()
    api().hotArticles.value.pop()
    expect(featured).toEqual([featuredSeed])
    expect(hot).toEqual([hotSeed])
    expect(mocks.getPublicArticleCardProjections).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the first empty hydration arrays ahead of populated bootstrap candidates', async () => {
    const featured = Object.freeze<FeaturedArticleItem[]>([])
    const hot = Object.freeze<PopularArticleSummaryResponse[]>([])
    const hydrationSeed = createHomeSeed(featured, hot)
    const bootstrapSeed = createHomeSeed(Object.freeze([featuredSeed]), Object.freeze([hotSeed]))
    putPublicRouteSeed({
      kind: 'Home', fullPath: '/',
      seed: { hydration: hydrationSeed.hydration, bootstrap: bootstrapSeed.bootstrap }
    })

    const { wrapper, api } = mountHomeView(await createHomeRouter('/'))
    await flushPromises()

    expect(api().featuredArticles.value).toEqual([])
    expect(api().hotArticles.value).toEqual([])
    expect(api().featuredArticles.value).not.toBe(featured)
    expect(api().hotArticles.value).not.toBe(hot)
    api().featuredArticles.value.push(featuredSeed)
    api().hotArticles.value.push(hotSeed)
    expect(featured).toEqual([])
    expect(hot).toEqual([])
    wrapper.unmount()
  })

  it('creates independent empty mutable arrays when both seed candidates are absent', async () => {
    mocks.getPublicArticleCardProjections.mockResolvedValue({ items: [], total: 0, hasMore: false, nextCursor: null })
    const { wrapper, api } = mountHomeView(await createHomeRouter('/'))
    await flushPromises()

    expect(api().featuredArticles.value).toEqual([])
    expect(api().hotArticles.value).toEqual([])
    expect(api().featuredArticles.value).not.toBe(api().hotArticles.value)
    api().featuredArticles.value.push(featuredSeed)
    api().hotArticles.value.push(hotSeed)
    expect(api().featuredArticles.value).toEqual([featuredSeed])
    expect(api().hotArticles.value).toEqual([hotSeed])
    wrapper.unmount()
  })
})
