import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { resolveSystemChromiumExecutablePath } from '../support/system-chromium.mjs'

const executablePath = resolveSystemChromiumExecutablePath()

test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-features=LocalNetworkAccessChecks']
  }
})

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/adminInlineEmptyStateVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

const viewports = [
  { name: 'desktop', width: 1280, height: 800, expectedPadding: '20px' },
  { name: 'mobile', width: 375, height: 812, expectedPadding: '16px' }
] as const

async function openFixture(page: Page): Promise<void> {
  await page.route('**/__admin-inline-empty-state-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Admin inline empty state fixture</title></head>
          <body>
            <div id="admin-inline-empty-state-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })

  await page.goto('/__admin-inline-empty-state-fixture__', { waitUntil: 'domcontentloaded' })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.adminInlineEmptyStateFixtureReady
  ))).toBe('true')
}

for (const viewport of viewports) {
  test.describe(`admin inline empty states (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('share the responsive inset across article, category, user and queue callers', async ({ page }) => {
      const consoleErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })

      await openFixture(page)

      for (const caller of ['article', 'category', 'user', 'queue', 'anonymous']) {
        const state = page.locator(`[data-caller="${caller}"] .admin-inline-empty-state`)
        await expect(state).toBeVisible()
        await expect(state).toHaveCSS('padding-top', viewport.expectedPadding)
        await expect(state).toHaveCSS('padding-right', viewport.expectedPadding)
        await expect(state).toHaveCSS('padding-bottom', viewport.expectedPadding)
        await expect(state).toHaveCSS('padding-left', viewport.expectedPadding)
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      expect(consoleErrors).toEqual([])

      if (process.env.FSUSBLOG_EMPTY_STATE_SCREENSHOT_DIR) {
        await page.screenshot({
          fullPage: true,
          path: path.join(process.env.FSUSBLOG_EMPTY_STATE_SCREENSHOT_DIR, `admin-inline-empty-state-${viewport.name}.png`)
        })
      }
    })
  })
}
