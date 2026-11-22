import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { requireWebPackage } from './web-package-fixture.mjs'
import { join } from 'node:path'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { decodeSubscriptionPreferenceRequest, FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium } = requireWebPackage('@playwright/test')
const {
  FSUSBLOG_TEST_SUBSCRIPTION_URL: origin, FSUSBLOG_TEST_SUBSCRIPTION_ISSUE: issuer,
  FSUSBLOG_TEST_EVIDENCE: evidence, FSUSBLOG_TEST_CHROME: executablePath, FSUSBLOG_TEST_TLS_SPKI: pin,
} = process.env
assert(origin && issuer && evidence, 'Provide the isolated subscription origin, offline fixture issuer and evidence directory.')
assert(/^https:\/\//u.test(origin))
assert(!pin || /^[A-Za-z0-9+/]{43}=$/u.test(pin))
const url = new URL('/subscribe', origin).href
const enrollUrl = new URL(WireRoutes.SubscriptionEnroll, origin).href
const cancelUrl = new URL(WireRoutes.SubscriptionCancel, origin).href
const address = `subscription-${randomBytes(12).toString('hex')}@example.test`
const wrongProof = randomBytes(32).toString('hex')
const processed = '请求已处理。有效的退订凭据会停用匹配的偏好。'
const checks = {}
const errors = []
const started = new Date().toISOString()
let proof = ''
let failure
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ executablePath, args: pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [] })

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  page.on('pageerror', () => errors.push('uncaught-page-error'))
  const landing = await page.goto(url)
  assert.equal(landing.status(), 200)
  assert.match((await landing.securityDetails())?.protocol ?? '', /^TLS/)
  assert.match(await landing.headerValue('X-Robots-Tag') ?? '', /\bnoindex\b/u)
  assert.match(await landing.headerValue('Cache-Control') ?? '', /\bno-store\b/u)
  await page.getByRole('heading', { name: '订阅', exact: true }).waitFor()
  assert.match(await page.title(), /订阅/u)
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content') ?? '', /\bnoindex\b/u)
  checks.secureUnindexedShell = true

  const feeds = { RSS: '/feed/rss.xml', Atom: '/feed/atom.xml', 'JSON Feed': '/feed/feed.json' }
  for (const [name, path] of Object.entries(feeds)) {
    const link = page.getByRole('link', { name, exact: true })
    assert.equal(await link.getAttribute('href'), path)
    assert.equal((await page.request.get(new URL(path, origin).href)).status(), 200)
  }
  await page.screenshot({ path: join(evidence, 'subscription-preferences.png'), animations: 'disabled' })
  checks.realFeeds = true

  await context.addCookies([{ name: 'fixture_cookie', value: 'must-be-omitted', url: origin, secure: true }])
  const field = page.getByLabel('邮箱地址', { exact: true })
  await field.fill(address)
  await selectChannel('邮件偏好')
  assert.equal(await page.getByLabel('退订凭据', { exact: true }).count(), 0)
  const enrolled = await post(enrollUrl, '保存偏好')
  await inspect(enrolled, WireLayouts.SubscriptionEmailChannel)
  assert.equal(await enrolled.request().headerValue(WireHeaders.SubscriptionProof), null)
  await page.getByText('订阅偏好请求已处理。', { exact: true }).waitFor()
  assert.equal(await field.inputValue(), '')
  await field.fill(address)
  await selectChannel('RSS 偏好')
  const alternateEnrollment = await post(enrollUrl, '保存偏好')
  await inspect(alternateEnrollment, WireLayouts.SubscriptionRssChannel)
  assert(Buffer.from(await alternateEnrollment.body()).equals(Buffer.from(await enrolled.body())))
  await page.getByText('订阅偏好请求已处理。', { exact: true }).waitFor()
  checks.anonymousEmailEnrollment = true
  checks.bothPreferenceChannelsSupported = true

  proof = await issueProof('email')
  await page.getByRole('button', { name: '停用', exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await selectChannel('邮件偏好')
  const proofField = page.getByLabel('退订凭据', { exact: true })
  assert.equal(await proofField.getAttribute('type'), 'password')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(evidence, 'subscription-cancel-mobile.png'), animations: 'disabled' })

  await field.fill(address)
  await proofField.fill('not-a-proof')
  const observed = []
  page.on('request', request => {
    if (request.url() === cancelUrl) observed.push(request)
  })
  await page.getByRole('button', { name: '停用偏好', exact: true }).click()
  await page.getByText('请输入 64 位十六进制凭据。', { exact: true }).waitFor()
  assert.equal(observed.length, 0)
  checks.malformedProofRejectedBeforeSending = true

  const cancelReceipts = []
  for (const credential of [wrongProof, proof, proof]) {
    await field.fill(address)
    await proofField.fill(credential)
    const result = await post(cancelUrl, '停用偏好')
    await inspect(result, WireLayouts.SubscriptionEmailChannel)
    assert((await result.request().headerValue(WireHeaders.SubscriptionProof)) === credential, 'Cancellation proof must be in the bound request header.')
    await page.getByText(processed, { exact: true }).waitFor()
    assert.equal(await field.inputValue(), '')
    assert.equal(await proofField.inputValue(), '')
    cancelReceipts.push(Buffer.from(await result.body()))
  }
  assert(cancelReceipts.every(receipt => receipt.equals(cancelReceipts[0])), 'Cancellation results must be indistinguishable in the wire and UI.')
  checks.neutralBoundCancellationAndReplay = true

  const persistence = await page.evaluate(() => JSON.stringify({ url: location.href, local: { ...localStorage }, session: { ...sessionStorage } }))
  assert(![address, proof, wrongProof].some(value => persistence.includes(value)), 'Subscription credentials must not reach URLs or browser storage.')
  assert.equal(page.url(), url)
  assert.equal(errors.length, 0)
  checks.privateInputHandling = true

  async function post(endpoint, label) {
    const [response] = await Promise.all([
      page.waitForResponse(result => result.url() === endpoint && result.request().method() === 'POST'),
      page.getByRole('button', { name: label, exact: true }).click(),
    ])
    return response
  }

  async function selectChannel(name) {
    await page.getByText(name, { exact: true }).click()
    assert(await page.getByRole('radio', { name, exact: true }).isChecked())
  }

  async function inspect(response, channel) {
    assert.equal(response.status(), 200)
    assert.match(await response.headerValue('Cache-Control') ?? '', /\bno-store\b/u)
    const request = response.request()
    assert.equal(await request.headerValue('Cookie'), null)
    const requestBody = decodeFrame(request.postDataBuffer(), FrameType.SubscriptionPreferenceRequest).payload
    const preference = decodeSubscriptionPreferenceRequest(requestBody)
    assert(preference.channel === channel && preference.email === address, 'Subscription payload must bind the requested email and channel.')
    decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
  }
} catch (error) {
  failure = error
} finally {
  const version = browser.version()
  await browser.close()
  await writeFile(join(evidence, 'subscription-preference-result.json'), JSON.stringify({
    started, ended: new Date().toISOString(), browser: version, checks, errors, passed: !failure,
  }, null, 2) + '\n')
}
if (failure) throw failure

function issueProof(channel) {
  return new Promise((accept, reject) => {
    const child = spawn(issuer, [channel], { timeout: 8_000, stdio: ['pipe', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', value => { output += value })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('close', code => {
      const token = output.trim()
      if (code === 0 && /^[0-9a-f]{64}$/u.test(token)) accept(token)
      else reject(new Error('The offline cancellation fixture did not issue a proof.'))
    })
    child.stdin.end(address + '\n')
  })
}
