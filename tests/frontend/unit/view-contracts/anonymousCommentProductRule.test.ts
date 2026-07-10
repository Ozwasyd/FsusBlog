import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const vueTemplate = (source: string): string => source.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? ''

describe('anonymous comment product rule contract', () => {
  const commentApi = readRepoFile('src/frontend/src/api/comment.ts')
  const detailComposable = readRepoFile('src/frontend/src/composables/useArticleDetailView.ts')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const composerTemplate = vueTemplate(composer)
  const governance = readRepoFile('src/frontend/src/views/admin/moderation/AnonymousGovernancePage.vue')

  it('loads server CommentPolicySnapshot for article composer controls', () => {
    expect(commentApi).toContain('getCommentPolicySnapshot')
    expect(commentApi).toContain("binaryRoute: { operationId: 'binary_get_comment_policy' }")
    expect(commentApi).toContain('FrameType.CommentPolicySnapshot')

    expect(detailComposable).toContain('getCommentPolicySnapshot')
    expect(detailComposable).toContain('loadCommentPolicySnapshot')
    expect(detailComposable).toContain('anonymousCommentsEnabled.value = policy.anonymousCommentsEnabled')
    expect(detailComposable).toContain('publicCommentsEnabled.value = policy.publicCommentsEnabled')
    expect(detailComposable).toContain('zkProdAvailable')
    expect(detailComposable).toContain('zkProdNativeVerifierConfigured')
    expect(detailComposable).toContain('zkProdTrustedSetupVerified')
    expect(detailComposable).toContain('zkProdCredentialRootReady')
    expect(detailComposable).toContain('zkAnonymousEnabled.value = policy.zkAnonymousEnabled && zkProdAvailable')
    expect(detailComposable).toContain("commentAuthorMode.value = anonymousCommentsEnabled.value ? 'anonymous' : 'public'")
  })

  it('keeps anonymous default, explicit public opt-in, and admin-disabled UI states', () => {
    expect(detailComposable).toContain("const commentAuthorMode = ref<CommentAuthorMode>('anonymous')")
    expect(detailComposable).toContain('const publicSendConfirmed = ref(false)')
    expect(detailComposable).toContain("selectedAuthorMode === 'public' && !publicSendConfirmed.value")
    expect(detailComposable).toContain("selectedAuthorMode === 'anonymous' && !anonymousCommentsEnabled.value")

    expect(composerTemplate).not.toContain('el-radio-button label="anonymous"')
    expect(composerTemplate).not.toContain('el-radio-button label="public"')
    expect(composerTemplate).not.toContain('zk_anonymous')
    expect(composerTemplate).not.toContain('强匿名')
    expect(composerTemplate.toLowerCase()).not.toContain('proof')
    expect(composerTemplate).toContain('comment-identity-toggle__input')
    expect(composerTemplate).toContain('type="checkbox"')
    expect(composerTemplate).toContain('匿名发布')
    expect(composerTemplate).toContain('公开显示我的名称')
    expect(composerTemplate).toContain('公开发布后，其他人会看到你的公开名称。')
    expect(composerTemplate).toContain('匿名发布暂不可用，可选择公开署名发布。')

    expect(governance).toContain("updatePolicy('anonymousCommentsEnabled'")
    expect(governance).toContain("updatePolicy('zkAnonymousEnabled'")
    expect(governance).toContain('anonymous.credential.revoke')
    expect(governance).toContain('anonymous.nullifier.block')
  })
})
