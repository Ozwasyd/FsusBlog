import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  fixtures,
  openAuditedPage,
  prewarmDevRuntime,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import { waitForPublicHydration } from '../../support/playwright/readiness.mjs'

function articleHeadline(page: Page): Locator {
  return page
    .locator('article[itemtype="https://schema.org/BlogPosting"]')
    .locator(':scope > header')
    .getByRole('heading', { level: 1 })
}

async function clickPublicNavLink(page: Page, name: string): Promise<void> {
  const links = page
    .locator('nav[aria-label="主导航"], nav[aria-label="Primary navigation"]')
    .getByRole('link', { name })

  for (let index = 0; index < await links.count(); index += 1) {
    const candidate = links.nth(index)
    if (await candidate.isVisible()) {
      await candidate.click()
      return
    }
  }

  throw new Error(`visible public nav link not found: ${name}`)
}

test.describe('SPA browser-only hydration contract', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 })

  test.beforeAll(async ({ browser }) => {
    await prewarmDevRuntime(browser)
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

      await session.page.mouse.click(16, 16)
      await waitForPublicHydration(session.page)
      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)

      await clickPublicNavLink(session.page, '归档')
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/archive')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
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

      await session.page.mouse.click(16, 16)
      await waitForPublicHydration(session.page)
      await session.page.getByRole('link', { name: '回到主页' }).click()
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect.poll(() => new URL(session.page.url()).pathname).toBe('/')
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
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
      await session.page.getByRole('link', { name: fixtures.articleTitle }).first().click()
      await waitForAppReady(session.page)
      await settlePage(session.page)

      await expect.poll(() => new URL(session.page.url()).pathname)
        .toBe(`/article/${fixtures.articleId}`)
      await expect(articleHeadline(session.page)).toContainText(fixtures.articleTitle)
      await expect(loader).toBeHidden()
      await expect(session.page.locator('#fsus-aot-shell')).toHaveCount(1)
      session.audit.assertCleanSince(start, 'public-aot-home-open-article')
    } finally {
      await session.close()
    }
  })
})
