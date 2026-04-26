import { test, expect } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  captureStorageState,
  userName,
  userPassword,
  openAuditedPage,
  assertElementHitTarget,
  assertElementInViewport,
  assertNoHorizontalOverflow,
  assertResponsiveLayoutContract,
  assertSectionsDoNotOverlap,
  assertToastInViewport,
  expectRouteAndShell,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

for (const viewport of [
  { name: 'desktop', size: DESKTOP_VIEWPORT },
  { name: 'mobile', size: MOBILE_VIEWPORT }
]) {
  test.describe(`user console acceptance (${viewport.name})`, () => {
    test.use({ viewport: viewport.size })
    test.describe.configure({ timeout: 300_000 })

    let storageState: Awaited<ReturnType<typeof captureStorageState>>

    test.beforeAll(async ({ browser }) => {
      storageState = await captureStorageState(browser, userName, userPassword, '/user/profile')
    })

    test('visible user routes load without runtime noise', async ({ browser }) => {
      const expectations = [
        {
          path: '/user/profile',
          expectedUrl: '/user/profile',
          label: 'user-profile',
          selectors: [
            (page) => page.getByRole('heading', { name: '个人资料' }),
            (page) => page.getByRole('button', { name: '注销账户' })
          ]
        },
        {
          path: '/user/comments',
          expectedUrl: '/user/comments',
          label: 'user-comments',
          selectors: [
            (page) => page.getByRole('heading', { name: '我的评论' }),
            (page) => page.locator('main')
          ]
        },
        {
          path: '/user/messagebox',
          expectedUrl: '/user/messagebox',
          label: 'user-messagebox',
          selectors: [
            (page) => page.getByText('我的站内信', { exact: false }),
            (page) => page.getByText('新建申诉工单', { exact: false })
          ]
        }
      ]

      for (const route of expectations) {
        const session = await openAuditedPage(browser, storageState)
        try {
          await expectRouteAndShell(session.page, session.audit, route)
          await assertResponsiveLayoutContract(session.page, route.label)
        } finally {
          await session.close()
        }
      }
    })

    test('profile session actions and delete guard stay aligned', async ({ browser }) => {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/profile', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        const revokeOthersButton = session.page.getByRole('button', { name: '下线其他设备' })
        await assertElementHitTarget(session.page, revokeOthersButton, 'revoke other sessions')
        await revokeOthersButton.click()
        await expect(session.page.locator('.el-message').last()).toContainText('其他设备已下线')
        await assertToastInViewport(session.page)

        const dangerButton = session.page.getByRole('button', { name: '注销账户' })
        await dangerButton.click()
        const dialog = session.page.getByRole('dialog', { name: '注销账户' })
        await expect(dialog).toBeVisible()
        await assertElementInViewport(session.page, dialog, 'delete account dialog')
        await assertResponsiveLayoutContract(session.page, 'user-profile-dialog')
        await expect(dialog).toContainText('DELETE')
        await session.page.getByRole('button', { name: '取消' }).click()

        session.audit.assertCleanSince(start, 'user-profile-security-actions')
      } finally {
        await session.close()
      }
    })

    test('message center can create a ticket and open detail cleanly', async ({ browser }) => {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/messagebox', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        const unique = `Acceptance 工单 ${Date.now()}`
        const subjectInput = session.page.locator('input[placeholder*="申诉"], input[placeholder*="系统通知"]').first()
        const bodyInput = session.page.locator('textarea[placeholder*="描述问题"], textarea[placeholder*="消息正文"]').first()
        await subjectInput.fill(unique)
        await bodyInput.fill('这是 acceptance 自动工单，用于验证消息中心主链。')
        await session.page.getByRole('button', { name: '提交工单' }).click()

        await expect(session.page.locator('.el-message').last()).toContainText('工单已创建')
        await assertToastInViewport(session.page)
        const threadPanel = session.page.locator('.mail-thread-panel').first()
        await expect(threadPanel.locator('.mail-header-title').first()).toContainText(unique)
        await assertElementInViewport(session.page, threadPanel, 'mail thread panel')
        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'user-messagebox')
        await assertSectionsDoNotOverlap([
          { locator: session.page.locator('.mail-list-pane').first(), label: 'mail list pane' },
          { locator: threadPanel, label: 'mail detail pane' }
        ])

        session.audit.assertCleanSince(start, 'user-messagebox-create-ticket')
      } finally {
        await session.close()
      }
    })
  })
}
