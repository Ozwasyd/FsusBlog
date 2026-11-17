// Keep route changes inside the shared authenticated shell when it is available.
export async function visitAdminWorkspace(page, path) {
  if (new URL(page.url()).pathname === path) return
  await page.locator('.account-workspace-nav').locator(`a[href="${path}"]`).click()
  await page.waitForURL(url => url.pathname === path)
}
