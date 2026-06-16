import type { ArticleListItemResponse } from '@/api/article'
import type { PublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import { createPublicArticleDetailNavigationTarget } from '@/public-renderers/publicNavigationTargets'
import dayjs from 'dayjs'
import { TimeUtils, type TimeRenderOptions } from '@/utils/time'

export type ArchiveArticleViewContract = Readonly<{
  id: number
  title: string
  createTime: string
  dayText: string
  yearText: string
  monthText: string
  fullLocalTimeText: string
  timestamp: number
  route: PublicArticleDetailNavigationTarget['route']
}>

type ArchiveMonthGroupViewContract = Readonly<{
  month: string
  monthLabel: string
  items: readonly ArchiveArticleViewContract[]
}>

type ArchiveYearGroupViewContract = Readonly<{
  year: string
  months: readonly ArchiveMonthGroupViewContract[]
}>

export type ArchivePageViewContract = Readonly<{
  total: number
  yearGroups: readonly ArchiveYearGroupViewContract[]
  emptyState: Readonly<{
    title: string
  }>
}>

function toArchiveDisplayTime(value: string, timeOptions?: TimeRenderOptions) {
  const parsed = TimeUtils._parse(value)
  if (!parsed || !parsed.isValid()) {
    return null
  }

  const timeZone = timeOptions?.timeZone?.trim()
  return timeZone ? parsed.tz(timeZone) : parsed.local()
}

function createArchiveArticleViewContract(
  article: ArticleListItemResponse,
  timeOptions?: TimeRenderOptions
): ArchiveArticleViewContract | null {
  const parsed = TimeUtils._parse(article.createTime)
  if (!parsed || !parsed.isValid()) {
    return null
  }

  const displayTime = toArchiveDisplayTime(article.createTime, timeOptions)
  if (!displayTime) {
    return null
  }

  const articleTarget = createPublicArticleDetailNavigationTarget(article.id)

  return {
    id: article.id,
    title: article.title,
    createTime: article.createTime,
    dayText: displayTime.format('DD'),
    yearText: displayTime.year().toString(),
    monthText: displayTime.format('MM'),
    fullLocalTimeText: TimeUtils.toFullLocalString(article.createTime, timeOptions),
    timestamp: parsed.valueOf(),
    route: articleTarget.route
  }
}

type ArchiveArticleResolver = (article: ArticleListItemResponse) => ArchiveArticleViewContract | null

type ArchiveArticleCacheEntry = Readonly<{
  key: string
  item: ArchiveArticleViewContract
}>

function formatArchiveMonthLabel(month: string): string {
  const monthNumber = Number.parseInt(month, 10)
  return Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
    ? `${monthNumber} 月`
    : month
}

function createArchivePageViewContractCore(
  articles: ArticleListItemResponse[],
  total: number,
  resolveArticle: ArchiveArticleResolver
): ArchivePageViewContract {
  const yearMap = new Map<string, Map<string, ArchiveArticleViewContract[]>>()

  for (const article of articles) {
    const item = resolveArticle(article)
    if (!item) {
      continue
    }

    const parsed = dayjs(item.timestamp)
    if (!parsed || !parsed.isValid()) {
      continue
    }

    const year = item.yearText || parsed.year().toString()
    const month = item.monthText || parsed.format('MM')

    if (!yearMap.has(year)) {
      yearMap.set(year, new Map())
    }

    const monthMap = yearMap.get(year)!
    if (!monthMap.has(month)) {
      monthMap.set(month, [])
    }

    monthMap.get(month)!.push(item)
  }

  const yearGroups = Array.from(yearMap.keys())
    .sort((a, b) => Number(b) - Number(a))
    .map((year) => {
      const monthMap = yearMap.get(year)!
      const months = Array.from(monthMap.keys())
        .sort((a, b) => Number(b) - Number(a))
        .map((month) => {
          const items = monthMap.get(month)!
          const monthLabel = formatArchiveMonthLabel(month)

          return {
            month,
            monthLabel,
            items: Object.freeze([...items].sort((a, b) => b.timestamp - a.timestamp)) as readonly ArchiveArticleViewContract[]
          }
        })

      return {
        year,
        months: Object.freeze(months) as readonly ArchiveMonthGroupViewContract[]
      }
    })

  return {
    total,
    yearGroups: Object.freeze(yearGroups) as readonly ArchiveYearGroupViewContract[],
    emptyState: {
      title: '暂无文章归档'
    }
  }
}

export function createArchivePageViewContract(
  articles: ArticleListItemResponse[],
  total: number,
  timeOptions?: TimeRenderOptions
): ArchivePageViewContract {
  return createArchivePageViewContractCore(articles, total, (article) => createArchiveArticleViewContract(article, timeOptions))
}

export function createStableArchivePageViewContractBuilder(): typeof createArchivePageViewContract {
  const itemCache = new Map<number, ArchiveArticleCacheEntry>()

  return (articles: ArticleListItemResponse[], total: number): ArchivePageViewContract => {
    const activeIds = new Set<number>()
    const view = createArchivePageViewContractCore(articles, total, (article) => {
      activeIds.add(article.id)
      const key = `${article.title}\u0000${article.createTime}`
      const cached = itemCache.get(article.id)
      if (cached?.key === key) {
        return cached.item
      }

      const item = createArchiveArticleViewContract(article)
      if (item) {
        itemCache.set(article.id, { key, item })
      }
      return item
    })

    for (const id of itemCache.keys()) {
      if (!activeIds.has(id)) {
        itemCache.delete(id)
      }
    }

    return view
  }
}
