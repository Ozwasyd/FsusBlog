import { test, expect } from '@playwright/test'
import {
  UX_VIEWPORT_MATRIX,
  type ThemeMode,
  adminName,
  adminPassword,
  assertElementHitTarget,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertTableLayout,
  assertThemeReadable,
  captureStorageState,
  expectStableScreenshot,
  openThemedAuditedPage,
  settlePage,
  userName,
  userPassword,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

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

for (const viewport of viewports) {
  for (const theme of themes) {
    test.describe(`console visual (${viewport.name}, ${theme})`, () => {
      test.use({ viewport: viewport.size })
      test.describe.configure({ timeout: 360_000 })

      test('user profile and inbox stay aligned', async ({ browser }) => {
        userStorageStatePromise ??= captureStorageState(browser, userName, userPassword, '/user/profile')
        const storageState = await userStorageStatePromise

        for (const route of [
          {
            path: '/user/identity',
            label: 'user-profile',
            primary: 'main',
            screenshot: '.identity-center'
          },
          {
            path: '/user/messagebox',
            label: 'user-messagebox',
            primary: 'main',
            screenshot: '.messages-list-pane .messages-pane-header'
          }
        ] as const) {
          const session = await openThemedAuditedPage(browser, theme, storageState)

          try {
            await session.page.goto(route.path, { waitUntil: 'domcontentloaded' })
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

            if (viewport.screenshot) {
              const screenshotTarget = session.page.locator(route.screenshot).first()
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

        for (const route of [
          { path: '/user/manage', label: 'manage-dashboard', primary: 'main', screenshot: 'header.account-page-header' },
          { path: '/user/manage/article/write', label: 'manage-write', primary: 'main', screenshot: '.write-editor-panel' },
          { path: '/user/manage/settings', label: 'manage-settings', primary: 'main', screenshot: 'header.account-page-header' },
          {
            path: '/user/manage/users',
            label: 'manage-users',
            primary: 'main',
            screenshot: 'header.account-page-header'
          }
        ] as const) {
          const session = await openThemedAuditedPage(browser, theme, storageState)

          try {
            await session.page.goto(route.path, { waitUntil: 'domcontentloaded' })
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
              const titleInput = session.page.getByPlaceholder('在此键入博文标题...')
              await assertElementHitTarget(session.page, titleInput, 'article title input')
            }

            if (viewport.screenshot) {
              const screenshotTarget = session.page.locator(route.screenshot ?? route.primary).first()
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
