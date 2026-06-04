import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  NARROW_MOBILE_VIEWPORT,
  TABLET_VIEWPORT,
  WARMUP_TIMEOUT_MS,
  fixtures,
  openAuditedPage,
  prewarmDevRuntime,
  assertElementHitTarget,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertResponsiveLayoutContract,
  expectRouteAndShell,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

const articlePath = `/article/${fixtures.articleId}`
const execFileAsync = promisify(execFile)
const resetSecurityTestState = process.env.FSUSBLOG_RESET_SECURITY_TEST_STATE !== '0'

async function resetLocalPowRiskState() {
  if (!resetSecurityTestState) {
    return
  }

  try {
    await execFileAsync('docker', [
      'exec',
      'fsusblog-redis',
      'sh',
      '-c',
      "redis-cli --scan --pattern '*fsus:sec:pow-risk:*' | xargs -r redis-cli DEL"
    ], { timeout: 5000 })
  } catch {
    // Non-local environments may not use the developer docker container name.
  }
}

function publicExpectations() {
  return [
    {
      path: '/',
      expectedUrl: '/',
      label: 'public-home',
      selectors: [
        (page) => page.getByRole('heading', { level: 1 }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/archive',
      expectedUrl: '/archive',
      label: 'public-archive',
      selectors: [
        (page) => page.getByRole('heading', { name: /归档/i }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/about',
      expectedUrl: '/about',
      label: 'public-about',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/category/${fixtures.categoryId}`,
      expectedUrl: `/category/${fixtures.categoryId}`,
      label: 'public-category',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/tag/${fixtures.tagId}`,
      expectedUrl: `/tag/${fixtures.tagId}`,
      label: 'public-tag',
      selectors: [
        (page) => page.getByRole('heading').first(),
        (page) => page.locator('main')
      ]
    },
    {
      path: `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`,
      expectedUrl: `/search?q=${encodeURIComponent(fixtures.searchKeyword)}`,
      label: 'public-search',
      selectors: [
        (page) => page.getByText('排序', { exact: false }),
        (page) => page.locator('main')
      ]
    },
    {
      path: '/login',
      expectedUrl: '/login',
      label: 'public-login',
      selectors: [
        (page) => page.locator('#username'),
        (page) => page.locator('#password')
      ]
    }
  ]
}

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'tablet', size: TABLET_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT },
  { name: 'narrow-mobile', size: NARROW_MOBILE_VIEWPORT }
]) {
  test.describe(`public acceptance (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })
    test.describe.configure({ timeout: 240_000 })

    test.beforeAll(async ({ browser }) => {
      await prewarmDevRuntime(browser)
    })

    test.beforeEach(async () => {
      await resetLocalPowRiskState()
    })

    test('visible public routes stay clean and aligned', async ({ browser }) => {
      for (const route of publicExpectations()) {
        const session = await openAuditedPage(browser)
        try {
          await expectRouteAndShell(session.page, session.audit, route)
          const main = session.page.locator('main').first()
          if (await main.count()) {
            await assertElementInViewport(session.page, main, `${route.label} main`)
          }
          await assertResponsiveLayoutContract(session.page, route.label)
        } finally {
          await session.close()
        }
      }
    })

    test('article detail and search page stay clean', async ({ browser }) => {
      const session = await openAuditedPage(browser)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto(articlePath, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
        await settlePage(session.page)

        const article = session.page.locator('main article, main [itemtype="https://schema.org/BlogPosting"]').first()
        const commentsIsland = session.page.locator('#fsus-comments-island')
        await expect(article).toBeVisible()
        await expect(commentsIsland).toBeVisible()
        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'public-article-detail')
        await assertElementInViewport(session.page, article, 'article detail')
        await assertElementInViewport(session.page, commentsIsland, 'comments-island')
        session.audit.assertCleanSince(start, 'public-article-detail')

        const searchStart = session.audit.checkpoint()
        await session.page.goto(`/search?q=${encodeURIComponent(fixtures.searchKeyword)}`, { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page, WARMUP_TIMEOUT_MS)
        await settlePage(session.page)

        for (const label of ['最新', '热度', '相关']) {
          const sortOption = session.page
            .locator('.filter-stack .el-radio-button')
            .filter({ hasText: label })
            .first()
          await assertElementHitTarget(session.page, sortOption, `search sort ${label}`)
        }
        await assertResponsiveLayoutContract(session.page, 'public-search-sort')

        session.audit.assertCleanSince(searchStart, 'public-search-sort')
      } finally {
        await session.close()
      }
    })
  })
}
