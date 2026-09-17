import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPublicRouteSeedStoreForTests } from '@/public-renderers/publicRouteSeedStore'
import { useHomeView } from '@/composables/useHomeView'

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
})
