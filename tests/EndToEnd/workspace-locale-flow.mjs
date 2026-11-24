import assert from 'node:assert/strict'
import { launchIsolatedChromium, restrictBrowserOrigins } from './isolated-browser-fixture.mjs'
import { exactButton, exactLabel, roleWithExactName } from './role-locators.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_URL
const bootstrap = process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP
const adminOrigin = process.env.FSUSBLOG_TEST_ADMIN_URL
assert(origin && bootstrap, 'Use an isolated test server and a synthetic administrator invitation')

async function chooseLanguage(page, currentLabel, option, language) {
  await exactButton(page, currentLabel).click()
  await roleWithExactName(page, 'menuitem', option).click()
  await page.waitForFunction(value => document.documentElement.lang === value, language)
}

const browser = await launchIsolatedChromium()
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } })
  await restrictBrowserOrigins(context, origin, adminOrigin)
  const page = await context.newPage()
  const errors = []
  const localeCatalogRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', req => {
    if (/\/assets\/workspace-locales-[^/]+\.js$/.test(req.url())) localeCatalogRequests.push(req.url())
  })
  await page.goto(origin)
  await page.locator('.site-footer').waitFor()
  assert.deepEqual(localeCatalogRequests, [], 'Public pages must not load workspace copy')
  assert.equal(await page.locator('.site-footer strong').count(), 1)
  assert.doesNotMatch(await page.locator('.site-footer p').textContent(), /FsusBlog · 本地演示/)
  await signInFreshAdmin(page, origin, bootstrap)
  await page.goto(origin + '/admin/articles/write')
  await roleWithExactName(page, 'heading', 'New article').waitFor()
  assert.ok(localeCatalogRequests.length > 0, 'Opening an authenticated workspace should load its translations')

  await page.goto(origin + '/admin/canvas')
  await exactButton(page, 'New Canvas').click()
  const entry = exactLabel(page, /^(Canvas title|画布标题)$/)
  const original = 'Original title 画布 test'
  await entry.fill(original)
  // Canvas has no language control. Change the shared preference from the public shell,
  // then exercise the browser's persisted-page notification without dismissing the dialog.
  const preferences = await context.newPage()
  try {
    await preferences.goto(origin)
    await chooseLanguage(preferences, 'Interface language', '中文', 'zh-CN')
  } finally {
    await preferences.close()
  }
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await roleWithExactName(page, 'dialog', '新建画布').waitFor()
  assert.equal(await entry.inputValue(), original)
  await exactButton(page.getByRole('dialog', { name: '新建画布' }), '取消').click()
  await page.reload()
  await roleWithExactName(page, 'heading', '画布列表').waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')

  if (adminOrigin) {
    // The test uses the separate, explicitly configured administrator origin.
    await context.addCookies([{ name: 'fsus_locale', value: 'en', url: adminOrigin }])
    await page.goto(adminOrigin + '/admin/identity')
    await chooseLanguage(page, 'Interface language', '中文', 'zh-CN')
    await roleWithExactName(page, 'heading', '管理员访问').waitFor()
    assert.match(await page.title(), /^管理员访问/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await chooseLanguage(page, '界面语言', 'EN', 'en')
    await roleWithExactName(page, 'heading', 'Administrator access').waitFor()
    assert.match(await page.title(), /^Administrator access/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    console.log('Separate administrator origin language switch verified.')
  }
  assert.deepEqual(errors, [])
  await context.close()
} finally { await browser.close() }
console.log('Verified lazy workspace translations, Canvas dialog input preservation, and language persistence.')
