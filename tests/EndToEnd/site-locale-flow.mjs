import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { exactButton, roleWithExactName } from './role-locators.mjs'

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
    assert.ok(html.includes('<meta name="color-scheme" content="light dark">'), `${path}: the initial document should declare light dark color-scheme`)
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
    await roleWithExactName(page, 'heading', 'Log in').waitFor()
    await exactButton(page, 'Log in with Passkey').waitFor()
    assert.equal(await page.locator('main input[type=password]').count(), 0)
    await selector.click()
    await roleWithExactName(page, 'menuitem', '中文').click()
    await roleWithExactName(page, 'heading', '登录').waitFor()
    assert.match(await page.title(), /^登录/)
    assert.equal(await page.locator('main input[type=password]').count(), 0)
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await page.locator('.site-auth-brand').click()
    await page.waitForURL(origin + '/')
    assert.equal(docs.length, 1)
    if (width < 500) await page.getByText('菜单', { exact: true }).click()
    const chineseNav = roleWithExactName(page, 'link', '归档').filter({ visible: true })
    await chineseNav.click()
    await page.waitForURL(origin + '/archive')
    await roleWithExactName(page, 'heading', '归档').waitFor()
    assert.equal(docs.length, 1)

    const response = await page.reload()
    assert.equal(response.headers()['content-language'], 'zh-CN')
    await roleWithExactName(page, 'heading', '归档').waitFor()
    if (width < 500) await page.getByText('菜单', { exact: true }).click()
    const languageControl = roleWithExactName(page, 'radiogroup', '界面语言').filter({ visible: true })
    if (width < 500) {
      const themeControl = roleWithExactName(page, 'radiogroup', '主题').filter({ visible: true })
      await themeControl.waitFor()
      const [languageBox, themeBox] = await Promise.all([languageControl.boundingBox(), themeControl.boundingBox()])
      assert.ok(languageBox && themeBox)
      assert.ok(Math.abs(languageBox.x - themeBox.x) <= 1)
      assert.ok(Math.abs(languageBox.width - themeBox.width) <= 1)
      assert.ok(languageBox.height >= 44 && languageBox.height <= 50)
      assert.ok(themeBox.height >= 44 && themeBox.height <= 50)
      assert.ok(languageBox.y + languageBox.height < themeBox.y)
      assert.ok(themeBox.x + themeBox.width <= width)
      await themeControl.getByText('跟随系统', { exact: true }).waitFor()
      await themeControl.getByText('深色', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
    }
    if (width < 500) await languageControl.getByText('EN', { exact: true }).click()
    else {
      await page.locator('.site-locale-menu button').click()
      await roleWithExactName(page, 'menuitem', 'EN').click()
    }
    if (width < 500) {
      const themeControl = roleWithExactName(page, 'radiogroup', 'Theme mode').filter({ visible: true })
      assert.equal(await roleWithExactName(themeControl, 'radio', 'Dark').isChecked(), true)
      await themeControl.getByText('System', { exact: true }).click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
    }
    await roleWithExactName(page, 'heading', 'Archive').waitFor()
    assert.match(await page.title(), /^Archive/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.goto(origin + '/about')
    await roleWithExactName(page, 'heading', 'About').waitFor()
    assert.equal(await page.locator('[data-site-page-body]').getAttribute('lang'), 'zh-CN')
    const footerLayout = await page.evaluate(() => {
      const footer = document.querySelector('.site-footer')
      const brand = document.querySelector('.site-footer-brand')
      const topLink = document.querySelector('.site-footer-top')
      const policyNav = document.querySelector('nav.site-policy-links')
      const policyLinks = [...policyNav.querySelectorAll('a')]
      const footerRect = footer.getBoundingClientRect()
      const brandRect = brand.getBoundingClientRect()
      const topRect = topLink.getBoundingClientRect()
      const firstPolicyRect = policyLinks[0].getBoundingClientRect()
      return {
        topInsidePolicyNav: policyNav.contains(topLink),
        policyCount: policyLinks.length,
        brandX: brandRect.x,
        brandMidY: brandRect.y + brandRect.height / 2,
        topX: topRect.x,
        topRight: topRect.right,
        topMidY: topRect.y + topRect.height / 2,
        topHeight: topRect.height,
        firstPolicyX: firstPolicyRect.x,
        firstPolicyHeight: firstPolicyRect.height,
        footerRight: footerRect.right,
      }
    })
    assert.equal(footerLayout.topInsidePolicyNav, false)
    assert.equal(footerLayout.policyCount, 4)
    assert.ok(Math.abs(footerLayout.topRight - footerLayout.footerRight) <= 1)
    assert.ok(Math.abs(footerLayout.brandMidY - footerLayout.topMidY) <= 4)
    if (width < 500) {
      assert.ok(Math.abs(footerLayout.firstPolicyX - footerLayout.brandX) <= 1)
      assert.ok(footerLayout.topHeight >= 44 && footerLayout.firstPolicyHeight >= 44)
    }

    const peer = await context.newPage()
    peer.on('pageerror', error => errors.push(error.message))
    await peer.goto(origin + '/')
    await peer.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
    if (width < 500) {
      await page.getByText('Menu', { exact: true }).click()
      await peer.getByText('Menu', { exact: true }).click()
    }
    const selectPageTheme = async (mode, label) => {
      if (width < 500) {
        const control = roleWithExactName(page, 'radiogroup', 'Theme mode').filter({ visible: true })
        await control.getByText(label, { exact: true }).click()
      } else {
        await page.locator('.site-theme-menu button').click()
        await roleWithExactName(page, 'menuitem', label).click()
      }
    }
    const assertPeerTheme = async (mode, label, resolved) => {
      await peer.waitForFunction(({ expectedMode, expectedResolved }) => {
        const root = document.documentElement
        return root.dataset.themeMode === expectedMode
          && root.dataset.themeResolved === expectedResolved
          && root.style.colorScheme === expectedResolved
      }, { expectedMode: mode, expectedResolved: resolved })
      const classes = await peer.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        light: document.documentElement.classList.contains('light'),
      }))
      assert.deepEqual(classes, { dark: mode === 'dark', light: mode === 'light' })
      if (width < 500) {
        const control = roleWithExactName(peer, 'radiogroup', 'Theme mode').filter({ visible: true })
        assert.equal(await roleWithExactName(control, 'radio', label).isChecked(), true)
      } else {
        assert.equal((await peer.locator('.site-theme-menu button').textContent())?.trim(), label)
      }
    }
    await selectPageTheme('dark', 'Dark')
    await assertPeerTheme('dark', 'Dark', 'dark')
    await selectPageTheme('light', 'Light')
    await assertPeerTheme('light', 'Light', 'light')
    await selectPageTheme('system', 'System')
    await assertPeerTheme('system', 'System', 'light')

    await peer.emulateMedia({ colorScheme: 'dark' })
    await assertPeerTheme('system', 'System', 'dark')
    await peer.evaluate(() => {
      document.documentElement.dataset.themeResolved = 'light'
      document.documentElement.style.colorScheme = 'light'
      window.dispatchEvent(new Event('focus'))
    })
    await assertPeerTheme('system', 'System', 'dark')
    await peer.emulateMedia({ colorScheme: 'light' })
    await assertPeerTheme('system', 'System', 'light')
    const reconciledOnResume = await peer.evaluate(() => {
      let changes = 0
      const onThemeChange = () => { changes += 1 }
      document.documentElement.addEventListener('fsus:theme-change', onThemeChange)
      window.dispatchEvent(new Event('focus'))
      const noopChanges = changes
      document.documentElement.dataset.themeResolved = 'dark'
      document.documentElement.style.colorScheme = 'dark'
      window.dispatchEvent(new Event('pageshow'))
      const pageshowChanges = changes - noopChanges
      document.documentElement.dataset.themeResolved = 'dark'
      document.documentElement.style.colorScheme = 'dark'
      document.dispatchEvent(new Event('visibilitychange'))
      const visibilityChanges = changes - noopChanges - pageshowChanges
      document.documentElement.removeEventListener('fsus:theme-change', onThemeChange)
      return {
        noopChanges,
        pageshowChanges,
        visibilityChanges,
        resolved: document.documentElement.dataset.themeResolved,
        colorScheme: document.documentElement.style.colorScheme,
        hasDarkClass: document.documentElement.classList.contains('dark'),
      }
    })
    assert.deepEqual(reconciledOnResume, {
      noopChanges: 0,
      pageshowChanges: 1,
      visibilityChanges: 1,
      resolved: 'light',
      colorScheme: 'light',
      hasDarkClass: false,
    })
    if (width < 500) {
      await page.getByText('Menu', { exact: true }).click()
      await roleWithExactName(page, 'radiogroup', 'Theme mode').waitFor({ state: 'hidden' })
    }
    await peer.close()

    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
    if (process.env.FSUSBLOG_TEST_EVIDENCE)
      await page.screenshot({ path: `${process.env.FSUSBLOG_TEST_EVIDENCE}/site-locale-${width}.png` })
    await context.close()
  }
} finally { await browser.close() }
console.log('Verified zh-CN/en server variants, cookie preference, reload, responsive navigation, theme sync and foreground reconciliation, page language and no ticket input on the login page.')
