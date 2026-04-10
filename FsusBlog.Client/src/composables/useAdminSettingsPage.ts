import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox, type UploadRequestOptions } from 'element-plus'
import type { AxiosRequestConfig } from 'axios'
import {
  deleteImage,
  getPageData,
  getSiteConfig,
  updatePageData,
  updateSiteConfig,
  uploadImage,
  type SiteConfig
} from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { isAbortError } from '@/utils/errors'

export function useAdminSettingsPage() {
  const baseURL = import.meta.env.VITE_API_BASE_URL || window.location.origin

  const activeTab = ref('site')
  const savingSite = ref(false)
  const savingPage = ref(false)
  const pageLoading = ref(false)
  const imageLoading = ref(false)

  const siteForm = reactive({
    title: '',
    description: '',
    keywords: '',
    author: '',
    ogImage: '',
    baseUrl: ''
  })

  const siteTask = useAbortableTask()
  const pageTask = useAbortableTask()
  const uploadTask = useAbortableTask()
  const initialLoadTask = useAbortableTask()

  const previousOgImage = ref('')
  const currentSlug = ref('about')
  const pageContent = ref('')
  const pageTargets = [
    { value: 'about', label: '关于我' },
    { value: 'privacy', label: '隐私政策' },
    { value: 'guidelines', label: '用户守则' }
  ] as const

  const buildSignalConfig = (signal: AbortSignal): AxiosRequestConfig => ({ signal })

  const readStringField = (source: Record<string, unknown>, camel: keyof SiteConfig, pascal: string): string => {
    const camelValue = source[camel]
    if (typeof camelValue === 'string') {
      return camelValue
    }

    const pascalValue = source[pascal]
    return typeof pascalValue === 'string' ? pascalValue : ''
  }

  const normalizeSiteConfig = (value: unknown): SiteConfig => {
    if (!value || typeof value !== 'object') {
      return {
        title: '',
        description: '',
        keywords: '',
        author: '',
        ogImage: '',
        baseUrl: ''
      }
    }

    const source = value as Record<string, unknown>
    return {
      title: readStringField(source, 'title', 'Title'),
      description: readStringField(source, 'description', 'Description'),
      keywords: readStringField(source, 'keywords', 'Keywords'),
      author: readStringField(source, 'author', 'Author'),
      ogImage: readStringField(source, 'ogImage', 'OgImage'),
      baseUrl: readStringField(source, 'baseUrl', 'BaseUrl')
    }
  }

  const displayUrl = computed(() => {
    if (!siteForm.ogImage) {
      return ''
    }
    return siteForm.ogImage.startsWith('http') ? siteForm.ogImage : `${baseURL}${siteForm.ogImage}`
  })

  const computedKeywords = computed(() =>
    siteForm.keywords ? siteForm.keywords.split(',').map((value) => value.trim()).filter((value) => value) : [])
  const hasOgImage = computed(() => Boolean(siteForm.ogImage))
  const siteSubmitText = computed(() => (savingSite.value ? '保存中...' : '保存同步'))
  const pageSubmitText = computed(() => (savingPage.value ? '发布中...' : '发布更新'))

  const sanitizeKeywords = (): void => {
    if (!siteForm.keywords) {
      return
    }

    const raw = siteForm.keywords.replace(/，/g, ',').replace(/[<>"/\\`]/g, '')
    siteForm.keywords = Array.from(new Set(raw.split(',')))
      .map((value) => value.trim())
      .filter((value) => value)
      .join(',')
  }

  const validateBaseUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url)
      return ['http:', 'https:'].includes(parsed.protocol)
    } catch {
      return false
    }
  }

  const syncSeoConfig = async (signal?: AbortSignal): Promise<void> => {
    try {
      if (siteForm.baseUrl) {
        siteForm.baseUrl = siteForm.baseUrl.trim().replace(/\/+$/, '')
        if (!validateBaseUrl(siteForm.baseUrl)) {
          throw new Error('BASEURL_PROTOCOL_INVALID')
        }
      }

      await updateSiteConfig({ ...siteForm }, signal ? buildSignalConfig(signal) : undefined)
      previousOgImage.value = siteForm.ogImage
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        siteForm.ogImage = previousOgImage.value
        const message = error instanceof Error ? error.message : ''
        const errorMsg = message === 'BASEURL_PROTOCOL_INVALID' ? '站点URL协议不合法' : '配置同步失败，已回退状态'
        ElMessage.warning(errorMsg)
        throw error
      }
    }
  }

  const handleImageAction = async (options: UploadRequestOptions): Promise<void> => {
    imageLoading.value = true
    previousOgImage.value = siteForm.ogImage

    try {
      await uploadTask.run(async (signal) => {
        const file = options.file as File
        const data = await uploadImage(file, buildSignalConfig(signal))
        siteForm.ogImage = data.relativeUrl || data.url
        await nextTick()
        await syncSeoConfig()
        ElMessage.success('配置图已更新')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Settings] Upload failed:', error)
        siteForm.ogImage = previousOgImage.value
      }
    } finally {
      imageLoading.value = false
    }
  }

  const handleImageRemove = async (): Promise<void> => {
    try {
      await ElMessageBox.confirm('彻底删除物理资源并重置封面吗？', '确认', {
        type: 'error',
        confirmButtonClass: 'el-button--danger',
        dangerouslyUseHTMLString: false
      })

      imageLoading.value = true
      previousOgImage.value = siteForm.ogImage

      if (siteForm.ogImage) {
        await deleteImage(siteForm.ogImage)
      }
      siteForm.ogImage = ''

      await syncSeoConfig()
      ElMessage.success('已物理重置')
    } catch {
      // ignored
    } finally {
      imageLoading.value = false
    }
  }

  const saveSiteConfig = async (): Promise<void> => {
    if (!siteForm.title.trim()) {
      ElMessage.warning('标题不可为空')
      return
    }
    if (!siteForm.baseUrl.trim() || !validateBaseUrl(siteForm.baseUrl)) {
      ElMessage.warning('请提供合法的站点基础 URL (http/https)')
      return
    }

    savingSite.value = true
    try {
      await siteTask.run(async (signal) => {
        await syncSeoConfig(signal)
        if (!signal.aborted) {
          ElMessage.success('SEO 配置同步成功')
        }
      })
    } finally {
      savingSite.value = false
    }
  }

  const loadSiteConfig = async (): Promise<void> => {
    try {
      await initialLoadTask.run(async (signal) => {
        const data = await getSiteConfig(buildSignalConfig(signal))
        if (!data) {
          return
        }

        const normalized = normalizeSiteConfig(data)
        siteForm.title = normalized.title
        siteForm.description = normalized.description
        siteForm.keywords = normalized.keywords
        siteForm.author = normalized.author
        siteForm.ogImage = normalized.ogImage
        siteForm.baseUrl = normalized.baseUrl
        previousOgImage.value = siteForm.ogImage
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Settings] Fetch Error:', error)
      }
    }
  }

  const loadPage = async (slug: string): Promise<void> => {
    pageLoading.value = true
    try {
      await pageTask.run(async (signal) => {
        const data = await getPageData(slug, buildSignalConfig(signal))
        if (!signal.aborted) {
          pageContent.value = data?.content || ''
        }
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        console.error('[Settings] Load failed:', error)
      }
    } finally {
      pageLoading.value = false
    }
  }

  const savePageContent = async (): Promise<void> => {
    try {
      await ElMessageBox.confirm('确定要发布页面更新吗？', '同步确认', { type: 'warning' })
      savingPage.value = true
      await updatePageData({ slug: currentSlug.value, content: pageContent.value })
      ElMessage.success('发布同步成功')
    } catch {
      // ignored
    } finally {
      savingPage.value = false
    }
  }

  watch(currentSlug, (value) => {
    void loadPage(value)
  }, { immediate: true })

  onMounted(() => {
    void loadSiteConfig()
  })

  onUnmounted(() => {
    siteTask.cancel()
    pageTask.cancel()
    uploadTask.cancel()
    initialLoadTask.cancel()
    pageContent.value = ''
  })

  return {
    activeTab,
    savingSite,
    savingPage,
    pageLoading,
    imageLoading,
    siteForm,
    currentSlug,
    pageContent,
    pageTargets,
    displayUrl,
    hasOgImage,
    computedKeywords,
    siteSubmitText,
    pageSubmitText,
    sanitizeKeywords,
    handleImageAction,
    handleImageRemove,
    saveSiteConfig,
    savePageContent
  }
}
