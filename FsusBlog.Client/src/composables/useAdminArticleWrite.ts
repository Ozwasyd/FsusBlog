import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type FormInstance } from '@ozwasyd/element-plus'
import {
  getArticleById,
  createArticle,
  getArticles,
  updateArticle,
  uploadArticleAotBundle,
  type ArticleDetailResponse,
  type ArticleWriteRequest
} from '@/api/article'
import { createCategory, getCategories, type CategoryItem } from '@/api/category'
import { createTag, getTags, type TagItem } from '@/api/tag'
import { getPageData } from '@/api/system'
import { useAbortableTask } from '@/composables/useAbortableTask'
import type { AxiosRequestConfig } from 'axios'
import { isAbortError } from '@/utils/errors'
import { useSiteStore } from '@/store/site'
import { buildFilterPublicAotEntry, buildPublicHydrationBundle } from '@/helpers/publicAotBundle'
import { toast } from '@/utils/toast'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'

interface ArticleParams {
  title: string
  content: string
  summary: string
  categoryId: number | undefined
  tagIds: number[]
}

interface ArticleDraftSnapshot extends ArticleParams {
  savedAt: number
  sourceArticleId: number | null
  isEdit: boolean
}

const CREATE_DRAFT_KEY = 'fsus:article-draft:create'
const EDIT_DRAFT_PREFIX = 'fsus:article-draft:edit:'
const DRAFT_SAVE_DELAY_MS = 700

const hasDraftContent = (draft: Pick<ArticleParams, 'title' | 'content' | 'summary' | 'categoryId' | 'tagIds'>): boolean =>
  draft.title.trim().length > 0
  || draft.content.trim().length > 0
  || draft.summary.trim().length > 0
  || draft.categoryId !== undefined
  || draft.tagIds.length > 0

const normalizeDraft = (value: unknown): ArticleDraftSnapshot | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const raw = value as Partial<ArticleDraftSnapshot>
  if (typeof raw.title !== 'string' || typeof raw.content !== 'string' || typeof raw.summary !== 'string') {
    return null
  }

  return {
    title: raw.title,
    content: raw.content,
    summary: raw.summary,
    categoryId: typeof raw.categoryId === 'number' && Number.isFinite(raw.categoryId) ? raw.categoryId : undefined,
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.map(Number).filter((item) => Number.isFinite(item)) : [],
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    sourceArticleId: typeof raw.sourceArticleId === 'number' && Number.isFinite(raw.sourceArticleId) ? raw.sourceArticleId : null,
    isEdit: raw.isEdit === true
  }
}

const readDraftSnapshot = (key: string): ArticleDraftSnapshot | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }

    const parsed = normalizeDraft(JSON.parse(raw))
    if (!parsed) {
      window.localStorage.removeItem(key)
    }
    return parsed
  } catch {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // Storage may be unavailable in restricted browser contexts.
    }
    return null
  }
}

const writeDraftSnapshot = (key: string, snapshot: ArticleDraftSnapshot): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(snapshot))
  } catch {
    // Local draft cache is best-effort and must never block editing.
  }
}

const removeDraftSnapshot = (key: string): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage failures.
  }
}

export function useAdminArticleWrite() {
  const route = useRoute()
  const router = useRouter()
  const siteStore = useSiteStore()
  const formRef = ref<FormInstance>()
  const articleId = computed(() => {
    const raw = route.params.id ?? route.query.id
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  })

  const pageLoading = ref(false)
  const submitting = ref(false)
  const categories = shallowRef<CategoryItem[]>([])
  const tags = shallowRef<TagItem[]>([])
  const originalCreateTime = ref('')
  const draftStatusText = ref('')
  const pendingDraft = ref<ArticleDraftSnapshot | null>(null)
  const draftSavedAt = ref<number | null>(null)
  const quickCreatingCategory = ref(false)
  const quickCreatingTag = ref(false)
  const {
    options: imageUploadOptions,
    wasmOnlyMode,
    setOptions: setImageUploadOptions,
    setWasmOnlyMode: setImageUploadWasmOnlyMode
  } = useImageUploadPreferences()
  const imageUploadRuntime = useImageUploadRuntime()

  const isEdit = computed(() => articleId.value !== null)
  const submitButtonText = computed(() => (isEdit.value ? '确认更新' : '立即发布'))
  const submitConfirmContent = computed(() =>
    isEdit.value ? '确认要更新此博文版本吗？' : '确认要立即发布此博文吗？'
  )

  const articleForm = reactive<ArticleParams>({
    title: '',
    content: '',
    summary: '',
    categoryId: undefined,
    tagIds: []
  })
  const draftKey = computed(() => (isEdit.value && articleId.value !== null ? `${EDIT_DRAFT_PREFIX}${articleId.value}` : CREATE_DRAFT_KEY))
  const hasLocalDraft = computed(() => pendingDraft.value !== null || draftSavedAt.value !== null)
  const requiresLeaveConfirm = computed(() => articleForm.content.length > 50 || hasLocalDraft.value)

  const rules = {
    title: [{ required: true, message: '博文标题是必填项', trigger: 'blur' }],
    content: [
      { required: true, message: '请键入正文内容', trigger: 'blur' },
      { max: 200000, message: '内容长度超出物理限制 (200KB)', trigger: 'blur' }
    ],
    categoryId: [{ required: true, message: '请为文章指定一个分类', trigger: 'change' }]
  }

  const initTask = useAbortableTask()
  const submitTask = useAbortableTask()
  const taxonomyTask = useAbortableTask()
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

  const handleUploadImg = async (
    files: File[],
    callback: (urls: string[]) => void,
    onError: (message: string) => void
  ): Promise<void> => {
    await imageUploadFlow.startUpload({
      files,
      maxFiles: 10,
      messages: {
        tooManyFiles: '单次上传资源文件不得超过 10 个',
        uploadFailed: '图片存储服务不可用',
        uploadSucceeded: `成功同步 ${files.length} 张资源图片`
      },
      onSuccess: (urls) => {
        callback(urls)
      },
      onError: (message) => {
        onError(message)
      }
    })
  }

  const resumeImageUpload = async (): Promise<void> => {
    await imageUploadFlow.resumeUpload({
      messages: {
        resumeMissing: '没有可恢复的上传任务',
        resumeFailed: '继续上传失败'
      }
    })
  }

  const buildSignalConfig = (signal: AbortSignal): AxiosRequestConfig => ({ signal })

  let draftSaveTimer: ReturnType<typeof window.setTimeout> | null = null
  let suppressDraftSave = true

  const clearDraftSaveTimer = (): void => {
    if (draftSaveTimer !== null) {
      window.clearTimeout(draftSaveTimer)
      draftSaveTimer = null
    }
  }

  const buildDraftSnapshot = (): ArticleDraftSnapshot => ({
    title: articleForm.title,
    content: articleForm.content,
    summary: articleForm.summary,
    categoryId: articleForm.categoryId,
    tagIds: [...articleForm.tagIds],
    savedAt: Date.now(),
    sourceArticleId: articleId.value,
    isEdit: isEdit.value
  })

  const saveDraftNow = (): void => {
    if (suppressDraftSave || !hasDraftContent(articleForm)) {
      return
    }

    const snapshot = buildDraftSnapshot()
    writeDraftSnapshot(draftKey.value, snapshot)
    draftSavedAt.value = snapshot.savedAt
    draftStatusText.value = `本地缓存已保存 ${new Date(snapshot.savedAt).toLocaleTimeString()}`
  }

  const scheduleDraftSave = (): void => {
    if (suppressDraftSave || typeof window === 'undefined') {
      return
    }

    clearDraftSaveTimer()
    draftSaveTimer = window.setTimeout(saveDraftNow, DRAFT_SAVE_DELAY_MS)
  }

  const isDraftSameAsForm = (draft: ArticleDraftSnapshot): boolean =>
    draft.title === articleForm.title
    && draft.content === articleForm.content
    && draft.summary === articleForm.summary
    && draft.categoryId === articleForm.categoryId
    && JSON.stringify(draft.tagIds) === JSON.stringify(articleForm.tagIds)

  const detectLocalDraft = (): void => {
    const draft = readDraftSnapshot(draftKey.value)
    if (!draft || !hasDraftContent(draft) || isDraftSameAsForm(draft)) {
      pendingDraft.value = null
      draftSavedAt.value = draft?.savedAt ?? null
      return
    }

    pendingDraft.value = draft
    draftSavedAt.value = draft.savedAt
    draftStatusText.value = `发现 ${new Date(draft.savedAt).toLocaleString()} 保存的本地缓存`
  }

  const applyDraftToForm = (draft: ArticleDraftSnapshot): void => {
    suppressDraftSave = true
    articleForm.title = draft.title
    articleForm.content = draft.content
    articleForm.summary = draft.summary
    articleForm.categoryId = draft.categoryId
    articleForm.tagIds = [...draft.tagIds]
    suppressDraftSave = false
  }

  const restoreLocalDraft = (): void => {
    if (!pendingDraft.value) {
      return
    }

    applyDraftToForm(pendingDraft.value)
    pendingDraft.value = null
    draftStatusText.value = '已恢复本地缓存'
    saveDraftNow()
    toast.success('已恢复本地缓存')
  }

  const discardLocalDraft = (): void => {
    removeDraftSnapshot(draftKey.value)
    pendingDraft.value = null
    draftSavedAt.value = null
    draftStatusText.value = ''
    toast.success('本地缓存已丢弃')
  }

  const clearLocalDraft = (): void => {
    clearDraftSaveTimer()
    removeDraftSnapshot(draftKey.value)
    pendingDraft.value = null
    draftSavedAt.value = null
    draftStatusText.value = ''
  }

  const refreshTaxonomy = async (signal?: AbortSignal): Promise<void> => {
    const requestConfig = signal ? buildSignalConfig(signal) : undefined
    const [catRes, tagRes] = await Promise.all([
      getCategories(requestConfig),
      getTags(requestConfig)
    ])
    categories.value = catRes || []
    tags.value = tagRes || []
  }

  const quickCreateCategory = async (name: string): Promise<boolean> => {
    const trimmed = name.trim()
    if (trimmed.length < 2 || trimmed.length > 20) {
      showWarningToast('分类名称需为 2-20 个字符', '分类名称需为 2-20 个字符')
      return false
    }

    quickCreatingCategory.value = true
    try {
      await taxonomyTask.run(async (signal) => {
        await createCategory(trimmed, buildSignalConfig(signal))
        await refreshTaxonomy(signal)
        const created = categories.value.find((item) => item.name === trimmed)
        if (created) {
          articleForm.categoryId = created.id
        }
      })
      toast.success('分类已创建并选中')
      return true
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '分类创建失败，请稍后重试')
      }
      return false
    } finally {
      quickCreatingCategory.value = false
    }
  }

  const quickCreateTag = async (name: string): Promise<boolean> => {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 20) {
      showWarningToast('标签名称需为 1-20 个字符', '标签名称需为 1-20 个字符')
      return false
    }

    quickCreatingTag.value = true
    try {
      await taxonomyTask.run(async (signal) => {
        await createTag(trimmed, buildSignalConfig(signal))
        await refreshTaxonomy(signal)
        const created = tags.value.find((item) => item.name === trimmed)
        if (created && !articleForm.tagIds.includes(created.id)) {
          articleForm.tagIds = [...articleForm.tagIds, created.id]
        }
      })
      toast.success('标签已创建并关联')
      return true
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '标签创建失败，请稍后重试')
      }
      return false
    } finally {
      quickCreatingTag.value = false
    }
  }

  const buildAotBundle = async (articleId: number, signal?: AbortSignal): Promise<ArticleWriteRequest['aotBundle']> => {
    const category = categories.value.find((item) => item.id === articleForm.categoryId)
    const selectedTags = tags.value.filter((item) => articleForm.tagIds.includes(item.id))
    const requestConfig = signal ? buildSignalConfig(signal) : undefined
    const allCategories = [...categories.value]
    const allTags = [...tags.value]

    const filterTasks: Array<Promise<{ kind: 'category' | 'tag'; id: number; name: string; list: Awaited<ReturnType<typeof getArticles>> }>> = [
      ...allCategories.map((item) =>
        getArticles({ page: 1, size: 10, categoryId: item.id }, requestConfig).then((list) => ({
          kind: 'category' as const,
          id: item.id,
          name: item.name,
          list
        }))
      ),
      ...allTags.map((item) =>
        getArticles({ page: 1, size: 10, tagId: item.id }, requestConfig).then((list) => ({
          kind: 'tag' as const,
          id: item.id,
          name: item.name,
          list
        }))
      )
    ]

    const [homeResult, aboutResult, archiveResult, ...filterResults] = await Promise.allSettled([
      getArticles({ page: 1, size: 8 }, requestConfig),
      getPageData('about', requestConfig),
      getArticles({ page: 1, size: 200 }, requestConfig),
      ...filterTasks
    ])

    const homeResponse = homeResult.status === 'fulfilled' ? homeResult.value : undefined
    const aboutContent = aboutResult.status === 'fulfilled' ? (aboutResult.value?.content ?? '') : ''
    const archiveItems = archiveResult.status === 'fulfilled' ? archiveResult.value.items : []

    const bundle = await buildPublicHydrationBundle({
      articleId,
      title: articleForm.title,
      content: articleForm.content,
      summary: articleForm.summary,
      createTime: originalCreateTime.value || undefined,
      categoryId: articleForm.categoryId,
      categoryName: category?.name ?? '未分类',
      tags: selectedTags,
      siteTitle: siteStore.siteInfo.title,
      baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
        ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
        : undefined,
      homeResponse,
      includeAbout: true,
      about: {
        content: aboutContent,
        siteTitle: siteStore.siteInfo.title,
        title: '关于',
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      },
      includeArchive: true,
      archive: {
        articles: archiveItems.map((item) => ({
          id: item.id,
          title: item.title,
          createTime: item.createTime
        })),
        siteTitle: siteStore.siteInfo.title,
        title: '归档',
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      }
    })

    for (const result of filterResults) {
      if (result.status !== 'fulfilled') {
        continue
      }

      const filter = result.value
      const routeKey = filter.kind === 'category'
        ? `category:${filter.id}`
        : `tag:${filter.id}`
      const title = filter.kind === 'category'
        ? `分类：${filter.name}`
        : `标签：${filter.name}`

      bundle.entries.push(await buildFilterPublicAotEntry({
        routeKey,
        pageIndex: 1,
        pageSize: 10,
        total: filter.list.total,
        articles: filter.list.items.map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          createTime: item.createTime
        })),
        siteTitle: siteStore.siteInfo.title,
        title,
        baseUrl: 'baseUrl' in siteStore.siteInfo && typeof (siteStore.siteInfo as { baseUrl?: unknown }).baseUrl === 'string'
          ? ((siteStore.siteInfo as { baseUrl?: string }).baseUrl ?? '').trim() || undefined
          : undefined
      }))
    }

    return bundle
  }

  const syncArticleAotBundle = async (
    targetArticleId: number,
    signal: AbortSignal,
    config: AxiosRequestConfig
  ): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    try {
      const bundle = await buildAotBundle(targetArticleId, signal)
      await uploadArticleAotBundle(targetArticleId, bundle, config)
      return { ok: true }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error
      }

      return { ok: false, error }
    }
  }

  const initData = async () => {
    pageLoading.value = true
    try {
      await initTask.run(async (signal) => {
        await refreshTaxonomy(signal)

        if (signal.aborted) {
          return
        }

        if (!isEdit.value) {
          return
        }

        if (articleId.value === null) {
          return
        }

        const data = await getArticleById(articleId.value, buildSignalConfig(signal)) as ArticleDetailResponse
        if (!data || signal.aborted) {
          return
        }

        articleForm.title = data.title || ''
        articleForm.content = data.content || ''
        articleForm.summary = data.summary || ''
        articleForm.categoryId = data.category?.id ? Number(data.category.id) : undefined
        articleForm.tagIds = Array.isArray(data.tags) ? data.tags.map((item) => Number(item.id)) : []
        originalCreateTime.value = data.createTime || ''
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast('无法同步远程配置资源', '无法同步远程配置资源')
        console.error('[Write Init Error]', error)
      }
    } finally {
      detectLocalDraft()
      suppressDraftSave = false
      pageLoading.value = false
    }
  }

  const validateBeforeSubmit = async (): Promise<boolean> => {
    if (!formRef.value || submitting.value) {
      return false
    }

    try {
      await formRef.value.validate()
      return true
    } catch {
      return false
    }
  }

  const submitForm = async () => {
    try {
      submitting.value = true
      await submitTask.run(async (signal) => {
        const config: AxiosRequestConfig = { signal }
        const articlePayload: ArticleWriteRequest = {
          title: articleForm.title,
          content: articleForm.content,
          summary: articleForm.summary,
          categoryId: articleForm.categoryId,
          tagIds: [...articleForm.tagIds]
        }

        let targetArticleId: number | null = null
        const successMessage = isEdit.value ? '博文已成功修订' : '博文已上线发布'

        if (isEdit.value) {
          if (articleId.value === null) {
            return
          }

          await updateArticle(articleId.value, articlePayload, config)
          targetArticleId = articleId.value
        } else {
          const result = await createArticle(articlePayload, config)
          const createdId = Number(result?.id)
          if (Number.isFinite(createdId) && createdId > 0) {
            targetArticleId = createdId
          }
        }

        if (targetArticleId === null) {
          throw new Error('article_write_succeeded_without_id')
        }

        const aotSyncResult = await syncArticleAotBundle(targetArticleId, signal, config)
        if (aotSyncResult.ok) {
          toast.success(successMessage)
        } else {
          showWarningToast(
            aotSyncResult.error,
            '文章已保存，但公开页缓存同步失败，可稍后重试同步'
          )
        }

        suppressDraftSave = true
        clearLocalDraft()
        articleForm.content = ''
        await router.push('/user/manage/article/list')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, isEdit.value ? '博文更新失败，请稍后重试' : '博文发布失败，请稍后重试')
        console.error('[Article Submit] Critical Error:', error)
      }
    } finally {
      submitting.value = false
    }
  }

  const autoGenerateSummary = () => {
    if (!articleForm.content) {
      showWarningToast('博文正文为空', '博文正文为空')
      return
    }

    const cleanStr = articleForm.content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/(!\[.*?]\(.*?\))|(\[.*?]\(.*?\))/g, '')
      .replace(/[#*`>|\-]/g, '')
      .replace(/(\r\n|\n|\r)/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 180)

    articleForm.summary = cleanStr + (cleanStr.length >= 180 ? '...' : '')
    toast.success('摘要提取算法执行成功')
  }

  const leaveEditor = () => {
    void router.back()
  }

  watch(
    () => ({
      title: articleForm.title,
      content: articleForm.content,
      summary: articleForm.summary,
      categoryId: articleForm.categoryId,
      tagIds: [...articleForm.tagIds]
    }),
    scheduleDraftSave,
    { deep: true }
  )

  onMounted(() => {
    void initData()
  })

  onUnmounted(() => {
    initTask.cancel()
    submitTask.cancel()
    taxonomyTask.cancel()
    imageUploadFlow.cancel()
    clearDraftSaveTimer()
    articleForm.title = ''
    articleForm.content = ''
    articleForm.summary = ''
    originalCreateTime.value = ''
  })

  return {
    formRef,
    pageLoading,
    submitting,
    categories,
    tags,
    isEdit,
    submitButtonText,
    submitConfirmContent,
    requiresLeaveConfirm,
    pendingDraft,
    draftStatusText,
    hasLocalDraft,
    articleForm,
    rules,
    validateBeforeSubmit,
    handleUploadImg,
    submitForm,
    restoreLocalDraft,
    discardLocalDraft,
    quickCreateCategory,
    quickCreateTag,
    quickCreatingCategory,
    quickCreatingTag,
    autoGenerateSummary,
    imageUploadOptions,
    imageUploadWasmOnlyMode: wasmOnlyMode,
    setImageUploadWasmOnlyMode,
    setImageUploadOptions,
    imageUploadRuntime,
    resumeImageUpload,
    leaveEditor
  }
}
