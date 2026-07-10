import { existsSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { resolveTestSessionFixtureFile } from './testSession'
import { resolvePublicFixtureFile } from '../fixture-paths.mjs'

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

  const sessionFixture = resolveTestSessionFixtureFile()
  if (sessionFixture && existsSync(sessionFixture)) {
    return sessionFixture
  }

  return resolvePublicFixtureFile()
}

export function loadAuditFixtures(): PlaywrightAuditFixtures {
  const fixtureFile = resolveFixtureFile()
  if (!existsSync(fixtureFile)) {
    throw new Error(`playwright fixture file missing: ${fixtureFile}`)
  }

  const raw = readFileSync(fixtureFile, 'utf8')
  const parsed = parseFixturePayload(raw)

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

function parseFixturePayload(raw: string): Partial<PlaywrightAuditFixtures> {
  const parsed: Partial<PlaywrightAuditFixtures> = {}
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const tabIndex = trimmed.indexOf('\t')
    if (tabIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, tabIndex) as keyof PlaywrightAuditFixtures
    const encoded = trimmed.slice(tabIndex + 1)
    const value = Buffer.from(encoded, 'base64url').toString('utf8')
    ;(parsed as Record<string, string>)[key] = value
  }
  return parsed
}
