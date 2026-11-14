import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const source = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium, request } = source('@playwright/test')
const origin = process.env.FSUSBLOG_TEST_MFA_URL
const ticket = process.env.FSUSBLOG_TEST_MFA_TICKET
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/mfa-browser')
assert(origin && ticket, 'Provide an isolated WebAuthn + TOTP origin and an unused passkey provisioning ticket.')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
const responses = []
const faults = []
const start = new Date().toISOString()
let phase = 'bootstrap'
let failure
let assertions = 0
let rotations = 0
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  page.on('pageerror', error => faults.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.includes('/auth/')) return
    responses.push([url.pathname, response.status()])
    if (response.status() >= 500) faults.push(url.pathname + ' returned ' + response.status())
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })
  const waitApi = (path, method = 'POST') => page.waitForResponse(response => response.url() === origin + path &&
    response.request().method() === method, { timeout: 9_000 })
  const logout = async () => {
    const confirmed = waitApi('/api/v2/identity/sign-out.aeds')
    await page.getByRole('button', { name: 'Log out', exact: true }).click()
    assert.equal((await confirmed).status(), 200)
    await page.waitForURL(origin + '/')
  }
  const signedIn = async () => {
    await page.waitForURL(origin + '/user/manage/article/write')
    await page.getByRole('heading', { name: 'New article' }).waitFor({ timeout: 9_000 })
    assert.equal((await context.request.get(origin + '/api/v2/identity/session.aeds')).status(), 200)
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
    try { assert.equal((await stale.get(origin + '/api/v2/identity/session.aeds')).status(), 401) }
    finally { await stale.dispose() }
    assert.equal((await context.request.get(origin + '/api/v2/identity/session.aeds')).status(), 200)
    rotations++
  }
  const passkey = async () => {
    await page.goto(origin + '/login')
    const completed = waitApi('/api/binary/auth/passkey/login/complete')
    await page.getByRole('button', { name: 'Log in with Passkey', exact: true }).click()
    const response = await completed
    assert.equal(response.status(), 200)
    return await response.body()
  }
  const verify = async (code) => {
    const checked = waitApi('/api/binary/auth/mfa/challenge')
    await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(code)
    await page.getByRole('button', { name: 'Verify and log in', exact: true }).click()
    return (await checked).status()
  }

  await page.goto(origin + '/login')
  await page.getByLabel('Owner access key').fill(ticket)
  await page.getByRole('button', { name: 'Create Passkey', exact: true }).click()
  await page.getByText('Passkey created. Log in with your Passkey.', { exact: true }).waitFor({ timeout: 9_000 })
  assert.equal((await passkey())[20], 1)
  await signedIn()

  phase = 'setup-and-verify'
  await page.getByRole('link', { name: 'Account security', exact: true }).first().click()
  await page.waitForURL(origin + '/user/identity/mfa')
  assert.equal((await context.request.post(origin + '/api/binary/auth/mfa/setup/start')).status(), 428)
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click()
  const seedNode = page.getByTestId('mfa-seed')
  await seedNode.waitFor({ timeout: 9_000 })
  const secret = readSeed(await seedNode.textContent())
  const step = Math.floor(Date.now() / 30_000)
  const setupCode = totp(secret, step)
  const beforeSetup = await sessionCookie()
  await page.getByLabel('Authenticator code', { exact: true }).fill(setupCode)
  await page.getByRole('button', { name: 'Enable verification', exact: true }).click()
  await page.getByRole('heading', { name: 'Recovery codes', exact: true }).waitFor({ timeout: 9_000 })
  await verifyRotation(beforeSetup)
  const recovery = await page.getByRole('listitem').filter({ hasText: /^(?:[0-9A-F]{4}-){7}[0-9A-F]{4}$/ }).allTextContents()
  assert.equal(recovery.length, 8)
  await page.getByRole('button', { name: 'Hide recovery codes', exact: true }).click()
  await page.screenshot({ path: join(evidence, 'mfa-enabled.png') })
  await logout()

  phase = 'totp-login'
  assert.equal((await passkey())[20], 2)
  assert.equal((await context.request.get(origin + '/api/v2/identity/session.aeds')).status(), 401)
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
  await logout()
  assert.equal((await passkey())[20], 2)
  assert.equal(await verify(recovery[0]), 401)
  await page.getByText('Verification failed. Use a fresh code or start a new login.').waitFor()
  assert.equal(await verify(recovery[1]), 200)
  await signedIn()

  phase = 'one-use-disable-proof'
  const beforeDisable = await sessionCookie()
  await page.getByRole('link', { name: 'Account security', exact: true }).first().click()
  const disabled = waitApi('/api/binary/auth/mfa/disable')
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(recovery[2])
  await page.getByRole('button', { name: 'Disable authenticator verification', exact: true }).click()
  assert.equal((await disabled).status(), 200)
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).waitFor({ timeout: 9_000 })
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
    responses, faults, exitCode: failure ? 1 : 0,
  }, null, 2))
}
if (failure) throw failure

function readSeed(text) {
  assert.match(text, /^[A-Z2-7]{32}$/)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const letter of text) {
    bits += 5
    value = (value << 5) | alphabet.indexOf(letter)
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 255)
    }
  }
  return Buffer.from(bytes)
}
function totp(secret, step) {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(bytes).digest()
  const offset = mac.at(-1) & 15
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}
