import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import contract from '../../fixtures/admin-inline-empty-state-contract.json' with { type: 'json' }
import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const executablePath = resolveSystemChromiumExecutablePath()

test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  }
})

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../../fixtures/adminInlineEmptyStateVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

async function openFixture(page: Page): Promise<void> {
  await page.route('**/__admin-inline-empty-state-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Admin inline empty state visual diagnostic</title></head>
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

for (const viewport of contract.visualDiagnostics.viewports) {
  test.describe(`admin inline empty state visual (${viewport.id})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('diagnoses representative hierarchy, alignment and overflow', async ({ page }) => {
      await openFixture(page)

      const fixture = page.getByRole('main', { name: 'Admin inline empty state fixture' })
      const representatives = fixture.locator('section')
      await expect(representatives).toHaveCount(3)
      await expect(fixture.locator('[data-state="neutral"]')).toHaveCount(1)
      await expect(fixture.locator('[data-state="error"]')).toHaveCount(1)
      await expect(fixture.locator('[data-state="loading"]')).toHaveCount(1)

      const leftEdges = await representatives.evaluateAll((sections) => sections.map((section) => (
        Math.round(section.getBoundingClientRect().left)
      )))
      expect(new Set(leftEdges).size).toBe(1)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      await expect(fixture).toHaveScreenshot(`admin-inline-empty-state-${viewport.id}.png`, {
        animations: 'disabled',
        caret: 'hide',
        maxDiffPixelRatio: 0.01
      })
    })
  })
}
