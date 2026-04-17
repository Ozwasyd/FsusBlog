import { computed, onMounted, ref, watch } from 'vue'
import { getArticles, type ArticleListItemResponse } from '@/api/article'
import { consumePublicAotBootstrap, toBootstrapArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { useSiteStore } from '@/store/site'
import { useSseStore } from '@/store/sse'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePagedListState } from '@/composables/usePagedListState'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { upsertArticlePreview, removeArticlePreview } from '@/services/sseArticlePatch'
import type { ArticleUpdatePayload, SseArticleRenderPatch } from '@/services/sseTypes'
import { isAbortError } from '@/utils/errors'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'
import { createArticleListCardViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'

export function useHomeView() {
  const siteStore = useSiteStore()
  const sseStore = useSseStore()
  const initialBootstrap = consumePublicAotBootstrap('Home')

  const articleItems = ref<ArticleListItemResponse[]>([])
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
  const articles = computed<ArticleListCardViewContract[]>(() =>
    articleItems.value.map((article, index) => createArticleListCardViewContract(article, index))
  )
  const canGoPrev = computed(() => currentPage.value > 1 && !loading.value)
  const canGoNext = computed(() => currentPage.value < totalPages.value && !loading.value)

  const articleTask = useAbortableTask()
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      articleTask.cancel()
    }
  })

  if (initialBootstrap) {
    articleItems.value = initialBootstrap.articles.map((article) => toBootstrapArticleListItem(article))
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
        articleItems.value = upsertArticlePreview(articleItems.value, payload.preview).slice(0, pageSize.value)
      }

      return true
    }

    if (payload.action === 'Updated') {
      if (!exists || !payload.preview) {
        return false
      }

      articleItems.value = upsertArticlePreview(articleItems.value, payload.preview)
      return true
    }

    if (!exists) {
      return false
    }

    articleItems.value = removeArticlePreview(articleItems.value, payload.articleId)
    setPageTotal(Math.max(0, total.value - 1))
    return currentPage.value === 1 && articleItems.value.length >= pageSize.value
  }

  const handleArticleBatch = (patches: readonly SseArticleRenderPatch[]): void => {
    let needsSync = false

    for (const patch of patches) {
      if (patch.kind === 'reconnected') {
        needsSync = true
        continue
      }

      if (!patch.event) {
        needsSync = true
        continue
      }

      if (!applyArticlePatch(patch.event.payload)) {
        needsSync = true
      }
    }

    if (needsSync && lifecycle.isActive()) {
      dispatchListUpdate()
    }
  }

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
    if (!initialBootstrap) {
      void loadArticles()
    }
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
    handlePageChange,
    loadArticles
  }
}
