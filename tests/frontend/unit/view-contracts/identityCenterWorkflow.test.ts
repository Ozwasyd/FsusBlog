import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const listRepoFiles = (path: string): string[] => {
  const root = repoFile(path)
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
  return walk(root)
}

describe('identity center workflow contract', () => {
  const router = readRepoFile('src/frontend/src/router/index.ts')
  const accountNav = readRepoFile('src/frontend/src/layouts/accountNav.ts')
  const identityCenter = readRepoFile('src/frontend/src/views/user/IdentityCenter.vue')
  const identityCopy = readRepoFile('src/frontend/src/copy/identity.ts')
  const passkeyManagement = readRepoFile('src/frontend/src/composables/usePasskeyManagement.ts')
  const profile = readRepoFile('src/frontend/src/views/user/Profile.vue')
  const userViewSources = listRepoFiles('src/frontend/src/views/user')
    .filter((file) => /\.(vue|ts)$/.test(file))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n')

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

  it('redirects the legacy profile route to the anonymous identity center', () => {
    expect(router).toContain("path: ACCOUNT_ROUTE_PATHS.profileChild")
    expect(router).toContain("redirect: { name: 'UserIdentityOverview' }")
    expect(accountNav).not.toContain("to: ACCOUNT_ROUTE_PATHS.profile")
    expect(accountNav).toContain("to: '/user/identity'")
    expect(profile).toContain("router.replace({ name: 'UserIdentityOverview' })")
    expect(profile).toContain('profileCopy.pageTitle')
    expect(identityCopy).toContain("pageTitle: '身份中心'")
    expect(profile).not.toContain('账号信息')
    expect(profile).not.toContain('安全验证')
    expect(profile).not.toContain('当前密码')
    expect(profile).not.toContain('新密码')
    expect(profile).not.toContain('确认新密码')
    expect(profile).not.toContain('deleteAccountState')
  })

  it('renders real identity pages with workspace context and existing client assets', () => {
    expect(identityCenter).toContain('useAccountWorkspaceContext')
    expect(identityCenter).toContain('identityAccountSnapshot')
    expect(identityCenter).toContain('workspaceFeatures')
    expect(identityCenter).toContain('workspacePolicies')
    expect(identityCenter).not.toContain('{{ workspaceContext.value')
    expect(identityCenter).toContain('usePasskeyManagement')
    expect(identityCenter).toContain('PasskeyRegisterModal')
    expect(identityCenter).toContain('createRecoveryKey')
    expect(identityCenter).toContain('rotateRecoveryKey')
    expect(identityCenter).toContain('updatePublicHandle')
    expect(identityCenter).toContain('savePublicHandle')
    expect(identityCenter).toContain('publicHandleSaving')
    expect(identityCenter).toContain('publicHandleError')
    expect(identityCenter).toContain('@click="savePublicHandle"')
    expect(identityCenter).not.toContain('user?.username')
    expect(identityCenter).not.toMatch(/publicHandle:[^\n]*username/u)
    expect(identityCenter).toContain('MfaSetupModal')
    expect(identityCenter).toContain('startMfaSetup')
    expect(identityCenter).toContain('verifyMfaSetup')
    expect(identityCenter).toContain('getMfaProfile')
    expect(identityCenter).toContain('listSessions')
    expect(identityCenter).toContain('revokeOtherSessions')
    expect(identityCenter).toContain('deleteAccount')
    expect(identityCenter).toContain("startMfaChallenge('account.delete')")
    expect(identityCenter).toContain("startMfaChallenge('passkey.delete')")
    expect(identityCenter).toContain("startMfaChallenge('passkey.credential-name.update')")
    expect(identityCenter).toContain("startMfaChallenge('recovery-key.create')")
    expect(identityCenter).toContain("startMfaChallenge('recovery-key.rotate')")
    expect(identityCenter).toContain('mfaProofToken: proof.proofToken')
    expect(identityCenter).toContain('createRecoveryKey({ mfaProofToken: proofToken })')
    expect(identityCenter).toContain('rotateRecoveryKey({ mfaProofToken: proofToken })')
    expect(identityCenter).toContain("confirmText: 'DELETE'")
    expect(identityCopy).toContain('匿名账号敏感操作校验')
    expect(identityCopy).toContain('注销账户')
    expect(identityCopy).toContain('明文不保存；仅创建或轮换后显示。')
    expect(identityCopy).toContain('敏感操作验证；账号恢复使用 Recovery Key。')
    expect(identityCenter).not.toContain('to="/user/profile#profile-security"')
    expect(identityCopy).toContain('公开发送的评论会进入账号记录。匿名评论不会按账号检索。')
    expect(identityCopy).not.toContain('可归因评论')
    expect(identityCenter).toContain(":title-tag=\"'h2'\"")
    expect(identityCenter).not.toMatch(/(^|\s)title-level="2"/u)
    expect(identityCenter).not.toContain('username/password')
    expect(identityCenter).not.toContain('IdentityCenterPlaceholder')
  })

  it('keeps old password profile fields out of production user views', () => {
    for (const token of [
      'profileOldPassword',
      'profileNewPassword',
      'profileConfirmPassword',
      'deleteAccountPassword',
      'updateUsername',
      'updatePassword',
      'deleteAccountState',
      'passwordForm'
    ]) {
      expect(userViewSources).not.toContain(token)
    }
  })

  it('routes passkey mutations through header-only step-up proof tokens', () => {
    expect(passkeyManagement).toContain('removePasskey = async (id: number, mfaProofToken?: string | null)')
    expect(passkeyManagement).toContain('deletePasskey(id, { mfaProofToken })')
    expect(passkeyManagement).toContain('renamePasskeyCredential = async (id: number, name: string, mfaProofToken?: string | null)')
    expect(passkeyManagement).toContain('renamePasskey(id, name, { mfaProofToken })')
    expect(passkeyManagement).not.toContain('MfaPasswordProofRequest')
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
