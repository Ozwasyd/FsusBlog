import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type FormInstance } from '@ozwasyd/element-plus'
import { isFsusUiOk } from '@/fsusui/result'
import {
  getAdminArticleById,
  createArticle,
  updateArticle,
  ArticlePublishStatus,
  type ArticleDetailResponse,
  type ArticleRightsRequest,
  type ArticleRightsResponse,
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
import { getAdminSiteComplianceConfig, getAdminSiteConfig, type SeoConfigAdmin, type SiteComplianceConfigAdmin } from '@/api/system'
import { createTag, getTags, type TagItem } from '@/api/tag'
import { useAbortableTask } from '@/composables/useAbortableTask'
import type { ApiRequestConfig } from '@/api/requestConfig'
import { isAbortError } from '@/utils/errors'
import { toast } from '@/fsusui/feedback'
import { showErrorToast, showWarningToast } from '@/utils/errorPresentation'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { useImageUploadRuntime } from '@/composables/useImageUploadRuntime'
import { useImageUploadFlow } from '@/composables/useImageUploadFlow'
import { useAdminTaskFeedback } from '@/composables/useAdminTaskFeedback'
import { ensureAdminSensitiveProof } from '@/composables/useAdminSensitiveProof'
import { usePow } from '@/composables/usePow'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'
import { BinaryTransportError } from '@/composition/binaryTransport'

interface ArticleParams {
  title: string
  content: string
  summary: string
  coverImageUrl: string
  categoryId: number | undefined
  tagIds: number[]
  status: ArticlePublishStatus
  scheduledPublishAt: string
  rights: ArticleRightsForm
}

interface ArticleDraftSnapshot extends ArticleParams {
  savedAt: number
  sourceArticleId: number | null
  baseRevisionId: string | null
  isEdit: boolean
  source: 'local' | 'server'
  clientRevision: string
  serverRevision: number | null
}

export interface LocalDraftMetadataSource {
  savedAt: number
  sourceArticleId: number | null
  isEdit: boolean
  clientRevision: string
}

export interface LocalDraftMetadata extends LocalDraftMetadataSource {
  schema: 'fsusblog.article-draft-metadata.v1'
  source: 'local'
}

export interface ArticleRevisionConflictMetadata {
  currentRevisionId: string
  revisionNo: number
  status: number
  updatedAt: string
}

export const parseArticleRevisionConflictDetails = (details?: string | null): ArticleRevisionConflictMetadata | null => {
  if (!details) {
    return null
  }

  try {
    const value = JSON.parse(details) as Partial<ArticleRevisionConflictMetadata>
    if (typeof value.currentRevisionId !== 'string'
      || !/^\d+$/.test(value.currentRevisionId)
      || !Number.isInteger(value.revisionNo)
      || !Number.isInteger(value.status)
      || typeof value.updatedAt !== 'string') {
      return null
    }
    return value as ArticleRevisionConflictMetadata
  } catch {
    return null
  }
}

export interface ServerDraftConflictMetadata {
  currentServerRevision: number | null
  currentUpdatedAt: string | null
  titleSummary: string | null
}

export const parseServerDraftConflictDetails = (details?: string | null): ServerDraftConflictMetadata | null => {
  if (!details) {
    return null
  }

  try {
    const value = JSON.parse(details) as Partial<ServerDraftConflictMetadata>
    if (value.currentServerRevision !== null
      && (!Number.isSafeInteger(value.currentServerRevision) || Number(value.currentServerRevision) < 1)) {
      return null
    }
    if (value.currentUpdatedAt !== null && typeof value.currentUpdatedAt !== 'string') {
      return null
    }
    if (value.titleSummary !== null && typeof value.titleSummary !== 'string') {
      return null
    }
    return {
      currentServerRevision: value.currentServerRevision ?? null,
      currentUpdatedAt: value.currentUpdatedAt ?? null,
      titleSummary: value.titleSummary ?? null
    }
  } catch {
    return null
  }
}

export const shouldRetryServerDraftSave = (error: unknown): boolean =>
  !(error instanceof BinaryTransportError && error.message === 'draft_conflict')

export interface LocalDraftRecovery<TDraft> {
  draft: TDraft | null
  savedAt: number | null
  hasLocalMetadataWithoutRestorableDraft: boolean
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

interface ArticleRightsForm {
  mode: 'site' | 'custom'
  enabled: boolean
  licenseType: string
  copyrightHolder: string
  copyrightYear: number | null
  rightsStatement: string
  attributionTemplate: string
  copyPolicy: string
  maxExcerptChars: number
  allowCodeCopy: boolean
  showPublicBadge: boolean
  proofBindingEnabled: boolean
}

const CREATE_DRAFT_KEY = 'fsus:article-draft:create'
const EDIT_DRAFT_PREFIX = 'fsus:article-draft:edit:'
const DRAFT_SAVE_DELAY_MS = 700
const LOCAL_DRAFT_METADATA_KEYS = new Set([
  'schema',
  'savedAt',
  'sourceArticleId',
  'isEdit',
  'source',
  'clientRevision'
])
const ARTICLE_RIGHTS_LICENSE_TYPES = [
  'all-rights-reserved',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC0-1.0'
] as const
const ARTICLE_RIGHTS_COPY_POLICIES = [
  'append-attribution',
  'excerpt-only',
  'disabled'
] as const
const ARTICLE_RIGHTS_EXCERPT_MAX = 10_000

const articleRightsLicenseOptions = [
  { label: '保留所有权利', value: 'all-rights-reserved' },
  { label: 'CC BY 4.0', value: 'CC-BY-4.0' },
  { label: 'CC BY-SA 4.0', value: 'CC-BY-SA-4.0' },
  { label: 'CC BY-NC 4.0', value: 'CC-BY-NC-4.0' },
  { label: 'CC0 1.0', value: 'CC0-1.0' }
] as const

const articleRightsCopyPolicyOptions = [
  { label: '复制时追加署名', value: 'append-attribution' },
  { label: '仅允许摘录复制', value: 'excerpt-only' },
  { label: '禁用复制增强', value: 'disabled' }
] as const

const resolveLicenseTypeFromCompliance = (compliance: SiteComplianceConfigAdmin | null): string => {
  const licenseText = `${compliance?.contentLicenseName ?? ''} ${compliance?.contentLicenseUrl ?? ''}`.toLowerCase()
  if (licenseText.includes('cc0')) return 'CC0-1.0'
  if (licenseText.includes('by-sa')) return 'CC-BY-SA-4.0'
  if (licenseText.includes('by-nc')) return 'CC-BY-NC-4.0'
  if (licenseText.includes('cc-by') || licenseText.includes('/by/')) return 'CC-BY-4.0'
  return 'all-rights-reserved'
}

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

const createDefaultArticleRightsForm = (mode: ArticleRightsForm['mode'] = 'site'): ArticleRightsForm => ({
  mode,
  enabled: true,
  licenseType: 'all-rights-reserved',
  copyrightHolder: '',
  copyrightYear: null,
  rightsStatement: '',
  attributionTemplate: '',
  copyPolicy: 'append-attribution',
  maxExcerptChars: 300,
  allowCodeCopy: true,
  showPublicBadge: true,
  proofBindingEnabled: true
})

const normalizeOptionalRightsText = (value: unknown): string => typeof value === 'string' ? value : ''

const normalizeNullableRightsYear = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }

  const year = Number(value)
  return Number.isInteger(year) ? year : null
}

const normalizeArticleRightsForm = (value: unknown): ArticleRightsForm => {
  const defaults = createDefaultArticleRightsForm()
  if (typeof value !== 'object' || value === null) {
    return defaults
  }

  const raw = value as Partial<ArticleRightsForm & ArticleRightsRequest & ArticleRightsResponse>
  const maxExcerptChars = typeof raw.maxExcerptChars === 'number' && Number.isFinite(raw.maxExcerptChars)
    ? Math.trunc(raw.maxExcerptChars)
    : defaults.maxExcerptChars

  return {
    mode: raw.mode === 'custom' ? 'custom' : raw.mode === 'site' ? 'site' : defaults.mode,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    licenseType: normalizeOptionalRightsText(raw.licenseType) || defaults.licenseType,
    copyrightHolder: normalizeOptionalRightsText(raw.copyrightHolder),
    copyrightYear: normalizeNullableRightsYear(raw.copyrightYear),
    rightsStatement: normalizeOptionalRightsText(raw.rightsStatement),
    attributionTemplate: normalizeOptionalRightsText(raw.attributionTemplate),
    copyPolicy: normalizeOptionalRightsText(raw.copyPolicy) || defaults.copyPolicy,
    maxExcerptChars,
    allowCodeCopy: typeof raw.allowCodeCopy === 'boolean' ? raw.allowCodeCopy : defaults.allowCodeCopy,
    showPublicBadge: typeof raw.showPublicBadge === 'boolean' ? raw.showPublicBadge : defaults.showPublicBadge,
    proofBindingEnabled: typeof raw.proofBindingEnabled === 'boolean' ? raw.proofBindingEnabled : defaults.proofBindingEnabled
  }
}

const hasNonDefaultArticleRights = (rights: ArticleRightsForm): boolean => {
  if (rights.mode === 'site') {
    return false
  }

  const defaults = createDefaultArticleRightsForm('custom')
  return Object.keys(defaults).some((key) => rights[key as keyof ArticleRightsForm] !== defaults[key as keyof ArticleRightsForm])
}

const areArticleRightsSame = (left: ArticleRightsForm, right: ArticleRightsForm): boolean =>
  left.mode === right.mode
  && left.enabled === right.enabled
  && left.licenseType === right.licenseType
  && left.copyrightHolder === right.copyrightHolder
  && left.copyrightYear === right.copyrightYear
  && left.rightsStatement === right.rightsStatement
  && left.attributionTemplate === right.attributionTemplate
  && left.copyPolicy === right.copyPolicy
  && left.maxExcerptChars === right.maxExcerptChars
  && left.allowCodeCopy === right.allowCodeCopy
  && left.showPublicBadge === right.showPublicBadge
  && left.proofBindingEnabled === right.proofBindingEnabled

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

const hasDraftContent = (draft: Pick<ArticleParams, 'title' | 'content' | 'summary' | 'categoryId' | 'tagIds' | 'rights'>): boolean =>
  draft.title.trim().length > 0
  || draft.content.trim().length > 0
  || draft.summary.trim().length > 0
  || draft.categoryId !== undefined
  || draft.tagIds.length > 0
  || hasNonDefaultArticleRights(draft.rights)

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

export const normalizeLocalDraftMetadata = (value: unknown): LocalDraftMetadata | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }

  const raw = value as Partial<LocalDraftMetadata>
  if (Object.keys(raw).some((key) => !LOCAL_DRAFT_METADATA_KEYS.has(key))
      || raw.schema !== 'fsusblog.article-draft-metadata.v1'
      || raw.source !== 'local'
      || typeof raw.savedAt !== 'number'
      || !Number.isFinite(raw.savedAt)
      || typeof raw.isEdit !== 'boolean'
      || typeof raw.clientRevision !== 'string'
      || (raw.sourceArticleId !== null
        && (typeof raw.sourceArticleId !== 'number' || !Number.isFinite(raw.sourceArticleId)))) {
    return null
  }

  return {
    schema: 'fsusblog.article-draft-metadata.v1',
    savedAt: raw.savedAt,
    sourceArticleId: raw.sourceArticleId,
    isEdit: raw.isEdit,
    source: 'local',
    clientRevision: raw.clientRevision
  }
}

export const toLocalDraftMetadata = (snapshot: LocalDraftMetadataSource): LocalDraftMetadata => ({
  schema: 'fsusblog.article-draft-metadata.v1',
  savedAt: snapshot.savedAt,
  sourceArticleId: snapshot.sourceArticleId,
  isEdit: snapshot.isEdit,
  source: 'local',
  clientRevision: snapshot.clientRevision
})

export const encodeLocalDraftMetadata = (snapshot: LocalDraftMetadataSource): string =>
  encodePublicAotPayload(toLocalDraftMetadata(snapshot))

export const decodeLocalDraftMetadata = (encoded: string): LocalDraftMetadata | null =>
  normalizeLocalDraftMetadata(decodePublicAotPayload(encoded))

export function resolveLocalDraftRecovery<TDraft extends { savedAt: number }>(
  localMetadata: LocalDraftMetadata | null,
  serverDraft: TDraft | null,
  isServerDraftRestorable: (draft: TDraft) => boolean
): LocalDraftRecovery<TDraft> {
  const draft = serverDraft && isServerDraftRestorable(serverDraft) ? serverDraft : null
  return {
    draft,
    savedAt: Math.max(localMetadata?.savedAt ?? 0, serverDraft?.savedAt ?? 0) || null,
    hasLocalMetadataWithoutRestorableDraft: localMetadata !== null && draft === null
  }
}

const readDraftMetadata = (key: string): LocalDraftMetadata | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return null
    }

    const parsed = decodeLocalDraftMetadata(raw)
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

const writeLocalDraftMetadata = (key: string, snapshot: ArticleDraftSnapshot): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, encodeLocalDraftMetadata(snapshot))
  } catch {
    // Local draft metadata is best-effort and must never block editing.
  }
}

const removeLocalDraftMetadata = (key: string): void => {
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
  const powProvider = usePow()
  const formRef = useTemplateRef<FormInstance>('formRef')
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
  const siteComplianceConfig = ref<SiteComplianceConfigAdmin | null>(null)
  const mountedBrowserSeoBaseUrl = ref('')
  const assetLibrary = shallowRef<AssetLibraryItemResponse[]>([])
  const assetLibraryLoading = ref(false)
  const assetLibraryStatusText = ref('资产库等待同步')
  const draftStatusText = ref('')
  const pendingDraft = ref<ArticleDraftSnapshot | null>(null)
  const draftSavedAt = ref<number | null>(null)
  const draftConflictText = ref('')
  const currentRevisionId = ref<string | null>(null)
  const currentRevisionNo = ref<number | null>(null)
  const serverDraftRevision = ref<number | null>(null)
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
    scheduledPublishAt: '',
    rights: createDefaultArticleRightsForm()
  })
  const siteInheritedRights = computed<ArticleRightsForm>(() => {
    const compliance = siteComplianceConfig.value
    return {
      ...createDefaultArticleRightsForm('site'),
      copyrightHolder: compliance?.copyrightOwner?.trim() || siteConfig.value?.title?.trim() || '',
      copyrightYear: compliance?.copyrightStartYear ?? null,
      rightsStatement: compliance?.copyrightText?.trim() || '',
      attributionTemplate: compliance?.contentLicenseName?.trim() || '',
      licenseType: resolveLicenseTypeFromCompliance(compliance)
    }
  })
  const articleRightsUsingSiteDefaults = computed(() => articleForm.rights.mode === 'site')
  const articleRightsInheritanceText = computed(() => {
    const inherited = siteInheritedRights.value
    const holder = inherited.copyrightHolder || '未设置版权主体'
    const year = inherited.copyrightYear ? `${inherited.copyrightYear} 年起` : '按站点年份'
    const statement = inherited.rightsStatement || '保留所有权利。'
    return articleRightsUsingSiteDefaults.value
      ? `当前继承：${holder}，${year}，${statement}`
      : `自定义本文版权；可从站点默认值继续调整。`
  })
  const submitButtonText = computed(() => {
    if (articleForm.status === ArticlePublishStatus.Draft) return '保存草稿'
    if (articleForm.status === ArticlePublishStatus.Scheduled) return '定时发布'
    if (articleForm.status === ArticlePublishStatus.Archived) return '保存为归档'
    return isEdit.value ? '更新文章' : '发布文章'
  })
  const submitConfirmContent = computed(() => {
    if (articleForm.status === ArticlePublishStatus.Draft) return '保存后文章保持草稿状态，不会出现在公开阅读页。'
    if (articleForm.status === ArticlePublishStatus.Scheduled) return '到达所选时间后文章会自动公开，提交前请检查时间与 SEO 摘要。'
    if (articleForm.status === ArticlePublishStatus.Archived) return '保存后文章进入归档隐藏状态，不会出现在公开阅读页。'
    return isEdit.value ? '更新后会生成新的文章版本并刷新公开缓存。' : '发布后文章会进入公开阅读页并同步搜索索引。'
  })
  const draftKey = computed(() => (isEdit.value && articleId.value !== null ? `${EDIT_DRAFT_PREFIX}${articleId.value}` : CREATE_DRAFT_KEY))
  const hasLocalDraft = computed(() => pendingDraft.value !== null)
  const pendingDraftSourceLabel = computed(() => '服务端草稿')
  const pendingDraftDescription = computed(() => {
    if (draftConflictText.value) {
      return draftConflictText.value
    }

    return '恢复会覆盖当前表单，丢弃会删除服务端草稿与浏览器中的保存记录。'
  })
  const draftRestoreButtonText = computed(() => '恢复服务端草稿')
  const draftDiscardButtonText = computed(() => '丢弃服务端草稿')
  const requiresLeaveConfirm = computed(() => hasDraftContent(articleForm) || hasLocalDraft.value)
  const selectedRevisionLabel = computed(() => selectedRevision.value ? `版本 ${selectedRevision.value.revisionNo}` : '未选择历史版本')
  const canGeneratePrivatePreview = computed(() => articleForm.title.trim().length > 0 || articleForm.content.trim().length > 0)
  const seoPreview = computed<ArticleSeoPreviewState>(() => {
    const baseUrl = normalizeSeoBaseUrl(siteConfig.value?.baseUrl || mountedBrowserSeoBaseUrl.value)
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
  const taskFeedback = useAdminTaskFeedback()
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
    taskFeedback.begin('正在上传文章头图', `待同步 ${files.length} 个文件`, 'article-cover')
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
          taskFeedback.succeed('文章头图已更新', '头图已进入待保存配置', 'article-cover')
        }
      },
      onError: (message) => {
        taskFeedback.fail('文章头图上传失败', message, message, 'article-cover')
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
    rights: { ...articleForm.rights },
    savedAt: Date.now(),
    sourceArticleId: articleId.value,
    baseRevisionId: isEdit.value ? currentRevisionId.value : null,
    isEdit: isEdit.value,
    source,
    clientRevision: nextClientRevision(),
    serverRevision: serverDraftRevision.value
  })

  const buildServerDraftRequest = (snapshot: ArticleDraftSnapshot): ServerDraftSaveRequest => ({
    draftKey: draftKey.value,
    articleId: snapshot.sourceArticleId,
    baseRevisionId: snapshot.baseRevisionId,
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
      : null,
    rights: { ...snapshot.rights },
    expectedServerRevision: snapshot.serverRevision
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
      rights: normalizeArticleRightsForm(draft.rights),
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      sourceArticleId: draft.articleId,
      baseRevisionId: draft.baseRevisionId,
      isEdit: draft.articleId !== null,
      source: 'server',
      clientRevision: draft.clientRevision ?? '',
      serverRevision: draft.serverRevision
    }
  }

  const saveServerDraftSnapshot = async (snapshot: ArticleDraftSnapshot): Promise<void> => {
    if (serverDraftSyncPaused.value) {
      draftStatusText.value = '当前更改尚未同步，请先处理已有服务端草稿'
      return
    }

    const token = ++serverDraftSaveToken
    try {
      const saved = await saveServerDraft(buildServerDraftRequest(snapshot))
      if (token !== serverDraftSaveToken) {
        return
      }

      const savedAt = Date.parse(saved.updatedAt)
      serverDraftRevision.value = saved.serverRevision
      draftSavedAt.value = Number.isFinite(savedAt) ? savedAt : snapshot.savedAt
      draftStatusText.value = `服务端草稿已保存 ${new Date(draftSavedAt.value).toLocaleTimeString()}`
    } catch (error: unknown) {
      if (token === serverDraftSaveToken) {
        if (!shouldRetryServerDraftSave(error)) {
          clearDraftSaveTimer()
          const details = parseServerDraftConflictDetails(error.details)
          serverDraftSyncPaused.value = true
          draftConflictText.value = details?.currentUpdatedAt
            ? `服务端已有版本 ${details.currentServerRevision ?? '未知'}（${new Date(details.currentUpdatedAt).toLocaleString()}），当前页面更改未覆盖它。请比较后选择恢复或丢弃。`
            : '服务端草稿已变化，当前页面更改未覆盖它。请重新载入并比较。'
          draftStatusText.value = '自动保存已暂停'
          try {
            const current = await getServerDraft(draftKey.value)
            pendingDraft.value = current ? snapshotFromServerDraft(current) : null
          } catch {
            pendingDraft.value = null
          }
          return
        }

        draftStatusText.value = '服务端草稿暂不可用；当前页面仍保留更改，请勿关闭'
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
    writeLocalDraftMetadata(draftKey.value, snapshot)
    draftSavedAt.value = snapshot.savedAt
    draftStatusText.value = '正在保存服务端草稿…'
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
    && areArticleRightsSame(draft.rights, articleForm.rights)

  const readServerDraftSnapshot = async (signal: AbortSignal): Promise<ArticleDraftSnapshot | null> => {
    try {
      const serverDraft = await getServerDraft(draftKey.value, buildSignalConfig(signal))
      return serverDraft ? snapshotFromServerDraft(serverDraft) : null
    } catch {
      return null
    }
  }

  const detectDraftCandidates = async (signal: AbortSignal): Promise<void> => {
    const localMetadata = readDraftMetadata(draftKey.value)
    const serverDraft = await readServerDraftSnapshot(signal)
    if (signal.aborted) {
      return
    }
    serverDraftRevision.value = serverDraft?.serverRevision ?? null

    const recovery = resolveLocalDraftRecovery(
      localMetadata,
      serverDraft,
      (candidate) => hasDraftContent(candidate) && !isDraftSameAsForm(candidate)
    )
    const draft = recovery.draft
    if (!draft) {
      pendingDraft.value = null
      draftConflictText.value = ''
      serverDraftSyncPaused.value = false
      draftSavedAt.value = recovery.savedAt
      if (recovery.hasLocalMetadataWithoutRestorableDraft) {
        draftStatusText.value = '未找到可恢复的服务端草稿；浏览器只保留了保存时间记录'
      }
      return
    }

    pendingDraft.value = draft
    serverDraftRevision.value = draft.serverRevision
    draftSavedAt.value = draft.savedAt
    draftConflictText.value = ''
    serverDraftSyncPaused.value = draft.source === 'server'
    draftStatusText.value = `发现 ${new Date(draft.savedAt).toLocaleString()} 保存的服务端草稿`
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
    articleForm.rights = { ...draft.rights }
    serverDraftRevision.value = draft.serverRevision
    if (draft.isEdit) {
      currentRevisionId.value = draft.baseRevisionId
    }
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
    removeLocalDraftMetadata(draftKey.value)
    if (shouldDiscardServerDraft) {
      try {
        const expectedServerRevision = pendingDraft.value?.serverRevision
        if (expectedServerRevision === null || expectedServerRevision === undefined) {
          throw new Error('expected_server_revision_required')
        }
        await discardServerDraft(draftKey.value, expectedServerRevision)
      } catch {
        showWarningToast('服务端草稿删除失败，请稍后重试', '服务端草稿删除失败，请稍后重试')
        return
      }
    }

    pendingDraft.value = null
    draftConflictText.value = ''
    serverDraftSyncPaused.value = false
    serverDraftRevision.value = null
    draftSavedAt.value = null
    draftStatusText.value = ''
    toast.success('服务端草稿已丢弃')
  }

  const clearLocalDraft = (): void => {
    clearDraftSaveTimer()
    removeLocalDraftMetadata(draftKey.value)
    pendingDraft.value = null
    draftConflictText.value = ''
    serverDraftSyncPaused.value = false
    serverDraftRevision.value = null
    draftSavedAt.value = null
    draftStatusText.value = ''
  }

  const clearDraftAfterSubmit = async (): Promise<void> => {
    const expectedServerRevision = serverDraftRevision.value
    clearLocalDraft()
    if (expectedServerRevision !== null) {
      try {
        await discardServerDraft(draftKey.value, expectedServerRevision)
      } catch {
        // The article mutation already succeeded; a newer draft must not be removed by stale cleanup.
      }
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

  const refreshSiteComplianceConfig = async (signal?: AbortSignal): Promise<void> => {
    try {
      siteComplianceConfig.value = await getAdminSiteComplianceConfig(signal ? buildSignalConfig(signal) : undefined)
      if (!isEdit.value && articleForm.rights.mode === 'site') {
        articleForm.rights = { ...siteInheritedRights.value }
      }
    } catch {
      siteComplianceConfig.value = null
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
    articleForm.rights = { ...normalizeArticleRightsForm(data.rights), mode: 'custom' }
    currentRevisionId.value = data.currentRevisionId ?? null
    currentRevisionNo.value = data.revisionNo ?? null
    draftConflictText.value = ''
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

  const rollbackSelectedRevision = async (selection: { targetStatus: 0 | 2 | 3; reason: string }): Promise<void> => {
    if (!selectedRevision.value || articleId.value === null) {
      return
    }

    revisionRollbacking.value = true
    taskFeedback.begin('正在回滚历史版本', `目标版本 ${selectedRevision.value.revisionNo}`, 'article-revision')
    try {
      const revisionNo = selectedRevision.value.revisionNo
      const mfaProofToken = await ensureAdminSensitiveProof()
      if (!currentRevisionId.value) {
        throw new Error('article_base_revision_required')
      }
      const rollback = await rollbackArticleRevision(
        articleId.value,
        selectedRevision.value.id,
        {
          baseRevisionId: currentRevisionId.value,
          targetStatus: selection.targetStatus,
          reason: selection.reason.trim()
        },
        { mfaProofToken })
      if (!rollback.rolledBack) {
        showWarningToast('历史版本不存在或已被清理', '历史版本不存在或已被清理')
        taskFeedback.partial('历史版本回滚未执行', '目标版本不存在或已被清理', 'article-revision')
        return
      }

      suppressDraftSave = true
      const expectedServerRevision = serverDraftRevision.value
      clearLocalDraft()
      if (expectedServerRevision !== null) {
        try {
          await discardServerDraft(draftKey.value, expectedServerRevision)
        } catch {
          // Rollback already persisted the article; a newer draft must not be removed.
        }
      }

      await loadArticleDetailIntoForm(new AbortController().signal)
      await refreshArticleRevisions()
      selectedRevision.value = null
      revisionStatusText.value = `已从版本 ${revisionNo} 创建新版本 ${rollback.revisionNo}`
      taskFeedback.succeed('历史版本回滚完成', `已创建新版本 ${rollback.revisionNo}`, 'article-revision')
      toast.success(`已从版本 ${revisionNo} 创建新版本 ${rollback.revisionNo}`)
    } catch (error: unknown) {
      taskFeedback.fail('历史版本回滚失败', error, '历史版本回滚失败，请稍后重试', 'article-revision')
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
    taskFeedback.begin('正在生成私有预览', '预览不会发布到公开站点', 'article-preview')
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
        taskFeedback.succeed('私有预览已生成', privatePreviewStatusText.value, 'article-preview')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('私有预览生成失败', error, '私有预览生成失败，请稍后重试', 'article-preview')
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
    taskFeedback.begin('正在运行发布前检查', warningOverrideReason ? '包含 warning override 审计理由' : '检查 SEO 与发布阻断项', 'article-prepublish')
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
        if (errorCount > 0) {
          taskFeedback.partial('发布前检查完成', seoStatusText.value, 'article-prepublish')
        } else {
          taskFeedback.succeed('发布前检查完成', seoStatusText.value, 'article-prepublish')
        }
      })
      return canPublish
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('发布前检查失败', error, '发布前检查失败，请稍后重试', 'article-prepublish')
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
    taskFeedback.begin('正在重建资产索引', `文章 ${articleId.value}`, 'article-assets')
    try {
      await assetTask.run(async (signal) => {
        const assets = await reindexArticleAssets(articleId.value!, buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        assetLibrary.value = assets
        assetLibraryStatusText.value = `资产库已重建，当前 ${assets.length} 项`
        taskFeedback.succeed('资产索引已重建', assetLibraryStatusText.value, 'article-assets')
        toast.success('资产库已重建')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('资产索引重建失败', error, '资产索引重建失败，请稍后重试', 'article-assets')
        showErrorToast(error, '资产索引重建失败，请稍后重试')
      }
    } finally {
      assetLibraryLoading.value = false
    }
  }

  const cleanupAssetOrphans = async (): Promise<void> => {
    assetLibraryLoading.value = true
    taskFeedback.begin('正在清理孤儿资产', '仅清理无引用资源', 'article-assets')
    try {
      await assetTask.run(async (signal) => {
        const deleted = await cleanupOrphanAssets(buildSignalConfig(signal))
        if (signal.aborted) {
          return
        }

        await refreshAssetLibrary(signal)
        taskFeedback.succeed('孤儿资产清理完成', `已清理 ${deleted} 个孤儿资产`, 'article-assets')
        toast.success(`已清理 ${deleted} 个孤儿资产`)
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('孤儿资产清理失败', error, '孤儿资产清理失败，请稍后重试', 'article-assets')
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
    taskFeedback.begin('正在创建分类', trimmed, 'article-taxonomy')
    try {
      await taxonomyTask.run(async (signal) => {
        const result = await createCategory(trimmed, buildSignalConfig(signal))
        await refreshTaxonomy(signal)
        const created = categories.value.find((item) => item.id === result.id)
          ?? categories.value.find((item) => item.name === trimmed)
        if (created) {
          articleForm.categoryId = created.id
        } else if (result.id > 0) {
          categories.value = [...categories.value, { id: result.id, name: trimmed, articleCount: 0 }]
          articleForm.categoryId = result.id
        }
      })
      taskFeedback.succeed('分类已创建并选中', trimmed, 'article-taxonomy')
      return true
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('分类创建失败', error, '分类创建失败，请稍后重试', 'article-taxonomy')
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
    taskFeedback.begin('正在创建标签', trimmed, 'article-taxonomy')
    try {
      await taxonomyTask.run(async (signal) => {
        const result = await createTag(trimmed, buildSignalConfig(signal))
        await refreshTaxonomy(signal)
        const created = tags.value.find((item) => item.id === result.id)
          ?? tags.value.find((item) => item.name === trimmed)
        if (created && !articleForm.tagIds.includes(created.id)) {
          articleForm.tagIds = [...articleForm.tagIds, created.id]
        } else if (result.id > 0 && !articleForm.tagIds.includes(result.id)) {
          tags.value = [...tags.value, { id: result.id, name: trimmed, articleCount: 0 }]
          articleForm.tagIds = [...articleForm.tagIds, result.id]
        }
      })
      taskFeedback.succeed('标签已创建并关联', trimmed, 'article-taxonomy')
      return true
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('标签创建失败', error, '标签创建失败，请稍后重试', 'article-taxonomy')
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
          refreshSeoConfig(signal),
          refreshSiteComplianceConfig(signal)
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

  const validateArticleRights = (): boolean => {
    const rights = buildEffectiveArticleRightsForm()
    const licenseType = rights.licenseType.trim()
    const copyPolicy = rights.copyPolicy.trim()
    if (licenseType.trim().length === 0) {
      showWarningToast('版权许可类型不能为空', '版权许可类型不能为空')
      return false
    }
    if (!ARTICLE_RIGHTS_LICENSE_TYPES.includes(licenseType as typeof ARTICLE_RIGHTS_LICENSE_TYPES[number])) {
      showWarningToast('版权许可类型不在允许范围内', '版权许可类型不在允许范围内')
      return false
    }
    if (copyPolicy.trim().length === 0) {
      showWarningToast('复制策略不能为空', '复制策略不能为空')
      return false
    }
    if (!ARTICLE_RIGHTS_COPY_POLICIES.includes(copyPolicy as typeof ARTICLE_RIGHTS_COPY_POLICIES[number])) {
      showWarningToast('复制策略不在允许范围内', '复制策略不在允许范围内')
      return false
    }
    if (rights.copyrightYear !== null) {
      const currentYear = new Date().getFullYear()
      if (!Number.isInteger(rights.copyrightYear) || rights.copyrightYear < 1900 || rights.copyrightYear > currentYear + 1) {
        showWarningToast('版权年份必须是有效年份', '版权年份必须是有效年份')
        return false
      }
    }
    if (!Number.isInteger(rights.maxExcerptChars) || rights.maxExcerptChars < 0 || rights.maxExcerptChars > ARTICLE_RIGHTS_EXCERPT_MAX) {
      showWarningToast(`摘录长度必须在 0-${ARTICLE_RIGHTS_EXCERPT_MAX} 之间`, `摘录长度必须在 0-${ARTICLE_RIGHTS_EXCERPT_MAX} 之间`)
      return false
    }

    return true
  }

  const validateBeforeSubmit = async (): Promise<boolean> => {
    if (!formRef.value || submitting.value) {
      return false
    }

    const validation = await formRef.value.validate()
    if (!isFsusUiOk(validation)) {
      return false
    }

    if (!validateArticleRights()) {
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

  const buildEffectiveArticleRightsForm = (): ArticleRightsForm =>
    articleForm.rights.mode === 'site'
      ? siteInheritedRights.value
      : articleForm.rights

  const buildArticleRightsRequest = (): ArticleRightsRequest => {
    const rights = buildEffectiveArticleRightsForm()
    return {
      mode: articleForm.rights.mode,
      enabled: rights.enabled,
      licenseType: rights.licenseType.trim(),
      copyrightHolder: rights.copyrightHolder.trim() || null,
      copyrightYear: rights.copyrightYear,
      rightsStatement: rights.rightsStatement.trim() || null,
      attributionTemplate: rights.attributionTemplate.trim() || null,
      copyPolicy: rights.copyPolicy.trim(),
      maxExcerptChars: rights.maxExcerptChars,
      allowCodeCopy: rights.allowCodeCopy,
      showPublicBadge: rights.showPublicBadge,
      proofBindingEnabled: rights.proofBindingEnabled
    }
  }

  const useSiteRightsDefaults = (): void => {
    articleForm.rights = { ...siteInheritedRights.value }
  }

  const useCustomArticleRights = (): void => {
    articleForm.rights = {
      ...siteInheritedRights.value,
      mode: 'custom'
    }
  }

  const setArticleRightsMode = (mode: ArticleRightsForm['mode']): void => {
    if (mode === 'site') {
      useSiteRightsDefaults()
      return
    }

    useCustomArticleRights()
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
      taskFeedback.begin(`${submitButtonText.value}处理中`, '正在写入文章并同步相关缓存', 'article-submit')
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
          scheduledPublishAt: articleForm.status === ArticlePublishStatus.Scheduled ? articleForm.scheduledPublishAt : null,
          rights: buildArticleRightsRequest(),
          baseRevisionId: isEdit.value ? currentRevisionId.value : null
        }

        let targetArticleId: number | null = null
        const successMessage = buildSubmitSuccessMessage(isEdit.value, articleForm.status)

        if (isEdit.value) {
          if (articleId.value === null) {
            return
          }

          if (!currentRevisionId.value) {
            throw new Error('article_base_revision_required')
          }
          const result = await updateArticle(articleId.value, articlePayload, config)
          currentRevisionId.value = String(result.revisionId)
          currentRevisionNo.value = result.revisionNo
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
        taskFeedback.succeed(successMessage, '文章写入完成，准备返回列表', 'article-submit')

        suppressDraftSave = true
        await clearDraftAfterSubmit()
        articleForm.content = ''
        await router.push('/user/manage/article/list')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        if (error instanceof BinaryTransportError && error.message === 'article_revision_conflict') {
          let latestRevision = '较新的版本'
          const details = parseArticleRevisionConflictDetails(error.details)
          if (details) {
            latestRevision = `版本 ${details.revisionNo}`
          }
          draftConflictText.value = `检测到${latestRevision}，当前编辑内容未提交。请先重新载入并比较后再保存。`
        }
        taskFeedback.fail(isEdit.value ? '博文更新失败' : '博文发布失败', error, isEdit.value ? '博文更新失败，请稍后重试' : '博文发布失败，请稍后重试', 'article-submit')
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
    toast.success('摘要草稿已生成')
  }

  const requestAiAssist = async () => {
    if (!articleForm.title.trim() && !articleForm.content.trim()) {
      showWarningToast('请先填写标题或正文', '请先填写标题或正文')
      return
    }

    aiAssistLoading.value = true
    aiAssistStatusText.value = '正在检查草稿'
    taskFeedback.begin('正在检查草稿', '摘要草稿、标签匹配、标题备选与结构检查', 'article-ai-assist')
    try {
      await aiAssistTask.run(async (signal) => {
        const response = await generateAiAssist({
          title: articleForm.title,
          content: articleForm.content,
          locale: typeof navigator === 'undefined' ? null : navigator.language,
          operation: 'summary-tags-title-structure-translate'
        }, buildSignalConfig(signal))
        aiAssist.value = response
        aiAssistStatusText.value = '草稿检查完成'
        if (!articleForm.summary.trim() && response.suggestedSummary.trim()) {
          articleForm.summary = response.suggestedSummary.trim()
        }
        taskFeedback.succeed('草稿检查结果已生成', aiAssistStatusText.value, 'article-ai-assist')
        toast.success('草稿检查结果已生成')
      })
    } catch (error: unknown) {
      if (!isAbortError(error)) {
        taskFeedback.fail('草稿检查失败', error, '草稿检查失败', 'article-ai-assist')
        showErrorToast(error, '草稿检查失败')
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
    toast.success('已使用这版摘要')
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
    toast.success('已匹配已有标签')
  }

  const applyAiTranslationDraft = () => {
    const translation = aiAssist.value?.translationDraft?.trim()
    if (!translation) {
      return
    }

    articleForm.content = translation
    toast.success('已使用翻译草稿')
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
      scheduledPublishAt: articleForm.scheduledPublishAt,
      rights: { ...articleForm.rights }
    }),
    scheduleDraftSave,
    { deep: true }
  )

  onMounted(() => {
    if (typeof window !== 'undefined') {
      mountedBrowserSeoBaseUrl.value = window.location.origin
    }
    powProvider.prewarm()
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
    articleForm.rights = createDefaultArticleRightsForm()
  })

  return {
    formRef,
    taskFeedback,
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
    articleRightsUsingSiteDefaults,
    articleRightsInheritanceText,
    articleRightsLicenseOptions,
    articleRightsCopyPolicyOptions,
    articleRightsExcerptMax: ARTICLE_RIGHTS_EXCERPT_MAX,
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
    setArticleRightsMode,
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
