#!/usr/bin/env node

import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(require.resolve('@playwright/test', { paths: [resolve(process.cwd(), 'node_modules')] }))

const baseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:8080'
const articlePath = process.env.FSUSBLOG_PWA_OFFLINE_ARTICLE_PATH || '/article/1'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

async function waitForController(page) {
  await page.waitForFunction(() => 'serviceWorker' in navigator, null, { timeout: 10_000 })
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready
    return Boolean(registration?.active && navigator.serviceWorker.controller)
  }, null, { timeout: 10_000 })
}

async function expectOfflineNavigationFailure(page, path) {
  let failed = false
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 5_000 })
  } catch {
    failed = true
  }

  assert(failed, `${path} must not be available from the offline public shell cache`)
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  })
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

    await context.setOffline(true)
    const offlineResponse = await page.goto(articlePath, { waitUntil: 'domcontentloaded' })
    assert(offlineResponse?.ok(), `${articlePath} offline cached load failed: ${offlineResponse?.status()}`)
    assert(offlineResponse.headers()['x-fsus-offline-stale'] === '1', 'offline public article must be marked stale')

    const bodyText = (await page.locator('body').textContent()) || ''
    assert(bodyText.length > 200, 'offline public article body must render cached content')
    assert(!bodyText.includes('binary-network-unavailable'), 'offline shell must not be the binary API fallback')

    await expectOfflineNavigationFailure(page, '/user/profile')
    await expectOfflineNavigationFailure(page, '/admin')
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
