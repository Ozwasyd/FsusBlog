import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { WireHeaders } from '../../src/Contracts/wire.generated.ts'

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
const checks = {}
const inventoryPath = '/api/v2/identity/passkeys.aeds'
const securityPath = '/user/identity/mfa'
let phase = 'start'
let failure
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  monitor(page)
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
  const assertionStarted = Date.now()
  await page.getByRole('button', { name: 'Log in with Passkey', exact: true }).click()
  await page.waitForURL(`${origin}/user/manage/article/write`)
  await page.getByRole('heading', { name: 'New article' }).waitFor()
  const cookie = (await context.cookies()).find(cookie => cookie.name === 'fsus-v2-session')
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.expires === -1)
  const session = await context.request.get(`${origin}/api/v2/identity/session.aeds`)
  assert.equal(session.status(), 200)
  const current = session.headers()[WireHeaders.CurrentSession.toLowerCase()]
  assert(/^[0-9a-f]{64}$/.test(current), 'Expected the active browser session handle.')
  await page.screenshot({ path: join(evidence, 'passkey-signed-in.png') })

  phase = 'credential-inventory'
  const security = await context.newPage()
  monitor(security)
  const listed = security.waitForResponse(response => response.request().method() === 'GET' &&
    response.url() === origin + inventoryPath)
  await security.goto(origin + securityPath)
  const response = await listed
  assert.equal(response.status(), 200)
  assert.equal((await response.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], current)
  assert.match(await response.headerValue('Cache-Control') ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
  const inventory = decodeFrame(await response.body())
  assert.equal(inventory.type, 32980)
  assert.equal(inventory.payload.byteLength, 23, 'One row must expose only its two timestamps and three flags.')
  assert.equal(new DataView(inventory.payload.buffer, inventory.payload.byteOffset).getInt32(0, true), 1)
  const credentials = security.getByRole('region', { name: 'Passkeys', exact: true })
  await credentials.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor()
  const credential = credentials.getByRole('listitem')
  await credential.getByText('Current session passkey', { exact: true }).waitFor()
  await credential.getByText('Created', { exact: true }).waitFor()
  await credential.getByText('Last used', { exact: true }).waitFor()
  await credential.getByText('Backup eligible', { exact: true }).waitFor()
  await credential.getByText('Backed up', { exact: true }).waitFor()
  const times = credential.locator('time')
  assert.equal(await times.count(), 2)
  const createdAt = Date.parse(await times.first().getAttribute('datetime') ?? '')
  const lastUsed = await times.last().getAttribute('datetime')
  const usedAt = Date.parse(lastUsed ?? '')
  assert(createdAt >= Date.parse(start) - 1_000 && createdAt <= usedAt,
    'The created timestamp must precede the login assertion.')
  assert(usedAt >= assertionStarted - 1_000 && usedAt <= Date.now() + 1_000,
    'The displayed last-used timestamp must reflect the completed login assertion.')
  checks.inventory = true
  await security.screenshot({ path: join(evidence, 'passkey-inventory.png') })

  phase = 'logout'
  const logout = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url() === `${origin}/api/v2/identity/sign-out.aeds`)
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await page.waitForURL(`${origin}/`)
  assert.equal((await logout).status(), 200)
  assert.equal((await context.request.get(`${origin}/api/v2/identity/session.aeds`)).status(), 401)
  await security.getByText('to manage account security.', { exact: false }).waitFor()
  assert.equal(await credentials.count(), 0, 'The open tab must clear its passkey inventory after sign-out.')
  const signedOut = await context.request.get(origin + inventoryPath, { headers: { [WireHeaders.CurrentSession]: current } })
  assert.equal(signedOut.status(), 401)
  assert.match(signedOut.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
  checks.signedOutInventoryDenied = true
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
    chromium: browser.version(), phase, checks, responses, errors, exitCode: failure ? 1 : 0 }, null, 2))
}
if (failure) throw failure

function monitor(page) {
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/')) responses.push([url.pathname, response.status()])
  })
}
