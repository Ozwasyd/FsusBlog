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
  expectAnyToastText,
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
      storageState = await captureStorageState(browser, userName, userPassword, '/user/identity')
    })

    test('visible user routes load without runtime noise', async ({ browser }) => {
      const expectations = [
        {
          path: '/user/identity',
          expectedUrl: '/user/identity',
          label: 'user-identity',
          selectors: [
            (page) => page.getByRole('heading', { name: '身份总览' }),
            (page) => page.getByRole('heading', { name: '账号生命周期' }),
            (page) => page.getByRole('button', { name: '注销账户' })
          ]
        },
        {
          path: '/user/comments',
          expectedUrl: '/user/comments',
          label: 'user-comments',
          selectors: [
            (page) => page.getByRole('heading', { name: '公开评论记录' }),
            (page) => page.locator('main')
          ]
        },
        {
          path: '/user/messagebox',
          expectedPathname: '/user/messagebox',
          label: 'user-messagebox',
          selectors: [
            (page) => page.getByText('我的站内信', { exact: false }),
            (page) => page.getByRole('button', { name: '提交工单' }).first()
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
        await session.page.goto('/user/identity/sessions', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        const revokeOthersButton = session.page.getByRole('button', { name: '下线其他设备' })
        await assertElementHitTarget(session.page, revokeOthersButton, 'revoke other sessions')
        const hasOtherSessions = await session.page.getByRole('listitem').filter({ hasText: '其他设备' }).count() > 0
        if (hasOtherSessions) {
          await revokeOthersButton.click()
          await expect(session.page.locator('.el-message').last()).toContainText('其他设备已下线')
          await assertToastInViewport(session.page)
        } else {
          await expect(revokeOthersButton).toBeDisabled()
          await expect(session.page.getByRole('dialog', { name: '下线其他设备' })).toHaveCount(0)
        }

        await session.page.goto('/user/identity', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)
        const dangerButton = session.page.getByRole('button', { name: '注销账户' })
        await dangerButton.click()
        const dialog = session.page.getByRole('dialog', { name: '注销账户' })
        await expect(dialog).toBeVisible()
        await assertElementInViewport(session.page, dialog, 'delete account dialog')
        await assertResponsiveLayoutContract(session.page, 'user-profile-dialog')
        await expect(dialog).toContainText('注销后账号相关会话、通行密钥、Recovery Key 与匿名凭据都会失效')
        await expect(dialog.getByRole('button', { name: '确认' })).toBeVisible()
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
        const createTicketButton = session.page.getByRole('button', { name: '提交工单' }).first()
        if (await createTicketButton.isVisible().catch(() => false)) {
          await createTicketButton.click()
        }
        const composePanel = session.page.locator('.messages-compose-panel', { hasText: '提交工单' }).first()
        await expect(composePanel).toBeVisible()
        const subjectInput = composePanel.locator('input[name^="ticketSubject"], input[placeholder*="工单"], input[placeholder*="主题"]').first()
        const bodyInput = composePanel.locator('textarea[name^="ticketBody"], textarea[placeholder*="回复内容"], textarea[placeholder*="正文"]').first()
        await expect(subjectInput).toBeVisible()
        await expect(bodyInput).toBeVisible()
        await subjectInput.fill(unique)
        await bodyInput.fill('这是 acceptance 自动工单，用于验证消息中心主链。')
        const ticketToastPromise = expectAnyToastText(session.page, /工单已创建/, 60_000)
        const ticketCreateResponsePromise = session.page.waitForResponse((response) => {
          const request = response.request()
          const url = new URL(response.url())
          return request.method() === 'POST' && url.pathname === '/api/binary/messages/conversations'
        }, { timeout: 60_000 })
        await composePanel.getByRole('button', { name: '提交工单' }).click()

        const ticketCreateResponse = await ticketCreateResponsePromise
        expect(ticketCreateResponse.ok(), 'ticket create request should succeed').toBe(true)
        await ticketToastPromise
        await assertToastInViewport(session.page)
        const threadPanel = session.page.locator('.messages-thread-panel').first()
        await expect(threadPanel.locator('.messages-header-title').first()).toContainText(unique)
        await assertElementInViewport(session.page, threadPanel, 'messages thread panel')
        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'user-messagebox')
        await assertSectionsDoNotOverlap([
          { locator: session.page.locator('.messages-list-pane').first(), label: 'messages list pane' },
          { locator: threadPanel, label: 'messages detail pane' }
        ])

        session.audit.assertCleanSince(start, 'user-messagebox-create-ticket')
      } finally {
        await session.close()
      }
    })

    test('passkey section is accessible and opens registration modal', async ({ browser }) => {
      const session = await openAuditedPage(browser, storageState)
      try {
        const start = session.audit.checkpoint()
        await session.page.goto('/user/identity/passkeys', { waitUntil: 'domcontentloaded' })
        await waitForAppReady(session.page)
        await settlePage(session.page)

        const passkeyHeading = session.page.getByRole('heading', { name: '通行密钥设备' })
        await expect(passkeyHeading).toBeVisible()
        await assertElementInViewport(session.page, passkeyHeading, 'passkey section heading')

        const emptyState = session.page.getByText('尚未添加通行密钥')
        await expect(emptyState).toBeVisible()

        const addButton = session.page.getByRole('button', { name: '添加通行密钥' })
        await expect(addButton).toBeVisible()
        await assertElementHitTarget(session.page, addButton, 'add passkey button')

        await addButton.click()
        const modal = session.page.getByRole('dialog')
        await expect(modal).toBeVisible()
        await assertElementInViewport(session.page, modal, 'passkey register modal')

        const nameInput = modal.locator('input').first()
        await expect(nameInput).toBeVisible()

        await session.page.getByRole('button', { name: '取消' }).first().click()
        await expect(modal).not.toBeVisible()

        await assertNoHorizontalOverflow(session.page)
        await assertResponsiveLayoutContract(session.page, 'user-profile-passkey')
        session.audit.assertCleanSince(start, 'passkey-section-profile')
      } finally {
        await session.close()
      }
    })
  })
}
