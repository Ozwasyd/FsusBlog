import { describe, expect, it } from 'vitest'
import type { ArticleDetailResponse } from '@/api/article'
import { createArticleDetailHeaderViewContract } from '@/view-contracts/articleDetail'
import { articleRightsFixture } from '../fixtures/articleRights'

function article(overrides: Partial<ArticleDetailResponse> = {}): ArticleDetailResponse {
  return {
    id: 42,
    title: 'Metadata article',
    content: 'Body',
    summary: 'Summary',
    views: 7,
    createTime: '2026-07-01T08:00:00.000Z',
    publishedAt: '2026-07-02T08:00:00.000Z',
    updatedAt: '2026-07-03T09:30:00.000Z',
    category: { id: 2, name: 'Engineering' },
    tags: [],
    rights: articleRightsFixture,
    ...overrides
  }
}

describe('article detail publication metadata', () => {
  it('uses first-public and body-modified timestamps as separate visible metadata', () => {
    const view = createArticleDetailHeaderViewContract(article())

    expect(view.meta.published.isoTime).toBe('2026-07-02T08:00:00.000Z')
    expect(view.meta.modified?.isoTime).toBe('2026-07-03T09:30:00.000Z')
    expect(view.meta.isoTime).toBe(view.meta.published.isoTime)
  })

  it('does not repeat an update when body time is not later than publication', () => {
    const view = createArticleDetailHeaderViewContract(article({
      updatedAt: '2026-07-02T08:00:00.000Z'
    }))

    expect(view.meta.modified).toBeUndefined()
  })

  it('falls back to legacy creation time only when publication time is unavailable', () => {
    const view = createArticleDetailHeaderViewContract(article({
      publishedAt: null,
      updatedAt: null
    }))

    expect(view.meta.published.isoTime).toBe('2026-07-01T08:00:00.000Z')
    expect(view.meta.modified).toBeUndefined()
  })
})
