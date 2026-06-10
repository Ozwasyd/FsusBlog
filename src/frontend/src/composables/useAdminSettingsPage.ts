import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { type UploadRequestOptions } from '@ozwasyd/element-plus'
import type { ApiRequestConfig } from '@/api/requestConfig'
import {
  deleteImage,
  getAdminPageData,
  getAdminSiteComplianceConfig,
  getAdminSiteConfig,
  refreshPageData,
  updatePageData,
  updateSiteComplianceConfig,
  updateSiteConfig,
  type SeoConfigAdmin,
  type SiteComplianceConfigAdmin
} from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { isAbortError } from '@/utils/errors'
import { getKnownErrorInfo } from '@/utils/errorKinds'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { toast } from '@/fsusui/feedback'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'
import { AppErrorCode, createAppError, toAppError } from '@/utils/appError'

export function useAdminSettingsPage() {
  const baseURL = import.meta.env.VITE_API_BASE_URL || window.location.origin

  const activeTab = ref('site')
  const savingSite = ref(false)
  const savingCompliance = ref(false)
  const savingPage = ref(false)
  const refreshingPage = ref(false)
  const pageLoading = ref(false)
  const imageLoading = ref(false)
  const siteLoadFailed = ref(false)
  const complianceLoadFailed = ref(false)
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
  const complianceForm = reactive<SiteComplianceConfigAdmin>({
    enabled: false,
    regionMode: 'global',
    copyrightOwner: '',
    copyrightStartYear: null,
    copyrightText: '',
    contentLicenseName: '',
    contentLicenseUrl: '',
    icpRecordNumber: '',
    icpRecordUrl: 'https://beian.miit.gov.cn/',
    policeRecordNumber: '',
    policeRecordUrl: 'https://beian.mps.gov.cn/',
    policeBadgeIconUrl: '',
    operatorName: '',
    contactEmail: ''
  })

  const siteTask = useAbortableTask()
  const complianceTask = useAbortableTask()
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
  const originalComplianceSnapshot = ref('')
  const currentSlug = ref('about')
  const pageContent = ref('')
  const originalPageContent = ref('')
  const pendingPageSwitchSlug = ref('')
  const hasActivatedPagesTab = ref(false)
  const pageTargets = [
    { value: 'about', label: '关于我' },
    { value: 'privacy', label: '隐私政策' },
    { value: 'guidelines', label: '用户守则' },
    { value: 'copyright', label: '版权声明' }
  ] as const

  const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal })

  const readStringField = (source: Record<string, unknown>, camel: string, pascal: string): string => {
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

  const readBooleanField = (source: Record<string, unknown>, camel: string, pascal: string): boolean => {
    const value = source[camel] ?? source[pascal]
    return value === true || value === 'true'
  }

  const readNullableNumberField = (source: Record<string, unknown>, camel: string, pascal: string): number | null => {
    const value = source[camel] ?? source[pascal]
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null
  }

  const normalizeComplianceConfig = (value: unknown): SiteComplianceConfigAdmin => {
    if (!value || typeof value !== 'object') {
      return { ...complianceForm }
    }

    const source = value as Record<string, unknown>
    return {
      enabled: readBooleanField(source, 'enabled', 'Enabled'),
      regionMode: readStringField(source, 'regionMode', 'RegionMode') === 'mainland-cn' ? 'mainland-cn' : 'global',
      copyrightOwner: readStringField(source, 'copyrightOwner', 'CopyrightOwner'),
      copyrightStartYear: readNullableNumberField(source, 'copyrightStartYear', 'CopyrightStartYear'),
      copyrightText: readStringField(source, 'copyrightText', 'CopyrightText'),
      contentLicenseName: readStringField(source, 'contentLicenseName', 'ContentLicenseName'),
      contentLicenseUrl: readStringField(source, 'contentLicenseUrl', 'ContentLicenseUrl'),
      icpRecordNumber: readStringField(source, 'icpRecordNumber', 'IcpRecordNumber'),
      icpRecordUrl: readStringField(source, 'icpRecordUrl', 'IcpRecordUrl') || 'https://beian.miit.gov.cn/',
      policeRecordNumber: readStringField(source, 'policeRecordNumber', 'PoliceRecordNumber'),
      policeRecordUrl: readStringField(source, 'policeRecordUrl', 'PoliceRecordUrl') || 'https://beian.mps.gov.cn/',
      policeBadgeIconUrl: readStringField(source, 'policeBadgeIconUrl', 'PoliceBadgeIconUrl'),
      operatorName: readStringField(source, 'operatorName', 'OperatorName'),
      contactEmail: readStringField(source, 'contactEmail', 'ContactEmail')
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
  const loadingCompliance = computed(() => complianceTask.isRunning.value)
  const siteFormDisabled = computed(() => loadingSite.value || savingSite.value || siteLoadFailed.value)
  const complianceFormDisabled = computed(() => loadingCompliance.value || savingCompliance.value || complianceLoadFailed.value)
  const siteSubmitText = computed(() => (savingSite.value ? '保存中...' : '保存同步'))
  const complianceSubmitText = computed(() => (savingCompliance.value ? '保存中...' : '保存合规信息'))
  const pageSubmitText = computed(() => (savingPage.value ? '发布中...' : '发布更新'))
  const isPageDirty = computed(() => pageContent.value !== originalPageContent.value)
  const currentPageTarget = computed(() => pageTargets.find((item) => item.value === currentSlug.value) ?? pageTargets[0])
  const pageContentLength = computed(() => pageContent.value.trim().length)
  const siteSearchPreview = computed(() => ({
    title: siteForm.title.trim() || "Fsus's Blog",
    url: normalizedBaseUrl.value || 'https://fsus.blog',
    description: siteForm.description.trim() || '站点描述将在这里显示。'
  }))
  const compliancePreview = computed(() => ({
    copyright: `© ${resolveComplianceYearText()} ${complianceForm.copyrightOwner.trim() || siteForm.title.trim() || "Fsu's Blog"}。${complianceForm.copyrightText.trim() || '保留所有权利。'}`,
    icp: complianceForm.icpRecordNumber.trim(),
    police: complianceForm.policeRecordNumber.trim(),
    license: complianceForm.contentLicenseName.trim()
  }))
  const mainlandLaunchChecklist = computed(() => [
    { label: '基础 URL 已配置', done: Boolean(siteForm.baseUrl.trim()) },
    { label: 'ICP 备案号已配置', done: Boolean(complianceForm.icpRecordNumber.trim()) },
    { label: '公安备案号已配置', done: Boolean(complianceForm.policeRecordNumber.trim()) },
    { label: '隐私政策已纳入页面编辑', done: pageTargets.some((item) => item.value === 'privacy') },
    { label: '用户守则已纳入页面编辑', done: pageTargets.some((item) => item.value === 'guidelines') },
    { label: '版权声明已纳入页面编辑', done: pageTargets.some((item) => item.value === 'copyright') },
    { label: 'RSS 公开入口可访问', done: true },
    { label: 'sitemap 与 robots 公开分发已启用', done: true }
  ])

  const serializeSiteForm = (): string => JSON.stringify({
    title: siteForm.title.trim(),
    description: siteForm.description.trim(),
    keywords: siteForm.keywords.trim(),
    author: siteForm.author.trim(),
    ogImage: siteForm.ogImage.trim(),
    baseUrl: normalizedBaseUrl.value
  })
  const serializeComplianceForm = (): string => JSON.stringify({
    enabled: complianceForm.enabled,
    regionMode: complianceForm.regionMode,
    copyrightOwner: complianceForm.copyrightOwner.trim(),
    copyrightStartYear: complianceForm.copyrightStartYear,
    copyrightText: complianceForm.copyrightText.trim(),
    contentLicenseName: complianceForm.contentLicenseName.trim(),
    contentLicenseUrl: complianceForm.contentLicenseUrl.trim(),
    icpRecordNumber: complianceForm.icpRecordNumber.trim(),
    icpRecordUrl: complianceForm.icpRecordUrl.trim(),
    policeRecordNumber: complianceForm.policeRecordNumber.trim(),
    policeRecordUrl: complianceForm.policeRecordUrl.trim(),
    policeBadgeIconUrl: complianceForm.policeBadgeIconUrl.trim(),
    operatorName: complianceForm.operatorName.trim(),
    contactEmail: complianceForm.contactEmail.trim()
  })

  const isSiteDirty = computed(() => serializeSiteForm() !== originalSiteSnapshot.value)
  const isComplianceDirty = computed(() => serializeComplianceForm() !== originalComplianceSnapshot.value)
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
      ogImage: '社交分享图',
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

  const resolveComplianceYearText = (): string => {
    const currentYear = new Date().getFullYear()
    const startYear = complianceForm.copyrightStartYear
    return startYear && startYear < currentYear ? `${startYear}-${currentYear}` : `${currentYear}`
  }

  const validateOptionalHttpUrl = (url: string): boolean => {
    const value = url.trim()
    return !value || validateBaseUrl(value)
  }

  const collectComplianceWarnings = (): string[] => {
    const warnings: string[] = []
    const icp = complianceForm.icpRecordNumber.trim()
    const police = complianceForm.policeRecordNumber.trim()
    if (icp && !/^[\u4e00-\u9fa5]ICP备\d{8,12}号(-\d+)?$/u.test(icp)) {
      warnings.push('ICP 备案号格式需要人工复核')
    }
    if (police && !/^[\u4e00-\u9fa5]公网安备\d{14}号$/u.test(police)) {
      warnings.push('公安备案号格式需要人工复核')
    }
    return warnings
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

  const handleImageDelete = async (): Promise<void> => {
    const current = siteForm.ogImage
    if (!current) {
      return
    }

    imageLoading.value = true
    previousOgImage.value = current
    try {
      await deleteImage(current)
      siteForm.ogImage = ''
      toast.success('预览图已从配置移除并删除服务器文件，请保存同步')
    } catch (error: unknown) {
      siteForm.ogImage = previousOgImage.value
      showErrorToast(error, '服务器文件删除失败')
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

  const loadComplianceConfig = async (): Promise<void> => {
    try {
      complianceLoadFailed.value = false
      await complianceTask.run(async (signal) => {
        const data = await getAdminSiteComplianceConfig(buildSignalConfig(signal))
        if (!data || signal.aborted) {
          return
        }

        Object.assign(complianceForm, normalizeComplianceConfig(data))
        originalComplianceSnapshot.value = serializeComplianceForm()
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        complianceLoadFailed.value = true
        console.error('[Settings] Compliance fetch error:', error)
      }
    }
  }

  const saveComplianceConfig = async (): Promise<void> => {
    if (loadingCompliance.value) {
      showWarningToast('合规配置仍在加载，请稍后保存', '合规配置仍在加载，请稍后保存')
      return
    }

    const currentYear = new Date().getFullYear()
    const startYear = complianceForm.copyrightStartYear
    if (startYear !== null && (startYear < 1990 || startYear > currentYear)) {
      showWarningToast(`版权起始年份需在 1990 到 ${currentYear} 之间`, `版权起始年份需在 1990 到 ${currentYear} 之间`)
      return
    }

    const urls = [
      complianceForm.icpRecordUrl,
      complianceForm.policeRecordUrl,
      complianceForm.policeBadgeIconUrl,
      complianceForm.contentLicenseUrl
    ]
    if (urls.some((url) => !validateOptionalHttpUrl(url))) {
      showWarningToast('链接只支持 http/https 协议', '链接只支持 http/https 协议')
      return
    }

    const warnings = collectComplianceWarnings()
    if (warnings.length > 0) {
      showWarningToast(warnings.join('，'), warnings.join('，'))
    }

    savingCompliance.value = true
    try {
      await complianceTask.run(async (signal) => {
        await updateSiteComplianceConfig({ ...complianceForm }, buildSignalConfig(signal))
        if (!signal.aborted) {
          originalComplianceSnapshot.value = serializeComplianceForm()
          toast.success('合规信息已保存并刷新公开缓存')
        }
      })
    } finally {
      savingCompliance.value = false
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
      await refreshPageData(currentSlug.value)
      originalPageContent.value = pageContent.value
      toast.success('发布并刷新缓存成功')
    } finally {
      savingPage.value = false
    }
  }

  const refreshPageCache = async (): Promise<void> => {
    refreshingPage.value = true
    try {
      await refreshPageData(currentSlug.value)
      toast.success('页面缓存已刷新')
    } catch (error: unknown) {
      showErrorToast(error, '页面缓存刷新失败')
    } finally {
      refreshingPage.value = false
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
    void loadComplianceConfig()
  })

  onUnmounted(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    siteTask.cancel()
    complianceTask.cancel()
    pageTask.cancel()
    initialLoadTask.cancel()
    imageUploadFlow.cancel()
    pageContent.value = ''
  })

  return {
    activeTab,
    savingSite,
    savingCompliance,
    savingPage,
    refreshingPage,
    loadingSite,
    loadingCompliance,
    siteFormDisabled,
    complianceFormDisabled,
    siteLoadFailed,
    complianceLoadFailed,
    pageLoading,
    imageLoading,
    siteForm,
    complianceForm,
    currentSlug,
    pageContent,
    pageTargets,
    displayUrl,
    hasOgImage,
    computedKeywords,
    normalizedBaseUrl,
    isSiteDirty,
    isComplianceDirty,
    siteChangeSummary,
    siteSearchPreview,
    compliancePreview,
    mainlandLaunchChecklist,
    siteSubmitText,
    complianceSubmitText,
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
    handleImageDelete,
    loadSiteConfig,
    loadComplianceConfig,
    saveSiteConfig,
    saveComplianceConfig,
    savePageContent,
    refreshPageCache,
    requestPageSwitch,
    cancelPageSwitch,
    discardPageChangesAndSwitch,
    savePageAndSwitch
  }
}
