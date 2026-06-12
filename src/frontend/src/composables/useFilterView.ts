import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { getArticles, type ArticleListItemResponse, type PageResponse } from '@/api/article'
import { toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { getCategories, type CategoryItem } from '@/api/category'
import { getTags, type TagItem } from '@/api/tag'
import { usePow } from '@/composables/usePow'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { usePagedListState } from '@/composables/usePagedListState'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed'
import { matchesCategoryFilter, matchesTagFilter, removeArticlePreview, upsertArticlePreview } from '@/services/notificationStreamArticlePatch'
import type { ArticleUpdatePayload, NotificationStreamArticleRenderPatch } from '@/services/notificationStreamTypes'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { isAbortError } from '@/utils/errors'
import type { ArticleListCardViewContract } from '@/view-contracts/articleList'
import { createStableArticleCardMapper } from '@/view-contracts/articleListStableCache'
import { createFilterPageViewContract } from '@/view-contracts/filterView'
import { searchIndex, type SearchSortMode } from '@/services/localSearch'
import {
  getPublicFilterLabel,
  PUBLIC_FILTER_TYPE,
  type PublicFilterType
} from '@/public-renderers/publicFilterSemantics'
import { resolvePublicFilterIdentity } from '@/public-renderers/publicRouteIdentity'

type NamedMeta = Pick<CategoryItem, 'id' | 'name'> | Pick<TagItem, 'id' | 'name'>
type ResolvedFilterTarget = Readonly<{
  valid: boolean
  filterId: number
  currentName: string
  isInvalidTarget: boolean
}>

type RouteFilterIdentity = ReturnType<typeof resolvePublicFilterIdentity>

const parsePageQuery = (value: unknown): number => {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export function useFilterView() {
  const route = useRoute()
  const router = useRouter()
  const notificationStreamStore = useNotificationStreamStore()
  const powProvider = usePow()
  const { bootstrap: initialBootstrap, hydration: initialHydrationView } = consumePublicPageSeed('Filter')
  const preferHydrationView = ref(Boolean(initialHydrationView?.view))
  const mapArticleCards = createStableArticleCardMapper()

  const filterType = ref<PublicFilterType>(PUBLIC_FILTER_TYPE.category)
  const filterId = ref<number>(0)
  const filterValue = ref('')
  const currentName = ref('')
  const invalidTarget = ref(false)
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
    mapArticleCards(articleItems.value)
  )

  const labelText = computed(() => getPublicFilterLabel(filterType.value))

  const articleTask = useAbortableTask()
  const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal })
  const resolveRouteFilterIdentity = (): RouteFilterIdentity => resolvePublicFilterIdentity({
    routeName: typeof route.name === 'string' ? route.name : null,
    routeParam: route.params.id,
    searchKeyword: route.query.q
  })
  const resolveBootstrapFilterMeta = () => {
    if (!initialBootstrap || filterType.value === PUBLIC_FILTER_TYPE.search) {
      return null
    }

    const bootstrapType = initialBootstrap.filter?.filterType ?? initialBootstrap.filterType
    const expectedType = filterType.value === PUBLIC_FILTER_TYPE.category || filterType.value === PUBLIC_FILTER_TYPE.tag
      ? filterType.value
      : null
    if (expectedType && bootstrapType && bootstrapType !== expectedType) {
      return null
    }

    const bootstrapKey = initialBootstrap.filter?.filterKey?.trim() || initialBootstrap.filterKey?.trim() || ''
    const bootstrapId = Number(initialBootstrap.filter?.filterId ?? initialBootstrap.filterId ?? 0)
    const filterName = initialBootstrap.filter?.filterName?.trim() || initialBootstrap.filterName?.trim() || ''
    const title = initialBootstrap.title?.trim() || ''
    const isInvalidTarget = Boolean(initialBootstrap.filter?.isInvalidTarget ?? initialBootstrap.isInvalidTarget)
    const routeIdentity = resolveRouteFilterIdentity()
    const routeMatchedByKey = bootstrapKey.length > 0 && bootstrapKey === routeIdentity.filterKey
    const routeMatchedById = bootstrapId > 0 && bootstrapId === routeIdentity.filterId
    const routeMatchedByName = filterType.value === PUBLIC_FILTER_TYPE.tag
      && filterValue.value.length > 0
      && filterName === filterValue.value
    if (bootstrapId > 0 && !routeMatchedById && !routeMatchedByName && !routeMatchedByKey && !isInvalidTarget) {
      return null
    }

    return {
      filterKey: bootstrapKey,
      filterName,
      title,
      isInvalidTarget
    }
  }

  const primeInitialSeoState = (): boolean => {
    const routeIdentity = resolveRouteFilterIdentity()
    if (routeIdentity.filterType === PUBLIC_FILTER_TYPE.search) {
      filterType.value = PUBLIC_FILTER_TYPE.search
      filterId.value = 0
      filterValue.value = ''
      currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
      invalidTarget.value = false
      loadingMeta.value = false
      const rawSort = String(route.query.sort || '').trim().toLowerCase()
      searchSortMode.value = rawSort === 'latest' || rawSort === 'hot' ? rawSort : 'relevance'
      return false
    }

    filterType.value = routeIdentity.filterType
    filterValue.value = typeof routeIdentity.filterName === 'string' ? routeIdentity.filterName : String(route.params.id ?? '').trim()
    filterId.value = routeIdentity.filterId
    invalidTarget.value = false
    searchSortMode.value = 'relevance'

    const bootstrapMeta = resolveBootstrapFilterMeta()
    currentName.value = bootstrapMeta?.filterName || bootstrapMeta?.title || ''
    invalidTarget.value = Boolean(bootstrapMeta?.isInvalidTarget)
      || (filterType.value === PUBLIC_FILTER_TYPE.category && filterId.value <= 0)
    loadingMeta.value = !(currentName.value || invalidTarget.value)

    const filterBootstrap = initialBootstrap?.filter
    if (!filterBootstrap || Boolean(filterBootstrap.isInvalidTarget)) {
      return false
    }

    const bootstrapItems = Array.isArray(filterBootstrap.articles)
      ? filterBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
      : []

    articleItems.value = bootstrapItems
    setPageTotal(Number(filterBootstrap.total) || 0)
    currentPage.value = Math.max(1, Number(filterBootstrap.pageIndex) || 1)
    currentName.value = filterBootstrap.filterName?.trim() || currentName.value
    if (Number(filterBootstrap.filterId) > 0) {
      filterId.value = Number(filterBootstrap.filterId)
    }
    loadingMeta.value = false
    return true
  }

  let bootstrapApplied = primeInitialSeoState()
  if (initialHydrationView?.view) {
    currentPage.value = Math.max(1, Number(initialHydrationView.view.pagination.currentPage) || currentPage.value)
    setPageTotal(Number(initialHydrationView.filter?.total ?? initialHydrationView.view.articles.length) || 0)
  }

  currentPage.value = parsePageQuery(route.query.page)

  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      articleTask.cancel()
    }
  })

  const resolveCurrentTarget = async (signal: AbortSignal): Promise<ResolvedFilterTarget> => {
    const bootstrapMeta = resolveBootstrapFilterMeta()
    if (filterType.value === PUBLIC_FILTER_TYPE.search) {
      return {
        valid: true,
        filterId: 0,
        currentName: route.query.q ? `“${route.query.q}”` : '全站搜索',
        isInvalidTarget: false
      }
    }

    if (filterType.value === PUBLIC_FILTER_TYPE.category && filterId.value <= 0) {
      return {
        valid: false,
        filterId: 0,
        currentName: bootstrapMeta?.title || '未发现分类',
        isInvalidTarget: true
      }
    }

    if (bootstrapMeta?.filterName && !bootstrapMeta.isInvalidTarget && filterId.value > 0) {
      return {
        valid: true,
        filterId: filterId.value,
        currentName: bootstrapMeta.filterName,
        isInvalidTarget: false
      }
    }

    loadingMeta.value = true
    const fetchFn = filterType.value === PUBLIC_FILTER_TYPE.category ? getCategories : getTags
    const list = await fetchFn(buildSignalConfig(signal))
    const match = filterType.value === PUBLIC_FILTER_TYPE.category
      ? (list as NamedMeta[]).find((item) => item.id === filterId.value)
      : (list as NamedMeta[]).find((item) => item.id === filterId.value || item.name === filterValue.value)

    if (!match) {
      return {
        valid: false,
        filterId: 0,
        currentName: bootstrapMeta?.title
          || (filterType.value === PUBLIC_FILTER_TYPE.category ? '未发现分类' : '未发现标签'),
        isInvalidTarget: true
      }
    }

    return {
      valid: true,
      filterId: match.id,
      currentName: match.name,
      isInvalidTarget: false
    }
  }

  const loadMetaName = async (signal: AbortSignal): Promise<void> => {
    if (filterType.value === PUBLIC_FILTER_TYPE.search) {
      currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
      invalidTarget.value = false
      loadingMeta.value = false
      return
    }

    try {
      const resolved = await resolveCurrentTarget(signal)
      if (lifecycle.isActive() && !signal.aborted) {
        filterId.value = resolved.filterId
        currentName.value = resolved.currentName
        invalidTarget.value = resolved.isInvalidTarget
      }
    } catch (error: unknown) {
      if (!isAbortError(error) && lifecycle.isActive() && !signal.aborted) {
        const bootstrapMeta = resolveBootstrapFilterMeta()
        currentName.value = bootstrapMeta?.filterName || bootstrapMeta?.title || '加载失败'
        invalidTarget.value = Boolean(bootstrapMeta?.isInvalidTarget)
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
      const isSearch = filterType.value === PUBLIC_FILTER_TYPE.search
      const keyword = searchKeyword.value

      if (isSearch && !keyword) {
        if (lifecycle.isActive() && !signal.aborted) {
          articleItems.value = []
          setPageTotal(0)
          hasError.value = false
        }
        return
      }

      if (!isSearch && invalidTarget.value) {
        if (lifecycle.isActive() && !signal.aborted) {
          articleItems.value = []
          setPageTotal(0)
          hasError.value = false
        }
        return
      }

      let response: PageResponse<ArticleListItemResponse> | ArticleListItemResponse[]
      if (isSearch) {
        response = await searchIndex(keyword, searchSortMode.value, currentPage.value, pageSize.value, signal)
      } else {
        response = await getArticles(
          {
            page: currentPage.value,
            size: pageSize.value,
            categoryId: filterType.value === PUBLIC_FILTER_TYPE.category ? filterId.value : undefined,
            tagId: filterType.value === PUBLIC_FILTER_TYPE.tag ? filterId.value : undefined
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
    const routeIdentity = resolveRouteFilterIdentity()
    if (routeIdentity.filterType === PUBLIC_FILTER_TYPE.search) {
      filterType.value = PUBLIC_FILTER_TYPE.search
      filterId.value = 0
      filterValue.value = ''
      invalidTarget.value = false
      const rawSort = String(route.query.sort || '').trim().toLowerCase()
      searchSortMode.value = rawSort === 'latest' || rawSort === 'hot' ? rawSort : 'relevance'
    } else {
      filterType.value = routeIdentity.filterType
      filterValue.value = typeof routeIdentity.filterName === 'string' ? routeIdentity.filterName : String(route.params.id ?? '').trim()
      filterId.value = routeIdentity.filterId
      invalidTarget.value = false
      searchSortMode.value = 'relevance'
    }
    currentPage.value = parsePageQuery(route.query.page)
    if (filterType.value === PUBLIC_FILTER_TYPE.search) {
      currentName.value = route.query.q ? `“${route.query.q}”` : '全站搜索'
      invalidTarget.value = false
    } else {
      const bootstrapMeta = resolveBootstrapFilterMeta()
      currentName.value = bootstrapMeta?.filterName || bootstrapMeta?.title || ''
      invalidTarget.value = Boolean(bootstrapMeta?.isInvalidTarget)
        || (filterType.value === PUBLIC_FILTER_TYPE.category && filterId.value <= 0)
      loadingMeta.value = !(currentName.value || invalidTarget.value)
    }

    const filterBootstrap = !bootstrapApplied && filterType.value !== PUBLIC_FILTER_TYPE.search
      ? initialBootstrap?.filter
      : null

    if (filterBootstrap && !Boolean(filterBootstrap.isInvalidTarget)) {
      const bootstrapItems = Array.isArray(filterBootstrap.articles)
        ? filterBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
        : []

      articleItems.value = bootstrapItems
      setPageTotal(Number(filterBootstrap.total) || 0)
      currentName.value = filterBootstrap.filterName?.trim() || currentName.value
      if (Number(filterBootstrap.filterId) > 0) {
        filterId.value = Number(filterBootstrap.filterId)
      }
      loadingMeta.value = false
      bootstrapApplied = true

      return
    }

    try {
      await articleTask.run(async (signal) => {
        await loadMetaName(signal)
        await loadArticles(true, signal)
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
    if (filterType.value === PUBLIC_FILTER_TYPE.category) {
      return matchesCategoryFilter(article, filterId.value)
    }

    if (filterType.value === PUBLIC_FILTER_TYPE.tag) {
      return matchesTagFilter(article, filterId.value)
    }

    return false
  }

  const applyArticlePatch = (payload: ArticleUpdatePayload): boolean => {
    if (filterType.value === PUBLIC_FILTER_TYPE.search) {
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

  const handleArticleBatch = (patches: readonly NotificationStreamArticleRenderPatch[]): void => {
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

    const nextQuery = { ...route.query }
    if (page <= 1) {
      delete nextQuery.page
    } else {
      nextQuery.page = String(page)
    }

    void router.replace({ path: route.path, query: nextQuery })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function setSearchSortMode(mode: SearchSortMode): void {
    if (filterType.value !== PUBLIC_FILTER_TYPE.search || searchSortMode.value === mode) {
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
    delete nextQuery.page

    void router.replace({ path: route.path, query: nextQuery })
  }

  watch([() => route.params.id, () => route.query.q, () => route.query.sort, () => route.query.page], () => {
    void init()
  })

  watch(
    () => notificationStreamStore.articleRevision,
    () => {
      if (!lifecycle.isActive()) {
        return
      }

      handleArticleBatch(notificationStreamStore.articleBatch)
    }
  )

  onMounted(() => {
    void init()
    if (preferHydrationView.value) {
      window.requestAnimationFrame(() => {
        preferHydrationView.value = false
      })
    }
  })

  return {
    route,
    router,
    powProvider,
    filterType,
    currentName,
    invalidTarget,
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
    filterView: computed(() => {
      if (preferHydrationView.value && initialHydrationView?.view) {
        return initialHydrationView.view
      }

      return createFilterPageViewContract({
        labelText: labelText.value,
        currentName: currentName.value,
        loadingMeta: loadingMeta.value,
        loadingArticles: loadingArticles.value,
        isPowCalculating: powProvider.isCalculating.value,
        hasError: hasError.value,
        isInvalidTarget: invalidTarget.value,
        articles: articles.value,
        currentPage: currentPage.value,
        totalPages: totalPages.value,
        pageIndicatorText: pageIndicatorText.value,
        canGoPrev: canGoPrev.value,
        canGoNext: canGoNext.value
      })
    })
  }
}
