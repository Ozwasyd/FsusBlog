import { onMounted, ref, shallowRef, watch } from 'vue'
import { getArticles, type ArticleListItemResponse } from '@/api/article'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { consumePublicAotBootstrap, toBootstrapArchiveArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { upsertArticlePreview, removeArticlePreview } from '@/services/sseArticlePatch'
import type { SseArticleRenderPatch } from '@/services/sseTypes'
import { useSseStore } from '@/store/sse'
import { isAbortError } from '@/utils/errors'
import { createArchivePageViewContract, type ArchivePageViewContract } from '@/view-contracts/archive'

export function useArchiveView() {
  const sseStore = useSseStore()
  const initialBootstrap = consumePublicAotBootstrap('Archive')
  const loading = ref(true)
  const total = ref(0)
  const allArticles = shallowRef<ArticleListItemResponse[]>([])
  const archiveView = shallowRef<ArchivePageViewContract>({
    total: 0,
    yearGroups: [],
    emptyState: {
      title: '暂无文章归档'
    }
  })

  const loadTask = useAbortableTask()
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      loadTask.cancel()
    }
  })
  const buildArchiveStructure = (data: ArticleListItemResponse[]): void => {
    allArticles.value = [...data]
    archiveView.value = createArchivePageViewContract(data, total.value)
  }

  if (initialBootstrap) {
    total.value = Number(initialBootstrap.total) || 0
    buildArchiveStructure(initialBootstrap.articles.map((article) => toBootstrapArchiveArticleListItem(article)))
    loading.value = false
  }

  const fetchAllArticles = async (signal: AbortSignal): Promise<ArticleListItemResponse[]> => {
    const allItems: ArticleListItemResponse[] = []
    let page = 1
    const size = 100

    while (true) {
      const response = await getArticles({ page, size }, { signal })
      const items = response?.items || []
      allItems.push(...items)

      const currentTotal = Number(response?.total) || 0
      if (allItems.length >= currentTotal || items.length < size) {
        total.value = currentTotal
        break
      }

      page++
    }

    return allItems
  }

  const loadArticles = async (showLoading = true): Promise<void> => {
    if (showLoading) {
      loading.value = true
    }

    try {
      await loadTask.run(async (signal) => {
        const items = await fetchAllArticles(signal)
        if (lifecycle.isActive() && !signal.aborted) {
          buildArchiveStructure(items)
        }
      })
    } catch (error: unknown) {
      if (!isAbortError(error) && lifecycle.isActive()) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Archive] Sync failed:', message)
      }
    } finally {
      if (lifecycle.isActive()) {
        loading.value = false
      }
    }
  }

  const dispatchSync = (): void => {
    lifecycle.scheduleSync(() => {
      void loadArticles(false)
    })
  }

  const handleArticleBatch = (patches: readonly SseArticleRenderPatch[]): void => {
    let needsSync = false
    let nextArticles = [...allArticles.value]
    let nextTotal = total.value

    for (const patch of patches) {
      if (patch.kind === 'reconnected') {
        needsSync = true
        continue
      }

      const payload = patch.event?.payload
      if (!payload) {
        needsSync = true
        continue
      }

      if (payload.action === 'Created' || payload.action === 'Restored') {
        if (!payload.preview) {
          needsSync = true
          continue
        }

        const exists = nextArticles.some((article) => article.id === payload.articleId)
        if (!exists) {
          nextTotal += 1
        }
        nextArticles = upsertArticlePreview(nextArticles, payload.preview)
        continue
      }

      if (payload.action === 'Updated') {
        if (!payload.preview) {
          needsSync = true
          continue
        }

        nextArticles = upsertArticlePreview(nextArticles, payload.preview)
        continue
      }

      if (nextArticles.some((article) => article.id === payload.articleId)) {
        nextArticles = removeArticlePreview(nextArticles, payload.articleId)
        nextTotal = Math.max(0, nextTotal - 1)
      }
    }

    if (needsSync) {
      dispatchSync()
      return
    }

    total.value = nextTotal
    buildArchiveStructure(nextArticles)
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
    loading,
    archiveView
  }
}
