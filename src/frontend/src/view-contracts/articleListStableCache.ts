import type { ArticleListItemResponse } from '@/api/article'
import { createArticleListCardViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'

type CachedArticleCard = Readonly<{
  source: ArticleListItemResponse
  index: number
  view: ArticleListCardViewContract
}>

export function createStableArticleCardMapper() {
  const cache = new Map<number, CachedArticleCard>()

  return (items: readonly ArticleListItemResponse[]): ArticleListCardViewContract[] => {
    const liveIds = new Set<number>()
    const views = new Array<ArticleListCardViewContract>(items.length)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      liveIds.add(item.id)

      const cached = cache.get(item.id)
      if (cached && cached.source === item && cached.index === index) {
        views[index] = cached.view
        continue
      }

      const view = createArticleListCardViewContract(item, index)
      cache.set(item.id, { source: item, index, view })
      views[index] = view
    }

    for (const id of cache.keys()) {
      if (!liveIds.has(id)) {
        cache.delete(id)
      }
    }

    return views
  }
}
