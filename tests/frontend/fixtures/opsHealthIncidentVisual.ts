import { createApp, h, nextTick } from 'vue'
import '@/assets/main.css'
import OpsHealthWorkbench from '@/components/admin/OpsHealthWorkbench.vue'
import type {
  AdminServiceStatusResponse,
  BackupArtifactResponse,
  OpsHealthResponse,
  RecentOpsErrorResponse
} from '@/api/authoring'

type FixtureState =
  | 'healthy'
  | 'one'
  | 'ten'
  | 'optional-missing'
  | 'long-path'
  | 'long-error'

const params = new URL(window.location.href).searchParams
const requestedState = params.get('state')
const states: readonly FixtureState[] = [
  'healthy',
  'one',
  'ten',
  'optional-missing',
  'long-path',
  'long-error'
]
const state = states.includes(requestedState as FixtureState)
  ? requestedState as FixtureState
  : 'healthy'
const theme = params.get('theme') === 'dark' ? 'dark' : 'light'
const checkedAt = '2026-07-24T08:30:00.000Z'

document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.themeMode = theme
document.documentElement.dataset.themeResolved = theme
document.body.className = 'account-shell admin-workspace-frame'

const fixtureHost = document.getElementById('ops-health-incident-fixture')
if (!fixtureHost) {
  throw new Error('ops_health_incident_fixture_host_missing')
}
fixtureHost.style.width = 'min(calc(100% - 2rem), 76rem)'
fixtureHost.style.margin = '1.5rem auto'

const service = (
  key: string,
  label: string,
  status = 'ready',
  detail: string | null = '最近探测正常',
  updatedAt = checkedAt
): AdminServiceStatusResponse => ({
  key,
  label,
  status,
  detail,
  updatedAt,
  metrics: []
})

const error = (
  index: number,
  severity: string,
  occurredAt: string,
  detail?: string
): RecentOpsErrorResponse => ({
  occurredAt,
  severity,
  action: `fixture-action-${index + 1}`,
  message: index === 9
    ? '后台任务连续失败，需要检查最近一次部署后的数据处理链路。'
    : `运维异常 ${index + 1}`,
  detail: detail ?? `worker-${index + 1} 返回不可恢复错误`,
  count: index + 1
})

const healthyServices = [
  service('postgres', 'PostgreSQL'),
  service('redis', 'Redis'),
  service('audit', '审计日志'),
  service('public-hot-read', '热门文章缓存'),
  service('search-index', '搜索索引'),
  service('dependency-graph', '依赖关系')
]
const healthyWorkers = [
  service('scheduled-publish', '定时发布'),
  service('aot-warmup', '公开页预热')
]

const longPath = '/srv/fsusblog/releases/2026/07/24/production-slot-blue/data-protection/artifacts/restore-verification/manifest.latest.json'
const artifacts: BackupArtifactResponse[] = [
  {
    kind: 'database',
    status: state === 'long-path' ? 'failed' : 'ready',
    path: state === 'long-path' ? longPath : '/srv/fsusblog/backups/database/latest.dump',
    updatedAt: checkedAt,
    sizeBytes: 2048,
    detail: state === 'long-path' ? '备份清单校验失败' : 'latest'
  },
  {
    kind: 'restore-drill',
    status: state === 'optional-missing' ? 'missing' : 'ready',
    path: null,
    updatedAt: state === 'optional-missing' ? null : checkedAt,
    sizeBytes: null,
    detail: state === 'optional-missing' ? 'not_run' : 'latest-report'
  }
]

const tenErrors = [
  error(0, 'warning', '2026-07-24T08:27:00.000Z'),
  error(1, 'critical', '2026-07-24T08:18:00.000Z'),
  error(2, 'error', '2026-07-24T08:29:00.000Z'),
  error(3, 'degraded', '2026-07-24T08:28:00.000Z'),
  error(4, 'failed', '2026-07-24T08:16:00.000Z'),
  error(5, 'warning', '2026-07-24T08:26:00.000Z'),
  error(6, 'unknown', '2026-07-24T08:25:00.000Z'),
  error(7, 'not_ready', '2026-07-24T08:24:00.000Z'),
  error(8, 'stale', '2026-07-24T08:23:00.000Z'),
  error(9, 'critical', '2026-07-24T08:30:00.000Z')
]
const recentErrors = state === 'ten'
  ? tenErrors
  : state === 'one'
    ? [error(0, 'warning', '2026-07-24T08:29:00.000Z')]
    : state === 'long-error'
      ? [error(
          0,
          'critical',
          '2026-07-24T08:29:00.000Z',
          '请求失败：'.repeat(32) + 'upstream connection reset after response headers'
        )]
      : []

const health: OpsHealthResponse = {
  status: recentErrors.length > 0 || state === 'long-path' ? 'degraded' : 'ready',
  checkedAt,
  environment: 'Production',
  releaseIdentity: {
    releaseId: '20260724-0830-0123456789ab',
    commitSha: '0123456789ab0123456789ab0123456789ab0123',
    releaseSlot: 'blue'
  },
  services: healthyServices,
  workers: healthyWorkers,
  queueBacklog: {
    articleMutationPending: state === 'one' ? 3 : 0,
    articleMutationFailed: 0,
    auditQueued: 0,
    auditDropped: 0
  },
  backup: {
    status: state === 'long-path' ? 'failed' : 'ready',
    checkedAt,
    backupRoot: '/srv/fsusblog/backups',
    artifacts,
    restoreDrillCommand: 'fsus restore drill',
    restoreCommand: 'fsus restore latest'
  },
  recentErrors
}

const app = createApp({
  render: () => h(OpsHealthWorkbench, {
    health,
    loading: false,
    onRefresh: () => {
      document.documentElement.dataset.opsHealthRefreshCount = String(
        Number(document.documentElement.dataset.opsHealthRefreshCount ?? '0') + 1
      )
    }
  })
})

app.mount(fixtureHost)
await nextTick()
document.documentElement.dataset.opsHealthFixtureReady = 'true'
document.documentElement.dataset.opsHealthFixtureState = state
