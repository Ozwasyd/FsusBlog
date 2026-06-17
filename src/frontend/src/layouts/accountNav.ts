import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'

export type AccountArea = 'self' | 'manage'
export type AccountContentMode = 'standard' | 'wide' | 'takeover'
export type AccountNavGroupKey = 'self' | 'identity' | 'content' | 'interaction' | 'system' | 'ops'
export type AccountWorkspaceFeatureKey = 'anonymousCommentsEnabled' | 'zkAnonymousEnabled' | 'publicSendOptionEnabled'
export type AccountWorkspacePolicyKey = 'anonymousCommentGovernanceAvailable' | 'zkAnonymousConfigurable'

export interface AccountNavWorkspaceContext {
  surface: AccountArea
  canManage: boolean
  permissions: readonly string[]
  features: Readonly<Record<AccountWorkspaceFeatureKey, boolean>>
  policies: Readonly<Record<AccountWorkspacePolicyKey, boolean>>
}

export interface AccountNavItem {
  label: string
  to: string
  helper?: string
  area: AccountArea
  groupKey: AccountNavGroupKey
  adminOnly?: boolean
  requiredPermission?: string
  requiredFeature?: AccountWorkspaceFeatureKey
  requiredPolicy?: AccountWorkspacePolicyKey
  match?: (path: string) => boolean
}

export interface AccountAreaMeta {
  label: string
}

export interface AccountNavGroup {
  key: AccountNavGroupKey
  label: string
  helper?: string
  area: AccountArea
  items: AccountNavItem[]
}

export const accountAreaMeta: Record<AccountArea, AccountAreaMeta> = {
  self: {
    label: '账户'
  },
  manage: {
    label: '管理'
  }
}

const accountNavItems: readonly AccountNavItem[] = [
  { label: '设置', to: ACCOUNT_ROUTE_PATHS.profile, helper: '资料与安全', area: 'self', groupKey: 'self' },
  { label: '我的消息', to: '/user/messagebox', helper: '站内会话', area: 'self', groupKey: 'self' },
  { label: '身份总览', to: '/user/identity', helper: '登录与公开身份', area: 'self', groupKey: 'identity' },
  { label: '通行密钥', to: '/user/identity/passkeys', helper: 'Passkey 设备', area: 'self', groupKey: 'identity' },
  { label: 'Recovery Key', to: '/user/identity/recovery-key', helper: '账户恢复', area: 'self', groupKey: 'identity' },
  { label: '匿名身份', to: '/user/identity/anonymous', helper: '匿名评论身份', area: 'self', groupKey: 'identity', requiredFeature: 'anonymousCommentsEnabled' },
  { label: '公开资料', to: '/user/identity/public-profile', helper: '公开发送 opt-in', area: 'self', groupKey: 'identity', requiredFeature: 'publicSendOptionEnabled' },
  { label: '评论记录', to: '/user/identity/comment-records', helper: '可归因记录', area: 'self', groupKey: 'identity' },
  { label: '设备会话', to: '/user/identity/sessions', helper: '登录设备', area: 'self', groupKey: 'identity' },
  { label: '二次验证', to: '/user/identity/mfa', helper: 'TOTP step-up', area: 'self', groupKey: 'identity' },
  { label: '仪表盘', to: '/user/manage', helper: '今日待处理', area: 'manage', groupKey: 'content', adminOnly: true },
  {
    label: '文章',
    to: '/user/manage/article/list',
    helper: '列表与编辑',
    area: 'manage',
    groupKey: 'content',
    adminOnly: true,
    requiredPermission: 'article.write',
    match: (path) =>
      path.startsWith('/user/manage/article/list')
      || path.startsWith('/user/manage/article/write')
      || path.startsWith('/user/manage/article/edit/')
  },
  { label: '回收站', to: '/user/manage/article/trash', helper: '删除恢复', area: 'manage', groupKey: 'content', adminOnly: true },
  {
    label: '审核系统',
    to: '/user/manage/moderation',
    helper: '评论、词库与策略',
    area: 'manage',
    groupKey: 'interaction',
    adminOnly: true,
    requiredPermission: 'comment.moderate',
    match: (path) =>
      path.startsWith('/user/manage/moderation')
      || path.startsWith('/user/manage/comments')
  },
  { label: '匿名评论策略', to: '/user/manage/moderation/anonymous-policy', helper: '开关与默认模式', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.comment.configure', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
  { label: '匿名风险', to: '/user/manage/moderation/anonymous-risk', helper: '主体与风险桶', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'comment.moderate', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
  { label: '匿名凭证', to: '/user/manage/moderation/anonymous-credentials', helper: '凭证状态与撤销', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.credential.revoke', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
  { label: 'Nullifier 治理', to: '/user/manage/moderation/nullifiers', helper: '封禁与 scope', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.nullifier.block', requiredFeature: 'anonymousCommentsEnabled', requiredPolicy: 'anonymousCommentGovernanceAvailable' },
  { label: 'ZK 匿名状态', to: '/user/manage/moderation/zk-anonymous', helper: 'Verifier 与配置', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'anonymous.comment.configure', requiredPolicy: 'zkAnonymousConfigurable' },
  {
    label: '站内信',
    to: '/user/manage/messages',
    helper: '会话与工单',
    area: 'manage',
    groupKey: 'interaction',
    adminOnly: true,
    match: (path) => path.startsWith('/user/manage/messages')
  },
  { label: '分类', to: '/user/manage/category', helper: '目录结构', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
  { label: '标签', to: '/user/manage/tag', helper: '索引关键词', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
  { label: '资产库', to: '/user/manage/assets', helper: '媒体与引用', area: 'manage', groupKey: 'content', adminOnly: true, requiredPermission: 'article.write' },
  { label: '备份迁移', to: '/user/manage/content-tools', helper: '导入导出', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'system.config' },
  {
    label: '安全系统',
    to: '/user/manage/security',
    helper: '反爬虫与 PoW',
    area: 'manage',
    groupKey: 'system',
    adminOnly: true,
    requiredPermission: 'system.config',
    match: (path) => path.startsWith('/user/manage/security')
  },
  { label: '审计日志', to: '/user/manage/audit', helper: '事件与证据', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'audit.read' },
  { label: '运维健康', to: '/user/manage/ops', helper: '依赖与 worker', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
  { label: '缓存诊断', to: '/user/manage/cache', helper: 'AOT 与搜索', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
  { label: '数据巡检', to: '/user/manage/integrity', helper: '一致性与 diff', area: 'manage', groupKey: 'ops', adminOnly: true, requiredPermission: 'system.config' },
  { label: '用户', to: '/user/manage/users', helper: '账户治理', area: 'manage', groupKey: 'interaction', adminOnly: true, requiredPermission: 'admin.manage' },
  { label: '系统设置', to: '/user/manage/settings', helper: 'SEO 与页面', area: 'manage', groupKey: 'system', adminOnly: true, requiredPermission: 'system.config' }
]

const navGroupTemplates: readonly Omit<AccountNavGroup, 'items'>[] = [
  { key: 'self', label: '账户', helper: '资料、评论、消息', area: 'self' },
  { key: 'identity', label: '身份', helper: 'Passkey、恢复、公开身份', area: 'self' },
  { key: 'content', label: '内容', helper: '文章、回收站、分类、标签、资产库', area: 'manage' },
  { key: 'interaction', label: '互动', helper: '评论审核、匿名治理、站内信、用户', area: 'manage' },
  { key: 'system', label: '系统', helper: '系统设置、安全系统、备份迁移、审计日志', area: 'manage' },
  { key: 'ops', label: '运维', helper: '运维健康、缓存诊断、数据巡检', area: 'manage' }
]

export function getAccountNavGroups(context: AccountNavWorkspaceContext): AccountNavGroup[] {
  return navGroupTemplates
    .filter((group) => group.area === 'self' || context.canManage)
    .map((group) => ({
      ...group,
      items: accountNavItems.filter((item) => item.groupKey === group.key && isNavItemVisible(item, context))
    }))
    .filter((group) => group.items.length > 0)
}

function isNavItemVisible(item: AccountNavItem, context: AccountNavWorkspaceContext): boolean {
  if (item.area === 'manage' && !context.canManage) {
    return false
  }

  if (item.adminOnly && !context.canManage) {
    return false
  }

  if (item.requiredPermission && !hasPermission(context.permissions, item.requiredPermission)) {
    return false
  }

  if (item.requiredFeature && context.features[item.requiredFeature] !== true) {
    return false
  }

  if (item.requiredPolicy && context.policies[item.requiredPolicy] !== true) {
    return false
  }

  return true
}

function hasPermission(permissions: readonly string[], permission: string): boolean {
  return permissions.includes(permission) || permissions.includes('legacy.admin')
}
