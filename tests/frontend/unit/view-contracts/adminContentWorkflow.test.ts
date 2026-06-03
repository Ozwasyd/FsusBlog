import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

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
  const categoryComposable = readRepoFile('src/frontend/src/composables/useAdminCategoryManage.ts')
  const tagPage = readRepoFile('src/frontend/src/views/admin/Tag.vue')
  const tagComposable = readRepoFile('src/frontend/src/composables/useAdminTagManage.ts')
  const authoringApi = readRepoFile('src/frontend/src/api/authoring.ts')
  const taxonomyEndpoint = readRepoFile('src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs')
  const authoringEndpoint = readRepoFile('src/backend/Modules/Endpoints/AuthoringEndpoints.cs')
  const dashboardPanel = readRepoFile('src/frontend/src/components/admin/DashboardOperationsPanel.vue')

  it('serializes admin keyword search through frontend and backend list queries', () => {
    expect(articleApi).toContain('params.keyword?.trim()')
    expect(articleApi).toContain("search.set('keyword', keyword)")
    expect(articleEndpoint).toContain('string? keyword')
    expect(articleEndpoint).toContain('GetPageListAsync(pageValue, sizeValue, categoryId, tagId, deleted')
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
  })

  it('shows cover thumbnails, contextual row actions, and status timestamps', () => {
    expect(listComposable).toContain('primaryActionLabel')
    expect(listComposable).toContain('继续写作')
    expect(listComposable).toContain('调整排期')
    expect(listComposable).toContain('statusTimeLabel')
    expect(listPage).toContain('article-cover-thumb')
    expect(compactCard).toContain('article-compact-cover')
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
    expect(categoryComposable).toContain('filteredList')
    expect(categoryComposable).toContain('hasDuplicateName')
    expect(categoryComposable).toContain('viewAssociatedArticles')
    expect(categoryComposable).toContain('listAdminCategories')
    expect(categoryComposable).toContain('totalBlockingArticleCount')
    expect(categoryComposable).toContain("name: 'ManageArticleList'")
    expect(categoryPage).toContain('仅未引用')
    expect(categoryPage).toContain('relationLockReason(row)')
    expect(tagComposable).toContain('listAdminTags')
    expect(tagComposable).toContain('正被')
    expect(tagComposable).not.toContain('handleMergeRequest')
    expect(tagPage).toContain('查看文章')
    expect(tagPage).not.toContain('合并')
  })

  it('does not label a category-only dashboard route as category and tag management', () => {
    expect(dashboardPanel).toContain("label: '分类管理'")
    expect(dashboardPanel).not.toContain("label: '分类与标签'")
    expect(dashboardPanel).toContain("label: '标签管理'")
  })
})
