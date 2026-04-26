import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type PlaywrightAuditFixtures = {
  generatedAt: string
  baseUrl: string
  articleId: string
  articleTitle: string
  categoryId: string
  tagId: string
  searchKeyword: string
  bodyProbeText: string
  showReadingNotice: boolean
  wordCount: number
  estimatedReadingMinutes: number
}

function resolveFixtureFile(): string {
  const configured = process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
  if (configured) {
    return path.resolve(configured)
  }

  return path.resolve(process.cwd(), '.playwright-fixtures.json')
}

export function loadAuditFixtures(): PlaywrightAuditFixtures {
  const fixtureFile = resolveFixtureFile()
  if (!existsSync(fixtureFile)) {
    throw new Error(`playwright fixture file missing: ${fixtureFile}`)
  }

  const raw = readFileSync(fixtureFile, 'utf8')
  const parsed = JSON.parse(raw) as Partial<PlaywrightAuditFixtures>

  const articleId = String(parsed.articleId ?? '').trim()
  const categoryId = String(parsed.categoryId ?? '').trim()
  const tagId = String(parsed.tagId ?? '').trim()
  const searchKeyword = String(parsed.searchKeyword ?? '').trim()
  const bodyProbeText = String(parsed.bodyProbeText ?? '').trim()

  if (!articleId || !categoryId || !tagId || !searchKeyword) {
    throw new Error(`playwright fixture file incomplete: ${fixtureFile}`)
  }

  return {
    generatedAt: String(parsed.generatedAt ?? ''),
    baseUrl: String(parsed.baseUrl ?? ''),
    articleId,
    articleTitle: String(parsed.articleTitle ?? ''),
    categoryId,
    tagId,
    searchKeyword,
    bodyProbeText,
    showReadingNotice: parsed.showReadingNotice === true,
    wordCount: Number(parsed.wordCount ?? 0),
    estimatedReadingMinutes: Number(parsed.estimatedReadingMinutes ?? 0)
  }
}
