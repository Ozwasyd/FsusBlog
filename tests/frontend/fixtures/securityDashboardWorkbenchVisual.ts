import { createApp, h, nextTick } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import '@/assets/main.css'
import SecurityDashboardWorkbench from '@/components/admin/SecurityDashboardWorkbench.vue'
import type {
  SecurityDashboardModel,
  SecurityDashboardTask
} from '@/view-contracts/securityDashboard'

type FixtureState = 'healthy' | 'one' | 'five' | 'twenty' | 'policy' | 'unavailable'

const params = new URL(window.location.href).searchParams
const requestedState = params.get('state')
const state: FixtureState = (
  ['healthy', 'one', 'five', 'twenty', 'policy', 'unavailable'] as const
).includes(requestedState as FixtureState)
  ? requestedState as FixtureState
  : 'healthy'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const checkedAtUtc = '2026-07-23T08:00:00.000Z'

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'account-shell'

const fixtureHost = document.getElementById('security-dashboard-workbench-fixture')
if (!fixtureHost) {
  throw new Error('security_dashboard_workbench_fixture_host_missing')
}
fixtureHost.style.width = 'min(calc(100% - 2rem), var(--fsusblog-container-account, 62rem))'
fixtureHost.style.margin = '1.5rem auto'

const severityCycle = [
  { severity: 'critical', severityLabel: '严重' },
  { severity: 'warning', severityLabel: '警告' },
  { severity: 'attention', severityLabel: '关注' }
] as const

const createTask = (index: number, unavailable = false): SecurityDashboardTask => {
  const severity = unavailable
    ? { severity: 'unavailable' as const, severityLabel: '不可用' }
    : severityCycle[index % severityCycle.length]!
  const routeNames = ['ManageSecurityEvents', 'ManageSecurityPow', 'ManageSecurityCrawler'] as const
  return {
    actionLabel: unavailable ? '检查子系统' : '处理异常',
    helper: unavailable
      ? '状态聚合暂不可用；进入子系统确认服务和最近事件。'
      : '确认来源、处置结果和是否需要调整当前策略。',
    key: unavailable ? 'subsystem-unavailable' : `fixture-anomaly-${index + 1}`,
    occurredAt: checkedAtUtc,
    severity: severity.severity,
    severityLabel: severity.severityLabel,
    title: unavailable ? '风险事件子系统不可用' : `安全异常 ${index + 1}`,
    to: { name: unavailable ? 'ManageSecurityEvents' : routeNames[index % routeNames.length]! }
  }
}

const anomalyCount = state === 'one'
  ? 1
  : state === 'five'
    ? 5
    : state === 'twenty'
      ? 20
      : 0
const tasks = state === 'unavailable'
  ? [createTask(0, true)]
  : Array.from({ length: anomalyCount }, (_, index) => createTask(index))

const model: SecurityDashboardModel = {
  checkedAtUtc,
  changes: state === 'policy'
    ? [{
        actor: 'admin:fixture',
        key: 'pow-policy-fixture',
        label: 'PoW 策略',
        occurredAt: checkedAtUtc,
        value: 'strict'
      }]
    : [],
  status: tasks.length > 0 ? 'attention' : 'healthy',
  statusCopy: tasks.length > 0
    ? `发现 ${tasks.length} 类需要处理的安全异常。`
    : '系统处于预期状态，当前没有需要处理的安全异常。',
  tasks,
  trends: [
    { key: 'events-hour', label: '近 1 小时事件', value: String(tasks.length) },
    { key: 'events-day', label: '近 24 小时事件', value: String(tasks.length * 4) },
    { key: 'high-risk', label: '高风险主体', value: String(Math.min(tasks.length, 5)) },
    { key: 'top-reason', label: '主要原因', value: tasks.length > 0 ? '策略阈值' : '无' }
  ]
}

const destination = {
  render: () => h('main', { 'data-fixture-destination': 'true' }, '目标子系统')
}
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', name: 'FixtureHome', component: destination },
    { path: '/events', name: 'ManageSecurityEvents', component: destination },
    { path: '/pow', name: 'ManageSecurityPow', component: destination },
    { path: '/crawler', name: 'ManageSecurityCrawler', component: destination }
  ]
})

router.afterEach((to) => {
  document.documentElement.dataset.securityDashboardRoutePath = to.path
})
await router.push('/')
await router.isReady()

const app = createApp({
  render: () => h(SecurityDashboardWorkbench, {
    errorMessage: '',
    loading: false,
    model,
    onRefresh: () => {
      document.documentElement.dataset.securityDashboardRefreshCount = String(
        Number(document.documentElement.dataset.securityDashboardRefreshCount ?? '0') + 1
      )
    }
  })
})

app.use(router)
app.mount(fixtureHost)
await nextTick()
document.documentElement.dataset.securityDashboardFixtureReady = 'true'
document.documentElement.dataset.securityDashboardFixtureState = state
