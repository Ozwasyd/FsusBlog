import { expect, test } from '../../../../src/frontend/node_modules/@playwright/test/index.mjs'

test('gamma browser contract', async ({ page }) => {
  await page.setContent('<main data-replay="gamma">gamma</main>')
  await expect(page.locator('[data-replay="gamma"]')).toHaveText('gamma')
})
