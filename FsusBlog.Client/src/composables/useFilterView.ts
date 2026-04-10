import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { AxiosRequestConfig } from 'axios'
import { getArticles, searchArticles, type ArticleListItem, type ArticleListRes } from '@/api/article'
import { consumePublicAotBootstrap, toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { getCategories, type CategoryItem } from '@/api/category'
import { getTags, type TagItem } from '@/api/tag'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { useAotRenderBridge } from '@/composables/useAotRenderBridge'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'
import { isAbortError } from '@/utils/errors'
import { createArticleListCardViewContract, createArticleListViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'
import { createFilterEmptyStateViewContract, createFilterHeaderViewContract, createFilterLoadingStateViewContract } from '@/view-contracts/filterView'
import { renderArticleListAot } from '@/renderers/aot'
import { FrameType } from '@wasm/protocol/frame'

const SIGNALS = {
  CREATED: 'signalr:article-created',
  UPDATED: 'signalr:article-updated',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected'
} as const

type NamedMeta = Pick<CategoryItem, 'id' | 'name'> | Pick<TagItem, 'id' | 'name'>
type RouteSignalPayload = { articleId?: string | number }

export function useFilterView() {
  const route = useRoute()
  const powProvider = usePow()
  const initialBootstrap = consumePublicAotBootstrap('Filter')

  const filterType = ref<'category' | 'tag' | 'search'>('category')
  const filterId = ref<number>(0)
  const currentName = ref('')
  const articles = ref<ArticleListCardViewContract[]>([])
  const loadingMeta = ref(true)
  const {
    loading: loadingArticles,
    currentPage,
    pageSize,
    totalPages,
    beginLoading,
    endLoading,
    setPageTotal
  } = usePagedListState({ pageSize: 10 })
  const hasError = ref(false)
  const serverShellPresent = typeof document !== 'undefined' && hasServerAotShell(document.getElementById('app'))
  const searchKeyword = computed(() => String(route.query.q || '').trim())
  const pageIndicatorText = computed(
    () => `${String(currentPage.value).padStart(2, '0')} / ${String(totalPages.value).padStart(2, '0')}`
  )
  const canGoPrev = computed(() => currentPage.value > 1 && !loadingArticles.value)
  const canGoNext = computed(() => currentPage.value < totalPages.value && !loadingArticles.value)
  const isLoadingState = computed(
    () => loadingArticles.value || powProvider.isCalculating.value
  )
  const shouldDelayLoadingSkeleton = computed(() => serverShellPresent && filterType.value !== 'search')

  const labelText = computed(() => {
    if (filterType.value === 'category') {
      return '分类'
    }
    if (filterType.value === 'tag') {
      return '标签'
    }
    return '搜索'
  })

  const articleTask = useAbortableTask()
  const buildSignalConfig = (signal: AbortSignal): AxiosRequestConfig => ({ signal })

  let isMounted = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let bootstrapApplied = false

  const { aotRenderedHtml, clearAotHtml } = useAotRenderBridge({
    frameType: FrameType.ArticleList,
    onRefresh: () => {
      if (!articleTask.isRunning.value) {
        void articleTask.run(async (signal) => await loadArticles(true, signal))
      }
    },
    onPageNext: () => handlePageChange(currentPage.value + 1),
    onPagePrev: () => handlePageChange(currentPage.value - 1),
    cooldownMs: 300
  })

  const syncAotHtml = (items: ArticleListItem[], total: number): void => {
    if (items.length === 0) {
      clearAotHtml()
      return
    }

    const view = createArticleListViewContract(
      { items, total },
      {
        currentPage: currentPage.value,
        pageSize: pageSize.value,
        searchKeyword: filterType.value === 'search' ? searchKeyword.value : ''
      }
    )
    aotRenderedHtml.value = renderArticleListAot(view)
  }

  const loadMetaName = async (signal: AbortSignal): Promise<void> => {
    if (filterType.value === 'search') {
      currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
      loadingMeta.value = false
      return
    }

    loadingMeta.value = true
    try {
      const fetchFn = filterType.value === 'category' ? getCategories : getTags
      const list = await fetchFn(buildSignalConfig(signal))

      if (isMounted && !signal.aborted) {
        const targetId = Number(route.params.id)
        const match = (list as NamedMeta[]).find((item) => item.id === targetId)
        currentName.value = match ? match.name : '未发现'
      }
    } catch (error: unknown) {
      if (!isAbortError(error) && isMounted && !signal.aborted) {
        currentName.value = '加载失败'
      }
    } finally {
      if (isMounted && !signal.aborted) {
        loadingMeta.value = false
      }
    }
  }

  const loadArticles = async (showLoading: boolean, signal: AbortSignal): Promise<void> => {
    if (showLoading) {
      beginLoading()
      hasError.value = false
    }

    try {
      const isSearch = filterType.value === 'search'
      const keyword = searchKeyword.value

      if (isSearch && !keyword) {
        if (isMounted && !signal.aborted) {
          articles.value = []
          setPageTotal(0)
          hasError.value = false
          clearAotHtml()
        }
        return
      }

      let response: ArticleListRes | ArticleListItem[]
      if (isSearch) {
        const config: AxiosRequestConfig = { signal, requiresPow: true }
        response = await searchArticles({ keyword }, config)
      } else {
        response = await getArticles(
          {
            page: currentPage.value,
            size: pageSize.value,
            categoryId: filterType.value === 'category' ? filterId.value : undefined,
            tagId: filterType.value === 'tag' ? filterId.value : undefined
          },
          buildSignalConfig(signal)
        )
      }

      if (isMounted && !signal.aborted) {
        const items = Array.isArray(response) ? response : response.items
        const count = Array.isArray(response) ? items.length : response.total
        articles.value = items.map((item, index) => createArticleListCardViewContract(item, index))
        setPageTotal(count)
        hasError.value = false
        syncAotHtml(items, count)
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return
      }

      if (isMounted && !signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[FilterView] Load Fail:', msg)
        hasError.value = true
        articles.value = []
        setPageTotal(0)
        clearAotHtml()
      }
    } finally {
      if (isMounted && !signal.aborted) {
        endLoading()
      }
    }
  }

  const init = async (): Promise<void> => {
    articleTask.cancel()
    clearAotHtml()

    hasError.value = false
    if (route.query.q !== undefined) {
      filterType.value = 'search'
      filterId.value = 0
      powProvider.prewarm()
    } else {
      filterType.value = route.path.includes('/category') ? 'category' : 'tag'
      filterId.value = Number(route.params.id) || 0
    }
    currentPage.value = 1

    const filterBootstrap = !bootstrapApplied && filterType.value !== 'search'
      ? initialBootstrap?.filter
      : null

    if (filterBootstrap) {
      const bootstrapItems = Array.isArray(filterBootstrap.articles)
        ? filterBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
        : []

      articles.value = bootstrapItems.map((item, index) => createArticleListCardViewContract(item, index))
      setPageTotal(Number(filterBootstrap.total) || 0)
      bootstrapApplied = true

      try {
        await articleTask.run(async (signal) => {
          await loadMetaName(signal)
        })
      } catch {
        // ignore abort
      }

      return
    }

    try {
      await articleTask.run(async (signal) => {
        await Promise.allSettled([loadMetaName(signal), loadArticles(true, signal)])
      })
    } catch {
      // ignore abort
    }
  }

  const dispatchSync = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      if (isMounted && !articleTask.isRunning.value) {
        void articleTask.run(async (signal) => await loadArticles(false, signal))
      }
      debounceTimer = null
    }, 500)
  }

  const handleRemoteCreated = (): void => {
    if (filterType.value === 'search' || currentPage.value === 1) {
      dispatchSync()
    }
  }

  const handleRemoteUpdated = (event: Event): void => {
    const data = (event as CustomEvent<RouteSignalPayload>).detail
    if (!data?.articleId) {
      return
    }

    const targetId = String(data.articleId)
    const exists = articles.value.some((article) => String(article.id) === targetId)
    if (exists || filterType.value === 'search') {
      dispatchSync()
    }
  }

  const handleReconnected = (): void => {
    if (isMounted) {
      void articleTask.run(async (signal) => await loadArticles(false, signal))
    }
  }

  const signalListeners = [
    { name: SIGNALS.CREATED, handler: handleRemoteCreated },
    { name: SIGNALS.UPDATED, handler: handleRemoteUpdated },
    { name: SIGNALS.DELETED, handler: dispatchSync },
    { name: SIGNALS.RESTORED, handler: handleRemoteCreated },
    { name: SIGNALS.RECONNECTED, handler: handleReconnected }
  ] as const

  function handlePageChange(page: number): void {
    if (page < 1 || page > totalPages.value || loadingArticles.value) {
      return
    }
    currentPage.value = page

    void articleTask.run(async (signal) => await loadArticles(true, signal))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  watch([() => route.params.id, () => route.query.q], () => {
    void init()
  })

  useWindowEvents(signalListeners)

  onMounted(() => {
    isMounted = true
    void init()
  })

  onUnmounted(() => {
    isMounted = false
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    articleTask.cancel()
    clearAotHtml()
  })

  return {
    route,
    powProvider,
    filterType,
    currentName,
    articles,
    loadingMeta,
    loadingArticles,
    currentPage,
    totalPages,
    hasError,
    searchKeyword,
    pageIndicatorText,
    canGoPrev,
    canGoNext,
    isLoadingState,
    labelText,
    handlePageChange,
    aotRenderedHtml,
    shouldDelayLoadingSkeleton,
    filterView: computed(() => ({
      header: createFilterHeaderViewContract({
        labelText: labelText.value,
        currentName: currentName.value,
        loadingMeta: loadingMeta.value
      }),
      loading: createFilterLoadingStateViewContract({
        loadingArticles: loadingArticles.value,
        isPowCalculating: powProvider.isCalculating.value
      }),
      empty: createFilterEmptyStateViewContract(hasError.value),
      articles: articles.value,
      pagination: {
        currentPage: currentPage.value,
        totalPages: totalPages.value,
        pageIndicatorText: pageIndicatorText.value,
        canGoPrev: canGoPrev.value,
        canGoNext: canGoNext.value
      }
    }))
  }
}
