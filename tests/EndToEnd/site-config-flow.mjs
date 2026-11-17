import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSeoConfig, decodeSiteComplianceConfig } from '../../src/Contracts/site-config.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const requireWeb = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = requireWeb('@playwright/test')
const origin = process.env.FSUSBLOG_TEST_URL
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
assert(origin && evidence, 'Use an isolated v2 server with the test configuration and a new evidence directory.')
const started = new Date().toISOString()
const read = async (path, type, decode) => {
  const response = await fetch(new URL(path, origin), { redirect: 'error' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream')
  const frame = decodeFrame(new Uint8Array(await response.arrayBuffer()))
  assert.equal(frame.type, type)
  return decode(frame.payload)
}
const seo = await read(WireRoutes.PublicSeo, FrameType.SeoConfig, decodeSeoConfig)
const legal = await read(WireRoutes.PublicCompliance, FrameType.SiteComplianceConfig, decodeSiteComplianceConfig)
assert.equal(seo.title, 'North & <South>')
assert.equal(seo.baseUrl, 'https://blog.example.test')
assert.equal(legal.enabled, true)
assert.equal(legal.icpRecordNumber, 'Fixture registration')
assert.equal(legal.contactEmail, 'info@example.test')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
try {
  const viewport = { width: 375, height: 812 }
  const page = await browser.newPage({ viewport, locale: 'en-US' })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto(origin, { waitUntil: 'domcontentloaded' })
  assert.equal(response.status(), 200)
  await page.locator('footer').getByText('North & <South>', { exact: true }).first().waitFor()
  const footer = page.locator('.site-footer')
  await footer.getByText('North Company', { exact: false }).waitFor()
  assert.equal(await page.title(), seo.title)
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), 'https://blog.example.test/')
  assert.equal(await footer.getByRole('link', { name: 'Fixture registration' }).getAttribute('href'), 'https://beian.miit.gov.cn/')
  assert.equal(await footer.getByRole('link', { name: 'CC BY 4.0' }).getAttribute('href'), 'https://creativecommons.org/licenses/by/4.0/')
  assert.equal(await footer.getByRole('link', { name: 'info@example.test' }).getAttribute('href'), 'mailto:info@example.test')
  await footer.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, 'public-site-config-mobile.png'), fullPage: true })
  await footer.getByRole('link', { name: 'About' }).click()
  await page.waitForURL(new URL('/about', origin).href)
  assert.equal(await page.locator('link[rel="canonical"]').count(), 0)
  assert.equal(await page.title(), `About · ${seo.title}`)
  assert.deepEqual(errors, [])
  await writeFile(join(evidence, 'result.json'), JSON.stringify({
    started, finished: new Date().toISOString(), browser: browser.version(), viewport,
    completed: ['seo and compliance AEDS frames', 'same configured title after Vue takeover', 'public compliance footer and safe links', 'SPA path clears original canonical'],
  }, null, 2) + '\n')
} finally {
  await browser.close()
}
