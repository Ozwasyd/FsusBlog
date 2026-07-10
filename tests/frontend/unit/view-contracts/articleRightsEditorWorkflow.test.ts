import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('admin article rights editor workflow contract', () => {
  const writePage = readRepoFile('src/frontend/src/views/admin/article/Write.vue')
  const writeComposable = readRepoFile('src/frontend/src/composables/useAdminArticleWrite.ts')
  const authoringApi = readRepoFile('src/frontend/src/api/authoring.ts')
  const articleApi = readRepoFile('src/frontend/src/api/article.ts')
  const apiDocs = readRepoFile('docs/api/contracts.md')

  it('renders every Rights V3 write-contract field in the article editor', () => {
    expect(writePage).toContain('版权保护')
    expect(writePage).toContain('版权与转载设置')
    expect(writePage).not.toContain('text-[13px] font-semibold normal-case tracking-normal text-[var(--fsusblog-text-primary)]">版权保护')
    expect(writePage).toContain('默认使用站点版权设置；需要单篇不同规则时切换为自定义。')
    expect(writePage).toContain('版权来源')
    expect(writePage).toContain('继承站点设置')
    expect(writePage).toContain('自定义本文版权')
    expect(writePage).toContain('articleRightsUsingSiteDefaults')
    expect(writePage).toContain('articleForm.rights.enabled')
    expect(writePage).toContain('articleForm.rights.licenseType')
    expect(writePage).toContain('articleForm.rights.copyrightHolder')
    expect(writePage).toContain('articleForm.rights.copyrightYear')
    expect(writePage).toContain('articleForm.rights.rightsStatement')
    expect(writePage).toContain('articleForm.rights.attributionTemplate')
    expect(writePage).toContain('articleForm.rights.copyPolicy')
    expect(writePage).toContain('articleForm.rights.maxExcerptChars')
    expect(writePage).toContain('articleForm.rights.allowCodeCopy')
    expect(writePage).toContain('articleForm.rights.showPublicBadge')
    expect(writePage).toContain('articleForm.rights.proofBindingEnabled')
  })

  it('wires rights through defaults, edit loading, server drafts, preview, and submit', () => {
    expect(articleApi).toContain('export interface ArticleRightsRequest')
    expect(authoringApi).toContain('rights: ArticleRightsRequest')
    expect(writeComposable).toContain('interface ArticleRightsForm')
    expect(writeComposable).toContain("mode: 'site' | 'custom'")
    expect(writeComposable).toContain('createDefaultArticleRightsForm')
    expect(writeComposable).toContain('rights: createDefaultArticleRightsForm()')
    expect(writeComposable).toContain('getAdminSiteComplianceConfig')
    expect(writeComposable).toContain('siteInheritedRights')
    expect(writeComposable).toContain('setArticleRightsMode')
    expect(writeComposable).toContain('encodeLocalDraftMetadata(snapshot)')
    expect(writeComposable).toContain("schema: 'fsusblog.article-draft-metadata.v1'")
    expect(writeComposable).not.toContain('toLocalDraftSnapshot')
    expect(writeComposable).toContain('rights: { ...snapshot.rights }')
    expect(writeComposable).toContain('rights: normalizeArticleRightsForm(draft.rights)')
    expect(writeComposable).toContain("articleForm.rights = { ...normalizeArticleRightsForm(data.rights), mode: 'custom' }")
    expect(writeComposable).toContain('rights: buildArticleRightsRequest()')
  })

  it('keeps unpublished content out of browser persistence and explains server-only recovery', () => {
    expect(writePage).toContain('尚未同步的更改只保留在当前页面')
    expect(writePage).toContain('返回编辑页后只能恢复已同步的服务端草稿')
    expect(writePage).not.toContain('当前内容已写入浏览器本地缓存')
    expect(writeComposable).toContain('const requiresLeaveConfirm = computed(() => hasDraftContent(articleForm) || hasLocalDraft.value)')
    expect(apiDocs).toContain('浏览器 localStorage 只保存不可恢复正文的草稿 metadata')
    expect(apiDocs).toContain('完整 `rights` 只写入 `ServerDraftSaveRequest`')
  })

  it('validates rights enums, year, excerpt length, and required text before submit', () => {
    expect(writeComposable).toContain('validateArticleRights')
    expect(writeComposable).toContain('ARTICLE_RIGHTS_LICENSE_TYPES.includes')
    expect(writeComposable).toContain('ARTICLE_RIGHTS_COPY_POLICIES.includes')
    expect(writeComposable).toContain('Number.isInteger(rights.copyrightYear)')
    expect(writeComposable).toContain('rights.maxExcerptChars < 0')
    expect(writeComposable).toContain('licenseType.trim().length === 0')
    expect(writeComposable).toContain('copyPolicy.trim().length === 0')
    expect(writeComposable).toContain('if (!validateArticleRights())')
  })

  it('documents the panel fields and server-authoritative validation boundary', () => {
    expect(apiDocs).toContain('Admin Rights V3 editor panel')
    expect(apiDocs).toContain('licenseType')
    expect(apiDocs).toContain('copyPolicy')
    expect(apiDocs).toContain('maxExcerptChars')
    expect(apiDocs).toContain('server-side validation remains authoritative')
  })
})
