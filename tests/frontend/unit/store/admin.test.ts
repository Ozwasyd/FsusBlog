import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAdminStore } from '@/store/admin'
import { getAccountNavGroups } from '@/layouts/accountNav'

vi.mock('@/api/auth', () => ({
  getAdminMe: vi.fn()
}))

describe('useAdminStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('does not expose a legacy user-role admin bridge', () => {
    const store = useAdminStore()

    expect('syncLegacyAdminPrincipal' in store).toBe(false)
    expect(store.adminSessionStatus).toBe('missing')
    expect(store.canManage).toBe(false)
    expect(store.permissions).toEqual([])
  })

  it('keeps independent admin principals separate from normal account role', () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['comment.moderate'],
      adminSessionStatus: 'active'
    })

    expect(store.canManage).toBe(true)
    expect(store.hasPermission('comment.moderate')).toBe(true)
    expect(store.hasPermission('article.write')).toBe(false)
  })

  it('does not treat legacy.admin as a wildcard permission', () => {
    const store = useAdminStore()
    store.setAdminPrincipal({
      id: 'admin-principal',
      displayName: 'Security Admin',
      source: 'independent',
      permissions: ['legacy.admin'],
      adminSessionStatus: 'active'
    })

    expect(store.canManage).toBe(true)
    expect(store.hasPermission('legacy.admin')).toBe(true)
    expect(store.hasPermission('system.config')).toBe(false)

    const groups = getAccountNavGroups({
      surface: 'manage',
      canManage: store.canManage,
      permissions: store.permissions,
      features: {
        anonymousCommentsEnabled: true,
        zkAnonymousEnabled: true,
        publicSendOptionEnabled: true
      },
      policies: {
        anonymousCommentGovernanceAvailable: true,
        zkAnonymousConfigurable: true
      }
    })
    const labels = groups.flatMap((group) => group.items.map((item) => item.label))

    expect(labels).toContain('仪表盘')
    expect(labels).not.toContain('安全系统')
    expect(labels).not.toContain('用户')
  })

  it('hydrates independent admin principals from the admin session endpoint', async () => {
    const authApi = await import('@/api/auth') as { getAdminMe: ReturnType<typeof vi.fn> }
    authApi.getAdminMe.mockResolvedValue({
      id: '1',
      displayName: 'local-root',
      source: 'independent',
      permissions: ['admin.manage', 'article.write'],
      adminSessionStatus: 'active',
      totpStepUpRequired: false
    })
    const store = useAdminStore()

    await store.ensureAdminSessionFresh(null)

    expect(authApi.getAdminMe).toHaveBeenCalledTimes(1)
    expect(store.canManage).toBe(true)
    expect(store.hasPermission('admin.manage')).toBe(true)
    expect(store.hasPermission('article.write')).toBe(true)
  })

  it('derives anonymous comment policy states for manage workspace controls', () => {
    const store = useAdminStore()

    store.setAnonymousCommentPolicy({
      anonymousCommentsEnabled: false,
      publicSendOptionEnabled: true,
      zkAnonymousEnabled: true
    })

    expect(store.publicOnlyMode).toBe(true)
    expect(store.anonymousCommentsEnabled).toBe(false)
    expect(store.zkAnonymousEnabled).toBe(true)
  })
})
