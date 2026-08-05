import { expect, test } from '@playwright/test'
import type { StorageState } from '@playwright/test'

const routePath = '/user/manage/article/list?page=1&size=10&status=2'
const labels = ['全部', '草稿', '定时', '已发布', '归档']
const longLabel = '已发布并完成公开索引与跨区域缓存同步的文章'

test.describe('admin article direct FsusUI segmented consumer (#1888)', () => {
  let adminStorageState: StorageState
  let shared: typeof import('../../support/playwright/acceptance-shared')

  test.beforeAll(async ({ browser }) => {
    shared = await import('../../support/playwright/acceptance-shared')
    adminStorageState = await shared.captureStorageState(
      browser,
      shared.adminName,
      shared.adminPassword,
      routePath
    )
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`${theme} 375px at 200% zoom keeps keyboard, long-label and selection semantics`, async ({ browser }) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme, adminStorageState)
      try {
        const session = await auditedContext.newPage()
        try {
          const { page } = session
          await page.setViewportSize({ width: 375, height: 812 })
          await page.goto(routePath, { waitUntil: 'domcontentloaded' })
          await shared.waitForAppReady(page)
          await shared.setThemeMode(page, theme)
          await page.evaluate(() => {
            document.documentElement.style.zoom = '2'
          })
          await shared.settlePage(page)

          const group = page.locator('.article-list-status-filter [role="radiogroup"]')
          const radios = group.locator('[role="radio"]')
          await expect(group).toHaveAttribute('aria-label', '文章状态筛选')
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

          await radios.filter({ hasText: '归档' }).evaluate((element, text) => {
            element.textContent = text
          }, longLabel)
          const geometry = await page.evaluate(() => {
            const root = document.querySelector('.article-list-status-filter [role="radiogroup"]')
            const item = [...document.querySelectorAll('.article-list-status-filter [role="radio"]')].at(-1)
            if (!(root instanceof HTMLElement) || !(item instanceof HTMLElement)) return null
            const rootRect = root.getBoundingClientRect()
            const itemRect = item.getBoundingClientRect()
            return {
              documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              itemInsideRoot: itemRect.left >= rootRect.left - 1 && itemRect.right <= rootRect.right + 1
            }
          })
          expect(geometry).toEqual({ documentOverflow: 0, itemInsideRoot: true })
          await session.audit.assertClean(`${theme}-375px-200pct-admin-article-segmented`)
        } finally {
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })
  }

  test('busy query disables every public item and restores it after the request', async ({ browser }) => {
    const auditedContext = await shared.openThemedAuditedContext(browser, 'light', adminStorageState)
    try {
      const session = await auditedContext.newPage()
      try {
        const { page } = session
        await page.goto(routePath, { waitUntil: 'domcontentloaded' })
        await shared.waitForAppReady(page)

        let markRequestHeld = (): void => undefined
        const requestHeld = new Promise<void>((resolve) => {
          markRequestHeld = resolve
        })
        let releaseRequest = (): void => undefined
        await page.route('**/api/binary/admin/article?**', async (route) => {
          markRequestHeld()
          await new Promise<void>((resolve) => {
            releaseRequest = resolve
          })
          await route.continue()
        })

        const radios = page.locator('.article-list-status-filter [role="radio"]')
        await radios.filter({ hasText: '草稿' }).click()
        await requestHeld
        await expect(radios).toHaveCount(labels.length)
        for (let index = 0; index < labels.length; index += 1) {
          await expect(radios.nth(index)).toBeDisabled()
        }

        releaseRequest()
        await expect(radios.first()).toBeEnabled()
        await session.audit.assertClean('busy-admin-article-segmented')
      } finally {
        await session.close()
      }
    } finally {
      await auditedContext.close()
    }
  })
})
