import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { clickForResponse } from './admin-workspace-fixture.mjs'
import { assertNoOverflow, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'
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
const browser = await launchIdentityBrowser(process.env.FSUSBLOG_TEST_TLS_SPKI)
const checks = {}
const faults = []

await withBrowserEvidence(browser, evidence, 'admin-workspace-result.json', failure => ({
  checks, faults, failure: failure instanceof Error ? failure.message : undefined,
}), async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'fsus_locale', value: 'en', url: admin.origin }])
  const page = await context.newPage()
  page.on('pageerror', error => faults.push(error.message))
  await enableAuthenticator(context, page)
  for (const [path] of [['/admin'], ['/admin/system'], ...routes]) {
    assertStatus(await context.request.get(site.origin + path, { maxRedirects: 0 }), 404, `Public origin must refuse ${path}`)
  }
  checks.publicOriginRefusesAdministratorPages = true

  async function clickMutation(path, name) {
    const response = await clickForResponse(page, admin.origin + path, loc.exactButton(page, name), 'POST')
    await assertEmptySuccess(response, 'Administrator mutation must not be cached.')
  }

  await page.goto(admin.origin + '/admin/identity')
  await expect(loc.exactButton(page, 'Log in as administrator')).toBeVisible()
  await expect(page.locator('.account-workspace')).toHaveCount(0)
  await loc.exactButton(page, 'Set up administrator Passkey').click()
  await loc.exactLabel(page, 'One-time administrator bootstrap key').fill(ticket)
  await clickMutation(WireRoutes.AdminBootstrapComplete, 'Create administrator Passkey')
  await expect(loc.exactText(page, 'Administrator Passkey created. Log in with it to continue.')).toBeVisible()
  assertStatus(await context.request.get(admin.origin + WireRoutes.AdminSession), 401)
  await expect(page.locator('.account-workspace')).toHaveCount(0)
  await clickMutation(WireRoutes.AdminPasskeyComplete, 'Log in as administrator')
  await expect(page.locator('.account-workspace')).toBeVisible()
  assertStatus(await context.request.get(admin.origin + WireRoutes.AdminSession), 200)
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
    const link = loc.exactLink(nav, label)
    await expect(link).toHaveAttribute('href', path)
    await link.click()
    await page.waitForURL(admin.origin + path)
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
    assert(await shell.evaluate(element => element.isConnected && element === document.querySelector('.account-workspace')),
      `The outer workspace must survive SPA navigation to ${path}`)
    assertStatus(await context.request.get(admin.origin + WireRoutes.AdminSession), 200)
    if (path === '/admin/articles') {
      const workspace = page.locator('.admin-workspace')
      const articles = loc.exactTab(workspace, 'Articles')
      const trash = loc.exactTab(workspace, 'Trash')
      await expect(articles).toHaveAttribute('aria-selected', 'true')
      await expect(loc.roleWithExactName(workspace, 'textbox', 'Title or summary')).toBeVisible()
      await expect(workspace.getByRole('region', { name: 'Taxonomy usage' })).toHaveCount(0)
      await trash.click()
      await expect(trash).toHaveAttribute('aria-selected', 'true')
      await expect(loc.roleWithExactName(workspace, 'textbox', 'Title or summary')).toBeVisible()
      assert.equal(new URL(page.url()).pathname, '/admin/articles')
      checks.articleInventoryIsPrimaryWithLocalTabs = true
    }
  }
  await shell.dispose()
  checks.allFourRoutesReuseAuthenticatedShell = true
  await saveShot(page, evidence, 'admin-workspace.png', {})

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 })
    const menuTrigger = loc.exactButton(page, 'Admin menu')
    await expect(menuTrigger).toBeVisible()
    const triggerBox = await menuTrigger.boundingBox()
    assert(triggerBox && triggerBox.height >= 44)
    await menuTrigger.click()
    const drawer = loc.exactDialog(page, 'Admin menu')
    await expect(drawer).toBeVisible()
    const layout = await page.evaluate(() => {
      const body = document.querySelector('.el-drawer__body')
      const groups = [...document.querySelectorAll('.account-workspace-drawer [role="radiogroup"]')]
      const logout = document.querySelector('.account-workspace-drawer-actions button')
      const rect = el => { const b = el?.getBoundingClientRect(); return b ? { x: b.x, width: b.width, height: b.height } : null }
      return {
        pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
        bodyOverflowX: !!body && body.scrollWidth > body.clientWidth,
        dropdownCount: document.querySelectorAll('.account-workspace-drawer .el-dropdown').length,
        groupRects: groups.map(rect),
        logoutRect: rect(logout),
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
      await loc.roleWithExactName(drawer, 'radiogroup', 'Theme mode').getByText('Dark', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
      await loc.roleWithExactName(drawer, 'radiogroup', 'Interface language').getByText('中文', { exact: true }).click()
      const zhDrawer = loc.exactDialog(page, '管理菜单')
      await expect(zhDrawer).toBeVisible()
      await loc.roleWithExactName(zhDrawer, 'radiogroup', '界面语言').getByText('EN', { exact: true }).click()
      await expect(drawer).toBeVisible()
      await loc.roleWithExactName(drawer, 'radiogroup', 'Theme mode').getByText('System', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
      await loc.exactLink(drawer, 'Site').click()
      await page.waitForURL(admin.origin + '/admin/site')
      await expect(drawer).toBeHidden()
    } else {
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
      await expect(page.locator('.site-config-form')).toBeVisible()
      await assertNoOverflow(page)
      await saveShot(page, evidence, 'admin-site-320-seo.png', { fullPage: true })
      await loc.exactTab(page, 'Compliance & Footer').click()
      await expect(loc.exactText(page, 'Enable public footer compliance & license block')).toBeVisible()
      await assertNoOverflow(page)
      await saveShot(page, evidence, 'admin-site-320-compliance.png', { fullPage: true })
    }
  }
  checks.mobileDrawerNavigationAndPreferences = true
  assert.deepEqual(faults, [])
}, { mkdir: true, newline: true })
