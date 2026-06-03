import { ACCOUNT_ROUTE_PATHS } from '@/public-renderers/publicRoutePaths'

export type AccountArea = 'self' | 'manage'
export type AccountContentMode = 'standard' | 'wide' | 'takeover'

export interface AccountNavItem {
  label: string
  to: string
  helper?: string
  area: AccountArea
  adminOnly?: boolean
  match?: (path: string) => boolean
}

export interface AccountAreaMeta {
  eyebrow: string
  title: string
  description: string
}

export interface AccountNavGroup {
  key: AccountArea
  label: string
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
    description: '维护内容、用户与系统状态，但保留与账户页一致的轻量阅读风格。'
  }
}

const accountNavItems: readonly AccountNavItem[] = [
  { label: '设置', to: ACCOUNT_ROUTE_PATHS.profile, helper: '资料与安全', area: 'self' },
  { label: '我的评论', to: '/user/comments', helper: '历史互动', area: 'self' },
  { label: '我的消息', to: '/user/messagebox', helper: '站内会话', area: 'self' },
  { label: '仪表盘', to: '/user/manage', helper: '概览', area: 'manage', adminOnly: true },
  {
    label: '文章',
    to: '/user/manage/article/list',
    helper: '列表与编辑',
    area: 'manage',
    adminOnly: true,
    match: (path) =>
      path.startsWith('/user/manage/article/list')
      || path.startsWith('/user/manage/article/write')
      || path.startsWith('/user/manage/article/edit/')
  },
  { label: '回收站', to: '/user/manage/article/trash', helper: '删除恢复', area: 'manage', adminOnly: true },
  {
    label: '评论审核',
    to: '/user/manage/comments',
    helper: '队列与审计',
    area: 'manage',
    adminOnly: true,
    match: (path) => path.startsWith('/user/manage/comments')
  },
  { label: '分类', to: '/user/manage/category', helper: '目录结构', area: 'manage', adminOnly: true },
  { label: '标签', to: '/user/manage/tag', helper: '索引关键词', area: 'manage', adminOnly: true },
  { label: '用户', to: '/user/manage/users', helper: '账户治理', area: 'manage', adminOnly: true },
  { label: '系统设置', to: '/user/manage/settings', helper: 'SEO 与页面', area: 'manage', adminOnly: true }
]

export function getAccountNavGroups(isAdmin: boolean): AccountNavGroup[] {
  const selfItems = accountNavItems.filter((item) => item.area === 'self')
  const groups: AccountNavGroup[] = [
    { key: 'self', label: '账户', items: selfItems.slice() }
  ]

  if (isAdmin) {
    groups.push({
      key: 'manage',
      label: '管理',
      items: accountNavItems.filter((item) => item.area === 'manage')
    })
  }

  return groups
}
