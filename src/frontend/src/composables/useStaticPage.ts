import { computed, inject, nextTick, onMounted, ref } from 'vue'
import { routeLocationKey } from 'vue-router'
import { getPageData } from '@/api/system'
import { markCurrentRouteContentReady, markCurrentRouteFailed } from '@/bootstrap/routeReadiness'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { consumePublicPageSeed } from '@/public-renderers/pageSeed'
import type { PublicPageKind } from '@/public-renderers/publicRenderBase'
import { isAbortError } from '@/utils/errors'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'

export type StaticPublicPageKind = Extract<PublicPageKind, 'About' | 'Privacy' | 'Guidelines' | 'Copyright'>

const FALLBACK_CONTENT = '> 页面内容正在准备中。'

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

export function useStaticPage(options: {
  kind: StaticPublicPageKind
  slug: string
  title: string
}) {
  const route = inject(routeLocationKey, null)
  const { bootstrap: initialBootstrap, hydration: initialHydrationPayload } = consumePublicPageSeed(options.kind, { fullPath: route?.fullPath })
  const initialHydrationView = initialHydrationPayload?.view ?? null
  const initialStaticPage = initialHydrationPayload?.staticPage ?? initialBootstrap?.staticPage
  const hasInitialRouteSeed = Boolean(initialBootstrap || initialHydrationPayload)
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
  const markRouteReady = (): void => {
    markCurrentRouteContentReady(route)
  }
  const markRouteFailed = (): void => {
    markCurrentRouteFailed(route)
  }

  if (initialHydrationView) {
    rawMarkdown.value = initialHydrationView.body.content || FALLBACK_CONTENT
    loading.value = false
  } else if (typeof initialStaticPage?.content === 'string') {
    rawMarkdown.value = initialStaticPage.content || FALLBACK_CONTENT
    loading.value = false
  }

  const staticPageView = computed(() => createAboutPageViewContract({
    currentYear,
    content: rawMarkdown.value || FALLBACK_CONTENT,
    title: options.title
  }))

  const fetchData = async () => {
    loading.value = true
    error.value = false

    try {
      await fetchTask.run(async (signal) => {
        const response = await getPageData(options.slug, { signal })
        if (signal.aborted || !lifecycle.isActive()) {
          return
        }

        const content = resolvePageContent(response)
        rawMarkdown.value = content || FALLBACK_CONTENT
      })
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        error.value = true
        markRouteFailed()
      }
    } finally {
      loading.value = false
      if (!error.value) {
        markRouteReady()
      }
    }
  }

  onMounted(() => {
    if (!hasInitialRouteSeed) {
      void fetchData()
    } else {
      void nextTick(markRouteReady)
    }
  })

  return {
    staticPageView,
    currentYear,
    rawMarkdown,
    loading,
    error,
    fetchData
  }
}
