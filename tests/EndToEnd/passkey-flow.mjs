import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const requireWeb = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = requireWeb('@playwright/test')
const origin = process.env.FSUSBLOG_TEST_PASSKEY_URL
const ticket = process.env.FSUSBLOG_TEST_PASSKEY_TICKET
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/passkey-browser')
assert(origin && ticket, 'Provide an isolated Passkey-enabled V2 origin and one unused provisioning ticket.')
await mkdir(evidence, { recursive: true })

const start = new Date().toISOString()
const responses = []
const errors = []
let phase = 'start'
let failure
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/')) responses.push([url.pathname, response.status()])
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })

  phase = 'provision'
  await page.goto(`${origin}/login`)
  await page.getByRole('button', { name: 'Create Passkey', exact: true }).waitFor()
  await page.getByLabel('Owner access key').fill(ticket)
  await page.getByRole('button', { name: 'Create Passkey', exact: true }).click()
  await page.getByText('Passkey created. Log in with your Passkey.', { exact: true }).waitFor({ timeout: 10_000 })
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert.equal(await page.getByLabel('Owner access key').inputValue(), '')
  await page.screenshot({ path: join(evidence, 'passkey-created.png') })

  phase = 'assertion'
  await page.getByRole('button', { name: 'Log in with Passkey', exact: true }).click()
  await page.waitForURL(`${origin}/user/manage/article/write`)
  await page.getByRole('heading', { name: 'New article' }).waitFor()
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'fsus-v2-session')
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.expires === -1)
  assert.equal((await context.request.get(`${origin}/api/v2/identity/session.aeds`)).status(), 200)
  await page.screenshot({ path: join(evidence, 'passkey-signed-in.png') })

  phase = 'logout'
  const logout = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url() === `${origin}/api/v2/identity/sign-out.aeds`)
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await page.waitForURL(`${origin}/`)
  assert.equal((await logout).status(), 200)
  assert.equal((await context.request.get(`${origin}/api/v2/identity/session.aeds`)).status(), 401)
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-passkey-ceremony'))
  assert.deepEqual(errors, [])
  assert(responses.some(([path, status]) => path === '/api/binary/auth/passkey/login/complete' && status === 200))
  assert(responses.some(([path, status]) => path === '/api/v2/identity/passkey/register/complete.aeds' && status === 200))
  phase = 'passed'
} catch (error) {
  // Browser and HTTP evidence omit provisioning secrets and credential bodies.
  failure = error
} finally {
  await browser.close()
  await writeFile(join(evidence, 'passkey-result.json'), JSON.stringify({ origin, start, end: new Date().toISOString(),
    chromium: browser.version(), phase, responses, errors, exitCode: failure ? 1 : 0 }, null, 2))
}
if (failure) throw failure
