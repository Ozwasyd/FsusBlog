import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { decodeSession, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { postFrame } from './browser-authoring-fixture.mjs'
import { saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus, readFrame } from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'
import { enableAuthenticator, expect, launchIdentityBrowser } from './site-authentication-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_PASSKEY_URL
assert(origin, 'Provide an isolated reader-registration-enabled origin; no setup ticket is needed.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/reader-registration-browser')
const registration = '/api/v2/identity/reader-registration'
const checks = {}, calls = [], faults = []
const browser = await launchIdentityBrowser()

await withBrowserEvidence(browser, evidence, 'reader-registration-result.json', failure => ({
  checks, calls, faults, failure: failure instanceof Error ? failure.message : undefined,
}), async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
  const page = await context.newPage()
  await enableAuthenticator(context, page)
  page.on('pageerror', error => faults.push(error.message))
  page.on('request', request => { if (request.method() === 'POST') calls.push(new URL(request.url()).pathname) })
  const noSession = async () => {
    assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
    assertStatus(await context.request.get(origin + WireRoutes.Session), 401)
  }

  // Without either a browser binding or work proof, begin must not create a session.
  const unproved = await postFrame(context.request, origin + registration + '/begin.aeds',
    FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0), { 'Content-Type': 'application/octet-stream', Origin: origin })
  assertStatus(unproved, 401)
  assert.equal(unproved.headers()['set-cookie'], undefined)
  await noSession()
  checks.unboundBeginRejected = true

  await page.goto(origin + '/register')
  await expect(loc.exactHeading(page, 'Create a reader account')).toBeVisible()
  const create = loc.exactButton(page, 'Create Passkey')
  const consent = loc.exactCheckbox(page, 'I have read and agree to the guidelines.')
  await expect(create).toBeDisabled()
  await expect(consent).not.toBeChecked()
  await expect(page.locator('input:not([type="checkbox"])')).toHaveCount(0)
  assert.deepEqual(calls, [])
  await loc.exactText(page, 'I have read and agree to the guidelines.').click()
  await expect(create).toBeEnabled()
  const [policy] = await Promise.all([context.waitForEvent('page'), loc.exactLink(page, 'Read the guidelines (opens in a new tab)').click()])
  await policy.waitForLoadState()
  assert.equal(new URL(policy.url()).pathname, '/guidelines')
  await policy.close()
  await expect(consent).toBeChecked()
  await expect(create).toBeEnabled()
  assert.deepEqual(calls, [])
  checks.explicitConsentAndPolicyPreserveForm = true

  await create.click()
  await expect(loc.exactText(page, 'Your reader account and Passkey have been created. You are not logged in yet. Log in with your new Passkey.')).toBeVisible({ timeout: 30_000 })
  await noSession()
  assert.deepEqual(calls, ['/pow.aeds', '/begin.aeds', '/complete.aeds'].map(path => registration + path))
  checks.registrationDoesNotSignIn = true
  await saveShot(page, evidence, 'reader-created.png', {})

  await loc.exactLink(page, 'Log in with Passkey').click()
  await page.waitForURL(origin + '/login')
  await loc.exactButton(page, 'Log in with Passkey').click()
  await page.waitForURL(origin + '/user/identity/mfa')
  const session = await readFrame(await context.request.get(origin + WireRoutes.Session), FrameType.OperatorSession, decodeSession)
  assert.equal(session.canAuthor, false)
  assert((await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert(!calls.includes(WireRoutes.SignIn))
  checks.passkeySignsInReaderOnly = true

  for (const path of [WireRoutes.AdminSession, WireRoutes.AuthoringSession, WireRoutes.AuthorArticles])
    assertStatus(await context.request.get(origin + path), 401)
  await page.goto(origin + '/admin/articles/write')
  await expect(loc.exactText(page, 'Log in with an author account to write an article.')).toBeVisible()
  await expect(page.locator('#workspace-editor, .workspace-actions')).toHaveCount(0)
  checks.authorApiAndEditorDenied = true
  await saveShot(page, evidence, 'reader-editor-denied.png', {})
  assert.deepEqual(faults, [])
}, { mkdir: true, newline: true })
