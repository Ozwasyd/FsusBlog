import { roleWithExactName } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { launchIsolatedChromium, restrictBrowserOrigins } from './isolated-browser-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_URL
assert(origin, 'Set the isolated test URL')
const browser = await launchIsolatedChromium()
try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ locale: 'en-US', reducedMotion, viewport: { width: 1280, height: 800 } })
    await restrictBrowserOrigins(context, origin)
    await context.addInitScript(() => {
      window.routeTransitions = []
      window.localeTransitions = []
      window.fallbackFades = []
      const animate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.matches('#page-content, .site-auth-main, .account-workspace-content, main.editor-page, main.canvas-workspace, main.media-page'))
          window.fallbackFades.push({ path: location.pathname, outlet: this.id || this.className || 'route', keyframes, options })
        return animate.call(this, keyframes, options)
      }
      const start = document.startViewTransition?.bind(document)
      if (typeof start === 'function') {
        document.startViewTransition = function (cb) {
          const kind = document.documentElement.dataset.fsusblogTransitioning ?? ''
          const fromPath = location.pathname
          const entry = { kind, fromPath, toPath: '', loadingSeen: false, finished: false }
          if (kind === 'route-crossfade') window.routeTransitions.push(entry)
          else if (kind === 'locale-switch') window.localeTransitions.push(entry)
          const transition = start(async () => {
            await cb()
            entry.toPath = location.pathname
            const status = document.querySelector('#page-content [role="status"], .site-auth-main [role="status"]')
            entry.loadingSeen = Boolean(status && /loading|checking|正在加载|正在检查/i.test(status.textContent ?? ''))
          })
          transition.finished.finally(() => { entry.finished = true })
          return transition
        }
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
    await page.getByRole('button', { name: 'Interface language' }).filter({ visible: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.routeTransitions), [])
    assert.deepEqual(await page.evaluate(() => window.fallbackFades), [])
    await page.evaluate(() => { window.initialHeader = document.querySelector('header'); window.initialOutlet = document.querySelector('#page-content') })

    const nav = page.locator('header').getByRole('link')
    await nav.filter({ hasText: /^Archive$/ }).click()
    await page.waitForURL(origin + '/archive')
    await roleWithExactName(page, 'heading', 'Archive').waitFor()
    await nav.filter({ hasText: /^About$/ }).click()
    await page.waitForURL(origin + '/about')
    await roleWithExactName(page, 'heading', 'About').waitFor()
    await page.goBack()
    await page.waitForURL(origin + '/archive')
    await roleWithExactName(page, 'heading', 'Archive').waitFor()
    if (reducedMotion === 'no-preference') {
      await page.waitForFunction(() => window.routeTransitions.length === 3 && window.routeTransitions.every(t => t.finished))
    }

    const transitions = await page.evaluate(() => window.routeTransitions)
    assert.deepEqual(transitions.map(t => t.toPath), reducedMotion === 'reduce' ? [] : ['/archive', '/about', '/archive'])
    for (const t of transitions) {
      assert.equal(t.loadingSeen, false, `Expected prefetched content ready before snapshot on ${t.toPath}`)
    }
    assert.deepEqual(await page.evaluate(() => window.fallbackFades), [])
    assert.deepEqual(docs, [origin + '/'])
    assert.equal(await page.evaluate(() => window.initialHeader === document.querySelector('header') && window.initialOutlet === document.querySelector('#page-content')), true)

    await page.locator('.site-locale-menu button').click()
    await roleWithExactName(page, 'menuitem', '中文').click()
    await roleWithExactName(page, 'heading', '归档').waitFor()
    assert.deepEqual(await page.evaluate(() => window.routeTransitions), transitions)
    if (reducedMotion === 'no-preference') {
      await page.waitForFunction(() => window.localeTransitions.length === 1 && window.localeTransitions[0].finished)
    } else {
      assert.equal(await page.evaluate(() => window.localeTransitions.length), 0)
    }

    await nav.filter({ hasText: /^登录$/ }).click()
    await page.waitForURL(origin + '/login')
    await page.locator('.site-auth-main h1').waitFor()
    const authPaths = ['/login']
    if (process.env.FSUSBLOG_TEST_AUTH_TRANSITIONS === '1') {
      await page.evaluate(() => { window.authHeader = document.querySelector('header.site-auth-header') })
      await roleWithExactName(page, 'link', '创建读者账户').click()
      await page.waitForURL(origin + '/register')
      await roleWithExactName(page, 'heading', '创建读者账户').waitFor()
      assert.equal(await page.evaluate(() => window.authHeader === document.querySelector('header.site-auth-header')), true)
      await page.goBack()
      await page.waitForURL(origin + '/login')
      assert.equal(await page.evaluate(() => window.authHeader === document.querySelector('header.site-auth-header')), true)
      authPaths.push('/register', '/login')
    }
    await roleWithExactName(page, 'link', '取消').click()
    await page.waitForURL(origin + '/')
    const expectedMore = reducedMotion === 'reduce' ? [] : [...authPaths, '/']
    if (expectedMore.length) {
      await page.waitForFunction(count => window.routeTransitions.length === count && window.routeTransitions.every(t => t.finished), transitions.length + expectedMore.length)
    }
    const moreTransitions = await page.evaluate(start => window.routeTransitions.slice(start), transitions.length)
    assert.deepEqual(moreTransitions.map(t => t.toPath), expectedMore)
    for (const t of moreTransitions) {
      assert.equal(t.loadingSeen, false, `Expected auth/public content ready before snapshot on ${t.toPath}`)
    }
    assert.deepEqual(await page.evaluate(() => window.fallbackFades), [])
    assert.equal(await page.evaluate(() => document.documentElement.dataset.fsusblogTransitioning ?? null), null)
    assert.deepEqual(docs, [origin + '/'])
    assert.deepEqual(errors, [])
    await context.close()
  }

  // Verify pure-opacity fallback when document.startViewTransition is unavailable
  {
    const context = await browser.newContext({ locale: 'en-US', reducedMotion: 'no-preference', viewport: { width: 1280, height: 800 } })
    await restrictBrowserOrigins(context, origin)
    await context.addInitScript(() => {
      Object.defineProperty(document, 'startViewTransition', { value: undefined, configurable: true, writable: true })
      window.fallbackFades = []
      const animate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        if (this.matches('#page-content, .site-auth-main'))
          window.fallbackFades.push({ path: location.pathname, outlet: this.id || 'auth', keyframes, options })
        return animate.call(this, keyframes, options)
      }
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    await page.locator('.el-public-shell').waitFor()
    assert.deepEqual(await page.evaluate(() => window.fallbackFades), [])
    await page.locator('header').getByRole('link').filter({ hasText: /^Archive$/ }).click()
    await page.waitForURL(origin + '/archive')
    await roleWithExactName(page, 'heading', 'Archive').waitFor()
    const fades = await page.evaluate(() => window.fallbackFades)
    assert.equal(fades.length, 1)
    assert.equal(fades[0].path, '/archive')
    assert.equal(fades[0].options.duration, 220)
    assert.deepEqual(fades[0].keyframes, [{ opacity: 0 }, { opacity: 1 }])
    assert.deepEqual(errors, [])
    await context.close()
  }
} finally { await browser.close() }
console.log('Verified data-ready View Transition route crossfades, browser Back, stable headers, fallback opacity fade, no reload and reduced-motion support.')
