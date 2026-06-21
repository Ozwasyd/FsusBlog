export type AdminSystemStatus =
  | 'ok' | 'ready' | 'success' | 'applied'
  | 'stale' | 'degraded' | 'warning' | 'not_ready' | 'queued'
  | 'failed' | 'failure' | 'missing' | 'unsupported' | 'unknown'
  | 'denied' | 'empty' | 'issue' | 'issues'
  | 'info' | 'error' | 'critical'

export type AdminStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export const adminStatusTone: Readonly<Record<AdminSystemStatus, AdminStatusTone>> = {
  ok: 'success',
  ready: 'success',
  success: 'success',
  applied: 'success',
  stale: 'warning',
  degraded: 'warning',
  warning: 'warning',
  not_ready: 'danger',
  queued: 'success',
  failed: 'danger',
  failure: 'danger',
  missing: 'danger',
  unsupported: 'danger',
  unknown: 'info',
  denied: 'warning',
  empty: 'success',
  issue: 'warning',
  issues: 'warning',
  info: 'info',
  error: 'danger',
  critical: 'danger'
}

export const adminStatusLabel: Readonly<Record<AdminSystemStatus, string>> = {
  ok: '正常',
  ready: '就绪',
  success: '成功',
  applied: '已应用',
  stale: '需刷新',
  degraded: '降级',
  warning: '警告',
  not_ready: '未就绪',
  queued: '已入队',
  failed: '失败',
  failure: '失败',
  missing: '缺失',
  unsupported: '不支持',
  unknown: '未知',
  denied: '已拒绝',
  empty: '无数据',
  issue: '有问题',
  issues: '有问题',
  info: '信息',
  error: '错误',
  critical: '严重'
}
