import { expect, test, type Page } from '@playwright/test'
import {
  assertElementHitTarget,
  assertNoHorizontalOverflow,
  expectStableScreenshot
} from '../../support/playwright/acceptance-shared'

type DashboardWorkload = 'zero' | 'high'
type DashboardTheme = 'light' | 'dark'

const workloads: DashboardWorkload[] = ['zero', 'high']
const themes: DashboardTheme[] = ['light', 'dark']
const viewports = [
  { name: 'desktop', width: 1366, height: 768 },
  { name: 'mobile', width: 390, height: 844 }
] as const

async function openDashboardFixture(
  page: Page,
  workload: DashboardWorkload,
  theme: DashboardTheme
): Promise<void> {
  await page.route('**/__admin-dashboard-workbench-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Admin dashboard workbench fixture</title></head>
          <body>
            <div id="admin-dashboard-workbench-fixture"></div>
            <script type="module" src="/tests/frontend/fixtures/adminDashboardWorkbenchVisual.ts"></script>
          </body>
        </html>`
    })
  })

  await page.goto(`/__admin-dashboard-workbench-fixture?workload=${workload}&theme=${theme}`, {
    waitUntil: 'domcontentloaded'
  })
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.adminDashboardFixtureReady
  ))).toBe('true')
}

for (const viewport of viewports) {
  for (const theme of themes) {
    for (const workload of workloads) {
      test.describe(`admin dashboard ${workload} workload (${viewport.name}, ${theme})`, () => {
        test.use({ viewport: { width: viewport.width, height: viewport.height } })

        test('keeps every task actionable and the ledger compact', async ({ page }) => {
          await openDashboardFixture(page, workload, theme)

          const workbench = page.locator('.dashboard-wrapper')
          const taskLinks = page.getByRole('list', { name: '今日待处理任务' }).getByRole('link')
          const ledger = page.locator('dl[aria-label="站点统计摘要"]')
          await expect(workbench).toBeVisible()
          await expect(taskLinks).toHaveCount(4)
          await expect(page.getByRole('link', { name: /待审评论/ })).toBeVisible()
          await expect(page.getByRole('link', { name: /待处理工单/ })).toBeVisible()
          await expect(page.getByRole('link', { name: /缓存异常/ })).toBeVisible()
          await expect(page.getByRole('link', { name: /写新文章/ })).toBeVisible()
          await expect(ledger).toBeVisible()
          await expect(page.locator('.dashboard-stat-card')).toHaveCount(0)
          await expect(page.locator('.dashboard-stat-ledger .el-icon')).toHaveCount(0)

          const expectedTaskValues = workload === 'high'
            ? ['1384', '92', '3', '开始']
            : ['0', '0', '0', '开始']
          await expect(page.locator('.dashboard-task-row__value')).toHaveText(expectedTaskValues)

          if (workload === 'zero') {
            await expect(page.getByText('站点尚未产生内容或互动；先写新文章，发布后摘要会自动更新。')).toBeVisible()
            await expect(page.getByText('暂无数据')).toHaveCount(0)
          } else {
            await expect(page.locator('.dashboard-stat-ledger dd')).toHaveText([
              '12000',
              '84291',
              '71'
            ])
          }

          await assertNoHorizontalOverflow(page, 4)
          await expectStableScreenshot(
            page,
            workbench,
            `admin-dashboard-${workload}-${viewport.name}-${theme}.png`,
            { maxDiffPixelRatio: 0.02 }
          )

          const helpTrigger = page.locator('.dashboard-help-menu__trigger')
          await assertElementHitTarget(page, helpTrigger, 'dashboard help disclosure')
          await helpTrigger.click()
          await expect(page.getByRole('navigation', { name: '帮助与反馈入口' })).toBeVisible()
          await expect(page.getByRole('link', { name: '提交问题' })).toBeVisible()
        })
      })
    }
  }
}
