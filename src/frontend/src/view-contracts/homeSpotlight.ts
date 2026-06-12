import type { FeaturedArticleItem, PopularArticleSummaryResponse } from '@/api/article'

export type HomeSecondaryLayout = 'loading' | 'spotlight' | 'text-first' | 'none'

export function hasUsableSpotlightCover(article: Pick<FeaturedArticleItem, 'coverImageUrl'>): boolean {
  return article.coverImageUrl.trim().length > 0
}

export function selectHomeSpotlightCandidates(
  articles: readonly FeaturedArticleItem[],
  limit = 3
): FeaturedArticleItem[] {
  const normalizedLimit = Math.max(0, Math.trunc(limit))
  if (normalizedLimit === 0) {
    return []
  }

  return articles
    .filter(hasUsableSpotlightCover)
    .slice(0, normalizedLimit)
}

export function resolveHomeSecondaryLayout(input: {
  loading: boolean
  spotlightCandidates: readonly FeaturedArticleItem[]
  hotArticles: readonly PopularArticleSummaryResponse[]
}): HomeSecondaryLayout {
  if (input.loading) {
    return 'loading'
  }

  if (input.spotlightCandidates.length > 0) {
    return 'spotlight'
  }

  if (input.hotArticles.length > 0) {
    return 'text-first'
  }

  return 'none'
}
