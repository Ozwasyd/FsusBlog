import assert from 'node:assert/strict'
import * as isolated from './isolated-browser-fixture.mjs'
import * as loc from './role-locators.mjs'

const origin = process.env.FSUSBLOG_TEST_URL
assert(origin, 'Set the isolated test URL')
const accept = { 'Accept-Language': 'fr, en-US;q=0.8, zh-CN;q=0.4' }
const zh = { ...accept, Cookie: 'fsus_locale=zh-CN' }
const locales = [[accept, 'en'], [zh, 'zh-CN']]
const visibleGroup = (target, name) => loc.roleWithExactName(target, 'radiogroup', name).filter({ visible: true })

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

const browser = await isolated.launchIsolatedChromium()
try {
  for (const width of [1280, 375, 320]) await verifyWidth(width)
} finally { await browser.close() }
console.log('Verified zh-CN/en server variants, cookie preference, reload, responsive navigation, theme sync and foreground reconciliation, page language and no ticket input on the login page.')

async function verifyWidth(width) {
  const narrow = width < 500
  const options = { locale: 'en-US', viewport: { width, height: 800 }, serviceWorkers: 'block' }
  await isolated.withTempContext(browser, options, async context => {
    await isolated.restrictBrowserOrigins(context, origin)
    const page = await context.newPage()
    const errors = []
    const docs = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.isNavigationRequest() && request.resourceType() === 'document') docs.push(request.url())
    })
    await page.goto(origin + '/login')
    await loc.exactHeading(page, 'Log in').waitFor()
    await loc.exactButton(page, 'Log in with Passkey').waitFor()
    assert.equal(await page.locator('main input[type=password]').count(), 0)
    await page.locator('.site-auth-header .site-locale-menu button').click()
    await loc.exactMenuItem(page, '中文').click()
    await loc.exactHeading(page, '登录').waitFor()
    assert.match(await page.title(), /^登录/)
    assert.equal(await page.locator('main input[type=password]').count(), 0)
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    await page.locator('.site-auth-brand').click()
    await page.waitForURL(origin + '/')
    assert.equal(docs.length, 1)
    if (narrow) await loc.exactText(page, '菜单').click()
    await loc.exactLink(page, '归档').filter({ visible: true }).click()
    await page.waitForURL(origin + '/archive')
    await loc.exactHeading(page, '归档').waitFor()
    assert.equal(docs.length, 1)

    const response = await page.reload()
    assert.equal(response.headers()['content-language'], 'zh-CN')
    await loc.exactHeading(page, '归档').waitFor()
    if (narrow) await loc.exactText(page, '菜单').click()
    const languageControl = visibleGroup(page, '界面语言')
    if (narrow) {
      const themeControl = visibleGroup(page, '主题')
      await themeControl.waitFor()
      const [languageBox, themeBox] = await Promise.all([languageControl.boundingBox(), themeControl.boundingBox()])
      assert.ok(languageBox && themeBox)
      assert.ok(Math.abs(languageBox.x - themeBox.x) <= 1)
      assert.ok(Math.abs(languageBox.width - themeBox.width) <= 1)
      assert.ok(languageBox.height >= 44 && languageBox.height <= 50)
      assert.ok(themeBox.height >= 44 && themeBox.height <= 50)
      assert.ok(languageBox.y + languageBox.height < themeBox.y)
      assert.ok(themeBox.x + themeBox.width <= width)
      await loc.exactText(themeControl, '跟随系统').waitFor()
      await loc.exactText(themeControl, '深色').click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'dark')
    }
    if (narrow) await loc.exactText(languageControl, 'EN').click()
    else {
      await page.locator('.site-locale-menu button').click()
      await loc.exactMenuItem(page, 'EN').click()
    }
    if (narrow) {
      const themeControl = visibleGroup(page, 'Theme mode')
      assert.equal(await loc.exactRadio(themeControl, 'Dark').isChecked(), true)
      await loc.exactText(themeControl, 'System').click()
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
    }
    await loc.exactHeading(page, 'Archive').waitFor()
    assert.match(await page.title(), /^Archive/)
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    await isolated.assertNoOverflow(page)
    await page.goto(origin + '/about')
    await loc.exactHeading(page, 'About').waitFor()
    assert.equal(await page.locator('[data-site-page-body]').getAttribute('lang'), 'zh-CN')
    const footerLayout = await page.evaluate(() => {
      const footer = document.querySelector('.site-footer').getBoundingClientRect()
      const brand = document.querySelector('.site-footer-brand').getBoundingClientRect()
      const topLink = document.querySelector('.site-footer-top')
      const top = topLink.getBoundingClientRect()
      const policyNav = document.querySelector('nav.site-policy-links')
      const policyLinks = [...policyNav.querySelectorAll('a')]
      const firstPolicy = policyLinks[0].getBoundingClientRect()
      return {
        topInsidePolicyNav: policyNav.contains(topLink), policyCount: policyLinks.length,
        brandX: brand.x, brandMidY: brand.y + brand.height / 2,
        topX: top.x, topRight: top.right, topMidY: top.y + top.height / 2, topHeight: top.height,
        firstPolicyX: firstPolicy.x, firstPolicyHeight: firstPolicy.height, footerRight: footer.right,
      }
    })
    assert.equal(footerLayout.topInsidePolicyNav, false)
    assert.equal(footerLayout.policyCount, 4)
    assert.ok(Math.abs(footerLayout.topRight - footerLayout.footerRight) <= 1)
    assert.ok(Math.abs(footerLayout.brandMidY - footerLayout.topMidY) <= 4)
    if (narrow) {
      assert.ok(Math.abs(footerLayout.firstPolicyX - footerLayout.brandX) <= 1)
      assert.ok(footerLayout.topHeight >= 44 && footerLayout.firstPolicyHeight >= 44)
    }

    const peer = await context.newPage()
    peer.on('pageerror', error => errors.push(error.message))
    await peer.goto(origin + '/')
    await peer.waitForFunction(() => document.documentElement.dataset.themeMode === 'system')
    if (narrow) {
      await loc.exactText(page, 'Menu').click()
      await loc.exactText(peer, 'Menu').click()
    }
    const selectPageTheme = async label => {
      if (narrow) await loc.exactText(visibleGroup(page, 'Theme mode'), label).click()
      else {
        await page.locator('.site-theme-menu button').click()
        await loc.exactMenuItem(page, label).click()
      }
    }
    const assertPeerTheme = async (mode, label, resolved) => {
      await peer.waitForFunction(({ expectedMode, expectedResolved }) => {
        const root = document.documentElement
        return root.dataset.themeMode === expectedMode && root.dataset.themeResolved === expectedResolved && root.style.colorScheme === expectedResolved
      }, { expectedMode: mode, expectedResolved: resolved })
      assert.deepEqual(await peer.evaluate(() => ({
        dark: document.documentElement.classList.contains('dark'),
        light: document.documentElement.classList.contains('light'),
      })), { dark: mode === 'dark', light: mode === 'light' })
      if (narrow) assert.equal(await loc.exactRadio(visibleGroup(peer, 'Theme mode'), label).isChecked(), true)
      else assert.equal((await peer.locator('.site-theme-menu button').textContent())?.trim(), label)
    }
    await selectPageTheme('Dark')
    await assertPeerTheme('dark', 'Dark', 'dark')
    await selectPageTheme('Light')
    await assertPeerTheme('light', 'Light', 'light')
    await selectPageTheme('System')
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
      const root = document.documentElement
      let changes = 0
      const onThemeChange = () => { changes += 1 }
      const measure = (target, name, dirty) => {
        const before = changes
        if (dirty) root.dataset.themeResolved = root.style.colorScheme = 'dark'
        target.dispatchEvent(new Event(name))
        return changes - before
      }
      root.addEventListener('fsus:theme-change', onThemeChange)
      const result = {
        noopChanges: measure(window, 'focus', false),
        pageshowChanges: measure(window, 'pageshow', true),
        visibilityChanges: measure(document, 'visibilitychange', true),
        resolved: root.dataset.themeResolved, colorScheme: root.style.colorScheme,
        hasDarkClass: root.classList.contains('dark'),
      }
      root.removeEventListener('fsus:theme-change', onThemeChange)
      return result
    })
    assert.deepEqual(reconciledOnResume, {
      noopChanges: 0, pageshowChanges: 1, visibilityChanges: 1,
      resolved: 'light', colorScheme: 'light', hasDarkClass: false,
    })
    if (narrow) {
      await loc.exactText(page, 'Menu').click()
      await loc.roleWithExactName(page, 'radiogroup', 'Theme mode').waitFor({ state: 'hidden' })
    }
    await peer.close()

    assert.equal(await page.locator('vite-error-overlay').count(), 0)
    assert.deepEqual(errors, [])
    const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
    if (evidence) await isolated.saveShot(page, evidence, `site-locale-${width}.png`, {})
  })
}
