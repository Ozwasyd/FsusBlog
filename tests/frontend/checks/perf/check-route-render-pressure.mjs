#!/usr/bin/env node
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendDir = path.join(root, 'src/frontend')
const { chromium } = require(require.resolve('@playwright/test', { paths: [frontendDir] }))
const outFile = path.join(root, '.tmp/frontend/route-render-pressure.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/frontend-render-pressure-summary.json')
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const strict = process.env.FSUSBLOG_ROUTE_RENDER_PRESSURE_STRICT === '1'

const routes = [
  '/',
  '/archive',
  `/article/${process.env.FSUSBLOG_ROUTE_PRESSURE_ARTICLE_ID || '1'}`,
  `/category/${process.env.FSUSBLOG_ROUTE_PRESSURE_CATEGORY_ID || '1'}`,
  `/tag/${process.env.FSUSBLOG_ROUTE_PRESSURE_TAG_ID || '1'}`,
  `/search?q=${encodeURIComponent(process.env.FSUSBLOG_ROUTE_PRESSURE_QUERY || 'markdown')}`,
  '/login',
  '/user/profile',
  '/user/comments',
  '/user/messagebox',
  '/user/manage',
  '/user/manage/article/list',
  '/user/manage/article/write',
  '/user/manage/moderation',
  '/user/manage/moderation/comments',
  '/user/manage/security',
  '/user/manage/settings',
  '/user/manage/users',
  '/user/manage/messages'
]

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

async function measureRoute(page, route) {
  const coldStarted = performance.now()
  await page.goto(route, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(250)
  const coldReadyMs = Math.round(performance.now() - coldStarted)

  const hotStarted = performance.now()
  await page.goto(route, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(150)
  const hotReadyMs = Math.round(performance.now() - hotStarted)

  const metrics = await page.evaluate(({ coldReadyMs, hotReadyMs }) => ({
    appReadyTimeMs: coldReadyMs,
    routeTransitionTimeMs: hotReadyMs,
    domMutationCount: window.__fsusRoutePressureMutations ?? 0,
    longTaskCount: window.__fsusRoutePressureLongTasks ?? 0,
    layoutShiftCount: window.__fsusRoutePressureLayoutShifts ?? 0,
    jsHeapBytes: performance.memory?.usedJSHeapSize ?? null,
    nodeCount: document.querySelectorAll('*').length
  }), { coldReadyMs, hotReadyMs })

  const warnings = []
  if (metrics.routeTransitionTimeMs > 3500) warnings.push(`hot transition ${metrics.routeTransitionTimeMs}ms > 3500ms`)
  if (metrics.longTaskCount > 8) warnings.push(`long tasks ${metrics.longTaskCount} > 8`)
  if (metrics.domMutationCount > 9000) warnings.push(`DOM mutations ${metrics.domMutationCount} > 9000`)

  return {
    route,
    status: strict && warnings.length > 0 ? 'failed' : 'ok',
    warnings,
    ...metrics
  }
}

function writeReleaseSummary(summary) {
  ensureDir(path.dirname(releaseSummaryFile))
  const existing = fs.existsSync(releaseSummaryFile)
    ? JSON.parse(fs.readFileSync(releaseSummaryFile, 'utf8'))
    : { status: 'ok', generatedAt: new Date().toISOString(), artifacts: {} }
  const next = {
    ...existing,
    status: existing.status === 'failed' || summary.status === 'failed' ? 'failed' : 'ok',
    generatedAt: new Date().toISOString(),
    routeRenderPressure: {
      status: summary.status,
      routeCount: summary.routeCount,
      warningCount: summary.warningCount,
      artifact: relative(outFile)
    },
    artifacts: {
      ...(existing.artifacts ?? {}),
      routeRenderPressure: relative(outFile)
    }
  }
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify(next, null, 2)}\n`)
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: process.env.FSUSBLOG_TEST_SESSION
      ? { 'X-Fsus-Test-Session': process.env.FSUSBLOG_TEST_SESSION }
      : undefined
  })
  await context.addInitScript(() => {
    window.__fsusRoutePressureMutations = 0
    window.__fsusRoutePressureLongTasks = 0
    window.__fsusRoutePressureLayoutShifts = 0
    const observeMutations = () => {
      if (!document.documentElement || window.__fsusRoutePressureObserver) return
      window.__fsusRoutePressureObserver = new MutationObserver((mutations) => {
        window.__fsusRoutePressureMutations += mutations.reduce((count, item) => count + item.addedNodes.length + item.removedNodes.length, 0)
      })
      window.__fsusRoutePressureObserver.observe(document.documentElement, { childList: true, subtree: true })
    }
    observeMutations()
    document.addEventListener('DOMContentLoaded', observeMutations, { once: true })
    try {
      new PerformanceObserver((list) => {
        window.__fsusRoutePressureLongTasks += list.getEntries().length
      }).observe({ entryTypes: ['longtask'] })
      new PerformanceObserver((list) => {
        window.__fsusRoutePressureLayoutShifts += list.getEntries().length
      }).observe({ entryTypes: ['layout-shift'] })
    } catch {
      // optional metrics
    }
  })
  const page = await context.newPage()
  const results = []
  try {
    for (const route of routes) {
      results.push(await measureRoute(page, route))
    }
  } finally {
    await browser.close()
  }

  const warningCount = results.reduce((count, item) => count + item.warnings.length, 0)
  const summary = {
    status: strict && results.some((item) => item.status === 'failed') ? 'failed' : 'ok',
    generatedAt: new Date().toISOString(),
    baseUrl,
    strict,
    routeCount: results.length,
    warningCount,
    routes: results
  }
  ensureDir(path.dirname(outFile))
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  writeReleaseSummary(summary)
  if (summary.status !== 'ok') process.exit(1)
  console.log(`[route-render-pressure] ok routes=${results.length} warnings=${warningCount}`)
}

main().catch((error) => {
  console.error('[route-render-pressure] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
