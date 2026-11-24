import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSeoConfig, decodeSiteComplianceConfig } from '../../src/Contracts/site-config.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { exactText } from './role-locators.mjs'
import { launchIdentityBrowser } from './site-authentication-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_SITE_URL ?? process.env.FSUSBLOG_TEST_URL
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(origin && evidence, 'Use an isolated v2 server with the test configuration and a new evidence directory.')
const started = new Date().toISOString()
const read = async (path, type, decode) => {
  const response = await fetch(new URL(path, origin), { redirect: 'error' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream')
  return decode(decodeFrame(new Uint8Array(await response.arrayBuffer()), type).payload)
}
const seo = await read(WireRoutes.PublicSeo, FrameType.SeoConfig, decodeSeoConfig)
const legal = await read(WireRoutes.PublicCompliance, FrameType.SiteComplianceConfig, decodeSiteComplianceConfig)
assert.equal(seo.title, 'North & <South>')
assert.equal(seo.baseUrl, process.env.FSUSBLOG_TEST_SITE_URL ?? 'https://blog.example.test')
assert.equal(legal.enabled, true)
assert.equal(legal.icpRecordNumber, 'Fixture registration')
assert.equal(legal.contactEmail, 'info@example.test')
const viewport = { width: 375, height: 812 }
const browser = await launchIdentityBrowser(process.env.FSUSBLOG_TEST_TLS_SPKI)

await withBrowserEvidence(
  browser,
  evidence,
  'result.json',
  () => ({
    started, finished: new Date().toISOString(), browser: browser.version(), viewport,
    completed: ['seo and compliance AEDS frames', 'same configured title after Vue takeover', 'public compliance footer and safe links', 'SPA path clears original canonical'],
  }),
  async () => {
    const page = await browser.newPage({ viewport, locale: 'en-US' })
    page.setDefaultTimeout(15_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    assertStatus(await page.goto(origin, { waitUntil: 'domcontentloaded' }), 200)
    const footer = page.locator('.site-footer')
    await exactText(footer.locator('strong'), 'North & <South>').waitFor()
    await footer.locator('p').getByText(/North Company/).waitFor()
    assert.equal(await page.title(), seo.title)
    assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), seo.baseUrl + '/')
    for (const [name, href] of [
      ['Fixture registration', 'https://beian.miit.gov.cn/'],
      ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
      ['info@example.test', 'mailto:info@example.test'],
    ]) assert.equal(await footer.getByRole('link', { name }).getAttribute('href'), href)
    await footer.scrollIntoViewIfNeeded()
    await saveShot(page, evidence, 'public-site-config-mobile.png', { fullPage: true })
    await footer.getByRole('link', { name: 'About' }).click()
    await page.waitForURL(new URL('/about', origin).href)
    assert.equal(await page.locator('link[rel="canonical"]').count(), 0)
    assert.equal(await page.title(), `About · ${seo.title}`)
    assert.deepEqual(errors, [])
  },
  { mkdir: true, newline: true },
)
