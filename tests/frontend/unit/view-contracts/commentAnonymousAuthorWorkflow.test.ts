import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const vueTemplate = (source: string): string => source.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? ''

describe('anonymous comment author workflow contract', () => {
  const api = readRepoFile('src/frontend/src/api/comment.ts')
  const commentDetailContract = readRepoFile('src/frontend/src/view-contracts/commentDetail.ts')
  const sharedContracts = readRepoFile('src/shared/Contracts/Outputs/ServerResponseContracts.cs')
  const coreReadModels = readRepoFile('src/core/Mapping/Models/ReadModels.cs')
  const apiContractsDoc = readRepoFile('docs/api/contracts.md')
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
    expect(api).toContain('export const createAnonymousComment')
    expect(api).toContain('export const createPublicComment')
    expect(api).toContain('resolveCommentAuthorView')
    expect(api).toContain('comment_author_contract_missing')
    expect(api).toContain('throw createAppError')
  })

  it('renders comment authors through CommentAuthorView instead of legacy username fields', () => {
    expect(adapter).toContain('resolveCommentAuthorView')
    expect(adapter).toContain('readRequiredEmbeddedAuthorView')
    expect(adapter).toContain('comment_author_contract_missing')
    expect(commentList).toContain('thread.author.displayName')
    expect(commentList).toContain('reply.author.displayName')
    expect(commentList).toContain('reply.replyToAuthor?.displayName')
    expect(commentList).not.toContain('{{ thread.userName }}')
    expect(commentList).not.toContain('{{ reply.userName }}')
  })

  it('keeps public comment read contracts snapshot-only without legacy identity fields', () => {
    for (const block of [
      extractTsInterface(api, 'CommentReplyItem'),
      extractTsInterface(api, 'CommentReplyPreviewItem'),
      extractTsInterface(api, 'CommentThreadItem'),
      extractTsInterface(api, 'UserCommentResponse'),
      extractTsInterface(commentDetailContract, 'CommentThreadItemContract')
    ]) {
      expect(block).toContain('author')
      expect(block).not.toMatch(/\b(?:authorId|userName|replyToUserId|replyToUserName)\b/)
    }

    for (const block of [
      extractCSharpRecord(sharedContracts, 'UserCommentResponse'),
      extractCSharpRecord(sharedContracts, 'CommentReplyItemDto'),
      extractCSharpRecord(sharedContracts, 'CommentReplyPreviewItemDto'),
      extractCSharpRecord(sharedContracts, 'CommentThreadItemDto'),
      extractCSharpRecord(coreReadModels, 'UserCommentCoreModel')
    ]) {
      expect(block).toContain('Author')
      expect(block).not.toMatch(/\b(?:AuthorId|UserName|ReplyToUserId|ReplyToUserName)\b/)
    }

    const commentDoc = extractMarkdownSection(apiContractsDoc, '## 评论契约', '## 分类与标签契约')
    expect(commentDoc).toContain('replyToAuthor')
    expect(commentDoc).not.toMatch(/\b(?:authorId|userName|replyToUserId|replyToUserName)\b/)
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
    expect(detailComposable).toContain('await createAnonymousComment')
    expect(detailComposable).toContain('await createPublicComment')
    expect(detailComposable).toContain('publicSendExplicitlySelected: true')
    expect(detailComposable).toContain('anonymousScope: commentAnonymousScope.value')
    expect(detailComposable).toContain('displayLanguage: commentDisplayLanguage.value')
    expect(detailComposable).toContain("showErrorToast('匿名发布暂不可用，请稍后重试。')")
    expect(detailComposable).not.toContain('proofToken: privacyTicket')
    expect(detailComposable).not.toContain('zkProof: privacyTicket')
  })

  it('keeps anonymous submit one-shot without public fallback or sensitive console output', () => {
    expect(detailComposable).toContain('anonymousSubmitScopesInFlight')
    expect(detailComposable).toContain('commentPrivacyRuntime.consumePreparedTicket(commentAnonymousScope.value)')
    expect(detailComposable).toContain('commentPrivacyRuntime.prepareAnonymousTicket(commentAnonymousScope.value)')
    expect(detailComposable).toContain('anonymousSubmitScopesInFlight.add(anonymousSubmitScope)')
    expect(detailComposable).toContain('anonymousSubmitScopesInFlight.delete(anonymousSubmitScope)')
    expect(detailComposable).toContain("selectedAuthorMode === 'anonymous'")
    expect(detailComposable).toContain("showErrorToast('匿名发布暂不可用，请稍后重试。')")
    expect(detailComposable).not.toMatch(/console\.(?:error|warn|log)\([^)]*(?:privacyTicket|ticket|proof|credential|nullifier)/i)
  })

  it('routes public mode only through the explicit checkbox model', () => {
    expect(composer).toContain('const publicIdentityModel = computed')
    expect(composer).toContain("emit('update:authorMode', value ? 'public' : 'anonymous')")
    expect(composer).toContain("emit('update:publicSendConfirmed', value)")
    expect(composer).toContain('publicIdentityModel.value')
  })
})

function extractTsInterface(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name} \\{[\\s\\S]*?\\n\\}`))
  expect(match, `Missing TypeScript interface ${name}`).not.toBeNull()
  return match![0]
}

function extractCSharpRecord(source: string, name: string): string {
  const start = source.indexOf(name)
  expect(start, `Missing C# record ${name}`).toBeGreaterThanOrEqual(0)
  const nextRecord = source.indexOf('\npublic ', start + name.length)
  return source.slice(start, nextRecord === -1 ? source.length : nextRecord)
}

function extractMarkdownSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, `Missing markdown start ${startMarker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, `Missing markdown end ${endMarker}`).toBeGreaterThanOrEqual(0)
  return source.slice(start, end)
}
