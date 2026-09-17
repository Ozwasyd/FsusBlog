import { describe, expect, it } from 'vitest'
import type { ArticleListItemResponse, PageResponse } from '@/api/article'
import { rankSearchPage, scoreArticleSearchResult, SEARCH_RANKING_FIELD_WEIGHTS } from '@/services/searchRanking'

type SearchFixtureArticle = ArticleListItemResponse & {
  body?: string
}

const NOW_MS = Date.parse('2026-01-01T00:00:00Z')

function makeArticle(overrides: Partial<SearchFixtureArticle> & { id: number }): SearchFixtureArticle {
  return {
    id: overrides.id,
    title: overrides.title ?? `Article ${overrides.id}`,
    summary: overrides.summary ?? '',
    body: overrides.body,
    views: overrides.views ?? 0,
    createTime: overrides.createTime ?? '2025-12-01T00:00:00Z',
    category: overrides.category ?? { id: 1, name: 'General' },
    tags: overrides.tags ?? []
  }
}

function page(items: SearchFixtureArticle[]): PageResponse<SearchFixtureArticle> {
  return { items, total: items.length }
}

describe('searchRanking', () => {
  it('keeps field weights explicit for BM25F-style scoring', () => {
    expect(SEARCH_RANKING_FIELD_WEIGHTS.title).toBeGreaterThan(SEARCH_RANKING_FIELD_WEIGHTS.summary)
    expect(SEARCH_RANKING_FIELD_WEIGHTS.tags).toBeGreaterThan(SEARCH_RANKING_FIELD_WEIGHTS.body)
  })

  it('prioritizes title hits over repeated long-body hits', () => {
    const titleHit = makeArticle({
      id: 1,
      title: 'Vue search algorithm',
      summary: 'short exact match'
    })
    const bodyHit = makeArticle({
      id: 2,
      title: 'Frontend notes',
      summary: 'misc',
      body: 'search algorithm '.repeat(80)
    })

    const result = rankSearchPage(page([bodyHit, titleHit]), 'search algorithm', 'relevance', NOW_MS)
    expect(result.items[0].id).toBe(titleHit.id)
  })

  it('boosts tag and category matches over summary-only matches', () => {
    const taxonomyHit = makeArticle({
      id: 1,
      title: 'Runtime',
      category: { id: 2, name: 'AEDS' },
      tags: [{ id: 10, name: 'Binary Protocol' }]
    })
    const summaryHit = makeArticle({
      id: 2,
      title: 'General post',
      summary: 'binary protocol details'
    })

    const result = rankSearchPage(page([summaryHit, taxonomyHit]), 'binary protocol', 'relevance', NOW_MS)
    expect(result.items[0].id).toBe(taxonomyHit.id)
  })

  it('uses recency decay and Bayesian smoothing for hot ranking', () => {
    const veryOldPopular = makeArticle({
      id: 1,
      views: 10000,
      createTime: '2023-01-01T00:00:00Z'
    })
    const recentModerate = makeArticle({
      id: 2,
      views: 120,
      createTime: '2025-12-31T12:00:00Z'
    })

    const result = rankSearchPage(page([veryOldPopular, recentModerate]), '', 'hot', NOW_MS)
    expect(result.items[0].id).toBe(recentModerate.id)
  })

  it('keeps scores deterministic for offline fixtures', () => {
    const articles = [
      makeArticle({ id: 1, title: 'AEDS binary protocol', tags: [{ id: 1, name: 'Protocol' }] }),
      makeArticle({ id: 2, title: 'Daily note', summary: 'aeds binary protocol '.repeat(4) })
    ]

    expect(scoreArticleSearchResult(articles[0], 'aeds protocol', articles, NOW_MS))
      .toBeGreaterThan(scoreArticleSearchResult(articles[1], 'aeds protocol', articles, NOW_MS))
  })
})
