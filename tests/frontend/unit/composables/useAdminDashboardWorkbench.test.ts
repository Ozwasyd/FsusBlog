import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdminDashboardWorkbench } from '@/composables/useAdminDashboardWorkbench'

const mocks = vi.hoisted(() => ({
  getCacheDiagnostics: vi.fn(),
  listCommentModerationQueue: vi.fn(),
  getSiteStatsOverview: vi.fn(),
  adminGetConversations: vi.fn(),
}))

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

vi.mock('@/api/authoring', () => ({
  CommentModerationStatus: { Pending: 0 },
  getCacheDiagnostics: mocks.getCacheDiagnostics,
  listCommentModerationQueue: mocks.listCommentModerationQueue
}))

vi.mock('@/api/message', () => ({
  messageApi: {
    adminGetConversations: mocks.adminGetConversations
  }
}))

vi.mock('@/api/stats', () => ({
  getSiteStatsOverview: mocks.getSiteStatsOverview
}))

vi.mock('@/composables/useSessionBootstrap', () => ({
  useSessionBootstrap: () => ({
    userStore: { isAuthChecked: true },
    adminStore: {
      canManage: false,
      hasPermission: vi.fn(() => false)
    }
  })
}))

const statsOverview = (totalArticles = 12) => ({
  summary: {
    totalArticles,
    totalComments: 34,
    trashCount: 2,
    totalReads: 567,
    humanVerifiedReads: 0,
    uniqueViewerKeyEstimate: 0,
    articleReads: 0,
    siteReads: 0
  },
  popularArticles: []
})

const healthyCacheDiagnostics = () => ({
  status: 'ok',
  checkedAt: '2026-07-11T00:00:00.000Z',
  aot: { status: 'ready' },
  search: { status: 'ready' },
  distribution: { status: 'ok' },
  outputCache: { status: 'ready', enabled: true }
})

const mountProbe = () => {
  let workbench: ReturnType<typeof useAdminDashboardWorkbench> | null = null
  const wrapper = mount(defineComponent({
    setup() {
      workbench = useAdminDashboardWorkbench()
      return () => h('div')
    }
  }))

  return {
    wrapper,
    get workbench() {
      if (!workbench) throw new Error('dashboard workbench did not mount')
      return workbench
    }
  }
}

const dashboardActions = (workbench: ReturnType<typeof useAdminDashboardWorkbench>) => [
  ...workbench.pendingActions.value,
  ...(workbench.writeAction.value ? [workbench.writeAction.value] : [])
]

beforeEach(() => {
  mocks.getCacheDiagnostics.mockReset().mockResolvedValue(healthyCacheDiagnostics())
  mocks.getSiteStatsOverview.mockReset().mockResolvedValue(statsOverview())
  mocks.adminGetConversations.mockReset().mockResolvedValue({ items: [], total: 7 })
  mocks.listCommentModerationQueue.mockReset().mockResolvedValue({
    items: [],
    pendingCount: 5,
    rejectedCount: 0,
    hiddenCount: 0
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useAdminDashboardWorkbench', () => {
  it('loads the four independent dashboard sources concurrently into task rows and ledger', async () => {
    const statsRequest = deferred<ReturnType<typeof statsOverview>>()
    const commentsRequest = deferred<{
      items: never[]
      pendingCount: number
      rejectedCount: number
      hiddenCount: number
    }>()
    const ticketsRequest = deferred<{ items: never[]; total: number }>()
    const cacheRequest = deferred<ReturnType<typeof healthyCacheDiagnostics>>()
    mocks.getSiteStatsOverview.mockReturnValueOnce(statsRequest.promise)
    mocks.listCommentModerationQueue.mockReturnValueOnce(commentsRequest.promise)
    mocks.adminGetConversations.mockReturnValueOnce(ticketsRequest.promise)
    mocks.getCacheDiagnostics.mockReturnValueOnce(cacheRequest.promise)
    const probe = mountProbe()

    const refreshPromise = probe.workbench.refreshDashboard()

    expect(mocks.getSiteStatsOverview).toHaveBeenCalledTimes(1)
    expect(mocks.listCommentModerationQueue).toHaveBeenCalledWith(
      0,
      1,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mocks.adminGetConversations).toHaveBeenCalledWith(
      1,
      'pending',
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(mocks.getCacheDiagnostics).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )

    statsRequest.resolve(statsOverview())
    commentsRequest.resolve({
      items: [],
      pendingCount: 5,
      rejectedCount: 0,
      hiddenCount: 0
    })
    ticketsRequest.resolve({ items: [], total: 7 })
    cacheRequest.resolve(healthyCacheDiagnostics())
    await refreshPromise

    expect(dashboardActions(probe.workbench).map((item) => item.countText))
      .toEqual(['5', '7', '开始'])
    expect(probe.workbench.ledgerItems.value.map((item) => item.value))
      .toEqual([12, 34, 2])
    expect(probe.workbench.summaryLoaded.value).toBe(true)
    expect(probe.workbench.helpLinks.map((item) => item.label)).toContain('提交问题')

    probe.wrapper.unmount()
  })

  it('keeps failures isolated and exposes concrete task and summary recovery states', async () => {
    mocks.getSiteStatsOverview.mockRejectedValueOnce(new Error('stats offline'))
    mocks.adminGetConversations.mockRejectedValueOnce(new Error('messages offline'))
    mocks.getCacheDiagnostics.mockRejectedValueOnce(new Error('cache offline'))
    mocks.listCommentModerationQueue.mockRejectedValueOnce(new Error('moderation offline'))
    const probe = mountProbe()

    await probe.workbench.refreshDashboard()

    expect(probe.workbench.summaryLoaded.value).toBe(false)
    expect(probe.workbench.summaryErrorMessage.value).toBe('stats offline')
    const actions = dashboardActions(probe.workbench)
    expect(actions.map((item) => item.countText))
      .toEqual(['读取失败', '读取失败', '读取失败', '开始'])
    expect(actions[0]?.helper).toContain('进入评论审核重新检查')
    expect(actions[1]?.helper).toContain('进入站内信重新检查')
    expect(actions[2]?.helper).toContain('进入缓存与索引重新检查')

    probe.wrapper.unmount()
  })
})
