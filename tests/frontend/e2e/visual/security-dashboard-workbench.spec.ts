import { expect, test, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

type FixtureState = 'healthy' | 'one' | 'five' | 'twenty' | 'policy' | 'unavailable'
type FixtureTheme = 'light' | 'dark'

const states: FixtureState[] = ['healthy', 'one', 'five', 'twenty', 'policy', 'unavailable']
const themes: FixtureTheme[] = ['light', 'dark']
const viewports = [
  { name: 'desktop', width: 1366, height: 768 },
  { name: 'wide-desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 375, height: 812 }
] as const
const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../../fixtures/securityDashboardWorkbenchVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

test.describe.configure({ mode: 'parallel' })

async function assertHitTarget(
  locator: Locator,
  label: string
): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, `${label} should have geometry`).not.toBeNull()
  expect(box!.width, `${label} width`).toBeGreaterThanOrEqual(44)
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(44)
}

async function assertNoHorizontalOverflow(page: Page, tolerance: number): Promise<void> {
  const overflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  expect(overflow).toBeLessThanOrEqual(tolerance)
}

async function openFixture(
  page: Page,
  state: FixtureState,
  theme: FixtureTheme
): Promise<string[]> {
  const runtimeErrors: string[] = []
  page.on('pageerror', error => runtimeErrors.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    const isViteHmrInfrastructureError = (
      text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS')
      || text.startsWith('[vite] failed to connect to websocket')
      || text.startsWith('Failed to send error to Vite server')
    )
    if (!isViteHmrInfrastructureError) runtimeErrors.push(text)
  })
  await page.route('**/__security-dashboard-workbench-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Security dashboard workbench fixture</title></head>
          <body>
            <div id="security-dashboard-workbench-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`
    })
  })
  await page.goto(`/__security-dashboard-workbench-fixture?state=${state}&theme=${theme}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.securityDashboardFixtureReady
  ))).toBe('true')
  return runtimeErrors
}

for (const viewport of viewports) {
  for (const theme of themes) {
    test.describe(`security dashboard ${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      for (const state of states) {
        test(`${state} keeps tasks first and the hierarchy flat`, async ({ page }) => {
          const runtimeErrors = await openFixture(page, state, theme)

          const workbench = page.locator('[data-security-dashboard-workbench]')
          const taskRows = page.locator('.security-task-list__item')
          const expectedRows = state === 'one' || state === 'unavailable'
            ? 1
            : state === 'five'
              ? 5
              : state === 'twenty'
                ? 20
                : 0

          await expect(workbench).toBeVisible()
          await expect(taskRows).toHaveCount(expectedRows)
          await expect(page.locator('.security-dashboard__links')).toHaveCount(0)
          await expect(page.locator('[aria-label="安全系统入口"]')).toHaveCount(0)
          await expect(page.locator('dl[aria-label="安全关键趋势"]')).toBeVisible()
          await assertNoHorizontalOverflow(page, viewport.width <= 768 ? 8 : 4)
          await assertHitTarget(
            page.getByRole('button', { name: '刷新状态' }),
            `${viewport.name} refresh`
          )

          if (expectedRows > 0) {
            const firstAction = page.locator('.security-task-list__action').first()
            await assertHitTarget(firstAction, `${viewport.name} contextual action`)
            await firstAction.focus()
            await expect(firstAction).toBeFocused()
            const focusRing = await firstAction.evaluate((element) => (
              getComputedStyle(element).boxShadow
            ))
            expect(focusRing).not.toBe('none')
          } else {
            await expect(page.getByRole('status')).toContainText('暂无待处理异常')
          }

          if (state === 'policy') {
            await expect(page.getByText('PoW 策略')).toBeVisible()
            await expect(page.getByText(/更新为\s*严格/u)).toBeVisible()
          }
          if (state === 'unavailable') {
            await expect(page.getByText('风险事件子系统不可用')).toBeVisible()
            await expect(page.getByRole('link', { name: '检查子系统' })).toBeVisible()
          }

          if (viewport.name === 'desktop' && (state === 'five' || state === 'twenty')) {
            const thirdRow = taskRows.nth(2)
            const thirdBox = await thirdRow.boundingBox()
            expect(thirdBox, 'third task row must have geometry').not.toBeNull()
            expect(thirdBox!.y + thirdBox!.height).toBeLessThanOrEqual(768)
            for (const row of await taskRows.evaluateAll((elements) => (
              elements.slice(0, 3).map((element) => element.getBoundingClientRect().height)
            ))) {
              expect(row).toBeGreaterThanOrEqual(48)
              expect(row).toBeLessThanOrEqual(56)
            }
          }
          expect(runtimeErrors, 'fixture console and page errors').toEqual([])
        })
      }
    })
  }
}

test.describe('security dashboard interaction', () => {
  test.use({ viewport: { width: 1366, height: 768 } })

  test('refreshes and follows a contextual link', async ({ page }) => {
    const runtimeErrors = await openFixture(page, 'one', 'light')

    await page.getByRole('button', { name: '刷新状态' }).click()
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.dataset.securityDashboardRefreshCount
    ))).toBe('1')

    await page.getByRole('link', { name: '处理异常' }).click()
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.dataset.securityDashboardRoutePath
    ))).toBe('/events')
    expect(runtimeErrors, 'interaction console and page errors').toEqual([])
  })
})
