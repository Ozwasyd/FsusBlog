#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [resolve(process.cwd(), 'node_modules')] }))

const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080'
const articlePath = process.env.FSUSBLOG_PWA_OFFLINE_ARTICLE_PATH || '/article/1'
const executablePath = resolveSystemChromiumExecutablePath()

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function waitForController(page) {
  await page.waitForFunction(() => 'serviceWorker' in navigator, null, { timeout: 10_000 })
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready
    return Boolean(registration?.active)
  }, null, { timeout: 10_000 })
  const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller))
  if (!controlled) {
    await page.reload({ waitUntil: 'networkidle' })
  }
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 10_000 })
}

async function expectOfflineNavigationRejected(page, path, expectedFallback = null) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 5_000 })
  assert(response?.status() === 503, `${path} offline navigation expected 503, got ${response?.status()}`)
  assert(!response.headers()['x-fsus-offline-stale'], `${path} must not be marked as an offline stale hit`)
  if (expectedFallback) {
    assert(
      response.headers()['x-fsus-service-worker-fallback'] === expectedFallback,
      `${path} offline fallback mismatch`
    )
  }
}

async function main() {
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  }
  if (executablePath) {
    launchOptions.executablePath = executablePath
  }

  const browser = await chromium.launch(launchOptions)
  const context = await browser.newContext({
    baseURL: baseUrl,
    serviceWorkers: 'allow'
  })
  const page = await context.newPage()

  try {
    const firstResponse = await page.goto(articlePath, { waitUntil: 'networkidle' })
    assert(firstResponse?.ok(), `${articlePath} initial load failed: ${firstResponse?.status()}`)

    await waitForController(page)

    const cachedResponse = await page.goto(articlePath, { waitUntil: 'networkidle' })
    assert(cachedResponse?.ok(), `${articlePath} controlled load failed: ${cachedResponse?.status()}`)
    const articleWasCached = await page.evaluate(async (path) => {
      for (const cacheName of await caches.keys()) {
        if (!cacheName.startsWith('fsus-shell-')) continue
        const cache = await caches.open(cacheName)
        if ((await cache.keys()).some((request) => new URL(request.url).pathname === path)) return true
      }
      return false
    }, articlePath)
    assert(!articleWasCached, `${articlePath} private/no-store nonce HTML entered shell Cache Storage`)

    await context.setOffline(true)
    await expectOfflineNavigationRejected(page, articlePath)
    await expectOfflineNavigationRejected(page, '/user/profile', 'private-network-unavailable')
    await expectOfflineNavigationRejected(page, '/admin', 'private-network-unavailable')
  } finally {
    await context.setOffline(false).catch(() => {})
    await browser.close()
  }

  console.log(`[check-pwa-offline-smoke] ok | base=${baseUrl} article=${articlePath}`)
}

main().catch((error) => {
  console.error('[check-pwa-offline-smoke] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
