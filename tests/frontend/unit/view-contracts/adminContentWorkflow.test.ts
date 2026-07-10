import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')
const slice = (content: string, startMarker: string, endMarker: string): string => {
  const start = content.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = content.indexOf(endMarker, start + startMarker.length)
  expect(end).toBeGreaterThan(start)
  return content.slice(start, end)
}

describe('admin content governance workflow contract', () => {
  const articleApi = readRepoFile('src/frontend/src/api/article.ts')
  const articleEndpoint = readRepoFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Articles.cs')
  const articleService = readRepoFile('src/backend/Services/ArticleService.cs')
  const listPage = readRepoFile('src/frontend/src/views/admin/article/List.vue')
  const listComposable = readRepoFile('src/frontend/src/composables/useAdminArticleList.ts')
  const compactCard = readRepoFile('src/frontend/src/components/admin/article/AdminArticleCompactCard.vue')
  const trashPage = readRepoFile('src/frontend/src/views/admin/article/Trash.vue')
  const trashComposable = readRepoFile('src/frontend/src/composables/useAdminArticleTrash.ts')
  const categoryPage = readRepoFile('src/frontend/src/views/admin/Category.vue')
  const tagPage = readRepoFile('src/frontend/src/views/admin/Tag.vue')
  const taxonomyComposable = readRepoFile('src/frontend/src/composables/useAdminTaxonomyManage.ts')
  const taxonomyView = readRepoFile('src/frontend/src/components/admin/AdminTaxonomyManageView.vue')
  const authoringApi = readRepoFile('src/frontend/src/api/authoring.ts')
  const taxonomyEndpoint = readRepoFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs')
  const authoringEndpoint = readRepoFile('src/backend/Modules/Endpoints/AuthoringEndpoints.cs')
  const dashboardPanel = readRepoFile('src/frontend/src/components/admin/DashboardQuickActionsPanel.vue')
  const collectionToolbar = readRepoFile('src/frontend/src/components/admin/AdminCollectionToolbar.vue')
  const collectionSummary = readRepoFile('src/frontend/src/components/admin/AdminCollectionSummary.vue')
  const auditLogPage = readRepoFile('src/frontend/src/views/admin/AuditLog.vue')

  it('serializes admin keyword search through frontend and backend list queries', () => {
    expect(articleApi).toContain('params.keyword?.trim()')
    expect(articleApi).toContain("search.set('keyword', keyword)")
    expect(articleEndpoint).toContain('string? keyword')
    expect(articleEndpoint).toContain('articles.GetPageListAsync(')
    expect(articleEndpoint).toContain('keyword: keyword')
    expect(articleService).toContain('NormalizeArticleListKeyword(keyword)')
    expect(articleService).toContain('(a.title LIKE @Keyword OR a.summary LIKE @Keyword)')
    expect(articleService).toContain('@Keyword')
  })

  it('keeps permanent delete out of the active article list while preserving trash delete', () => {
    expect(listPage).not.toContain('handlePermanentRemove')
    expect(listPage).not.toContain('永久删除')
    expect(compactCard).not.toContain('permanent-remove')
    expect(trashPage).toContain('永久删除')
    expect(trashComposable).toContain('permanentDeleteArticle')
  })

  it('supports category/tag/status/keyword filters with URL sync and visible chips', () => {
    expect(listComposable).toContain('useRoute')
    expect(listComposable).toContain('hydrateQueryFromRoute')
    expect(listComposable).toContain('syncQueryToRoute')
    expect(listComposable).toContain('categoryId')
    expect(listComposable).toContain('tagId')
    expect(listComposable).toContain('activeFilterChips')
    expect(listPage).toContain('按分类筛选')
    expect(listPage).toContain('按标签筛选')
    expect(listPage).toContain('@close="removeFilter(chip.key)"')
    expect(listPage).toContain('article-list-write-button')
    expect(slice(listPage, '<AdminCollectionToolbar label="文章筛选"', '</AdminCollectionToolbar>')).not.toContain('<template #actions>')
  })

  it('shows cover thumbnails, contextual row actions, and status timestamps', () => {
    expect(listComposable).toContain('primaryActionLabel')
    expect(listComposable).toContain('继续写作')
    expect(listComposable).toContain('调整排期')
    expect(listComposable).toContain('statusTimeLabel')
    expect(listPage).toContain('v-if="row.coverImageUrl"')
    expect(listPage).toContain('class="article-cover-thumb"')
    expect(listPage).not.toContain('row.title.slice(0, 1)')
    expect(compactCard).toContain('v-if="row.coverImageUrl"')
    expect(compactCard).toContain('class="article-compact-cover"')
    expect(compactCard).not.toContain('row.title.slice(0, 1)')
  })

  it('keeps article ids on one line in the desktop table', () => {
    expect(listPage).toContain('width="96"')
    expect(listPage).toContain('class="article-id-cell tabular-nums"')
    expect(listPage).toContain('white-space: nowrap')
    expect(listPage).toContain('word-break: keep-all')
  })

  it('keeps the fixed action column aligned without segmented shadow seams', () => {
    expect(listPage).toContain('class="article-list-table"')
    expect(listPage).toContain('.article-list-table :deep(.el-table-fixed-column--right.is-first-column)')
    expect(listPage).toContain('.article-list-table :deep(.el-table-fixed-column--right.is-first-column::before)')
    expect(listPage).toContain('border-left: 1px solid var(--fsusblog-panel-border)')
    expect(listPage).toContain('box-shadow: none')
  })

  it('uses compact article cards before tablet width to avoid fixed table clipping', () => {
    expect(listPage).toContain('compact-query="(max-width: 767px)"')
    expect(listPage).toContain("const isCompactPagination = useMediaQuery('(max-width: 767px)')")
    expect(listPage).not.toContain('compact-query="(max-width: 639px)"')
    expect(listPage).not.toContain("const isCompactPagination = useMediaQuery('(max-width: 639px)')")
  })

  it('allows the article status filter to shrink before mobile zoom can push actions offscreen', () => {
    expect(listPage).toMatch(/@media \(max-width: 639px\) \{[\s\S]*?\.article-list-status-filter \{[\s\S]*?min-width: 0;/)
  })

  it('keeps the article title editor usable at extreme mobile zoom', () => {
    const writePage = readRepoFile('src/frontend/src/views/admin/article/Write.vue')

    expect(writePage).toMatch(/\.write-title-input :deep\(\.el-input__inner\) \{[\s\S]*?min-height: 2\.25rem;/)
    expect(writePage).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.write-title-input :deep\(\.el-input__wrapper\) \{[\s\S]*?padding-inline: 0\.5rem;/)
    expect(writePage).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.write-title-input :deep\(\.el-input__count\) \{[\s\S]*?display: none;/)
    expect(writePage).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?\.write-title-input :deep\(\.el-input__inner\) \{[\s\S]*?font-size: clamp\(1\.5rem, 10vw, 2\.25rem\);/)
  })

  it('uses compact trash cards before tablet width to avoid fixed table clipping', () => {
    expect(trashPage).toContain("const isCompact = useMediaQuery('(max-width: 767px)')")
    expect(trashPage).not.toContain("const isCompact = useMediaQuery('(max-width: 639px)')")
  })

  it('keeps taxonomy fixed action columns aligned without segmented shadow seams', () => {
    expect(taxonomyView).toContain('class="taxonomy-table"')
    expect(taxonomyView).toContain('.taxonomy-table :deep(.el-table-fixed-column--right.is-first-column)')
    expect(taxonomyView).toContain('.taxonomy-table :deep(.el-table-fixed-column--right.is-first-column::before)')
    expect(taxonomyView).toContain('border-left: 1px solid var(--fsusblog-panel-border)')
    expect(taxonomyView).toContain('box-shadow: none')
  })

  it('routes taxonomy dialogs through the shared Fsus dialog shell', () => {
    expect(taxonomyView).toContain('<FsusDialog')
    expect(taxonomyView).toContain("from '@/components/ui/FsusDialog.vue'")
    expect(taxonomyView).not.toContain('<el-dialog')
    expect(taxonomyView).toContain('taxonomy-dialog-actions')
  })

  it('keeps collection toolbar primary actions on the trailing edge before desktop breakpoints', () => {
    expect(collectionToolbar).toContain('class="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 lg:w-auto"')
    expect(collectionToolbar).not.toContain('lg:justify-end')
  })

  it('keeps collection summary primary actions on the trailing edge before tablet breakpoints', () => {
    expect(collectionSummary).toContain('class="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto"')
    expect(collectionSummary).not.toContain('class="flex shrink-0 flex-wrap items-center gap-2"')
  })

  it('keeps compact audit actions reachable on mobile and short landscape touch screens', () => {
    expect(auditLogPage).toMatch(/\.audit-compact-row__action \{[\s\S]*?min-width: 36px;[\s\S]*?min-height: 36px;/)
    expect(auditLogPage).not.toMatch(/@media \(min-width: 640px\) \{[\s\S]*?\.audit-compact-row__action \{[\s\S]*?min-(?:width|height): 32px;/)
    expect(auditLogPage).toMatch(/@media \(max-width: 640px\) \{[\s\S]*?:deep\(\.audit-filter-grid \.el-date-editor \.el-range-input\) \{[\s\S]*?min-width: 32px;/)
  })

  it('makes trash restore explicit and requires title or id before permanent delete', () => {
    expect(trashComposable).toContain('恢复后文章将重新对外可见')
    expect(trashComposable).toContain('恢复并重新发布')
    expect(trashComposable).toContain('promptText')
    expect(trashComposable).toContain('text === String(row.id) || text === row.title')
    expect(trashPage).toContain('row.restoreActionText')
  })

  it('adds taxonomy search, duplicate checks, reference locks, and article drill-downs', () => {
    expect(authoringApi).toContain('listAdminCategories')
    expect(authoringApi).toContain('listAdminTags')
    expect(authoringEndpoint).toContain('"/taxonomy/categories"')
    expect(authoringEndpoint).toContain('"/taxonomy/tags"')
    expect(taxonomyEndpoint).toContain('AnyAsync(at => at.TagId == id)')
    expect(taxonomyEndpoint).not.toContain('Deleteable<ArticleTag>().Where(at => at.TagId == id)')
    expect(taxonomyComposable).toContain('filteredList')
    expect(taxonomyComposable).toContain('hasDuplicateName')
    expect(taxonomyComposable).toContain('viewAssociatedArticles')
    expect(taxonomyComposable).toContain("name: 'ManageArticleList'")
    expect(taxonomyComposable).toContain('[schema.articleQueryKey]')
    expect(taxonomyView).toContain('admin-data-surface')
    expect(taxonomyView).toContain('仅未引用')
    expect(taxonomyView).toContain('state.relationLockReason(row)')
    expect(taxonomyView).toContain('查看文章')
    expect(categoryPage).toContain('useAdminTaxonomyManage')
    expect(categoryPage).toContain('listAdminCategories')
    expect(categoryPage).toContain("articleQueryKey: 'categoryId'")
    expect(categoryPage).toContain('totalBlockingArticleCount')
    expect(tagPage).toContain('useAdminTaxonomyManage')
    expect(tagPage).toContain('listAdminTags')
    expect(tagPage).toContain("articleQueryKey: 'tagId'")
    expect(tagPage).toContain('正被')
    expect(tagPage).not.toContain('合并')
  })

  it('uses admin principal attribution for article revisions', () => {
    const revisionPanel = readRepoFile('src/frontend/src/components/admin/article/ArticleRevisionPanel.vue')

    expect(authoringApi).toContain('createdByAdminPrincipalId: string')
    expect(authoringApi).not.toContain('createdByAdminPrincipalId: number')
    expect(authoringApi).not.toContain('createdByUserId')
    expect(revisionPanel).toContain('revision.createdByAdminPrincipalId')
    expect(revisionPanel).not.toContain('revision.createdByUserId')
  })

  it('does not expose importable numeric actor ids in content export metadata', () => {
    const exportRevision = slice(
      authoringApi,
      'export interface ContentRevisionExportResponse',
      'export interface ContentExportMetadataResponse',
    )

    expect(exportRevision).not.toContain('createdByUserId')
    expect(exportRevision).not.toContain('createdByAdminPrincipalId')
  })

  it('does not label a category-only dashboard route as category and tag management', () => {
    expect(dashboardPanel).toContain("label: '分类管理'")
    expect(dashboardPanel).not.toContain("label: '分类与标签'")
    expect(dashboardPanel).toContain("label: '标签管理'")
  })
})
