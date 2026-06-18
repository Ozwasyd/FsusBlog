import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const vueTemplate = (source: string): string => source.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? ''

describe('anonymous comment author workflow contract', () => {
  const api = readRepoFile('src/frontend/src/api/comment.ts')
  const composer = readRepoFile('src/frontend/src/components/article/ArticleCommentComposer.vue')
  const composerTemplate = vueTemplate(composer)
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
    expect(composer).toContain('publicIdentityModel')
    expect(composer).toContain('anonymousUnavailableMessage')
    expect(composer).toContain('publicSendConfirmed')
    expect(composerTemplate).toContain('匿名发布')
    expect(composerTemplate).toContain('公开显示我的名称')
    expect(composerTemplate).toContain('公开发布后，其他人会看到你的公开名称。')
    expect(composerTemplate).toContain('匿名发布暂不可用，可选择公开署名发布。')
    expect(composerTemplate).not.toContain('el-radio-button label="anonymous"')
    expect(composerTemplate).not.toContain('el-radio-button label="public"')
    expect(composerTemplate).not.toContain('zk_anonymous')
    expect(composerTemplate).not.toContain('强匿名')
    expect(composerTemplate.toLowerCase()).not.toContain('proof')
    expect(composerTemplate).not.toContain('凭证')
    expect(composerTemplate.toLowerCase()).not.toContain('nullifier')
    expect(composerTemplate.toLowerCase()).not.toContain('root')
    expect(composerTemplate.toLowerCase()).not.toContain('circuit')
    expect(detailComposable).toContain("const commentAuthorMode = ref<CommentAuthorMode>('anonymous')")
    expect(detailComposable).toContain('publicSendExplicitlySelected: publicSendConfirmed.value')
    expect(detailComposable).toContain('anonymousScope: commentAnonymousScope.value')
    expect(detailComposable).toContain('displayLanguage: commentDisplayLanguage.value')
    expect(detailComposable).toContain('createCommentV2')
  })

  it('routes public mode only through the explicit checkbox model', () => {
    expect(composer).toContain('const publicIdentityModel = computed')
    expect(composer).toContain("emit('update:authorMode', value ? 'public' : 'anonymous')")
    expect(composer).toContain("emit('update:publicSendConfirmed', value)")
    expect(composer).toContain('publicIdentityModel.value')
  })
})
