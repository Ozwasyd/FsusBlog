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
  | 'dateRange'

export interface CommentModerationFilters {
  status: CommentModerationStatus
  keyword: string
  article: string
  user: string
  hitReason: string
  blockedRegion: string
  dateRange: [string, string] | null
}

export interface CommentModerationViewItem extends CommentModerationItemResponse {
  statusLabel: string
  statusCode: string
  statusClass: string
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
  const auditEvents = [
    `提交：${TimeUtils.toFullLocalString(item.createTime)}`,
    item.moderatedAt
      ? `审核：${TimeUtils.toFullLocalString(item.moderatedAt)} / ${item.moderatedByUserId ?? '--'}`
      : '审核：--'
  ]

  return {
    ...item,
    statusLabel,
    statusCode,
    statusClass: commentModerationStatusClass(item.status),
    createTimeText: TimeUtils.toFullLocalString(item.createTime),
    articleLabel: `${item.articleTitle} / ${item.articleId}`,
    userLabel: `${item.userName} / ${item.userId}`,
    hitReasonLabels,
    regionSummary: `提交地区：${commentRegionLabel(item.submitRegion)}`,
    blockedRegionLabel,
    regionPolicyLabel: item.regionPolicyVersion ?? '策略未记录',
    regionReviewLabel,
    regionConfidenceLabel: confidence === null ? '置信度未记录' : `置信度：${confidence}%`,
    regionCanApprove: item.regionCanPublish !== false,
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

  const filteredItems = computed(() => {
    const keyword = normalizeSearchText(filters.keyword)
    const article = normalizeSearchText(filters.article)
    const user = normalizeSearchText(filters.user)
    const hitReason = filters.hitReason
    const blockedRegion = filters.blockedRegion
    const dateRange = filters.dateRange
    const fromTime = dateRange?.[0] ? new Date(`${dateRange[0]}T00:00:00`).getTime() : null
    const toTime = dateRange?.[1] ? new Date(`${dateRange[1]}T23:59:59`).getTime() : null

    return allItems.value.filter((item) => {
      if (keyword) {
        const haystack = `${item.id} ${item.content} ${item.articleTitle} ${item.userName} ${item.reason ?? ''}`.toLowerCase()
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
        const userHaystack = `${item.userId} ${item.userName}`.toLowerCase()
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
    counters,
    activeFilterChips,
    refreshQueue,
    setStatus,
    resetFilters,
    removeFilter
  }
}
