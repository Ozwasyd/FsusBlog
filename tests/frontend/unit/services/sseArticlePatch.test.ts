import { describe, it, expect } from 'vitest'
import {
  upsertArticlePreview,
  removeArticlePreview,
  matchesCategoryFilter,
  matchesTagFilter
} from '@/services/sseArticlePatch'
import type { ArticleListItemResponse } from '@/api/article'

function makeArticle(id: number, createTime: string, categoryId = 1, tags: { id: number; name: string }[] = []): ArticleListItemResponse {
  return {
    id,
    title: `Article ${id}`,
    summary: '',
    views: 0,
    createTime,
    category: { id: categoryId, name: 'Cat' },
    tags
  }
}

// ---------------------------------------------------------------------------
// upsertArticlePreview
// ---------------------------------------------------------------------------
describe('upsertArticlePreview', () => {
  it('adds new article to empty list', () => {
    const result = upsertArticlePreview([], makeArticle(1, '2025-01-01T00:00:00Z'))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(1)
  })

  it('replaces existing article by id', () => {
    const existing = [makeArticle(1, '2025-01-01T00:00:00Z'), makeArticle(2, '2025-01-02T00:00:00Z')]
    const updated = makeArticle(1, '2025-01-03T00:00:00Z')
    const result = upsertArticlePreview(existing, updated)
    expect(result).toHaveLength(2)
    const found = result.find(a => a.id === 1)
    expect(found?.createTime).toBe('2025-01-03T00:00:00Z')
  })

  it('result is sorted by createTime descending', () => {
    const list = [makeArticle(2, '2025-01-03T00:00:00Z'), makeArticle(1, '2025-01-01T00:00:00Z')]
    const newItem = makeArticle(3, '2025-01-02T00:00:00Z')
    const result = upsertArticlePreview(list, newItem)
    expect(result[0].id).toBe(2) // newest first
    expect(result[1].id).toBe(3)
    expect(result[2].id).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// removeArticlePreview
// ---------------------------------------------------------------------------
describe('removeArticlePreview', () => {
  it('removes article by id', () => {
    const list = [makeArticle(1, '2025-01-01T00:00:00Z'), makeArticle(2, '2025-01-02T00:00:00Z')]
    const result = removeArticlePreview(list, 1)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(2)
  })

  it('returns original list when id not found', () => {
    const list = [makeArticle(1, '2025-01-01T00:00:00Z')]
    const result = removeArticlePreview(list, 99)
    expect(result).toHaveLength(1)
  })

  it('returns empty list when removing the only item', () => {
    const result = removeArticlePreview([makeArticle(1, '2025-01-01T00:00:00Z')], 1)
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// matchesCategoryFilter
// ---------------------------------------------------------------------------
describe('matchesCategoryFilter', () => {
  it('returns true when categoryId matches', () => {
    const a = makeArticle(1, '2025-01-01T00:00:00Z', 5)
    expect(matchesCategoryFilter(a, 5)).toBe(true)
  })

  it('returns false when categoryId does not match', () => {
    const a = makeArticle(1, '2025-01-01T00:00:00Z', 5)
    expect(matchesCategoryFilter(a, 3)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// matchesTagFilter
// ---------------------------------------------------------------------------
describe('matchesTagFilter', () => {
  it('returns true when tagId matches', () => {
    const a = makeArticle(1, '2025-01-01T00:00:00Z', 1, [{ id: 7, name: 'Vue' }])
    expect(matchesTagFilter(a, 7)).toBe(true)
  })

  it('returns false when tagId does not match', () => {
    const a = makeArticle(1, '2025-01-01T00:00:00Z', 1, [{ id: 7, name: 'Vue' }])
    expect(matchesTagFilter(a, 8)).toBe(false)
  })

  it('returns false when tags array is empty', () => {
    const a = makeArticle(1, '2025-01-01T00:00:00Z')
    expect(matchesTagFilter(a, 1)).toBe(false)
  })
})
