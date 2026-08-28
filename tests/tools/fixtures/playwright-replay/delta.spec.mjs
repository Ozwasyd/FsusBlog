import { expect, test } from '../../../../src/frontend/node_modules/@playwright/test/index.mjs'

test('delta browser contract', async ({ page }) => {
  await page.setContent('<main data-replay="delta">delta</main>')
  await expect(page.locator('[data-replay="delta"]')).toHaveText('delta')
})
