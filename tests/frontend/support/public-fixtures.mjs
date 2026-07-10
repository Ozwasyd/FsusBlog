import { existsSync, readFileSync } from 'node:fs'
import { resolvePublicFixtureFile } from './fixture-paths.mjs'

function decodeFixtureValue(value) {
  try {
    return Buffer.from(String(value ?? ''), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function readFixtureFile({ ignoreBaseUrl = false } = {}) {
  const candidates = [
    process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE,
    resolvePublicFixtureFile()
  ].filter(Boolean)

  const fixturePath = candidates.find((candidate) => existsSync(candidate))
  if (!fixturePath) {
    return {}
  }

  const values = {}
  const raw = readFileSync(fixturePath, 'utf8')
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue
    }

    const [key, encoded] = line.split('\t')
    if (!key || encoded == null) {
      continue
    }

    values[key] = decodeFixtureValue(encoded)
  }

  const expectedBaseUrl = String(process.env.FSUSBLOG_BASE_URL ?? '').trim().replace(/\/+$/u, '')
  const fixtureBaseUrl = String(values.baseUrl ?? '').trim().replace(/\/+$/u, '')
  if (!ignoreBaseUrl && expectedBaseUrl && fixtureBaseUrl && expectedBaseUrl !== fixtureBaseUrl) {
    return {}
  }

  return values
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function readPublicFixtureIds(defaults = {}) {
  const fixtures = readFixtureFile()
  return {
    articleId: positiveInt(fixtures.articleId, positiveInt(defaults.articleId, 1)),
    categoryId: positiveInt(fixtures.categoryId, positiveInt(defaults.categoryId, 1)),
    tagId: positiveInt(fixtures.tagId, positiveInt(defaults.tagId, 1)),
  }
}

export function readPublicFixtures(defaults = {}) {
  const fixtures = readFixtureFile({ ignoreBaseUrl: true })
  return {
    ...fixtures,
    articleId: positiveInt(fixtures.articleId, positiveInt(defaults.articleId, 1)),
    categoryId: positiveInt(fixtures.categoryId, positiveInt(defaults.categoryId, 1)),
    tagId: positiveInt(fixtures.tagId, positiveInt(defaults.tagId, 1)),
    articleTitle: String(fixtures.articleTitle || defaults.articleTitle || ''),
    searchKeyword: String(fixtures.searchKeyword || defaults.searchKeyword || '')
  }
}
