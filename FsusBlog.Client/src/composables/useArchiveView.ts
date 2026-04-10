import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { getArticles, type ArticleListItem } from '@/api/article'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useWindowEvents } from '@/composables/useWindowEvents'
import { consumePublicAotBootstrap, toBootstrapArchiveArticleListItem } from '@/bootstrap/publicAotBootstrap'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'
import { isAbortError } from '@/utils/errors'
import { createArchivePageViewContract, type ArchivePageViewContract } from '@/view-contracts/archive'
import { getPublicPageDescriptor } from '@/view-contracts/publicPages'
import { renderArchiveAot } from '@/renderers/aot'

const SIGNALS = {
  CREATED: 'signalr:article-created',
  DELETED: 'signalr:article-deleted',
  RESTORED: 'signalr:article-restored',
  RECONNECTED: 'signalr:reconnected'
} as const

const ARCHIVE_PAGE = getPublicPageDescriptor('archive')

export function useArchiveView() {
  const initialBootstrap = consumePublicAotBootstrap('Archive')
  const loading = ref(true)
  const total = ref(0)
  const serverShellPresent = typeof document !== 'undefined' && hasServerAotShell(document.getElementById('app'))
  const aotRenderedHtml = ref('')
  const archiveView = shallowRef<ArchivePageViewContract>({
    total: 0,
    yearGroups: [],
    emptyState: {
      title: '暂无文章归档'
    }
  })
  const shouldRenderAotHtml = computed(() => !serverShellPresent && aotRenderedHtml.value.length > 0)

  let isMounted = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const loadTask = useAbortableTask()
  const serverFirstAot = ARCHIVE_PAGE.aotShellReady && ARCHIVE_PAGE.deferSpaBoot
  const shouldDelayLoadingSkeleton = computed(() => serverFirstAot && serverShellPresent)
  const buildArchiveStructure = (data: ArticleListItem[]): void => {
    archiveView.value = createArchivePageViewContract(data, total.value)
    aotRenderedHtml.value = serverFirstAot ? renderArchiveAot(archiveView.value) : ''
  }

  if (initialBootstrap) {
    total.value = Number(initialBootstrap.total) || 0
    buildArchiveStructure(initialBootstrap.articles.map((article) => toBootstrapArchiveArticleListItem(article)))
    loading.value = false
  }

  const fetchAllArticles = async (signal: AbortSignal): Promise<ArticleListItem[]> => {
    const allItems: ArticleListItem[] = []
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
    aotRenderedHtml.value = ''

    try {
      await loadTask.run(async (signal) => {
        const items = await fetchAllArticles(signal)
        if (isMounted && !signal.aborted) {
          buildArchiveStructure(items)
        }
      })
    } catch (error: unknown) {
      if (!isAbortError(error) && isMounted) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Archive] Sync failed:', message)
      }
    } finally {
      if (isMounted) {
        loading.value = false
      }
    }
  }

  const dispatchSync = (): void => {
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

  const handleSignalReconnect = (): void => {
    if (isMounted) {
      void loadArticles(false)
    }
  }

  useWindowEvents([
    { name: SIGNALS.CREATED, handler: dispatchSync },
    { name: SIGNALS.DELETED, handler: dispatchSync },
    { name: SIGNALS.RESTORED, handler: dispatchSync },
    { name: SIGNALS.RECONNECTED, handler: handleSignalReconnect }
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
    loadTask.cancel()
  })

  return {
    loading,
    archiveView,
    aotRenderedHtml,
    shouldRenderAotHtml,
    shouldDelayLoadingSkeleton
  }
}
