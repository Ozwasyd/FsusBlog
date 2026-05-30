import type { ArticleListItemResponse } from '@/api/article'

function compareArticlesByCreateTime(left: ArticleListItemResponse, right: ArticleListItemResponse): number {
  const leftTime = Date.parse(left.createTime) || 0
  const rightTime = Date.parse(right.createTime) || 0
  return rightTime - leftTime || right.id - left.id
}

export function upsertArticlePreview(items: readonly ArticleListItemResponse[], preview: ArticleListItemResponse): ArticleListItemResponse[] {
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

export function removeArticlePreview(items: readonly ArticleListItemResponse[], articleId: number): ArticleListItemResponse[] {
  const index = items.findIndex((item) => item.id === articleId)
  if (index === -1) {
    return [...items]
  }

  const next = items.slice()
  next.splice(index, 1)
  return next
}

export function matchesCategoryFilter(article: ArticleListItemResponse, categoryId: number): boolean {
  return Number(article.category?.id) === Number(categoryId)
}

export function matchesTagFilter(article: ArticleListItemResponse, tagId: number): boolean {
  return Array.isArray(article.tags) && article.tags.some((tag) => Number(tag.id) === Number(tagId))
}
