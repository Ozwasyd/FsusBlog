import type { ArticleListItemResponse } from '@/api/article'

export function compareArticlesByCreateTime(left: ArticleListItemResponse, right: ArticleListItemResponse): number {
  const leftTime = Date.parse(left.createTime) || 0
  const rightTime = Date.parse(right.createTime) || 0
  return rightTime - leftTime || right.id - left.id
}

export function upsertArticlePreview(items: readonly ArticleListItemResponse[], preview: ArticleListItemResponse): ArticleListItemResponse[] {
  const next = items.filter((item) => item.id !== preview.id)
  next.push(preview)
  next.sort(compareArticlesByCreateTime)
  return next
}

export function removeArticlePreview(items: readonly ArticleListItemResponse[], articleId: number): ArticleListItemResponse[] {
  return items.filter((item) => item.id !== articleId)
}

export function matchesCategoryFilter(article: ArticleListItemResponse, categoryId: number): boolean {
  return Number(article.category?.id) === Number(categoryId)
}

export function matchesTagFilter(article: ArticleListItemResponse, tagId: number): boolean {
  return Array.isArray(article.tags) && article.tags.some((tag) => Number(tag.id) === Number(tagId))
}
