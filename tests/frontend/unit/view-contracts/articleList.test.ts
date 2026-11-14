import { describe, it, expect } from 'vitest'
import { createArticleListCardViewContract, createArticleListViewContract } from '@/view-contracts/articleList'
import { PUBLIC_SEO_ROUTE_NAMES } from '@/public-renderers/publicRouteRegistry'
import { buildPublicHomePaginationHref } from '@/public-renderers/publicRouteIdentity'

const mockArticle = {
  id: 10,
  title: 'Test Article',
  summary: 'A short summary',
  createTime: '2025-01-15T10:00:00Z',
  category: { id: 1, name: 'Tech' },
  tags: [{ id: 1, name: 'vue' }, { id: 2, name: 'typescript' }, { id: 3, name: 'js' }],
  views: 100
}

describe('createArticleListCardViewContract', () => {
  it('maps article to card view contract', () => {
    const vc = createArticleListCardViewContract(mockArticle as never, 0)
    expect(vc.id).toBe(10)
    expect(vc.title).toBe('Test Article')
    expect(vc.summary).toBe('A short summary')
    expect(vc.href).toBe('/article/10')
    expect(vc.href).toBe(`/article/${String(mockArticle.id)}`)
    expect(vc.card.kind).toBe('article-list-card')
    expect(vc.card.index).toBe(0)
  })

  it('uses category name from article', () => {
    const vc = createArticleListCardViewContract(mockArticle as never)
    expect(vc.meta.categoryName).toBe('Tech')
    expect(vc.meta.categoryHref).toBe('/category/1')
  })

  it('falls back to default category when no category', () => {
    const noCategory = { ...mockArticle, category: null }
    const vc = createArticleListCardViewContract(noCategory as never)
    expect(vc.meta.categoryName).toBe('通用类')
    expect(vc.meta.categoryHref).toBeUndefined()
  })

  it('maps tags to label with # prefix', () => {
    const vc = createArticleListCardViewContract(mockArticle as never)
    expect(vc.tags[0].label).toBe('#vue')
    expect(vc.tags[0].href).toBe('/tag/1')
    expect(vc.tags[0].hiddenOnMobile).toBe(true)
  })

  it('limits tags to 5', () => {
    const manyTags = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `tag${i}` }))
    const article = { ...mockArticle, tags: manyTags }
    const vc = createArticleListCardViewContract(article as never)
    expect(vc.tags).toHaveLength(5)
  })

  it('handles empty tags', () => {
    const article = { ...mockArticle, tags: [] }
    const vc = createArticleListCardViewContract(article as never)
    expect(vc.tags).toHaveLength(0)
  })

  it('uses empty string for missing summary', () => {
    const article = { ...mockArticle, summary: null }
    const vc = createArticleListCardViewContract(article as never)
    expect(vc.summary).toBe('')
  })

  it('sets isoTime from createTime', () => {
    const vc = createArticleListCardViewContract(mockArticle as never)
    expect(vc.meta.isoTime).toBe('2025-01-15T10:00:00Z')
  })
})

describe('createArticleListViewContract', () => {
  const response = {
    items: [mockArticle],
    total: 25,
    page: 1,
    pageSize: 10
  }

  it('maps items to card contracts', () => {
    const vc = createArticleListViewContract(response as never, { currentPage: 1, pageSize: 10 })
    expect(vc.items).toHaveLength(1)
    expect(vc.items[0].id).toBe(10)
  })

  it('calculates pagination correctly', () => {
    const vc = createArticleListViewContract(response as never, { currentPage: 2, pageSize: 10 })
    expect(vc.pagination.indicator).toBe('2 / 3')
    expect(vc.pagination.previous.disabled).toBe(false)
    expect(vc.pagination.next.disabled).toBe(false)
    expect(vc.pagination.previous.href).toBe('/')
    expect(vc.pagination.next.href).toBe('/')
    expect(vc.showPagination).toBe(true)
  })

  it('uses the canonical cursor when supplied for the next page', () => {
    const vc = createArticleListViewContract(response as never, {
      currentPage: 2,
      pageSize: 10,
      pageHref: page => buildPublicHomePaginationHref(page, page === 3 ? 'cursor_home_3' : null)
    })
    expect(vc.pagination.previous.href).toBe('/')
    expect(vc.pagination.next.href).toBe('/?page=3&cursor=cursor_home_3')
    expect(vc.pagination.next.disabled).toBe(false)
  })

  it('uses the caller canonical route for pagination hrefs', () => {
    const vc = createArticleListViewContract(response as never, {
      currentPage: 2,
      pageSize: 10,
      pageHref: (page) => page === 1 ? '/category/7' : `/category/7?page=${page}`
    })
    expect(vc.pagination.previous.href).toBe('/category/7')
    expect(vc.pagination.next.href).toBe('/category/7?page=3')
  })

  it('disables previous on first page', () => {
    const vc = createArticleListViewContract(response as never, { currentPage: 1, pageSize: 10 })
    expect(vc.pagination.previous.disabled).toBe(true)
    expect(vc.pagination.next.disabled).toBe(false)
  })

  it('disables next on last page', () => {
    const vc = createArticleListViewContract(response as never, { currentPage: 3, pageSize: 10 })
    expect(vc.pagination.next.disabled).toBe(true)
  })

  it('hides pagination when only one page', () => {
    const singlePage = { ...response, total: 5 }
    const vc = createArticleListViewContract(singlePage as never, { currentPage: 1, pageSize: 10 })
    expect(vc.showPagination).toBe(false)
  })

  it('sets searchKeyword from options', () => {
    const vc = createArticleListViewContract(response as never, {
      currentPage: 1,
      pageSize: 10,
      searchKeyword: '  vue  '
    })
    expect(vc.searchKeyword).toBe('vue')
  })

  it('empty state has title', () => {
    const vc = createArticleListViewContract(response as never, { currentPage: 1, pageSize: 10 })
    expect(vc.emptyState.title).toBe('这里还没有文章')
  })
})
