import { expect, test } from '../../../../src/frontend/node_modules/@playwright/test/index.mjs'

test('alpha browser contract', async ({ page }) => {
  await page.setContent('<main data-replay="alpha">alpha</main>')
  await expect(page.locator('[data-replay="alpha"]')).toHaveText('alpha')
})
