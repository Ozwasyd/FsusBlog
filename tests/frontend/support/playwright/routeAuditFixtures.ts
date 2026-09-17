import { readPublicFixtures } from '../public-fixtures.mjs'

export type PlaywrightAuditFixtures = {
  articleId: string
  articleTitle: string
  categoryId: string
  tagId: string
  searchKeyword: string
}

export function loadAuditFixtures(): PlaywrightAuditFixtures {
  const parsed = readPublicFixtures({}, { requireCurrent: true })

  const articleId = String(parsed.articleId ?? '').trim()
  const categoryId = String(parsed.categoryId ?? '').trim()
  const tagId = String(parsed.tagId ?? '').trim()
  const searchKeyword = String(parsed.searchKeyword ?? '').trim()

  if (!articleId || !categoryId || !tagId || !searchKeyword) {
    throw new Error('playwright public fixture projection is incomplete')
  }

  return {
    articleId,
    articleTitle: String(parsed.articleTitle ?? ''),
    categoryId,
    tagId,
    searchKeyword
  }
}
