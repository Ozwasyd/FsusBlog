import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('anonymous comment author workflow contract', () => {
  const api = readRepoFile('src/frontend/src/api/comment.ts')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const commentList = readRepoFile('src/frontend/src/components/article/ArticleCommentsVirtualList.vue')
  const detailComposable = readRepoFile('src/frontend/src/composables/useArticleDetailView.ts')
  const adapter = readRepoFile('src/frontend/src/adapters/binary/podReaders.ts')

  it('defines CommentAuthorView and an explicit CommentCreateV2 client', () => {
    expect(api).toContain('export interface CommentAuthorView')
    expect(api).toContain("mode: 'anonymous' | 'public' | 'zk_anonymous'")
    expect(api).toContain("displayLanguage: 'zh-CN' | 'en'")
    expect(api).toContain('export interface CommentCreateV2Dto')
    expect(api).toContain('export const createCommentV2')
    expect(api).toContain('resolveCommentAuthorView')
    expect(api).toContain('fixture compatibility')
  })

  it('renders comment authors through CommentAuthorView instead of legacy username fields', () => {
    expect(adapter).toContain('resolveCommentAuthorView')
    expect(adapter).toContain('author: resolveCommentAuthorView')
    expect(commentList).toContain('thread.author.displayName')
    expect(commentList).toContain('reply.author.displayName')
    expect(commentList).toContain('reply.replyToAuthor?.displayName')
    expect(commentList).not.toContain('{{ thread.userName }}')
    expect(commentList).not.toContain('{{ reply.userName }}')
  })

  it('makes the composer anonymous by default with explicit public opt-in', () => {
    expect(composer).toContain('authorModeModel')
    expect(composer).toContain('anonymousControlsDisabled')
    expect(composer).toContain('publicSendConfirmed')
    expect(composer).toContain('zk_anonymous')
    expect(composer).toContain('匿名优先')
    expect(composer).toContain('公开发送')
    expect(composer).toContain('匿名评论已被管理员关闭')
    expect(detailComposable).toContain("const commentAuthorMode = ref<CommentAuthorMode>('anonymous')")
    expect(detailComposable).toContain('publicSendExplicitlySelected: publicSendConfirmed.value')
    expect(detailComposable).toContain('anonymousScope: commentAnonymousScope.value')
    expect(detailComposable).toContain('displayLanguage: commentDisplayLanguage.value')
    expect(detailComposable).toContain('createCommentV2')
  })
})
