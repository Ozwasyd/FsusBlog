import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('anonymous comment product rule contract', () => {
  const commentApi = readRepoFile('src/frontend/src/api/comment.ts')
  const detailComposable = readRepoFile('src/frontend/src/composables/useArticleDetailView.ts')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const governance = readRepoFile('src/frontend/src/views/admin/moderation/AnonymousGovernancePlaceholder.vue')

  it('loads server CommentPolicySnapshot for article composer controls', () => {
    expect(commentApi).toContain('getCommentPolicySnapshot')
    expect(commentApi).toContain("binaryUrl: '/api/binary/comment/policy'")
    expect(commentApi).toContain('FrameType.CommentPolicySnapshot')

    expect(detailComposable).toContain('getCommentPolicySnapshot')
    expect(detailComposable).toContain('loadCommentPolicySnapshot')
    expect(detailComposable).toContain('anonymousCommentsEnabled.value = policy.anonymousCommentsEnabled')
    expect(detailComposable).toContain('publicCommentsEnabled.value = policy.publicCommentsEnabled')
    expect(detailComposable).toContain('zkAnonymousEnabled.value = policy.zkAnonymousEnabled')
    expect(detailComposable).toContain("commentAuthorMode.value = anonymousCommentsEnabled.value ? 'anonymous' : 'public'")
  })

  it('keeps anonymous default, explicit public opt-in, and admin-disabled UI states', () => {
    expect(detailComposable).toContain("const commentAuthorMode = ref<CommentAuthorMode>('anonymous')")
    expect(detailComposable).toContain('const publicSendConfirmed = ref(false)')
    expect(detailComposable).toContain("selectedAuthorMode === 'public' && !publicSendConfirmed.value")
    expect(detailComposable).toContain("selectedAuthorMode === 'anonymous' && !anonymousCommentsEnabled.value")

    expect(composer).toContain('el-radio-button label="anonymous"')
    expect(composer).toContain('el-radio-button label="public"')
    expect(composer).toContain('el-checkbox')
    expect(composer).toContain('我确认公开发送此评论')
    expect(composer).toContain('匿名评论已被管理员关闭，当前只能公开发送。')

    expect(governance).toContain("updatePolicy('anonymousCommentsEnabled'")
    expect(governance).toContain("updatePolicy('zkAnonymousEnabled'")
    expect(governance).toContain('anonymous.credential.revoke')
    expect(governance).toContain('anonymous.nullifier.block')
  })
})
