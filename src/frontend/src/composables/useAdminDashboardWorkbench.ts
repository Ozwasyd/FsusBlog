import { computed, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  CommentModerationStatus,
  getCacheDiagnostics,
  listAuditLogs,
  listCommentModerationQueue,
  type AuditLogItemResponse,
  type CacheDiagnosticsResponse
} from '@/api/authoring'
import { messageApi } from '@/api/message'
import { getSiteStatsOverview, type StatsSummary } from '@/api/stats'
import { useSessionBootstrap } from '@/composables/useSessionBootstrap'
import { useViewTask } from '@/composables/useViewTask'
import {
  buildConsoleSupportLinks,
  resolveConsoleWelcomeCalloutConfig
} from '@/config/consoleWelcomeCallout'
import {
  countCacheDiagnosticsIncidents,
  createAdminDashboardLedger,
  createAdminDashboardRecentChanges,
  createAdminDashboardSystemStatus,
  createAdminDashboardTasks,
  type AdminDashboardReadState
} from '@/view-contracts/adminDashboard'

const resolveReadState = (
  loading: boolean,
  errorMessage: string,
  loaded: boolean
): AdminDashboardReadState => {
  if (loading) return 'loading'
  if (errorMessage) return 'error'
  return loaded ? 'ready' : 'idle'
}

export function useAdminDashboardWorkbench() {
  const statsTask = useViewTask()
  const commentsTask = useViewTask()
  const ticketsTask = useViewTask()
  const cacheTask = useViewTask()
  const changesTask = useViewTask()
  const { userStore, adminStore } = useSessionBootstrap()

  const summary = shallowRef<StatsSummary | null>(null)
  const summaryLoaded = ref(false)
  const pendingCommentCount = ref(0)
  const commentsLoaded = ref(false)
  const pendingTicketsCount = ref(0)
  const ticketsLoaded = ref(false)
  const cacheDiagnostics = shallowRef<CacheDiagnosticsResponse | null>(null)
  const cacheLoaded = ref(false)
  const recentAuditItems = shallowRef<readonly AuditLogItemResponse[]>([])
  const recentChangesLoaded = ref(false)
  const helpLinks = buildConsoleSupportLinks(resolveConsoleWelcomeCalloutConfig())
  let hasFetched = false

  const cacheIncidentCount = computed(() =>
    countCacheDiagnosticsIncidents(cacheDiagnostics.value)
  )
  const canViewAuditLog = computed(() => adminStore.hasPermission('audit.read'))
  const ledgerItems = computed(() => createAdminDashboardLedger(summary.value))
  const hasSummaryData = computed(() => ledgerItems.value.some((item) => item.value > 0))
  const todayActions = computed(() => createAdminDashboardTasks({
    comments: {
      count: pendingCommentCount.value,
      state: resolveReadState(
        commentsTask.loading.value,
        commentsTask.errorMessage.value,
        commentsLoaded.value
      )
    },
    tickets: {
      count: pendingTicketsCount.value,
      state: resolveReadState(
        ticketsTask.loading.value,
        ticketsTask.errorMessage.value,
        ticketsLoaded.value
      )
    },
    cache: {
      count: cacheIncidentCount.value,
      state: resolveReadState(
        cacheTask.loading.value,
        cacheTask.errorMessage.value,
        cacheLoaded.value
      )
    }
  }))
  const pendingActions = computed(() => todayActions.value.filter((action) => (
    action.key !== 'write'
    && (
      action.state !== 'ready'
      || Number.parseInt(action.countText, 10) > 0
    )
  )))
  const writeAction = computed(() => (
    todayActions.value.find((action) => action.key === 'write') ?? null
  ))
  const recentChanges = computed(() => createAdminDashboardRecentChanges(recentAuditItems.value))
  const systemStatus = computed(() => createAdminDashboardSystemStatus(
    cacheDiagnostics.value,
    resolveReadState(
      cacheTask.loading.value,
      cacheTask.errorMessage.value,
      cacheLoaded.value
    )
  ))

  const refreshSummary = async (): Promise<boolean> => {
    const overview = await statsTask.run(
      async (signal) => await getSiteStatsOverview({ signal }),
      {
        fallbackMessage: '统计摘要加载失败',
        onError: () => {
          summary.value = null
          summaryLoaded.value = false
        }
      }
    )

    if (!overview) return false

    summary.value = overview.summary
    summaryLoaded.value = true
    return true
  }

  const refreshPendingTickets = async (): Promise<boolean> => {
    const page = await ticketsTask.run(
      async (signal) => await messageApi.adminGetConversations(1, 'pending', null, { signal }),
      {
        fallbackMessage: '待处理工单数量加载失败',
        onError: () => {
          pendingTicketsCount.value = 0
          ticketsLoaded.value = false
        }
      }
    )

    if (!page) return false

    pendingTicketsCount.value = Number(page.total) || 0
    ticketsLoaded.value = true
    return true
  }

  const refreshPendingComments = async (): Promise<boolean> => {
    const queue = await commentsTask.run(
      async (signal) => await listCommentModerationQueue(
        CommentModerationStatus.Pending,
        1,
        { signal }
      ),
      {
        fallbackMessage: '待审评论数量加载失败',
        onError: () => {
          pendingCommentCount.value = 0
          commentsLoaded.value = false
        }
      }
    )

    if (!queue) return false

    pendingCommentCount.value = Number(queue.pendingCount) || 0
    commentsLoaded.value = true
    return true
  }

  const refreshCacheDiagnostics = async (): Promise<boolean> => {
    const diagnostics = await cacheTask.run(
      async (signal) => await getCacheDiagnostics(null, { signal }),
      {
        fallbackMessage: '缓存与索引状态加载失败',
        onError: () => {
          cacheDiagnostics.value = null
          cacheLoaded.value = false
        }
      }
    )

    if (!diagnostics) return false

    cacheDiagnostics.value = diagnostics
    cacheLoaded.value = true
    return true
  }

  const refreshRecentChanges = async (): Promise<boolean> => {
    if (!canViewAuditLog.value) {
      recentAuditItems.value = []
      recentChangesLoaded.value = true
      return true
    }

    const response = await changesTask.run(
      async (signal) => await listAuditLogs(
        { page: 1, pageSize: 5, piiMode: 'pii-redacted' },
        { signal }
      ),
      {
        fallbackMessage: '最近变更加载失败',
        onError: () => {
          recentAuditItems.value = []
          recentChangesLoaded.value = false
        }
      }
    )

    if (!response) return false

    recentAuditItems.value = response.items
    recentChangesLoaded.value = true
    return true
  }

  const refreshDashboard = async (): Promise<void> => {
    hasFetched = true
    await Promise.all([
      refreshSummary(),
      refreshPendingComments(),
      refreshPendingTickets(),
      refreshCacheDiagnostics(),
      refreshRecentChanges()
    ])
  }

  const resetDashboard = (): void => {
    statsTask.cancel()
    commentsTask.cancel()
    ticketsTask.cancel()
    cacheTask.cancel()
    changesTask.cancel()
    statsTask.clearError()
    commentsTask.clearError()
    ticketsTask.clearError()
    cacheTask.clearError()
    changesTask.clearError()
    summary.value = null
    summaryLoaded.value = false
    pendingCommentCount.value = 0
    commentsLoaded.value = false
    pendingTicketsCount.value = 0
    ticketsLoaded.value = false
    cacheDiagnostics.value = null
    cacheLoaded.value = false
    recentAuditItems.value = []
    recentChangesLoaded.value = false
  }

  watch(
    () => [userStore.isAuthChecked, adminStore.canManage] as const,
    ([isAuthChecked, canManage]) => {
      if (!isAuthChecked || !canManage) {
        hasFetched = false
        resetDashboard()
        return
      }

      if (!hasFetched) {
        void refreshDashboard()
      }
    },
    { immediate: true }
  )

  onUnmounted(resetDashboard)

  return {
    hasSummaryData,
    canViewAuditLog,
    helpLinks,
    ledgerItems,
    pendingActions,
    recentChanges,
    recentChangesErrorMessage: changesTask.errorMessage,
    recentChangesLoaded,
    recentChangesLoading: changesTask.loading,
    refreshDashboard,
    refreshRecentChanges,
    refreshSummary,
    summaryErrorMessage: statsTask.errorMessage,
    summaryLoaded,
    summaryLoading: statsTask.loading,
    systemStatus,
    writeAction
  }
}
