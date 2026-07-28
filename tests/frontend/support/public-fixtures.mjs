import { existsSync, readFileSync } from 'node:fs'
import { resolvePublicFixtureFile } from './fixture-paths.mjs'

/**
 * Read public entity IDs from a verified-receipt projection (#1710/#1712).
 * Old TSV public.aeds is not accepted as authority or compat input.
 */
function readProjectionDocument() {
  const candidates = [
    process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE,
    process.env.FSUSBLOG_PUBLIC_ID_PROJECTION_FILE,
    resolvePublicFixtureFile()
  ].filter(Boolean)

  const fixturePath = candidates.find((candidate) => existsSync(candidate))
  if (!fixturePath) {
    return null
  }

  const raw = readFileSync(fixturePath, 'utf8')
  // Fail closed on legacy TSV public.aeds (tab-separated base64url rows).
  if (raw.includes('\t') && !raw.trimStart().startsWith('{')) {
    throw new Error(
      `legacy public fixture TSV is not accepted (${fixturePath}); use fsusblog.fixture-id-projection.v1 from a verified FixtureReceipt`
    )
  }

  let document
  try {
    document = JSON.parse(raw)
  } catch {
    throw new Error(`public fixture projection is not valid JSON: ${fixturePath}`)
  }

  if (document?.schema !== 'fsusblog.fixture-id-projection.v1' && document?.notAuthoritative !== true) {
    throw new Error(
      `public fixture file must be fixture-id-projection.v1 (not authoritative receipt): ${fixturePath}`
    )
  }
  if (document?.schema === 'fsusblog.fixture-receipt.v1' || document?.schema === 'fsusblog.fixture-receipt.v2') {
    throw new Error('FixtureReceipt cannot be consumed as a public ID projection')
  }
  return document
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function firstIdByKind(document, kind) {
  if (document?.idsByKind?.[kind]?.[0]) return document.idsByKind[kind][0]
  const match = (document?.entities ?? []).find((item) => item.kind === kind)
  return match?.id ?? null
}

export function readPublicFixtureIds(defaults = {}, { requireCurrent = false } = {}) {
  const document = readProjectionDocument()
  if (!document) {
    if (requireCurrent) {
      throw new Error('current-run public fixture projection is missing')
    }
    return {
      articleId: positiveInt(defaults.articleId, 0),
      categoryId: positiveInt(defaults.categoryId, 0),
      tagId: positiveInt(defaults.tagId, 0)
    }
  }

  const articleId = positiveInt(document.articleId ?? firstIdByKind(document, 'article'), 0)
  const categoryId = positiveInt(document.categoryId ?? firstIdByKind(document, 'category'), 0)
  const tagId = positiveInt(document.tagId ?? firstIdByKind(document, 'tag'), 0)

  if (requireCurrent) {
    const missing = []
    if (!articleId) missing.push('articleId')
    if (!categoryId) missing.push('categoryId')
    if (!tagId) missing.push('tagId')
    if (missing.length) {
      throw new Error(`current-run public fixtures are missing: ${missing.join(', ')}`)
    }
  }

  return {
    articleId: articleId || positiveInt(defaults.articleId, 0),
    categoryId: categoryId || positiveInt(defaults.categoryId, 0),
    tagId: tagId || positiveInt(defaults.tagId, 0)
  }
}

export function readPublicFixtures(defaults = {}) {
  const document = readProjectionDocument() ?? {}
  const ids = readPublicFixtureIds(defaults)
  const article = (document.entities ?? []).find((item) => item.kind === 'article')
  return {
    ...document,
    ...ids,
    articleTitle: String(article?.handle || defaults.articleTitle || ''),
    searchKeyword: String(document.searchKeyword || defaults.searchKeyword || '')
  }
}
