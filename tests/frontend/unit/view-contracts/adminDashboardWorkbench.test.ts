import { describe, expect, it } from 'vitest'
import type { StatsSummary } from '@/api/stats'
import type { AuditLogItemResponse } from '@/api/authoring'
import {
  countCacheDiagnosticsIncidents,
  createAdminDashboardLedger,
  createAdminDashboardRecentChanges,
  createAdminDashboardSystemStatus,
  createAdminDashboardTasks,
  type CacheDiagnosticsHealthSnapshot
} from '@/view-contracts/adminDashboard'

const summary = (override: Partial<StatsSummary> = {}): StatsSummary => ({
  totalArticles: 0,
  totalComments: 0,
  trashCount: 0,
  totalReads: 0,
  humanVerifiedReads: 0,
  uniqueViewerKeyEstimate: 0,
  articleReads: 0,
  siteReads: 0,
  ...override
})

const cacheSnapshot = (
  override: Partial<CacheDiagnosticsHealthSnapshot> = {}
): CacheDiagnosticsHealthSnapshot => ({
  status: 'ok',
  aot: { status: 'ready' },
  search: { status: 'ready' },
  distribution: { status: 'ok' },
  outputCache: { status: 'ready', enabled: true },
  ...override
})

const auditItem = (override: Partial<AuditLogItemResponse> = {}): AuditLogItemResponse => ({
  id: 'audit-1',
  source: 'admin',
  type: 'article',
  action: 'article.publish',
  outcome: 'success',
  severity: 'info',
  isHighValue: false,
  actorType: 'admin',
  actorId: null,
  actorRole: 'admin',
  targetType: 'article',
  targetId: '42',
  reasonCode: null,
  occurredAtUtc: '2026-07-23T08:00:00Z',
  eventInfo: '发布了文章',
  traceId: null,
  requestPath: '/api/binary/authoring/articles/42',
  requestMethod: 'POST',
  ipHash: null,
  userAgentHash: null,
  sessionIdHash: null,
  deviceFingerprintHash: null,
  chainId: null,
  prevHash: null,
  recordHash: null,
  recordMac: null,
  piiMode: 'pii-redacted',
  ...override
})

describe('admin dashboard workbench view contract', () => {
  it('keeps zero workload actionable without a generic empty card', () => {
    const tasks = createAdminDashboardTasks({
      comments: { count: 0, state: 'ready' },
      tickets: { count: 0, state: 'ready' },
      cache: { count: 0, state: 'ready' }
    })

    expect(tasks).toHaveLength(4)
    expect(tasks.map((item) => item.key)).toEqual(['comments', 'tickets', 'cache', 'write'])
    expect(tasks.map((item) => item.countText)).toEqual(['0', '0', '0', '开始'])
    expect(tasks[0]).toMatchObject({
      helper: '审核队列已清空；可进入查看历史记录',
      to: { name: 'ManageModerationComments' }
    })
    expect(tasks[1]).toMatchObject({
      helper: '没有待处理工单；可进入查看全部会话',
      to: { name: 'ManageMessages' }
    })
    expect(tasks[2]).toMatchObject({
      helper: '最近一次检查无异常；可进入查看诊断详情',
      to: { name: 'ManageCacheDiagnostics' }
    })
    expect(tasks[3]).toMatchObject({
      helper: '创建草稿并进入写作流程',
      to: { name: 'ManageWriteArticle' }
    })
  })

  it('renders high workload counts without clipping or arbitrary caps', () => {
    const tasks = createAdminDashboardTasks({
      comments: { count: 1384.9, state: 'ready' },
      tickets: { count: 92, state: 'ready' },
      cache: { count: 3, state: 'ready' }
    })

    expect(tasks.map((item) => item.countText)).toEqual(['1384', '92', '3', '开始'])
    expect(tasks[0]?.helper).toContain('1384 条待审评论')
    expect(tasks[1]?.helper).toContain('92 个待办工单')
    expect(tasks[2]?.helper).toContain('3 项异常')
  })

  it('turns loading, idle and error reads into concrete next steps', () => {
    const tasks = createAdminDashboardTasks({
      comments: { count: 0, state: 'loading' },
      tickets: { count: 0, state: 'error' },
      cache: { count: 0, state: 'idle' }
    })

    expect(tasks[0]).toMatchObject({ countText: '读取中', helper: '正在读取评论审核队列' })
    expect(tasks[1]).toMatchObject({
      countText: '读取失败',
      helper: '工单读取失败；进入站内信重新检查'
    })
    expect(tasks[2]).toMatchObject({
      countText: '待检查',
      helper: '尚未检查；进入缓存与索引查看状态'
    })
  })

  it('builds a compact ledger and normalizes invalid counters', () => {
    expect(createAdminDashboardLedger(summary({
      totalArticles: 12000,
      totalComments: 84291,
      totalReads: Number.NaN,
      trashCount: -4
    }))).toEqual([
      { key: 'totalArticles', label: '文章总计', value: 12000 },
      { key: 'totalComments', label: '评论总计', value: 84291 },
      { key: 'trashCount', label: '回收站', value: 0 }
    ])
    expect(createAdminDashboardLedger(null)).toEqual([])
  })

  it('counts each unhealthy cache subsystem and preserves an aggregate fallback', () => {
    expect(countCacheDiagnosticsIncidents(cacheSnapshot())).toBe(0)
    expect(countCacheDiagnosticsIncidents(cacheSnapshot({
      aot: { status: 'degraded' },
      search: { status: 'failed' },
      outputCache: { status: 'disabled', enabled: false }
    }))).toBe(3)
    expect(countCacheDiagnosticsIncidents(cacheSnapshot({ status: 'degraded' }))).toBe(1)
    expect(countCacheDiagnosticsIncidents(null)).toBe(0)
  })

  it('groups recent audit records into task-readable change categories', () => {
    const changes = createAdminDashboardRecentChanges([
      auditItem(),
      auditItem({ id: 'comment', type: 'comment', action: 'moderation.approve', targetType: 'comment', requestPath: '/api/binary/authoring/comments', eventInfo: '批准了评论' }),
      auditItem({ id: 'policy', type: 'security', action: 'policy.update', targetType: 'policy', requestPath: '/api/binary/authoring/policy', eventInfo: '更新了安全策略' }),
      auditItem({ id: 'system', type: 'cache', action: 'cache.rebuild', targetType: 'cache', requestPath: '/api/binary/authoring/cache', eventInfo: '' })
    ])

    expect(changes.map((item) => item.category)).toEqual(['文章', '评论', '策略', '系统'])
    expect(changes[3]).toMatchObject({
      title: 'cache.rebuild',
      to: { name: 'ManageAuditLog' }
    })
  })

  it('does not report an unchecked system as healthy and aggregates real incidents', () => {
    expect(createAdminDashboardSystemStatus(null, 'idle')).toMatchObject({
      state: 'idle',
      label: '系统状态尚未检查'
    })
    expect(createAdminDashboardSystemStatus(cacheSnapshot(), 'ready')).toMatchObject({
      state: 'healthy',
      label: '系统处于预期状态'
    })
    expect(createAdminDashboardSystemStatus(cacheSnapshot({
      search: { status: 'failed' }
    }), 'ready')).toMatchObject({
      state: 'attention',
      label: '1 项运行异常需要处理'
    })
    expect(createAdminDashboardSystemStatus(cacheSnapshot(), 'error')).toMatchObject({
      state: 'error',
      label: '系统状态读取失败'
    })
  })
})
