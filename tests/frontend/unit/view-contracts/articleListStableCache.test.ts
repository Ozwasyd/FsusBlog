import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArticleListItemResponse } from '@/api/article'
import { createStableArticleCardMapper } from '@/view-contracts/articleListStableCache'

function makeArticle(id: number): ArticleListItemResponse {
  return {
    id,
    title: `Article ${id}`,
    summary: '',
    views: id,
    createTime: '2025-01-01T00:00:00Z',
    category: { id: 1, name: 'General' },
    tags: []
  }
}

describe('createStableArticleCardMapper', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses unchanged article views at the same index', () => {
    const mapper = createStableArticleCardMapper()
    const article = makeArticle(1)

    const first = mapper([article])
    const second = mapper([article])

    expect(second[0]).toBe(first[0])
  })

  it('sweeps stale cache entries by generation', () => {
    const mapper = createStableArticleCardMapper()
    const firstArticle = makeArticle(1)
    const secondArticle = makeArticle(2)

    const first = mapper([firstArticle, secondArticle])
    mapper([firstArticle])
    const third = mapper([firstArticle, secondArticle])

    expect(third[0]).toBe(first[0])
    expect(third[1]).not.toBe(first[1])
  })

  it('uses the supplied render clock for hydration-stable smart times', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const mapper = createStableArticleCardMapper({
      now: '2026-01-01T00:01:00Z',
      timeZone: 'UTC'
    })
    const first = {
      ...makeArticle(1),
      createTime: '2026-01-01T00:00:30Z'
    }
    const second = {
      ...first,
      summary: 'changed summary'
    }

    expect(mapper([first])[0].meta.displayTime).toBe('刚刚')

    vi.setSystemTime(new Date('2026-01-03T12:00:00Z'))

    expect(mapper([second])[0].meta.displayTime).toBe('刚刚')
  })
})
