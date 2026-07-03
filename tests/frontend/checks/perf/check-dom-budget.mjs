#!/usr/bin/env node
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { systemChromiumLaunchOptions } from '../../support/system-chromium.mjs'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const frontendDir = path.join(root, 'src/frontend')
const { chromium } = require(require.resolve('@playwright/test', { paths: [frontendDir] }))
const outDir = path.join(root, '.tmp/frontend/dom-budget')
const summaryFile = path.join(root, '.tmp/frontend/dom-budget.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/frontend-render-pressure-summary.json')
const baseUrl = process.env.PLAYWRIGHT_BASE_URL || process.env.FSUSBLOG_PUBLIC_BASE_URL || 'http://127.0.0.1:3000'
const strict = process.env.FSUSBLOG_DOM_BUDGET_STRICT === '1'
const routeArgIndex = process.argv.indexOf('--route')
const routeFilter = routeArgIndex >= 0 ? process.argv[routeArgIndex + 1] : ''

const routeBudgets = [
  { id: 'public-home', path: '/', nodeSoft: 1200, nodeHard: 2200, depthHard: 28 },
  { id: 'public-archive', path: '/archive', nodeSoft: 1200, nodeHard: 2200, depthHard: 28 },
  { id: 'article-detail-normal', path: `/article/${process.env.FSUSBLOG_DOM_BUDGET_ARTICLE_ID || '1'}`, nodeSoft: 1800, nodeHard: 3600, depthHard: 34 },
  { id: 'article-detail-markdown-heavy', path: `/article/${process.env.FSUSBLOG_DOM_BUDGET_ARTICLE_ID || '1'}?domBudget=markdown-heavy`, nodeSoft: 3500, nodeHard: 6500, depthHard: 40 },
  { id: 'public-category', path: `/category/${process.env.FSUSBLOG_DOM_BUDGET_CATEGORY_ID || '1'}`, nodeSoft: 1800, nodeHard: 3200, depthHard: 32 },
  { id: 'public-tag', path: `/tag/${process.env.FSUSBLOG_DOM_BUDGET_TAG_ID || '1'}`, nodeSoft: 1800, nodeHard: 3200, depthHard: 32 },
  { id: 'search', path: `/search?q=${encodeURIComponent(process.env.FSUSBLOG_DOM_BUDGET_QUERY || 'markdown')}`, nodeSoft: 1800, nodeHard: 3200, depthHard: 32 },
  { id: 'login', path: '/login', nodeSoft: 1400, nodeHard: 2600, depthHard: 30 },
  { id: 'user-profile', path: '/user/profile', nodeSoft: 1800, nodeHard: 3200, depthHard: 32 },
  { id: 'user-comments', path: '/user/comments', nodeSoft: 2200, nodeHard: 4200, depthHard: 36 },
  { id: 'messages', path: '/user/messagebox', nodeSoft: 2500, nodeHard: 4500, depthHard: 38 },
  { id: 'manage-dashboard', path: '/user/manage', nodeSoft: 3000, nodeHard: 5200, depthHard: 38 },
  { id: 'admin-article-list', path: '/user/manage/article/list', nodeSoft: 3000, nodeHard: 5200, depthHard: 38 },
  { id: 'article-write', path: '/user/manage/article/write', nodeSoft: 3500, nodeHard: 6800, depthHard: 42 },
  { id: 'manage-moderation', path: '/user/manage/moderation', nodeSoft: 3000, nodeHard: 5400, depthHard: 40 },
  { id: 'manage-moderation-comments', path: '/user/manage/moderation/comments', nodeSoft: 3400, nodeHard: 6200, depthHard: 42 },
  { id: 'manage-security', path: '/user/manage/security', nodeSoft: 3200, nodeHard: 5800, depthHard: 40 },
  { id: 'manage-settings', path: '/user/manage/settings', nodeSoft: 2600, nodeHard: 4600, depthHard: 36 },
  { id: 'manage-users', path: '/user/manage/users', nodeSoft: 3000, nodeHard: 5200, depthHard: 38 },
  { id: 'manage-messages', path: '/user/manage/messages', nodeSoft: 2800, nodeHard: 5000, depthHard: 38 }
].filter((route) => !routeFilter || route.path === routeFilter || route.id === routeFilter)

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

async function collectRouteMetrics(page, route) {
  const startedAt = performance.now()
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(250)
  const renderReadyMs = Math.round(performance.now() - startedAt)
  const metrics = await page.evaluate(() => {
    const elementList = Array.from(document.querySelectorAll('*'))
    const visible = (element) => {
      if (!(element instanceof HTMLElement)) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const depthFor = (element) => {
      let depth = 0
      let current = element
      while (current?.parentElement) {
        depth += 1
        current = current.parentElement
      }
      return depth
    }
    const subtreeSize = (element) => element.querySelectorAll('*').length + 1
    const largest = elementList
      .filter((element) => element instanceof HTMLElement)
      .map((element) => ({ element, count: subtreeSize(element) }))
      .sort((a, b) => b.count - a.count)[0]
    const labelFor = (element) => {
      if (!element) return ''
      const id = element.id ? `#${element.id}` : ''
      const classes = String(element.className || '')
        .split(/\s+/u)
        .filter(Boolean)
        .slice(0, 3)
        .map((item) => `.${item}`)
        .join('')
      return `${element.tagName.toLowerCase()}${id}${classes}`
    }

    return {
      url: `${location.pathname}${location.search}`,
      nodeCount: elementList.length,
      maxDepth: Math.max(0, ...elementList.map(depthFor)),
      hiddenMountedNodeCount: elementList.filter((element) => element instanceof HTMLElement && !visible(element)).length,
      elementPlusRootCount: document.querySelectorAll('[class*="el-"]').length,
      tableRowCount: document.querySelectorAll('tr, .el-table__row, .user-mobile-card, .messages-conversation-entry').length,
      interactiveControlCount: document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], .el-button').length,
      longTaskCount: window.__fsusDomBudgetLongTasks ?? 0,
      layoutShiftCount: window.__fsusDomBudgetLayoutShifts ?? 0,
      largestSubtreeSelector: labelFor(largest?.element),
      largestSubtreeNodeCount: largest?.count ?? 0,
      jsHeapBytes: performance.memory?.usedJSHeapSize ?? null
    }
  })

  const violations = []
  const warnings = []
  if (metrics.nodeCount > route.nodeHard) violations.push(`nodeCount ${metrics.nodeCount} > hard ${route.nodeHard}`)
  else if (metrics.nodeCount > route.nodeSoft) warnings.push(`nodeCount ${metrics.nodeCount} > soft ${route.nodeSoft}`)
  if (metrics.maxDepth > route.depthHard) violations.push(`maxDepth ${metrics.maxDepth} > hard ${route.depthHard}`)

  return {
    ...route,
    ...metrics,
    renderReadyMs,
    warnings,
    violations,
    status: violations.length > 0 ? (strict ? 'failed' : 'warn') : 'ok'
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
    domBudget: {
      status: summary.status,
      routeCount: summary.routeCount,
      warningCount: summary.warningCount,
      violationCount: summary.violationCount,
      artifact: relative(summaryFile)
    },
    artifacts: {
      ...(existing.artifacts ?? {}),
      domBudget: relative(summaryFile)
    }
  }
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify(next, null, 2)}\n`)
}

async function main() {
  ensureDir(outDir)
  const browser = await chromium.launch(systemChromiumLaunchOptions({ headless: true }))
  const context = await browser.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: process.env.FSUSBLOG_TEST_SESSION
      ? { 'X-Fsus-Test-Session': process.env.FSUSBLOG_TEST_SESSION }
      : undefined
  })
  await context.addInitScript(() => {
    window.__fsusDomBudgetLongTasks = 0
    window.__fsusDomBudgetLayoutShifts = 0
    try {
      new PerformanceObserver((list) => {
        window.__fsusDomBudgetLongTasks += list.getEntries().length
      }).observe({ entryTypes: ['longtask'] })
      new PerformanceObserver((list) => {
        window.__fsusDomBudgetLayoutShifts += list.getEntries().length
      }).observe({ entryTypes: ['layout-shift'] })
    } catch {
      // Older browser engines may not expose these entry types.
    }
  })

  const results = []
  try {
    for (const route of routeBudgets) {
      const page = await context.newPage()
      try {
        const result = await collectRouteMetrics(page, route)
        results.push(result)
        fs.writeFileSync(path.join(outDir, `${route.id}.json`), `${JSON.stringify(result, null, 2)}\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`route ${route.id} (${route.path}) failed: ${message}`)
      } finally {
        await page.close().catch(() => {})
      }
    }
  } finally {
    await browser.close()
  }

  const violationCount = results.reduce((count, item) => count + item.violations.length, 0)
  const warningCount = results.reduce((count, item) => count + item.warnings.length, 0)
  const summary = {
    status: strict && violationCount > 0 ? 'failed' : 'ok',
    generatedAt: new Date().toISOString(),
    baseUrl,
    strict,
    routeCount: results.length,
    warningCount,
    violationCount,
    routes: results
  }
  ensureDir(path.dirname(summaryFile))
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`)
  writeReleaseSummary(summary)

  if (summary.status !== 'ok') {
    console.error(`[dom-budget] failed violations=${violationCount}`)
    process.exit(1)
  }
  console.log(`[dom-budget] ok routes=${results.length} warnings=${warningCount} violations=${violationCount}`)
}

main().catch((error) => {
  console.error('[dom-budget] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
