import { describe, it, expect } from 'vitest'
import { createArchivePageViewContract } from '@/view-contracts/archive'
import { PUBLIC_SEO_ROUTE_NAMES } from '@/public-renderers/publicRouteRegistry'

const mockArticle = {
  id: 1,
  title: 'Test Article',
  createTime: '2025-03-15T10:00:00Z',
  summary: 'summary',
  views: 100,
  category: { id: 1, name: 'Tech' },
  tags: []
}

describe('createArchivePageViewContract', () => {
  it('returns empty yearGroups when no articles', () => {
    const vc = createArchivePageViewContract([], 0)
    expect(vc.yearGroups).toHaveLength(0)
    expect(vc.total).toBe(0)
  })

  it('returns emptyState with title', () => {
    const vc = createArchivePageViewContract([], 0)
    expect(vc.emptyState.title).toBeTruthy()
  })

  it('groups articles by year and month', () => {
    const articles = [
      { ...mockArticle, id: 1, createTime: '2025-03-15T10:00:00Z' },
      { ...mockArticle, id: 2, createTime: '2025-03-20T10:00:00Z' },
      { ...mockArticle, id: 3, createTime: '2024-12-01T10:00:00Z' }
    ]
    const vc = createArchivePageViewContract(articles as never, 3)
    expect(vc.total).toBe(3)
    // 2 years: 2025 and 2024
    expect(vc.yearGroups.length).toBeGreaterThanOrEqual(2)
    const year2025 = vc.yearGroups.find(y => y.year === '2025')
    expect(year2025).toBeDefined()
    const marchGroup = year2025!.months.find(m => m.month.includes('03') || m.monthLabel.toLowerCase().includes('mar') || m.monthLabel.includes('3'))
    expect(marchGroup).toBeDefined()
    expect(marchGroup!.items).toHaveLength(2)
    expect(marchGroup!.items[0].route.name).toBe(PUBLIC_SEO_ROUTE_NAMES.articleDetail)
  })

  it('skips articles with invalid createTime', () => {
    const articles = [
      { ...mockArticle, id: 1, createTime: '2025-03-15T10:00:00Z' },
      { ...mockArticle, id: 2, createTime: 'bad-date' }
    ]
    const vc = createArchivePageViewContract(articles as never, 2)
    expect(vc.total).toBe(2) // total is passed in, not derived
    // Only 1 valid article
    const allItems = vc.yearGroups.flatMap(y => y.months.flatMap(m => m.items))
    expect(allItems).toHaveLength(1)
  })
})
