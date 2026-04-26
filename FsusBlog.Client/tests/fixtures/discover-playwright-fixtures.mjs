#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJsonLikeResponse } from '../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../support/http.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const clientRoot = path.resolve(__dirname, '../..')

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const outputPath = process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
  || path.join(clientRoot, '.playwright-fixtures.json')
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || 'fsusblog-postgres'
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog'
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || 'fsusblog-redis'
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!'
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'playwright-fixtures-node'
const seedCategoryName = process.env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME || 'Acceptance Category'
const seedTagName = process.env.FSUSBLOG_PLAYWRIGHT_TAG_NAME || 'AcceptanceTag'
const seedArticleTitle = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_TITLE || 'Acceptance Public Article'
const seedArticleSummary = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_SUMMARY
  || 'Acceptance smoke summary for public routes and dashboard coverage.'
const seedArticleMarkdown = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_MARKDOWN
  || '# Acceptance Public Article\n\n这是自动验收生成的公开文章，用于 Playwright fixture 与公开页验收。'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function fetchApiJson(relativePath) {
  const response = await fetchWithTimeout(`${baseUrl}${relativePath}`, {
    headers: {
      Accept: 'application/json'
    }
  }, requestTimeoutMs)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`request failed: ${relativePath} -> ${response.status} ${text}`)
  }

  const payload = await readJsonLikeResponse(response)
  return payload?.data ?? payload
}

async function fetchJsonWithOptions(relativePath, init = {}) {
  const response = await fetchWithTimeout(`${baseUrl}${relativePath}`, init, requestTimeoutMs)
  const payload = await readJsonLikeResponse(response).catch(() => ({}))

  if (!response.ok) {
    const message = payload?.message ?? payload?.Message ?? `status ${response.status}`
    throw new Error(`request failed: ${relativePath} -> ${response.status} ${message}`)
  }

  return payload?.data ?? payload
}

function hasLeadingDifficulty(hash, difficulty) {
  const fullBytes = Math.floor(difficulty / 2)
  for (let i = 0; i < fullBytes; i += 1) {
    if (hash[i] !== 0) {
      return false
    }
  }

  if (difficulty % 2 === 1) {
    return (hash[fullBytes] & 0xf0) === 0
  }

  return true
}

function solvePowNonce(salt, browserFp, difficulty) {
  let nonce = 0
  while (true) {
    const payload = `${salt}:${nonce}:${browserFp}`
    const hash = createHash('sha256').update(payload, 'utf8').digest()
    if (hasLeadingDifficulty(hash, difficulty)) {
      return String(nonce)
    }
    nonce += 1
  }
}

function toSafeBase64(payloadObject) {
  return Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64')
}

async function fetchPowChallenge() {
  return fetchJsonWithOptions('/api/Auth/pow-challenge', {
    headers: {
      Accept: 'application/json'
    }
  })
}

async function buildPowHeaders() {
  const challenge = await fetchPowChallenge()
  const salt = challenge.salt ?? challenge.Salt
  const signature = challenge.signature ?? challenge.Signature
  const difficulty = Number(challenge.difficulty ?? challenge.Difficulty ?? 4)
  const timestamp = Number(challenge.timestamp ?? challenge.Timestamp)
  assert(salt && signature, 'invalid pow challenge payload')

  const nonce = solvePowNonce(salt, deviceFingerprint, difficulty)
  const proof = toSafeBase64({
    powSalt: salt,
    powNonce: nonce,
    powTimestamp: timestamp,
    difficulty,
    powSignature: signature,
    browserFp: deviceFingerprint
  })

  return {
    'X-Fsus-Pow-Proof': proof,
    'X-Fsus-Device-Fp': deviceFingerprint
  }
}

async function loginAdminSession() {
  const powHeaders = await buildPowHeaders()
  const response = await fetchWithTimeout(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...powHeaders
    },
    body: JSON.stringify({
      username: adminName,
      password: adminPassword,
      rememberMe: false
    })
  }, requestTimeoutMs)

  const payload = await readJsonLikeResponse(response).catch(() => ({}))
  if (!response.ok) {
    const message = payload?.message ?? payload?.Message ?? `status ${response.status}`
    throw new Error(`admin login failed: ${message}`)
  }

  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie().map((value) => value.split(';', 1)[0]).filter(Boolean)
    : []
  assert(cookies.length > 0, 'admin login did not return auth cookies')
  return cookies.join('; ')
}

async function fetchAdminJson(relativePath, options = {}) {
  const {
    method = 'GET',
    body,
    cookie
  } = options
  const headers = {
    Accept: 'application/json',
    ...(cookie ? { Cookie: cookie } : {})
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (method !== 'GET' && method !== 'HEAD') {
    Object.assign(headers, await buildPowHeaders())
  }

  return fetchJsonWithOptions(relativePath, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
}

function buildSearchKeyword(title) {
  const normalized = String(title || '').trim().replace(/\s+/g, ' ')
  if (!normalized) {
    return 'test'
  }

  const tokens = normalized
    .split(/[\s,.;:!?()[\]{}"'`~\-_/\\|]+/)
    .map((item) => item.trim())
    .filter(Boolean)

  const longestToken = tokens.sort((left, right) => right.length - left.length)[0]
  if (longestToken && longestToken.length >= 2) {
    return longestToken.slice(0, 16)
  }

  return normalized.slice(0, Math.min(normalized.length, 8))
}

function buildProbeText(content) {
  const normalized = String(content || '')
    .replace(/[`#>*_\-\[\]()!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return ''
  }

  return normalized.slice(0, Math.min(normalized.length, 24))
}

function pickArticleTag(article, tags) {
  const articleTag = article?.tags?.[0]
  if (articleTag?.id) {
    return articleTag
  }

  return tags[0] ?? null
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''")
}

function runPsql(sql) {
  const result = spawnSync('docker', [
    'exec',
    '-i',
    pgContainer,
    'psql',
    '-U',
    pgUser,
    '-d',
    pgDb,
    '-t',
    '-A',
    '-F',
    '|',
    '-c',
    sql
  ], {
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql command failed')
  }

  return result.stdout.trim()
}

function runRedis(args) {
  const result = spawnSync('docker', [
    'exec',
    '-i',
    redisContainer,
    'redis-cli',
    ...args
  ], {
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'redis command failed')
  }

  return result.stdout.trim()
}

function seedPublicFixtures() {
  const categoryName = escapeSqlLiteral(seedCategoryName)
  const tagName = escapeSqlLiteral(seedTagName)
  const articleTitle = escapeSqlLiteral(seedArticleTitle)
  const articleSummary = escapeSqlLiteral(seedArticleSummary)
  const articleMarkdown = escapeSqlLiteral(seedArticleMarkdown)
  const sql = `
WITH category_row AS (
  INSERT INTO category(name)
  VALUES ('${categoryName}')
  ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
),
tag_row AS (
  INSERT INTO tag(name)
  VALUES ('${tagName}')
  ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
  RETURNING id
),
existing_article AS (
  SELECT id
  FROM article
  WHERE title = '${articleTitle}' AND isdeleted = false
  ORDER BY id
  LIMIT 1
),
inserted_article AS (
  INSERT INTO article(title, summary, categoryid, views, createtime, isdeleted)
  SELECT '${articleTitle}', '${articleSummary}', (SELECT id FROM category_row), 12, NOW(), false
  WHERE NOT EXISTS (SELECT 1 FROM existing_article)
  RETURNING id
),
final_article AS (
  SELECT id FROM inserted_article
  UNION ALL
  SELECT id FROM existing_article
  LIMIT 1
),
updated_article AS (
  UPDATE article
  SET categoryid = (SELECT id FROM category_row),
      summary = '${articleSummary}',
      isdeleted = false
  WHERE id = (SELECT id FROM final_article)
  RETURNING id
),
upsert_body AS (
  INSERT INTO article_body(article_id, markdown_content, updated_at)
  SELECT id, '${articleMarkdown}', NOW()
  FROM final_article
  ON CONFLICT (article_id) DO UPDATE
  SET markdown_content = EXCLUDED.markdown_content,
      updated_at = EXCLUDED.updated_at
),
upsert_article_tag AS (
  INSERT INTO article_tag(articleid, tagid)
  SELECT (SELECT id FROM final_article), (SELECT id FROM tag_row)
  ON CONFLICT (articleid, tagid) DO NOTHING
)
SELECT
  (SELECT id FROM final_article),
  (SELECT id FROM category_row),
  (SELECT id FROM tag_row);
`
  const output = runPsql(sql)
  const [articleId, categoryId, tagId] = output.split('|').map((item) => item.trim())
  if (!articleId || !categoryId || !tagId) {
    throw new Error(`seeded fixture identifiers are incomplete: ${output}`)
  }

  runRedis(['INCR', 'fsus:blog:article-list-version:main'])
  runRedis(['ZADD', 'blog:top_articles', '12', articleId])

  return { articleId, categoryId, tagId }
}

async function seedPublicFixturesViaApi() {
  const cookie = await loginAdminSession()
  let categories = await fetchAdminJson('/api/Category', { cookie })
  let tags = await fetchAdminJson('/api/Tag', { cookie })

  let category = Array.isArray(categories)
    ? categories.find((item) => String(item?.name ?? '').trim() === seedCategoryName)
    : null
  if (!category) {
    await fetchAdminJson('/api/Category', {
      method: 'POST',
      body: { name: seedCategoryName },
      cookie
    })
    categories = await fetchAdminJson('/api/Category', { cookie })
    category = Array.isArray(categories)
      ? categories.find((item) => String(item?.name ?? '').trim() === seedCategoryName)
      : null
  }

  let tag = Array.isArray(tags)
    ? tags.find((item) => String(item?.name ?? '').trim() === seedTagName)
    : null
  if (!tag) {
    await fetchAdminJson('/api/Tag', {
      method: 'POST',
      body: { name: seedTagName },
      cookie
    })
    tags = await fetchAdminJson('/api/Tag', { cookie })
    tag = Array.isArray(tags)
      ? tags.find((item) => String(item?.name ?? '').trim() === seedTagName)
      : null
  }

  assert(category?.id, 'seed category missing after admin API create')
  assert(tag?.id, 'seed tag missing after admin API create')

  await fetchAdminJson('/api/Article', {
    method: 'POST',
    body: {
      title: seedArticleTitle,
      content: seedArticleMarkdown,
      summary: seedArticleSummary,
      categoryId: Number(category.id),
      tagIds: [Number(tag.id)]
    },
    cookie
  })

  return {
    categoryId: String(category.id),
    tagId: String(tag.id)
  }
}

async function main() {
  await probeReachable(`${baseUrl}/api/Article?page=1&size=5`, '[discover-playwright-fixtures backend]', requestTimeoutMs)

  let page = await fetchApiJson('/api/Article?page=1&size=8')
  let categories = await fetchApiJson('/api/Category')
  let tags = await fetchApiJson('/api/Tag')

  if (!page?.items?.[0]?.id || !Array.isArray(categories) || categories.length === 0 || !pickArticleTag(page?.items?.[0], Array.isArray(tags) ? tags : [])) {
    try {
      const seeded = await seedPublicFixturesViaApi()
      console.log(`[discover-playwright-fixtures] seeded minimal public fixtures via admin APIs category=${seeded.categoryId} tag=${seeded.tagId}`)
    } catch (apiSeedError) {
      console.warn(`[discover-playwright-fixtures] admin API seeding failed, falling back to direct DB seed: ${apiSeedError instanceof Error ? apiSeedError.message : String(apiSeedError)}`)
      const seeded = seedPublicFixtures()
      console.log(`[discover-playwright-fixtures] seeded minimal public fixtures via direct DB article=${seeded.articleId} category=${seeded.categoryId} tag=${seeded.tagId}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
    page = await fetchApiJson('/api/Article?page=1&size=8')
    categories = await fetchApiJson('/api/Category')
    tags = await fetchApiJson('/api/Tag')
  }

  const firstArticle = page?.items?.[0]
  assert(firstArticle?.id, 'playwright fixture discovery failed: no public article found')
  assert(Array.isArray(categories) && categories.length > 0, 'playwright fixture discovery failed: no category found')
  const firstTag = pickArticleTag(firstArticle, Array.isArray(tags) ? tags : [])
  assert(firstTag?.id, 'playwright fixture discovery failed: no tag found')

  const articleDetail = await fetchApiJson(`/api/Article/${firstArticle.id}`)

  const fixtures = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    articleId: String(firstArticle.id),
    articleTitle: firstArticle.title ?? articleDetail?.title ?? '',
    categoryId: String(firstArticle.category?.id ?? categories[0].id),
    tagId: String(firstTag.id),
    searchKeyword: buildSearchKeyword(firstArticle.title ?? articleDetail?.title ?? ''),
    bodyProbeText: buildProbeText(articleDetail?.content),
    showReadingNotice: Boolean(articleDetail?.showReadingNotice),
    wordCount: Number(articleDetail?.wordCount ?? 0),
    estimatedReadingMinutes: Number(articleDetail?.estimatedReadingMinutes ?? 0)
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8')

  console.log(`[discover-playwright-fixtures] wrote ${outputPath}`)
  console.log(JSON.stringify(fixtures))
}

main().catch((error) => {
  console.error('[discover-playwright-fixtures] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
