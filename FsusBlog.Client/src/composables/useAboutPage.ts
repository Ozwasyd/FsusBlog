import { onMounted, ref } from 'vue'
import { getPageData } from '@/api/system'
import { consumePublicAotBootstrap } from '@/bootstrap/publicAotBootstrap'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'
import { isAbortError } from '@/utils/errors'

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
  const initialBootstrap = consumePublicAotBootstrap('About')
  const currentYear = new Date().getFullYear()
  const rawMarkdown = ref('')
  const loading = ref(true)
  const error = ref(false)
  const fetchTask = useAbortableTask()
  const lifecycle = usePublicPageLifecycle({
    onDispose: () => {
      fetchTask.cancel()
    }
  })

  if (typeof initialBootstrap?.about?.content === 'string') {
    rawMarkdown.value = initialBootstrap.about.content || FALLBACK_CONTENT
    loading.value = false
  }

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
    if (!initialBootstrap) {
      void fetchData()
    }
  })

  return {
    currentYear,
    rawMarkdown,
    loading,
    error,
    fetchData
  }
}
