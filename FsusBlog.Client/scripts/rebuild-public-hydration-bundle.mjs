#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readJsonLikeResponse } from '../tests/support/aeds-envelope.mjs'
import { buildPublicHydrationBundle } from './public-hydration-bundle.mjs'

const baseUrl = process.env.FSUSBLOG_BASE_URL || process.env.VITE_API_BASE_URL || 'http://127.0.0.1:5000'
const publicBaseUrl = process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:8080'
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!'
const articleId = Number(process.env.FSUSBLOG_ARTICLE_ID || '1')
const homePage = Number(process.env.FSUSBLOG_HOME_PAGE || '1')
const homeSize = Number(process.env.FSUSBLOG_HOME_SIZE || '10')
const skipHome = process.env.FSUSBLOG_REBUILD_SKIP_HOME === '1'
const includeAbout = process.env.FSUSBLOG_REBUILD_INCLUDE_ABOUT === '1'
const includeArchive = process.env.FSUSBLOG_REBUILD_INCLUDE_ARCHIVE === '1'
const includeFilter = process.env.FSUSBLOG_REBUILD_INCLUDE_FILTER === '1'
const filterRouteKey = process.env.FSUSBLOG_FILTER_ROUTE_KEY || ''
const archivePageSize = Number(process.env.FSUSBLOG_ARCHIVE_PAGE_SIZE || '100')
const deviceFingerprint = process.env.FSUSBLOG_DEVICE_FP || 'public-hydration-rebuild'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function unwrapEnvelope(payload) {
  if (payload && typeof payload === 'object' && ('data' in payload || 'code' in payload)) {
    return payload.data ?? payload
  }

  return payload
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
  const json = JSON.stringify(payloadObject)
  return Buffer.from(json, 'utf8').toString('base64')
}

function readCookieHeader(response) {
  const values = response.headers.getSetCookie()
  assert(values && values.length > 0, 'missing set-cookie in login response')

  const pairs = []
  for (const raw of values) {
    const idx = raw.indexOf(';')
    pairs.push(idx >= 0 ? raw.slice(0, idx) : raw)
  }

  return pairs.join('; ')
}

function describeBundleEntry(entry) {
  const hasIslands = Boolean(entry.islandsJson && entry.islandsJson.trim().length > 0)
  return `pageId=${entry.pageId} routeKey=${entry.routeKey} articleId=${entry.articleId ?? 'n/a'} rendererVersion=${entry.rendererVersion ?? 'n/a'} islands=${hasIslands ? 'yes' : 'no'}`
}

async function fetchJson(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {})
    }
  })

  assert(response.ok, `${path} failed: ${response.status}`)
  const payload = await readJsonLikeResponse(response)
  return unwrapEnvelope(payload)
}

async function fetchChallenge() {
  return await fetchJson('/api/Auth/pow-challenge')
}

async function loginWithPow(username, password) {
  const challenge = await fetchChallenge()
  const browserFp = deviceFingerprint
  const nonce = solvePowNonce(challenge.salt, browserFp, Number(challenge.difficulty ?? 4))
  const powHeader = toSafeBase64({
    powSalt: challenge.salt,
    powNonce: nonce,
    powTimestamp: challenge.timestamp,
    difficulty: challenge.difficulty,
    powSignature: challenge.signature,
    browserFp
  })

  const response = await fetch(`${baseUrl}/api/Auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify({ username, password })
  })

  assert(response.ok, `login failed: ${response.status}`)
  return readCookieHeader(response)
}

async function postWithPow(path, cookieHeader, body) {
  const challenge = await fetchChallenge()
  const browserFp = deviceFingerprint
  const nonce = solvePowNonce(challenge.salt, browserFp, Number(challenge.difficulty ?? 4))
  const powHeader = toSafeBase64({
    powSalt: challenge.salt,
    powNonce: nonce,
    powTimestamp: challenge.timestamp,
    difficulty: challenge.difficulty,
    powSignature: challenge.signature,
    browserFp
  })

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookieHeader,
      'X-Fsus-Pow-Proof': powHeader,
      'X-Fsus-Device-Fp': deviceFingerprint
    },
    body: JSON.stringify(body)
  })

  assert(response.ok, `${path} failed: ${response.status} ${await response.text()}`)
}

async function main() {
  assert(Number.isFinite(articleId) && articleId > 0, 'FSUSBLOG_ARTICLE_ID must be a positive number')

  console.log(
    `[rebuild-public-hydration] start baseUrl=${baseUrl} publicBaseUrl=${publicBaseUrl} articleId=${articleId} homePage=${homePage} homeSize=${homeSize} includeHome=${skipHome ? 'false' : 'true'} includeAbout=${includeAbout} includeArchive=${includeArchive} includeFilter=${includeFilter}`
  )

  const [seo, article] = await Promise.all([
    fetchJson('/api/System/seo'),
    fetchJson(`/api/Article/${articleId}`)
  ])

  const home = skipHome
    ? null
    : await fetchJson(`/api/Article?page=${homePage}&size=${homeSize}&isDeleted=false`)

  const aboutPage = includeAbout
    ? await fetchJson('/api/System/page/about')
    : null

  const archiveItems = includeArchive
    ? await fetchAllArchiveArticles(archivePageSize)
    : null

  const filterData = includeFilter
    ? await fetchFilterDataset(filterRouteKey)
    : null

  const bundle = await buildPublicHydrationBundle({
    articleId: article.id,
    title: article.title,
    content: article.content,
    summary: article.summary ?? '',
    createTime: article.createTime,
    categoryId: article.category?.id ?? null,
    categoryName: article.category?.name ?? null,
    tags: article.tags,
    siteTitle: seo.title ?? "Fsus's Blog",
    siteDescription: seo.description ?? '记录技术与生活',
    baseUrl: publicBaseUrl || seo.baseUrl?.trim() || baseUrl,
    includeHome: !skipHome,
    homeResponse: home ?? undefined,
    homePage,
    homeSize,
    includeAbout,
    about: aboutPage
      ? {
          slug: aboutPage.slug,
          content: aboutPage.content
        }
      : undefined,
    includeArchive,
    archive: archiveItems
      ? {
          articles: archiveItems
        }
      : undefined,
    includeFilter,
    filter: filterData ?? undefined
  })

  console.log(
    `[rebuild-public-hydration] bundle entries:\n  - ${bundle.entries.map(describeBundleEntry).join('\n  - ')}`
  )

  const cookieHeader = await loginWithPow(adminName, adminPassword)
  await postWithPow(`/api/Article/${article.id}/aot-bundle`, cookieHeader, bundle)

  console.log(`[rebuild-public-hydration] uploaded bundle for article=${article.id}, homePage=${homePage}, entries=${bundle.entries.length}`)
}

async function fetchAllArchiveArticles(pageSize) {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : 100
  const items = []
  let page = 1
  let total = Number.POSITIVE_INFINITY
  while (items.length < total) {
    const response = await fetchJson(`/api/Article?page=${page}&size=${size}&isDeleted=false`)
    const list = Array.isArray(response?.items) ? response.items : []
    total = Number(response?.total ?? list.length)
    for (const article of list) {
      items.push({
        id: Number(article.id),
        title: article.title ?? '',
        createTime: article.createTime ?? null
      })
    }
    if (list.length < size) {
      break
    }
    page += 1
  }
  return items
}

async function fetchFilterDataset(routeKey) {
  assert(typeof routeKey === 'string' && routeKey.trim().length > 0, 'FSUSBLOG_FILTER_ROUTE_KEY is required when FSUSBLOG_REBUILD_INCLUDE_FILTER=1')
  const normalizedRouteKey = routeKey.trim()
  const [kind, rawId] = normalizedRouteKey.split(':', 2)
  assert((kind === 'category' || kind === 'tag') && rawId, 'FSUSBLOG_FILTER_ROUTE_KEY must be category:<id> or tag:<id>')
  const id = Number(rawId)
  assert(Number.isFinite(id) && id > 0, 'FSUSBLOG_FILTER_ROUTE_KEY id must be a positive number')

  const pageIndex = 1
  const pageSize = 10
  const query = kind === 'category'
    ? `/api/Article?page=${pageIndex}&size=${pageSize}&isDeleted=false&categoryId=${id}`
    : `/api/Article?page=${pageIndex}&size=${pageSize}&isDeleted=false&tagId=${id}`
  const response = await fetchJson(query)
  const list = Array.isArray(response?.items) ? response.items : []

  return {
    routeKey: normalizedRouteKey,
    pageIndex,
    pageSize,
    total: Number(response?.total ?? list.length),
    articles: list.map((article) => ({
      id: Number(article.id),
      title: article.title ?? '',
      summary: article.summary ?? article.snippet ?? '',
      createTime: article.createTime ?? null
    }))
  }
}

main().catch((error) => {
  console.error('[rebuild-public-hydration] fatal:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
