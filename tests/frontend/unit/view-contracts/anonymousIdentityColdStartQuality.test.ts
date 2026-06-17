import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('anonymous identity cold-start quality gates', () => {
  const workspaceContext = readRepoFile('src/frontend/src/layouts/accountWorkspaceContext.ts')
  const accountNav = readRepoFile('src/frontend/src/layouts/accountNav.ts')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const detailComposable = readRepoFile('src/frontend/src/composables/useArticleDetailView.ts')
  const composerContract = readRepoFile('src/frontend/src/view-contracts/commentDetail.ts')
  const commentApi = readRepoFile('src/frontend/src/api/comment.ts')
  const frameTypes = readRepoFile('src/frontend/wasm/web/protocol/frame.ts')
  const binaryIndex = readRepoFile('src/frontend/src/adapters/binary/index.ts')
  const commentApiTest = readRepoFile('tests/frontend/unit/api/comment.test.ts')

  it('keeps AccountLayout manage context independent from legacy user role', () => {
    expect(workspaceContext).toContain("import { useAdminStore } from '@/store/admin'")
    expect(workspaceContext).toContain('const adminStore = useAdminStore()')
    expect(workspaceContext).toContain('canManage: adminStore.canManage')
    expect(workspaceContext).toContain('permissions: adminStore.permissions')
    expect(workspaceContext).toContain("surface === 'manage' ? adminStore.logout : userStore.logout")
    expect(workspaceContext).not.toContain('userStore.isAdmin')

    expect(accountNav).toContain('requiredPermission?: string')
    expect(accountNav).toContain('requiredFeature?: AccountWorkspaceFeatureKey')
    expect(accountNav).toContain('requiredPolicy?: AccountWorkspacePolicyKey')
    expect(accountNav).toContain('isNavItemVisible')
    expect(accountNav).toContain('hasPermission(context.permissions')
    expect(accountNav).toContain("to: '/user/manage/moderation/anonymous-policy'")
    expect(accountNav).toContain("requiredPermission: 'anonymous.comment.configure'")
    expect(accountNav).toContain("requiredFeature: 'anonymousCommentsEnabled'")
  })

  it('keeps anonymous comments default and public sending explicit in the client flow', () => {
    expect(detailComposable).toContain("const commentAuthorMode = ref<CommentAuthorMode>('anonymous')")
    expect(detailComposable).toContain('const publicSendConfirmed = ref(false)')
    expect(detailComposable).toContain("selectedAuthorMode === 'public' && !publicSendConfirmed.value")
    expect(detailComposable).toContain("selectedAuthorMode === 'anonymous' && !anonymousCommentsEnabled.value")
    expect(detailComposable).toContain('await createCommentV2')
    expect(detailComposable).toContain('publicSendExplicitlySelected: publicSendConfirmed.value')
    expect(detailComposable).toContain('anonymousScope: commentAnonymousScope.value')
    expect(detailComposable).toContain('displayLanguage: commentDisplayLanguage.value')
    expect(detailComposable).toContain("commentAuthorMode.value = anonymousCommentsEnabled.value ? 'anonymous' : 'public'")

    expect(composer).toContain('el-radio-group')
    expect(composer).toContain('el-radio-button label="anonymous"')
    expect(composer).toContain('el-radio-button label="public"')
    expect(composer).toContain('el-checkbox')
    expect(composer).toContain('我确认公开发送此评论')
    expect(composer).toContain('匿名评论已被管理员关闭')

    expect(composerContract).toContain('publicBlocked')
    expect(composerContract).toContain('anonymousBlocked')
    expect(composerContract).toContain('zkBlocked')
  })

  it('pins frontend binary frames and author adapters for anonymous identity contracts', () => {
    for (const [name, value] of [
      ['RecoveryKeyCreateResponse', 159],
      ['RecoveryKeyVerifyRequest', 160],
      ['RecoveryKeyVerifyResponse', 161],
      ['RecoveryKeySessionRequest', 162],
      ['IdentityAccountSnapshot', 163],
      ['CommentPolicySnapshot', 164],
      ['CommentPolicyUpdateRequest', 165],
      ['CommentCreateV2Request', 166],
      ['CommentAuthorView', 167]
    ] as const) {
      expect(frameTypes).toContain(`${name} = ${value}`)
    }

    expect(binaryIndex).toContain('[FrameType.RecoveryKeyCreateResponse]: mapRecoveryKeyCreateResponseFromPayload')
    expect(binaryIndex).toContain('[FrameType.RecoveryKeyVerifyResponse]: mapRecoveryKeyVerifyResponseFromPayload')
    expect(binaryIndex).toContain('[FrameType.CommentPolicySnapshot]: mapCommentPolicySnapshotFromPayload')
    expect(commentApi).toContain('export interface CommentAuthorView')
    expect(commentApi).toContain('export interface CommentCreateV2Dto')
    expect(commentApi).toContain('resolveCommentAuthorView')
    expect(commentApiTest).toContain('createComment uses CommentCreateV2 for anonymous author fields')
    expect(commentApiTest).toContain('resolves legacy usernames through CommentAuthorView compatibility')
  })

  it('documents the operator smoke flow and intentional destructive reset scope', () => {
    const docPath = repoFile('docs/anonymous-identity-smoke-flow.md')
    expect(existsSync(docPath)).toBe(true)
    const doc = readFileSync(docPath, 'utf8')

    for (const requiredStep of [
      'cold-start reset',
      'bootstrap admin',
      'Passkey registration/login',
      'Recovery Key creation/recovery',
      'anonymous default comment submission',
      'public opt-in comment submission',
      'moderation review',
      'old users and historical comments are intentionally cleared'
    ]) {
      expect(doc).toContain(requiredStep)
    }
  })
})
