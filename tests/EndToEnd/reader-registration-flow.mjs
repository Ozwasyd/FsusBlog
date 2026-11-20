import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSession, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { postFrame } from './browser-authoring-fixture.mjs'
import { enableAuthenticator, expect, launchIdentityBrowser } from './site-authentication-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_PASSKEY_URL
assert(origin, 'Provide an isolated reader-registration-enabled origin; no setup ticket is needed.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/reader-registration-browser')
await mkdir(evidence, { recursive: true })
const registration = '/api/v2/identity/reader-registration'
const checks = {}
const calls = []
const faults = []
const browser = await launchIdentityBrowser()
let failure
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await context.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
  const page = await context.newPage()
  await enableAuthenticator(context, page)
  page.on('pageerror', error => faults.push(error.message))
  page.on('request', request => {
    if (request.method() === 'POST') calls.push(new URL(request.url()).pathname)
  })

  // Without either a browser binding or work proof, begin must not create a session.
  const unproved = await postFrame(context.request, origin + registration + '/begin.aeds',
    FrameType.EmptySuccess, Uint8Array.of(1, 0, 0, 0), { 'Content-Type': 'application/octet-stream', Origin: origin })
  assert.equal(unproved.status(), 401)
  assert.equal(unproved.headers()['set-cookie'], undefined)
  await noSession(context)
  checks.unboundBeginRejected = true

  await page.goto(origin + '/register')
  await expect(page.getByRole('heading', { name: 'Create a reader account', exact: true })).toBeVisible()
  const create = page.getByRole('button', { name: 'Create Passkey', exact: true })
  const consent = page.getByRole('checkbox', { name: 'I have read and agree to the guidelines.', exact: true })
  await expect(create).toBeDisabled()
  await expect(consent).not.toBeChecked()
  await expect(page.locator('input:not([type="checkbox"])')).toHaveCount(0)
  assert.deepEqual(calls, [])
  await page.getByText('I have read and agree to the guidelines.', { exact: true }).click()
  await expect(create).toBeEnabled()
  const [policy] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('link', { name: 'Read the guidelines (opens in a new tab)', exact: true }).click(),
  ])
  await policy.waitForLoadState()
  assert.equal(new URL(policy.url()).pathname, '/guidelines')
  await policy.close()
  await expect(consent).toBeChecked()
  await expect(create).toBeEnabled()
  assert.deepEqual(calls, [])
  checks.explicitConsentAndPolicyPreserveForm = true

  await create.click()
  await expect(page.getByText('Your reader account and Passkey have been created. You are not logged in yet. Log in with your new Passkey.',
    { exact: true })).toBeVisible({ timeout: 30_000 })
  await noSession(context)
  assert.deepEqual(calls, ['/pow.aeds', '/begin.aeds', '/complete.aeds'].map(path => registration + path))
  checks.registrationDoesNotSignIn = true
  await page.screenshot({ path: join(evidence, 'reader-created.png') })

  await page.getByRole('link', { name: 'Log in with Passkey', exact: true }).click()
  await page.waitForURL(origin + '/login')
  await page.getByRole('button', { name: 'Log in with Passkey', exact: true }).click()
  await page.waitForURL(origin + '/user/identity/mfa')
  const response = await context.request.get(origin + WireRoutes.Session)
  assert.equal(response.status(), 200)
  const session = decodeSession(decodeFrame(await response.body(), FrameType.OperatorSession).payload)
  assert.equal(session.canAuthor, false)
  assert((await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert(!calls.includes(WireRoutes.SignIn))
  checks.passkeySignsInReaderOnly = true

  const articles = await context.request.get(origin + WireRoutes.AuthorArticles)
  assert.equal(articles.status(), 403)
  await page.goto(origin + '/user/manage/article/write')
  await expect(page.getByText('Log in with an author account to write an article.', { exact: true })).toBeVisible()
  await expect(page.locator('#workspace-editor, .workspace-actions')).toHaveCount(0)
  checks.authorApiAndEditorDenied = true
  await page.screenshot({ path: join(evidence, 'reader-editor-denied.png') })
  assert.deepEqual(faults, [])
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'reader-registration-result.json'), JSON.stringify({
    checks, calls, faults, failure: failure instanceof Error ? failure.message : undefined,
  }, null, 2) + '\n')
}
if (failure) throw failure

async function noSession(context) {
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert.equal((await context.request.get(origin + WireRoutes.Session)).status(), 401)
}
