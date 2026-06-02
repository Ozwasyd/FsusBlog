import type { ArticleListItemResponse } from '@/api/article'
import { createArticleListCardViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'

type CachedArticleCard = {
  source: ArticleListItemResponse
  index: number
  view: ArticleListCardViewContract
  generation: number
}

export function createStableArticleCardMapper() {
  const cache = new Map<number, CachedArticleCard>()
  let generation = 0

  return (items: readonly ArticleListItemResponse[]): ArticleListCardViewContract[] => {
    generation += 1
    const views = new Array<ArticleListCardViewContract>(items.length)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]

      const cached = cache.get(item.id)
      if (cached && cached.source === item && cached.index === index) {
        cached.generation = generation
        views[index] = cached.view
        continue
      }

      const view = createArticleListCardViewContract(item, index)
      cache.set(item.id, { source: item, index, view, generation })
      views[index] = view
    }

    for (const [id, cached] of cache) {
      if (cached.generation !== generation) {
        cache.delete(id)
      }
    }

    return views
  }
}
