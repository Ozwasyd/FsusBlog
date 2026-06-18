import { computed, inject, onMounted, ref } from 'vue'
import { routeLocationKey } from 'vue-router'
import { getPageData } from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed'
import { isAbortError } from '@/utils/errors'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

const FALLBACK_CONTENT = '> 暂无介绍内容。'

function resolvePageContent(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return ''
  }

  const source = payload as Record<string, unknown>
  const data = source.data
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>
    if (typeof nested.content === 'string') {
      return nested.content
    }
  }

  return typeof source.content === 'string' ? source.content : ''
}

export function useAboutPage() {
  const route = inject(routeLocationKey, null)
  const { bootstrap: initialBootstrap, hydration: initialHydrationPayload } = consumePublicPageSeed('About', { fullPath: route?.fullPath })
  const initialHydrationView = initialHydrationPayload?.view ?? null
  const initialStaticPage = initialHydrationPayload?.staticPage ?? initialBootstrap?.staticPage
  const hasInitialRouteSeed = Boolean(initialBootstrap || initialHydrationPayload)
  const initialBodyHtml = typeof initialHydrationPayload?.bodyHtml === 'string'
    ? initialHydrationPayload.bodyHtml
    : typeof initialBootstrap?.bodyHtml === 'string'
      ? initialBootstrap.bodyHtml
      : ''
  const currentYear = Number.isInteger(initialHydrationPayload?.renderYear)
    ? Number(initialHydrationPayload?.renderYear)
    : Number.isInteger(initialBootstrap?.renderYear)
      ? Number(initialBootstrap?.renderYear)
      : new Date().getFullYear()
  const rawMarkdown = ref('')
  const loading = ref(true)
  const error = ref(false)
  const fetchTask = useAbortableTask()
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      fetchTask.cancel()
    }
  })

  if (initialHydrationView) {
    rawMarkdown.value = initialHydrationView.body.content || FALLBACK_CONTENT
    loading.value = false
  } else if (typeof initialStaticPage?.content === 'string') {
    rawMarkdown.value = initialStaticPage.content || FALLBACK_CONTENT
    loading.value = false
  }

  const aboutView = computed(() => createAboutPageViewContract({
    currentYear,
    content: rawMarkdown.value || FALLBACK_CONTENT
  }))

  const fetchData = async () => {
    loading.value = true
    error.value = false

    try {
      await fetchTask.run(async (signal) => {
        const response = await getPageData('about', { signal })
        if (signal.aborted || !lifecycle.isActive()) {
          return
        }

        const content = resolvePageContent(response)
        rawMarkdown.value = content || FALLBACK_CONTENT
      })
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        error.value = true
      }
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    if (!hasInitialRouteSeed) {
      void fetchData()
    }
  })

  return {
    aboutView,
    currentYear,
    initialBodyHtml,
    rawMarkdown,
    loading,
    error,
    fetchData
  }
}
