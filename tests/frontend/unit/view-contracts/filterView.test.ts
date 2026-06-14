import { describe, expect, it } from 'vitest'
import { PUBLIC_FILTER_TYPE, type PublicFilterType } from '@/public-renderers/publicFilterSemantics'
import { createFilterPageViewContract } from '@/view-contracts/filterView'

function createView(filterType: PublicFilterType, currentName: string, overrides: {
  hasError?: boolean
  isInvalidTarget?: boolean
} = {}) {
  return createFilterPageViewContract({
    filterType,
    labelText: filterType === PUBLIC_FILTER_TYPE.search ? '搜索' : filterType === PUBLIC_FILTER_TYPE.tag ? '标签' : '分类',
    currentName,
    loadingMeta: false,
    loadingArticles: false,
    isPowCalculating: false,
    hasError: overrides.hasError ?? false,
    isInvalidTarget: overrides.isInvalidTarget ?? false,
    articles: [],
    currentPage: 1,
    totalPages: 1,
    pageIndicatorText: '1 / 1',
    canGoPrev: false,
    canGoNext: false
  })
}

describe('createFilterPageViewContract', () => {
  it('uses search-specific empty copy with the query', () => {
    const view = createView(PUBLIC_FILTER_TYPE.search, '“AOT”')

    expect(view.empty.title).toBe('没搜到「AOT」，换个词试试')
  })

  it('uses category-specific empty copy', () => {
    const view = createView(PUBLIC_FILTER_TYPE.category, '性能')

    expect(view.empty.title).toBe('这个分类还没放文章')
  })

  it('uses tag-specific empty copy', () => {
    const view = createView(PUBLIC_FILTER_TYPE.tag, 'Vue')

    expect(view.empty.title).toBe('这个标签下还没有文章')
  })

  it('uses direct operational copy for load errors', () => {
    const view = createView(PUBLIC_FILTER_TYPE.search, '“AOT”', { hasError: true })

    expect(view.empty.title).toBe('文章列表没取回来，稍后再试')
  })
})
