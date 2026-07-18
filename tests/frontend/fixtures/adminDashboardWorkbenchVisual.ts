import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import '@/assets/main.css'
import AdminDashboardTaskWorkbench from '@/components/admin/AdminDashboardTaskWorkbench.vue'
import {
  createAdminDashboardLedger,
  createAdminDashboardTasks
} from '@/view-contracts/adminDashboard'

const params = new URL(window.location.href).searchParams
const workload = params.get('workload') === 'high' ? 'high' : 'zero'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const isHighWorkload = workload === 'high'

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

const todayActions = createAdminDashboardTasks({
  comments: { count: isHighWorkload ? 1384 : 0, state: 'ready' },
  tickets: { count: isHighWorkload ? 92 : 0, state: 'ready' },
  cache: { count: isHighWorkload ? 3 : 0, state: 'ready' }
})

const ledgerItems = createAdminDashboardLedger({
  totalArticles: isHighWorkload ? 12000 : 0,
  totalComments: isHighWorkload ? 84291 : 0,
  trashCount: isHighWorkload ? 71 : 0,
  totalReads: isHighWorkload ? 9340021 : 0,
  humanVerifiedReads: 0,
  uniqueViewerKeyEstimate: 0,
  articleReads: 0,
  siteReads: 0
})

const destination = { render: () => h('main', { 'data-fixture-destination': 'true' }) }
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'FixtureHome', component: destination },
    { path: '/comments', name: 'ManageModerationComments', component: destination },
    { path: '/messages', name: 'ManageMessages', component: destination },
    { path: '/cache', name: 'ManageCacheDiagnostics', component: destination },
    { path: '/write', name: 'ManageWriteArticle', component: destination },
    { path: '/analytics', name: 'ManageAnalytics', component: destination }
  ]
})

await router.push('/')
await router.isReady()

const app = createApp({
  render: () => h(AdminDashboardTaskWorkbench, {
    hasSummaryData: isHighWorkload,
    helpLinks: [
      { key: 'contribute', label: '查看维护说明', href: 'https://example.test/guide' },
      { key: 'issue', label: '提交问题', href: 'https://example.test/support' }
    ],
    ledgerItems,
    summaryErrorMessage: '',
    summaryLoaded: true,
    summaryLoading: false,
    todayActions
  })
})

app.use(router)
app.mount(fixtureHost)
await nextTick()
document.documentElement.dataset.adminDashboardFixtureReady = 'true'
