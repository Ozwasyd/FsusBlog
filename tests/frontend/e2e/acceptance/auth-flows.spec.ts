import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  DESKTOP_VIEWPORT,
  openAuditedPage,
  prewarmDevRuntime,
  settlePage,
  waitForAppReady
} from '../../support/playwright/acceptance-shared'

async function acceptRegistrationAgreement(page: Page) {
  await page.locator('#agreement').evaluate((element) => {
    const checkbox = element as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('input', { bubbles: true }))
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await expect(page.locator('#agreement')).toBeChecked()
}

test.describe('auth flows acceptance', () => {
  test.use({ viewport: DESKTOP_VIEWPORT })
  test.describe.configure({ timeout: 240_000 })

  test.beforeAll(async ({ browser }) => {
    await prewarmDevRuntime(browser)
  })

  test('register entry enables only after agreement and keeps step-up failures inline', async ({ browser }) => {
    const session = await openAuditedPage(browser)
    const randomSuffix = Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')
    const publicHandle = `uiacct${randomSuffix}`

    try {
      const redirectTo = '/user/profile'
      await session.page.goto(`/register?redirect=${encodeURIComponent(redirectTo)}`, { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)

      await session.page.locator('#public-handle').fill(publicHandle)
      await acceptRegistrationAgreement(session.page)
      await expect(session.page.getByRole('button', { name: /创建匿名账号并生成 Recovery Key/ })).toBeEnabled()
      await session.page.getByRole('button', { name: /创建匿名账号并生成 Recovery Key|正在创建匿名账号/ }).click()

      await expect(session.page.locator('#register-error')).toBeVisible({ timeout: 45_000 })
      await expect(session.page.locator('#register-error')).toContainText(/ANONYMOUS_STEP_UP_PROOF_REQUIRED|匿名账号创建失败/)
      await expect(session.page.locator('#register-error')).not.toContainText(/^400$/)

      const current = new URL(session.page.url())
      expect(`${current.pathname}${current.search}`).toBe(`/register?redirect=${encodeURIComponent(redirectTo)}`)

      await waitForAppReady(session.page)
      await settlePage(session.page)
      await expect(session.page.locator('body')).not.toContainText('400')
    } finally {
      await session.close()
    }
  })

  test('login and register failures stay inline and explicit', async ({ browser }) => {
    const session = await openAuditedPage(browser)

    try {
      await session.page.goto('/login', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)

      await expect(session.page.getByRole('heading', { name: '登录' })).toBeVisible()
      await expect(session.page.getByRole('button', { name: /使用通行密钥登录/ })).toBeVisible()
      await expect(session.page.getByRole('link', { name: /使用 Recovery Key 恢复访问/ })).toHaveAttribute('href', '/recover')
      await expect(session.page.locator('#username')).toHaveCount(0)
      await expect(session.page.locator('#password')).toHaveCount(0)
      await expect(session.page.locator('#login-error')).toHaveCount(0)

      await session.page.goto('/register', { waitUntil: 'domcontentloaded' })
      await waitForAppReady(session.page)
      await session.page.locator('#public-handle').fill('!!')

      await expect(session.page.locator('#public-handle-hint')).toBeVisible()
      await expect(session.page.getByRole('button', { name: /创建匿名账号并生成 Recovery Key/ })).toBeDisabled()
      await expect(session.page.locator('#register-error')).toHaveCount(0)
      await expect(session.page.locator('body')).not.toContainText('TypeError')
    } finally {
      await session.close()
    }
  })
})
