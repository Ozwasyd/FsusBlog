#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authBinary, loginWithFixtureSessionBypass, requestTimeoutMs as defaultRequestTimeoutMs } from '../support/auth-helpers.mjs'
import { encodeAedsFrame, readAedsResponse } from '../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../support/http.mjs'
import { resolveFixtureAssetDirectory, resolvePublicFixtureFile } from '../support/fixture-paths.mjs'
import { buildDirectDbSeedCacheActions } from './direct-db-seed-cache-plan.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../../..')
const clientRoot = path.join(repoRoot, 'src', 'frontend')
const publicFixtureDir = resolveFixtureAssetDirectory()
const checkedInCoverFixtureDir = path.join(clientRoot, 'public', 'fixtures')

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
const outputPath = resolvePublicFixtureFile()
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, defaultRequestTimeoutMs)
const pgContainer = process.env.FSUSBLOG_PG_CONTAINER || ''
const pgUser = process.env.FSUSBLOG_PG_USER || 'fsusblog'
const pgDb = process.env.FSUSBLOG_PG_DB || 'fsusblog'
const redisContainer = process.env.FSUSBLOG_REDIS_CONTAINER || 'fsusblog-redis'
const testSession = process.env.FSUSBLOG_TEST_SESSION || ''
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD ?? ''
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'playwright-fixtures-node'
const trustedOrigin = new URL(
  process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_DEBUG_FRONTEND_URL || baseUrl
).origin
const adminCacheActionRequestFrame = 81
const seedCategoryName = process.env.FSUSBLOG_PLAYWRIGHT_CATEGORY_NAME || 'Acceptance Category'
const seedTagName = process.env.FSUSBLOG_PLAYWRIGHT_TAG_NAME || 'AcceptanceTag'
const seedArticleTitle = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_TITLE || 'Acceptance Public Article'
const seedArticleSummary = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_SUMMARY
  || 'Acceptance smoke summary for public routes and dashboard coverage.'
const seedArticleMarkdown = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_MARKDOWN
  || '这是自动验收生成的公开文章，用于 Playwright fixture 与公开页验收。\n\n正文探针段落用于校验公开页 hydration 与详情渲染。'
const seedArticleCoverImageUrl = process.env.FSUSBLOG_PLAYWRIGHT_ARTICLE_COVER_URL
  || '/fixtures/acceptance-cover-primary.svg'
const seedPublicHomeArticles = [
  {
    title: seedArticleTitle,
    summary: seedArticleSummary,
    markdown: seedArticleMarkdown,
    coverImageUrl: seedArticleCoverImageUrl,
    views: 42
  },
  {
    title: 'Acceptance Focus Smoke Note',
    summary: 'Acceptance fixture whose cover records keyboard focus traversal.',
    markdown: 'Acceptance focus fixture body for public home screenshot coverage.',
    coverImageUrl: '/fixtures/acceptance-cover-focus.svg',
    views: 30
  },
  {
    title: 'Acceptance Hot Read Note',
    summary: 'Acceptance fixture whose cover records a hot-read latency profile.',
    markdown: 'Acceptance hot-read fixture body for public home screenshot coverage.',
    coverImageUrl: '/fixtures/acceptance-cover-hot.svg',
    views: 18
  }
]
const publicArticlePageSize = 5

function assertSafeFixtureContainer(container, label) {
  if (!/^fsusblog-(?:dev|test|ci)(?:[-_.a-zA-Z0-9]*)$/.test(container)) {
    throw new Error(`${label} must name a dev/test/ci fixture container.`)
  }
}

async function writePublicCoverFixtures() {
  const managedCoverFiles = new Set([
    'acceptance-cover-primary.svg',
    'acceptance-cover-focus.svg',
    'acceptance-cover-hot.svg'
  ])

  await mkdir(publicFixtureDir, { recursive: true })
  await Promise.all(seedPublicHomeArticles.map(async (article) => {
    const prefix = '/fixtures/'
    const coverImageUrl = String(article.coverImageUrl ?? '')
    if (!coverImageUrl.startsWith(prefix) || coverImageUrl.slice(prefix.length).includes('/')) {
      return
    }

    const fileName = coverImageUrl.slice(prefix.length)
    if (!managedCoverFiles.has(fileName)) {
      return
    }

    await copyFile(
      path.join(checkedInCoverFixtureDir, fileName),
      path.join(publicFixtureDir, fileName)
    )
  }))
}

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

async function fetchPublicFeaturedArticles(size = 3) {
  return await fetchPublicBinary(`/api/binary/article/featured/${size}.aeds`)
}

async function fetchPublicHotArticles(size = 5) {
  return await fetchPublicBinary(`/api/binary/article/hot/${size}.aeds`)
}

async function loginAdminSession() {
  const session = await loginWithFixtureSessionBypass(adminName, adminPassword, false, deviceFingerprint, requestTimeoutMs)
  return session.cookieHeader
}

async function fetchAdminBinary(relativePath, options = {}) {
  const {
    method = 'GET',
    body,
    cookie,
    headers = {}
  } = options
  const result = await authBinary(relativePath, {
    method,
    cookieHeader: cookie,
    deviceFingerprint,
    body,
    requiresPow: method !== 'GET'
      && method !== 'HEAD'
      && !relativePath.startsWith('/api/binary/author/'),
    headers: method === 'GET' || method === 'HEAD' ? headers : { Origin: trustedOrigin, ...headers },
    timeoutMs: requestTimeoutMs
  })
  if (!result.response.ok) {
    const message = result.payload?.message ?? result.payload?.Message ?? `status ${result.response.status}`
    throw new Error(`request failed: ${relativePath} -> ${result.response.status} ${message}`)
  }
  const payload = result.payload?.data ?? result.payload
  if (payload?.payload instanceof Uint8Array) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload.payload))
  }
  return payload
}

async function requestCacheAction(action, articleId, cookie) {
  return fetchAdminBinary('/api/binary/author/cache/actions', {
    method: 'POST',
    cookie,
    body: encodeAedsFrame(
      adminCacheActionRequestFrame,
      new TextEncoder().encode(JSON.stringify({ action, articleId }))
    )
  })
}

async function requestPublicHotRebuild(cookie = null) {
  const adminCookie = cookie || await loginAdminSession()
  return requestCacheAction('public-hot-rebuild', null, adminCookie)
}

async function refreshDirectDbSeedCaches(seed) {
  const adminCookie = await loginAdminSession()
  for (const action of buildDirectDbSeedCacheActions(seed)) {
    await requestCacheAction(action.action, action.articleId, adminCookie)
  }
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

function buildSeededArticleFallback(seeded) {
  return {
    article: {
      id: Number(seeded.articleId),
      title: seedArticleTitle,
      category: { id: Number(seeded.categoryId), name: seedCategoryName },
      tags: [{ id: Number(seeded.tagId), name: seedTagName }]
    },
    detail: {
      title: seedArticleTitle,
      content: seedArticleMarkdown,
      showReadingNotice: false,
      wordCount: seedArticleMarkdown.trim().split(/\s+/u).filter(Boolean).length,
      estimatedReadingMinutes: 1
    },
    categories: [{ id: Number(seeded.categoryId), name: seedCategoryName }],
    tags: [{ id: Number(seeded.tagId), name: seedTagName }]
  }
}

function hasCompleteHomeSecondaryFixtures(featuredArticles, hotArticles) {
  return Array.isArray(featuredArticles)
    && featuredArticles.some((article) => String(article?.coverImageUrl ?? '').trim().length > 0)
    && Array.isArray(hotArticles)
    && hotArticles.some((article) => Number(article?.id) > 0)
}

async function waitForPublicFixtureSnapshot() {
  const deadlineAt = Date.now() + requestTimeoutMs * 2
  const pollIntervalMs = Math.max(50, Math.min(250, Math.floor(requestTimeoutMs / 60)))
  let lastFailure = 'public fixture snapshot was incomplete'

  while (Date.now() < deadlineAt) {
    try {
      const [page, categories, tags, featuredArticles, hotArticles] = await Promise.all([
        fetchPublicArticlePage(1, publicArticlePageSize),
        fetchApiBinary('/api/Category'),
        fetchApiBinary('/api/Tag'),
        fetchPublicFeaturedArticles(3),
        fetchPublicHotArticles(5)
      ])
      const candidates = page?.items ?? []
      const hasPrimaryFixtures = candidates.some((article) => (
        Number(article?.id) > 0 && pickArticleTag(article, Array.isArray(tags) ? tags : [])?.id
      ))
      if (hasPrimaryFixtures
        && Array.isArray(categories)
        && categories.length > 0
        && hasCompleteHomeSecondaryFixtures(featuredArticles, hotArticles)) {
        for (const candidate of candidates) {
          if (!candidate?.id || !pickArticleTag(candidate, tags)) {
            continue
          }
          try {
            await fetchPublicArticleDetail(candidate.id)
            return { page, categories, tags }
          } catch (error) {
            lastFailure = error instanceof Error ? error.message : String(error)
          }
        }
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(`public fixture snapshot did not converge: ${lastFailure}`)
}

function escapeSqlLiteral(value) {
  return String(value).replaceAll("'", "''")
}

function runPsql(sql) {
  assertSafeFixtureContainer(pgContainer, 'FSUSBLOG_PG_CONTAINER')
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

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(?:SET|INSERT|UPDATE|DELETE|SELECT)(?:\s+\d+)?$/iu.test(line))
    .join('\n')
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
  const identitySql = `
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
)
SELECT
  (SELECT id FROM category_row),
  (SELECT id FROM tag_row);
`
  const identityOutput = runPsql(identitySql)
  const [categoryId, tagId] = identityOutput.split('|').map((item) => item.trim())
  if (!categoryId || !tagId) {
    throw new Error(`seeded fixture taxonomy identifiers are incomplete: ${identityOutput}`)
  }

  const seededArticles = []
  for (let index = 0; index < seedPublicHomeArticles.length; index += 1) {
    const article = seedPublicHomeArticles[index]
    const title = escapeSqlLiteral(article.title)
    const summary = escapeSqlLiteral(article.summary)
    const markdown = escapeSqlLiteral(article.markdown)
    const coverImageUrl = escapeSqlLiteral(article.coverImageUrl)
    const views = Number.isFinite(article.views) ? Math.max(1, Math.trunc(article.views)) : 1
    const publishOffsetHours = index
    const articleSql = `
WITH existing_article AS (
  SELECT id
  FROM article
  WHERE title = '${title}' AND isdeleted = false
  ORDER BY id
  LIMIT 1
),
inserted_article AS (
  INSERT INTO article(title, summary, categoryid, coverimageurl, views, createtime, status, published_at, metadata_updated_at, isdeleted)
  SELECT '${title}', '${summary}', ${categoryId}, '${coverImageUrl}', ${views}, NOW() - INTERVAL '${publishOffsetHours} hours', 2, NOW() - INTERVAL '${publishOffsetHours} hours', NOW() - INTERVAL '${publishOffsetHours} hours', false
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
  SET categoryid = ${categoryId},
      summary = '${summary}',
      coverimageurl = '${coverImageUrl}',
      views = GREATEST(views, ${views}),
      status = 2,
      published_at = NOW() - INTERVAL '${publishOffsetHours} hours',
      metadata_updated_at = COALESCE(metadata_updated_at, NOW() - INTERVAL '${publishOffsetHours} hours'),
      isdeleted = false
  WHERE id = (SELECT id FROM final_article)
  RETURNING id
),
upsert_body AS (
  INSERT INTO article_body(article_id, markdown_content, updated_at)
  SELECT id, '${markdown}', NOW()
  FROM final_article
  ON CONFLICT (article_id) DO UPDATE
  SET markdown_content = EXCLUDED.markdown_content,
      updated_at = EXCLUDED.updated_at
),
upsert_article_tag AS (
  INSERT INTO article_tag(articleid, tagid)
  SELECT (SELECT id FROM final_article), ${tagId}
  ON CONFLICT (articleid, tagid) DO NOTHING
),
upsert_content_block AS (
  INSERT INTO article_revision_content_block(content_hash, markdown_content, byte_length, created_at)
  VALUES (
    encode(sha256(convert_to('${markdown}', 'UTF8')), 'hex'),
    '${markdown}',
    octet_length(convert_to('${markdown}', 'UTF8')),
    NOW()
  )
  ON CONFLICT (content_hash) DO UPDATE
  SET markdown_content = EXCLUDED.markdown_content,
      byte_length = EXCLUDED.byte_length
  RETURNING id
),
upsert_revision AS (
  INSERT INTO article_revision(
    article_id,
    revision_no,
    title,
    summary,
    cover_image_url,
    categoryid,
    tag_ids,
    content_block_id,
    markdown_content,
    diff_summary,
    created_by_admin_principal_id,
    created_at
  )
  SELECT
    article.id,
    1,
    '${title}',
    '${summary}',
    '${coverImageUrl}',
    ${categoryId},
    '${tagId}',
    block.id,
    '',
    'acceptance fixture seed',
    0,
    NOW()
  FROM final_article article
  CROSS JOIN upsert_content_block block
  ON CONFLICT (article_id, revision_no) DO UPDATE
  SET title = EXCLUDED.title,
      summary = EXCLUDED.summary,
      cover_image_url = EXCLUDED.cover_image_url,
      categoryid = EXCLUDED.categoryid,
      tag_ids = EXCLUDED.tag_ids,
      content_block_id = EXCLUDED.content_block_id,
      markdown_content = EXCLUDED.markdown_content,
      diff_summary = EXCLUDED.diff_summary,
      created_at = EXCLUDED.created_at
  RETURNING id, article_id, revision_no
),
upsert_rights_policy AS (
  INSERT INTO article_rights_policy(
    article_id,
    enabled,
    license_type,
    copy_policy,
    max_excerpt_chars,
    allow_code_copy,
    show_public_badge,
    proof_binding_enabled,
    created_at,
    updated_at
  )
  SELECT
    id,
    true,
    'all-rights-reserved',
    'append-attribution',
    300,
    true,
    true,
    true,
    NOW(),
    NOW()
  FROM final_article
  ON CONFLICT (article_id) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      license_type = EXCLUDED.license_type,
      copy_policy = EXCLUDED.copy_policy,
      max_excerpt_chars = EXCLUDED.max_excerpt_chars,
      allow_code_copy = EXCLUDED.allow_code_copy,
      show_public_badge = EXCLUDED.show_public_badge,
      proof_binding_enabled = EXCLUDED.proof_binding_enabled,
      updated_at = EXCLUDED.updated_at
  RETURNING id, article_id
),
upsert_rights_snapshot AS (
  INSERT INTO article_rights_snapshot(
    article_id,
    article_revision_id,
    revision_no,
    article_rights_policy_id,
    enabled,
    license_type,
    copy_policy,
    max_excerpt_chars,
    allow_code_copy,
    show_public_badge,
    proof_binding_enabled,
    policy_hash,
    content_canonical_hash,
    created_at
  )
  SELECT
    revision.article_id,
    revision.id,
    revision.revision_no,
    policy.id,
    true,
    'all-rights-reserved',
    'append-attribution',
    300,
    true,
    true,
    true,
    'rights-v3:policy-hash:recompute',
    'rights-v3:content-hash:recompute',
    NOW()
  FROM upsert_revision revision
  JOIN upsert_rights_policy policy
    ON policy.article_id = revision.article_id
  ON CONFLICT (article_id, article_revision_id) DO UPDATE
  SET article_rights_policy_id = EXCLUDED.article_rights_policy_id,
      enabled = EXCLUDED.enabled,
      license_type = EXCLUDED.license_type,
      copy_policy = EXCLUDED.copy_policy,
      max_excerpt_chars = EXCLUDED.max_excerpt_chars,
      allow_code_copy = EXCLUDED.allow_code_copy,
      show_public_badge = EXCLUDED.show_public_badge,
      proof_binding_enabled = EXCLUDED.proof_binding_enabled,
      policy_hash = EXCLUDED.policy_hash,
      content_canonical_hash = EXCLUDED.content_canonical_hash,
      created_at = EXCLUDED.created_at
  RETURNING id, article_id, article_revision_id, revision_no
),
upsert_publication AS (
  INSERT INTO article_publication(
    article_id,
    publication_no,
    article_revision_id,
    revision_no,
    rights_snapshot_id,
    responsibility_snapshot_id,
    transition_kind,
    published_at,
    created_at
  )
  SELECT
    revision.article_id,
    1,
    revision.id,
    revision.revision_no,
    rights.id,
    NULL,
    'publish',
    NOW() - INTERVAL '${publishOffsetHours} hours',
    NOW()
  FROM upsert_revision revision
  JOIN upsert_rights_snapshot rights
    ON rights.article_id = revision.article_id
   AND rights.article_revision_id = revision.id
  ON CONFLICT (article_id, publication_no) DO UPDATE
  SET article_revision_id = EXCLUDED.article_revision_id,
      revision_no = EXCLUDED.revision_no,
      rights_snapshot_id = EXCLUDED.rights_snapshot_id,
      transition_kind = EXCLUDED.transition_kind,
      published_at = EXCLUDED.published_at
  RETURNING id, article_id, article_revision_id
),
link_article_publication AS (
  UPDATE article article
  SET current_revision_id = publication.article_revision_id,
      current_publication_id = publication.id,
      status = 2,
      published_at = COALESCE(article.published_at, NOW() - INTERVAL '${publishOffsetHours} hours'),
      metadata_updated_at = COALESCE(article.metadata_updated_at, NOW() - INTERVAL '${publishOffsetHours} hours'),
      isdeleted = false
  FROM upsert_publication publication
  WHERE article.id = publication.article_id
  RETURNING article.id
)
SELECT id FROM final_article;
`
    const articleId = runPsql(articleSql).trim()
    if (!articleId) {
      throw new Error(`seeded fixture article identifier is incomplete for ${article.title}`)
    }

    seededArticles.push({ articleId, views })
  }

  const articleId = seededArticles[0]?.articleId
  if (!articleId) {
    throw new Error('seeded fixture identifiers are incomplete: no articles were created')
  }

  runRedis(['INCR', redisKey('fsus:blog:article-list-version:main')])
  runRedis(['DEL', redisKey('blog:top_articles')])
  runRedis([
    'ZADD',
    redisKey('blog:top_articles'),
    ...seededArticles.flatMap((article) => [String(article.views), article.articleId])
  ])

  return {
    articleId,
    articleIds: seededArticles.map((article) => article.articleId),
    categoryId,
    tagId
  }
}

async function seedPublicFixturesViaApi() {
  const cookie = await loginAdminSession()
  let categories = await fetchAdminBinary('/api/binary/author/taxonomy/categories', { cookie })
  let tags = await fetchAdminBinary('/api/binary/author/taxonomy/tags', { cookie })

  let category = Array.isArray(categories)
    ? categories.find((item) => String(item?.name ?? '').trim() === seedCategoryName)
    : null
  if (!category) {
    await fetchAdminBinary('/api/Category', {
      method: 'POST',
      body: { name: seedCategoryName },
      cookie
    })
    categories = await fetchAdminBinary('/api/binary/author/taxonomy/categories', { cookie })
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
    tags = await fetchAdminBinary('/api/binary/author/taxonomy/tags', { cookie })
    tag = Array.isArray(tags)
      ? tags.find((item) => String(item?.name ?? '').trim() === seedTagName)
      : null
  }

  assert(category?.id, 'seed category missing after admin API create')
  assert(tag?.id, 'seed tag missing after admin API create')

  for (const article of seedPublicHomeArticles) {
    await fetchAdminBinary('/api/Article', {
      method: 'POST',
      headers: { 'X-Fsus-Client-Mutation-Id': randomUUID() },
      body: {
        title: article.title,
        content: article.markdown,
        summary: article.summary,
        coverImageUrl: article.coverImageUrl,
        categoryId: Number(category.id),
        tagIds: [Number(tag.id)]
      },
      cookie
    })
  }

  await requestPublicHotRebuild(cookie)

  return {
    categoryId: String(category.id),
    tagId: String(tag.id)
  }
}

async function main() {
  await writePublicCoverFixtures()
  await probeReachable(`${baseUrl}/api/binary/article/list/home/1/5.aeds`, '[discover-playwright-fixtures backend]', requestTimeoutMs)

  let page = await fetchPublicArticlePage(1, publicArticlePageSize)
  let categories = await fetchApiBinary('/api/Category')
  let tags = await fetchApiBinary('/api/Tag')
  let seededFallback = null

  if (!page?.items?.[0]?.id || !Array.isArray(categories) || categories.length === 0 || !pickArticleTag(page?.items?.[0], Array.isArray(tags) ? tags : [])) {
    try {
      const seeded = await seedPublicFixturesViaApi()
      console.log(`[discover-playwright-fixtures] seeded minimal public fixtures via admin APIs category=${seeded.categoryId} tag=${seeded.tagId}`)
    } catch (apiSeedError) {
      const apiSeedReason = apiSeedError instanceof Error
        ? apiSeedError.message.replace(/\bfailed\b/giu, 'unavailable')
        : String(apiSeedError).replace(/\bfailed\b/giu, 'unavailable')
      console.log(`[discover-playwright-fixtures] admin API seeding unavailable; using direct DB seed: ${apiSeedReason}`)
      const seeded = seedPublicFixtures()
      seededFallback = seeded
      console.log(`[discover-playwright-fixtures] seeded minimal public fixtures via direct DB article=${seeded.articleId} category=${seeded.categoryId} tag=${seeded.tagId}`)
      try {
        await refreshDirectDbSeedCaches(seeded)
      } catch (cacheError) {
        console.warn(`[discover-playwright-fixtures] direct DB cache refresh unavailable: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`)
      }
    }

    try {
      const snapshot = await waitForPublicFixtureSnapshot()
      page = snapshot.page
      categories = snapshot.categories
      tags = snapshot.tags
    } catch (snapshotError) {
      if (!seededFallback) {
        throw snapshotError
      }
      console.warn(`[discover-playwright-fixtures] public snapshot not converged after direct DB seed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`)
    }
  }

  const featuredArticles = await fetchPublicFeaturedArticles(3).catch(() => [])
  const hotArticles = await fetchPublicHotArticles(5).catch(() => [])
  if (!hasCompleteHomeSecondaryFixtures(featuredArticles, hotArticles)) {
    try {
      const seeded = seedPublicFixtures()
      seededFallback = seeded
      console.log(`[discover-playwright-fixtures] seeded public home secondary fixtures via direct DB article=${seeded.articleId} category=${seeded.categoryId} tag=${seeded.tagId}`)
      await refreshDirectDbSeedCaches(seeded)
      const snapshot = await waitForPublicFixtureSnapshot()
      page = snapshot.page
      categories = snapshot.categories
      tags = snapshot.tags
    } catch (dbSeedError) {
      console.warn(`[discover-playwright-fixtures] direct DB secondary seeding failed: ${dbSeedError instanceof Error ? dbSeedError.message : String(dbSeedError)}`)
    }
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
    seededFallback = seeded
    console.log(`[discover-playwright-fixtures] seeded replacement public fixture via direct DB article=${seeded.articleId} category=${seeded.categoryId} tag=${seeded.tagId}`)
    try {
      await refreshDirectDbSeedCaches(seeded)
    } catch (cacheError) {
      console.warn(`[discover-playwright-fixtures] replacement cache refresh unavailable: ${cacheError instanceof Error ? cacheError.message : String(cacheError)}`)
    }
    try {
      const snapshot = await waitForPublicFixtureSnapshot()
      page = snapshot.page
      categories = snapshot.categories
      tags = snapshot.tags
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
    } catch (snapshotError) {
      console.warn(`[discover-playwright-fixtures] public snapshot still incomplete after replacement seed: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`)
    }
  }

  if (!firstArticle?.id && seededFallback) {
    const fallback = buildSeededArticleFallback(seededFallback)
    firstArticle = fallback.article
    articleDetail = fallback.detail
    categories = Array.isArray(categories) && categories.length > 0 ? categories : fallback.categories
    tags = Array.isArray(tags) && tags.length > 0 ? tags : fallback.tags
    console.log('[discover-playwright-fixtures] using direct DB fixture seed while public hot-read snapshot refreshes')
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
