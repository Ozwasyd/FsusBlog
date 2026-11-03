import { test, expect } from '@playwright/test'
test('successful evidence fixture', async ({ page }) => {
  await page.setContent('<button>actual fixture</button>')
  await expect(page.getByRole('button')).toHaveText('actual fixture')
})
test('intentional failure evidence fixture', async ({ page }) => {
  await page.setContent('<button>actual fixture</button>')
  await expect(page.getByRole('button')).toHaveText('intentional failure', { timeout: 50 })
})
