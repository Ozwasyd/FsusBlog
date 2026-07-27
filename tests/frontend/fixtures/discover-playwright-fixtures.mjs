#!/usr/bin/env node
// fixture-catalog: consumer playwright-fixture-discovery acceptance-representative
// fixture-catalog: producer public-content
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { authBinary, loginWithFixtureSessionBypass, requestTimeoutMs as defaultRequestTimeoutMs } from '../support/auth-helpers.mjs'
import { encodeAedsFrame, readAedsResponse } from '../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../support/http.mjs'
import { resolveFixtureAssetDirectory, resolvePublicFixtureFile } from '../support/fixture-paths.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../../..')
const clientRoot = path.join(repoRoot, 'src', 'frontend')
const publicFixtureDir = resolveFixtureAssetDirectory()
const checkedInCoverFixtureDir = path.join(clientRoot, 'public', 'fixtures')

const baseUrl = process.env.FSUSBLOG_BASE_URL || 'http://127.0.0.1:7568'
const outputPath = resolvePublicFixtureFile()
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, defaultRequestTimeoutMs)
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
  || 'Public preview content for browser verification.\n\n![Acceptance body image](/fixtures/acceptance-cover-primary.svg)\n\nThis stable paragraph verifies hydration and article rendering.'
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
    const details = result.payload?.details ?? result.payload?.Details
    const detailSuffix = typeof details === 'string' && details.trim() && details.trim() !== message
      ? ` details=${details.trim()}`
      : ''
    throw new Error(`request failed: ${relativePath} -> ${result.response.status} ${message}${detailSuffix}`)
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

  if (!page?.items?.[0]?.id || !Array.isArray(categories) || categories.length === 0 || !pickArticleTag(page?.items?.[0], Array.isArray(tags) ? tags : [])) {
    // public-api-scenario only (#1709): API failure must not fall back to direct DB seed.
    const seeded = await seedPublicFixturesViaApi()
    console.log(`[discover-playwright-fixtures] seeded minimal public fixtures via admin APIs category=${seeded.categoryId} tag=${seeded.tagId}`)

    const snapshot = await waitForPublicFixtureSnapshot()
    page = snapshot.page
    categories = snapshot.categories
    tags = snapshot.tags
  }

  const featuredArticles = await fetchPublicFeaturedArticles(3).catch(() => [])
  const hotArticles = await fetchPublicHotArticles(5).catch(() => [])
  if (!hasCompleteHomeSecondaryFixtures(featuredArticles, hotArticles)) {
    throw new Error(
      'public-content producer (public-api-scenario) did not materialize complete home secondary fixtures; refusing direct DB fallback'
    )
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
    throw new Error(
      'public-content producer (public-api-scenario) found no readable public article after API seed; refusing direct DB fallback'
    )
  }

  assert(firstArticle?.id, 'playwright fixture discovery failed: no public article found')
  assert(articleDetail, 'playwright fixture discovery failed: no readable public article found')
  assert(Array.isArray(categories) && categories.length > 0, 'playwright fixture discovery failed: no category found')
  const firstTag = pickArticleTag(firstArticle, Array.isArray(tags) ? tags : [])
  assert(firstTag?.id, 'playwright fixture discovery failed: no tag found')

  // Narrow ID projection for test consumers only — NOT FixtureReceipt authority (#1710).
  // Completeness is proven by verified FixtureReceipt postconditions, not article/category/tag IDs alone.
  const fixtures = {
    authority: 'projection-not-receipt',
    notAuthoritative: 'true',
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
