import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import contract from '../fixtures/public-home-editorial-contract.json' with { type: 'json' }

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/publicHomeEditorialVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

type FixtureOptions = {
  theme: 'light' | 'dark'
  locale?: 'zh-CN' | 'en-US'
  count?: 3 | 10
  cover?: 'with-cover' | 'without-cover'
}

async function openFixture(page: Page, options: FixtureOptions): Promise<{
  apiRequestCount: () => number
  runtimeErrors: readonly string[]
}> {
  let apiRequestCount = 0
  const runtimeErrors: string[] = []
  const isDevServerTransportError = (message: string): boolean => (
    message.includes('WebSocket connection to')
    || message.includes('[vite] failed to connect to websocket')
    || message.includes('Failed to send error to Vite server')
  )
  page.on('console', (message) => {
    if (message.type() === 'error' && !isDevServerTransportError(message.text())) {
      runtimeErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    runtimeErrors.push(error.message)
  })
  await page.route('**/api/**', async (route) => {
    apiRequestCount += 1
    await route.abort('blockedbyclient')
  })
  await page.route('**/__public-home-editorial-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>公开首页编辑层级 fixture</title></head>
          <body>
            <div id="public-home-editorial-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })
  const search = new URLSearchParams({
    theme: options.theme,
    locale: options.locale ?? 'zh-CN',
    count: String(options.count ?? 10),
    cover: options.cover ?? 'with-cover'
  })
  await page.goto(`/__public-home-editorial-fixture?${search}`, { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.publicHomeFixtureReady
  ))).toBe('true')
  return {
    apiRequestCount: () => apiRequestCount,
    runtimeErrors
  }
}

async function attachColorEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string
): Promise<void> {
  await testInfo.attach(`${label}-color.png`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png'
  })
  await page.evaluate(() => {
    document.documentElement.dataset.fixtureColorMode = 'grayscale'
  })
  await testInfo.attach(`${label}-grayscale.png`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png'
  })
  await page.evaluate(() => {
    delete document.documentElement.dataset.fixtureColorMode
  })
}

test.describe('public home production fixture editorial hierarchy', () => {
  for (const viewport of contract.viewports) {
    for (const theme of contract.themes as Array<'light' | 'dark'>) {
      test(`${viewport.width}px ${theme} keeps four grayscale-readable levels`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
        const diagnostics = await openFixture(page, { theme, locale: 'zh-CN', count: 10, cover: 'with-cover' })

        const leadTitle = page.locator('.home-editorial-lead__title')
        const sectionTitle = page.locator('.home-editorial-section__header h2').first()
        const feedTitle = page.locator('[data-home-feed-section] .ui-article-title').first()
        const summary = page.locator('[data-home-feed-section] .ui-article-summary').first()
        const metadata = page.locator('[data-home-feed-section] .ui-article-meta').first()
        await expect(leadTitle).toBeVisible()
        await expect(sectionTitle).toBeVisible()
        await expect(feedTitle).toBeVisible()
        await expect(summary).toBeVisible()
        await expect(metadata).toBeVisible()
        await expect(page).toHaveTitle('公开首页编辑层级 fixture')
        await expect(page.locator('main[aria-label]')).toBeVisible()
        await expect(page.locator('vite-error-overlay, #vite-error-overlay, .vite-error-overlay')).toHaveCount(0)

        const tiers = await Promise.all([
          leadTitle,
          sectionTitle,
          feedTitle,
          summary,
          metadata
        ].map((locator) => locator.evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            fontSize: Number.parseFloat(style.fontSize),
            fontWeight: Number.parseInt(style.fontWeight, 10),
            lineHeight: Number.parseFloat(style.lineHeight),
            color: style.color
          }
        })))
        expect(tiers.map(({ fontSize }) => fontSize)).toEqual([
          28,
          20,
          18,
          14,
          12
        ])
        expect(tiers.map(({ fontWeight }) => fontWeight)).toEqual([700, 700, 700, 400, 500])
        expect(tiers[3]!.lineHeight).toBeCloseTo(22.4, 1)
        expect(tiers[3]!.color).not.toBe(tiers[4]!.color)

        const leadPadding = await page.locator('[data-home-editorial-lead] > a').evaluate((element) => {
          const style = getComputedStyle(element)
          return [Number.parseFloat(style.paddingTop), Number.parseFloat(style.paddingBottom)]
        })
        expect(leadPadding).toEqual([
          viewport.width >= 768 ? 64 : 48,
          viewport.width >= 768 ? 64 : 48
        ])

        const headerLefts = await page.locator('.home-editorial-section__header').evaluateAll((elements) =>
          elements.map((element) => element.getBoundingClientRect().left)
        )
        expect(Math.max(...headerLefts) - Math.min(...headerLefts)).toBeLessThanOrEqual(1)
        expect(await page.locator('[data-home-punctuation-motif]').count()).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
          .toBeLessThanOrEqual(1)
        expect(diagnostics.apiRequestCount()).toBe(0)
        expect(diagnostics.runtimeErrors).toEqual([])

        const surfaces = await page.locator(
          '[data-home-editorial-lead] > a, [data-home-editorial-secondary] li, [data-home-feed-section] article'
        ).evaluateAll((elements) => elements.map((element) => {
          const style = getComputedStyle(element)
          return {
            backgroundImage: style.backgroundImage,
            boxShadow: style.boxShadow,
            transform: style.transform
          }
        }))
        expect(surfaces.every((surface) => surface.backgroundImage === 'none')).toBe(true)
        expect(surfaces.every((surface) => surface.boxShadow === 'none')).toBe(true)
        expect(surfaces.every((surface) => surface.transform === 'none')).toBe(true)

        await attachColorEvidence(page, testInfo, `${viewport.name}-${theme}`)
      })
    }
  }

  test('3-article English fixture without cover remains complete and backend-free', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const diagnostics = await openFixture(page, {
      theme: 'dark',
      locale: 'en-US',
      count: 3,
      cover: 'without-cover'
    })
    await expect(page.locator('[data-home-editorial-lead]')).toHaveAttribute('data-home-lead-layout', 'text')
    await expect(page.locator('[data-content-cover]')).toHaveCount(0)
    await expect(page.locator('[data-home-editorial-secondary] [data-article-id]')).toHaveCount(1)
    await expect(page.locator('[data-home-feed-section] [data-article-id]')).toHaveCount(1)
    await expect(page.locator('.home-editorial-lead__title')).toContainText('verifiable')
    await expect(page.locator('[data-home-feed-section] .ui-article-title')).toContainText('deliberately long')
    expect(diagnostics.apiRequestCount()).toBe(0)
    expect(diagnostics.runtimeErrors).toEqual([])
  })

  test('Scholarly Blue appears on interaction and keyboard activation remains wired', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await openFixture(page, { theme: 'light', locale: 'zh-CN', count: 10, cover: 'with-cover' })

    const recommendation = page.locator('[data-home-editorial-secondary] a').first()
    const recommendationTitle = recommendation.locator('span.block').first()
    const defaultColor = await recommendationTitle.evaluate((element) => getComputedStyle(element).color)
    await recommendation.hover()
    const hoverColor = await recommendationTitle.evaluate((element) => getComputedStyle(element).color)
    expect(hoverColor).not.toBe(defaultColor)
    await recommendation.focus()
    await expect(recommendation).toBeFocused()
    await recommendation.press('Space')
    await expect.poll(() => page.evaluate(() => (
      (window as Window & { __publicHomeFixtureNavigations?: string[] })
        .__publicHomeFixtureNavigations?.length ?? 0
    ))).toBe(1)
  })
})
