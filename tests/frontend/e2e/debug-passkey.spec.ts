import { expect, test } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  openAuditedPage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

test.describe('passkey login debugging', () => {
  test.use({ viewport: DESKTOP_VIEWPORT })

  test('passkey login button triggers authentication flow', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    try {
      await session.page.goto('/login', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)

      // 点击通行密钥登录按钮
      await session.page.getByRole('button', { name: /使用通行密钥登录/ }).click()

      // 我们预期代码会打印 debug 日志
      // 如果它工作了，它应该会尝试调用 WebAuthn
      // 在 Playwright 环境下，通常会抛出错误或超时，因为没有模拟的 authenticator 默认开启

      // 检查页面是否显示了我们新加的详细错误信息（如果 startAuthentication 抛错）
      // 或者检查控制台日志

      await session.page.waitForTimeout(5000)
      const logs = await session.page.evaluate(() => (window as any).__passkey_logs || [])
      console.log('Browser Passkey Logs:', logs)

    } finally {
      await session.close()
    }
  })
})
