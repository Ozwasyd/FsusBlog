import { expect, test } from '@playwright/test'
import type { Page, TestInfo } from '@playwright/test'

import type { StorageState } from '../../support/playwright/acceptance-shared'

const routePath = '/user/profile'
const themes = ['light', 'dark'] as const
let userStorageState: StorageState
let shared: typeof import('../../support/playwright/acceptance-shared')

const attachEvidence = async (page: Page, testInfo: TestInfo, filename: string) => {
  const screenshotPath = testInfo.outputPath(filename)
  await page.screenshot({ path: screenshotPath, animations: 'disabled', fullPage: false })
  await testInfo.attach(filename, { path: screenshotPath, contentType: 'image/png' })
}

const openAuthenticatedShell = async (
  page: Page,
  theme: (typeof themes)[number],
  options: { forcedColors?: boolean; zoom?: number; viewport: { width: number; height: number } }
) => {
  await page.setViewportSize(options.viewport)
  if (options.forcedColors) {
    await page.emulateMedia({ forcedColors: 'active' })
  }
  await page.goto(routePath, { waitUntil: 'domcontentloaded' })
  await shared.waitForAppReady(page)
  await expect(page, `${theme} mobile shell must not remain on login`).not.toHaveURL(/\/login(?:\?|$)/u)
  await shared.setThemeMode(page, theme)
  if (options.zoom && options.zoom !== 1) {
    await page.evaluate((zoom) => {
      document.documentElement.style.zoom = String(zoom)
    }, options.zoom)
  }
  await shared.settlePage(page)
}

test.beforeAll(async ({ browser }) => {
  shared = await import('../../support/playwright/acceptance-shared')
  userStorageState = await shared.captureStorageState(
    browser,
    shared.userName,
    shared.userPassword,
    routePath
  )
})

for (const theme of themes) {
  test.describe(`account mobile drawer FsusUI trigger (#1898, ${theme})`, () => {
    test.describe.configure({ timeout: 360_000 })

    test('375px portrait keyboard open/close keeps FsusUI trigger contract', async ({
      browser
    }, testInfo) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme, userStorageState)
      try {
        const session = await auditedContext.newPage()
        try {
          const { page } = session
          await openAuthenticatedShell(page, theme, {
            viewport: { width: 375, height: 812 }
          })

          const trigger = page.locator('button.account-mobile-drawer-trigger:visible')
          await expect(trigger, `${theme} visible mobile trigger`).toHaveCount(1)
          await expect(trigger).toHaveAttribute('aria-controls', 'account-mobile-drawer')
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')
          await expect(trigger.locator('button'), `${theme} nested button`).toHaveCount(0)
          await expect(trigger).toHaveClass(/el-button/)
          const box = await trigger.boundingBox()
          expect(box, `${theme} trigger box`).not.toBeNull()
          expect(box!.width, `${theme} trigger width`).toBeGreaterThanOrEqual(44)
          expect(box!.height, `${theme} trigger height`).toBeGreaterThanOrEqual(44)

          await trigger.focus()
          await page.keyboard.press('Enter')
          await expect(trigger).toHaveAttribute('aria-expanded', 'true')
          const drawer = page.locator('#account-mobile-drawer:visible, .el-drawer:visible')
          await expect(drawer.first()).toBeVisible()

          await page.keyboard.press('Escape')
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')
          await expect(drawer).toHaveCount(0)
          await expect(trigger).toBeFocused()

          await attachEvidence(
            page,
            testInfo,
            `issue-1898-account-mobile-drawer-${theme}-375-portrait.png`
          )
        } finally {
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })

    test('375px landscape + 200% zoom + forced-colors keeps operable trigger', async ({
      browser
    }, testInfo) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme, userStorageState)
      try {
        const session = await auditedContext.newPage()
        try {
          const { page } = session
          await openAuthenticatedShell(page, theme, {
            viewport: { width: 812, height: 375 },
            forcedColors: true,
            zoom: 2
          })

          const trigger = page.locator('button.account-mobile-drawer-trigger:visible')
          await expect(trigger, `${theme} landscape zoom trigger`).toHaveCount(1)
          await expect(trigger).toHaveAttribute('aria-controls', 'account-mobile-drawer')
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')

          const box = await trigger.boundingBox()
          expect(box, `${theme} landscape trigger box`).not.toBeNull()
          // 200% zoom reports layout sizes in CSS pixels; still enforce 44px touch floor.
          expect(box!.width, `${theme} landscape trigger width`).toBeGreaterThanOrEqual(44)
          expect(box!.height, `${theme} landscape trigger height`).toBeGreaterThanOrEqual(44)

          await trigger.focus()
          await page.keyboard.press('Space')
          await expect(trigger).toHaveAttribute('aria-expanded', 'true')
          await expect(page.locator('#account-mobile-drawer:visible, .el-drawer:visible').first()).toBeVisible()

          await page.keyboard.press('Escape')
          await expect(trigger).toHaveAttribute('aria-expanded', 'false')
          await expect(trigger).toBeFocused()
          await shared.assertNoHorizontalOverflow(page, 8)

          await attachEvidence(
            page,
            testInfo,
            `issue-1898-account-mobile-drawer-${theme}-375-landscape-zoom-200-forced-colors.png`
          )
        } finally {
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })

    test('route change closes the drawer and keeps trigger state synchronized', async ({
      browser
    }) => {
      const auditedContext = await shared.openThemedAuditedContext(browser, theme, userStorageState)
      try {
        const session = await auditedContext.newPage()
        try {
          const { page } = session
          await openAuthenticatedShell(page, theme, {
            viewport: { width: 375, height: 812 }
          })

          const trigger = page.locator('button.account-mobile-drawer-trigger:visible')
          await trigger.click()
          await expect(trigger).toHaveAttribute('aria-expanded', 'true')

          await page.goto('/user/identity', { waitUntil: 'domcontentloaded' })
          await shared.waitForAppReady(page)
          await shared.settlePage(page)
          await expect(page).not.toHaveURL(/\/login(?:\?|$)/u)

          const nextTrigger = page.locator('button.account-mobile-drawer-trigger:visible')
          await expect(nextTrigger).toHaveCount(1)
          await expect(nextTrigger).toHaveAttribute('aria-expanded', 'false')
          await expect(page.locator('#account-mobile-drawer:visible, .el-drawer:visible')).toHaveCount(0)
        } finally {
          await session.close()
        }
      } finally {
        await auditedContext.close()
      }
    })
  })
}
