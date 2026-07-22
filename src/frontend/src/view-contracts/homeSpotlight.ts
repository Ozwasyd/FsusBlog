import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'
import type { ArticleListCardViewContract, ArticleListViewContract } from '@/view-contracts/articleList'

const DEFAULT_SECONDARY_ARTICLE_LIMIT = 5

type HomeArticleIdentity = Readonly<{
  id: number
}>

export type HomeEditorialComposition<TFeedItem extends HomeArticleIdentity = ArticleListCardViewContract> = Readonly<{
  leadArticle: FeaturedArticleItem | null
  secondaryArticles: readonly PopularArticleSummaryResponse[]
  feedItems: readonly TFeedItem[]
}>

export type HomeEditorialPageState = Readonly<{
  composition: HomeEditorialComposition<ArticleListCardViewContract>
  view: ArticleListViewContract
  hasRecommendations: boolean
}>

function normalizedArticleId(article: HomeArticleIdentity): number | null {
  const id = Number(article.id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function normalizedSecondaryLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SECONDARY_ARTICLE_LIMIT
  }

  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_SECONDARY_ARTICLE_LIMIT
}

/**
 * Selects the complete public-home editorial surface without changing the
 * ordering supplied by any backend source. The same selector is used by
 * server rendering, hydration, and the SPA takeover path.
 */
export function selectHomeEditorialComposition<TFeedItem extends HomeArticleIdentity>(input: {
  featuredArticles: readonly FeaturedArticleItem[]
  hotArticles: readonly PopularArticleSummaryResponse[]
  feedItems: readonly TFeedItem[]
  secondaryLimit?: number
}): HomeEditorialComposition<TFeedItem> {
  const recommendationIds = new Set<number>()
  let leadArticle: FeaturedArticleItem | null = null

  for (const article of input.featuredArticles) {
    const id = normalizedArticleId(article)
    if (id === null || recommendationIds.has(id)) {
      continue
    }

    leadArticle = article
    recommendationIds.add(id)
    break
  }

  const secondaryArticles: PopularArticleSummaryResponse[] = []
  const secondaryLimit = normalizedSecondaryLimit(input.secondaryLimit)
  for (const article of input.hotArticles) {
    if (secondaryArticles.length >= secondaryLimit) {
      break
    }

    const id = normalizedArticleId(article)
    if (id === null || recommendationIds.has(id)) {
      continue
    }
    recommendationIds.add(id)
    secondaryArticles.push(article)
  }

  return {
    leadArticle,
    secondaryArticles,
    feedItems: [...input.feedItems]
  }
}

/**
 * Builds the complete home render state shared by public AOT/SSR, hydration,
 * and the SPA route. Keeping this assembly pure prevents either renderer from
 * introducing a second recommendation order or a separate deduplication pass.
 */
export function createHomeEditorialPageState(input: {
  view: ArticleListViewContract
  featuredArticles: readonly FeaturedArticleItem[]
  hotArticles: readonly PopularArticleSummaryResponse[]
  secondaryLimit?: number
}): HomeEditorialPageState {
  const composition = selectHomeEditorialComposition({
    featuredArticles: input.featuredArticles,
    hotArticles: input.hotArticles,
    feedItems: input.view.items,
    ...(input.secondaryLimit === undefined ? {} : { secondaryLimit: input.secondaryLimit })
  })

  return {
    composition,
    view: input.view,
    hasRecommendations: Boolean(
      composition.leadArticle
      || composition.secondaryArticles.length > 0
    )
  }
}
