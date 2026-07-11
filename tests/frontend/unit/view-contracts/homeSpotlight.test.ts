import { describe, expect, it } from 'vitest'
import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import { createPublicHomePageAssembly } from '@/public-renderers/pageAssemblies'
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList'
import {
  createHomeEditorialPageState,
  selectHomeEditorialComposition,
  withHomeEditorialFeed
} from '@/view-contracts/homeSpotlight'

const featured = (id: number, coverImageUrl = `/uploads/${id}.webp`): FeaturedArticleItem => ({
  id,
  title: `Featured ${id}`,
  coverImageUrl,
  views: id * 100,
  createTime: `2026-01-${String(id).padStart(2, '0')}T00:00:00.000Z`,
  category: {
    id: 1,
    name: 'Demo'
  }
})

const hot = (id: number): PopularArticleSummaryResponse => ({
  id,
  title: `Hot ${id}`,
  views: id * 10
})

const feed = (id: number): ArticleListCardViewContract => ({
  card: { kind: 'article-list-card', index: id },
  id,
  href: `/article/${id}`,
  title: `Feed ${id}`,
  summary: `Summary ${id}`,
  meta: {
    isoTime: '2026-01-01T00:00:00.000Z',
    displayTime: '2026-01-01',
    fullTime: '2026-01-01 00:00:00',
    categoryName: 'Demo'
  },
  tags: []
})

const view = (items: readonly ArticleListCardViewContract[]): ArticleListViewContract => ({
  items,
  pagination: {
    previous: { label: '上一页', disabled: true, action: { action: 'page-prev' } },
    next: { label: '下一页', disabled: false, action: { action: 'page-next' } },
    indicator: '1 / 2'
  },
  showPagination: true,
  emptyState: { title: '这里还没有文章' },
  searchKeyword: ''
})

describe('home editorial composition', () => {
  it('makes lead, secondary recommendations, and the current feed mutually exclusive', () => {
    const result = selectHomeEditorialComposition({
      featuredArticles: [featured(1), featured(8)],
      hotArticles: [hot(1), hot(2), hot(2), hot(3)],
      feedItems: [feed(1), feed(2), feed(3), feed(4), feed(4)]
    })

    expect(result.leadArticle?.id).toBe(1)
    expect(result.secondaryArticles.map((article) => article.id)).toEqual([2, 3])
    expect(result.feedItems.map((article) => article.id)).toEqual([4])

    const displayedIds = [
      result.leadArticle?.id,
      ...result.secondaryArticles.map((article) => article.id),
      ...result.feedItems.map((article) => article.id)
    ].filter((id): id is number => id !== undefined)
    expect(new Set(displayedIds).size).toBe(displayedIds.length)
  })

  it('keeps one coverless lead instead of replacing it with a visual placeholder', () => {
    const result = selectHomeEditorialComposition({
      featuredArticles: [featured(7, '   '), featured(8)],
      hotArticles: [],
      feedItems: []
    })

    expect(result.leadArticle).toEqual(featured(7, '   '))
    expect(result.secondaryArticles).toEqual([])
    expect(result.feedItems).toEqual([])
  })

  it('preserves backend ordering, input arrays, and the configured text-list limit', () => {
    const featuredArticles = Object.freeze([featured(9), featured(8)])
    const hotArticles = Object.freeze([hot(7), hot(6), hot(5), hot(4)])
    const feedItems = Object.freeze([feed(3), feed(2), feed(1)])

    const result = selectHomeEditorialComposition({
      featuredArticles,
      hotArticles,
      feedItems,
      secondaryLimit: 2
    })

    expect(result.leadArticle?.id).toBe(9)
    expect(result.secondaryArticles.map((article) => article.id)).toEqual([7, 6])
    expect(result.feedItems.map((article) => article.id)).toEqual([3, 2, 1])
    expect(featuredArticles.map((article) => article.id)).toEqual([9, 8])
    expect(hotArticles.map((article) => article.id)).toEqual([7, 6, 5, 4])
    expect(feedItems.map((article) => article.id)).toEqual([3, 2, 1])
  })

  it('drops invalid identities instead of allowing an untrackable duplicate surface', () => {
    const result = selectHomeEditorialComposition({
      featuredArticles: [featured(0), featured(1)],
      hotArticles: [hot(Number.NaN), hot(2)],
      feedItems: [feed(-1), feed(2), feed(3)]
    })

    expect(result.leadArticle?.id).toBe(1)
    expect(result.secondaryArticles.map((article) => article.id)).toEqual([2])
    expect(result.feedItems.map((article) => article.id)).toEqual([3])
  })

  it('starts directly from the feed when recommendations are empty', () => {
    const result = selectHomeEditorialComposition({
      featuredArticles: [],
      hotArticles: [],
      feedItems: [feed(11), feed(12)]
    })

    expect({
      leadId: result.leadArticle?.id ?? null,
      secondaryIds: result.secondaryArticles.map((article) => article.id),
      feedIds: result.feedItems.map((article) => article.id)
    }).toMatchInlineSnapshot(`
      {
        "feedIds": [
          11,
          12,
        ],
        "leadId": null,
        "secondaryIds": [],
      }
    `)
  })

  it('reapplies the same recommendation exclusions after a page switch', () => {
    const sources = {
      featuredArticles: [featured(1)],
      hotArticles: [hot(2), hot(3)]
    }
    const firstPage = selectHomeEditorialComposition({
      ...sources,
      feedItems: [feed(1), feed(4), feed(5)]
    })
    const secondPage = selectHomeEditorialComposition({
      ...sources,
      feedItems: [feed(2), feed(6), feed(7)]
    })

    expect(firstPage.leadArticle?.id).toBe(secondPage.leadArticle?.id)
    expect(firstPage.secondaryArticles.map((article) => article.id)).toEqual([2, 3])
    expect(secondPage.secondaryArticles.map((article) => article.id)).toEqual([2, 3])
    expect(firstPage.feedItems.map((article) => article.id)).toEqual([4, 5])
    expect(secondPage.feedItems.map((article) => article.id)).toEqual([6, 7])
    expect({
      firstPage: firstPage.feedItems.map((article) => article.id),
      secondPage: secondPage.feedItems.map((article) => article.id),
      recommendations: secondPage.secondaryArticles.map((article) => article.id)
    }).toMatchInlineSnapshot(`
      {
        "firstPage": [
          4,
          5,
        ],
        "recommendations": [
          2,
          3,
        ],
        "secondPage": [
          6,
          7,
        ],
      }
    `)
  })

  it('reuses the original view when no feed items were removed', () => {
    const original = view([feed(1), feed(2)])

    expect(withHomeEditorialFeed(original, original.items)).toBe(original)
  })

  it('changes only view items when editorial exclusions remove feed entries', () => {
    const original = view([feed(1), feed(2), feed(3)])
    const result = withHomeEditorialFeed(original, [original.items[2]!])

    expect(result).not.toBe(original)
    expect(result.items.map((article) => article.id)).toEqual([3])
    expect(result.pagination).toBe(original.pagination)
    expect(result.showPagination).toBe(true)
  })

  it('builds the full renderer state through the same pure assembly', () => {
    const result = createHomeEditorialPageState({
      view: view([feed(1), feed(2), feed(4)]),
      featuredArticles: [featured(1)],
      hotArticles: [hot(2), hot(3)]
    })

    expect(result.composition.leadArticle?.id).toBe(1)
    expect(result.composition.secondaryArticles.map((article) => article.id)).toEqual([2, 3])
    expect(result.view.items.map((article) => article.id)).toEqual([4])
    expect(result.hasRecommendations).toBe(true)
  })

  it('gives public AOT the same editorial view and controls as the shared SPA state', () => {
    const input = {
      view: view([feed(1), feed(2), feed(4), feed(5)]),
      featuredArticles: [featured(1)],
      hotArticles: [hot(2), hot(3)]
    }
    const sharedState = createHomeEditorialPageState(input)
    const aotAssembly = createPublicHomePageAssembly(input)
    const aotView = aotAssembly.props.view as ArticleListViewContract

    expect(aotView.items.map((article) => article.id)).toEqual(
      sharedState.view.items.map((article) => article.id)
    )
    expect(aotAssembly.props.hasRecommendations).toBe(sharedState.hasRecommendations)
    expect(aotAssembly.props.showArticleCta).toBe(false)
    expect(aotAssembly.props.showAside).toBe(false)
    expect(aotAssembly.slots?.featured).toBeTypeOf('function')
    expect(aotAssembly.slots?.aside).toBeTypeOf('function')
  })
})
