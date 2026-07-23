import type { ArticleListItemResponse } from '@/api/article'

type ArticlePreviewIdentity = Pick<ArticleListItemResponse, 'id' | 'createTime'>
type ArticleFilterIdentity = ArticlePreviewIdentity & Pick<ArticleListItemResponse, 'category' | 'tags'>

const articleCreateTimeMsCache = new WeakMap<object, number>()

function resolveArticleCreateTimeMs(article: ArticlePreviewIdentity): number {
  const cached = articleCreateTimeMsCache.get(article)
  if (cached !== undefined) {
    return cached
  }

  const timeMs = Date.parse(article.createTime) || 0
  articleCreateTimeMsCache.set(article, timeMs)
  return timeMs
}

function compareArticlesByCreateTime(left: ArticlePreviewIdentity, right: ArticlePreviewIdentity): number {
  const leftTime = resolveArticleCreateTimeMs(left)
  const rightTime = resolveArticleCreateTimeMs(right)
  return rightTime - leftTime || right.id - left.id
}

export function upsertArticlePreview<T extends ArticlePreviewIdentity>(items: readonly T[], preview: T): T[] {
  const next = items.slice()
  const existingIndex = next.findIndex((item) => item.id === preview.id)
  if (existingIndex >= 0) {
    next.splice(existingIndex, 1)
  }

  const insertIndex = next.findIndex((item) => compareArticlesByCreateTime(preview, item) < 0)
  if (insertIndex === -1) {
    next.push(preview)
  } else {
    next.splice(insertIndex, 0, preview)
  }

  return next
}

export function removeArticlePreview<T extends ArticlePreviewIdentity>(items: readonly T[], articleId: number): T[] {
  const index = items.findIndex((item) => item.id === articleId)
  if (index === -1) {
    return [...items]
  }

  const next = items.slice()
  next.splice(index, 1)
  return next
}

export function matchesCategoryFilter(article: ArticleFilterIdentity, categoryId: number): boolean {
  return Number(article.category?.id) === Number(categoryId)
}

export function matchesTagFilter(article: ArticleFilterIdentity, tagId: number): boolean {
  return Array.isArray(article.tags) && article.tags.some((tag) => Number(tag.id) === Number(tagId))
}
