import type { CacheDiagnosticsResponse } from '@/api/authoring'
import type { StatsSummary } from '@/api/stats'
import type { RouteLocationRaw } from 'vue-router'

export type AdminDashboardReadState = 'idle' | 'loading' | 'ready' | 'error'

export type AdminDashboardTaskKey = 'comments' | 'tickets' | 'cache' | 'write'

export type AdminDashboardTaskSource = Readonly<{
  count: number
  state: AdminDashboardReadState
}>

export type AdminDashboardTaskItem = Readonly<{
  key: AdminDashboardTaskKey
  label: string
  countText: string
  helper: string
  state: AdminDashboardReadState
  to: RouteLocationRaw
}>

export type AdminDashboardLedgerItem = Readonly<{
  key: keyof Pick<StatsSummary, 'totalArticles' | 'totalComments' | 'trashCount'>
  label: string
  value: number
}>

export type CacheDiagnosticsHealthSnapshot = Readonly<{
  status: string
  aot: Readonly<{ status: string }>
  search: Readonly<{ status: string }>
  distribution: Readonly<{ status: string }>
  outputCache: Readonly<{ status: string; enabled: boolean }>
}>

const HEALTHY_CACHE_STATUSES = new Set(['ok', 'ready', 'success', 'empty'])

const normalizeCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0

const isHealthyCacheStatus = (status: string): boolean =>
  HEALTHY_CACHE_STATUSES.has(status.trim().toLowerCase())

const taskCountText = (source: AdminDashboardTaskSource): string => {
  if (source.state === 'loading') return '读取中'
  if (source.state === 'error') return '读取失败'
  if (source.state === 'idle') return '待检查'
  return String(normalizeCount(source.count))
}

export function createAdminDashboardLedger(summary: StatsSummary | null): readonly AdminDashboardLedgerItem[] {
  if (!summary) return []

  return [
    { key: 'totalArticles', label: '文章总计', value: normalizeCount(summary.totalArticles) },
    { key: 'totalComments', label: '评论总计', value: normalizeCount(summary.totalComments) },
    { key: 'trashCount', label: '回收站', value: normalizeCount(summary.trashCount) }
  ]
}

export function countCacheDiagnosticsIncidents(
  diagnostics: CacheDiagnosticsHealthSnapshot | CacheDiagnosticsResponse | null
): number {
  if (!diagnostics) return 0

  const sourceHealth = [
    isHealthyCacheStatus(diagnostics.aot.status),
    isHealthyCacheStatus(diagnostics.search.status),
    isHealthyCacheStatus(diagnostics.distribution.status),
    diagnostics.outputCache.enabled && isHealthyCacheStatus(diagnostics.outputCache.status)
  ]
  const incidentCount = sourceHealth.filter((healthy) => !healthy).length

  if (incidentCount === 0 && !isHealthyCacheStatus(diagnostics.status)) {
    return 1
  }

  return incidentCount
}

export function createAdminDashboardTasks(input: Readonly<{
  comments: AdminDashboardTaskSource
  tickets: AdminDashboardTaskSource
  cache: AdminDashboardTaskSource
}>): readonly AdminDashboardTaskItem[] {
  const commentCount = normalizeCount(input.comments.count)
  const ticketCount = normalizeCount(input.tickets.count)
  const cacheCount = normalizeCount(input.cache.count)

  return [
    {
      key: 'comments',
      label: '待审评论',
      countText: taskCountText(input.comments),
      helper: input.comments.state === 'loading'
        ? '正在读取评论审核队列'
        : input.comments.state === 'error'
          ? '队列读取失败；进入评论审核重新检查'
          : input.comments.state === 'idle'
            ? '尚未检查；进入评论审核查看队列'
            : commentCount > 0
              ? `进入评论审核处理 ${commentCount} 条待审评论`
              : '审核队列已清空；可进入查看历史记录',
      state: input.comments.state,
      to: { name: 'ManageModerationComments' }
    },
    {
      key: 'tickets',
      label: '待处理工单',
      countText: taskCountText(input.tickets),
      helper: input.tickets.state === 'loading'
        ? '正在读取站内信工单'
        : input.tickets.state === 'error'
          ? '工单读取失败；进入站内信重新检查'
          : input.tickets.state === 'idle'
            ? '尚未检查；进入站内信查看会话'
            : ticketCount > 0
              ? `进入站内信处理 ${ticketCount} 个待办工单`
              : '没有待处理工单；可进入查看全部会话',
      state: input.tickets.state,
      to: { name: 'ManageMessages' }
    },
    {
      key: 'cache',
      label: '缓存异常',
      countText: taskCountText(input.cache),
      helper: input.cache.state === 'loading'
        ? '正在检查缓存与索引状态'
        : input.cache.state === 'error'
          ? '状态读取失败；进入缓存与索引重新检查'
          : input.cache.state === 'idle'
            ? '尚未检查；进入缓存与索引查看状态'
            : cacheCount > 0
              ? `发现 ${cacheCount} 项异常；进入缓存与索引处理`
              : '最近一次检查无异常；可进入查看诊断详情',
      state: input.cache.state,
      to: { name: 'ManageCacheDiagnostics' }
    },
    {
      key: 'write',
      label: '写新文章',
      countText: '开始',
      helper: '创建草稿并进入写作流程',
      state: 'ready',
      to: { name: 'ManageWriteArticle' }
    }
  ]
}
