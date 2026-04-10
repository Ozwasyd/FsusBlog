import { computed, onMounted, onUnmounted, ref } from 'vue'
import { FrameType } from '@wasm/protocol/frame'
import { getArticles } from '@/api/article'
import { consumePublicAotBootstrap, toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { useSiteStore } from '@/store/site'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useAotRenderBridge } from '@/composables/useAotRenderBridge'
import { usePagedListState } from '@/composables/usePagedListState'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { isAbortError } from '@/utils/errors'
import { createArticleListViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'

const ARTICLE_SIGNALS = {
  CREATED: 'signalr:article-created',
  UPDATED: 'signalr:article-updated',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected'
} as const

type ArticleSignalPayload = { articleId?: string | number }

export function useHomeView() {
  const siteStore = useSiteStore()
  const initialBootstrap = consumePublicAotBootstrap('Home')

  const articles = ref<ArticleListCardViewContract[]>([])
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
    siteStore.isLoaded ? siteStore.siteInfo.title : '...'
  )
  const pageIndicatorText = computed(() => `${currentPage.value} / ${totalPages.value}`)
  const canGoPrev = computed(() => currentPage.value > 1 && !loading.value)
  const canGoNext = computed(() => currentPage.value < totalPages.value && !loading.value)

  let isMounted = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const articleTask = useAbortableTask()

  if (initialBootstrap) {
    const hydrated = createArticleListViewContract(
      {
        items: initialBootstrap.articles.map((article) => toBootstrapArticleListItem(article)),
        total: Number(initialBootstrap.total) || 0
      },
      {
        currentPage: currentPage.value,
        pageSize: pageSize.value
      }
    )

    articles.value = [...hydrated.items]
    setPageTotal(Number(initialBootstrap.total) || 0)
  }

  const handlePageChange = (page: number): void => {
    if (page < 1 || page > totalPages.value || loading.value) {
      return
    }
    currentPage.value = page
    void loadArticles()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const { aotRenderedHtml, clearAotHtml } = useAotRenderBridge({
    frameType: FrameType.ArticleList,
    onRefresh: () => {
      void loadArticles(false)
    },
    onPageNext: () => handlePageChange(currentPage.value + 1),
    onPagePrev: () => handlePageChange(currentPage.value - 1)
  })

  const loadArticles = async (showLoading = true): Promise<void> => {
    if (showLoading) {
      beginLoading()
    } else {
      error.value = null
    }
    clearAotHtml()

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

      if (isMounted && response) {
        if (Array.isArray(response.items)) {
          articles.value = createArticleListViewContract(response, {
            currentPage: currentPage.value,
            pageSize: pageSize.value
          }).items
          setPageTotal(Number(response.total) || 0)
          error.value = null
        } else {
          throw new Error('Malformed API Response Structure')
        }
      }
    } catch (caught: unknown) {
      if (isAbortError(caught)) {
        return
      }

      if (isMounted) {
        const message = caught instanceof Error ? caught.message : String(caught)
        console.error('[Home] Data loading error:', message)
        setError('数据加载异常')
        articles.value = []
        setPageTotal(0)
      }
    } finally {
      if (isMounted && showLoading) {
        endLoading()
      }
    }
  }

  const dispatchListUpdate = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }

    debounceTimer = setTimeout(() => {
      if (isMounted) {
        void loadArticles(false)
      }
      debounceTimer = null
    }, 500)
  }

  const handleRemoteArticleCreated = (): void => {
    if (currentPage.value === 1) {
      dispatchListUpdate()
    }
  }

  const handleRemoteArticleUpdated = (event: Event): void => {
    const data = (event as CustomEvent<ArticleSignalPayload>).detail
    if (!data?.articleId) {
      return
    }

    const targetId = String(data.articleId)
    const exists = articles.value.some((article) => String(article.id) === targetId)
    if (exists) {
      dispatchListUpdate()
    }
  }

  const handleRemoteArticleDeleted = (): void => {
    dispatchListUpdate()
  }

  const handleSignalRReconnected = (): void => {
    if (isMounted) {
      void loadArticles(false)
    }
  }

  useWindowEvents([
    { name: ARTICLE_SIGNALS.CREATED, handler: handleRemoteArticleCreated },
    { name: ARTICLE_SIGNALS.UPDATED, handler: handleRemoteArticleUpdated },
    { name: ARTICLE_SIGNALS.DELETED, handler: handleRemoteArticleDeleted },
    { name: ARTICLE_SIGNALS.RESTORED, handler: handleRemoteArticleCreated },
    { name: ARTICLE_SIGNALS.RECONNECTED, handler: handleSignalRReconnected }
  ])

  onMounted(() => {
    isMounted = true
    if (!initialBootstrap) {
      void loadArticles()
    }
  })

  onUnmounted(() => {
    isMounted = false
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    articleTask.cancel()
  })

  return {
    siteStore,
    siteTitleText,
    articles,
    currentPage,
    totalPages,
    loading,
    isError,
    pageIndicatorText,
    canGoPrev,
    canGoNext,
    aotRenderedHtml,
    handlePageChange,
    loadArticles
  }
}
