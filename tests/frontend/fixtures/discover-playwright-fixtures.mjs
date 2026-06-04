#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authBinary, loginWithPow, requestTimeoutMs as defaultRequestTimeoutMs } from '../support/auth-helpers.mjs'
import { readAedsResponse } from '../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../support/http.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../../..')
const clientRoot = path.join(repoRoot, 'src', 'frontend')

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:5000'
const outputPath = process.env.FSUSBLOG_PLAYWRIGHT_FIXTURES_FILE
  || path.join(clientRoot, '.playwright-fixtures.aeds')
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, defaultRequestTimeoutMs)
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || 'fsusblog-postgres'
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog'
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || 'fsusblog-redis'
const testSession = process.env.FSUSBLOG_TEST_SESSION || ''
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!'
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'playwright-fixtures-node'
const seedCategoryName = process.env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME || 'Acceptance Category'
const seedTagName = process.env.FSUSBLOG_PLAYWRIGHT_TAG_NAME || 'AcceptanceTag'
const seedArticleTitle = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_TITLE || 'Acceptance Public Article'
const seedArticleSummary = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_SUMMARY
  || 'Acceptance smoke summary for public routes and dashboard coverage.'
const seedArticleMarkdown = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_MARKDOWN
  || '这是自动验收生成的公开文章，用于 Playwright fixture 与公开页验收。\n\n正文探针段落用于校验公开页 hydration 与详情渲染。'
const publicArticlePageSize = 5

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function fetchApiBinary(relativePath) {
  const result = await authBinary(relativePath, {
    method: 'GET',
    deviceFingerprint,
    timeoutMs: requestTimeoutMs
  })
  if (!result.response.ok) {
    throw new Error(`request failed: ${relativePath} -> ${result.response.status}`)
  }
  return result.payload?.data ?? result.payload
}

async function fetchPublicBinary(relativePath) {
  const response = await fetchWithTimeout(`${baseUrl}${relativePath}`, {
    headers: {
      Accept: 'application/octet-stream',
      'X-Fsus-Device-Fp': deviceFingerprint
    }
  }, requestTimeoutMs)
  const payload = await readAedsResponse(response).catch(() => null)
  if (!response.ok) {
    throw new Error(`request failed: ${relativePath} -> ${response.status}`)
  }
  return payload?.data ?? payload
}

async function fetchPublicArticlePage(page, size) {
  return await fetchPublicBinary(`/api/binary/article/list/home/${page}/${size}.aeds`)
}

async function fetchPublicArticleDetail(id) {
  return await fetchPublicBinary(`/api/binary/article/${id}.aeds`)
}

async function loginAdminSession() {
  const session = await loginWithPow(adminName, adminPassword, false, deviceFingerprint, requestTimeoutMs)
  return session.cookieHeader
}

async function fetchAdminBinary(relativePath, options = {}) {
  const {
    method = 'GET',
    body,
    cookie
  } = options
  const result = await authBinary(relativePath, {
    method,
    cookieHeader: cookie,
    deviceFingerprint,
    body,
    requiresPow: method !== 'GET' && method !== 'HEAD',
    timeoutMs: requestTimeoutMs
  })
  if (!result.response.ok) {
    const message = result.payload?.message ?? result.payload?.Message ?? `status ${result.response.status}`
    throw new Error(`request failed: ${relativePath} -> ${result.response.status} ${message}`)
  }
  return result.payload?.data ?? result.payload
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

function encodeFixtureValue(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64url')
}

function formatFixtureFile(fixtures) {
  return Object.entries(fixtures)
    .map(([key, value]) => `${key}\t${encodeFixtureValue(value)}`)
    .join('\n') + '\n'
}

function formatFixtureSummary(fixtures) {
  return Object.entries(fixtures)
    .map(([key, value]) => `${key}=${String(value ?? '').replace(/\s+/g, ' ').trim()}`)
    .join(' ')
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''")
}

function runPsql(sql) {
  const schema = testSession ? `fsus_e2e_${testSession.replaceAll('-', '_')}` : ''
  const scopedSql = schema ? `set search_path to "${schema}", public;\n${sql}` : sql
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
    scopedSql
  ], {
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'psql command failed')
  }

  return result.stdout.trim()
}

function redisKey(key) {
  return testSession ? `e2e:${testSession}:${key}` : key
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

  runRedis(['INCR', redisKey('fsus:blog:article-list-version:main')])
  runRedis(['ZADD', redisKey('blog:top_articles'), '12', articleId])

  return { articleId, categoryId, tagId }
}

async function seedPublicFixturesViaApi() {
  const cookie = await loginAdminSession()
  let categories = await fetchAdminBinary('/api/Category', { cookie })
  let tags = await fetchAdminBinary('/api/Tag', { cookie })

  let category = Array.isArray(categories)
    ? categories.find((item) => String(item?.name ?? '').trim() === seedCategoryName)
    : null
  if (!category) {
    await fetchAdminBinary('/api/Category', {
      method: 'POST',
      body: { name: seedCategoryName },
      cookie
    })
    categories = await fetchAdminBinary('/api/Category', { cookie })
    category = Array.isArray(categories)
      ? categories.find((item) => String(item?.name ?? '').trim() === seedCategoryName)
      : null
  }

  let tag = Array.isArray(tags)
    ? tags.find((item) => String(item?.name ?? '').trim() === seedTagName)
    : null
  if (!tag) {
    await fetchAdminBinary('/api/Tag', {
      method: 'POST',
      body: { name: seedTagName },
      cookie
    })
    tags = await fetchAdminBinary('/api/Tag', { cookie })
    tag = Array.isArray(tags)
      ? tags.find((item) => String(item?.name ?? '').trim() === seedTagName)
      : null
  }

  assert(category?.id, 'seed category missing after admin API create')
  assert(tag?.id, 'seed tag missing after admin API create')

  await fetchAdminBinary('/api/Article', {
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
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/5.aeds`, '[discover-playwright-fixtures backend]', requestTimeoutMs)

  let page = await fetchPublicArticlePage(1, publicArticlePageSize)
  let categories = await fetchApiBinary('/api/Category')
  let tags = await fetchApiBinary('/api/Tag')

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
    page = await fetchPublicArticlePage(1, publicArticlePageSize)
    categories = await fetchApiBinary('/api/Category')
    tags = await fetchApiBinary('/api/Tag')
  }

  let firstArticle = null
  let articleDetail = null
  for (const candidate of page?.items ?? []) {
    if (!candidate?.id || !pickArticleTag(candidate, Array.isArray(tags) ? tags : [])) {
      continue
    }

    try {
      articleDetail = await fetchPublicArticleDetail(candidate.id)
      firstArticle = candidate
      break
    } catch (error) {
      console.warn(`[discover-playwright-fixtures] ignoring stale article list item id=${candidate.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!firstArticle?.id) {
    const seeded = seedPublicFixtures()
    console.log(`[discover-playwright-fixtures] seeded replacement public fixture via direct DB article=${seeded.articleId} category=${seeded.categoryId} tag=${seeded.tagId}`)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    page = await fetchPublicArticlePage(1, publicArticlePageSize)
    categories = await fetchApiBinary('/api/Category')
    tags = await fetchApiBinary('/api/Tag')
    for (const candidate of page?.items ?? []) {
      if (!candidate?.id || !pickArticleTag(candidate, Array.isArray(tags) ? tags : [])) {
        continue
      }

      try {
        articleDetail = await fetchPublicArticleDetail(candidate.id)
        firstArticle = candidate
        break
      } catch {
        // Keep scanning; the list can contain stale cache entries while the acceptance environment is reused.
      }
    }
  }

  assert(firstArticle?.id, 'playwright fixture discovery failed: no public article found')
  assert(articleDetail, 'playwright fixture discovery failed: no readable public article found')
  assert(Array.isArray(categories) && categories.length > 0, 'playwright fixture discovery failed: no category found')
  const firstTag = pickArticleTag(firstArticle, Array.isArray(tags) ? tags : [])
  assert(firstTag?.id, 'playwright fixture discovery failed: no tag found')

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
  await writeFile(outputPath, formatFixtureFile(fixtures), 'utf8')

  console.log(`[discover-playwright-fixtures] wrote ${outputPath}`)
  console.log(formatFixtureSummary(fixtures))
}

main().catch((error) => {
  console.error('[discover-playwright-fixtures] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
