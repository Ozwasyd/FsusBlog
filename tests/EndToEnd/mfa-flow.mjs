import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { enableAuthenticator, launchIdentityBrowser, readSeed, request, totp } from './site-authentication-fixture.mjs'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

const origin = process.env.FSUSBLOG_TEST_MFA_URL
const ticket = process.env.FSUSBLOG_TEST_MFA_TICKET
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/mfa-browser')
assert(origin && ticket, 'Provide an isolated WebAuthn + TOTP origin and an unused passkey provisioning ticket.')
await mkdir(evidence, { recursive: true })
const browser = await launchIdentityBrowser()
const responses = []
const faults = []
const start = new Date().toISOString()
const regeneratePath = '/api/binary/auth/mfa/recovery/regenerate'
let phase = 'bootstrap'
let failure
let assertions = 0
let rotations = 0
let recoveryRegenerated = false
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  assertStatus(await context.request.post(origin + regeneratePath), 401)
  page.on('pageerror', error => faults.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.includes('/auth/')) return
    responses.push([url.pathname, response.status()])
    if (response.status() >= 500) faults.push(url.pathname + ' returned ' + response.status())
  })
  await enableAuthenticator(context, page)
  const waitApi = (path, method = 'POST') => page.waitForResponse(response => response.url() === origin + path &&
    response.request().method() === method, { timeout: 9_000 })
  const logout = async () => {
    const confirmed = waitApi('/api/v2/identity/sign-out.aeds')
    await exactButton(page, 'Log out').click()
    assertStatus(await confirmed, 200)
    await page.waitForURL(origin + '/')
  }
  const signedIn = async () => {
    await page.waitForURL(origin + '/user/manage/article/write')
    await page.getByRole('heading', { name: 'New article' }).waitFor({ timeout: 9_000 })
    assertStatus(await context.request.get(origin + '/api/v2/identity/session.aeds'), 200)
    assertions++
  }
  const sessionCookie = async () => {
    const cookies = await context.cookies(origin)
    const session = cookies.find(cookie => cookie.name === 'fsus-v2-session')
    assert(session, 'Authenticated browser session cookie is missing.')
    return session
  }
  const verifyRotation = async (oldCookie) => {
    assert((await sessionCookie()).value !== oldCookie.value, 'MFA change reused the prior session credential.')
    const stale = await request.newContext({ storageState: { cookies: [oldCookie], origins: [] } })
    try { assertStatus(await stale.get(origin + '/api/v2/identity/session.aeds'), 401) }
    finally { await stale.dispose() }
    assertStatus(await context.request.get(origin + '/api/v2/identity/session.aeds'), 200)
    rotations++
  }
  const passkey = async () => {
    await page.goto(origin + '/login')
    const completed = waitApi('/api/binary/auth/passkey/login/complete')
    await exactButton(page, 'Log in with Passkey').click()
    const response = await completed
    assertStatus(response, 200)
    return await response.body()
  }
  const verify = async (code) => {
    const checked = waitApi('/api/binary/auth/mfa/challenge')
    await exactLabel(page, 'Authenticator or recovery code').fill(code)
    await exactButton(page, 'Verify and log in').click()
    return (await checked).status()
  }

  await page.goto(origin + '/login')
  await page.getByLabel('Owner access key').fill(ticket)
  await exactButton(page, 'Create Passkey').click()
  await exactText(page, 'Passkey created. Log in with your Passkey.').waitFor({ timeout: 9_000 })
  assert.equal((await passkey())[20], 1)
  await signedIn()

  phase = 'setup-and-verify'
  await roleWithExactName(page, 'link', 'Account').first().click()
  await page.waitForURL(origin + '/user/identity/mfa')
  assertStatus(await context.request.post(origin + '/api/binary/auth/mfa/setup/start'), 428)
  await exactButton(page, 'Set up authenticator').click()
  const seedNode = page.getByTestId('mfa-seed')
  await seedNode.waitFor({ timeout: 9_000 })
  const seed = await seedNode.textContent()
  assert.match(seed, /^[A-Z2-7]{32}$/)
  const secret = readSeed(seed)
  const step = Math.floor(Date.now() / 30_000)
  const setupCode = totp(secret, step)
  const beforeSetup = await sessionCookie()
  await exactLabel(page, 'Authenticator code').fill(setupCode)
  await exactButton(page, 'Enable verification').click()
  await roleWithExactName(page, 'heading', 'Recovery codes').waitFor({ timeout: 9_000 })
  await verifyRotation(beforeSetup)
  const recovery = await page.getByRole('listitem').filter({ hasText: /^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/ }).allTextContents()
  assert.equal(recovery.length, 8)
  await exactButton(page, 'Hide recovery codes').click()
  await page.screenshot({ path: join(evidence, 'mfa-enabled.png') })
  await logout()

  phase = 'totp-login'
  assert.equal((await passkey())[20], 2)
  assertStatus(await context.request.get(origin + '/api/v2/identity/session.aeds'), 401)
  await page.screenshot({ path: join(evidence, 'mfa-pending.png') })
  assert.equal(await verify(setupCode), 401)
  await page.getByText('Verification failed. Use a fresh code or start a new login.').waitFor()
  const fresh = Math.max(step + 1, Math.floor(Date.now() / 30_000))
  assert.equal(await verify(totp(secret, fresh)), 200)
  await signedIn()
  await logout()

  phase = 'recovery-login'
  assert.equal((await passkey())[20], 2)
  assert.equal(await verify(recovery[0]), 200)
  await signedIn()

  phase = 'regenerate-recovery-codes'
  await roleWithExactName(page, 'link', 'Account').first().click()
  assertStatus(await context.request.post(origin + regeneratePath), 428)
  const beforeRegeneration = await sessionCookie()
  const recoveryList = page.getByRole('listitem').filter({ hasText: /^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/ })
  await exactButton(page, 'Regenerate recovery codes').click()
  await exactLabel(page, 'Authenticator or recovery code to regenerate').fill(recovery[1])
  const regenerated = waitApi(regeneratePath)
  await exactButton(page, 'Replace recovery codes').click()
  const replacement = await regenerated
  assertStatus(replacement, 200)
  assert.equal(replacement.headers()['cache-control'], 'no-store')
  assert.equal((await replacement.headerValues('set-cookie')).length, 0)
  assert((await sessionCookie()).value === beforeRegeneration.value, 'Recovery code rotation changed the active cookie.')
  assert.equal(replacement.request().postData(), null)
  const usedProof = await replacement.request().headerValue('x-fsus-mfa-proof')
  assert(Boolean(usedProof), 'Recovery rotation required an action proof.')
  const repeated = await context.request.post(origin + regeneratePath, { headers: { 'X-Fsus-Mfa-Proof': usedProof } })
  assertStatus(repeated, 428)
  await recoveryList.nth(9).waitFor({ timeout: 9_000 })
  const newCodes = await recoveryList.allTextContents()
  assert.equal(newCodes.length, 10)
  assert.equal(new Set(newCodes).size, 10)
  assert(newCodes.every(code => !recovery.includes(code)))
  await exactButton(page, 'Hide recovery codes').click()
  await roleWithExactName(page, 'heading', 'Recovery codes').waitFor({ state: 'detached' })
  await page.reload()
  await exactButton(page, 'Regenerate recovery codes').waitFor()
  assert.equal(await recoveryList.count(), 0)
  await logout()
  assert.equal((await passkey())[20], 2)
  assert.equal(await verify(recovery[2]), 401)
  await page.getByText('Verification failed. Use a fresh code or start a new login.').waitFor()
  assert.equal(await verify(newCodes[0]), 200)
  await signedIn()
  recoveryRegenerated = true

  phase = 'one-use-disable-proof'
  const beforeDisable = await sessionCookie()
  await roleWithExactName(page, 'link', 'Account').first().click()
  await exactLabel(page, 'Authenticator or recovery code').fill(newCodes[0])
  const usedCode = waitApi('/api/binary/auth/mfa/challenge')
  await exactButton(page, 'Disable authenticator verification').click()
  assertStatus(await usedCode, 401)
  await exactText(page, 'Could not verify your request. Use a fresh code and try again.').waitFor()
  const disabled = waitApi('/api/binary/auth/mfa/disable')
  await exactLabel(page, 'Authenticator or recovery code').fill(newCodes[1])
  await exactButton(page, 'Disable authenticator verification').click()
  assertStatus(await disabled, 200)
  await exactButton(page, 'Set up authenticator').waitFor({ timeout: 9_000 })
  await verifyRotation(beforeDisable)
  await logout()
  assert.equal((await passkey())[20], 1)
  await signedIn()
  await logout()
  assert.deepEqual(faults, [])
  phase = 'passed'
} catch (error) {
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'mfa-result.json'), JSON.stringify({
    start, end: new Date().toISOString(), origin, chromium: browser.version(), phase, validSessions: assertions, rotations,
    responses, faults, recoveryRegenerated, exitCode: failure ? 1 : 0,
  }, null, 2))
}
if (failure) throw failure
