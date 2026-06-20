import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAdminStore } from '@/store/admin'
import type { CurrentUserSnapshot } from '@/api/auth'

vi.mock('@/api/auth', () => ({
  getAdminMe: vi.fn()
}))

const user = (role: string): CurrentUserSnapshot => ({
  id: role === 'admin' ? 1 : 2,
  username: role === 'admin' ? 'admin' : 'guest',
  role,
  status: 0,
  banReason: null
})

describe('useAdminStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('bridges legacy admin users into an active admin principal', () => {
    const store = useAdminStore()

    store.syncLegacyAdminPrincipal(user('admin'))

    expect(store.adminSessionStatus).toBe('active')
    expect(store.canManage).toBe(true)
    expect(store.hasPermission('article.write')).toBe(true)
    expect(store.hasPermission('anonymous.comment.configure')).toBe(true)
  })

  it('clears only legacy principals when normal users are synced', () => {
    const store = useAdminStore()

    store.syncLegacyAdminPrincipal(user('admin'))
    store.syncLegacyAdminPrincipal(user('guest'))

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

    store.syncLegacyAdminPrincipal(user('guest'))

    expect(store.canManage).toBe(true)
    expect(store.hasPermission('comment.moderate')).toBe(true)
    expect(store.hasPermission('article.write')).toBe(false)
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
