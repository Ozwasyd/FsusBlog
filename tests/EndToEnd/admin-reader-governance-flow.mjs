import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { clickForResponse, visitAdminWorkspace } from './admin-workspace-fixture.mjs'
import { assertNoOverflow, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertNoStore, assertStatus } from './response-status-fixture.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'
import { exactButton, exactDialog, exactLabel, exactTab, exactText } from './role-locators.mjs'
import { assertEmptySuccess, expect, launchIdentityBrowser } from './site-authentication-fixture.mjs'
import { signInFreshAdmin, signInFreshSite } from './webauthn-fixture.mjs'

const admin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL ?? 'http://invalid.test')
const ticket = process.env.FSUSBLOG_TEST_ADMIN_TICKET
const site = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
const readerTicket = process.env.FSUSBLOG_TEST_SITE_TICKET
const readerName = process.env.FSUSBLOG_TEST_READER_NAME ?? 'alice-reader'
const readerDisplay = process.env.FSUSBLOG_TEST_READER_DISPLAY ?? 'Alice Reader'
assert(admin.protocol === 'https:' && admin.hostname === 'admin.localhost')
assert(site.protocol === 'https:' && site.hostname === 'localhost' && site.port === admin.port)
assert(/^[0-9a-f]{64}$/.test(ticket ?? ''), 'Supply one unused synthetic administrator bootstrap ticket.')
assert(/^[0-9a-f]{64}$/.test(readerTicket ?? ''), 'Supply one unused synthetic reader setup ticket.')

const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/admin-reader-governance')
const browser = await launchIdentityBrowser(process.env.FSUSBLOG_TEST_TLS_SPKI)
const checks = {}
const faults = []

await withBrowserEvidence(browser, evidence, 'result.json', failure => ({
  checks, faults, failure: failure instanceof Error ? failure.message : undefined,
}), async () => {
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const readerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await signInFreshSite(await readerContext.newPage(), site.origin, readerTicket)

  // Verify reader session is live before governance action.
  assertStatus(await readerContext.request.get(site.origin + WireRoutes.Session), 200, 'Reader Passkey session must be active before banning.')
  checks.readerSessionInitiallyActive = true

  const page = await adminContext.newPage()
  page.on('pageerror', error => faults.push(error.message))
  await Promise.all([
    ...[WireRoutes.AdminBootstrapComplete, WireRoutes.AdminPasskeyComplete].map(async path => {
      await assertEmptySuccess(await waitForPathResponse(page, () => path, 'POST'), 'Administrator mutation must not be cached.')
    }),
    signInFreshAdmin(page, admin.origin, ticket),
  ])
  await expect(page.locator('.account-workspace')).toBeVisible()
  checks.adminSignedIn = true

  const setTheme = mode => page.evaluate(theme => {
    document.documentElement.dataset.themeMode = theme
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, mode)
  const executeUrl = admin.origin + WireRoutes.AdminReaderStatusExecute

  // Navigate to Interaction -> Readers tab.
  await visitAdminWorkspace(page, '/admin/interaction')
  const readersTab = exactTab(page, 'Readers')
  await expect(readersTab).toBeVisible()
  await readersTab.click()
  await expect(readersTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.readers-list')).toBeVisible()
  await expect(exactText(page, readerDisplay)).toBeVisible()
  await saveShot(page, evidence, 'desktop-1280-en-light.png', {})
  checks.readersTabLoadsOnDesktop = true

  // Search by keyword and filter by status.
  await exactLabel(page, 'Account name, comment handle, or ID').fill(readerName)
  await exactButton(page, 'Search').click()
  await expect(page.locator('.readers-list .el-resource-list-item')).toHaveCount(1)
  await expect(exactText(page, readerDisplay)).toBeVisible()
  checks.keywordSearchWorks = true

  // Open Ban dialog, verify blur validation, then execute real Passkey Step-Up ban.
  await exactButton(page, 'Ban account').click()
  const dialog = exactDialog(page, 'Ban reader account')
  await expect(dialog).toBeVisible()
  const reasonBox = exactLabel(dialog, 'Governance reason')
  await reasonBox.focus()
  await reasonBox.blur()
  await expect(dialog.locator('.readers-validation')).toBeVisible()
  await reasonBox.fill('Repeated automated spam in comments')
  await page.waitForFunction(() => {
    const dlg = document.querySelector('body > .el-overlay .el-dialog')
    return !!dlg && Number.parseFloat(getComputedStyle(dlg).opacity) >= 0.99
  })
  await page.waitForTimeout(250)
  await saveShot(page, evidence, 'desktop-1280-en-ban-dialog.png', {})

  const banResponse = await clickForResponse(page, executeUrl, exactButton(dialog, 'Confirm ban with Passkey'), 'POST')
  assertStatus(banResponse, 200)
  await assertNoStore(banResponse)
  await expect(dialog).toBeHidden()
  await expect(exactText(page, 'Banned').first()).toBeVisible()
  await expect(page.getByText(/Repeated automated spam in comments/)).toBeVisible()
  checks.banWithPasskeyStepUpSucceeded = true

  // Verify the banned reader's live HTTP session is immediately dead.
  assertStatus(await readerContext.request.get(site.origin + WireRoutes.Session), 401, 'Banned reader session must be revoked immediately.')
  checks.readerSessionImmediatelyRevoked = true

  // Switch to zh-CN and dark theme on desktop, capture evidence.
  await page.evaluate(() => { document.cookie = 'fsus_locale=zh-CN; path=/' })
  await page.reload()
  await setTheme('dark')
  await exactTab(page, '读者账号').click()
  await expect(page.locator('.readers-list')).toBeVisible()
  await page.waitForTimeout(150)
  await saveShot(page, evidence, 'desktop-1280-zh-dark.png', {})

  // Filter Disabled in zh-CN, then unban with real Passkey Step-Up.
  await page.locator('.readers-status-group').getByText(/已封禁/).click()
  await expect(page.locator('.readers-list')).toBeVisible()
  const targetCard = page.locator('.readers-list .el-resource-list-item', { hasText: readerDisplay })
  await expect(targetCard).toBeVisible()
  await exactButton(targetCard, '解封账号').click()
  const unbanDialog = exactDialog(page, '解封读者账号')
  await expect(unbanDialog).toBeVisible()
  await exactLabel(unbanDialog, '治理原因').fill('复核申诉通过，恢复账号')
  assertStatus(await clickForResponse(page, executeUrl, exactButton(unbanDialog, '使用通行密钥确认解封'), 'POST'), 200)
  await expect(unbanDialog).toBeHidden()
  await page.locator('.readers-status-group').getByText(/全部/).click()
  await expect(page.getByText(/复核申诉通过，恢复账号/)).toBeVisible()
  checks.unbanWithPasskeyStepUpSucceeded = true

  // Inspect mobile viewports (375px dark & light, 320px light) for zero horizontal overflow.
  for (const [width, theme, file] of [
    [375, 'dark', 'mobile-375-zh-dark.png'],
    [375, 'light', 'mobile-375-zh-light.png'],
    [320, 'light', 'mobile-320-zh-light.png'],
  ]) {
    await page.setViewportSize({ width, height: 812 })
    await setTheme(theme)
    await page.waitForTimeout(150)
    await assertNoOverflow(page)
    await saveShot(page, evidence, file, { fullPage: true })
  }
  checks.mobileZeroOverflowAcross375And320 = true
  assert.deepEqual(faults, [])
}, { mkdir: true, newline: true })
