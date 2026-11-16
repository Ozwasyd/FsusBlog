export async function submitSearch(page, query) {
  const form = page.locator('form.search-form')
  await form.getByRole('textbox', { name: 'Search articles' }).fill(query)
  await form.getByRole('button', { name: 'Search', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === query)
}
