import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSubscriptionPreferenceRequest, FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { clickForResponse } from './admin-workspace-fixture.mjs'
import { assertNoOverflow, saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertEmpty, assertNoStore, assertStatus } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'
import { launchIdentityBrowser } from './site-authentication-fixture.mjs'

const {
  FSUSBLOG_TEST_SUBSCRIPTION_URL: origin, FSUSBLOG_TEST_SUBSCRIPTION_ISSUE: issuer,
  FSUSBLOG_TEST_EVIDENCE: evidence, FSUSBLOG_TEST_TLS_SPKI: pin,
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
const checks = {}, errors = [], started = new Date().toISOString()
let proof = ''
const browser = await launchIdentityBrowser(pin)
const version = browser.version()

await withBrowserEvidence(browser, evidence, 'subscription-preference-result.json', failure => ({
  started, ended: new Date().toISOString(), browser: version, checks, errors, passed: !failure,
}), async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
  context.setDefaultTimeout(15_000)
  await context.addCookies([{ name: 'fsus_locale', value: 'zh-CN', url: origin }])
  const page = await context.newPage()
  page.on('pageerror', () => errors.push('uncaught-page-error'))
  const landing = await page.goto(url)
  assertStatus(landing, 200)
  assert.match((await landing.securityDetails())?.protocol ?? '', /^TLS/)
  assert.match(await landing.headerValue('X-Robots-Tag') ?? '', /\bnoindex\b/u)
  await assertNoStore(landing)
  await loc.exactHeading(page, '订阅').waitFor()
  assert.match(await page.title(), /订阅/u)
  assert.match(await page.locator('meta[name="robots"]').getAttribute('content') ?? '', /\bnoindex\b/u)
  checks.secureUnindexedShell = true

  for (const [name, path] of Object.entries({ RSS: '/feed/rss.xml', Atom: '/feed/atom.xml', 'JSON Feed': '/feed/feed.json' })) {
    assert.equal(await loc.exactLink(page, name).getAttribute('href'), path)
    assertStatus(await page.request.get(new URL(path, origin).href), 200)
  }
  await saveShot(page, evidence, 'subscription-preferences.png')
  checks.realFeeds = true

  const post = (endpoint, label) => clickForResponse(page, endpoint, loc.exactButton(page, label), 'POST')
  const selectChannel = async name => {
    await loc.exactText(page, name).click()
    assert(await loc.exactRadio(page, name).isChecked())
  }
  async function inspect(response, channel) {
    await assertNoStore(response)
    const request = response.request()
    assert.equal(await request.headerValue('Cookie'), null)
    const preference = decodeSubscriptionPreferenceRequest(decodeFrame(request.postDataBuffer(), FrameType.SubscriptionPreferenceRequest).payload)
    assert(preference.channel === channel && preference.email === address, 'Subscription payload must bind the requested email and channel.')
    await assertEmpty(response)
  }

  await context.addCookies([{ name: 'fixture_cookie', value: 'must-be-omitted', url: origin, secure: true }])
  const field = loc.exactLabel(page, '邮箱地址')
  await field.fill(address)
  await selectChannel('邮件偏好')
  assert.equal(await loc.exactLabel(page, '退订凭据').count(), 0)
  const enrolled = await post(enrollUrl, '保存偏好')
  await inspect(enrolled, WireLayouts.SubscriptionEmailChannel)
  assert.equal(await enrolled.request().headerValue(WireHeaders.SubscriptionProof), null)
  await loc.exactText(page, '订阅偏好请求已处理。').waitFor()
  assert.equal(await field.inputValue(), '')
  await field.fill(address)
  await selectChannel('RSS 偏好')
  const alternateEnrollment = await post(enrollUrl, '保存偏好')
  await inspect(alternateEnrollment, WireLayouts.SubscriptionRssChannel)
  assert(Buffer.from(await alternateEnrollment.body()).equals(Buffer.from(await enrolled.body())))
  await loc.exactText(page, '订阅偏好请求已处理。').waitFor()
  checks.anonymousEmailEnrollment = true
  checks.bothPreferenceChannelsSupported = true

  proof = await issueProof('email')
  await loc.exactButton(page, '停用').click()
  await page.setViewportSize({ width: 375, height: 812 })
  await selectChannel('邮件偏好')
  const proofField = loc.exactLabel(page, '退订凭据')
  assert.equal(await proofField.getAttribute('type'), 'password')
  await assertNoOverflow(page)
  await saveShot(page, evidence, 'subscription-cancel-mobile.png')

  await field.fill(address)
  await proofField.fill('not-a-proof')
  const observed = []
  page.on('request', request => { if (request.url() === cancelUrl) observed.push(request) })
  await loc.exactButton(page, '停用偏好').click()
  await loc.exactText(page, '请输入 64 位十六进制凭据。').waitFor()
  assert.equal(observed.length, 0)
  checks.malformedProofRejectedBeforeSending = true

  const cancelReceipts = []
  for (const credential of [wrongProof, proof, proof]) {
    await field.fill(address)
    await proofField.fill(credential)
    const result = await post(cancelUrl, '停用偏好')
    await inspect(result, WireLayouts.SubscriptionEmailChannel)
    assert((await result.request().headerValue(WireHeaders.SubscriptionProof)) === credential, 'Cancellation proof must be in the bound request header.')
    await loc.exactText(page, processed).waitFor()
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
}, { mkdir: true, newline: true })

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
