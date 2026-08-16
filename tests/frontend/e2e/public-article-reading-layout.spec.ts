import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import contract from '../fixtures/public-article-reading-layout-contract.json' with { type: 'json' }

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/publicArticleReadingLayoutVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

async function openFixture(page: Page, theme: 'light' | 'dark'): Promise<{
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
  page.on('pageerror', (error) => runtimeErrors.push(error.message))
  await page.route('**/api/**', (route) => {
    apiRequestCount += 1
    return route.abort('blockedbyclient')
  })
  await page.route('**/__public-article-reading-layout-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>文章阅读布局 fixture</title></head>
          <body>
            <div id="public-article-reading-layout-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })
  await page.goto(`/__public-article-reading-layout-fixture?theme=${theme}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.publicArticleReadingLayoutFixtureReady
  ))).toBe('true')
  return { apiRequestCount: () => apiRequestCount, runtimeErrors }
}

test.describe('public article reading layout production fixture', () => {
  for (const viewport of contract.viewports) {
    for (const theme of contract.themes as Array<'light' | 'dark'>) {
      for (const zoom of contract.zooms) {
        test(`${viewport.width}px ${theme} ${zoom * 100}% keeps named reading lines`, async ({ page }) => {
          await page.setViewportSize(viewport)
          const diagnostics = await openFixture(page, theme)
          await page.evaluate((nextZoom) => {
            document.documentElement.style.zoom = String(nextZoom)
          }, zoom)

          await expect(page).toHaveTitle('文章阅读布局 fixture')
          await expect(page.locator('main[aria-label="文章阅读布局 fixture"]')).toBeVisible()
          await expect(page.locator('vite-error-overlay, #vite-error-overlay, .vite-error-overlay')).toHaveCount(0)
          await expect(page.locator('[data-reading-case="cover"] img')).toBeVisible()
          await expect(page.locator('[data-reading-case="figure"]')).toBeVisible()
          await expect(page.locator('[data-reading-case="wide-figure"]')).toBeVisible()
          await expect(page.locator('[data-reading-case="wide-code"]')).toBeVisible()
          await expect(page.locator('[data-reading-case="lightbox-trigger"]')).toBeVisible()
          await expect(page.locator('[data-reading-case="no-media"]')).toBeVisible()
          await page.locator('[data-reading-case="lightbox-trigger"]').click()
          await expect.poll(() => page.evaluate(() => (
            document.documentElement.dataset.fixtureLightboxOpen
          ))).toBe('true')

          const geometry = await page.evaluate(() => {
            const rect = (selector: string) => {
              const element = document.querySelector<HTMLElement>(selector)
              if (!element) throw new Error(`missing geometry target: ${selector}`)
              const box = element.getBoundingClientRect()
              return { left: box.left, right: box.right, width: box.width }
            }
            return {
              content: rect('[data-reading-case="content-reference"]'),
              noMedia: rect('[data-reading-case="no-media"]'),
              figure: rect('[data-reading-case="figure"]'),
              bleed: [
                rect('[data-reading-case="cover"]'),
                rect('[data-reading-case="wide-figure"]'),
                rect('[data-reading-case="wide-code"]'),
                rect('[data-reading-case="lightbox-trigger"]')
              ],
              wideCaption: rect('[data-reading-case="wide-figure"] figcaption'),
              viewportWidth: document.documentElement.clientWidth,
              scrollWidth: document.documentElement.scrollWidth
            }
          })

          const tolerance = contract.edgeTolerancePx
          expect(Math.abs(geometry.figure.left - geometry.content.left)).toBeLessThanOrEqual(tolerance)
          expect(Math.abs(geometry.figure.right - geometry.content.right)).toBeLessThanOrEqual(tolerance)
          for (const bleed of geometry.bleed) {
            expect(Math.abs(bleed.left - geometry.bleed[0]!.left)).toBeLessThanOrEqual(tolerance)
            expect(Math.abs(bleed.right - geometry.bleed[0]!.right)).toBeLessThanOrEqual(tolerance)
            expect(bleed.width).toBeGreaterThan(geometry.content.width)
          }
          expect(Math.abs(geometry.wideCaption.left - geometry.content.left)).toBeLessThanOrEqual(tolerance)
          expect(Math.abs(geometry.wideCaption.right - geometry.content.right)).toBeLessThanOrEqual(tolerance)
          expect(Math.abs(geometry.noMedia.left - geometry.content.left)).toBeLessThanOrEqual(tolerance)
          expect(Math.abs(geometry.noMedia.right - geometry.content.right)).toBeLessThanOrEqual(tolerance)
          expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + tolerance)
          expect(diagnostics.apiRequestCount()).toBe(0)
          expect(diagnostics.runtimeErrors).toEqual([])
        })
      }
    }
  }
})
