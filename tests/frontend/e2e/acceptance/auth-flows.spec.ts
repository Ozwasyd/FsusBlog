import { expect, test, type Page } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  openAuditedPage,
  prewarmDevRuntime,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

async function submitAndAwaitAuthAlert(page: Page, buttonPattern: RegExp, alertSelector: string) {
  await page.getByRole('button', { name: buttonPattern }).click()
  await expect(page.locator(alertSelector)).toBeVisible()
  return (await page.locator(alertSelector).textContent())?.trim() || ''
}

async function acceptRegistrationAgreement(page: Page) {
  await page.locator('label.el-checkbox:has(#agreement)').click()
  await expect(page.locator('#agreement')).toBeChecked()
}

test.describe('auth flows acceptance', () => {
  test.use({ viewport: DESKTOP_VIEWPORT })
  test.describe.configure({ timeout: 240_000 })

  test.beforeAll(async ({ browser }) => {
    await prewarmDevRuntime(browser)
  })

  test('register auto-login redirects to requested page', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const randomSuffix = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
    const username = `uiregister${randomSuffix}`
    const password = 'UiRegisterPass123!'

    try {
      const start = session.audit.checkpoint()
      const redirectTo = '/user/profile'
      await session.page.goto(`/register?redirect=${encodeURIComponent(redirectTo)}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)

      await session.page.locator('#username').fill(username)
      await session.page.locator('#password').fill(password)
      await session.page.locator('#confirm-password').fill(password)
      await acceptRegistrationAgreement(session.page)
      await session.page.getByRole('button', { name: /立即注册|安全加固校验中|正在同步账户数据/ }).click()

      await session.page.waitForFunction(
        () => {
          const path = `${location.pathname}${location.search}`
          return path === '/user/profile' || Boolean(document.querySelector('#register-error'))
        },
        undefined,
        { timeout: 45_000 }
      )

      const inlineError = (await session.page.locator('#register-error').allTextContents()).join(' | ').trim()
      expect(inlineError, 'register should not fail').toBe('')

      await expect
        .poll(() => {
          const current = new URL(session.page.url())
          return `${current.pathname}${current.search}`
        }, { message: 'register should redirect to requested page after auto-login' })
        .toBe(redirectTo)

      await waitForAppReady(session.page)
      await settlePage(session.page)
      await expect(session.page.locator('body')).not.toContainText('400')
      session.audit.assertCleanSince(start, 'register-auto-login')
    } finally {
      await session.close()
    }
  })

  test('login and register failures stay inline and explicit', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      await session.page.goto('/login', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await session.page.locator('#username').fill('definitely_missing_user')
      await session.page.locator('#password').fill('WrongPass123!')
      let loginErrorText = await submitAndAwaitAuthAlert(session.page, /进行|登录中|安全校验中/, '#login-error')
      if (loginErrorText === '安全校验已刷新，请重新提交') {
        loginErrorText = await submitAndAwaitAuthAlert(session.page, /进行|登录中|安全校验中/, '#login-error')
      }

      expect(loginErrorText).toMatch(/用户名或密码错误|无法继续登录|锁定/)
      await expect(session.page.locator('#login-error')).not.toContainText(/^400$/)

      await session.page.goto('/register', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await session.page.locator('#username').fill('binaryuser')
      await session.page.locator('#password').fill('RegisterDuplicate123!')
      await session.page.locator('#confirm-password').fill('RegisterDuplicate123!')
      await acceptRegistrationAgreement(session.page)
      await session.page.getByRole('button', { name: /立即注册|安全加固校验中|正在同步账户数据/ }).click()

      await expect(session.page.locator('#register-error')).toContainText(/已存在|已被注册|已被占用/)
      await expect(session.page.locator('#register-error')).not.toContainText(/^400$/)
      await expect(session.page.locator('body')).not.toContainText('TypeError')
    } finally {
      await session.close()
    }
  })
})
