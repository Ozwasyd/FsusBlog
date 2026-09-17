import { describe, expect, it } from 'vitest'
import { PUBLIC_FILTER_TYPE, type PublicFilterType } from '@/public-renderers/publicFilterSemantics'
import { createFilterPageViewContract, normalizeFilterDescription } from '@/view-contracts/filterView'

function createView(filterType: PublicFilterType, currentName: string, overrides: {
  hasError?: boolean
  isInvalidTarget?: boolean
} = {}) {
  return createFilterPageViewContract({
    filterType,
    labelText: filterType === PUBLIC_FILTER_TYPE.search ? '搜索' : filterType === PUBLIC_FILTER_TYPE.tag ? '标签' : '分类',
    currentName,
    description: null,
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

    expect(view.empty.title).toBe('无匹配结果')
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

    expect(view.empty.title).toBe('内容不可用')
    expect(view.empty.description).toBe('刷新后重试。')
  })

  it('forwards description to header contract when provided', () => {
    const view = createFilterPageViewContract({
      filterType: PUBLIC_FILTER_TYPE.category,
      labelText: '分类',
      currentName: '架构',
      description: '关于系统架构与设计的深度文章',
      loadingMeta: false,
      loadingArticles: false,
      isPowCalculating: false,
      hasError: false,
      isInvalidTarget: false,
      articles: [],
      currentPage: 1,
      totalPages: 1,
      pageIndicatorText: '1 / 1',
      canGoPrev: false,
      canGoNext: false
    })

    expect(view.header.description).toBe('关于系统架构与设计的深度文章')
  })

  it('sets header description to null when explicitly null', () => {
    const view = createFilterPageViewContract({
      filterType: PUBLIC_FILTER_TYPE.search,
      labelText: '搜索',
      currentName: '“Rust”',
      description: null,
      loadingMeta: false,
      loadingArticles: false,
      isPowCalculating: false,
      hasError: false,
      isInvalidTarget: false,
      articles: [],
      currentPage: 1,
      totalPages: 1,
      pageIndicatorText: '1 / 1',
      canGoPrev: false,
      canGoNext: false
    })

    expect(view.header.description).toBeNull()
  })

  it('normalizes missing and blank descriptions to null', () => {
    expect(normalizeFilterDescription(undefined)).toBeNull()
    expect(normalizeFilterDescription(null)).toBeNull()
    expect(normalizeFilterDescription('')).toBeNull()
    expect(normalizeFilterDescription('   ')).toBeNull()
    expect(normalizeFilterDescription('  架构说明  ')).toBe('架构说明')
  })
})
