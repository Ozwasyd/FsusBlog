import { describe, expect, it } from 'vitest'

import {
  getPublicFilterLabel,
  isPublicFilterType,
  normalizePublicFilterType,
  PUBLIC_FILTER_TYPE,
  shouldShowPublicFilterSearchSort
} from '@/public-renderers/publicFilterSemantics'

describe('publicFilterSemantics', () => {
  it('owns the canonical public filter types', () => {
    expect(isPublicFilterType(PUBLIC_FILTER_TYPE.category)).toBe(true)
    expect(isPublicFilterType(PUBLIC_FILTER_TYPE.tag)).toBe(true)
    expect(isPublicFilterType(PUBLIC_FILTER_TYPE.search)).toBe(true)
    expect(isPublicFilterType('other')).toBe(false)
  })

  it('normalizes unknown filter types back to search', () => {
    expect(normalizePublicFilterType(PUBLIC_FILTER_TYPE.category)).toBe(PUBLIC_FILTER_TYPE.category)
    expect(normalizePublicFilterType('oops')).toBe(PUBLIC_FILTER_TYPE.search)
  })

  it('owns the display labels for filter pages', () => {
    expect(getPublicFilterLabel(PUBLIC_FILTER_TYPE.category)).toBe('分类')
    expect(getPublicFilterLabel(PUBLIC_FILTER_TYPE.tag)).toBe('标签')
    expect(getPublicFilterLabel(PUBLIC_FILTER_TYPE.search)).toBe('搜索')
  })

  it('owns the search-sort visibility rule for filter pages', () => {
    expect(shouldShowPublicFilterSearchSort(PUBLIC_FILTER_TYPE.search)).toBe(true)
    expect(shouldShowPublicFilterSearchSort(PUBLIC_FILTER_TYPE.category)).toBe(false)
    expect(shouldShowPublicFilterSearchSort(PUBLIC_FILTER_TYPE.tag)).toBe(false)
  })
})