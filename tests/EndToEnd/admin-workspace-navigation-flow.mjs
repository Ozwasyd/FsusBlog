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
  ['/admin/site', 'Site'], ['/admin/identity', 'Account'],
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
  for (const [path] of [['/admin'], ['/admin/system'], ...routes]) {
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
  checks.allFourRoutesReuseAuthenticatedShell = true
  await page.screenshot({ path: join(evidence, 'admin-workspace.png') })

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 })
    const menuTrigger = page.getByRole('button', { name: 'Admin menu', exact: true })
    await expect(menuTrigger).toBeVisible()
    const triggerBox = await menuTrigger.boundingBox()
    assert(triggerBox && triggerBox.height >= 44)
    await menuTrigger.click()
    const drawer = page.getByRole('dialog', { name: 'Admin menu', exact: true })
    await expect(drawer).toBeVisible()
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.el-drawer__body')
      const groups = [...document.querySelectorAll('.account-workspace-drawer [role="radiogroup"]')]
      const logout = document.querySelector('.account-workspace-drawer-actions button')
      const r = el => el?.getBoundingClientRect()
      return {
        pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
        bodyOverflowX: !!body && body.scrollWidth > body.clientWidth,
        dropdownCount: document.querySelectorAll('.account-workspace-drawer .el-dropdown').length,
        groupRects: groups.map(g => { const b = r(g); return b ? { x: b.x, width: b.width, height: b.height } : null }),
        logoutRect: (() => { const b = r(logout); return b ? { x: b.x, width: b.width, height: b.height } : null })(),
      }
    })
    assert.equal(layout.pageOverflowX, false)
    assert.equal(layout.bodyOverflowX, false)
    assert.equal(layout.dropdownCount, 0)
    assert.equal(layout.groupRects.length, 2)
    assert(layout.logoutRect && layout.groupRects[0] && layout.groupRects[1])
    assert(Math.abs(layout.logoutRect.x - layout.groupRects[0].x) <= 1)
    assert(Math.abs(layout.logoutRect.width - layout.groupRects[0].width) <= 1)
    assert(layout.logoutRect.height >= 44 && layout.groupRects[0].height >= 44 && layout.groupRects[1].height >= 44)
    if (width === 375) {
      await drawer.getByRole('radiogroup', { name: 'Theme mode', exact: true }).getByText('Dark', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
      await drawer.getByRole('radiogroup', { name: 'Interface language', exact: true }).getByText('中文', { exact: true }).click()
      const zhDrawer = page.getByRole('dialog', { name: '管理菜单', exact: true })
      await expect(zhDrawer).toBeVisible()
      await zhDrawer.getByRole('radiogroup', { name: '界面语言', exact: true }).getByText('EN', { exact: true }).click()
      await expect(drawer).toBeVisible()
      await drawer.getByRole('radiogroup', { name: 'Theme mode', exact: true }).getByText('System', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
      await drawer.getByRole('link', { name: 'Site', exact: true }).click()
      await page.waitForURL(admin.origin + '/admin/site')
      await expect(drawer).toBeHidden()
    } else {
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    }
  }
  checks.mobileDrawerNavigationAndPreferences = true
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
