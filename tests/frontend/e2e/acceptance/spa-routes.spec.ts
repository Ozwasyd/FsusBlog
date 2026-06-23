import { expect, test } from '@playwright/test'
import type { Browser, Locator, Page, StorageState } from '@playwright/test'
import {
  buildAdminRoutes,
  buildAnonymousRoutes,
  buildUserRoutes,
  type RouteCheck
} from '../../support/playwright/routeAuditMatrix'
import { loadAuditFixtures } from '../../support/playwright/routeAuditFixtures'
import { withTestSessionContextOptions } from '../../support/playwright/testSession'

type RuntimeAudit = {
  checkpoint: () => number
  assertCleanSince: (start: number, label: string) => void
}

const APP_READY_TIMEOUT_MS = 30_000
const WARMUP_TIMEOUT_MS = 45_000

const userName = process.env.FSUSBLOG_USER_USERNAME || 'binaryuser'
const userPassword = process.env.FSUSBLOG_USER_PASSWORD || 'BinaryUserPass123!'
const adminName = process.env.FSUSBLOG_ADMIN_USERNAME || 'binaryadmin'
const adminPassword = process.env.FSUSBLOG_ADMIN_PASSWORD || 'BinaryAdminPass123!'
const fixtures = loadAuditFixtures()
const anonymousRoutes = buildAnonymousRoutes(fixtures)
const userRoutes = buildUserRoutes()
const adminRoutes = buildAdminRoutes(fixtures)

function attachRuntimeAudit(page: Page): RuntimeAudit {
  const events: string[] = []

  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') {
      return
    }

    const text = message.text().trim()
    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    events.push(`console:${message.type()}:${text}`)
  })

  page.on('pageerror', (error) => {
    const text = error.message.trim()
    if (isIgnorableRuntimeMessage(text)) {
      return
    }

    const stackHead = error.stack?.split('\n').slice(1, 4).map((line) => line.trim()).join(' | ')
    events.push(`pageerror:${stackHead ? `${text} ${stackHead}` : text}`)
  })

  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText || 'request_failed'
    if (failure.includes('ERR_ABORTED') || failure.includes('ERR_NETWORK_CHANGED')) {
      return
    }

    events.push(`requestfailed:${request.method()} ${request.url()} ${failure}`)
  })

  return {
    checkpoint: () => events.length,
    assertCleanSince: (start, label) => {
      expect(events.slice(start), `${label} should not emit runtime errors or warnings`).toEqual([])
    }
  }
}

function isIgnorableRuntimeMessage(text: string): boolean {
  return text.includes('favicon.ico')
    || text.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)')
    || text.includes('Failed to load resource: net::ERR_NETWORK_CHANGED')
}

function normalizeProbeText(text: string): string {
  const normalized = String(text || '').trim()
  return normalized.replace(/^[A-Za-z0-9_-]+\s*/, '').trim()
}

async function waitForAppReady(page: Page, timeout = APP_READY_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    () => {
      const body = document.body?.innerText || ''
      return document.readyState === 'complete'
        && Boolean(document.querySelector('#app'))
        && !/INITIALIZING/i.test(body)
    },
    undefined,
    { timeout }
  )
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await page.waitForTimeout(200)
}

async function prewarmDevRuntime(browser: Browser): Promise<void> {
  const session = await openAuditedPage(browser)

  try {
    await session.page.goto('/', { waitUntil: 'domcontentloaded' })
    await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
  } finally {
    await session.close()
  }
}

async function expectRoute(page: Page, audit: RuntimeAudit, route: RouteCheck): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(route.path, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)
  await settlePage(page)

  await expect
    .poll(() => {
      const current = new URL(page.url())
      return route.expectedUrl.includes('?')
        ? `${current.pathname}${current.search}`
        : current.pathname
    }, { message: `${route.name} should land on expected route` })
    .toBe(route.expectedUrl)

  await expect(page.locator('#app')).toHaveCount(1)
  await expect(page.locator('#mfa-code')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('article_payload_invalid')
  await expectVisibleShell(page)
  audit.assertCleanSince(start, route.name)
}

async function expectVisibleShell(page: Page): Promise<void> {
  const body = page.locator('body')
  await expect(body).not.toContainText('TypeError')
  await expect(body).not.toContainText('ReferenceError')
  await expect(body).not.toContainText('Unhandled')
  await expect(body).not.toContainText('article_payload_invalid')
}

async function clickPublicNavLink(page: Page, name: string): Promise<void> {
  const links = page
    .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
    .getByRole('link', { name })
  const count = await links.count()

  for (let index = 0; index < count; index += 1) {
    const candidate = links.nth(index)
    if (await candidate.isVisible()) {
      await candidate.click()
      return
    }
  }

  throw new Error(`visible public nav link not found: ${name}`)
}

function articleHeadline(page: Page): Locator {
  return articleDetailRoot(page).locator(':scope > header').getByRole('heading', { level: 1 })
}

function articleDetailRoot(page: Page): Locator {
  return page.locator('article[itemtype="https://schema.org/BlogPosting"]')
}

async function openAuditedPage(browser: Browser, storageState?: StorageState): Promise<{
  page: Page
  audit: RuntimeAudit
  close: () => Promise<void>
}> {
  const context = await browser.newContext(withTestSessionContextOptions(storageState ? { storageState } : undefined))
  const page = await context.newPage()
  const audit = attachRuntimeAudit(page)

  return {
    page,
    audit,
    close: async () => {
      await context.close()
    }
  }
}

async function captureStorageState(
  browser: Browser,
  username: string,
  password: string,
  redirectTo: string
): Promise<StorageState> {
  const session = await openAuditedPage(browser)

  try {
    await loginViaUi(session.page, session.audit, username, password, redirectTo)
    return await session.page.context().storageState()
  } finally {
    await session.close()
  }
}

async function loginViaUi(
  page: Page,
  audit: RuntimeAudit,
  username: string,
  password: string,
  redirectTo: string
): Promise<void> {
  const start = audit.checkpoint()
  await page.goto(`/login?redirect=${encodeURIComponent(redirectTo)}`, { waitUntil: 'domcontentloaded' })
  await waitForAppReady(page)

  await page.locator('#username').fill(username)
  await page.locator('#password').fill(password)
  await page.locator('form').evaluate((form) => {
    ;(form as HTMLFormElement).requestSubmit()
  })

  await page.waitForFunction(
    () => {
      const path = `${location.pathname}${location.search}`
      return path !== '/login' && !path.startsWith('/login?')
        || Boolean(document.querySelector('#mfa-code'))
        || Boolean(document.querySelector('[role="alert"]'))
    },
    undefined,
    { timeout: 25_000 }
  )

  const alertText = (await page.locator('[role="alert"]').allTextContents()).join(' | ').trim()
  const hasMfaPrompt = await page.locator('#mfa-code').count()
  expect(hasMfaPrompt, `${username} should not be forced into MFA`).toBe(0)
  expect(alertText, `${username} login should not fail`).toBe('')

  await waitForAppReady(page)
  await settlePage(page)
  await expect
    .poll(() => {
      const current = new URL(page.url())
      return `${current.pathname}${current.search}`
    }, { message: `${username} should land on redirect target` })
    .toBe(redirectTo)

  audit.assertCleanSince(start, `${username}-login`)
}

async function expectAnyVisible(locatorCandidates: Locator[], label: string): Promise<void> {
  for (const locator of locatorCandidates) {
    if (await locator.count()) {
      const first = locator.first()
      if (await first.isVisible().catch(() => false)) {
        await expect(first, `${label} should be visible`).toBeVisible()
        return
      }
    }

    if (await locator.count()) {
      const visibleCandidate = locator.filter({ visible: true }).first()
      if (await visibleCandidate.count().catch(() => 0)) {
        await expect(visibleCandidate, `${label} should be visible`).toBeVisible()
        return
      }
    }

    if (await locator.isVisible().catch(() => false)) {
      await expect(locator, `${label} should be visible`).toBeVisible()
      return
    }
  }

  throw new Error(`${label} selector not found`)
}

test.describe('SPA route audit', () => {
  test.describe.configure({ timeout: 180_000 })

  test.beforeAll(async ({ browser }) => {
    await prewarmDevRuntime(browser)
  })

  test('dev entry serves public AOT for public routes and SPA shell for app routes', async ({ request }) => {
    const publicResponse = await request.get('/')
    expect(publicResponse.ok()).toBeTruthy()

    const publicHeaders = publicResponse.headers()
    const publicSource = publicHeaders['x-fsus-public-aot-source'] ?? ''
    expect(['server-ssr', 'spa-fallback']).toContain(publicSource)

    const publicHtml = await publicResponse.text()
    expect(publicHtml).toContain('id="app"')
    if (publicSource === 'spa-fallback') {
      expect(publicHtml).toContain('/src/bootstrap/entry.ts')
    } else {
      expect(publicHtml).toContain('data-public-hydration-kind=')
    }

    const spaResponse = await request.get('/login')
    expect(spaResponse.ok()).toBeTruthy()
    expect(spaResponse.headers()['x-fsus-public-aot-source'] ?? '').toBe('')

    const spaHtml = await spaResponse.text()
    expect(spaHtml).toContain('/src/bootstrap/entry.ts')
    expect(spaHtml).not.toContain('data-public-hydration-kind=')
  })

  test('anonymous routes stay stable', async ({ browser }) => {
    for (const route of anonymousRoutes) {
      const session = await openAuditedPage(browser)
      try {
        await expectRoute(session.page, session.audit, route)
      } finally {
        await session.close()
      }
    }
  })

  test('public AOT silently takes over full app after first intent', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/article/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      const loader = session.page.locator('#global-loader')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)

      await session.page.mouse.move(16, 16)
      await session.page.mouse.down()
      await session.page.mouse.up()
      await session.page.waitForTimeout(1200)

      await expect(loader).toBeHidden()
      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)

      await clickPublicNavLink(session.page, '归档')
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect
        .poll(() => new URL(session.page.url()).pathname, { message: 'public takeover should hand off navigation to SPA router' })
        .toBe('/archive')

      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      await expectVisibleShell(session.page)
      session.audit.assertCleanSince(start, 'public-aot-takeover')
    } finally {
      await session.close()
    }
  })

  test('public AOT route can return home without remount or hydration mismatch', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/category/${fixtures.categoryId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      const loader = session.page.locator('#global-loader')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)

      await session.page.mouse.move(16, 16)
      await session.page.mouse.down()
      await session.page.mouse.up()
      await session.page.waitForTimeout(1200)

      await session.page.getByRole('link', { name: '回到主页' }).click()
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect
        .poll(() => new URL(session.page.url()).pathname, { message: 'public route should return home without fallback remount' })
        .toBe('/')

      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      await expectVisibleShell(session.page)
      session.audit.assertCleanSince(start, 'public-aot-return-home')
    } finally {
      await session.close()
    }
  })

  test('AOT home click article should navigate to article without takeover failure', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto('/', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      const loader = session.page.locator('#global-loader')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)

      await session.page.getByRole('link', { name: fixtures.articleTitle }).first().click()
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect
        .poll(() => new URL(session.page.url()).pathname, { message: 'AOT home article click should land on article detail' })
        .toBe(`/article/${fixtures.articleId}`)

      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      await expectVisibleShell(session.page)
      session.audit.assertCleanSince(start, 'public-aot-home-open-article')
    } finally {
      await session.close()
    }
  })

  test('guest account login does not trigger MFA and routes stay stable', async ({ browser }) => {
    const storageState = await captureStorageState(browser, userName, userPassword, '/user/profile')

    for (const route of userRoutes) {
      const session = await openAuditedPage(browser, storageState)
      try {
        await expectRoute(session.page, session.audit, route)
      } finally {
        await session.close()
      }
    }
  })

  test('admin account login does not trigger MFA and routes stay stable', async ({ browser }) => {
    test.setTimeout(300_000)

    const storageState = await captureStorageState(browser, adminName, adminPassword, '/user/manage')

    for (const route of adminRoutes) {
      const session = await openAuditedPage(browser, storageState)
      try {
        await expectRoute(session.page, session.audit, route)
      } finally {
        await session.close()
      }
    }
  })

  test('protected redirect flow lands on requested page after login', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    try {
      await loginViaUi(session.page, session.audit, userName, userPassword, `/article/${fixtures.articleId}`)
      await expect(articleDetailRoot(session.page)).toBeVisible()
      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)
      session.audit.assertCleanSince(0, 'protected-redirect-flow')
    } finally {
      await session.close()
    }
  })

  test('article detail flow renders body comments and reading notice cleanly', async ({ browser }) => {
    const storageState = await captureStorageState(browser, userName, userPassword, `/article/${fixtures.articleId}`)
    const session = await openAuditedPage(browser, storageState)

    try {
      const start = session.audit.checkpoint()
      await session.page.goto(`/article/${fixtures.articleId}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect(articleDetailRoot(session.page)).toBeVisible()
      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)
      if (fixtures.bodyProbeText) {
        await expect(articleDetailRoot(session.page)).toContainText(normalizeProbeText(fixtures.bodyProbeText))
      }
      await expect(session.page.locator('#fsus-comments-island')).toBeVisible()
      await expect(session.page.locator('#fsus-comments-island-content')).toBeVisible()

      if (fixtures.showReadingNotice) {
        await expect(session.page.getByLabel('阅读前提示')).toContainText(`${fixtures.estimatedReadingMinutes}`)
      }

      await expectVisibleShell(session.page)
      session.audit.assertCleanSince(start, 'article-detail-flow')
    } finally {
      await session.close()
    }
  })

  test('search flow renders and allows sort switching without runtime errors', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      const start = session.audit.checkpoint()
      const searchPath = `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`
      await session.page.goto(searchPath, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
      await settlePage(session.page)

      await expect(session.page.locator('body')).toContainText('排序')
      await expectAnyVisible([
        session.page.locator('article'),
        session.page.getByText('没有匹配', { exact: false }),
        session.page.getByText('暂无', { exact: false }),
        session.page.getByText('暂无文章', { exact: false })
      ], 'search result shell')

      for (const label of ['最新', '热度', '相关']) {
        await session.page
          .locator('.filter-stack .el-radio-button')
          .filter({ hasText: label })
          .first()
          .click()
      }

      await expectVisibleShell(session.page)
      session.audit.assertCleanSince(start, 'search-flow')
    } finally {
      await session.close()
    }
  })

  test('user center routes render key panels without runtime errors', async ({ browser }) => {
    const storageState = await captureStorageState(browser, userName, userPassword, '/user/profile')
    const expectations: Array<{ path: string; label: string; selectors: ((page: Page) => Locator)[] }> = [
      {
        path: '/user/profile',
        label: 'user-profile',
        selectors: [
          (page) => page.getByRole('heading', { name: '个人资料' }),
          (page) => page.getByRole('button', { name: '注销账户' })
        ]
      },
      {
        path: '/user/comments',
        label: 'user-comments',
        selectors: [
          (page) => page.getByRole('heading', { name: '公开评论记录' }),
          (page) => page.getByText('公开评论记录', { exact: false })
        ]
      },
      {
        path: '/user/messagebox',
        label: 'user-messagebox',
        selectors: [
          (page) => page.getByText('我的站内信', { exact: false }),
          (page) => page.getByText('新建申诉工单', { exact: false })
        ]
      }
    ]

    for (const item of expectations) {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto(item.path, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        await expectAnyVisible(item.selectors.map((factory) => factory(session.page)), item.label)
        await expectVisibleShell(session.page)
        session.audit.assertCleanSince(start, item.label)
      } finally {
        await session.close()
      }
    }
  })

  test('admin key routes render first screen without runtime errors', async ({ browser }) => {
    const storageState = await captureStorageState(browser, adminName, adminPassword, '/user/manage')
    const expectations: Array<{ path: string; label: string; selectors: ((page: Page) => Locator)[] }> = [
      {
        path: '/user/manage/article/list',
        label: 'manage-article-list',
        selectors: [
          (page) => page.getByRole('button', { name: '写新文章' }),
          (page) => page.getByText('文章管理', { exact: false })
        ]
      },
      {
        path: '/user/manage/article/write',
        label: 'manage-article-write',
        selectors: [
          (page) => page.getByPlaceholder('在此键入博文标题...'),
          (page) => page.getByRole('button', { name: /发布|更新|确认发布/ })
        ]
      },
      {
        path: '/user/manage/settings',
        label: 'manage-settings',
        selectors: [
          (page) => page.getByText('SEO 配置', { exact: false }),
          (page) => page.getByText('页面编辑', { exact: false })
        ]
      },
      {
        path: '/user/manage/messages',
        label: 'manage-message',
        selectors: [
          (page) => page.getByText('站内信中心', { exact: false }),
          (page) => page.getByText('发送系统消息', { exact: false })
        ]
      }
    ]

    for (const item of expectations) {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto(item.path, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
        await settlePage(session.page)
        await expectAnyVisible(item.selectors.map((factory) => factory(session.page)), item.label)
        await expectVisibleShell(session.page)
        session.audit.assertCleanSince(start, item.label)
      } finally {
        await session.close()
      }
    }
  })
})
