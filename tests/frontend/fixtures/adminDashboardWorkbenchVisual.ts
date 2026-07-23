import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import '@/assets/main.css'
import AdminDashboardTaskWorkbench from '@/components/admin/AdminDashboardTaskWorkbench.vue'
import AccountNavigationPanel from '@/components/account/AccountNavigationPanel.vue'
import { getAccountNavGroups } from '@/layouts/accountNav'
import {
  createAdminDashboardLedger,
  createAdminDashboardSystemStatus,
  createAdminDashboardTasks,
  type AdminDashboardRecentChangeItem,
  type AdminDashboardTaskItem
} from '@/view-contracts/adminDashboard'

const params = new URL(window.location.href).searchParams
const requestedWorkload = params.get('workload')
const workload = requestedWorkload === 'one' || requestedWorkload === 'eight'
  ? requestedWorkload
  : 'zero'
const changesMode = params.get('changes') === 'many' ? 'many' : 'none'
const systemMode = params.get('system') === 'attention' ? 'attention' : 'healthy'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const hasWorkload = workload !== 'zero'

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'account-shell'
const fixtureHost = document.getElementById('admin-dashboard-workbench-fixture')
if (!fixtureHost) {
  throw new Error('admin_dashboard_workbench_fixture_host_missing')
}
fixtureHost.style.width = 'min(calc(100% - 2rem), var(--fsusblog-container-account, 56rem))'
fixtureHost.style.margin = '1.5rem auto'
const fixtureStyle = document.createElement('style')
fixtureStyle.textContent = `
  #admin-dashboard-workbench-fixture { width: min(calc(100% - 2rem), 72rem) !important; }
  .admin-dashboard-fixture-shell { display: grid; grid-template-columns: 13rem minmax(0, 1fr); gap: 2rem; }
  .admin-dashboard-fixture-sidebar { min-width: 0; padding-top: 0.25rem; }
  @media (max-width: 767px) {
    .admin-dashboard-fixture-shell { grid-template-columns: 1fr; }
    .admin-dashboard-fixture-sidebar { display: none; }
  }
`
document.head.append(fixtureStyle)

const allTasks = createAdminDashboardTasks({
  comments: { count: hasWorkload ? 8 : 0, state: 'ready' },
  tickets: { count: hasWorkload ? 3 : 0, state: 'ready' },
  cache: { count: systemMode === 'attention' ? 2 : 0, state: 'ready' }
})
const pendingActions: readonly AdminDashboardTaskItem<string>[] = workload === 'zero'
  ? []
  : workload === 'one'
    ? allTasks.slice(0, 1)
    : Array.from({ length: 8 }, (_, index) => ({
        ...allTasks[index % 3]!,
        key: `fixture-task-${index}`,
        label: ['待审评论', '待处理工单', '运行异常'][index % 3]!,
        countText: String(index + 1)
      }))
const writeAction = allTasks.find((item) => item.key === 'write') ?? null

const ledgerItems = createAdminDashboardLedger({
  totalArticles: hasWorkload ? 12000 : 0,
  totalComments: hasWorkload ? 84291 : 0,
  trashCount: hasWorkload ? 71 : 0,
  totalReads: hasWorkload ? 9340021 : 0,
  humanVerifiedReads: 0,
  uniqueViewerKeyEstimate: 0,
  articleReads: 0,
  siteReads: 0
})
const recentChanges: readonly AdminDashboardRecentChangeItem[] = changesMode === 'many'
  ? [
      { id: 'article', category: '文章', title: '发布了文章《任务优先的管理工作流》', occurredAtUtc: '2026-07-23T08:15:00Z', to: { name: 'ManageAuditLog' } },
      { id: 'comment', category: '评论', title: '批准了 3 条待审评论', occurredAtUtc: '2026-07-23T07:42:00Z', to: { name: 'ManageAuditLog' } },
      { id: 'policy', category: '策略', title: '更新了匿名评论审核策略', occurredAtUtc: '2026-07-22T16:20:00Z', to: { name: 'ManageAuditLog' } },
      { id: 'system', category: '系统', title: '完成了缓存索引重建', occurredAtUtc: '2026-07-22T15:08:00Z', to: { name: 'ManageAuditLog' } }
    ]
  : []
const systemStatus = createAdminDashboardSystemStatus({
  status: systemMode === 'attention' ? 'degraded' : 'ok',
  aot: { status: systemMode === 'attention' ? 'degraded' : 'ready' },
  search: { status: 'ready' },
  distribution: { status: 'ok' },
  outputCache: { status: 'ready', enabled: true }
}, 'ready')

const destination = { render: () => h('main', { 'data-fixture-destination': 'true' }) }
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'FixtureHome', component: destination },
    { path: '/comments', name: 'ManageModerationComments', component: destination },
    { path: '/messages', name: 'ManageMessages', component: destination },
    { path: '/cache', name: 'ManageCacheDiagnostics', component: destination },
    { path: '/write', name: 'ManageWriteArticle', component: destination },
    { path: '/analytics', name: 'ManageAnalytics', component: destination },
    { path: '/audit', name: 'ManageAuditLog', component: destination },
    { path: '/:pathMatch(.*)*', name: 'FixtureCatchAll', component: destination }
  ]
})
const navigationGroups = getAccountNavGroups({
  surface: 'manage',
  canManage: true,
  permissions: ['admin.manage', 'article.write', 'comment.moderate', 'system.config', 'audit.read'],
  features: {
    anonymousCommentsEnabled: false,
    zkAnonymousEnabled: false,
    publicSendOptionEnabled: false
  },
  policies: {
    anonymousCommentGovernanceAvailable: false,
    zkAnonymousConfigurable: false
  }
})

await router.push('/')
await router.isReady()

const app = createApp({
  render: () => h('div', { class: 'admin-dashboard-fixture-shell' }, [
    h('aside', { class: 'admin-dashboard-fixture-sidebar' }, [
      h(AccountNavigationPanel, {
        areaLabel: '管理',
        groups: navigationGroups,
        headingId: 'fixture-admin-navigation'
      })
    ]),
    h('main', [
      h(AdminDashboardTaskWorkbench, {
        canViewAuditLog: true,
        hasSummaryData: hasWorkload,
        helpLinks: [
          { key: 'contribute', label: '查看维护说明', href: 'https://example.test/guide' },
          { key: 'issue', label: '提交问题', href: 'https://example.test/support' }
        ],
        ledgerItems,
        pendingActions,
        recentChanges,
        recentChangesErrorMessage: '',
        recentChangesLoaded: true,
        recentChangesLoading: false,
        summaryErrorMessage: '',
        summaryLoaded: true,
        summaryLoading: false,
        systemStatus,
        writeAction
      })
    ])
  ])
})

app.use(router)
app.mount(fixtureHost)
await nextTick()
document.documentElement.dataset.adminDashboardFixtureReady = 'true'
