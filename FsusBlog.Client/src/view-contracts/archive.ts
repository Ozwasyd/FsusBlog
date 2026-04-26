import type { ArticleListItemResponse } from '@/api/article'
import dayjs from 'dayjs'
import { TimeUtils } from '@/utils/time'

export type ArchiveArticleViewContract = Readonly<{
  id: number
  title: string
  createTime: string
  dayText: string
  fullLocalTimeText: string
  timestamp: number
  route: Readonly<{
    name: 'ArticleDetail'
    params: Readonly<{
      id: string
    }>
  }>
}>

export type ArchiveMonthGroupViewContract = Readonly<{
  month: string
  monthLabel: string
  items: readonly ArchiveArticleViewContract[]
}>

export type ArchiveYearGroupViewContract = Readonly<{
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

export function createArchiveArticleViewContract(article: ArticleListItemResponse): ArchiveArticleViewContract | null {
  const parsed = TimeUtils._parse(article.createTime)
  if (!parsed || !parsed.isValid()) {
    return null
  }

  return {
    id: article.id,
    title: article.title,
    createTime: article.createTime,
    dayText: parsed.format('DD'),
    fullLocalTimeText: TimeUtils.toFullLocalString(article.createTime),
    timestamp: parsed.valueOf(),
    route: {
      name: 'ArticleDetail',
      params: {
        id: String(article.id)
      }
    }
  }
}

export function createArchivePageViewContract(articles: ArticleListItemResponse[], total: number): ArchivePageViewContract {
  const yearMap = new Map<string, Map<string, ArchiveArticleViewContract[]>>()

  for (const article of articles) {
    const item = createArchiveArticleViewContract(article)
    if (!item) {
      continue
    }

    const parsed = TimeUtils._parse(article.createTime)
    if (!parsed || !parsed.isValid()) {
      continue
    }

    const year = parsed.year().toString()
    const month = parsed.format('MM')

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
          const monthLabel = dayjs(`${year}-${month}-01`).isValid()
            ? dayjs(`${year}-${month}-01`).format('MMMM')
            : month

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
