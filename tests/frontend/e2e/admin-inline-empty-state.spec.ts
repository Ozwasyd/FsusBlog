import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { resolveSystemChromiumExecutablePath } from '../support/system-chromium.mjs'
import contract from '../fixtures/admin-inline-empty-state-contract.json' with { type: 'json' }

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

const viewports = contract.visualDiagnostics.viewports

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
  test.describe(`admin inline empty states (${viewport.id})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('keeps representative states accessible, actionable and horizontally reachable', async ({ page }) => {
      const consoleErrors: string[] = []
      const pageErrors: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      page.on('pageerror', (error) => pageErrors.push(error.message))

      await openFixture(page)

      for (const caller of contract.consumerRepresentatives.filter((entry) => entry.visualRepresentative)) {
        const state = page.locator(`[data-caller="${caller.id}"] .admin-inline-empty-state`)
        await expect(state).toBeVisible()
      }

      const article = page.locator('[data-caller="article"] .admin-inline-empty-state')
      await expect(article).toHaveAttribute('role', 'status')
      await expect(article.getByText('暂无文章', { exact: true })).toBeVisible()
      await expect(article.getByText('调整筛选条件后重试。', { exact: true })).toBeVisible()
      const clearFilter = article.getByRole('button', { name: '清除筛选' })
      await expect(clearFilter).toBeEnabled()
      await clearFilter.click()
      await expect(page.getByRole('status', { name: 'Empty state action result' })).toHaveText('筛选已清除')
      await expect(article.getByRole('button', { name: '写新文章' })).toBeDisabled()

      const queue = page.locator('[data-caller="queue"] .admin-inline-empty-state')
      await expect(queue).toHaveAttribute('role', 'alert')
      await expect(queue).toHaveAttribute('aria-live', 'assertive')

      const anonymous = page.locator('[data-caller="anonymous"] .admin-inline-empty-state')
      await expect(anonymous).toHaveAttribute('role', 'status')
      await expect(anonymous).toHaveAttribute('aria-busy', 'true')

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })
  })
}
