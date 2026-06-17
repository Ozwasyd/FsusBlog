import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('identity center workflow contract', () => {
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const accountNav = readRepoFile('src/frontend/src/layouts/accountNav.ts')
  const identityCenter = readRepoFile('src/frontend/src/views/user/IdentityCenter.vue')

  it('routes identity-center pages through the existing AccountLayout shell', () => {
    expect(router).toContain("component: () => import('@/layouts/AccountLayout.vue')")
    expect(router).toContain("component: () => import('@/views/user/IdentityCenter.vue')")
    expect(router).not.toContain("component: () => import('@/views/user/IdentityCenterPlaceholder.vue')")
    expect(router).toContain("name: 'UserIdentityOverview'")
    expect(router).toContain("name: 'UserIdentityPasskeys'")
    expect(router).toContain("name: 'UserIdentityRecoveryKey'")
    expect(router).toContain("name: 'UserIdentityAnonymous'")
    expect(router).toContain("name: 'UserIdentityPublicProfile'")
    expect(router).toContain("name: 'UserIdentitySessions'")
    expect(router).toContain("name: 'UserIdentityMfa'")
    expect(router).toContain("name: 'UserIdentityCommentRecords'")
    expect(accountNav).toContain("to: '/user/identity/comment-records'")
  })

  it('renders real identity pages with workspace context and existing client assets', () => {
    expect(identityCenter).toContain('useAccountWorkspaceContext')
    expect(identityCenter).toContain('identityAccountSnapshot')
    expect(identityCenter).toContain('workspaceContext.value.features')
    expect(identityCenter).toContain('workspaceContext.value.policies')
    expect(identityCenter).toContain('usePasskeyManagement')
    expect(identityCenter).toContain('PasskeyRegisterModal')
    expect(identityCenter).toContain('createRecoveryKey')
    expect(identityCenter).toContain('rotateRecoveryKey')
    expect(identityCenter).toContain('getMfaProfile')
    expect(identityCenter).toContain('listSessions')
    expect(identityCenter).toContain('revokeOtherSessions')
    expect(identityCenter).toContain('Recovery Key 只显示一次')
    expect(identityCenter).toContain('TOTP 是敏感操作 step-up，不是账号恢复方式')
    expect(identityCenter).toContain('强匿名评论不会出现在按账号查询的评论记录中')
    expect(identityCenter).not.toContain('username/password')
    expect(identityCenter).not.toContain('IdentityCenterPlaceholder')
  })

  it('keeps page states explicit for loading, empty, and recoverable errors', () => {
    expect(identityCenter).toContain('identity-loading-state')
    expect(identityCenter).toContain('identity-empty-state')
    expect(identityCenter).toContain('identity-error-state')
    expect(identityCenter).toContain('passkeyError')
    expect(identityCenter).toContain('recoveryKeyError')
    expect(identityCenter).toContain('sessionError')
    expect(identityCenter).toContain('mfaError')
  })
})
