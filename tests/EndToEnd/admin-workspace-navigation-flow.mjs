import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertEmptySuccess, enableAuthenticator, expect, launchIdentityBrowser } from './site-authentication-fixture.mjs'

const admin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL ?? 'http://invalid.test')
const site = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
const ticket = process.env.FSUSBLOG_TEST_ADMIN_TICKET
assert.equal(admin.hostname, 'localhost')
assert.equal(site.hostname, '127.0.0.1')
assert(/^[0-9a-f]{64}$/.test(ticket ?? ''), 'Supply one unused synthetic administrator bootstrap ticket.')
const routes = [
  ['/admin/articles', 'Articles'], ['/admin/interaction', 'Interaction'],
  ['/admin/site', 'Site'], ['/admin/system', 'System'], ['/admin/identity', 'Account'],
]
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/admin-workspace-navigation')
await mkdir(evidence, { recursive: true })
const browser = await launchIdentityBrowser(process.env.FSUSBLOG_TEST_TLS_SPKI)
const checks = {}
const faults = []
let failure
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'fsus_locale', value: 'en', url: admin.origin }])
  const page = await context.newPage()
  page.on('pageerror', error => faults.push(error.message))
  await enableAuthenticator(context, page)
  for (const [path] of [['/admin'], ...routes]) {
    const response = await context.request.get(site.origin + path, { maxRedirects: 0 })
    assert.equal(response.status(), 404, `Public origin must refuse ${path}`)
  }
  checks.publicOriginRefusesAdministratorPages = true

  await page.goto(admin.origin + '/admin/identity')
  await expect(page.getByRole('button', { name: 'Log in as administrator', exact: true })).toBeVisible()
  await expect(page.locator('.account-workspace')).toHaveCount(0)
  await page.getByRole('button', { name: 'Set up administrator Passkey', exact: true }).click()
  await page.getByLabel('One-time administrator bootstrap key', { exact: true }).fill(ticket)
  await clickMutation(WireRoutes.AdminBootstrapComplete, 'Create administrator Passkey')
  await expect(page.getByText('Administrator Passkey created. Log in with it to continue.', { exact: true })).toBeVisible()
  assert.equal((await context.request.get(admin.origin + WireRoutes.AdminSession)).status(), 401)
  await expect(page.locator('.account-workspace')).toHaveCount(0)
  await clickMutation(WireRoutes.AdminPasskeyComplete, 'Log in as administrator')
  await expect(page.locator('.account-workspace')).toBeVisible()
  assert.equal((await context.request.get(admin.origin + WireRoutes.AdminSession)).status(), 200)
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  checks.distinctAdministratorSessionRequired = true

  await page.goto(admin.origin + '/admin')
  await page.waitForURL(admin.origin + '/admin/site')
  await expect(page.locator('.account-workspace-nav a[href="/admin"]')).toHaveCount(0)
  checks.overviewRedirectsToSite = true

  const shell = await page.locator('.account-workspace').elementHandle()
  assert(shell)
  const nav = page.locator('.account-workspace-nav')
  for (const [path, label] of routes) {
    const link = nav.getByRole('link', { name: label, exact: true })
    await expect(link).toHaveAttribute('href', path)
    await link.click()
    await page.waitForURL(admin.origin + path)
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    assert(await shell.evaluate(element => element.isConnected && element === document.querySelector('.account-workspace')),
      `The outer workspace must survive SPA navigation to ${path}`)
    assert.equal((await context.request.get(admin.origin + WireRoutes.AdminSession)).status(), 200)
    if (path === '/admin/articles') {
      const workspace = page.locator('.admin-workspace')
      const articles = workspace.getByRole('tab', { name: 'Articles', exact: true })
      const trash = workspace.getByRole('tab', { name: 'Trash', exact: true })
      await expect(articles).toHaveAttribute('aria-selected', 'true')
      await expect(workspace.getByRole('textbox', { name: 'Title or summary', exact: true })).toBeVisible()
      await expect(workspace.getByRole('region', { name: 'Taxonomy usage' })).toHaveCount(0)
      await trash.click()
      await expect(trash).toHaveAttribute('aria-selected', 'true')
      await expect(workspace.getByRole('textbox', { name: 'Title or summary', exact: true })).toBeVisible()
      assert.equal(new URL(page.url()).pathname, '/admin/articles')
      checks.articleInventoryIsPrimaryWithLocalTabs = true
    }
  }
  await shell.dispose()
  checks.allFiveRoutesReuseAuthenticatedShell = true
  await page.screenshot({ path: join(evidence, 'admin-workspace.png') })
  assert.deepEqual(faults, [])

  async function clickMutation(path, name) {
    const response = page.waitForResponse(value => value.request().method() === 'POST' && value.url() === admin.origin + path)
    await page.getByRole('button', { name, exact: true }).click()
    await assertEmptySuccess(await response, 'Administrator mutation must not be cached.')
  }
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'admin-workspace-result.json'), JSON.stringify({
    checks, faults, failure: failure instanceof Error ? failure.message : undefined,
  }, null, 2) + '\n')
}
if (failure) throw failure
