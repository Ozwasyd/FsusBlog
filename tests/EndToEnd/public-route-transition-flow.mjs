import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const origin = process.env.FSUSBLOG_TEST_URL
assert(origin, 'Set the isolated test URL')
const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, args: ['--no-proxy-server'] })
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ locale: 'en-US', reducedMotion, viewport: { width: 1280, height: 800 } })
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await context.addInitScript(() => {
      window.routeFades = []
      const animate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.id === 'page-content') window.routeFades.push({ path: location.pathname, keyframes, options })
        return animate.call(this, keyframes, options)
      }
    })
    const page = await context.newPage()
    const errors = [], docs = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.isNavigationRequest() && request.resourceType() === 'document') docs.push(request.url())
    })
    await page.goto(origin)
    await page.locator('.el-public-shell').waitFor()
    await page.getByRole('combobox', { name: 'Interface language' }).filter({ visible: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.routeFades), [])
    await page.evaluate(() => { window.initialHeader = document.querySelector('header'); window.initialOutlet = document.querySelector('#page-content') })

    const nav = page.locator('header').getByRole('link')
    await nav.filter({ hasText: /^Archive$/ }).click()
    await page.waitForURL(origin + '/archive')
    await page.getByRole('heading', { name: 'Archive', exact: true }).waitFor()
    await nav.filter({ hasText: /^About$/ }).click()
    await page.waitForURL(origin + '/about')
    await page.getByRole('heading', { name: 'About', exact: true }).waitFor()
    await page.goBack()
    await page.waitForURL(origin + '/archive')
    await page.getByRole('heading', { name: 'Archive', exact: true }).waitFor()

    const fades = await page.evaluate(() => window.routeFades)
    assert.deepEqual(fades.map(fade => fade.path), reducedMotion === 'reduce' ? [] : ['/archive', '/about', '/archive'])
    for (const fade of fades) {
      assert.equal(fade.options.duration, 250)
      assert.deepEqual(fade.keyframes, [
        { opacity: .18, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ])
    }
    assert.deepEqual(docs, [origin + '/'])
    assert.equal(await page.evaluate(() => window.initialHeader === document.querySelector('header') && window.initialOutlet === document.querySelector('#page-content')), true)

    await page.getByRole('combobox', { name: 'Interface language' }).filter({ visible: true }).selectOption('zh-CN')
    await page.getByRole('heading', { name: '归档', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.routeFades), fades)
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally { await browser.close() }
console.log('Verified content-only public route fades, browser Back, stable header, no reload and reduced-motion support.')
