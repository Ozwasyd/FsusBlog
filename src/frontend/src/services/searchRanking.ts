import type { ArticleListItemResponse, PageResponse } from '@/api/article'
import type { SearchSortMode } from '@wasm/search'

type SearchableArticle = ArticleListItemResponse & Partial<{
  body: string | null
  content: string | null
}>

type FieldKey = 'title' | 'tags' | 'category' | 'summary' | 'body'

type FieldSpec = Readonly<{
  key: FieldKey
  weight: number
  b: number
}>

export const SEARCH_RANKING_FIELD_WEIGHTS: Readonly<Record<FieldKey, number>> = {
  title: 4,
  tags: 3,
  category: 2,
  summary: 1.6,
  body: 1
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { key: 'title', weight: SEARCH_RANKING_FIELD_WEIGHTS.title, b: 0.35 },
  { key: 'tags', weight: SEARCH_RANKING_FIELD_WEIGHTS.tags, b: 0.2 },
  { key: 'category', weight: SEARCH_RANKING_FIELD_WEIGHTS.category, b: 0.2 },
  { key: 'summary', weight: SEARCH_RANKING_FIELD_WEIGHTS.summary, b: 0.65 },
  { key: 'body', weight: SEARCH_RANKING_FIELD_WEIGHTS.body, b: 0.85 }
]

const K1 = 1.25
const FRESHNESS_TAU_DAYS = 180
const POPULARITY_PRIOR_VIEWS = 24
const POPULARITY_PRIOR_WEIGHT = 2

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim()
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchText(query)
  if (!normalized) {
    return []
  }

  const tokens: string[] = []
  const matches = normalized.match(/[\p{Script=Han}]+|[a-z0-9_+#.]+/gu) ?? []
  for (const value of matches) {
    if (/^[\p{Script=Han}]+$/u.test(value)) {
      tokens.push(value)
      if (value.length > 2) {
        for (let index = 0; index < value.length - 1; index += 1) {
          tokens.push(value.slice(index, index + 2))
        }
      }
      continue
    }

    tokens.push(value)
  }

  return unique(tokens)
}

function getFieldText(article: SearchableArticle, field: FieldKey): string {
  switch (field) {
    case 'tags':
      return article.tags.map((tag) => tag.name).join(' ')
    case 'category':
      return article.category?.name ?? ''
    case 'body':
      return article.body ?? article.content ?? ''
    default:
      return String(article[field] ?? '')
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) {
    return 0
  }

  let count = 0
  let offset = 0
  while (offset < haystack.length) {
    const found = haystack.indexOf(needle, offset)
    if (found === -1) {
      break
    }

    count += 1
    offset = found + Math.max(1, needle.length)
  }

  return count
}

function estimateFieldLength(text: string): number {
  return Math.max(1, tokenizeSearchQuery(text).length)
}

function resolveAverageFieldLengths(items: readonly SearchableArticle[]): Record<FieldKey, number> {
  const averages = {
    title: 1,
    tags: 1,
    category: 1,
    summary: 1,
    body: 1
  }

  if (items.length === 0) {
    return averages
  }

  for (const field of FIELD_SPECS) {
    let total = 0
    for (const item of items) {
      total += estimateFieldLength(getFieldText(item, field.key))
    }

    averages[field.key] = Math.max(1, total / items.length)
  }

  return averages
}

function resolveFieldTermScore(text: string, token: string, field: FieldSpec, avgLength: number): number {
  const normalized = normalizeSearchText(text)
  const rawTf = countOccurrences(normalized, token)
  if (rawTf === 0) {
    return 0
  }

  const tf = Math.min(rawTf, field.key === 'body' ? 3 : 8)
  const length = estimateFieldLength(normalized)
  const normalizedTf = (field.weight * tf) / ((1 - field.b) + field.b * (length / avgLength))
  return ((K1 + 1) * normalizedTf) / (K1 + normalizedTf)
}

function resolvePhraseProximity(article: SearchableArticle, normalizedQuery: string): number {
  if (!normalizedQuery) {
    return 0
  }

  const title = normalizeSearchText(article.title)
  if (title === normalizedQuery) {
    return 1
  }

  if (title.includes(normalizedQuery)) {
    return 0.75
  }

  const tags = normalizeSearchText(article.tags.map((tag) => tag.name).join(' '))
  if (tags.includes(normalizedQuery)) {
    return 0.65
  }

  const summary = normalizeSearchText(article.summary)
  return summary.includes(normalizedQuery) ? 0.35 : 0
}

function resolveFreshnessScore(article: ArticleListItemResponse, nowMs: number): number {
  const createdAt = Date.parse(article.publishedAt ?? article.createTime) || 0
  if (createdAt <= 0) {
    return 0
  }

  const ageDays = Math.max(0, (nowMs - createdAt) / 86400000)
  return Math.exp(-ageDays / FRESHNESS_TAU_DAYS)
}

function resolvePopularityBayes(article: ArticleListItemResponse, maxViews: number): number {
  const numerator = Math.log1p(Math.max(0, article.views) + POPULARITY_PRIOR_VIEWS * POPULARITY_PRIOR_WEIGHT)
  const denominator = Math.log1p(Math.max(1, maxViews) + POPULARITY_PRIOR_VIEWS * POPULARITY_PRIOR_WEIGHT)
  return denominator > 0 ? numerator / denominator : 0
}

function resolveHotScore(article: ArticleListItemResponse, maxViews: number, nowMs: number): number {
  const popularity = resolvePopularityBayes(article, maxViews)
  const createdAt = Date.parse(article.publishedAt ?? article.createTime) || nowMs
  const ageHours = Math.max(0, (nowMs - createdAt) / 3600000)
  return popularity / Math.pow(ageHours + 12, 0.35)
}

export function scoreArticleSearchResult(
  article: SearchableArticle,
  query: string,
  corpus: readonly SearchableArticle[],
  nowMs = Date.now()
): number {
  const tokens = tokenizeSearchQuery(query)
  if (tokens.length === 0) {
    return 0
  }

  const avgLengths = resolveAverageFieldLengths(corpus)
  const maxViews = Math.max(1, ...corpus.map((item) => item.views))
  let bm25f = 0

  for (const token of tokens) {
    let fieldScore = 0
    for (const field of FIELD_SPECS) {
      fieldScore += resolveFieldTermScore(getFieldText(article, field.key), token, field, avgLengths[field.key])
    }

    const idfApprox = 1 + Math.min(1.5, token.length / 4)
    bm25f += idfApprox * fieldScore
  }

  const normalizedQuery = normalizeSearchText(query)
  const phrase = resolvePhraseProximity(article, normalizedQuery)
  const freshness = resolveFreshnessScore(article, nowMs)
  const popularity = resolvePopularityBayes(article, maxViews)

  return bm25f + 0.12 * freshness + 0.08 * popularity + 0.22 * phrase
}

function resolveSortScore(
  article: SearchableArticle,
  query: string,
  sort: SearchSortMode,
  corpus: readonly SearchableArticle[],
  nowMs: number
): number {
  const relevance = scoreArticleSearchResult(article, query, corpus, nowMs)
  const maxViews = Math.max(1, ...corpus.map((item) => item.views))

  switch (sort) {
    case 'latest':
      return resolveFreshnessScore(article, nowMs) + Math.min(0.2, relevance / 25)
    case 'hot':
      return resolveHotScore(article, maxViews, nowMs) + Math.min(0.25, relevance / 20)
    default:
      return relevance
  }
}

export function rankSearchPage<TArticle extends ArticleListItemResponse>(
  response: PageResponse<TArticle>,
  query: string,
  sort: SearchSortMode,
  nowMs = Date.now()
): PageResponse<TArticle> {
  if (response.items.length <= 1) {
    return response
  }

  const corpus = response.items as SearchableArticle[]
  const ranked = response.items
    .map((item, index) => ({
      item,
      index,
      score: resolveSortScore(item as SearchableArticle, query, sort, corpus, nowMs)
    }))
    .sort((left, right) =>
      right.score - left.score
      || Date.parse(right.item.publishedAt ?? right.item.createTime) - Date.parse(left.item.publishedAt ?? left.item.createTime)
      || right.item.id - left.item.id
      || left.index - right.index
    )
    .map((entry) => entry.item)

  return {
    ...response,
    items: ranked
  }
}
