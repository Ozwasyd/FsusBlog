import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type FormInstance } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/fsusui/result'
import {
  getAdminArticleById,
  createArticle,
  updateArticle,
  ArticlePublishStatus,
  type ArticleDetailResponse,
  type ArticleWriteRequest
} from '@/api/article'
import {
  checkArticlePrepublish,
  cleanupOrphanAssets,
  discardServerDraft,
  generateAiAssist,
  getArticleRevision,
  getServerDraft,
  listAssetLibrary,
  listArticleRevisions,
  previewArticleDraft,
  reindexArticleAssets,
  rollbackArticleRevision,
  saveServerDraft,
  type AiAssistResponse,
  type AssetLibraryItemResponse,
  type ArticlePreviewResponse,
  type ArticleRevisionDetailResponse,
  type ArticleRevisionSummaryResponse,
  type PrepublishIssue,
  type ServerDraftResponse,
  type ServerDraftSaveRequest
} from '@/api/authoring'
import { createCategory, getCategories, type CategoryItem } from '@/api/category'
import { getAdminSiteConfig, type SeoConfigAdmin } from '@/api/system'
import { createTag, getTags, type TagItem } from '@/api/tag'
import { useAbortableTask } from '@/composables/useAbortableTask'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { isAbortError } from '@/utils/errors'
import { toast } from '@/fsusui/feedback'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

interface ArticleParams {
  title: string
  content: string
  summary: string
  coverImageUrl: string
  categoryId: number | undefined
  tagIds: number[]
  status: ArticlePublishStatus
  scheduledPublishAt: string
}

interface ArticleDraftSnapshot extends ArticleParams {
  savedAt: number
  sourceArticleId: number | null
  isEdit: boolean
  source: 'local' | 'server'
  clientRevision: string
}

interface ArticleSeoPreviewState {
  title: string
  description: string
  canonicalUrl: string
  slug: string
  ogImage: string
  titleLength: number
  descriptionLength: number
  canonicalValid: boolean
}

const CREATE_DRAFT_KEY = 'fsus:article-draft:create'
const EDIT_DRAFT_PREFIX = 'fsus:article-draft:edit:'
const DRAFT_SAVE_DELAY_MS = 700

const normalizeArticlePublishStatus = (value: unknown): ArticlePublishStatus => {
  const status = Number(value)
  return status === ArticlePublishStatus.Draft
    || status === ArticlePublishStatus.Scheduled
    || status === ArticlePublishStatus.Published
    || status === ArticlePublishStatus.Archived
    || status === ArticlePublishStatus.Deleted
    ? status
    : ArticlePublishStatus.Published
}

const normalizeDateTimeInput = (value: string | null | undefined): string => {
  if (!value) return ''

  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return ''

  const local = new Date(parsed)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`
}

const buildSubmitSuccessMessage = (isEdit: boolean, status: ArticlePublishStatus): string => {
  if (status === ArticlePublishStatus.Draft) return isEdit ? '草稿已更新' : '草稿已保存'
  if (status === ArticlePublishStatus.Scheduled) return isEdit ? '定时发布已更新' : '定时发布已创建'
  if (status === ArticlePublishStatus.Archived) return isEdit ? '文章已归档' : '文章已保存为归档'
  return isEdit ? '博文已成功修订' : '博文已上线发布'
}

const hasDraftContent = (draft: Pick<ArticleParams, 'title' | 'content' | 'summary' | 'categoryId' | 'tagIds'>): boolean =>
  draft.title.trim().length > 0
  || draft.content.trim().length > 0
  || draft.summary.trim().length > 0
  || draft.categoryId !== undefined
  || draft.tagIds.length > 0

const stripMarkdownForSeo = (content: string, maxLength = 180): string => content
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
  .replace(/\[[^\]]+]\([^)]+\)/g, (match) => match.slice(1, match.indexOf(']')))
  .replace(/[#>*_`~|\-[\]]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength)

const normalizeSeoBaseUrl = (value: string): string | null => {
  const candidate = value.trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null
    }

    url.pathname = url.pathname.replace(/\/+$/u, '')
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

const slugifyTitle = (title: string): string => {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'draft-preview'
}

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
    coverImageUrl: typeof raw.coverImageUrl === 'string' ? raw.coverImageUrl : '',
    categoryId: typeof raw.categoryId === 'number' && Number.isFinite(raw.categoryId) ? raw.categoryId : undefined,
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.map(Number).filter((item) => Number.isFinite(item)) : [],
    status: normalizeArticlePublishStatus(raw.status),
    scheduledPublishAt: typeof raw.scheduledPublishAt === 'string' ? raw.scheduledPublishAt : '',
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    sourceArticleId: typeof raw.sourceArticleId === 'number' && Number.isFinite(raw.sourceArticleId) ? raw.sourceArticleId : null,
    isEdit: raw.isEdit === true,
    source: raw.source === 'server' ? 'server' : 'local',
    clientRevision: typeof raw.clientRevision === 'string' ? raw.clientRevision : ''
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

    const parsed = normalizeDraft(decodePublicAotPayload(raw))
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
    window.localStorage.setItem(key, encodePublicAotPayload(snapshot))
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
  const siteConfig = ref<SeoConfigAdmin | null>(null)
  const assetLibrary = shallowRef<AssetLibraryItemResponse[]>([])
  const assetLibraryLoading = ref(false)
  const assetLibraryStatusText = ref('资产库等待同步')
  const draftStatusText = ref('')
  const pendingDraft = ref<ArticleDraftSnapshot | null>(null)
  const draftSavedAt = ref<number | null>(null)
  const draftConflictText = ref('')
  const serverDraftSyncPaused = ref(false)
  const articleRevisions = shallowRef<ArticleRevisionSummaryResponse[]>([])
  const selectedRevision = ref<ArticleRevisionDetailResponse | null>(null)
  const revisionLoading = ref(false)
  const revisionRollbacking = ref(false)
  const revisionStatusText = ref('')
  const privatePreview = ref<ArticlePreviewResponse | null>(null)
  const privatePreviewLoading = ref(false)
  const privatePreviewStatusText = ref('预览仅在作者工作台内生成')
  const seoIssues = ref<PrepublishIssue[]>([])
  const seoChecking = ref(false)
  const seoStatusText = ref('发布前检查随表单实时更新')
  const aiAssist = shallowRef<AiAssistResponse | null>(null)
  const aiAssistLoading = ref(false)
  const aiAssistStatusText = ref('')
  const prepublishWarningOverrideReason = ref('')
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
  const articleForm = reactive<ArticleParams>({
    title: '',
    content: '',
    summary: '',
    coverImageUrl: '',
    categoryId: undefined,
    tagIds: [],
    status: ArticlePublishStatus.Published,
    scheduledPublishAt: ''
  })
  const submitButtonText = computed(() => {
    if (articleForm.status === ArticlePublishStatus.Draft) return '保存草稿'
    if (articleForm.status === ArticlePublishStatus.Scheduled) return '定时发布'
    if (articleForm.status === ArticlePublishStatus.Archived) return '存为归档'
    return isEdit.value ? '确认更新' : '立即发布'
  })
  const submitConfirmContent = computed(() => {
    if (articleForm.status === ArticlePublishStatus.Draft) return '确认保存为后台草稿吗？'
    if (articleForm.status === ArticlePublishStatus.Scheduled) return '确认按所选时间发布此博文吗？'
    if (articleForm.status === ArticlePublishStatus.Archived) return '确认保存为归档隐藏状态吗？'
    return isEdit.value ? '确认要更新此博文版本吗？' : '确认要立即发布此博文吗？'
  })
  const draftKey = computed(() => (isEdit.value && articleId.value !== null ? `${EDIT_DRAFT_PREFIX}${articleId.value}` : CREATE_DRAFT_KEY))
  const hasLocalDraft = computed(() => pendingDraft.value !== null || draftSavedAt.value !== null)
  const pendingDraftSourceLabel = computed(() => pendingDraft.value?.source === 'server' ? '服务端草稿' : '本地缓存')
  const pendingDraftDescription = computed(() => {
    if (draftConflictText.value) {
      return draftConflictText.value
    }

    return pendingDraft.value?.source === 'server'
      ? '恢复会覆盖当前表单，丢弃会删除服务端草稿与本地兜底缓存。'
      : '恢复会覆盖当前表单，丢弃只清除浏览器内缓存。'
  })
  const draftRestoreButtonText = computed(() => pendingDraft.value?.source === 'server' ? '恢复服务端草稿' : '恢复本地缓存')
  const draftDiscardButtonText = computed(() => pendingDraft.value?.source === 'server' ? '丢弃服务端草稿' : '丢弃缓存')
  const requiresLeaveConfirm = computed(() => articleForm.content.length > 50 || hasLocalDraft.value)
  const selectedRevisionLabel = computed(() => selectedRevision.value ? `版本 ${selectedRevision.value.revisionNo}` : '未选择历史版本')
  const canGeneratePrivatePreview = computed(() => articleForm.title.trim().length > 0 || articleForm.content.trim().length > 0)
  const seoPreview = computed<ArticleSeoPreviewState>(() => {
    const browserOrigin = typeof window !== 'undefined' ? window.location.origin : ''
    const baseUrl = normalizeSeoBaseUrl(siteConfig.value?.baseUrl || browserOrigin)
    const routePath = articleId.value ? `/article/${articleId.value}` : `/article/${slugifyTitle(articleForm.title)}`
    const title = articleForm.title.trim() || '未命名文章'
    const description = (articleForm.summary.trim() || stripMarkdownForSeo(articleForm.content) || siteConfig.value?.description || '').slice(0, 220)
    const ogImage = articleForm.coverImageUrl.trim() || siteConfig.value?.ogImage?.trim() || ''
    return {
      title: siteConfig.value?.title ? `${title} | ${siteConfig.value.title}` : title,
      description,
      canonicalUrl: baseUrl ? `${baseUrl}${routePath}` : routePath,
      slug: routePath,
      ogImage,
      titleLength: title.length,
      descriptionLength: description.length,
      canonicalValid: baseUrl !== null
    }
  })
  const revisionCompareText = computed(() => {
    const revision = selectedRevision.value
    if (!revision) {
      return '选择一个历史版本后，可查看它与当前表单的差异摘要。'
    }

    const changes: string[] = []
    if (revision.title !== articleForm.title) changes.push('标题不同')
    if ((revision.summary ?? '') !== articleForm.summary) changes.push('摘要不同')
    if ((revision.coverImageUrl ?? '') !== articleForm.coverImageUrl) changes.push('头图不同')
    if (revision.categoryId !== (articleForm.categoryId ?? 0)) changes.push('分类不同')
    if (revision.tagIds.join(',') !== articleForm.tagIds.join(',')) changes.push('标签不同')
    if (revision.content !== articleForm.content) {
      const delta = revision.content.length - articleForm.content.length
      changes.push(`正文长度 ${delta >= 0 ? '+' : ''}${delta}`)
    }

    return changes.length > 0 ? changes.join('，') : '当前表单与该历史版本一致。'
  })

  const rules = {
    title: [{ required: true, message: '博文标题是必填项', trigger: 'blur' }],
    content: [
      { required: true, message: '请键入正文内容', trigger: 'blur' },
      { max: 200000, message: '内容长度超出系统限制 (200KB)', trigger: 'blur' }
    ],
    categoryId: [{ required: true, message: '请为文章指定一个分类', trigger: 'change' }]
  }

  const initTask = useAbortableTask()
  const submitTask = useAbortableTask()
  const taxonomyTask = useAbortableTask()
  const previewTask = useAbortableTask()
  const prepublishTask = useAbortableTask()
  const aiAssistTask = useAbortableTask()
  const assetTask = useAbortableTask()
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

  const handleCoverUpload = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    await imageUploadFlow.startUpload({
      files: [files[0]],
      maxFiles: 1,
      messages: {
        tooManyFiles: '一次只能设置一张头图',
        uploadFailed: '头图上传失败',
        uploadSucceeded: '文章头图已更新'
      },
      onSuccess: (urls) => {
        if (urls.length > 0) {
          articleForm.coverImageUrl = urls[0]
        }
      },
      onError: (message) => {
        showErrorToast(message, message)
      }
    })
  }

  const buildSignalConfig = (signal: AbortSignal): ApiRequestConfig => ({ signal })

  let draftSaveTimer: ReturnType<typeof window.setTimeout> | null = null
  let serverDraftRetryTimer: ReturnType<typeof window.setTimeout> | null = null
  let suppressDraftSave = true
  let serverDraftSaveToken = 0

  const clearDraftSaveTimer = (): void => {
    if (draftSaveTimer !== null) {
      window.clearTimeout(draftSaveTimer)
      draftSaveTimer = null
    }
    if (serverDraftRetryTimer !== null) {
      window.clearTimeout(serverDraftRetryTimer)
      serverDraftRetryTimer = null
    }
  }

  const nextClientRevision = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  const buildDraftSnapshot = (source: ArticleDraftSnapshot['source'] = 'local'): ArticleDraftSnapshot => ({
    title: articleForm.title,
    content: articleForm.content,
    summary: articleForm.summary,
    coverImageUrl: articleForm.coverImageUrl,
    categoryId: articleForm.categoryId,
    tagIds: [...articleForm.tagIds],
    status: articleForm.status,
    scheduledPublishAt: articleForm.scheduledPublishAt,
    savedAt: Date.now(),
    sourceArticleId: articleId.value,
    isEdit: isEdit.value,
    source,
    clientRevision: nextClientRevision()
  })

  const buildServerDraftRequest = (snapshot: ArticleDraftSnapshot): ServerDraftSaveRequest => ({
    draftKey: draftKey.value,
    articleId: snapshot.sourceArticleId,
    title: snapshot.title,
    content: snapshot.content,
    summary: snapshot.summary || null,
    coverImageUrl: snapshot.coverImageUrl || null,
    categoryId: snapshot.categoryId ?? 0,
    tagIds: [...snapshot.tagIds],
    clientRevision: snapshot.clientRevision,
    status: snapshot.status,
    scheduledPublishAt: snapshot.status === ArticlePublishStatus.Scheduled && snapshot.scheduledPublishAt
      ? snapshot.scheduledPublishAt
      : null
  })

  const snapshotFromServerDraft = (draft: ServerDraftResponse): ArticleDraftSnapshot => {
    const savedAt = Date.parse(draft.updatedAt)
    return {
      title: draft.title,
      content: draft.content,
      summary: draft.summary ?? '',
      coverImageUrl: draft.coverImageUrl ?? '',
      categoryId: draft.categoryId > 0 ? draft.categoryId : undefined,
      tagIds: Array.isArray(draft.tagIds) ? draft.tagIds.map(Number).filter((item) => Number.isFinite(item)) : [],
      status: normalizeArticlePublishStatus(draft.status),
      scheduledPublishAt: normalizeDateTimeInput(draft.scheduledPublishAt),
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      sourceArticleId: draft.articleId,
      isEdit: draft.articleId !== null,
      source: 'server',
      clientRevision: draft.clientRevision ?? ''
    }
  }

  const saveServerDraftSnapshot = async (snapshot: ArticleDraftSnapshot): Promise<void> => {
    if (serverDraftSyncPaused.value) {
      draftStatusText.value = `本地缓存已保存 ${new Date(snapshot.savedAt).toLocaleTimeString()}，请先处理服务端草稿冲突`
      return
    }

    const token = ++serverDraftSaveToken
    try {
      const saved = await saveServerDraft(buildServerDraftRequest(snapshot))
      if (token !== serverDraftSaveToken) {
        return
      }

      const savedAt = Date.parse(saved.updatedAt)
      draftSavedAt.value = Number.isFinite(savedAt) ? savedAt : snapshot.savedAt
      draftStatusText.value = `服务端草稿已保存 ${new Date(draftSavedAt.value).toLocaleTimeString()}`
    } catch {
      if (token === serverDraftSaveToken) {
        draftStatusText.value = `本地缓存已保存 ${new Date(snapshot.savedAt).toLocaleTimeString()}，服务端草稿暂不可用`
        if (!serverDraftSyncPaused.value && typeof window !== 'undefined') {
          if (serverDraftRetryTimer !== null) {
            window.clearTimeout(serverDraftRetryTimer)
          }
          serverDraftRetryTimer = window.setTimeout(() => {
            serverDraftRetryTimer = null
            void saveServerDraftSnapshot(snapshot)
          }, 1_200)
        }
      }
    }
  }

  const saveDraftNow = (): void => {
    if (suppressDraftSave || !hasDraftContent(articleForm)) {
      return
    }

    const snapshot = buildDraftSnapshot()
    writeDraftSnapshot(draftKey.value, snapshot)
    draftSavedAt.value = snapshot.savedAt
    draftStatusText.value = `本地缓存已保存 ${new Date(snapshot.savedAt).toLocaleTimeString()}`
    void saveServerDraftSnapshot(snapshot)
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
    && draft.coverImageUrl === articleForm.coverImageUrl
    && draft.categoryId === articleForm.categoryId
    && draft.status === articleForm.status
    && draft.scheduledPublishAt === articleForm.scheduledPublishAt
    && draft.tagIds.length === articleForm.tagIds.length
    && draft.tagIds.every((tagId, index) => tagId === articleForm.tagIds[index])

  const readServerDraftSnapshot = async (signal: AbortSignal): Promise<ArticleDraftSnapshot | null> => {
    try {
      const serverDraft = await getServerDraft(draftKey.value, buildSignalConfig(signal))
      return serverDraft ? snapshotFromServerDraft(serverDraft) : null
    } catch {
      return null
    }
  }

  const chooseDraftCandidate = (
    localDraft: ArticleDraftSnapshot | null,
    serverDraft: ArticleDraftSnapshot | null
  ): ArticleDraftSnapshot | null => {
    const validLocal = localDraft && hasDraftContent(localDraft) && !isDraftSameAsForm(localDraft) ? localDraft : null
    const validServer = serverDraft && hasDraftContent(serverDraft) && !isDraftSameAsForm(serverDraft) ? serverDraft : null
    if (validLocal && validServer) {
      const isSameRevisionServerCopyLossy = validLocal.clientRevision.trim().length > 0
        && validLocal.clientRevision === validServer.clientRevision
        && validLocal.content !== validServer.content
        && validLocal.content.length > validServer.content.length
      if (isSameRevisionServerCopyLossy) {
        return validLocal
      }

      return validServer.savedAt >= validLocal.savedAt ? validServer : validLocal
    }

    return validServer ?? validLocal
  }

  const detectDraftCandidates = async (signal: AbortSignal): Promise<void> => {
    const localDraft = readDraftSnapshot(draftKey.value)
    const serverDraft = await readServerDraftSnapshot(signal)
    if (signal.aborted) {
      return
    }

    const draft = chooseDraftCandidate(localDraft, serverDraft)
    if (!draft) {
      pendingDraft.value = null
      draftConflictText.value = ''
      serverDraftSyncPaused.value = false
      draftSavedAt.value = Math.max(localDraft?.savedAt ?? 0, serverDraft?.savedAt ?? 0) || null
      return
    }

    pendingDraft.value = draft
    draftSavedAt.value = draft.savedAt
    const hasConflict = localDraft && serverDraft && !isDraftSameAsForm(localDraft) && !isDraftSameAsForm(serverDraft)
    draftConflictText.value = hasConflict
      ? `同时存在服务端草稿和本地缓存，已优先显示${draft.source === 'server' ? '服务端草稿' : '本地缓存'}；恢复会覆盖当前表单。`
      : ''
    serverDraftSyncPaused.value = draft.source === 'server'
    draftStatusText.value = `发现 ${new Date(draft.savedAt).toLocaleString()} 保存的${draft.source === 'server' ? '服务端草稿' : '本地缓存'}`
  }

  const applyDraftToForm = (draft: ArticleDraftSnapshot): void => {
    suppressDraftSave = true
    articleForm.title = draft.title
    articleForm.content = draft.content
    articleForm.summary = draft.summary
    articleForm.coverImageUrl = draft.coverImageUrl
    articleForm.categoryId = draft.categoryId
    articleForm.tagIds = [...draft.tagIds]
    articleForm.status = draft.status
    articleForm.scheduledPublishAt = draft.scheduledPublishAt
    serverDraftSyncPaused.value = false
    suppressDraftSave = false
  }

  const restoreLocalDraft = (): void => {
    if (!pendingDraft.value) {
      return
    }

    const sourceLabel = pendingDraftSourceLabel.value
    applyDraftToForm(pendingDraft.value)
    pendingDraft.value = null
    draftConflictText.value = ''
    draftStatusText.value = `已恢复${sourceLabel}`
    saveDraftNow()
    toast.success(`已恢复${sourceLabel}`)
  }

  const discardLocalDraft = async (): Promise<void> => {
    const shouldDiscardServerDraft = pendingDraft.value?.source === 'server'
    removeDraftSnapshot(draftKey.value)
    if (shouldDiscardServerDraft) {
      try {
        await discardServerDraft(draftKey.value)
      } catch {
        showWarningToast('服务端草稿删除失败，请稍后重试', '服务端草稿删除失败，请稍后重试')
        return
      }
    }

    pendingDraft.value = null
    draftConflictText.value = ''
    serverDraftSyncPaused.value = false
    draftSavedAt.value = null
    draftStatusText.value = ''
    toast.success(shouldDiscardServerDraft ? '服务端草稿已丢弃' : '本地缓存已丢弃')
  }

  const clearLocalDraft = (): void => {
    clearDraftSaveTimer()
    removeDraftSnapshot(draftKey.value)
    pendingDraft.value = null
    draftConflictText.value = ''
    serverDraftSyncPaused.value = false
    draftSavedAt.value = null
    draftStatusText.value = ''
  }

  const clearDraftAfterSubmit = async (): Promise<void> => {
    clearLocalDraft()
    try {
      await discardServerDraft(draftKey.value)
    } catch {
      // The article mutation already succeeded; stale draft cleanup can be retried by explicit discard.
    }
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

  const refreshSeoConfig = async (signal?: AbortSignal): Promise<void> => {
    try {
      siteConfig.value = await getAdminSiteConfig(signal ? buildSignalConfig(signal) : undefined)
    } catch {
      siteConfig.value = null
      seoStatusText.value = '站点 SEO 配置暂不可用，canonical 使用当前访问域名'
    }
  }

  const refreshAssetLibrary = async (signal?: AbortSignal): Promise<void> => {
    assetLibraryLoading.value = true
    try {
      const assets = await listAssetLibrary(signal ? buildSignalConfig(signal) : undefined)
      if (signal?.aborted) {
        return
      }

      assetLibrary.value = assets
      const orphanCount = assets.filter((asset) => asset.referenceCount === 0).length
      assetLibraryStatusText.value = orphanCount > 0
        ? `已载入 ${assets.length} 项，${orphanCount} 项待清理`
        : `已载入 ${assets.length} 项可复用资产`
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        assetLibraryStatusText.value = '资产库暂不可用'
      }
    } finally {
      assetLibraryLoading.value = false
    }
  }

  const applyArticleDetailToForm = (data: ArticleDetailResponse): void => {
    articleForm.title = data.title || ''
    articleForm.content = data.content || ''
    articleForm.summary = data.summary || ''
    articleForm.coverImageUrl = data.coverImageUrl || ''
    articleForm.categoryId = data.category?.id ? Number(data.category.id) : undefined
    articleForm.tagIds = Array.isArray(data.tags) ? data.tags.map((item) => Number(item.id)) : []
    articleForm.status = normalizeArticlePublishStatus(data.status)
    articleForm.scheduledPublishAt = normalizeDateTimeInput(data.scheduledPublishAt)
  }

  const loadArticleDetailIntoForm = async (signal: AbortSignal): Promise<void> => {
    if (!isEdit.value || articleId.value === null) {
      return
    }

    const data = await getAdminArticleById(articleId.value, buildSignalConfig(signal)) as ArticleDetailResponse
    if (!signal.aborted) {
      applyArticleDetailToForm(data)
    }
  }

  const refreshArticleRevisions = async (signal?: AbortSignal): Promise<void> => {
    if (!isEdit.value || articleId.value === null) {
      articleRevisions.value = []
      selectedRevision.value = null
      revisionStatusText.value = ''
      return
    }

    revisionLoading.value = true
    try {
      const requestConfig = signal ? buildSignalConfig(signal) : undefined
      const revisions = await listArticleRevisions(articleId.value, requestConfig)
      if (signal?.aborted) {
        return
      }

      articleRevisions.value = revisions
      if (selectedRevision.value && !revisions.some((revision) => revision.id === selectedRevision.value?.id)) {
        selectedRevision.value = null
      }
      revisionStatusText.value = revisions.length > 0 ? `已载入 ${revisions.length} 个历史版本` : '暂无修订历史'
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        revisionStatusText.value = '修订历史暂不可用'
      }
    } finally {
      revisionLoading.value = false
    }
  }

  const selectArticleRevision = async (revision: ArticleRevisionSummaryResponse): Promise<void> => {
    if (!isEdit.value || articleId.value === null) {
      return
    }

    revisionLoading.value = true
    try {
      selectedRevision.value = await getArticleRevision(articleId.value, revision.id)
      revisionStatusText.value = `正在比较版本 ${selectedRevision.value.revisionNo}`
    } catch (error: unknown) {
      showErrorToast(error, '历史版本载入失败，请稍后重试')
    } finally {
      revisionLoading.value = false
    }
  }

  const rollbackSelectedRevision = async (): Promise<void> => {
    if (!selectedRevision.value || articleId.value === null) {
      return
    }

    revisionRollbacking.value = true
    try {
      const revisionNo = selectedRevision.value.revisionNo
      const rolledBack = await rollbackArticleRevision(articleId.value, selectedRevision.value.id)
      if (!rolledBack) {
        showWarningToast('历史版本不存在或已被清理', '历史版本不存在或已被清理')
        return
      }

      suppressDraftSave = true
      clearLocalDraft()
      try {
        await discardServerDraft(draftKey.value)
      } catch {
        // Rollback already persisted the article; stale draft cleanup is best-effort.
      }

      await loadArticleDetailIntoForm(new AbortController().signal)
      await refreshArticleRevisions()
      selectedRevision.value = null
      revisionStatusText.value = `已回滚到版本 ${revisionNo}`
      toast.success(`已回滚到版本 ${revisionNo}`)
    } catch (error: unknown) {
      showErrorToast(error, '历史版本回滚失败，请稍后重试')
    } finally {
      suppressDraftSave = false
      revisionRollbacking.value = false
    }
  }

  const generatePrivatePreview = async (): Promise<void> => {
    if (!canGeneratePrivatePreview.value) {
      showWarningToast('请先填写标题或正文', '请先填写标题或正文')
      return
    }

    privatePreviewLoading.value = true
    try {
      await previewTask.run(async (signal) => {
        const snapshot = buildDraftSnapshot('server')
        const preview = await previewArticleDraft(buildServerDraftRequest(snapshot), buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        privatePreview.value = preview
        const errorCount = preview.issues.filter((issue) => issue.severity.toLowerCase() === 'error').length
        privatePreviewStatusText.value = errorCount > 0
          ? `已生成预览，存在 ${errorCount} 个发布阻断项`
          : `已生成预览，正文 ${preview.plainText.length} 字符`
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '私有预览生成失败，请稍后重试')
        privatePreviewStatusText.value = '私有预览暂不可用'
      }
    } finally {
      privatePreviewLoading.value = false
    }
  }

  const buildLocalSeoIssues = (): PrepublishIssue[] => {
    if (seoPreview.value.canonicalValid) {
      return []
    }

    return [{
      severity: 'error',
      code: 'canonical_invalid',
      message: '站点 Base URL 无法生成 canonical。'
    }]
  }

  const prepublishErrorIssues = computed(() => seoIssues.value
    .filter((issue) => issue.severity.toLowerCase() === 'error'))
  const prepublishWarningIssues = computed(() => seoIssues.value
    .filter((issue) => issue.severity.toLowerCase() === 'warning'))
  const prepublishWarningsNeedOverride = computed(() =>
    (articleForm.status === ArticlePublishStatus.Published || articleForm.status === ArticlePublishStatus.Scheduled)
    && prepublishErrorIssues.value.length === 0
    && prepublishWarningIssues.value.length > 0)

  const refreshPrepublishCheck = async (warningOverrideReason?: string): Promise<boolean> => {
    seoChecking.value = true
    try {
      let canPublish = true
      await prepublishTask.run(async (signal) => {
        const snapshot = buildDraftSnapshot('server')
        const request = {
          ...buildServerDraftRequest(snapshot),
          warningOverrideReason: warningOverrideReason?.trim() || null
        }
        const result = await checkArticlePrepublish(request, buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        const issues = [...result.issues, ...buildLocalSeoIssues()]
        const errorCount = issues.filter((issue) => issue.severity.toLowerCase() === 'error').length
        const warningCount = issues.filter((issue) => issue.severity.toLowerCase() === 'warning').length
        seoIssues.value = issues
        canPublish = result.canPublish && errorCount === 0
        seoStatusText.value = errorCount > 0
          ? `发现 ${errorCount} 个发布阻断项`
          : warningCount > 0
            ? `发现 ${warningCount} 个发布提醒项`
            : '发布前检查通过'
      })
      return canPublish
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '发布前检查失败，请稍后重试')
        seoStatusText.value = '发布前检查暂不可用'
      }
      return false
    } finally {
      seoChecking.value = false
    }
  }

  const confirmPrepublishWarningOverride = async (): Promise<boolean> => {
    if (!prepublishWarningsNeedOverride.value) {
      return true
    }

    const reason = prepublishWarningOverrideReason.value.trim()
    if (reason.length < 8) {
      showWarningToast('请填写至少 8 个字符的发布警告跳过理由', '请填写至少 8 个字符的发布警告跳过理由')
      return false
    }

    const ready = await refreshPrepublishCheck(reason)
    if (!ready || prepublishErrorIssues.value.length > 0) {
      showWarningToast('存在发布阻断项，请先处理发布前检查结果', '存在发布阻断项，请先处理发布前检查结果')
      return false
    }

    toast.success('发布警告跳过理由已记录')
    return true
  }

  const reindexCurrentArticleAssets = async (): Promise<void> => {
    if (!isEdit.value || articleId.value === null) {
      showWarningToast('新文章发布后才能重建资产索引', '新文章发布后才能重建资产索引')
      return
    }

    assetLibraryLoading.value = true
    try {
      await assetTask.run(async (signal) => {
        const assets = await reindexArticleAssets(articleId.value!, buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        assetLibrary.value = assets
        assetLibraryStatusText.value = `资产库已重建，当前 ${assets.length} 项`
        toast.success('资产库已重建')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '资产索引重建失败，请稍后重试')
      }
    } finally {
      assetLibraryLoading.value = false
    }
  }

  const cleanupAssetOrphans = async (): Promise<void> => {
    assetLibraryLoading.value = true
    try {
      await assetTask.run(async (signal) => {
        const deleted = await cleanupOrphanAssets(buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        await refreshAssetLibrary(signal)
        toast.success(`已清理 ${deleted} 个孤儿资产`)
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '孤儿资产清理失败，请稍后重试')
      }
    } finally {
      assetLibraryLoading.value = false
    }
  }

  const insertAssetIntoContent = (asset: AssetLibraryItemResponse, insertAtCursor?: (markdown: string) => boolean): void => {
    if (!asset.url || asset.referenceCount === 0) {
      return
    }

    const alt = asset.altText?.trim() || 'image'
    const markdown = `![${alt}](${asset.url})`
    if (insertAtCursor?.(`\n${markdown}\n`) === true) {
      toast.success('资产已插入光标位置')
      saveDraftNow()
      return
    }

    articleForm.content = articleForm.content.trim().length > 0
      ? `${articleForm.content.trimEnd()}\n\n${markdown}\n`
      : `${markdown}\n`
    toast.success('资产已插入正文')
    saveDraftNow()
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

  const initData = async () => {
    pageLoading.value = true
    try {
      await initTask.run(async (signal) => {
        await Promise.all([
          refreshTaxonomy(signal),
          refreshSeoConfig(signal)
        ])

        if (signal.aborted) {
          return
        }

        if (isEdit.value && articleId.value !== null) {
          try {
            await loadArticleDetailIntoForm(signal)
          } catch (error: unknown) {
            if (isAbortError(error) || signal.aborted) {
              return
            }
          }

          if (signal.aborted) {
            return
          }
        }

        await detectDraftCandidates(signal)
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast('无法同步远程配置资源', '无法同步远程配置资源')
        console.error('[Write Init Error]', error)
      }
    } finally {
      suppressDraftSave = false
      pageLoading.value = false
    }
  }

  const validateBeforeSubmit = async (): Promise<boolean> => {
    if (!formRef.value || submitting.value) {
      return false
    }

    const validation = await formRef.value.validate()
    if (!isFsusUiOk(validation)) {
      return false
    }

    if (articleForm.status === ArticlePublishStatus.Published || articleForm.status === ArticlePublishStatus.Scheduled) {
      const ready = await refreshPrepublishCheck()
      if (!ready) {
        showWarningToast('存在发布阻断项，请先处理发布前检查结果', '存在发布阻断项，请先处理发布前检查结果')
        return false
      }
      if (!prepublishWarningsNeedOverride.value) {
        prepublishWarningOverrideReason.value = ''
      }
    }
    return true
  }

  const validatePublishState = (): boolean => {
    if (articleForm.status !== ArticlePublishStatus.Scheduled) {
      return true
    }

    const scheduledTime = Date.parse(articleForm.scheduledPublishAt)
    if (!Number.isFinite(scheduledTime) || scheduledTime <= Date.now()) {
      showWarningToast('定时发布时间必须晚于当前时间', '定时发布时间必须晚于当前时间')
      return false
    }

    return true
  }

  const submitForm = async () => {
    if (!validatePublishState()) {
      return
    }

    try {
      submitting.value = true
      await submitTask.run(async (signal) => {
        const config: ApiRequestConfig = { signal }
        const articlePayload: ArticleWriteRequest = {
          title: articleForm.title,
          content: articleForm.content,
          summary: articleForm.summary,
          coverImageUrl: articleForm.coverImageUrl,
          categoryId: articleForm.categoryId,
          tagIds: [...articleForm.tagIds],
          status: articleForm.status,
          scheduledPublishAt: articleForm.status === ArticlePublishStatus.Scheduled ? articleForm.scheduledPublishAt : null
        }

        let targetArticleId: number | null = null
        const successMessage = buildSubmitSuccessMessage(isEdit.value, articleForm.status)

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

        toast.success(successMessage)

        suppressDraftSave = true
        await clearDraftAfterSubmit()
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

  const requestAiAssist = async () => {
    if (!articleForm.title.trim() && !articleForm.content.trim()) {
      showWarningToast('请先填写标题或正文', '请先填写标题或正文')
      return
    }

    aiAssistLoading.value = true
    aiAssistStatusText.value = '正在生成作者辅助建议'
    try {
      await aiAssistTask.run(async (signal) => {
        const response = await generateAiAssist({
          title: articleForm.title,
          content: articleForm.content,
          locale: typeof navigator === 'undefined' ? null : navigator.language,
          operation: 'summary-tags-title-structure-translate'
        }, buildSignalConfig(signal))
        aiAssist.value = response
        aiAssistStatusText.value = response.externalProviderAllowed
          ? `已生成建议，provider=${response.providerMode}`
          : `已生成本地建议，provider=${response.providerMode}`
        if (!articleForm.summary.trim() && response.suggestedSummary.trim()) {
          articleForm.summary = response.suggestedSummary.trim()
        }
        toast.success('作者辅助建议已生成')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        showErrorToast(error, '作者辅助建议生成失败')
      }
    } finally {
      aiAssistLoading.value = false
    }
  }

  const applyAiSummary = () => {
    const summary = aiAssist.value?.suggestedSummary?.trim()
    if (!summary) {
      return
    }

    articleForm.summary = summary
    toast.success('已采用摘要建议')
  }

  const applyAiTitleCandidate = (title: string) => {
    const normalized = title.trim()
    if (!normalized) {
      return
    }

    articleForm.title = normalized.slice(0, 100)
    toast.success('已采用标题候选')
  }

  const applyAiSuggestedTags = () => {
    const suggestions = new Set((aiAssist.value?.suggestedTags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))
    if (suggestions.size === 0) {
      return
    }

    const matchedIds = tags.value
      .filter((tag) => suggestions.has(tag.name.trim().toLowerCase()))
      .map((tag) => tag.id)
    if (matchedIds.length === 0) {
      showWarningToast('建议标签尚未存在，请先新建标签', '建议标签尚未存在，请先新建标签')
      return
    }

    articleForm.tagIds = [...new Set([...articleForm.tagIds, ...matchedIds])]
    toast.success('已关联已有建议标签')
  }

  const applyAiTranslationDraft = () => {
    const translation = aiAssist.value?.translationDraft?.trim()
    if (!translation) {
      return
    }

    articleForm.content = translation
    toast.success('已采用翻译草稿')
  }

  const leaveEditor = () => {
    void router.back()
  }

  watch(
    () => articleForm.status,
    (status) => {
      if (status !== ArticlePublishStatus.Scheduled) {
        articleForm.scheduledPublishAt = ''
      }
    }
  )

  watch(
    () => ({
      title: articleForm.title,
      content: articleForm.content,
      summary: articleForm.summary,
      coverImageUrl: articleForm.coverImageUrl,
      categoryId: articleForm.categoryId,
      tagIds: [...articleForm.tagIds],
      status: articleForm.status,
      scheduledPublishAt: articleForm.scheduledPublishAt
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
    previewTask.cancel()
    prepublishTask.cancel()
    aiAssistTask.cancel()
    assetTask.cancel()
    imageUploadFlow.cancel()
    clearDraftSaveTimer()
    articleForm.title = ''
    articleForm.content = ''
    articleForm.summary = ''
  })

  return {
    formRef,
    pageLoading,
    submitting,
    categories,
    tags,
    assetLibrary,
    assetLibraryLoading,
    assetLibraryStatusText,
    isEdit,
    submitButtonText,
    submitConfirmContent,
    requiresLeaveConfirm,
    pendingDraft,
    draftStatusText,
    pendingDraftSourceLabel,
    pendingDraftDescription,
    draftRestoreButtonText,
    draftDiscardButtonText,
    hasLocalDraft,
    articleRevisions,
    selectedRevision,
    selectedRevisionLabel,
    revisionLoading,
    revisionRollbacking,
    revisionStatusText,
    revisionCompareText,
    privatePreview,
    privatePreviewLoading,
    privatePreviewStatusText,
    canGeneratePrivatePreview,
    aiAssist,
    aiAssistLoading,
    aiAssistStatusText,
    seoPreview,
    seoIssues,
    prepublishWarningIssues,
    prepublishWarningsNeedOverride,
    prepublishWarningOverrideReason,
    seoChecking,
    seoStatusText,
    articleForm,
    rules,
    validateBeforeSubmit,
    saveDraftNow,
    handleUploadImg,
    handleCoverUpload,
    submitForm,
    restoreLocalDraft,
    discardLocalDraft,
    refreshArticleRevisions,
    selectArticleRevision,
    rollbackSelectedRevision,
    generatePrivatePreview,
    requestAiAssist,
    applyAiSummary,
    applyAiTitleCandidate,
    applyAiSuggestedTags,
    applyAiTranslationDraft,
    refreshPrepublishCheck,
    confirmPrepublishWarningOverride,
    refreshAssetLibrary,
    reindexCurrentArticleAssets,
    cleanupAssetOrphans,
    insertAssetIntoContent,
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
