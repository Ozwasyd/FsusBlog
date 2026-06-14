import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'

export type AccountArea = 'self' | 'manage'
export type AccountContentMode = 'standard' | 'wide' | 'takeover'
export type AccountNavGroupKey = 'self' | 'content' | 'interaction' | 'system' | 'ops'

export interface AccountNavItem {
  label: string
  to: string
  helper?: string
  area: AccountArea
  groupKey: AccountNavGroupKey
  adminOnly?: boolean
  match?: (path: string) => boolean
}

export interface AccountAreaMeta {
  eyebrow: string
  title: string
  description: string
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
    eyebrow: '账户',
    title: '个人空间',
    description: '管理你的资料、评论与消息，不改变主站阅读体验。'
  },
  manage: {
    eyebrow: '管理',
    title: '控制中心',
    description: '维护内容、用户、评论审核、安全设置与系统配置。'
  }
}

const accountNavItems: readonly AccountNavItem[] = [
  { label: '设置', to: ACCOUNT_ROUTE_PATHS.profile, helper: '资料与安全', area: 'self', groupKey: 'self' },
  { label: '我的评论', to: '/user/comments', helper: '历史互动', area: 'self', groupKey: 'self' },
  { label: '我的消息', to: '/user/messagebox', helper: '站内会话', area: 'self', groupKey: 'self' },
  { label: '仪表盘', to: '/user/manage', helper: '今日待处理', area: 'manage', groupKey: 'content', adminOnly: true },
  {
    label: '文章',
    to: '/user/manage/article/list',
    helper: '列表与编辑',
    area: 'manage',
    groupKey: 'content',
    adminOnly: true,
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
    match: (path) =>
      path.startsWith('/user/manage/moderation')
      || path.startsWith('/user/manage/comments')
  },
  {
    label: '站内信',
    to: '/user/manage/messages',
    helper: '会话与工单',
    area: 'manage',
    groupKey: 'interaction',
    adminOnly: true,
    match: (path) => path.startsWith('/user/manage/messages')
  },
  { label: '分类', to: '/user/manage/category', helper: '目录结构', area: 'manage', groupKey: 'content', adminOnly: true },
  { label: '标签', to: '/user/manage/tag', helper: '索引关键词', area: 'manage', groupKey: 'content', adminOnly: true },
  { label: '资产库', to: '/user/manage/assets', helper: '媒体与引用', area: 'manage', groupKey: 'content', adminOnly: true },
  { label: '备份迁移', to: '/user/manage/content-tools', helper: '导入导出', area: 'manage', groupKey: 'system', adminOnly: true },
  {
    label: '安全系统',
    to: '/user/manage/security',
    helper: '反爬虫与 PoW',
    area: 'manage',
    groupKey: 'system',
    adminOnly: true,
    match: (path) => path.startsWith('/user/manage/security')
  },
  { label: '审计日志', to: '/user/manage/audit', helper: '事件与证据', area: 'manage', groupKey: 'system', adminOnly: true },
  { label: '运维健康', to: '/user/manage/ops', helper: '依赖与 worker', area: 'manage', groupKey: 'ops', adminOnly: true },
  { label: '缓存诊断', to: '/user/manage/cache', helper: 'AOT 与搜索', area: 'manage', groupKey: 'ops', adminOnly: true },
  { label: '数据巡检', to: '/user/manage/integrity', helper: '一致性与 diff', area: 'manage', groupKey: 'ops', adminOnly: true },
  { label: '用户', to: '/user/manage/users', helper: '账户治理', area: 'manage', groupKey: 'interaction', adminOnly: true },
  { label: '系统设置', to: '/user/manage/settings', helper: 'SEO 与页面', area: 'manage', groupKey: 'system', adminOnly: true }
]

const navGroupTemplates: readonly Omit<AccountNavGroup, 'items'>[] = [
  { key: 'self', label: '账户', helper: '资料、评论、消息', area: 'self' },
  { key: 'content', label: '内容', helper: '文章、回收站、分类、标签、资产库', area: 'manage' },
  { key: 'interaction', label: '互动', helper: '评论审核、站内信、用户', area: 'manage' },
  { key: 'system', label: '系统', helper: '系统设置、安全系统、备份迁移、审计日志', area: 'manage' },
  { key: 'ops', label: '运维', helper: '运维健康、缓存诊断、数据巡检', area: 'manage' }
]

export function getAccountNavGroups(isAdmin: boolean): AccountNavGroup[] {
  return navGroupTemplates
    .filter((group) => group.area === 'self' || isAdmin)
    .map((group) => ({
      ...group,
      items: accountNavItems.filter((item) => item.groupKey === group.key && (!item.adminOnly || isAdmin))
    }))
    .filter((group) => group.items.length > 0)
}
