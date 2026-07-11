import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_GLOBAL_MODULE_LIMIT,
  getAccountNavGroups,
  isAccountNavGroupActive,
  isAccountNavItemActive,
  type AccountNavWorkspaceContext
} from '@/layouts/accountNav'

const manageContext = (
  permissions: readonly string[],
  override: Partial<AccountNavWorkspaceContext> = {}
): AccountNavWorkspaceContext => ({
  surface: 'manage',
  canManage: true,
  permissions,
  features: {
    anonymousCommentsEnabled: true,
    zkAnonymousEnabled: true,
    publicSendOptionEnabled: true
  },
  policies: {
    anonymousCommentGovernanceAvailable: true,
    zkAnonymousConfigurable: true
  },
  ...override
})

const allPermissions = [
  'admin.manage',
  'article.write',
  'comment.moderate',
  'anonymous.comment.configure',
  'anonymous.credential.revoke',
  'anonymous.nullifier.block',
  'system.config',
  'audit.read'
] as const

describe('account navigation module IA', () => {
  it('limits the fully authorized admin shell to six first-level modules', () => {
    const groups = getAccountNavGroups(manageContext(allPermissions))

    expect(groups).toHaveLength(6)
    expect(groups.length).toBeLessThanOrEqual(ACCOUNT_GLOBAL_MODULE_LIMIT)
    expect(groups.map((group) => group.label)).toEqual([
      '工作台',
      '内容',
      '互动',
      '安全',
      '系统',
      '运维'
    ])
    expect(groups.map((group) => group.to)).toEqual([
      '/user/manage',
      '/user/manage/article/list',
      '/user/manage/moderation',
      '/user/manage/security',
      '/user/manage/settings',
      '/user/manage/analytics'
    ])
  })

  it('keeps leaf destinations in their module-local navigation without changing URLs', () => {
    const groups = getAccountNavGroups(manageContext(allPermissions))
    const itemPaths = Object.fromEntries(groups.map((group) => [
      group.key,
      group.items.map((item) => item.to)
    ]))

    expect(itemPaths.content).toEqual([
      '/user/manage/article/list',
      '/user/manage/article/trash',
      '/user/manage/category',
      '/user/manage/tag',
      '/user/manage/assets'
    ])
    expect(itemPaths.security).toEqual(['/user/manage/security'])
    expect(itemPaths.system).toEqual([
      '/user/manage/settings',
      '/user/manage/content-tools',
      '/user/manage/audit'
    ])
    expect(itemPaths.ops).toEqual([
      '/user/manage/analytics',
      '/user/manage/ops',
      '/user/manage/cache',
      '/user/manage/integrity',
      '/user/manage/integrity-proof'
    ])
  })

  it('removes unauthorized modules and leaves instead of exposing disabled links', () => {
    const adminOnly = getAccountNavGroups(manageContext(['admin.manage']))
    expect(adminOnly.map((group) => group.label)).toEqual(['工作台', '互动', '运维'])
    expect(adminOnly.find((group) => group.key === 'interaction')?.items.map((item) => item.label))
      .toEqual(['站内信', '用户'])
    expect(adminOnly.find((group) => group.key === 'ops')?.items.map((item) => item.label))
      .toEqual(['数据概览'])
    expect(adminOnly.flatMap((group) => group.items).map((item) => item.label))
      .not.toContain('Integrity Proof')

    const operationsOnly = getAccountNavGroups(manageContext(['system.config']))
    expect(operationsOnly.map((group) => group.label)).toEqual(['安全', '系统', '运维'])
    expect(operationsOnly.find((group) => group.key === 'system')?.items.map((item) => item.label))
      .toEqual(['系统设置', '备份迁移'])
    expect(operationsOnly.find((group) => group.key === 'ops')?.items.map((item) => item.label))
      .toContain('Integrity Proof')
    expect(operationsOnly.flatMap((group) => group.items).map((item) => item.label))
      .not.toContain('审计日志')

    const auditOnly = getAccountNavGroups(manageContext(['audit.read']))
    expect(auditOnly).toHaveLength(1)
    expect(auditOnly[0]).toMatchObject({
      key: 'system',
      to: '/user/manage/audit'
    })
    expect(auditOnly[0]?.items.map((item) => item.label)).toEqual(['审计日志'])

    expect(getAccountNavGroups(manageContext(allPermissions, { canManage: false }))).toEqual([])
  })

  it('applies feature and policy gates to local leaves before a module is rendered', () => {
    const groups = getAccountNavGroups(manageContext(allPermissions, {
      features: {
        anonymousCommentsEnabled: false,
        zkAnonymousEnabled: false,
        publicSendOptionEnabled: false
      },
      policies: {
        anonymousCommentGovernanceAvailable: false,
        zkAnonymousConfigurable: false
      }
    }))
    const interactionLabels = groups
      .find((group) => group.key === 'interaction')
      ?.items.map((item) => item.label)

    expect(interactionLabels).toEqual(['审核系统', '站内信', '用户'])
    expect(interactionLabels).not.toContain('匿名风险')
    expect(interactionLabels).not.toContain('隐私证明状态')
  })

  it('preserves deep-link current state for nested and prefix-sensitive routes', () => {
    const groups = getAccountNavGroups(manageContext(allPermissions))
    const content = groups.find((group) => group.key === 'content')!
    const interaction = groups.find((group) => group.key === 'interaction')!
    const security = groups.find((group) => group.key === 'security')!
    const ops = groups.find((group) => group.key === 'ops')!

    expect(isAccountNavGroupActive(content, '/user/manage/article/edit/42')).toBe(true)
    expect(content.items.filter((item) => isAccountNavItemActive(item, '/user/manage/article/edit/42')))
      .toHaveLength(1)
    expect(isAccountNavGroupActive(security, '/user/manage/security/pow')).toBe(true)

    const anonymousPath = '/user/manage/moderation/anonymous-credentials'
    expect(interaction.items.filter((item) => isAccountNavItemActive(item, anonymousPath)).map((item) => item.label))
      .toEqual(['匿名资格'])

    const integrityProofPath = '/user/manage/integrity-proof'
    expect(ops.items.filter((item) => isAccountNavItemActive(item, integrityProofPath)).map((item) => item.label))
      .toEqual(['Integrity Proof'])
  })

  it('keeps account and admin surfaces separate in the persistent module list', () => {
    const selfGroups = getAccountNavGroups({
      ...manageContext(allPermissions),
      surface: 'self'
    })

    expect(selfGroups.map((group) => group.label)).toEqual(['账户', '身份'])
    expect(selfGroups.flatMap((group) => group.items).every((item) => item.area === 'self')).toBe(true)
    expect(selfGroups.flatMap((group) => group.items).map((item) => item.to))
      .not.toContain('/user/manage')
  })
})
