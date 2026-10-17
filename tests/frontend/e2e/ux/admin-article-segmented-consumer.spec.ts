import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'

import type { StorageState } from '../../support/playwright/acceptance-shared'

const routePath = '/user/manage/article/list?page=1&size=10&status=2'
const labels = ['全部', '草稿', '定时', '已发布', '归档']
const longLabel = '已发布与索引完成'
const themes = [
  {
    group: 'admin article direct FsusUI segmented consumer (#1888, light)',
    mode: 'light',
    stateEvidence: 'issue-1888-admin-article-segmented-light-375-100-states.png',
    scrollEvidence: 'issue-1888-admin-article-segmented-light-375-200-long-scroll.png'
  },
  {
    group: 'admin article direct FsusUI segmented consumer (#1888, dark)',
    mode: 'dark',
    stateEvidence: 'issue-1888-admin-article-segmented-dark-375-100-states.png',
    scrollEvidence: 'issue-1888-admin-article-segmented-dark-375-200-long-scroll.png'
  }
] as const

let adminStorageState: StorageState
let shared: typeof import('../../support/playwright/acceptance-shared')

const attachEvidence = async (page: Page, testInfo: TestInfo, filename: string) => {
  const screenshotPath = testInfo.outputPath(filename)
  await page.screenshot({ path: screenshotPath, animations: 'disabled', fullPage: false })
  await testInfo.attach(filename, { path: screenshotPath, contentType: 'image/png' })
}

test.beforeAll(async ({ browser }) => {
  shared = await import('../../support/playwright/acceptance-shared')
  adminStorageState = await shared.captureStorageState(
    browser,
    shared.adminName,
    shared.adminPassword,
    routePath
  )
})

for (const theme of themes) {
  test.describe(theme.group, () => {
    test('375px at 100% preserves selected, disabled and focus states', async ({ browser }, testInfo) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme.mode, adminStorageState)
      try {
        const session = await auditedContext.newPage()
        let releaseRequest = (): void => undefined
        try {
          const { page } = session
          await page.setViewportSize({ width: 375, height: 812 })
          await page.goto(routePath, { waitUntil: 'domcontentloaded' })
          await shared.waitForAppReady(page)
          await shared.setThemeMode(page, theme.mode)
          await shared.settlePage(page)

          const group = page.locator('.article-list-status-filter [role="radiogroup"]')
          const radios = group.locator('[role="radio"]')
          const published = radios.filter({ hasText: '已发布' })
          await expect(group).toHaveAttribute('aria-label', '文章状态筛选')
          await expect(radios).toHaveCount(labels.length)
          await expect(radios).toHaveText(labels)
          await expect(published).toHaveAttribute('aria-checked', 'true')

          await page.keyboard.press('Tab')
          await published.focus()
          await expect(published).toBeFocused()
          await expect.poll(() => published.evaluate((node) => node.matches(':focus-visible'))).toBe(true)
          const focusShadow = await published.evaluate((node) => getComputedStyle(node).boxShadow)
          expect(focusShadow).toContain('inset')

          let markRequestHeld = (): void => undefined
          const requestHeld = new Promise<void>((resolve) => {
            markRequestHeld = resolve
          })
          await page.route('**/api/binary/admin/article?**', async (route) => {
            markRequestHeld()
            await new Promise<void>((resolve) => {
              releaseRequest = resolve
            })
            await route.continue()
          })

          await radios.filter({ hasText: '草稿' }).click()
          await requestHeld
          await expect(radios.filter({ hasText: '草稿' })).toHaveAttribute('aria-checked', 'true')
          for (let index = 0; index < labels.length; index += 1) {
            await expect(radios.nth(index)).toBeDisabled()
          }
          await attachEvidence(page, testInfo, theme.stateEvidence)

          releaseRequest()
          await expect(radios.first()).toBeEnabled()
        } finally {
          releaseRequest()
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })

    test('375px at 200% preserves URL, keyboard and horizontal-scroll reachability', async ({
      browser
    }, testInfo) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme.mode, adminStorageState)
      try {
        const session = await auditedContext.newPage()
        try {
          const { page } = session
          await page.setViewportSize({ width: 375, height: 812 })
          await page.goto(routePath, { waitUntil: 'domcontentloaded' })
          await shared.waitForAppReady(page)
          await shared.setThemeMode(page, theme.mode)
          await page.evaluate(() => {
            document.documentElement.style.zoom = '2'
          })
          await shared.settlePage(page)

          const group = page.locator('.article-list-status-filter [role="radiogroup"]')
          const radios = group.locator('[role="radio"]')
          await expect(radios).toHaveCount(labels.length)
          await expect(radios).toHaveText(labels)
          await expect(radios.filter({ hasText: '已发布' })).toHaveAttribute('aria-checked', 'true')

          await radios.filter({ hasText: '已发布' }).press('Home')
          await expect(page).not.toHaveURL(/[?&]status=/u)
          await expect(radios.filter({ hasText: '全部' })).toHaveAttribute('aria-checked', 'true')

          await radios.filter({ hasText: '全部' }).press('ArrowRight')
          await expect(page).toHaveURL(/[?&]status=0(?:&|$)/u)
          await expect(radios.filter({ hasText: '草稿' })).toHaveAttribute('aria-checked', 'true')

          await radios.filter({ hasText: '草稿' }).press('End')
          await expect(page).toHaveURL(/[?&]status=3(?:&|$)/u)
          await expect(radios.filter({ hasText: '归档' })).toHaveAttribute('aria-checked', 'true')

          const lastItem = radios.last()
          await lastItem.evaluate((element, text) => {
            element.textContent = text
          }, longLabel)
          const beforeScroll = await group.evaluate((root) => {
            const style = getComputedStyle(root)
            return {
              clientWidth: root.clientWidth,
              documentOverflow:
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              overflowX: style.overflowX,
              scrollLeft: root.scrollLeft,
              scrollWidth: root.scrollWidth
            }
          })
          expect(beforeScroll.documentOverflow).toBe(0)
          expect(['auto', 'scroll']).toContain(beforeScroll.overflowX)
          expect(beforeScroll.scrollWidth).toBeGreaterThan(beforeScroll.clientWidth + 1)

          await group.evaluate((root) => {
            root.scrollLeft = root.scrollWidth
          })
          await expect.poll(() => group.evaluate((root) => root.scrollLeft)).toBeGreaterThan(
            beforeScroll.scrollLeft
          )

          const afterScroll = await group.evaluate((root) => {
            const item = root.querySelector<HTMLElement>('[role="radio"]:last-child')
            if (!item) return null
            const rootRect = root.getBoundingClientRect()
            const itemRect = item.getBoundingClientRect()
            // After max horizontal scroll the long label must remain in the
            // group's scrollport (partial visibility is enough when a single
            // option is wider than the 375px / 200% group).
            const itemInScrollport =
              itemRect.left < rootRect.right - 1 && itemRect.right > rootRect.left + 1
            return {
              documentOverflow:
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              itemInScrollport,
              itemNotClipped: item.scrollWidth <= item.clientWidth + 1,
              scrollLeft: root.scrollLeft,
              scrollRange: root.scrollWidth - root.clientWidth
            }
          })
          expect(afterScroll).not.toBeNull()
          expect(afterScroll).toMatchObject({
            documentOverflow: 0,
            itemInScrollport: true,
            itemNotClipped: true
          })
          expect(afterScroll!.scrollLeft).toBeGreaterThanOrEqual(afterScroll!.scrollRange - 1)

          await attachEvidence(page, testInfo, theme.scrollEvidence)
        } finally {
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })
  })
}
