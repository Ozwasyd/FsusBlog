import { expect, test, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

import { resolveSystemChromiumExecutablePath } from '../../support/system-chromium.mjs'

const executablePath = resolveSystemChromiumExecutablePath()
test.use({
  launchOptions: {
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  },
})

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../../fixtures/moderationRegionsDataListVisual.ts', import.meta.url),
).replaceAll('\\', '/')}`

const cases = [
  { id: 'desktop-light', width: 1366, height: 768, theme: 'light' },
  { id: 'desktop-dark', width: 1366, height: 768, theme: 'dark' },
  { id: 'mobile-light', width: 375, height: 812, theme: 'light' },
  { id: 'mobile-dark', width: 375, height: 812, theme: 'dark' },
] as const

const baselineGeometry = {
  rowHeight: 59.5,
  firstInset: 0,
  lastInset: 0,
} as const

async function openFixture(
  page: Page,
  theme: 'light' | 'dark',
  runtimeMessages: string[],
): Promise<void> {
  await page.route(
    /\/__moderation-regions-data-list-fixture(?:\?.*)?$/,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
        <html>
          <head><meta charset="utf-8"><title>Moderation regions DataList fixture</title></head>
          <body>
            <div id="moderation-regions-data-list-fixture"></div>
            <script type="module" src="${fixtureModule}"></script>
          </body>
        </html>`,
      })
    },
  )

  await page.goto(
    `/__moderation-regions-data-list-fixture?theme=${theme}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page
    .waitForFunction(
      () =>
        document.documentElement.dataset
          .moderationRegionsDataListFixtureReady === 'true',
      undefined,
      { timeout: 15_000 },
    )
    .catch((error: unknown) => {
      throw new Error(
        `fixture did not become ready: ${runtimeMessages.join(' | ') || String(error)}`,
      )
    })
}

for (const fixtureCase of cases) {
  test.describe(`moderation regions DataList ${fixtureCase.id}`, () => {
    test.use({
      viewport: { width: fixtureCase.width, height: fixtureCase.height },
    })

    test('keeps row geometry, focus and active state inside the public contract', async ({
      page,
    }, testInfo) => {
      const consoleMessages: string[] = []
      page.on('console', (message) => {
        if (message.type() !== 'error' && message.type() !== 'warning') return
        const text = message.text()
        const isViteHmrInfrastructureError =
          text.includes('ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS') ||
          text.startsWith('[vite] failed to connect to websocket') ||
          text.startsWith('Failed to send error to Vite server')
        if (!isViteHmrInfrastructureError) {
          consoleMessages.push(`${message.type()}: ${text}`)
        }
      })
      page.on('pageerror', (error) => {
        consoleMessages.push(`pageerror: ${error.message}`)
      })

      await openFixture(page, fixtureCase.theme, consoleMessages)
      await expect(page).toHaveTitle('Moderation regions DataList fixture')
      await expect(
        page.getByRole('heading', { name: '地区生效规则' }),
      ).toBeVisible()

      const list = page.getByRole('list', { name: '地区定义列表' })
      const rows = list.getByRole('listitem')
      await expect(rows).toHaveCount(3)

      const geometry = await rows.evaluateAll((elements) =>
        elements.map((element) => {
          const row = element.getBoundingClientRect()
          const rowStyle = getComputedStyle(element)
          const cells = Array.from(
            element.querySelectorAll<HTMLElement>('.el-data-list__cell'),
          )
          const first = cells[0]?.getBoundingClientRect()
          const last = cells.at(-1)?.getBoundingClientRect()
          const lastStyle = cells.at(-1)
            ? getComputedStyle(cells.at(-1)!)
            : null
          return {
            height: row.height,
            width: row.width,
            gridTemplateColumns: rowStyle.gridTemplateColumns,
            columnGap: rowStyle.columnGap,
            firstInset: first ? first.left - row.left : Number.NaN,
            lastInset: last ? row.right - last.right : Number.NaN,
            lastWidth: last?.width ?? Number.NaN,
            lastBoxSizing: lastStyle?.boxSizing ?? '',
            lastPaddingInline: lastStyle
              ? `${lastStyle.paddingLeft} ${lastStyle.paddingRight}`
              : '',
          }
        }),
      )
      expect(
        Math.max(...geometry.map(({ height }) => height)) -
          Math.min(...geometry.map(({ height }) => height)),
        JSON.stringify(geometry),
      ).toBeLessThanOrEqual(1)
      for (const row of geometry) {
        expect(
          Math.abs(row.height - baselineGeometry.rowHeight),
          JSON.stringify(row),
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(row.firstInset - baselineGeometry.firstInset),
          JSON.stringify(row),
        ).toBeLessThanOrEqual(1)
        expect(
          Math.abs(row.lastInset - baselineGeometry.lastInset),
          JSON.stringify(row),
        ).toBeLessThanOrEqual(1)
      }

      const activeRow = rows.nth(1)
      await expect(activeRow).toHaveAttribute('aria-current', 'true')
      expect(await activeRow.evaluate((element) =>
        getComputedStyle(element).boxShadow,
      )).toContain('2px 0px 0px')

      const focusRow = rows.nth(2)
      await focusRow.focus()
      await expect(focusRow).toBeFocused()
      const focusEvidence = await focusRow.evaluate((element) => {
        const row = element.getBoundingClientRect()
        const list = element.parentElement!.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          boxShadow: style.boxShadow,
          outlineWidth: Number.parseFloat(style.outlineWidth),
          clipped:
            row.left < list.left - 1 ||
            row.right > list.right + 1 ||
            row.top < list.top - 1 ||
            row.bottom > list.bottom + 1,
        }
      })
      expect(focusEvidence.boxShadow).toContain('0px 0px 0px 2px')
      expect(focusEvidence.outlineWidth).toBeLessThanOrEqual(2)
      expect(focusEvidence.clipped).toBe(false)

      const indicator = focusRow.locator('[data-region-indicator]')
      await expect(indicator).toHaveCSS('opacity', '1')
      expect(await page.evaluate(() =>
        document.documentElement.scrollWidth - window.innerWidth,
      )).toBeLessThanOrEqual(1)
      expect(consoleMessages).toEqual([])

      await testInfo.attach(`moderation-regions-${fixtureCase.id}`, {
        body: await page.screenshot({ animations: 'disabled' }),
        contentType: 'image/png',
      })
    })
  })
}
