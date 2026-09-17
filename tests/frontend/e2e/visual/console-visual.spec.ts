import { test, expect, type Page } from '@playwright/test'
import {
  UX_VIEWPORT_MATRIX,
  type ThemeMode,
  adminName,
  adminPassword,
  applyUxViewportMediaMode,
  assertElementHitTarget,
  assertElementInViewport,
  assertFocusOutlineVisible,
  assertNoHorizontalOverflow,
  assertTableLayout,
  assertThemeReadable,
  assertTouchTargetSize,
  assertUxViewportMediaMode,
  captureStorageState,
  expectStableScreenshot,
  openThemedAuditedPage,
  resetUxViewportMediaMode,
  settlePage,
  userName,
  userPassword,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'
import {
  ADMIN_LAYOUT_ARCHETYPES,
  IDENTITY_LAYOUT_ARCHETYPES,
  resolveLayoutArchetypePath
} from '../../support/playwright/layoutArchetypeMatrix'

const viewports = UX_VIEWPORT_MATRIX.viewports
  .filter((viewport) => viewport.useInConsoleVisual)
  .map((viewport) => ({
    name: viewport.name,
    size: { width: viewport.width, height: viewport.height },
    screenshot: viewport.name === 'desktop' || viewport.name === 'mobile'
  }))

const themes: ThemeMode[] = ['light', 'dark']

let userStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null
let adminStorageStatePromise: Promise<Awaited<ReturnType<typeof captureStorageState>>> | null = null

async function assertArchetypeAccessibility(page: Page, label: string): Promise<void> {
  await assertFocusOutlineVisible(page, label)
  await assertTouchTargetSize(page, label)
  for (const media of ['reduced-motion', 'high-contrast'] as const) {
    await resetUxViewportMediaMode(page)
    await applyUxViewportMediaMode(page, media)
    await assertUxViewportMediaMode(page, media, `${label} ${media}`)
    await assertNoHorizontalOverflow(page, 8)
  }
  await resetUxViewportMediaMode(page)
}

async function assertAccountHeaderMenuContract(page: Page, label: string): Promise<void> {
  const trigger = page.locator('button.account-header-menu__trigger:visible')
  const accountLabel = trigger.locator('span:not(:has(span))').filter({ hasText: /^账号$/u })
  const visibleMenu = page.locator('[role="menu"]:visible').filter({ hasText: '使用规范' })
  await expect(trigger, `${label} visible account-menu trigger`).toHaveCount(1)
  await expect(trigger).toHaveAccessibleName('打开账号菜单')
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await expect(trigger.locator('button'), `${label} nested clickable button`).toHaveCount(0)
  await expect(accountLabel, `${label} account label`).toHaveCount(1)
  await expect(visibleMenu, `${label} collapsed menu`).toHaveCount(0)

  const compact = (page.viewportSize()?.width ?? 0) < 1024
  if (compact) {
    await expect(accountLabel, `${label} compact account label`).toHaveClass(/(?:^|\s)sr-only(?:\s|$)/u)
  } else {
    await expect(accountLabel, `${label} noncompact account label`).not.toHaveClass(
      /(?:^|\s)sr-only(?:\s|$)/u
    )
    await expect(accountLabel, `${label} visible noncompact account label`).toBeVisible()
  }

  const triggerBox = await trigger.boundingBox()
  const minimumTarget = compact ? 44 : 40
  expect(triggerBox, `${label} account-menu trigger box`).not.toBeNull()
  expect(triggerBox!.width, `${label} account-menu trigger width`).toBeGreaterThanOrEqual(minimumTarget)
  expect(triggerBox!.height, `${label} account-menu trigger height`).toBeGreaterThanOrEqual(minimumTarget)

  for (const key of ['Enter', 'Space']) {
    await trigger.focus()
    await trigger.press(key)
    await expect(trigger, `${label} ${key} expanded state`).toHaveAttribute('aria-expanded', 'true')
    await expect(visibleMenu, `${label} ${key} menu visibility`).toHaveCount(1)
    await expect(visibleMenu).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(trigger, `${label} ${key} collapsed state`).toHaveAttribute('aria-expanded', 'false')
    await expect(visibleMenu, `${label} ${key} collapsed menu`).toHaveCount(0)
    await expect(trigger, `${label} ${key} focus return`).toBeFocused()
  }
}

for (const viewport of viewports) {
  for (const theme of themes) {
    test.describe(`console visual (${viewport.name}, ${theme})`, () => {
      test.describe.configure({ timeout: 360_000 })
      test.use({ viewport: viewport.size })

      test('user profile and inbox stay aligned', async ({ browser }) => {
        userStorageStatePromise ??= captureStorageState(browser, userName, userPassword, '/user/profile')
        const storageState = await userStorageStatePromise

        for (const route of IDENTITY_LAYOUT_ARCHETYPES) {
          const session = await openThemedAuditedPage(browser, theme, storageState)

          try {
            await session.page.goto(resolveLayoutArchetypePath(route), { waitUntil: 'domcontentloaded' })
            await waitForAppReady(session.page)
            await settlePage(session.page)

            const primary = session.page.locator(route.primary).first()
            await expect(primary).toBeVisible()
            await assertThemeReadable(session.page, theme)
            await assertNoHorizontalOverflow(session.page, viewport.name === 'desktop' ? 4 : 8)
            await assertElementInViewport(session.page, primary, `${route.label} main`)

            const revokeOthers = session.page.getByRole('button', { name: '下线其他设备' })
            if (await revokeOthers.count()) {
              await assertElementHitTarget(session.page, revokeOthers, 'revoke other sessions button')
            }

            await assertArchetypeAccessibility(session.page, `${route.label} ${viewport.name} ${theme}`)
            if (route.label === 'user-profile') {
              await assertAccountHeaderMenuContract(
                session.page,
                `${route.label} ${viewport.name} ${theme}`
              )
            }

            if (viewport.screenshot && route.snapshot) {
              const screenshotTarget = session.page.locator(route.screenshotTarget).first()
              await expectStableScreenshot(
                session.page,
                screenshotTarget,
                `${route.label}-${viewport.name}-${theme}.png`,
                { maxDiffPixelRatio: 0.03 }
              )
            }
          } finally {
            await session.close()
          }
        }
      })

      test('admin workbench pages stay visually stable', async ({ browser }) => {
        adminStorageStatePromise ??= captureStorageState(browser, adminName, adminPassword, '/user/manage')
        const storageState = await adminStorageStatePromise

        for (const route of ADMIN_LAYOUT_ARCHETYPES) {
          const session = await openThemedAuditedPage(browser, theme, storageState)

          try {
            await session.page.goto(resolveLayoutArchetypePath(route), { waitUntil: 'domcontentloaded' })
            await waitForAppReady(session.page)
            await settlePage(session.page)

            const primary = session.page.locator(route.primary).first()
            await expect(primary).toBeVisible()
            await assertThemeReadable(session.page, theme)
            await assertNoHorizontalOverflow(session.page, viewport.name === 'desktop' ? 4 : 8)
            await assertElementInViewport(session.page, primary, `${route.label} main`)

            if (route.label === 'manage-users') {
              const userTable = session.page.locator('.user-table').first()
              if (await userTable.isVisible().catch(() => false)) {
                await assertTableLayout(
                  session.page,
                  userTable,
                  session.page.locator('.el-pagination').first()
                )
              } else {
                const mobileCard = session.page.locator('.user-mobile-card, .user-resource-list-item').first()
                if (await mobileCard.isVisible().catch(() => false)) {
                  await assertElementInViewport(session.page, mobileCard, 'mobile user card')
                } else {
                  const accountSearch = session.page.getByLabel('搜索账号标识')
                    .or(session.page.getByPlaceholder('搜账号 ID / public handle...'))
                    .or(session.page.getByPlaceholder('搜用户名...'))
                    .first()
                  await expect(accountSearch).toBeVisible()
                  await assertElementHitTarget(
                    session.page,
                    session.page.getByRole('button', { name: '查询' }),
                    'mobile user search button'
                  )
                }
              }
            }

            if (route.label === 'manage-write') {
              const titleInput = session.page.getByPlaceholder('写下文章标题')
              await assertElementHitTarget(session.page, titleInput, 'article title input')
            }

            if (route.label === 'manage-dashboard') {
              await expect(session.page.getByRole('list', { name: '今日待处理任务' })).toBeVisible()
              await expect(session.page.getByRole('link', { name: /待审评论/ })).toBeVisible()
              await expect(session.page.getByRole('link', { name: /待处理工单/ })).toBeVisible()
              await expect(session.page.getByRole('link', { name: /缓存异常/ })).toBeVisible()
              await expect(session.page.getByRole('link', { name: /写新文章/ })).toBeVisible()
              await expect(session.page.locator('dl[aria-label="站点统计摘要"]')).toBeVisible()
              await expect(session.page.locator('.dashboard-stat-card')).toHaveCount(0)
              await expect(session.page.locator('.dashboard-stat-ledger .el-icon')).toHaveCount(0)
            }

            await assertArchetypeAccessibility(session.page, `${route.label} ${viewport.name} ${theme}`)

            if (viewport.screenshot && route.snapshot) {
              const screenshotTarget = session.page.locator(route.screenshotTarget).first()
              await expectStableScreenshot(
                session.page,
                screenshotTarget,
                `${route.label}-${viewport.name}-${theme}.png`,
                { maxDiffPixelRatio: 0.03 }
              )
            }
          } finally {
            await session.close()
          }
        }
      })
    })
  }
}

for (const theme of themes) {
  test.describe(`account menu contract (375px, 200% zoom, ${theme})`, () => {
    test.use({ viewport: { width: 375, height: 812 } })
    test.describe.configure({ timeout: 360_000 })

    test('keeps the FsusUI trigger operable in forced colors with keyboard input', async ({
      browser
    }, testInfo) => {
      userStorageStatePromise ??= captureStorageState(browser, userName, userPassword, '/user/profile')
      const session = await openThemedAuditedPage(browser, theme, await userStorageStatePromise)

      try {
        await session.page.emulateMedia({ forcedColors: 'active' })
        await session.page.goto('/user/profile', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        // Auth-fixture races must fail loudly instead of asserting a missing menu.
        // Desktop + compact shells both mount the menu; only the visible one is in contract.
        await expect(
          session.page,
          `375px 200% ${theme} forced-colors must land on authenticated profile`
        ).not.toHaveURL(/\/login(?:\?|$)/u)
        await expect(
          session.page.locator('button.account-header-menu__trigger:visible'),
          `375px 200% ${theme} forced-colors visible account-menu trigger`
        ).toHaveCount(1, { timeout: 30_000 })
        await session.page.evaluate(() => {
          document.documentElement.style.zoom = '2'
        })
        await settlePage(session.page)
        await assertAccountHeaderMenuContract(session.page, `375px 200% ${theme} forced-colors`)
        await assertNoHorizontalOverflow(session.page, 8)
        await session.page.screenshot({
          path: testInfo.outputPath(`account-menu-375-zoom-200-${theme}.png`),
          fullPage: false
        })
      } finally {
        await session.close()
      }
    })
  })
}

for (const theme of themes) {
  test.describe(`dashboard 768px first fold (${theme})`, () => {
    test.use({ viewport: { width: 1366, height: 768 } })
    test.describe.configure({ timeout: 360_000 })

    test('shows every task, the summary and the migrated help action', async ({ browser }) => {
      adminStorageStatePromise ??= captureStorageState(browser, adminName, adminPassword, '/user/manage')
      const session = await openThemedAuditedPage(browser, theme, await adminStorageStatePromise)

      try {
        await session.page.goto('/user/manage', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        const workbench = session.page.locator('.dashboard-wrapper')
        const taskList = session.page.getByRole('list', { name: '今日待处理任务' })
        const summary = session.page.locator('.dashboard-summary')
        const desktopSidebar = session.page.locator('aside .account-sidebar-frame')
        await expect(workbench).toBeVisible()
        await expect(desktopSidebar.getByRole('navigation', { name: '管理一级模块' }).getByRole('link')).toHaveCount(6)
        expect(await desktopSidebar.evaluate((element) => getComputedStyle(element).overflowY))
          .not.toMatch(/auto|scroll/)
        await expect(taskList.getByRole('link')).toHaveCount(4)
        await expect(taskList).toBeVisible()
        await expect(summary).toBeVisible()
        const taskBox = await taskList.boundingBox()
        const summaryBox = await summary.boundingBox()
        expect(taskBox, 'dashboard task list should have a 768px-fold bounding box').not.toBeNull()
        expect(summaryBox, 'dashboard summary should have a 768px-fold bounding box').not.toBeNull()
        expect(taskBox!.y, 'dashboard task list should start inside the first fold').toBeGreaterThanOrEqual(0)
        expect(
          summaryBox!.y + summaryBox!.height,
          'dashboard summary should end inside the 768px first fold'
        ).toBeLessThanOrEqual(770)

        const helpTrigger = session.page.locator('.dashboard-help-menu__trigger')
        if (await helpTrigger.count()) {
          await assertElementHitTarget(session.page, helpTrigger, 'dashboard help and feedback trigger')
          await helpTrigger.click()
          await expect(session.page.getByRole('navigation', { name: '帮助与反馈入口' })).toBeVisible()
        }

        await assertThemeReadable(session.page, theme)
        await assertNoHorizontalOverflow(session.page, 4)
      } finally {
        await session.close()
      }
    })
  })
}
