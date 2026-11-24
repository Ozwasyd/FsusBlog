import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { decodeLoginFlow } from '../../src/Contracts/passkey.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus, readFrame } from './response-status-fixture.mjs'
import { exactButton, exactHeading, exactLabel, exactText } from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'
import { signInFreshSite } from './webauthn-fixture.mjs'

const origin = process.env.FSUSBLOG_TEST_MFA_URL
const ticket = process.env.FSUSBLOG_TEST_MFA_TICKET
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/mfa-browser')
assert(origin && ticket, 'Provide an isolated WebAuthn + TOTP origin and an unused passkey provisioning ticket.')
const browser = await auth.launchIdentityBrowser()
const responses = [], faults = []
const start = new Date().toISOString()
const regeneratePath = '/api/binary/auth/mfa/recovery/regenerate'
let phase = 'bootstrap', assertions = 0, rotations = 0, recoveryRegenerated = false

await withBrowserEvidence(browser, evidence, 'mfa-result.json', failure => ({
  start, end: new Date().toISOString(), origin, chromium: browser.version(), phase, validSessions: assertions, rotations,
  responses, faults, recoveryRegenerated, exitCode: failure ? 1 : 0,
}), async () => {
  const context = await browser.newContext()
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  assertStatus(await context.request.post(origin + regeneratePath), 401)
  page.on('pageerror', error => faults.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.includes('/auth/')) return
    responses.push([url.pathname, response.status()])
    if (response.status() >= 500) faults.push(url.pathname + ' returned ' + response.status())
  })
  const { waitApi, clickApi } = auth.siteApi(origin, (target, predicate) => target.waitForResponse(predicate, { timeout: 9_000 }))
  const expectSession = async status => assertStatus(await context.request.get(origin + WireRoutes.Session), status)
  const logout = async () => {
    assertStatus(await clickApi(page, WireRoutes.SignOut, 'Log out'), 200)
    await page.waitForURL(origin + '/')
  }
  const signedIn = async () => {
    await page.waitForURL(origin + '/user/identity/mfa')
    await exactHeading(page, 'Account').waitFor({ timeout: 9_000 })
    await expectSession(200)
    assertions++
  }
  const sessionCookie = async () => {
    const session = (await context.cookies(origin)).find(cookie => cookie.name === 'fsus-v2-session')
    assert(session, 'Authenticated browser session cookie is missing.')
    return session
  }
  const verifyRotation = async oldCookie => {
    assert((await sessionCookie()).value !== oldCookie.value, 'MFA change reused the prior session credential.')
    await auth.assertStaleSessionRejected(origin, [oldCookie])
    await expectSession(200)
    rotations++
  }
  const readerNeedsTotp = async response => {
    const flow = await readFrame(response, FrameType.AuthLoginFlow, decodeLoginFlow)
    assert.equal(flow.kind, 'reader')
    return flow.pending !== null
  }
  const passkey = async () => {
    await page.goto(origin + '/login')
    return readerNeedsTotp(await clickApi(page, WireRoutes.PasskeyLoginComplete, 'Log in with Passkey'))
  }
  const verify = async code => {
    await exactLabel(page, 'Authenticator or recovery code').fill(code)
    return (await clickApi(page, '/api/binary/auth/mfa/challenge', 'Verify and log in')).status()
  }

  const [initialLogin] = await Promise.all([waitApi(page, WireRoutes.PasskeyLoginComplete), signInFreshSite(page, origin, ticket)])
  assert.equal(await readerNeedsTotp(initialLogin), false)
  await signedIn()

  phase = 'setup-and-verify'
  assertStatus(await context.request.post(origin + '/api/binary/auth/mfa/setup/start'), 428)
  await exactButton(page, 'Set up authenticator').click()
  const seedNode = page.getByTestId('mfa-seed')
  await seedNode.waitFor({ timeout: 9_000 })
  const seed = await seedNode.textContent()
  assert.match(seed, /^[A-Z2-7]{32}$/)
  const secret = auth.readSeed(seed), step = Math.floor(Date.now() / 30_000), setupCode = auth.totp(secret, step)
  const beforeSetup = await sessionCookie()
  await exactLabel(page, 'Authenticator code').fill(setupCode)
  await exactButton(page, 'Enable verification').click()
  await exactHeading(page, 'Recovery codes').waitFor({ timeout: 9_000 })
  await verifyRotation(beforeSetup)
  const recoveryList = page.getByRole('listitem').filter({ hasText: /^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/ })
  const recovery = await recoveryList.allTextContents()
  assert.equal(recovery.length, 8)
  await exactButton(page, 'Hide recovery codes').click()
  await saveShot(page, evidence, 'mfa-enabled.png', {})
  await logout()

  phase = 'totp-login'
  assert.equal(await passkey(), true)
  await expectSession(401)
  await saveShot(page, evidence, 'mfa-pending.png', {})
  assert.equal(await verify(setupCode), 401)
  await page.getByText('Verification failed. Use a fresh code or start a new login.').waitFor()
  assert.equal(await verify(auth.totp(secret, Math.max(step + 1, Math.floor(Date.now() / 30_000)))), 200)
  await signedIn()
  await logout()

  phase = 'recovery-login'
  assert.equal(await passkey(), true)
  assert.equal(await verify(recovery[0]), 200)
  await signedIn()

  phase = 'regenerate-recovery-codes'
  assertStatus(await context.request.post(origin + regeneratePath), 428)
  const beforeRegeneration = await sessionCookie()
  await exactButton(page, 'Regenerate recovery codes').click()
  await exactLabel(page, 'Authenticator or recovery code to regenerate').fill(recovery[1])
  const replacement = await clickApi(page, regeneratePath, 'Replace recovery codes')
  assertStatus(replacement, 200)
  assert.equal(replacement.headers()['cache-control'], 'no-store')
  assert.equal((await replacement.headerValues('set-cookie')).length, 0)
  assert((await sessionCookie()).value === beforeRegeneration.value, 'Recovery code rotation changed the active cookie.')
  assert.equal(replacement.request().postData(), null)
  const usedProof = await replacement.request().headerValue('x-fsus-mfa-proof')
  assert(Boolean(usedProof), 'Recovery rotation required an action proof.')
  assertStatus(await context.request.post(origin + regeneratePath, { headers: { 'X-Fsus-Mfa-Proof': usedProof } }), 428)
  await recoveryList.nth(9).waitFor({ timeout: 9_000 })
  const newCodes = await recoveryList.allTextContents()
  assert.equal(newCodes.length, 10)
  assert.equal(new Set(newCodes).size, 10)
  assert(newCodes.every(code => !recovery.includes(code)))
  await exactButton(page, 'Hide recovery codes').click()
  await exactHeading(page, 'Recovery codes').waitFor({ state: 'detached' })
  await page.reload()
  await exactButton(page, 'Regenerate recovery codes').waitFor()
  assert.equal(await recoveryList.count(), 0)
  await logout()
  assert.equal(await passkey(), true)
  assert.equal(await verify(recovery[2]), 401)
  await page.getByText('Verification failed. Use a fresh code or start a new login.').waitFor()
  assert.equal(await verify(newCodes[0]), 200)
  await signedIn()
  recoveryRegenerated = true

  phase = 'one-use-disable-proof'
  const beforeDisable = await sessionCookie()
  await exactLabel(page, 'Authenticator or recovery code').fill(newCodes[0])
  assertStatus(await clickApi(page, '/api/binary/auth/mfa/challenge', 'Disable authenticator verification'), 401)
  await exactText(page, 'Could not verify your request. Use a fresh code and try again.').waitFor()
  await exactLabel(page, 'Authenticator or recovery code').fill(newCodes[1])
  assertStatus(await clickApi(page, '/api/binary/auth/mfa/disable', 'Disable authenticator verification'), 200)
  await exactButton(page, 'Set up authenticator').waitFor({ timeout: 9_000 })
  await verifyRotation(beforeDisable)
  await logout()
  assert.equal(await passkey(), false)
  await signedIn()
  await logout()
  assert.deepEqual(faults, [])
  phase = 'passed'
}, { mkdir: true })
