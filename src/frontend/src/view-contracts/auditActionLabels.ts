export const auditActionLabels: Readonly<Record<string, string>> = {
  dictionary_loaded: '词库已载入',
  dictionary_reload_failed: '词库重新载入失败',
  dictionary_checksum_changed: '词库校验值变化',
  region_policy_loaded: '地区策略已载入',
  region_policy_reload_failed: '地区策略重新载入失败',
  region_policy_replay_started: '地区策略回放开始',
  region_policy_replay_completed: '地区策略回放完成',
  model_moderation_scored: '模型风险评分完成',
  region_moderation_rejected: '地区策略拒绝发布',
  region_moderation_geo_blocked: '地区策略按地区拦截'
} as const

export type AuditActionDisplay =
  | { kind: 'label'; text: string }
  | { kind: 'code'; namespace: string; name: string }

export const formatAuditAction = (value: string | null | undefined): AuditActionDisplay => {
  if (!value) {
    return { kind: 'label', text: '-' }
  }

  const label = auditActionLabels[value]
  if (label) {
    return { kind: 'label', text: label }
  }

  const dot = value.lastIndexOf('.')
  if (dot === -1) {
    return { kind: 'code', namespace: '', name: value }
  }

  return {
    kind: 'code',
    namespace: value.slice(0, dot),
    name: value.slice(dot + 1)
  }
}
