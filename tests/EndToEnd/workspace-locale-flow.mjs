import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const origin = process.env.FSUSBLOG_TEST_URL
const ticket = process.env.FSUSBLOG_TEST_TICKET
const adminOrigin = process.env.FSUSBLOG_TEST_ADMIN_URL
assert(origin && ticket, 'Use an isolated test server and a synthetic author ticket')

const tools = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = tools('@playwright/test')
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, args: ['--no-proxy-server'] })
try {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 860 } })
  await context.route('**/*', route => [origin, adminOrigin].filter(Boolean).some(url => route.request().url().startsWith(url + '/')) ? route.continue() : route.abort())
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
  await page.goto(origin + '/login')
  await page.getByLabel('Owner access key').fill(ticket)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await page.waitForURL(origin + '/user/manage/article/write')
  await page.getByRole('heading', { name: 'New article', exact: true }).waitFor()
  assert.ok(localeCatalogRequests.length > 0, 'The editor should load its own translations')

  await page.goto(origin + '/user/manage/canvas')
  const selector = page.getByRole('combobox', { name: 'Interface language' }).filter({ visible: true })
  await page.getByRole('button', { name: 'New Canvas', exact: true }).click()
  const entry = page.locator('#canvas-name')
  const original = 'Original title 画布 test'
  await entry.fill(original)
  // A modal traps keyboard focus; activate the page preference programmatically without dismissing it.
  await selector.evaluate(select => {
    select.value = 'zh-CN'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.getByRole('dialog', { name: '新建画布', exact: true }).waitFor()
  assert.equal(await entry.inputValue(), original)
  await page.getByRole('dialog', { name: '新建画布' }).getByRole('button', { name: '取消', exact: true }).click()
  await page.reload()
  await page.getByRole('heading', { name: '画布列表', exact: true }).waitFor()
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')

  if (adminOrigin) {
    // The test uses the separate, explicitly configured administrator origin.
    await page.goto(adminOrigin + '/admin/identity')
    const chooser = page.locator('.admin-language select')
    await chooser.waitFor()
    await chooser.selectOption('zh-CN')
    await page.getByRole('heading', { name: '管理员访问', exact: true }).waitFor()
    assert.match(await page.title(), /^管理员访问/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await chooser.selectOption('en')
    await page.getByRole('heading', { name: 'Administrator access', exact: true }).waitFor()
    assert.match(await page.title(), /^Administrator access/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  }
  assert.deepEqual(errors, [])
  await context.close()
} finally { await browser.close() }
console.log('Workspace translations loaded on demand; author editor, Canvas dialog state, language persistence, and optional admin origin verified.')
