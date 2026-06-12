import { computed, nextTick, onMounted, ref, watch, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getArticles, getFeaturedArticles, getHotArticles, type ArticleListItemResponse, type FeaturedArticleItem, type PopularArticleSummaryResponse } from '@/api/article'
import { toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed'
import { useSiteStore } from '@/store/site'
import { useNotificationStreamStore } from '@/store/notificationStream'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { upsertArticlePreview, removeArticlePreview } from '@/services/notificationStreamArticlePatch'
import type { ArticleUpdatePayload, NotificationStreamArticleRenderPatch } from '@/services/notificationStreamTypes'
import { isAbortError } from '@/utils/errors'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'
import { createArticleListViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'
import { createStableArticleCardMapper } from '@/view-contracts/articleListStableCache'

const HOME_FEATURED_ARTICLE_COUNT = 3
const HOME_HOT_ARTICLE_PREFETCH_COUNT = 10
const HOME_HOT_ARTICLE_DISPLAY_COUNT = 5
const HOME_SECONDARY_CONTENT_SENTINEL_ID = 'fsus-home-secondary-content-sentinel'
const HOME_SECONDARY_LIST_ROOT_MARGIN = '600px 0px 600px 0px'
const HOME_SECONDARY_LIST_FALLBACK_DELAY_MS = 2500

const parsePageQuery = (value: unknown): number => {
  const raw = Array.isArray(value) ? value[0] : value
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export function useHomeView() {
  const route = useRoute()
  const router = useRouter()
  const siteStore = useSiteStore()
  const notificationStreamStore = useNotificationStreamStore()
  const { bootstrap: initialBootstrap, hydration: initialHydrationPayload } = consumePublicPageSeed('Home')
  const initialHydrationView = initialHydrationPayload?.view ?? null
  const initialSiteTitleText = initialHydrationPayload?.siteTitle?.trim()
    || initialBootstrap?.siteTitle?.trim()
    || `Fsu's Blog`
  const initialSiteDescriptionText = initialHydrationPayload?.siteDescription?.trim()
    || initialBootstrap?.siteDescription?.trim()
    || '记录技术与生活'

  const articleItems = ref<ArticleListItemResponse[]>([])
  const featuredArticles = ref<FeaturedArticleItem[]>([])
  const hotArticles = ref<PopularArticleSummaryResponse[]>([])
  const featuredLoading = ref(false)
  const initialViewItems = ref<readonly ArticleListCardViewContract[] | null>(
    initialHydrationView && Array.isArray(initialHydrationView.items)
      ? initialHydrationView.items
      : null
  )
  const mapArticleCards = createStableArticleCardMapper()
  const {
    currentPage,
    pageSize,
    total,
    totalPages,
    loading,
    error,
    beginLoading,
    endLoading,
    setError,
    setPageTotal
  } = usePagedListState({ pageSize: 10 })
  const isError = computed(() => error.value !== null)
  const siteTitleText = computed(() =>
    siteStore.isLoaded ? siteStore.siteInfo.title : initialSiteTitleText
  )
  const pageIndicatorText = computed(() => `${currentPage.value} / ${totalPages.value}`)
  const articles = computed<ArticleListCardViewContract[]>(() =>
    initialViewItems.value
      ? [...initialViewItems.value]
      : mapArticleCards(articleItems.value)
  )
  const listView = computed(() =>
    initialViewItems.value && initialHydrationView
      ? {
          ...initialHydrationView,
          items: [...initialViewItems.value],
          pagination: {
            ...initialHydrationView.pagination
          }
        }
      : createArticleListViewContract(
          {
            items: articleItems.value,
            total: total.value
          },
          {
            currentPage: currentPage.value,
            pageSize: pageSize.value
          }
        )
  )
  const canGoPrev = computed(() => currentPage.value > 1 && !loading.value)
  const canGoNext = computed(() => currentPage.value < totalPages.value && !loading.value)

  const articleTask = useAbortableTask()
  const featuredTask = useAbortableTask()
  let featuredDebounceTimer: ReturnType<typeof setTimeout> | null = null
  let secondaryListObserver: IntersectionObserver | null = null
  let secondaryListFallbackTimer: ReturnType<typeof setTimeout> | null = null
  let secondaryListsLoaded = false
  let secondaryListRequestInFlight = false

  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      articleTask.cancel()
      featuredTask.cancel()
      if (featuredDebounceTimer) {
        clearTimeout(featuredDebounceTimer)
      }
      clearSecondaryListFallbackTimer()
      disconnectSecondaryListObserver()
    }
  })

  if (initialBootstrap) {
    articleItems.value = initialBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
    setPageTotal(Number(initialBootstrap.total) || 0)
  }
  if (initialHydrationView) {
    currentPage.value = Math.max(1, Number(initialHydrationPayload?.currentPage) || 1)
    pageSize.value = Math.max(1, Number(initialHydrationPayload?.pageSize) || pageSize.value)
    setPageTotal(Number(initialHydrationPayload?.total) || 0)
  }

  currentPage.value = parsePageQuery(route.query.page)

  const syncPageQuery = (page: number): void => {
    const nextQuery = { ...route.query }
    if (page <= 1) {
      delete nextQuery.page
    } else {
      nextQuery.page = String(page)
    }

    void router.replace({ path: route.path, query: nextQuery })
  }

  const handlePageChange = (page: number): void => {
    if (page < 1 || page > totalPages.value || loading.value) {
      return
    }
    syncPageQuery(page)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const loadArticles = async (showLoading = true): Promise<void> => {
    if (showLoading) {
      beginLoading()
    } else {
      error.value = null
    }

    try {
      const response = await articleTask.run(
        async (signal) =>
          await getArticles(
            {
              page: currentPage.value,
              size: pageSize.value
            },
            { signal }
          )
      )

      if (lifecycle.isActive() && response) {
        if (Array.isArray(response.items)) {
          initialViewItems.value = null
          articleItems.value = response.items
          setPageTotal(Number(response.total) || 0)
          error.value = null
        } else {
          throw createAppError(AppErrorCode.ProtocolFailure, 'home_articles_response_invalid')
        }
      }
    } catch (caught: unknown) {
      if (isAbortError(caught)) {
        return
      }

      if (lifecycle.isActive()) {
        const normalized = toAppError(caught, 'home_articles_load_failed')
        console.error('[Home] Data loading error:', normalized.message)
        setError(normalized.code === AppErrorCode.ProtocolFailure ? '数据结构异常' : '数据加载异常')
        articleItems.value = []
        setPageTotal(0)
      }
    } finally {
      if (lifecycle.isActive() && showLoading) {
        endLoading()
      }
    }
  }

  const clearSecondaryListFallbackTimer = (): void => {
    if (!secondaryListFallbackTimer) {
      return
    }

    clearTimeout(secondaryListFallbackTimer)
    secondaryListFallbackTimer = null
  }

  const disconnectSecondaryListObserver = (): void => {
    secondaryListObserver?.disconnect()
    secondaryListObserver = null
  }

  const loadFeaturedArticles = async (showLoading = true): Promise<void> => {
    if (secondaryListRequestInFlight) {
      return
    }

    secondaryListRequestInFlight = true
    if (showLoading) {
      featuredLoading.value = true
    }

    try {
      const [featured, hot] = await featuredTask.run(
        async (signal) => await Promise.all([
          getFeaturedArticles(HOME_FEATURED_ARTICLE_COUNT, { signal }),
          getHotArticles(HOME_HOT_ARTICLE_PREFETCH_COUNT, { signal })
        ])
      )

      if (lifecycle.isActive()) {
        featuredArticles.value = featured || []

        // 去重逻辑：如果文章已经出现在精选位，则不再出现在热门排行中
        const featuredIds = new Set(featuredArticles.value.map(a => a.id))
        hotArticles.value = (hot || [])
          .filter(a => !featuredIds.has(a.id))
          .slice(0, HOME_HOT_ARTICLE_DISPLAY_COUNT)
        secondaryListsLoaded = true
      }
    } catch (caught: unknown) {
      if (isAbortError(caught)) {
        return
      }
      console.error('[Home] Featured articles load error:', caught)
    } finally {
      secondaryListRequestInFlight = false
      if (lifecycle.isActive()) {
        featuredLoading.value = false
      }
    }
  }

  const triggerSecondaryListLoad = (showLoading = true): void => {
    clearSecondaryListFallbackTimer()
    disconnectSecondaryListObserver()
    void loadFeaturedArticles(showLoading)
  }

  const scheduleSecondaryListLoad = async (): Promise<void> => {
    if (secondaryListsLoaded || secondaryListRequestInFlight || secondaryListObserver || secondaryListFallbackTimer) {
      return
    }

    await nextTick()
    if (!lifecycle.isActive() || loading.value || isError.value || listView.value.items.length === 0) {
      return
    }

    const target = typeof document === 'undefined'
      ? null
      : document.getElementById(HOME_SECONDARY_CONTENT_SENTINEL_ID)
    if (!target) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      secondaryListFallbackTimer = setTimeout(() => {
        secondaryListFallbackTimer = null
        triggerSecondaryListLoad(true)
      }, HOME_SECONDARY_LIST_FALLBACK_DELAY_MS)
      return
    }

    secondaryListObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
        triggerSecondaryListLoad(true)
      }
    }, {
      root: null,
      rootMargin: HOME_SECONDARY_LIST_ROOT_MARGIN,
      threshold: 0
    })
    secondaryListObserver.observe(target)
  }

  const dispatchFeaturedUpdate = (): void => {
    if (!secondaryListsLoaded && !secondaryListRequestInFlight) {
      return
    }

    if (featuredDebounceTimer) {
      clearTimeout(featuredDebounceTimer)
    }

    featuredDebounceTimer = setTimeout(() => {
      void loadFeaturedArticles(false)
      featuredDebounceTimer = null
    }, 500)
  }

  const dispatchListUpdate = (): void => {
    lifecycle.scheduleSync(() => {
      void loadArticles(false)
    })
  }

  const applyArticlePatch = (payload: ArticleUpdatePayload): boolean => {
    const exists = articleItems.value.some((article) => article.id === payload.articleId)

    if (payload.action === 'Created' || payload.action === 'Restored') {
      if (!payload.preview) {
        return false
      }

      if (!exists) {
        setPageTotal(total.value + 1)
      }

      if (currentPage.value === 1) {
        initialViewItems.value = null
        articleItems.value = upsertArticlePreview(articleItems.value, payload.preview).slice(0, pageSize.value)
      }

      return true
    }

    if (payload.action === 'Updated') {
      if (!exists || !payload.preview) {
        return false
      }

      articleItems.value = upsertArticlePreview(articleItems.value, payload.preview)
      initialViewItems.value = null
      return true
    }

    if (!exists) {
      return false
    }

    articleItems.value = removeArticlePreview(articleItems.value, payload.articleId)
    initialViewItems.value = null
    setPageTotal(Math.max(0, total.value - 1))
    return currentPage.value === 1 && articleItems.value.length >= pageSize.value
  }

  const handleArticleBatch = (patches: readonly NotificationStreamArticleRenderPatch[]): void => {
    let needsSync = false
    let needsFeaturedSync = false

    for (const patch of patches) {
      if (patch.kind === 'reconnected') {
        needsSync = true
        needsFeaturedSync = true
        continue
      }

      if (!patch.event) {
        needsSync = true
        needsFeaturedSync = true
        continue
      }

      const action = patch.event.payload.action
      if (action === 'Created' || action === 'Deleted' || action === 'Restored' || action === 'Updated') {
        needsFeaturedSync = true
      }

      if (!applyArticlePatch(patch.event.payload)) {
        needsSync = true
      }
    }

    if (needsSync && lifecycle.isActive()) {
      dispatchListUpdate()
    }

    if (needsFeaturedSync && lifecycle.isActive()) {
      dispatchFeaturedUpdate()
    }
  }

  watch(
    () => route.query.page,
    () => {
      const nextPage = parsePageQuery(route.query.page)
      if (nextPage === currentPage.value) {
        return
      }

      initialViewItems.value = null
      currentPage.value = nextPage
      void loadArticles()
    }
  )

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
    void scheduleSecondaryListLoad()

    if (!initialBootstrap || currentPage.value > 1) {
      initialViewItems.value = null
      void loadArticles()
    }
  })

  watch(
    () => [loading.value, isError.value, listView.value.items.length] as const,
    () => {
      void scheduleSecondaryListLoad()
    },
    { flush: 'post' }
  )

  onUnmounted(() => {
    if (featuredDebounceTimer) {
      clearTimeout(featuredDebounceTimer)
    }
    clearSecondaryListFallbackTimer()
    disconnectSecondaryListObserver()
  })

  return {
    siteStore,
    siteTitleText,
    initialSiteTitleText,
    initialSiteDescriptionText,
    listView,
    articles,
    featuredArticles,
    hotArticles,
    featuredLoading,
    currentPage,
    totalPages,
    loading,
    isError,
    pageIndicatorText,
    canGoPrev,
    canGoNext,
    handlePageChange,
    loadArticles,
    loadFeaturedArticles
  }
}
