import { expect, test } from '../../../../src/frontend/node_modules/@playwright/test/index.mjs'

test('beta browser contract', async ({ page }) => {
  await page.setContent('<main data-replay="beta">beta</main>')
  await expect(page.locator('[data-replay="beta"]')).toHaveText('beta')
})
