import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { type UploadRequestOptions } from '@ozwasyd/element-plus'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  getAdminPageData,
  getAdminSiteConfig,
  updatePageData,
  updateSiteConfig,
  type SeoConfigAdmin
} from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { isAbortError } from '@/utils/errors'
import { getKnownErrorInfo } from '@/utils/errorKinds'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/utils/toast'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'

export function useAdminSettingsPage() {
  const baseURL = import.meta.env.VITE_API_BASE_URL || window.location.origin

  const activeTab = ref('site')
  const savingSite = ref(false)
  const savingPage = ref(false)
  const pageLoading = ref(false)
  const imageLoading = ref(false)
  const siteLoadFailed = ref(false)
  const {
    options: imageUploadOptions,
    wasmOnlyMode,
    setOptions: setImageUploadOptions,
    setWasmOnlyMode: setImageUploadWasmOnlyMode
  } = useImageUploadPreferences()
  const imageUploadRuntime = useImageUploadRuntime()

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
  const initialLoadTask = useAbortableTask()
  const imageUploadFlow = useImageUploadFlow({
    runtime: imageUploadRuntime,
    getOptions: () => imageUploadOptions.value,
    getWasmOnly: () => wasmOnlyMode.value,
    notify: {
      success: (message) => toast.success(message),
      warning: (message) => showWarningToast(message, message),
      error: (message) => showErrorToast(message, message)
    }
  })

  const previousOgImage = ref('')
  const originalSiteSnapshot = ref('')
  const currentSlug = ref('about')
  const pageContent = ref('')
  const originalPageContent = ref('')
  const pendingPageSwitchSlug = ref('')
  const hasActivatedPagesTab = ref(false)
  const pageTargets = [
    { value: 'about', label: '关于我' },
    { value: 'privacy', label: '隐私政策' },
    { value: 'guidelines', label: '用户守则' }
  ] as const

  const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal })

  const readStringField = (source: Record<string, unknown>, camel: keyof SeoConfigAdmin, pascal: string): string => {
    const camelValue = source[camel]
    if (typeof camelValue === 'string') {
      return camelValue
    }

    const pascalValue = source[pascal]
    return typeof pascalValue === 'string' ? pascalValue : ''
  }

  const normalizeSiteConfig = (value: unknown): SeoConfigAdmin => {
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

  const normalizedBaseUrl = computed(() => siteForm.baseUrl.trim().replace(/\/+$/, ''))
  const computedKeywords = computed(() =>
    siteForm.keywords ? siteForm.keywords.split(',').map((value) => value.trim()).filter((value) => value) : [])
  const hasOgImage = computed(() => Boolean(siteForm.ogImage))
  const loadingSite = computed(() => initialLoadTask.isRunning.value)
  const siteFormDisabled = computed(() => loadingSite.value || savingSite.value || siteLoadFailed.value)
  const siteSubmitText = computed(() => (savingSite.value ? '保存中...' : '保存同步'))
  const pageSubmitText = computed(() => (savingPage.value ? '发布中...' : '发布更新'))
  const isPageDirty = computed(() => pageContent.value !== originalPageContent.value)
  const currentPageTarget = computed(() => pageTargets.find((item) => item.value === currentSlug.value) ?? pageTargets[0])
  const pageContentLength = computed(() => pageContent.value.trim().length)
  const siteSearchPreview = computed(() => ({
    title: siteForm.title.trim() || "Fsus's Blog",
    url: normalizedBaseUrl.value || 'https://fsus.blog',
    description: siteForm.description.trim() || '站点描述将在这里显示。'
  }))

  const serializeSiteForm = (): string => JSON.stringify({
    title: siteForm.title.trim(),
    description: siteForm.description.trim(),
    keywords: siteForm.keywords.trim(),
    author: siteForm.author.trim(),
    ogImage: siteForm.ogImage.trim(),
    baseUrl: normalizedBaseUrl.value
  })

  const isSiteDirty = computed(() => serializeSiteForm() !== originalSiteSnapshot.value)
  const siteChangeSummary = computed(() => {
    if (!originalSiteSnapshot.value) {
      return []
    }

    const before = JSON.parse(originalSiteSnapshot.value) as Record<string, string>
    const after = JSON.parse(serializeSiteForm()) as Record<string, string>
    const labels: Record<string, string> = {
      title: '网站标题',
      description: 'SEO 描述',
      keywords: '关键词',
      author: '作者名称',
      ogImage: 'OG 图',
      baseUrl: '站点基础 URL'
    }

    return Object.keys(labels).filter((key) => before[key] !== after[key]).map((key) => labels[key])
  })

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
      sanitizeKeywords()
      if (siteForm.baseUrl) {
        siteForm.baseUrl = normalizedBaseUrl.value
        if (!validateBaseUrl(siteForm.baseUrl)) {
          throw createAppError(AppErrorCode.Validation, 'BASEURL_PROTOCOL_INVALID')
        }
      }

      await updateSiteConfig({ ...siteForm }, signal ? buildSignalConfig(signal) : undefined)
      previousOgImage.value = siteForm.ogImage
      originalSiteSnapshot.value = serializeSiteForm()
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        siteForm.ogImage = previousOgImage.value
        const normalized = toAppError(error, '配置同步失败，已回退状态')
        const message = getKnownErrorInfo(normalized).message
        const errorMsg = message === 'BASEURL_PROTOCOL_INVALID' ? '站点URL协议不合法' : '配置同步失败，已回退状态'
        showWarningToast(normalized, errorMsg)
        throw normalized
      }
    }
  }

  const handleImageAction = async (options: UploadRequestOptions): Promise<void> => {
    const file = options.file as File
    imageLoading.value = true
    previousOgImage.value = siteForm.ogImage
    try {
      await imageUploadFlow.startUpload({
        files: [file],
        messages: {
          uploadFailed: '配置图上传失败，可继续恢复',
          uploadSucceeded: '配置图已更新'
        },
        onSuccess: async ([url]) => {
          siteForm.ogImage = url
          await nextTick()
          toast.success('配置图已更新，请保存同步')
        },
        onError: (message, error) => {
          if (!isAbortError(error)) {
            console.error('[Settings] Upload failed:', error)
            siteForm.ogImage = previousOgImage.value
            showErrorToast(error, message)
          }
        }
      })
    } finally {
      imageLoading.value = false
    }
  }

  const resumeImageUpload = async (): Promise<void> => {
    imageLoading.value = true
    previousOgImage.value = siteForm.ogImage
    try {
      await imageUploadFlow.resumeUpload({
        messages: {
          resumeMissing: '没有可恢复的上传任务',
          resumeFailed: '恢复上传失败',
          uploadSucceeded: '配置图恢复上传成功'
        },
        onSuccess: async ([url]) => {
          siteForm.ogImage = url
          await nextTick()
          toast.success('配置图恢复上传成功，请保存同步')
        },
        onError: (message, error) => {
          if (!isAbortError(error)) {
            console.error('[Settings] Resume upload failed:', error)
            siteForm.ogImage = previousOgImage.value
            showErrorToast(error, message)
          }
        }
      })
    } finally {
      imageLoading.value = false
    }
  }

  const handleImageRemove = async (): Promise<void> => {
    imageLoading.value = true
    previousOgImage.value = siteForm.ogImage

    try {
      siteForm.ogImage = ''
      toast.success('预览图已从待保存配置移除，请保存同步')
    } finally {
      imageLoading.value = false
    }
  }

  const saveSiteConfig = async (): Promise<void> => {
    if (loadingSite.value) {
      showWarningToast('站点配置仍在加载，请稍后保存', '站点配置仍在加载，请稍后保存')
      return
    }

    sanitizeKeywords()

    if (!siteForm.title.trim()) {
      showWarningToast('标题不可为空', '标题不可为空')
      return
    }
    if (!siteForm.author.trim()) {
      showWarningToast('作者名称不可为空', '作者名称不可为空')
      return
    }
    if (!siteForm.baseUrl.trim() || !validateBaseUrl(siteForm.baseUrl)) {
      showWarningToast('请提供合法的站点基础 URL (http/https)', '请提供合法的站点基础 URL (http/https)')
      return
    }

    savingSite.value = true
    try {
      await siteTask.run(async (signal) => {
        await syncSeoConfig(signal)
        if (!signal.aborted) {
          toast.success('SEO 配置同步成功')
        }
      })
    } finally {
      savingSite.value = false
    }
  }

  const loadSiteConfig = async (): Promise<void> => {
    try {
      siteLoadFailed.value = false
      await initialLoadTask.run(async (signal) => {
        const data = await getAdminSiteConfig(buildSignalConfig(signal))
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
        sanitizeKeywords()
        originalSiteSnapshot.value = serializeSiteForm()
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        siteLoadFailed.value = true
        console.error('[Settings] Fetch Error:', error)
      }
    }
  }

  const loadPage = async (slug: string): Promise<void> => {
    pageLoading.value = true
    try {
      await pageTask.run(async (signal) => {
        const data = await getAdminPageData(slug, buildSignalConfig(signal))
        if (!signal.aborted) {
          pageContent.value = data?.content || ''
          originalPageContent.value = pageContent.value
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
      savingPage.value = true
      await updatePageData({ slug: currentSlug.value, content: pageContent.value })
      originalPageContent.value = pageContent.value
      toast.success('发布同步成功')
    } finally {
      savingPage.value = false
    }
  }

  const switchPage = async (slug: string): Promise<void> => {
    if (slug === currentSlug.value) {
      return
    }

    currentSlug.value = slug
    await loadPage(slug)
  }

  const requestPageSwitch = async (value: unknown): Promise<void> => {
    if (typeof value !== 'string') {
      return
    }

    const slug = value
    if (slug === currentSlug.value || pageLoading.value || savingPage.value) {
      return
    }

    if (isPageDirty.value) {
      pendingPageSwitchSlug.value = slug
      return
    }

    await switchPage(slug)
  }

  const cancelPageSwitch = (): void => {
    pendingPageSwitchSlug.value = ''
  }

  const discardPageChangesAndSwitch = async (): Promise<void> => {
    const slug = pendingPageSwitchSlug.value
    pendingPageSwitchSlug.value = ''
    if (slug) {
      await switchPage(slug)
    }
  }

  const savePageAndSwitch = async (): Promise<void> => {
    const slug = pendingPageSwitchSlug.value
    if (!slug) {
      return
    }

    await savePageContent()
    pendingPageSwitchSlug.value = ''
    await switchPage(slug)
  }

  const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!isPageDirty.value) {
      return
    }

    event.preventDefault()
    event.returnValue = ''
  }

  watch(activeTab, (value) => {
    if (value !== 'pages') {
      return
    }

    hasActivatedPagesTab.value = true
    void loadPage(currentSlug.value)
  }, { immediate: true })

  onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload)
    void loadSiteConfig()
  })

  onUnmounted(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    siteTask.cancel()
    pageTask.cancel()
    initialLoadTask.cancel()
    imageUploadFlow.cancel()
    pageContent.value = ''
  })

  return {
    activeTab,
    savingSite,
    savingPage,
    loadingSite,
    siteFormDisabled,
    siteLoadFailed,
    pageLoading,
    imageLoading,
    siteForm,
    currentSlug,
    pageContent,
    pageTargets,
    displayUrl,
    hasOgImage,
    computedKeywords,
    normalizedBaseUrl,
    isSiteDirty,
    siteChangeSummary,
    siteSearchPreview,
    siteSubmitText,
    pageSubmitText,
    isPageDirty,
    currentPageTarget,
    pageContentLength,
    pendingPageSwitchSlug,
    imageUploadOptions,
    imageUploadWasmOnlyMode: wasmOnlyMode,
    setImageUploadWasmOnlyMode,
    setImageUploadOptions,
    imageUploadRuntime,
    resumeImageUpload,
    sanitizeKeywords,
    handleImageAction,
    handleImageRemove,
    loadSiteConfig,
    saveSiteConfig,
    savePageContent,
    requestPageSwitch,
    cancelPageSwitch,
    discardPageChangesAndSwitch,
    savePageAndSwitch
  }
}
