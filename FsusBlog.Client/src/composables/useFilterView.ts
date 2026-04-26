import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AxiosRequestConfig } from 'axios'
import { getArticles, type ArticleListItemResponse, type PageResponse } from '@/api/article'
import { consumePublicAotBootstrap, toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { getCategories, type CategoryItem } from '@/api/category'
import { getTags, type TagItem } from '@/api/tag'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { usePagedListState } from '@/composables/usePagedListState'
import { matchesCategoryFilter, matchesTagFilter, removeArticlePreview, upsertArticlePreview } from '@/services/sseArticlePatch'
import type { ArticleUpdatePayload, SseArticleRenderPatch } from '@/services/sseTypes'
import { useSseStore } from '@/store/sse'
import { isAbortError } from '@/utils/errors'
import { createArticleListCardViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'
import { createFilterEmptyStateViewContract, createFilterHeaderViewContract, createFilterLoadingStateViewContract } from '@/view-contracts/filterView'
import { loadDeepSearchIndex, searchIndex, type SearchSortMode } from '@/services/localSearch'

type NamedMeta = Pick<CategoryItem, 'id' | 'name'> | Pick<TagItem, 'id' | 'name'>

export function useFilterView() {
  const route = useRoute()
  const router = useRouter()
  const sseStore = useSseStore()
  const powProvider = usePow()
  const initialBootstrap = consumePublicAotBootstrap('Filter')

  const filterType = ref<'category' | 'tag' | 'search'>('category')
  const filterId = ref<number>(0)
  const currentName = ref('')
  const articleItems = ref<ArticleListItemResponse[]>([])
  const loadingMeta = ref(true)
  const {
    loading: loadingArticles,
    currentPage,
    pageSize,
    total,
    totalPages,
    beginLoading,
    endLoading,
    setPageTotal
  } = usePagedListState({ pageSize: 10 })
  const hasError = ref(false)
  const searchKeyword = computed(() => String(route.query.q || '').trim())
  const searchSortMode = ref<SearchSortMode>('relevance')
  const pageIndicatorText = computed(
    () => `${String(currentPage.value).padStart(2, '0')} / ${String(totalPages.value).padStart(2, '0')}`
  )
  const canGoPrev = computed(() => currentPage.value > 1 && !loadingArticles.value)
  const canGoNext = computed(() => currentPage.value < totalPages.value && !loadingArticles.value)
  const isLoadingState = computed(
    () => loadingArticles.value || powProvider.isCalculating.value
  )
  const articles = computed<ArticleListCardViewContract[]>(() =>
    articleItems.value.map((item, index) => createArticleListCardViewContract(item, index))
  )

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

  let bootstrapApplied = false
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      articleTask.cancel()
    }
  })

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

      if (lifecycle.isActive() && !signal.aborted) {
        const targetId = Number(route.params.id)
        const match = (list as NamedMeta[]).find((item) => item.id === targetId)
        currentName.value = match ? match.name : '未发现'
      }
    } catch (error: unknown) {
      if (!isAbortError(error) && lifecycle.isActive() && !signal.aborted) {
        currentName.value = '加载失败'
      }
    } finally {
      if (lifecycle.isActive() && !signal.aborted) {
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
        if (lifecycle.isActive() && !signal.aborted) {
          articleItems.value = []
          setPageTotal(0)
          hasError.value = false
        }
        return
      }

      let response: PageResponse<ArticleListItemResponse> | ArticleListItemResponse[]
      if (isSearch) {
        await loadDeepSearchIndex(signal)
        response = await searchIndex(keyword, searchSortMode.value, currentPage.value, pageSize.value, signal)
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

      if (lifecycle.isActive() && !signal.aborted) {
        const items = Array.isArray(response) ? response : response.items
        const count = Array.isArray(response) ? items.length : response.total
        articleItems.value = items
        setPageTotal(count)
        hasError.value = false
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return
      }

      if (lifecycle.isActive() && !signal.aborted) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[FilterView] Load Fail:', msg)
        hasError.value = true
        articleItems.value = []
        setPageTotal(0)
      }
    } finally {
      if (lifecycle.isActive() && !signal.aborted) {
        endLoading()
      }
    }
  }

  const init = async (): Promise<void> => {
    articleTask.cancel()

    hasError.value = false
    if (route.query.q !== undefined) {
      filterType.value = 'search'
      filterId.value = 0
      const rawSort = String(route.query.sort || '').trim().toLowerCase()
      searchSortMode.value = rawSort === 'latest' || rawSort === 'hot' ? rawSort : 'relevance'
    } else {
      filterType.value = route.path.includes('/category') ? 'category' : 'tag'
      filterId.value = Number(route.params.id) || 0
      searchSortMode.value = 'relevance'
    }
    currentPage.value = 1

    const filterBootstrap = !bootstrapApplied && filterType.value !== 'search'
      ? initialBootstrap?.filter
      : null

    if (filterBootstrap) {
      const bootstrapItems = Array.isArray(filterBootstrap.articles)
        ? filterBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
        : []

      articleItems.value = bootstrapItems
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
    lifecycle.scheduleSync(() => {
      if (!articleTask.isRunning.value) {
        void articleTask.run(async (signal) => await loadArticles(false, signal))
      }
    })
  }

  const matchesCurrentFilter = (article: ArticleListItemResponse): boolean => {
    if (filterType.value === 'category') {
      return matchesCategoryFilter(article, filterId.value)
    }

    if (filterType.value === 'tag') {
      return matchesTagFilter(article, filterId.value)
    }

    return false
  }

  const applyArticlePatch = (payload: ArticleUpdatePayload): boolean => {
    if (filterType.value === 'search') {
      return false
    }

    const exists = articleItems.value.some((article) => article.id === payload.articleId)
    const preview = payload.preview ?? null

    if (payload.action === 'Created' || payload.action === 'Restored') {
      if (!preview) {
        return false
      }

      if (!matchesCurrentFilter(preview)) {
        return true
      }

      if (!exists) {
        setPageTotal(total.value + 1)
      }

      if (currentPage.value === 1) {
        articleItems.value = upsertArticlePreview(articleItems.value, preview).slice(0, pageSize.value)
      }

      return true
    }

    if (payload.action === 'Updated') {
      if (!preview) {
        return false
      }

      const matches = matchesCurrentFilter(preview)
      if (exists && matches) {
        articleItems.value = upsertArticlePreview(articleItems.value, preview)
        return true
      }

      if (exists && !matches) {
        articleItems.value = removeArticlePreview(articleItems.value, payload.articleId)
        setPageTotal(Math.max(0, total.value - 1))
        return false
      }

      if (!exists && matches && currentPage.value === 1) {
        setPageTotal(total.value + 1)
        articleItems.value = upsertArticlePreview(articleItems.value, preview).slice(0, pageSize.value)
        return false
      }

      return true
    }

    if (!exists) {
      return true
    }

    articleItems.value = removeArticlePreview(articleItems.value, payload.articleId)
    setPageTotal(Math.max(0, total.value - 1))
    return false
  }

  const handleArticleBatch = (patches: readonly SseArticleRenderPatch[]): void => {
    let needsSync = false

    for (const patch of patches) {
      if (patch.kind === 'reconnected') {
        needsSync = true
        continue
      }

      if (!patch.event || !applyArticlePatch(patch.event.payload)) {
        needsSync = true
      }
    }

    if (needsSync && lifecycle.isActive()) {
      dispatchSync()
    }
  }

  function handlePageChange(page: number): void {
    if (page < 1 || page > totalPages.value || loadingArticles.value) {
      return
    }
    currentPage.value = page

    void articleTask.run(async (signal) => await loadArticles(true, signal))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function setSearchSortMode(mode: SearchSortMode): void {
    if (filterType.value !== 'search' || searchSortMode.value === mode) {
      return
    }

    searchSortMode.value = mode
    currentPage.value = 1

    const nextQuery = { ...route.query }
    if (mode === 'relevance') {
      delete nextQuery.sort
    } else {
      nextQuery.sort = mode
    }

    void router.replace({ path: route.path, query: nextQuery })
  }

  watch([() => route.params.id, () => route.query.q, () => route.query.sort], () => {
    void init()
  })

  watch(
    () => sseStore.articleRevision,
    () => {
      if (!lifecycle.isActive()) {
        return
      }

      handleArticleBatch(sseStore.articleBatch)
    }
  )

  onMounted(() => {
    void init()
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
    searchSortMode,
    pageIndicatorText,
    canGoPrev,
    canGoNext,
    isLoadingState,
    labelText,
    handlePageChange,
    setSearchSortMode,
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
