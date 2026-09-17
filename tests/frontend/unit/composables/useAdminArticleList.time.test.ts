import { describe, expect, it } from 'vitest'
import { ArticlePublishStatus, type ArticleListItemResponse } from '@/api/article'
import { isPubliclyVisibleArticle } from '@/composables/useAdminArticleList'

const baseArticle = {
  id: 1,
  title: 'Scheduled article',
  summary: '',
  views: 0,
  createTime: '2025-12-31T23:00:00Z',
  category: { id: 1, name: 'Tech' },
  tags: [],
  isDeleted: false,
  status: ArticlePublishStatus.Published,
  publishedAt: '2025-12-31T23:00:00Z'
} satisfies ArticleListItemResponse

describe('isPubliclyVisibleArticle', () => {
  it('uses the supplied render clock around scheduled publish boundaries', () => {
    const boundaryMs = Date.parse('2026-01-01T00:00:00Z')

    expect(isPubliclyVisibleArticle({
      ...baseArticle,
      scheduledPublishAt: '2026-01-01T00:00:01Z'
    }, boundaryMs)).toBe(false)

    expect(isPubliclyVisibleArticle({
      ...baseArticle,
      scheduledPublishAt: '2026-01-01T00:00:00Z'
    }, boundaryMs)).toBe(true)
  })
})
