#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { chromium } from '@playwright/test'
import { readJsonLikeResponse } from '../../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../../support/http.mjs'

const baseUrl =
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((candidate) => existsSync(candidate))

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function fetchJson(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/json'
    }
  }, requestTimeoutMs)

  assert(response.ok, `${path} failed: ${response.status}`)
  return await readJsonLikeResponse(response)
}

function pickQueryFromTitle(title) {
  const normalized = String(title || '').trim()
  if (!normalized) {
    return ''
  }

  const asciiWord = normalized.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/)
  if (asciiWord) {
    return asciiWord[0]
  }

  const compact = normalized.replace(/\s+/g, '')
  return compact.slice(0, Math.min(compact.length, 4))
}

async function main() {
  await probeReachable(`${baseUrl}/search/index.manifest.json`, '[check-search-runtime frontend]', requestTimeoutMs)

  const manifest = await fetchJson('/search/index.manifest.json')
  assert(Array.isArray(manifest.initialRoles), 'manifest initialRoles invalid')
  assert(Array.isArray(manifest.backgroundRoles), 'manifest backgroundRoles invalid')
  assert(Array.isArray(manifest.deepRoles), 'manifest deepRoles invalid')

  const articlePage = await fetchJson('/api/Article?page=1&size=5')
  const items = Array.isArray(articlePage?.items) ? articlePage.items : Array.isArray(articlePage?.data?.items) ? articlePage.data.items : []
  assert(items.length > 0, 'no articles available for search runtime smoke')

  const probeArticle = items.find((item) => typeof item?.title === 'string' && item.title.trim().length > 0) ?? items[0]
  const query = pickQueryFromTitle(probeArticle.title)
  assert(query.length > 0, 'failed to derive search query from article title')

  const launchOptions = {
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  }
  if (!executablePath) {
    delete launchOptions.executablePath
  }

  const browser = await chromium.launch(launchOptions)
  const context = await browser.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true })
  const page = await context.newPage()

  const requests = new Set()
  page.on('request', (request) => {
    try {
      const url = new URL(request.url())
      if (url.origin === new URL(baseUrl).origin && url.pathname.startsWith('/search/')) {
        requests.add(url.pathname)
      }
    } catch {
      // ignore malformed urls from extensions / browser internals
    }
  })

  try {
    await page.goto(`/search?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.readyState === 'complete' && Boolean(document.querySelector('#app')), undefined, { timeout: 30000 })
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(2000)

    const bodyText = await page.locator('body').innerText()
    assert(!/TypeError|ReferenceError|search_runtime_failed|search_index_not_loaded/i.test(bodyText), 'search page surfaced runtime failure')
    assert(bodyText.includes(query) || bodyText.includes(String(probeArticle.title).trim()), 'search page did not render expected search context or results')

    assert(requests.has('/search/index.manifest.json'), 'search runtime did not request manifest')
    assert(Array.from(requests).some((path) => path.includes('/search/index.core.')), 'search runtime did not load core shard')
    assert(Array.from(requests).some((path) => path.includes('/search/index.recent.')), 'search runtime did not load recent shard')

    if (Array.isArray(manifest.deepRoles) && manifest.deepRoles.includes('body')) {
      assert(Array.from(requests).some((path) => path.includes('/search/index.body.')), 'search runtime did not load body shard for deep search')
    }

    if (Array.isArray(manifest.backgroundRoles) && manifest.backgroundRoles.includes('archive')) {
      assert(Array.from(requests).some((path) => path.includes('/search/index.archive.')), 'search runtime did not preload archive shard in background')
    }

    console.log('[check-search-runtime] ok')
  } finally {
    await context.close()
    await browser.close()
  }
}

main().catch((error) => {
  console.error('[check-search-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
