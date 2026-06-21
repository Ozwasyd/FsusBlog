import { computed, reactive, ref, shallowRef } from 'vue'
import {
  CommentModerationStatus,
  listCommentModerationQueue,
  type CommentModerationItemResponse,
  type CommentModerationQueueResponse
} from '@/api/authoring'
import { useViewTask } from '@/composables/useViewTask'
import { TimeUtils } from '@/utils/time'

export type CommentModerationFilterKey =
  | 'status'
  | 'keyword'
  | 'article'
  | 'user'
  | 'hitReason'
  | 'blockedRegion'
  | 'modelLabel'
  | 'modelProvider'
  | 'dateRange'

export interface CommentModerationFilters {
  status: CommentModerationStatus
  keyword: string
  article: string
  user: string
  hitReason: string
  blockedRegion: string
  modelLabel: string
  modelProvider: string
  dateRange: [string, string] | null
}

export interface CommentModerationViewItem extends CommentModerationItemResponse {
  actorDisplayName: string
  authorModeLabel: string
  displayLanguageLabel: string
  anonymousScopeLabel: string
  credentialLevelLabel: string
  reputationBucketLabel: string
  accountAgeBucketLabel: string
  nullifierStatusLabel: string
  riskLabels: string[]
  isAnonymousActor: boolean
  isStrongAnonymous: boolean
  hasAnonymousNullifier: boolean
  hasAnonymousCredential: boolean
  canBlockAnonymousNullifier: boolean
  canRevokeAnonymousCredential: boolean
  statusLabel: string
  statusCode: string
  statusClass: string
  moderationActorLabel: string
  recommendedStatus: CommentModerationStatus
  recommendedActionLabel: string
  recommendedActionReason: string
  createTimeText: string
  articleLabel: string
  userLabel: string
  hitReasonLabels: string[]
  regionSummary: string
  blockedRegionLabel: string
  regionPolicyLabel: string
  regionReviewLabel: string
  regionConfidenceLabel: string
  regionCanApprove: boolean
  modelSignalLabel: string
  modelConfidenceLabel: string
  modelProviderLabel: string
  modelReasonLabel: string
  modelSeverityLabel: string
  modelCategoriesLabel: string
  modelProfileLabel: string
  modelStatusLabel: string
  modelLatencyLabel: string
  auditEvents: string[]
}

type UseCommentModerationQueueOptions = Readonly<{
  initialStatus?: CommentModerationStatus
  limit?: number
}>

export const commentModerationStatusOptions = [
  { value: CommentModerationStatus.Pending, label: '待审' },
  { value: CommentModerationStatus.Approved, label: '已通过' },
  { value: CommentModerationStatus.Rejected, label: '已拒绝' },
  { value: CommentModerationStatus.Hidden, label: '已隐藏' }
] as const

export function commentModerationStatusLabel(status: CommentModerationStatus): string {
  switch (status) {
    case CommentModerationStatus.Pending:
      return '待审'
    case CommentModerationStatus.Approved:
      return '已通过'
    case CommentModerationStatus.Rejected:
      return '已拒绝'
    case CommentModerationStatus.Hidden:
      return '已隐藏'
    default:
      return '未知'
  }
}

export function commentModerationStatusCode(status: CommentModerationStatus): string {
  switch (status) {
    case CommentModerationStatus.Pending:
      return 'PENDING'
    case CommentModerationStatus.Approved:
      return 'APPROVED'
    case CommentModerationStatus.Rejected:
      return 'REJECTED'
    case CommentModerationStatus.Hidden:
      return 'HIDDEN'
    default:
      return 'UNKNOWN'
  }
}

export function commentModerationStatusClass(status: CommentModerationStatus): string {
  switch (status) {
    case CommentModerationStatus.Approved:
      return 'text-[var(--fsusblog-color-success)]'
    case CommentModerationStatus.Rejected:
      return 'text-[var(--fsusblog-color-error)]'
    case CommentModerationStatus.Hidden:
      return 'text-[var(--fsusblog-text-muted)]'
    default:
      return 'text-[var(--fsusblog-color-warning)]'
  }
}

export function commentModerationHitReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    'pending-review': '待人工审核',
    'manual-review': '人工复核',
    'html-risk': 'HTML 风险',
    'link-heavy': '链接密集',
    'spam-repeat': '重复刷屏',
    sensitive_term_detected: '敏感词命中',
    malicious_ad_detected: '广告/引流',
    contact_lead_detected: '联系方式引流',
    political_redline_detected: '红线词命中'
  }
  return labels[reason] ?? reason
}

function commentRegionLabel(region: string | null | undefined): string {
  const value = region?.trim()
  if (!value) {
    return '未记录'
  }

  const labels: Record<string, string> = {
    GLOBAL: 'GLOBAL',
    UNKNOWN: 'UNKNOWN',
    'CN-MAINLAND': 'CN-MAINLAND',
    'CN-HK': 'CN-HK',
    'CN-MO': 'CN-MO',
    'CN-TW': 'CN-TW',
    SG: 'SG',
    US: 'US',
    EU: 'EU',
    'EU-DE': 'EU-DE',
    JP: 'JP',
    KR: 'KR'
  }
  return labels[value] ?? value
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

function modelLabelText(label: string | null | undefined): string {
  const labels: Record<string, string> = {
    clean: '低风险',
    suspicious: '可疑',
    risky: '高风险',
    blocked_candidate: '强风险候选'
  }
  return label ? labels[label] ?? label : '未评分'
}

function modelProviderText(provider: string | null | undefined): string {
  const value = provider?.trim()
  if (!value) {
    return '未记录'
  }
  const normalized = value.toLowerCase()
  const labels: Record<string, string> = {
    none: '已关闭',
    mock: '本地模拟',
    local: '本地',
    http_json: 'HTTP JSON',
    fsus_cli: 'Fsus CLI'
  }
  return labels[normalized] ?? `来源：${value}`
}

function modelSeverityText(severity: string | null | undefined): string {
  const labels: Record<string, string> = {
    info: '信息',
    low: '低',
    medium: '中',
    warning: '警告',
    high: '高',
    error: '错误',
    critical: '严重'
  }
  return severity ? labels[severity.toLowerCase()] ?? severity : '未记录'
}

function modelStatusText(status: string | null | undefined): string {
  const labels: Record<string, string> = {
    ok: '正常',
    success: '成功',
    scored: '已评分',
    skipped: '已跳过',
    timeout: '超时',
    unavailable: '不可用',
    error: '异常',
    failed: '失败'
  }
  return status ? labels[status.toLowerCase()] ?? status : '未记录'
}

function cleanText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null
  }
  const text = String(value).trim()
  return text.length > 0 ? text : null
}

function moderationActorText(item: CommentModerationItemResponse): string {
  if (item.autoModerated || item.moderationActor === 'model') {
    return '模型自动处置'
  }
  const actor = cleanText(item.moderationActor)
  if (actor?.startsWith('admin:')) {
    return `管理员 ${actor.slice('admin:'.length)}`
  }
  if (item.moderatedByAdminPrincipalId) {
    return `管理员 ${item.moderatedByAdminPrincipalId}`
  }
  return '等待人工审核'
}

type NormalizedAuthorMode = 'anonymous' | 'public' | 'zk_anonymous'

function normalizeAuthorMode(item: CommentModerationItemResponse): NormalizedAuthorMode {
  const rawMode = cleanText(item.authorMode)?.toLowerCase()
  if (rawMode === 'public' || rawMode === 'zk_anonymous') {
    return rawMode
  }
  if (rawMode === 'anonymous' || item.nullifierHash || item.anonymousCredentialId) {
    return 'anonymous'
  }
  return 'public'
}

function authorModeText(mode: NormalizedAuthorMode): string {
  if (mode === 'public') {
    return '公开账号'
  }
  if (mode === 'zk_anonymous') {
    return '强匿名'
  }
  return '匿名'
}

function displayLanguageText(language: string | null | undefined): string {
  const value = cleanText(language)
  if (value === 'zh-CN') {
    return '展示语言：中文'
  }
  if (value === 'en') {
    return 'Display language: English'
  }
  return value ? `展示语言：${value}` : '展示语言：未记录'
}

function localizedAnonymousDisplayName(language: string | null | undefined, strongAnonymous: boolean): string {
  if (cleanText(language) === 'en') {
    return strongAnonymous ? 'Strong anonymous commenter' : 'Anonymous commenter'
  }
  return strongAnonymous ? '强匿名评论者' : '匿名评论者'
}

function bucketText(label: string, value: string | null | undefined): string {
  return `${label}：${cleanText(value) ?? '未记录'}`
}

function nullifierStatusText(item: CommentModerationItemResponse, isAnonymousActor: boolean): string {
  if (!isAnonymousActor) {
    return 'Nullifier：公开账号'
  }

  return cleanText(item.nullifierStatusLabel) ?? 'Nullifier：未记录'
}

function buildRecommendedAction(item: CommentModerationItemResponse): Pick<CommentModerationViewItem, 'recommendedStatus' | 'recommendedActionLabel' | 'recommendedActionReason'> {
  const modelLabel = item.modelLabel?.toLowerCase() ?? ''
  const modelConfidence = typeof item.modelConfidence === 'number' ? item.modelConfidence : 0
  const hitReasons = new Set(item.hitReasons)
  const hasHardPolicyHit = item.blockedRegions.length > 0 || item.regionCanPublish === false || item.regionHideUntilReviewed
  const hasHighModelRisk = ['risky', 'blocked_candidate'].includes(modelLabel) && modelConfidence >= 0.75
  const hasSpamSignal = hitReasons.has('spam-repeat') || hitReasons.has('malicious_ad_detected') || hitReasons.has('contact_lead_detected')
  const needsManualReview = item.regionRequiresManualReview || hitReasons.has('manual-review') || hitReasons.has('pending-review') || modelLabel === 'suspicious'

  if (hasHardPolicyHit || hasHighModelRisk || hasSpamSignal) {
    const reason = hasHardPolicyHit
      ? '地区策略命中或禁止公开'
      : hasSpamSignal
        ? '命中广告/刷屏风险'
        : '模型高置信风险'
    return {
      recommendedStatus: CommentModerationStatus.Rejected,
      recommendedActionLabel: '建议：拒绝',
      recommendedActionReason: reason
    }
  }

  if (needsManualReview) {
    return {
      recommendedStatus: CommentModerationStatus.Hidden,
      recommendedActionLabel: '建议：隐藏',
      recommendedActionReason: '存在复核信号，先隐藏再人工判断'
    }
  }

  return {
    recommendedStatus: CommentModerationStatus.Approved,
    recommendedActionLabel: '建议：通过',
    recommendedActionReason: '未命中敏感策略，模型信号较低'
  }
}

function toViewItem(item: CommentModerationItemResponse): CommentModerationViewItem {
  const statusLabel = commentModerationStatusLabel(item.status)
  const statusCode = commentModerationStatusCode(item.status)
  const hitReasonLabels = item.hitReasons.map(commentModerationHitReasonLabel)
  const blockedRegionLabel = item.blockedRegions.length > 0
    ? item.blockedRegions.map(commentRegionLabel).join(' / ')
    : '无屏蔽地区'
  const regionReviewLabel = item.regionHideUntilReviewed
    ? '公开前复核'
    : item.regionRequiresManualReview
      ? '需要复核'
      : '无额外复核'
  const confidence = typeof item.submitRegionConfidence === 'number'
    ? Math.round(Math.min(1, Math.max(0, item.submitRegionConfidence)) * 100)
    : null
  const modelConfidence = typeof item.modelConfidence === 'number'
    ? Math.round(Math.min(1, Math.max(0, item.modelConfidence)) * 100)
    : null
  const auditEvents = [
    `提交：${TimeUtils.toFullLocalString(item.createTime)}`,
    item.moderatedAt
      ? `审核：${TimeUtils.toFullLocalString(item.moderatedAt)} / ${item.moderatedByAdminPrincipalId ?? '--'}`
      : '审核：--'
  ]
  const recommendedAction = buildRecommendedAction(item)
  const firstModelSignal = item.modelSignals[0]
  const authorMode = normalizeAuthorMode(item)
  const isAnonymousActor = authorMode !== 'public'
  const credentialLevel = cleanText(item.credentialLevel)
  const isStrongAnonymous = authorMode === 'zk_anonymous' || credentialLevel?.toLowerCase() === 'strong'
  const actorDisplayName = isAnonymousActor
    ? cleanText(item.authorDisplayName) ?? localizedAnonymousDisplayName(item.displayLanguage, isStrongAnonymous)
    : cleanText(item.authorDisplayName) ?? '未署名用户'
  const authorModeLabel = authorModeText(authorMode)
  const anonymousScopeLabel = isAnonymousActor
    ? bucketText('scope', item.anonymousScope)
    : 'scope：公开账号'
  const riskLabels = Array.isArray(item.riskLabels)
    ? item.riskLabels.map(cleanText).filter((label): label is string => Boolean(label))
    : []
  const hasAnonymousNullifier = isAnonymousActor && Boolean(cleanText(item.nullifierHash))
  const hasAnonymousCredential = isAnonymousActor && Boolean(cleanText(item.anonymousCredentialId))
  const userLabel = isStrongAnonymous
    ? `${authorModeLabel} / ${anonymousScopeLabel} / 不显示真实账号`
    : isAnonymousActor
      ? `${authorModeLabel} / ${anonymousScopeLabel}`
      : `${actorDisplayName} / ${typeof item.userId === 'number' ? item.userId : '无账号 ID'}`

  return {
    ...item,
    actorDisplayName,
    authorModeLabel,
    displayLanguageLabel: displayLanguageText(item.displayLanguage),
    anonymousScopeLabel,
    credentialLevelLabel: bucketText('credential', item.credentialLevel),
    reputationBucketLabel: bucketText('声誉桶', item.reputationBucket),
    accountAgeBucketLabel: bucketText('账号年龄桶', item.accountAgeBucket),
    nullifierStatusLabel: nullifierStatusText(item, isAnonymousActor),
    riskLabels,
    isAnonymousActor,
    isStrongAnonymous,
    hasAnonymousNullifier,
    hasAnonymousCredential,
    canBlockAnonymousNullifier: hasAnonymousNullifier && item.canBlockAnonymousNullifier === true,
    canRevokeAnonymousCredential: hasAnonymousCredential && item.canRevokeAnonymousCredential === true,
    statusLabel,
    statusCode,
    statusClass: commentModerationStatusClass(item.status),
    moderationActorLabel: moderationActorText(item),
    ...recommendedAction,
    createTimeText: TimeUtils.toFullLocalString(item.createTime),
    articleLabel: `${item.articleTitle} / ${item.articleId}`,
    userLabel,
    hitReasonLabels,
    regionSummary: `提交地区：${commentRegionLabel(item.submitRegion)}`,
    blockedRegionLabel,
    regionPolicyLabel: item.regionPolicyVersion ?? '策略未记录',
    regionReviewLabel,
    regionConfidenceLabel: confidence === null ? '置信度未记录' : `置信度：${confidence}%`,
    regionCanApprove: item.regionCanPublish !== false,
    modelSignalLabel: item.modelUnavailable ? '模型不可用' : modelLabelText(item.modelLabel),
    modelConfidenceLabel: modelConfidence === null ? '模型置信度未记录' : `模型置信度：${modelConfidence}%`,
    modelProviderLabel: `模型来源：${modelProviderText(item.modelProvider)}`,
    modelReasonLabel: item.modelPrimaryReason ? `原因：${item.modelPrimaryReason}` : '原因未记录',
    modelSeverityLabel: `严重度：${modelSeverityText(firstModelSignal?.severity)}`,
    modelCategoriesLabel: `风险类别：${firstModelSignal?.riskCategories.join(', ') || '未记录'}`,
    modelProfileLabel: `阈值配置：${firstModelSignal?.thresholdProfile || '未记录'}`,
    modelStatusLabel: `状态：${modelStatusText(firstModelSignal?.status)}`,
    modelLatencyLabel: `耗时：${firstModelSignal?.latencyMs ?? '--'}ms`,
    auditEvents
  }
}

export function useCommentModerationQueue(options: UseCommentModerationQueueOptions = {}) {
  const limit = options.limit ?? 100
  const task = useViewTask()
  const queue = shallowRef<CommentModerationQueueResponse | null>(null)
  const lastLoadedAt = ref<string | null>(null)
  const filters = reactive<CommentModerationFilters>({
    status: options.initialStatus ?? CommentModerationStatus.Pending,
    keyword: '',
    article: '',
    user: '',
    hitReason: '',
    blockedRegion: '',
    modelLabel: '',
    modelProvider: '',
    dateRange: null
  })

  const rawItems = computed(() => queue.value?.items ?? [])
  const allItems = computed<CommentModerationViewItem[]>(() => rawItems.value.map(toViewItem))

  const hitReasonOptions = computed(() => {
    const reasons = new Map<string, string>()
    for (const item of rawItems.value) {
      for (const reason of item.hitReasons) {
        reasons.set(reason, commentModerationHitReasonLabel(reason))
      }
    }
    return Array.from(reasons.entries()).map(([value, label]) => ({ value, label }))
  })

  const blockedRegionOptions = computed(() => {
    const regions = new Map<string, string>()
    for (const item of rawItems.value) {
      for (const region of item.blockedRegions) {
        regions.set(region, commentRegionLabel(region))
      }
    }
    return Array.from(regions.entries()).map(([value, label]) => ({ value, label }))
  })

  const modelLabelOptions = computed(() => {
    const labels = new Map<string, string>()
    for (const item of rawItems.value) {
      if (item.modelLabel) {
        labels.set(item.modelLabel, modelLabelText(item.modelLabel))
      }
    }
    return Array.from(labels.entries()).map(([value, label]) => ({ value, label }))
  })

  const modelProviderOptions = computed(() => {
    const providers = new Map<string, string>()
    for (const item of rawItems.value) {
      if (item.modelProvider) {
        providers.set(item.modelProvider, modelProviderText(item.modelProvider))
      }
    }
    return Array.from(providers.entries()).map(([value, label]) => ({ value, label }))
  })

  const filteredItems = computed(() => {
    const keyword = normalizeSearchText(filters.keyword)
    const article = normalizeSearchText(filters.article)
    const user = normalizeSearchText(filters.user)
    const hitReason = filters.hitReason
    const blockedRegion = filters.blockedRegion
    const modelLabel = filters.modelLabel
    const modelProvider = filters.modelProvider
    const dateRange = filters.dateRange
    const fromTime = dateRange?.[0] ? new Date(`${dateRange[0]}T00:00:00`).getTime() : null
    const toTime = dateRange?.[1] ? new Date(`${dateRange[1]}T23:59:59`).getTime() : null

    return allItems.value.filter((item) => {
      if (keyword) {
        const haystack = [
          item.id,
          item.content,
          item.articleTitle,
          item.actorDisplayName,
          item.authorModeLabel,
          item.displayLanguageLabel,
          item.anonymousScopeLabel,
          item.credentialLevelLabel,
          item.reputationBucketLabel,
          item.accountAgeBucketLabel,
          item.riskLabels.join(' '),
          item.reason ?? ''
        ].join(' ').toLowerCase()
        if (!haystack.includes(keyword)) {
          return false
        }
      }

      if (article) {
        const articleHaystack = `${item.articleId} ${item.articleTitle}`.toLowerCase()
        if (!articleHaystack.includes(article)) {
          return false
        }
      }

      if (user) {
        const userHaystack = [
          item.actorDisplayName,
          item.userLabel
        ].join(' ').toLowerCase()
        if (!userHaystack.includes(user)) {
          return false
        }
      }

      if (hitReason && !item.hitReasons.includes(hitReason)) {
        return false
      }

      if (blockedRegion && !item.blockedRegions.includes(blockedRegion)) {
        return false
      }

      if (modelLabel && item.modelLabel !== modelLabel) {
        return false
      }

      if (modelProvider && item.modelProvider !== modelProvider) {
        return false
      }

      if (fromTime !== null || toTime !== null) {
        const createdAt = new Date(item.createTime).getTime()
        if (fromTime !== null && createdAt < fromTime) {
          return false
        }
        if (toTime !== null && createdAt > toTime) {
          return false
        }
      }

      return true
    })
  })

  const counters = computed(() => [
    { label: '待审', value: queue.value?.pendingCount ?? 0 },
    { label: '已拒绝', value: queue.value?.rejectedCount ?? 0 },
    { label: '已隐藏', value: queue.value?.hiddenCount ?? 0 }
  ])

  const activeFilterChips = computed(() => {
    const chips: Array<{ key: CommentModerationFilterKey; label: string }> = [
      { key: 'status', label: `状态：${commentModerationStatusLabel(filters.status)}` }
    ]
    if (filters.keyword.trim()) {
      chips.push({ key: 'keyword', label: `内容：${filters.keyword.trim()}` })
    }
    if (filters.article.trim()) {
      chips.push({ key: 'article', label: `文章：${filters.article.trim()}` })
    }
    if (filters.user.trim()) {
      chips.push({ key: 'user', label: `用户：${filters.user.trim()}` })
    }
    if (filters.hitReason) {
      chips.push({ key: 'hitReason', label: `命中：${commentModerationHitReasonLabel(filters.hitReason)}` })
    }
    if (filters.blockedRegion) {
      chips.push({ key: 'blockedRegion', label: `屏蔽地区：${commentRegionLabel(filters.blockedRegion)}` })
    }
    if (filters.modelLabel) {
      chips.push({ key: 'modelLabel', label: `模型：${modelLabelText(filters.modelLabel)}` })
    }
    if (filters.modelProvider) {
      chips.push({ key: 'modelProvider', label: `模型来源：${modelProviderText(filters.modelProvider)}` })
    }
    if (filters.dateRange) {
      chips.push({ key: 'dateRange', label: `时间：${filters.dateRange[0]} - ${filters.dateRange[1]}` })
    }
    return chips
  })

  const refreshQueue = async (): Promise<boolean> => {
    const result = await task.run(
      async (signal) => await listCommentModerationQueue(filters.status, limit, { signal }),
      {
        fallbackMessage: '评论审核队列加载失败',
        onError: () => {
          queue.value = {
            items: [],
            pendingCount: 0,
            rejectedCount: 0,
            hiddenCount: 0
          }
        }
      }
    )

    if (result) {
      queue.value = result
      lastLoadedAt.value = new Date().toISOString()
      return true
    }

    return false
  }

  const setStatus = async (status: CommentModerationStatus): Promise<void> => {
    filters.status = status
    await refreshQueue()
  }

  const resetFilters = async (): Promise<void> => {
    filters.keyword = ''
    filters.article = ''
    filters.user = ''
    filters.hitReason = ''
    filters.blockedRegion = ''
    filters.modelLabel = ''
    filters.modelProvider = ''
    filters.dateRange = null
    await refreshQueue()
  }

  const removeFilter = async (key: CommentModerationFilterKey): Promise<void> => {
    if (key === 'status') {
      filters.status = CommentModerationStatus.Pending
      await refreshQueue()
      return
    }

    if (key === 'keyword') filters.keyword = ''
    if (key === 'article') filters.article = ''
    if (key === 'user') filters.user = ''
    if (key === 'hitReason') filters.hitReason = ''
    if (key === 'blockedRegion') filters.blockedRegion = ''
    if (key === 'modelLabel') filters.modelLabel = ''
    if (key === 'modelProvider') filters.modelProvider = ''
    if (key === 'dateRange') filters.dateRange = null
  }

  return {
    loading: task.loading,
    errorMessage: task.errorMessage,
    lastLoadedAt,
    filters,
    queue,
    rawItems,
    allItems,
    filteredItems,
    hitReasonOptions,
    blockedRegionOptions,
    modelLabelOptions,
    modelProviderOptions,
    counters,
    activeFilterChips,
    refreshQueue,
    setStatus,
    resetFilters,
    removeFilter
  }
}
