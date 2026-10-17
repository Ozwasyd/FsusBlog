import { expect, test, type ConsoleMessage, type Page, type Route, type TestInfo } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const fixtureModule = `/@fs/${fileURLToPath(
  new URL('../fixtures/commentModerationAdvancedFiltersVisual.ts', import.meta.url),
).replaceAll('\\', '/')}`
const contents = [
  { id: 'short-article', key: 'article', input: '按文章筛选评论', prefix: '文章：', value: '42' },
  { id: 'long-cjk-article', key: 'article', input: '按文章筛选评论', prefix: '文章：', value: '文章'.repeat(30) },
  { id: 'long-unbroken-user', key: 'user', input: '按用户筛选评论', prefix: '用户：', value: 'Account'.repeat(30) },
] as const

for (const width of [375, 768, 1366, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test.describe(`advanced filters ${width}px ${theme}`, () => {
      test.use({ viewport: { width, height: 900 }, colorScheme: theme })

      for (const content of contents) {
        test(`${content.id} keeps its complete label readable and actionable`, async ({ page }: { page: Page }, testInfo: TestInfo) => {
          const runtimeMessages: string[] = []
          page.on('console', (message: ConsoleMessage) => {
            if (message.type() === 'error' || message.type() === 'warning') runtimeMessages.push(message.text())
          })
          page.on('pageerror', (error: Error) => runtimeMessages.push(error.message))
          await page.route('**/__advanced-filters-fixture', (route: Route) => route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Advanced filters fixture</title></head><body><div id="advanced-filters-fixture"></div><script type="module" src="${fixtureModule}"></script></body></html>`,
          }))
          await page.goto('/__advanced-filters-fixture')
          await expect(page).toHaveTitle('Advanced filters fixture')
          await page.evaluate((dark: boolean) => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
          const trigger = page.locator('.comment-advanced-trigger')
          await trigger.click()
          await expect(page.locator('#comment-advanced-filter-panel')).toBeFocused()
          await page.getByRole('textbox', { name: content.input, exact: true }).fill(content.value)
          const text = `移除 ${content.prefix}${content.value}`
          const action = page.getByRole('button', { name: text, exact: true })
          await expect(action).toHaveText(text)
          const geometry = await action.evaluate((button: HTMLButtonElement) => {
            const bounds = button.getBoundingClientRect()
            const container = button.parentElement!.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(button)
            return {
              width: bounds.width,
              containerWidth: container.width,
              horizontalOverflow: button.scrollWidth - button.clientWidth,
              verticalOverflow: button.scrollHeight - button.clientHeight,
              lines: new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size,
              textContained: [...range.getClientRects()].every(rect =>
                rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
                && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
            }
          })
          expect(geometry.width, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.containerWidth + 1)
          expect(geometry.horizontalOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1)
          expect(geometry.verticalOverflow, JSON.stringify(geometry)).toBeLessThanOrEqual(1)
          expect(geometry.textContained, JSON.stringify(geometry)).toBe(true)
          if (content.id !== 'short-article') expect(geometry.lines).toBeGreaterThan(1)
          await writeFile(testInfo.outputPath('label-geometry.json'), JSON.stringify(geometry, null, 2))
          const screenshotPath = testInfo.outputPath('complete-label.png')
          await page.screenshot({ path: screenshotPath })
          await testInfo.attach('complete-label', { path: screenshotPath, contentType: 'image/png' })
          await action.focus()
          await expect(action).toBeFocused()
          await page.keyboard.press('Enter')
          await expect(action).toHaveCount(0)
          await expect(page.getByRole('status', { name: 'Removed filters' })).toHaveText(content.key)
          await page.keyboard.press('Escape')
          await expect(trigger).toBeFocused()
          expect(runtimeMessages).toEqual([])
        })
      }
    })
  }
}
