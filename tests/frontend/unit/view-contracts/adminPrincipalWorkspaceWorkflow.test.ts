import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => {
  const file = repoFile(path)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

describe('admin principal workspace workflow contract', () => {
  const adminStore = readRepoFile('src/frontend/src/store/admin.ts')
  const workspaceContext = readRepoFile('src/frontend/src/layouts/accountWorkspaceContext.ts')
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const accountLayout = readRepoFile('src/frontend/src/layouts/AccountLayout.vue')

  it('defines independent admin principal state and anonymous-comment policy controls', () => {
    expect(adminStore).toContain('export const useAdminStore')
    expect(adminStore).toContain('export interface AdminPrincipalSnapshot')
    expect(adminStore).toContain('adminSessionStatus')
    expect(adminStore).toContain('permissions')
    expect(adminStore).toContain('anonymousCommentsEnabled')
    expect(adminStore).toContain('zkAnonymousEnabled')
    expect(adminStore).toContain('publicOnlyMode')
    expect(adminStore).toContain('logout')
  })

  it('lets AccountLayout workspace read manage state from the admin store', () => {
    expect(workspaceContext).toContain("import { useAdminStore } from '@/store/admin'")
    expect(workspaceContext).toContain('const adminStore = useAdminStore()')
    expect(workspaceContext).toContain('canManage: adminStore.canManage')
    expect(workspaceContext).toContain('permissions: adminStore.permissions')
    expect(workspaceContext).toContain("surface === 'manage' ? adminStore.logout : userStore.logout")
    expect(workspaceContext).not.toContain('const canManage = userStore.isAdmin')
    expect(accountLayout).toContain('workspaceContext.value.logout()')
  })

  it('authorizes manage routes by permissions instead of normal user role', () => {
    expect(router).toContain("import { useAdminStore } from '@/store/admin'")
    expect(router).toContain('const manageMeta =')
    expect(router).toContain('permissions')
    expect(router).toContain('readRouteRequiredPermissions')
    expect(router).toContain('adminStore.hasPermission')
    expect(router).toContain("manageMeta('匿名评论策略', ['anonymous.comment.configure'])")
    expect(router).toContain("manageMeta('评论审核', ['comment.moderate'])")
    expect(router).toContain("manageMeta('系统设置', ['system.config'])")
    expect(router).toContain("return '/403'")
    expect(router).not.toContain("if (userRole === 'guest' && to.path.startsWith('/user/manage'))")
  })
})
