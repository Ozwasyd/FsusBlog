import { expect, test, type Locator, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

type DashboardCase = Readonly<{
  name: string
  width: number
  height: number
  workload: 'zero' | 'one' | 'eight'
  changes: 'none' | 'many'
  system: 'healthy' | 'attention'
  theme: 'light' | 'dark'
  grayscale?: boolean
}>

const adminDashboardFixtureModule = `/@fs/${fileURLToPath(
  new URL('../../fixtures/adminDashboardWorkbenchVisual.ts', import.meta.url)
).replaceAll('\\', '/')}`

const cases: readonly DashboardCase[] = [
  {
    name: 'zero-desktop-light',
    width: 1366,
    height: 768,
    workload: 'zero',
    changes: 'none',
    system: 'healthy',
    theme: 'light'
  },
  {
    name: 'one-wide-dark',
    width: 1440,
    height: 900,
    workload: 'one',
    changes: 'many',
    system: 'attention',
    theme: 'dark'
  },
  {
    name: 'eight-tablet-light',
    width: 768,
    height: 900,
    workload: 'eight',
    changes: 'many',
    system: 'healthy',
    theme: 'light'
  },
  {
    name: 'one-mobile-dark',
    width: 375,
    height: 812,
    workload: 'one',
    changes: 'none',
    system: 'attention',
    theme: 'dark'
  },
  {
    name: 'one-desktop-grayscale',
    width: 1366,
    height: 768,
    workload: 'one',
    changes: 'many',
    system: 'attention',
    theme: 'light',
    grayscale: true
  }
]

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(4)
  expect(overflow.document).toBeLessThanOrEqual(4)
}

async function assertElementHitTarget(locator: Locator, label: string, minimum = 40): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, `${label} should have a bounding box`).not.toBeNull()
  expect(box!.height, `${label} height`).toBeGreaterThanOrEqual(minimum)
}

const isViteHmrTransportNoise = (message: string): boolean => (
  message.includes('WebSocket connection to')
  || message.includes('[vite] failed to connect to websocket')
  || message.includes('Failed to send error to Vite server')
)

async function openDashboardFixture(page: Page, fixtureCase: DashboardCase): Promise<void> {
  await page.route('**/__admin-dashboard-workbench-fixture**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Admin dashboard workbench fixture</title></head>
          <body>
            <div id="admin-dashboard-workbench-fixture"></div>
            <script type="module" src="${adminDashboardFixtureModule}"></script>
          </body>
        </html>`
    })
  })

  await page.goto(
    `/__admin-dashboard-workbench-fixture?workload=${fixtureCase.workload}&changes=${fixtureCase.changes}&system=${fixtureCase.system}&theme=${fixtureCase.theme}`,
    { waitUntil: 'domcontentloaded' }
  )
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.dataset.adminDashboardFixtureReady
  ))).toBe('true')

  if (fixtureCase.grayscale) {
    await page.locator('html').evaluate((element) => {
      element.style.filter = 'grayscale(1)'
    })
  }
}

for (const fixtureCase of cases) {
  test.describe(`admin dashboard ${fixtureCase.name}`, () => {
    test.use({ viewport: { width: fixtureCase.width, height: fixtureCase.height } })

    test('keeps task priority, next actions and flat states measurable', async ({ page }) => {
      const consoleMessages: string[] = []
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning') {
          consoleMessages.push(`${message.type()}: ${message.text()}`)
        }
      })

      await openDashboardFixture(page, fixtureCase)

      await expect(page).toHaveTitle('Admin dashboard workbench fixture')
      const workbench = page.locator('.dashboard-wrapper')
      await expect(workbench).toBeVisible()
      await expect(page.getByRole('heading', { name: '今日待处理' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '最近变更' })).toBeVisible()
      await expect(page.getByRole('heading', { name: '系统状态' })).toBeVisible()
      await expect(page.locator('.dashboard-stat-card')).toHaveCount(0)
      await expect(page.locator('.dashboard-entry-card')).toHaveCount(0)
      await assertNoHorizontalOverflow(page)

      const taskRows = page.locator('.dashboard-task-row')
      const expectedTaskCount = fixtureCase.workload === 'zero'
        ? 0
        : fixtureCase.workload === 'one'
          ? 1
          : 8
      await expect(taskRows).toHaveCount(expectedTaskCount)

      if (fixtureCase.workload === 'zero') {
        const healthyEmpty = page.locator('.dashboard-healthy-empty')
        await expect(healthyEmpty).toContainText('暂无待处理')
        const nextAction = page.getByRole('link', { name: '写新文章' })
        await expect(nextAction).toBeVisible()
        await assertElementHitTarget(nextAction, 'zero-workload next action', fixtureCase.width <= 767 ? 44 : 40)
        const box = await healthyEmpty.boundingBox()
        expect(box).not.toBeNull()
        if (fixtureCase.width === 1366 && fixtureCase.height === 768) {
          expect(box!.y + box!.height).toBeLessThanOrEqual(768)
        }
      } else {
        const firstTask = taskRows.first()
        await expect(firstTask).toBeVisible()
        const firstBox = await firstTask.boundingBox()
        expect(firstBox).not.toBeNull()
        expect(firstBox!.height).toBeGreaterThanOrEqual(52)
        expect(firstBox!.height).toBeLessThanOrEqual(64)

        const cta = firstTask.locator('.dashboard-task-row__cta')
        await assertElementHitTarget(cta, 'primary task action', fixtureCase.width <= 767 ? 44 : 40)
        const ctaBox = await cta.boundingBox()
        expect(ctaBox).not.toBeNull()
        expect(ctaBox!.height).toBeGreaterThanOrEqual(fixtureCase.width <= 767 ? 44 : 40)
        await firstTask.focus()
        await expect(firstTask).toBeFocused()
      }

      if (fixtureCase.changes === 'none') {
        await expect(page.getByText('最近变更中暂无新记录。')).toBeVisible()
      } else {
        await expect(page.locator('.dashboard-change-row')).toHaveCount(4)
      }

      const systemStatus = page.locator('.dashboard-system-status')
      await expect(systemStatus).toContainText(
        fixtureCase.system === 'healthy' ? '系统处于预期状态' : '运行异常需要处理'
      )
      await assertElementHitTarget(
        systemStatus.locator('.dashboard-system-status__action'),
        'system status action',
        fixtureCase.width <= 767 ? 44 : 40
      )

      if (fixtureCase.width >= 768) {
        const sidebarHelpers = page.locator('.account-module-link__helper')
        await expect(sidebarHelpers.first()).toBeVisible()
        expect(await sidebarHelpers.first().evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            color: style.color,
            fontSize: Number.parseFloat(style.fontSize),
            lineHeight: Number.parseFloat(style.lineHeight)
          }
        })).toMatchObject({
          fontSize: 12,
          lineHeight: expect.any(Number)
        })
        const helperLineHeight = await sidebarHelpers.first().evaluate((element) => (
          Number.parseFloat(getComputedStyle(element).lineHeight)
        ))
        expect(helperLineHeight).toBeGreaterThanOrEqual(17)
      }

      const relevantConsoleMessages = consoleMessages.filter((message) => !isViteHmrTransportNoise(message))
      expect(relevantConsoleMessages, 'fixture should not emit relevant console errors or warnings').toEqual([])
      await expect(page.locator('.admin-dashboard-fixture-shell')).toHaveScreenshot(
        `admin-dashboard-${fixtureCase.name}.png`,
        {
          animations: 'disabled',
          caret: 'hide',
          maxDiffPixelRatio: 0.02
        }
      )

      const helpTrigger = page.locator('.dashboard-help-menu__trigger')
      await assertElementHitTarget(helpTrigger, 'dashboard help disclosure')
      await helpTrigger.click()
      await expect(page.getByRole('navigation', { name: '帮助与反馈入口' })).toBeVisible()
      await expect(page.getByRole('link', { name: '提交问题' })).toBeVisible()
    })
  })
}
