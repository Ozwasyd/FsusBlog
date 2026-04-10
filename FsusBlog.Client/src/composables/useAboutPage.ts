import { computed, onMounted, ref } from 'vue'
import { getPageData } from '@/api/system'
import { consumePublicAotBootstrap } from '@/bootstrap/publicAotBootstrap'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { useSiteStore } from '@/store/site'
import { hasServerAotShell } from '@/bootstrap/publicShellPrimitives'
import { isAbortError } from '@/utils/errors'
import { createAboutPageViewContract } from '@/view-contracts/aboutPage'
import { getPublicPageDescriptor } from '@/view-contracts/publicPages'
import { renderAboutAot } from '@/renderers/aot'

const FALLBACK_CONTENT = '> 暂无介绍内容。'
const ABOUT_PAGE = getPublicPageDescriptor('about')

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
  const siteStore = useSiteStore()
  const initialBootstrap = consumePublicAotBootstrap('About')
  const currentYear = new Date().getFullYear()
  const rawMarkdown = ref('')
  const aotRenderedHtml = ref('')
  const loading = ref(true)
  const error = ref(false)
  const fetchTask = useAbortableTask()
  const serverFirstAot = ABOUT_PAGE.aotShellReady && ABOUT_PAGE.deferSpaBoot
  const serverShellPresent = typeof document !== 'undefined' && hasServerAotShell(document.getElementById('app'))
  const aboutView = computed(() => createAboutPageViewContract({
    siteTitle: siteStore.siteInfo.title,
    currentYear,
    content: rawMarkdown.value
  }))
  const shouldRenderAotHtml = computed(() => !serverShellPresent && aotRenderedHtml.value.length > 0)

  if (typeof initialBootstrap?.about?.content === 'string') {
    rawMarkdown.value = initialBootstrap.about.content || FALLBACK_CONTENT
    loading.value = false
  }

  const fetchData = async () => {
    loading.value = true
    error.value = false
    aotRenderedHtml.value = ''

    try {
      await fetchTask.run(async (signal) => {
        const response = await getPageData('about', { signal })
        if (signal.aborted) {
          return
        }

        const content = resolvePageContent(response)
        rawMarkdown.value = content || FALLBACK_CONTENT
        if (serverFirstAot && !serverShellPresent) {
          aotRenderedHtml.value = await renderAboutAot(aboutView.value)
        }
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
    aotRenderedHtml,
    shouldRenderAotHtml,
    serverFirstAot,
    serverShellPresent,
    loading,
    error,
    fetchData
  }
}
