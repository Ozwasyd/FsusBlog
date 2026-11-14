import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUBLIC_FILTER_ROUTE_NAMES } from '@/public-renderers/publicRouteRegistry'
import { PUBLIC_RENDERER_VERSION } from '@/public-renderers/publicEntryCore'
import {
  putPublicRouteSeed,
  resetPublicRouteSeedStoreForTests
} from '@/public-renderers/publicRouteSeedStore'
import { AppErrorCode, createAppError } from '@/utils/appError'
import type { PublicPageSeed } from '@/public-renderers/pageSeed'
import type { PublicAotBootstrapPayloadFor } from '@/public-renderers/publicPayloadTypes'
import { useFilterView } from '@/composables/useFilterView'

const mocks = vi.hoisted(() => ({
  getArticles: vi.fn(),
  getCategoryExactMetadata: vi.fn(),
  getTagExactMetadata: vi.fn(),
  getTagExactMetadataByName: vi.fn(),
  getCategories: vi.fn(),
  getTags: vi.fn()
}))

vi.mock('@/api/article', () => ({
  getArticles: mocks.getArticles
}))

vi.mock('@/api/category', () => ({
  getCategoryExactMetadata: mocks.getCategoryExactMetadata,
  getCategories: mocks.getCategories
}))

vi.mock('@/api/tag', () => ({
  getTagExactMetadata: mocks.getTagExactMetadata,
  getTagExactMetadataByName: mocks.getTagExactMetadataByName,
  getTags: mocks.getTags
}))

vi.mock('@/fsusui/markdown', () => ({
  renderMarkdownOrThrow: vi.fn()
}))

vi.mock('@ozwasyd/element-plus/markdown-runtime', () => ({}))
vi.mock('@ozwasyd/element-plus/wasm', () => ({}))
vi.mock('@element-plus/wasm', () => ({}))

vi.mock('@/composables/usePow', async () => {
  const { ref } = await import('vue')
  return {
    usePow: () => ({
      isCalculating: ref(false)
    })
  }
})

function emptyArticlePage() {
  return { items: [], total: 0, hasMore: false, nextCursor: null }
}

function notFoundError() {
  return createAppError(AppErrorCode.NotFound, 'taxonomy_not_found', { status: 404 })
}

async function createFilterRouter(initialPath: string): Promise<Router> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/category/:id(\\d+)', name: PUBLIC_FILTER_ROUTE_NAMES.category, component: { template: '<div />' } },
      { path: '/tag/:id(\\d+)', name: PUBLIC_FILTER_ROUTE_NAMES.tagById, component: { template: '<div />' } },
      { path: '/tag/:id', name: PUBLIC_FILTER_ROUTE_NAMES.tag, component: { template: '<div />' } },
      { path: '/search', name: PUBLIC_FILTER_ROUTE_NAMES.search, component: { template: '<div />' } }
    ]
  })
  await router.push(initialPath)
  await router.isReady()
  return router
}

function mountFilterView(router: Router) {
  let api: ReturnType<typeof useFilterView> | null = null
  const wrapper = mount(defineComponent({
    setup() {
      api = useFilterView()
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
        throw new Error('useFilterView was not created')
      }
      return api
    }
  }
}

function createCategoryBootstrapSeed(overrides: {
  filterId?: number
  filterName?: string
  description?: string | null
  fullPath?: string
} = {}): PublicPageSeed<'Filter'> {
  const filterId = overrides.filterId ?? 7
  const filterName = overrides.filterName ?? '架构'
  const description = overrides.description === undefined
    ? '关于系统架构与设计的深度文章'
    : overrides.description
  const bootstrap: PublicAotBootstrapPayloadFor<'Filter'> = {
    kind: 'Filter',
    routeKey: `category:${filterId}`,
    rendererVersion: PUBLIC_RENDERER_VERSION,
    title: filterName,
    renderLocale: 'zh-CN',
    localeCatalogDigest: 'test-locale-digest',
    filterType: 'category',
    filterKey: `category:${filterId}`,
    filterId,
    filterName,
    isInvalidTarget: false,
    filter: {
      filterType: 'category',
      filterKey: `category:${filterId}`,
      filterId,
      filterName,
      description,
      isInvalidTarget: false,
      pageIndex: 1,
      pageSize: 10,
      total: 0,
      articles: []
    }
  }

  return {
    bootstrap,
    hydration: null
  }
}

describe('useFilterView exact taxonomy metadata', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
    setActivePinia(createPinia())
    resetPublicRouteSeedStoreForTests()
    mocks.getArticles.mockResolvedValue(emptyArticlePage())
    mocks.getCategoryExactMetadata.mockReset()
    mocks.getTagExactMetadata.mockReset()
    mocks.getTagExactMetadataByName.mockReset()
    mocks.getCategories.mockReset()
    mocks.getTags.mockReset()
    mocks.getArticles.mockClear()
  })

  afterEach(() => {
    resetPublicRouteSeedStoreForTests()
    vi.clearAllMocks()
  })

  it('loads one exact category metadata read and no category list for unseeded SPA navigation', async () => {
    mocks.getCategoryExactMetadata.mockResolvedValue({
      id: 7,
      name: '架构',
      description: '关于系统架构与设计的深度文章'
    })
    const router = await createFilterRouter('/category/7')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getCategoryExactMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.getCategoryExactMetadata).toHaveBeenCalledWith(7, expect.objectContaining({
      signal: expect.any(AbortSignal)
    }))
    expect(mocks.getCategories).not.toHaveBeenCalled()
    expect(mocks.getTags).not.toHaveBeenCalled()
    expect(mocks.getArticles).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 7, tagId: undefined }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(api().filterView.value.header.currentName).toBe('架构')
    expect(api().filterView.value.header.description).toBe('关于系统架构与设计的深度文章')
    expect(api().invalidTarget.value).toBe(false)
    wrapper.unmount()
  })

  it('loads one exact tag metadata read and no tag list for unseeded tag-id SPA navigation', async () => {
    mocks.getTagExactMetadata.mockResolvedValue({
      id: 11,
      name: 'C#',
      description: '语言笔记'
    })
    const router = await createFilterRouter('/tag/11')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getTagExactMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.getTagExactMetadata).toHaveBeenCalledWith(11, expect.objectContaining({
      signal: expect.any(AbortSignal)
    }))
    expect(mocks.getTagExactMetadataByName).not.toHaveBeenCalled()
    expect(mocks.getTags).not.toHaveBeenCalled()
    expect(mocks.getCategories).not.toHaveBeenCalled()
    expect(mocks.getArticles).toHaveBeenCalledWith(
      expect.objectContaining({ tagId: 11, categoryId: undefined }),
      expect.any(Object)
    )
    expect(api().filterView.value.header.currentName).toBe('C#')
    expect(api().filterView.value.header.description).toBe('语言笔记')
    wrapper.unmount()
  })

  it('resolves a tag name through the exact name helper and canonicalizes to the tag-id URL', async () => {
    mocks.getTagExactMetadataByName.mockResolvedValue({
      id: 11,
      name: 'C#',
      description: 'alias-canonical'
    })
    mocks.getTagExactMetadata.mockResolvedValue({
      id: 11,
      name: 'C#',
      description: 'alias-canonical'
    })
    const router = await createFilterRouter('/tag/CSharp?page=2#section')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getTagExactMetadataByName).toHaveBeenCalledTimes(1)
    expect(mocks.getTagExactMetadataByName).toHaveBeenCalledWith('CSharp', expect.objectContaining({
      signal: expect.any(AbortSignal)
    }))
    expect(mocks.getTags).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/tag/11')
    expect(router.currentRoute.value.query.page).toBe('2')
    expect(router.currentRoute.value.query.cursor).toBeUndefined()
    expect(router.currentRoute.value.hash).toBe('#section')
    expect(mocks.getArticles).not.toHaveBeenCalled()
    expect(api().hasError.value).toBe(true)
    expect(api().filterView.value.header.currentName).toBe('C#')
    expect(api().filterView.value.header.description).toBe('alias-canonical')
    wrapper.unmount()
  })

  it('uses response cursors for forward navigation and browser back', async () => {
    mocks.getCategoryExactMetadata.mockResolvedValue({
      id: 7,
      name: '架构',
      description: null
    })
    mocks.getArticles
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: true, nextCursor: 'cursor_page_2' })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: true, nextCursor: 'cursor_page_2' })

    const router = await createFilterRouter('/category/7')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ page: 1, cursor: null, categoryId: 7 }),
      expect.any(Object)
    )
    expect(api().canGoNext.value).toBe(true)
    expect(api().filterView.value.pagination.nextHref).toBe('/category/7?page=2&cursor=cursor_page_2')

    api().handlePageChange(2)
    await flushPromises()

    expect(router.currentRoute.value.query).toMatchObject({ page: '2', cursor: 'cursor_page_2' })
    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ page: 2, cursor: 'cursor_page_2', categoryId: 7 }),
      expect.any(Object)
    )
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })

    router.back()
    await flushPromises()

    expect(router.currentRoute.value.query.page).toBeUndefined()
    expect(router.currentRoute.value.query.cursor).toBeUndefined()
    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ page: 1, cursor: null, categoryId: 7 }),
      expect.any(Object)
    )
    wrapper.unmount()
  })

  it('restores a refreshed deep URL only when its opaque cursor is present', async () => {
    mocks.getCategoryExactMetadata.mockResolvedValue({
      id: 7,
      name: '架构',
      description: null
    })
    mocks.getArticles.mockResolvedValue({ items: [], total: 20, hasMore: false, nextCursor: null })

    const router = await createFilterRouter('/category/7?page=2&cursor=cursor_page_2')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(api().currentPage.value).toBe(2)
    expect(mocks.getArticles).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, cursor: 'cursor_page_2', categoryId: 7 }),
      expect.any(Object)
    )
    wrapper.unmount()
  })

  it('uses a seeded Filter description without a fallback metadata request', async () => {
    putPublicRouteSeed({
      kind: 'Filter',
      fullPath: '/category/7',
      routeKey: 'category:7',
      seed: createCategoryBootstrapSeed()
    })
    const router = await createFilterRouter('/category/7')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getCategoryExactMetadata).not.toHaveBeenCalled()
    expect(mocks.getTagExactMetadata).not.toHaveBeenCalled()
    expect(mocks.getTagExactMetadataByName).not.toHaveBeenCalled()
    expect(mocks.getCategories).not.toHaveBeenCalled()
    expect(mocks.getTags).not.toHaveBeenCalled()
    expect(mocks.getArticles).not.toHaveBeenCalled()
    expect(api().filterView.value.header.currentName).toBe('架构')
    expect(api().filterView.value.header.description).toBe('关于系统架构与设计的深度文章')
    wrapper.unmount()
  })

  it('sets search description to null and skips taxonomy metadata endpoints', async () => {
    const router = await createFilterRouter('/search?q=AOT')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getCategoryExactMetadata).not.toHaveBeenCalled()
    expect(mocks.getTagExactMetadata).not.toHaveBeenCalled()
    expect(mocks.getTagExactMetadataByName).not.toHaveBeenCalled()
    expect(mocks.getCategories).not.toHaveBeenCalled()
    expect(mocks.getTags).not.toHaveBeenCalled()
    expect(mocks.getArticles).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        cursor: null,
        keyword: 'AOT',
        sort: 'relevance'
      }),
      expect.any(Object)
    )
    expect(api().filterView.value.header.description).toBeNull()
    expect(api().filterView.value.header.currentName).toBe('“AOT”')
    wrapper.unmount()
  })

  it('preserves search sort and opaque cursor across forward navigation and refresh', async () => {
    mocks.getArticles
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: true, nextCursor: 'cursor_search_2' })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [], total: 20, hasMore: false, nextCursor: null })

    const router = await createFilterRouter('/search?q=AOT&sort=hot')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        page: 1,
        cursor: null,
        keyword: 'AOT',
        sort: 'hot'
      }),
      expect.any(Object)
    )
    expect(api().filterView.value.pagination.nextHref)
      .toBe('/search?q=AOT&sort=hot&page=2&cursor=cursor_search_2')

    api().handlePageChange(2)
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({
      q: 'AOT',
      sort: 'hot',
      page: '2',
      cursor: 'cursor_search_2'
    })
    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        page: 2,
        cursor: 'cursor_search_2',
        keyword: 'AOT',
        sort: 'hot'
      }),
      expect.any(Object)
    )
    wrapper.unmount()

    const refreshRouter = await createFilterRouter('/search?q=AOT&sort=hot&page=2&cursor=cursor_search_2')
    const refreshMount = mountFilterView(refreshRouter)
    await flushPromises()
    expect(mocks.getArticles).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        page: 2,
        cursor: 'cursor_search_2',
        keyword: 'AOT',
        sort: 'hot'
      }),
      expect.any(Object)
    )
    refreshMount.wrapper.unmount()
  })

  it('rejects a first-page search cursor before API dispatch', async () => {
    const router = await createFilterRouter('/search?q=AOT&cursor=cursor_search_2')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(api().currentPage.value).toBe(1)
    expect(api().hasError.value).toBe(true)
    expect(mocks.getArticles).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('preserves invalid-target and empty article list when exact metadata is missing', async () => {
    mocks.getCategoryExactMetadata.mockRejectedValue(notFoundError())
    const router = await createFilterRouter('/category/99')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()

    expect(mocks.getCategoryExactMetadata).toHaveBeenCalledTimes(1)
    expect(mocks.getArticles).not.toHaveBeenCalled()
    expect(api().invalidTarget.value).toBe(true)
    expect(api().filterView.value.empty.isInvalidTarget).toBe(true)
    expect(api().filterView.value.articles).toEqual([])
    expect(api().filterView.value.header.description).toBeNull()
    wrapper.unmount()
  })

  it('replaces a previous description with null instead of keeping the stale SPA value', async () => {
    mocks.getCategoryExactMetadata.mockImplementation(async (id: number) => {
      if (id === 7) {
        return { id: 7, name: '架构', description: '关于系统架构与设计的深度文章' }
      }
      return { id: 8, name: '生活', description: null }
    })
    const router = await createFilterRouter('/category/7')
    const { wrapper, api } = mountFilterView(router)
    await flushPromises()
    expect(api().filterView.value.header.description).toBe('关于系统架构与设计的深度文章')

    await router.push('/category/8')
    await flushPromises()

    expect(api().filterView.value.header.currentName).toBe('生活')
    expect(api().filterView.value.header.description).toBeNull()
    wrapper.unmount()
  })

  it('aborts in-flight exact metadata when the page unmounts', async () => {
    const observed: { signal: AbortSignal | null } = { signal: null }
    mocks.getCategoryExactMetadata.mockImplementation((_id: number, config?: { signal?: AbortSignal }) => {
      observed.signal = config?.signal ?? null
      return new Promise(() => {})
    })
    const router = await createFilterRouter('/category/7')
    const { wrapper } = mountFilterView(router)
    await Promise.resolve()
    expect(observed.signal).not.toBeNull()
    wrapper.unmount()
    expect(observed.signal?.aborted).toBe(true)
  })
})
