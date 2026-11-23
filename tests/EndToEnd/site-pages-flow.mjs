import assert from 'node:assert/strict'
import { requireWebPackage } from './web-package-fixture.mjs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSitePage, sitePages } from '../../src/Contracts/site-pages.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const origin = process.env.FSUSBLOG_TEST_URL
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(origin && evidence, 'Set the isolated test URL and evidence directory')
await mkdir(evidence, { recursive: true })
const fixture = slug => `Standalone fixture ${slug}`
for (const slug of Object.keys(sitePages)) {
  const [first, head, wire] = await Promise.all([
    fetch(`${origin}/${slug}`),
    fetch(`${origin}/${slug}`, { method: 'HEAD' }),
    fetch(`${origin}/api/binary/system/page/${slug}`),
  ])
  assert.equal(first.status, 200)
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-language'), 'zh-CN')
  assert.equal(head.headers.get('cache-control'), 'no-store')
  assert.equal(await head.text(), '')
  const html = await first.text()
  assert.match(html, new RegExp(`<article[^>]* data-site-page="${slug}" data-state="published">`))
  assert.match(html, new RegExp(fixture(slug)))
  assert.equal(wire.status, 200)
  const packet = decodeFrame(new Uint8Array(await wire.arrayBuffer()), FrameType.PageContent)
  const content = decodeSitePage(packet.payload)
  assert.equal(content.slug, slug)
  assert.match(content.markdown, new RegExp(fixture(slug)))
}
const invalid = await fetch(`${origin}/api/binary/system/page/unrecognized`)
assert.equal(invalid.status, 404)
decodeFrame(new Uint8Array(await invalid.arrayBuffer()), FrameType.ApiError)

const { chromium } = requireWebPackage('@playwright/test')
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
try {
  for (const size of [{ width: 1280, height: 860 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport: size, locale: 'zh-CN', colorScheme: size.width < 500 ? 'dark' : 'light' })
    const errors = []
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('console', msg => {
      if (msg.type() === 'warn' || msg.type() === 'error')
        errors.push({ message: msg.text(), path: new URL(msg.location().url || origin, origin).pathname })
    })
    await page.goto(`${origin}/about`)
    await page.getByRole('heading', { name: '关于', exact: true }).waitFor()
    await page.locator('[data-site-page-body] >> text=Standalone fixture about').waitFor()
    assert.equal(await page.title(), "关于 · Fsu's Blog")
    assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN')
    assert.equal(await page.locator('[data-site-page-body] script, [data-site-page-body] [href^="javascript:"]').count(), 0)
    assert(!(await page.locator('vite-error-overlay').count()))
    await page.getByRole('navigation', { name: '站点政策' }).getByRole('link', { name: '隐私政策' }).click()
    await page.locator('[data-site-page-body] >> text=Standalone fixture privacy').waitFor()
    assert.equal(new URL(page.url()).pathname, '/privacy')
    assert.equal(await page.title(), "隐私政策 · Fsu's Blog")
    assert.equal(await page.locator('meta[name=robots]').count(), 0)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await page.screenshot({ path: resolve(evidence, `site-pages-${size.width}.png`), fullPage: true })
    let failOnce = true
    await page.route('**/guidelines', route => {
      if (!failOnce) return route.continue()
      failOnce = false
      return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Fixture failure' })
    })
    const guidelines = page.getByRole('navigation', { name: '站点政策' }).getByRole('link', { name: '用户守则' })
    await guidelines.focus()
    await page.keyboard.press('Enter')
    await page.getByText('页面内容暂时无法加载').waitFor()
    await page.getByRole('button', { name: '重试' }).click()
    await page.locator('[data-site-page-body] >> text=Standalone fixture guidelines').waitFor()
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(errors.filter(({ message, path }) =>
      !(path === WireRoutes.Session && message.includes('401')) &&
      !(path === WireRoutes.SiteRefreshStatus && message.includes('404')) &&
      !(path === '/guidelines' && message.includes('503')) &&
      !(path === '/favicon.ico' && message.includes('404')),
    ), [])
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('Site pages verified in Chrome at desktop and mobile sizes, with real HTML/HEAD and pinned AEDS.')
