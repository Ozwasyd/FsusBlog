import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { sha256Hex } from './admin-workspace-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { roleWithExactName } from './role-locators.mjs'

const origin = process.env.FSUSBLOG_TEST_URL
const expire = process.env.FSUSBLOG_TEST_APPEARANCE_EXPIRY
assert(origin && expire, 'Supply a native v2 server with the signed theme and font test fixture.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/appearance')
const browser = await isolated.launchChrome()
const failures = [], tests = []

await isolated.withBrowserEvidence(browser, evidence, 'browser-result.json', () => ({ tests, expired: true, failures }), async () => {
  for (const profile of [{ width: 1280, height: 800, colorScheme: 'light' }, { width: 375, height: 850, colorScheme: 'dark' }]) {
    const { width, height, colorScheme } = profile
    const page = await browser.newPage({ baseURL: origin, viewport: { width, height }, colorScheme, locale: 'en-US' })
    page.on('pageerror', error => failures.push(error.message))
    page.on('console', event => { if (/Failed to decode downloaded font|OTS parsing error/.test(event.text())) failures.push(event.text()) })
    const fontLoaded = page.waitForResponse(r => /\/site-appearance\/font\/\w{64}\.woff2$/.test(r.url()))
    await page.goto(origin)
    await roleWithExactName(page, 'heading', 'Latest posts').waitFor()
    const font = await fontLoaded
    assertStatus(font, 200)
    assert.equal(font.headers()['content-type'], 'font/woff2')
    assert.equal(font.headers()['cache-control'], 'no-store')
    assert.equal(font.headers()['x-content-type-options'], 'nosniff')
    assert(font.url().endsWith(`/${sha256Hex(await font.body())}.woff2`))
    const href = await page.locator('link[href^="/site-appearance/"]').getAttribute('href')
    assert(href)
    const css = await page.request.get(href)
    assertStatus(css, 200)
    assert.equal(css.headers()['cache-control'], 'no-store')
    assert.equal(css.headers()['x-content-type-options'], 'nosniff')
    assert(href.endsWith(`/${sha256Hex(await css.body())}.css`))
    const appearance = await page.evaluate(async () => {
      const [loaded] = await document.fonts.load('400 16px FsusBlogSiteFont', 'Latest articles')
      const css = getComputedStyle(document.documentElement)
      return {
        action: css.getPropertyValue('--fsus-color-action-primary').trim(),
        primary: css.getPropertyValue('--el-color-primary').trim(),
        font: css.fontFamily,
        fontStatus: loaded?.status,
      }
    })
    assert.equal(appearance.action, colorScheme === 'light' ? '#225533' : '#99eeaa')
    assert.equal(appearance.primary, appearance.action)
    assert.match(appearance.font, /^FsusBlogSiteFont,/)
    assert.equal(appearance.fontStatus, 'loaded')
    assertStatus(await page.request.get('/site-appearance/appearance.json'), 404)
    assertStatus(await page.request.get(href.replace(/[0-9a-f]{64}/, '0'.repeat(64))), 404)
    await isolated.saveShot(page, evidence, `${colorScheme}-${width}.png`, {})
    tests.push({ profile, appearance, css: href, font: new URL(font.url()).pathname })
    await page.close()
  }
  const wait = Date.parse(expire) - Date.now() + 600
  assert(wait < 30000, 'Use a near-term fixture cutoff.')
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  const page = await browser.newPage({ baseURL: origin, locale: 'en-US' })
  await page.goto(origin)
  await roleWithExactName(page, 'heading', 'Latest posts').waitFor()
  assertStatus(await page.request.get(tests[0].css), 404)
  assertStatus(await page.request.get(tests[0].font), 404)
  assert(!await page.evaluate(() => getComputedStyle(document.documentElement).fontFamily.includes('FsusBlogSiteFont')))
  assert.deepEqual(failures, [])
}, { mkdir: true })
