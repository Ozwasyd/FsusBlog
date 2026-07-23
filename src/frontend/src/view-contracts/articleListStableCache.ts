import type { ArticleListItemResponse } from '@/api/article'
import { createArticleListCardViewContract, type ArticleListCardViewContract } from '@/view-contracts/articleList'
import type { TimeRenderOptions } from '@/utils/time'
import type { PublicArticleListCardProjection } from '@/adapters/binary/articleProjectionReader'

type ArticleCardSource = ArticleListItemResponse | PublicArticleListCardProjection

type CachedArticleCard = {
  source: ArticleCardSource
  index: number
  timeKey: string
  view: ArticleListCardViewContract
  generation: number
}

type TimeOptionsInput = TimeRenderOptions | (() => TimeRenderOptions | undefined) | undefined

function resolveTimeOptions(input: TimeOptionsInput): TimeRenderOptions | undefined {
  return typeof input === 'function' ? input() : input
}

function toTimeKey(options: TimeRenderOptions | undefined): string {
  if (!options) {
    return ''
  }

  const now = options.now instanceof Date ? options.now.toISOString() : String(options.now ?? '')
  return `${now}\u0000${options.timeZone?.trim() ?? ''}`
}

export function createStableArticleCardMapper(timeOptions?: TimeOptionsInput) {
  const cache = new Map<number, CachedArticleCard>()
  let generation = 0

  return (items: readonly ArticleCardSource[]): ArticleListCardViewContract[] => {
    generation += 1
    const resolvedTimeOptions = resolveTimeOptions(timeOptions)
    const timeKey = toTimeKey(resolvedTimeOptions)
    const views = new Array<ArticleListCardViewContract>(items.length)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]

      const cached = cache.get(item.id)
      if (cached && cached.source === item && cached.index === index && cached.timeKey === timeKey) {
        cached.generation = generation
        views[index] = cached.view
        continue
      }

      const view = createArticleListCardViewContract(item, index, resolvedTimeOptions)
      cache.set(item.id, { source: item, index, timeKey, view, generation })
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
