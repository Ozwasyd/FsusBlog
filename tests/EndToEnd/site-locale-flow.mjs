import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const origin = process.env.FSUSBLOG_TEST_URL
assert(origin, 'Set the isolated test URL')
const accept = { 'Accept-Language': 'fr, en-US;q=0.8, zh-CN;q=0.4' }
const zh = { ...accept, Cookie: 'fsus_locale=zh-CN' }
const locales = [[accept, 'en'], [zh, 'zh-CN']]

for (const path of ['/', '/archive', '/search', '/login', '/about']) {
  const responses = await Promise.all(locales.map(([headers]) => fetch(origin + path, { headers })))
  for (const [i, response] of responses.entries()) {
    assert.equal(response.status, 200)
    const language = locales[i][1]
    assert.equal(response.headers.get('content-language'), language)
    assert.match(response.headers.get('vary') ?? '', /\bcookie\b/i)
    assert.match(response.headers.get('vary') ?? '', /\baccept-language\b/i)
    const html = await response.text()
    assert.ok(html.includes(`<html lang="${language}">`), `${path}: the initial document should use ${language}`)
    assert.ok(html.includes(`name="fsus-locale" content="${language}"`))
    if (path === '/login') {
      assert.match(response.headers.get('cache-control'), /no-store/)
      assert.doesNotMatch(html, /id="owner-key"/)
    }
  }
  if (path === '/about') {
    const englishTag = responses[0].headers.get('etag')
    const chineseTag = responses[1].headers.get('etag')
    assert.ok(englishTag && chineseTag && englishTag !== chineseTag)
    assert.equal((await fetch(origin + path, { headers: { ...zh, 'If-None-Match': englishTag } })).status, 200)
  }
}
const fallback = await fetch(origin + '/login', { headers: { 'Accept-Language': 'fr-CA, en;q=0' } })
assert.equal(fallback.headers.get('content-language'), 'zh-CN')

const wire = await Promise.all(locales.map(([headers]) => fetch(origin + '/api/binary/system/page/about', { headers })))
assert.ok(wire.every(response => response.ok))
assert.deepEqual(await wire[0].arrayBuffer(), await wire[1].arrayBuffer())

const tools = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = tools('@playwright/test')
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, args: ['--no-proxy-server'] })
try {
  for (const width of [1280, 375, 320]) {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width, height: 800 }, serviceWorkers: 'block' })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    const page = await context.newPage()
    const errors = []
    const docs = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.isNavigationRequest() && request.resourceType() === 'document') docs.push(request.url())
    })
    await page.goto(origin + '/login')
    const selector = page.locator('.site-auth-header .site-locale-menu button')
    const key = page.locator('#owner-key')
    await page.getByRole('heading', { name: 'Log in', exact: true }).waitFor()
    await key.fill('test-value-never-submitted')
    await selector.click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    await page.getByRole('heading', { name: '登录', exact: true }).waitFor()
    assert.match(await page.title(), /^登录/)
    assert.equal(await key.inputValue(), 'test-value-never-submitted')
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await page.locator('.site-auth-brand').click()
    await page.waitForURL(origin + '/')
    assert.equal(docs.length, 1)
    if (width < 500) await page.getByText('菜单', { exact: true }).click()
    const chineseNav = page.getByRole('link', { name: '归档', exact: true }).filter({ visible: true })
    await chineseNav.click()
    await page.waitForURL(origin + '/archive')
    await page.getByRole('heading', { name: '归档', exact: true }).waitFor()
    assert.equal(docs.length, 1)

    const response = await page.reload()
    assert.equal(response.headers()['content-language'], 'zh-CN')
    await page.getByRole('heading', { name: '归档', exact: true }).waitFor()
    if (width < 500) await page.getByText('菜单', { exact: true }).click()
    const languageControl = page.getByRole('combobox', { name: '界面语言' }).filter({ visible: true })
    if (width < 500) {
      const themeControl = page.getByRole('combobox', { name: '主题', exact: true }).filter({ visible: true })
      await themeControl.waitFor()
      const [languageBox, themeBox] = await Promise.all([languageControl.boundingBox(), themeControl.boundingBox()])
      assert.ok(languageBox && themeBox)
      assert.ok(Math.abs(languageBox.y - themeBox.y) <= 1)
      assert.ok(Math.abs(languageBox.height - themeBox.height) <= 1)
      assert.ok(languageBox.x + languageBox.width < themeBox.x)
      assert.ok(themeBox.x + themeBox.width <= width)
      assert.equal(await themeControl.locator('option[value=system]').textContent(), '跟随系统')
      await themeControl.selectOption('dark')
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
    }
    if (width < 500) await languageControl.selectOption('en')
    else {
      await page.locator('.site-locale-menu button').click()
      await page.getByRole('menuitem', { name: 'EN', exact: true }).click()
    }
    if (width < 500) {
      const themeControl = page.getByRole('combobox', { name: 'Theme mode', exact: true }).filter({ visible: true })
      assert.equal(await themeControl.inputValue(), 'dark')
      assert.equal(await themeControl.locator('option[value=system]').textContent(), 'System')
      await themeControl.selectOption('system')
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
    }
    await page.getByRole('heading', { name: 'Archive', exact: true }).waitFor()
    assert.match(await page.title(), /^Archive/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.goto(origin + '/about')
    await page.getByRole('heading', { name: 'About', exact: true }).waitFor()
    assert.equal(await page.locator('[data-site-page-body]').getAttribute('lang'), 'zh-CN')
    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
    if (process.env.FSUSBLOG_TEST_EVIDENCE)
      await page.screenshot({ path: `${process.env.FSUSBLOG_TEST_EVIDENCE}/site-locale-${width}.png` })
    await context.close()
  }
} finally { await browser.close() }
console.log('Verified zh-CN/en server variants, cookie preference, reload, responsive navigation, page language and preserved login input.')
