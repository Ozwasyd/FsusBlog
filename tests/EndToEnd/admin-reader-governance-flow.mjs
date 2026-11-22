import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertEmptySuccess, expect, launchIdentityBrowser } from './site-authentication-fixture.mjs'
import { signInFreshAdmin, signInFreshSite } from './webauthn-fixture.mjs'
import { exactButton, roleWithExactName } from './role-locators.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'

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
await mkdir(evidence, { recursive: true })
const browser = await launchIdentityBrowser(process.env.FSUSBLOG_TEST_TLS_SPKI)
const checks = {}
const faults = []
let failure

try {
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const readerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await signInFreshSite(await readerContext.newPage(), site.origin, readerTicket)

  // Verify reader session is live before governance action.
  const readerBefore = await readerContext.request.get(site.origin + WireRoutes.Session)
  assert.equal(readerBefore.status(), 200, 'Reader Passkey session must be active before banning.')
  checks.readerSessionInitiallyActive = true

  const page = await adminContext.newPage()
  page.on('pageerror', error => faults.push(error.message))
  await Promise.all([
    ...[WireRoutes.AdminBootstrapComplete, WireRoutes.AdminPasskeyComplete].map(async path => {
      const response = await waitForPathResponse(page, () => path, 'POST')
      await assertEmptySuccess(response, 'Administrator mutation must not be cached.')
    }),
    signInFreshAdmin(page, admin.origin, ticket),
  ])
  await expect(page.locator('.account-workspace')).toBeVisible()
  checks.adminSignedIn = true

  // Navigate to Interaction -> Readers tab.
  await roleWithExactName(page.locator('.account-workspace-nav'), 'link', 'Interaction').click()
  await page.waitForURL(admin.origin + '/admin/interaction')
  const readersTab = roleWithExactName(page, 'tab', 'Readers')
  await expect(readersTab).toBeVisible()
  await readersTab.click()
  await expect(readersTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.readers-list')).toBeVisible()
  await expect(page.getByText(readerDisplay, { exact: true })).toBeVisible()
  await page.screenshot({ path: join(evidence, 'desktop-1280-en-light.png') })
  checks.readersTabLoadsOnDesktop = true

  // Search by keyword and filter by status.
  const searchInput = page.getByLabel('Account name, comment handle, or ID', { exact: true })
  await searchInput.fill(readerName)
  await exactButton(page, 'Search').click()
  await expect(page.locator('.readers-list .el-resource-list-item')).toHaveCount(1)
  await expect(page.getByText(readerDisplay, { exact: true })).toBeVisible()
  checks.keywordSearchWorks = true

  // Open Ban dialog, verify blur validation, then execute real Passkey Step-Up ban.
  await exactButton(page, 'Ban account').click()
  const dialog = roleWithExactName(page, 'dialog', 'Ban reader account')
  await expect(dialog).toBeVisible()
  const reasonBox = dialog.getByLabel('Governance reason', { exact: true })
  await reasonBox.focus()
  await reasonBox.blur()
  await expect(dialog.locator('.readers-validation')).toBeVisible()
  await reasonBox.fill('Repeated automated spam in comments')
  await page.waitForFunction(() => {
    const dlg = document.querySelector('body > .el-overlay .el-dialog')
    return !!dlg && Number.parseFloat(getComputedStyle(dlg).opacity) >= 0.99
  })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(evidence, 'desktop-1280-en-ban-dialog.png') })

  const banResponsePromise = page.waitForResponse(res =>
    res.request().method() === 'POST' && res.url() === admin.origin + WireRoutes.AdminReaderStatusExecute)
  await exactButton(dialog, 'Confirm ban with Passkey').click()
  const banResponse = await banResponsePromise
  assert.equal(banResponse.status(), 200)
  assert((await banResponse.allHeaders())['cache-control']?.includes('no-store'))
  await expect(dialog).toBeHidden()
  await expect(page.getByText('Banned', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/Repeated automated spam in comments/)).toBeVisible()
  checks.banWithPasskeyStepUpSucceeded = true

  // Verify the banned reader's live HTTP session is immediately dead.
  const readerAfterBan = await readerContext.request.get(site.origin + WireRoutes.Session)
  assert.equal(readerAfterBan.status(), 401, 'Banned reader session must be revoked immediately.')
  checks.readerSessionImmediatelyRevoked = true

  // Switch to zh-CN and dark theme on desktop, capture evidence.
  await page.evaluate(() => {
    document.cookie = 'fsus_locale=zh-CN; path=/'
  })
  await page.reload()
  await page.evaluate(() => {
    document.documentElement.dataset.themeMode = 'dark'
    document.documentElement.classList.add('dark')
  })
  await roleWithExactName(page, 'tab', '读者账号').click()
  await expect(page.locator('.readers-list')).toBeVisible()
  await page.waitForTimeout(150)
  await page.screenshot({ path: join(evidence, 'desktop-1280-zh-dark.png') })

  // Filter Disabled in zh-CN, then unban with real Passkey Step-Up.
  await page.locator('.readers-status-group').getByText(/已封禁/).click()
  await expect(page.locator('.readers-list')).toBeVisible()
  const targetCard = page.locator('.readers-list .el-resource-list-item', { hasText: readerDisplay })
  await expect(targetCard).toBeVisible()
  await exactButton(targetCard, '解封账号').click()
  const unbanDialog = roleWithExactName(page, 'dialog', '解封读者账号')
  await expect(unbanDialog).toBeVisible()
  await unbanDialog.getByLabel('治理原因', { exact: true }).fill('复核申诉通过，恢复账号')
  const unbanResponsePromise = page.waitForResponse(res =>
    res.request().method() === 'POST' && res.url() === admin.origin + WireRoutes.AdminReaderStatusExecute)
  await exactButton(unbanDialog, '使用通行密钥确认解封').click()
  assert.equal((await unbanResponsePromise).status(), 200)
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
    await page.evaluate(mode => {
      document.documentElement.dataset.themeMode = mode
      document.documentElement.classList.toggle('dark', mode === 'dark')
    }, theme)
    await page.waitForTimeout(150)
    const overflow = await page.evaluate(() => ({
      pageOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }))
    assert.equal(overflow.pageOverflowX, false, `Horizontal overflow at ${width}px (${theme}): ${JSON.stringify(overflow)}`)
    await page.screenshot({ path: join(evidence, file), fullPage: true })
  }
  checks.mobileZeroOverflowAcross375And320 = true
  assert.deepEqual(faults, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'result.json'), JSON.stringify({
    checks, faults, failure: failure instanceof Error ? failure.message : undefined,
  }, null, 2) + '\n')
}
if (failure) throw failure
