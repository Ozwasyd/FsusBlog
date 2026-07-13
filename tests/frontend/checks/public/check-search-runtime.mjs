#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { decodeSearchManifest, readAedsResponse } from '../../support/aeds-envelope.mjs'
import { fetchWithTimeout, parseTimeoutMs, probeReachable } from '../../support/http.mjs'
import { readPublicFixtures } from '../../support/public-fixtures.mjs'
import { testSessionHeaders } from '../../support/test-session.mjs'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'
import { resolveRuntimeBrowserTimeoutPlan } from '../../support/runtime-browser-timeout.mjs'

const baseUrl =
  process.env.PLAYWRIGHT_BASE_URL
  || process.env.FSUSBLOG_PUBLIC_BASE_URL
  || process.env.FSUSBLOG_BASE_URL
  || 'http://127.0.0.1:3000'
const requestTimeoutMs = parseTimeoutMs(process.env.FSUSBLOG_HTTP_TIMEOUT_MS, 15000)
const pageNavigationTimeoutMs = Math.max(requestTimeoutMs * 3, 45000)
const shellReadyTimeoutMs = Math.max(
  requestTimeoutMs * 2,
  resolveRuntimeBrowserTimeoutPlan().requestTimeoutMs * 2
)
const executablePath = resolveSystemChromiumExecutablePath()
const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [process.cwd()] }))
const publicFixtures = readPublicFixtures()

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function fetchAeds(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {
    headers: {
      Accept: 'application/octet-stream'
    }
  }, requestTimeoutMs)

  assert(response.ok, `${path} failed: ${response.status}`)
  return await readAedsResponse(response)
}

async function fetchSearchManifest(path) {
  const response = await fetchWithTimeout(`${baseUrl}${path}`, {}, requestTimeoutMs)
  assert(response.ok, `${path} failed: ${response.status}`)
  return decodeSearchManifest(new Uint8Array(await response.arrayBuffer()))
}

async function waitForRequestPath(requests, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (Array.from(requests).some(predicate)) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  return Array.from(requests).some(predicate)
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
  await probeReachable(`${baseUrl}/search/index.manifest.aeds`, '[check-search-runtime frontend]', requestTimeoutMs)

  const manifest = await fetchSearchManifest('/search/index.manifest.aeds')
  assert(Array.isArray(manifest.initialRoles), 'manifest initialRoles invalid')
  assert(Array.isArray(manifest.backgroundRoles), 'manifest backgroundRoles invalid')
  assert(Array.isArray(manifest.deepRoles), 'manifest deepRoles invalid')

  const articlePage = await fetchAeds('/api/binary/article/list/home/1/5.aeds')
  const items = Array.isArray(articlePage?.items) ? articlePage.items : []

  const probeArticle = items.find((item) => typeof item?.title === 'string' && item.title.trim().length > 0)
    ?? { title: publicFixtures.searchKeyword || publicFixtures.articleTitle }
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
  const context = await browser.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true, extraHTTPHeaders: testSessionHeaders() })
  await context.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        configurable: true,
        get: () => 8
      })
    } catch {
      // Browser-only deterministic test hint.
    }

    try {
      const connection = navigator.connection ?? {}
      Object.defineProperty(connection, 'saveData', {
        configurable: true,
        get: () => false
      })

      if (!navigator.connection) {
        Object.defineProperty(Navigator.prototype, 'connection', {
          configurable: true,
          get: () => connection
        })
      }
    } catch {
      // Browser-only deterministic test hint.
    }
  })
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
    await page.goto(`/search?q=${encodeURIComponent(query)}`, {
      waitUntil: 'domcontentloaded',
      timeout: pageNavigationTimeoutMs
    })
    await page.waitForSelector('#app', { timeout: shellReadyTimeoutMs })
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(2000)

    const [loadedCore, loadedRecent] = await Promise.all([
      waitForRequestPath(requests, (path) => path.includes('/search/index.core.'), shellReadyTimeoutMs),
      waitForRequestPath(requests, (path) => path.includes('/search/index.recent.'), shellReadyTimeoutMs)
    ])
    assert(loadedCore, 'search runtime did not load core shard')
    assert(loadedRecent, 'search runtime did not load recent shard')
    const expectedTitle = String(probeArticle.title).trim()
    await page.waitForFunction(
      ({ expectedQuery, title }) => document.body.innerText.includes(expectedQuery)
        || document.body.innerText.includes(title),
      { expectedQuery: query, title: expectedTitle },
      { timeout: shellReadyTimeoutMs }
    )
    const bodyText = await page.locator('body').innerText()
    assert(!/TypeError|ReferenceError|search_runtime_failed|search_index_not_loaded/i.test(bodyText), 'search page surfaced runtime failure')

    assert(!Array.isArray(manifest.deepRoles) || !manifest.deepRoles.includes('body'), 'search runtime manifest must not advertise body deep shard')
    assert(!Array.from(requests).some((path) => path.includes('/search/index.body.')), 'search runtime should not load body shard in v3')

    if (Array.isArray(manifest.backgroundRoles) && manifest.backgroundRoles.includes('archive')) {
      const loadedArchive = await waitForRequestPath(requests, (path) => path.includes('/search/index.archive.'))
      assert(loadedArchive, 'search runtime did not preload archive shard in background')
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
