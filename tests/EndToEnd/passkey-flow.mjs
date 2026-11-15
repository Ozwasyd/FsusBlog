import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeEnrollmentBegin } from '../../src/Contracts/passkey.ts'
import { decodeSitePasskeyManagement } from '../../src/Contracts/site-passkey-names.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

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
const inventoryPath = WireRoutes.SitePasskeys
const managementPath = WireRoutes.SitePasskeyManagement
const renameRequired = process.env.FSUSBLOG_TEST_PASSKEY_RENAME === '1'
const enrollmentRequired = process.env.FSUSBLOG_TEST_PASSKEY_ENROLL === '1'
const friendlyName = 'Writing laptop 🔐'
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
  const firstDevice = await addAuthenticator(cdp)
  let secondCreatedAt

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
  const sessionHeaders = { [WireHeaders.CurrentSession]: current }
  const response = await context.request.get(origin + inventoryPath, { headers: sessionHeaders })
  assert.equal(response.status(), 200)
  assert.match(response.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
  const inventory = decodeFrame(await response.body())
  assert.equal(inventory.type, FrameType.SitePasskeys)
  assert.equal(inventory.payload.byteLength, 23, 'One row must expose only its two timestamps and three flags.')
  assert.equal(new DataView(inventory.payload.buffer, inventory.payload.byteOffset).getInt32(0, true), 1)

  const managed = page.waitForResponse(response => response.request().method() === 'GET' &&
    response.url() === origin + managementPath)
  await page.goto(origin + securityPath)
  const management = await managed
  assert([200, 404].includes(management.status()), 'Expected the current management inventory or a legacy fallback.')
  assert.equal((await management.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], current)
  if (management.status() === 200) {
    assert.match(await management.headerValue('Cache-Control') ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
    assert.equal(decodeFrame(await management.body()).type, FrameType.SitePasskeyManagement)
  }
  const inventoryRegion = page.getByRole('region', { name: 'Passkeys', exact: true })
  await inventoryRegion.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor()
  const credential = inventoryRegion.getByRole('listitem')
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
  await page.screenshot({ path: join(evidence, 'passkey-inventory.png') })

  if (renameRequired) {
    phase = 'credential-rename'
    assert.equal(management.status(), 200)
    await credential.getByRole('button', { name: 'Rename Passkey', exact: true }).click()
    const field = credential.getByLabel('Passkey name', { exact: true })
    const save = credential.getByRole('button', { name: 'Save with Passkey', exact: true })
    assert(await save.isDisabled(), 'A blank name cannot be submitted.')
    await field.fill(friendlyName)
    const mutation = path => page.waitForResponse(response => response.request().method() === 'POST' && response.url() === origin + path)
    const began = mutation(WireRoutes.SitePasskeyRenameBegin)
    const completed = mutation(WireRoutes.SitePasskeyRenameComplete)
    await save.click()
    for (const mutationResponse of await Promise.all([began, completed])) {
      assert.equal(mutationResponse.status(), 200)
      assert.equal((await mutationResponse.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], current)
      assert.match(await mutationResponse.headerValue('Cache-Control') ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
    }
    await inventoryRegion.getByRole('status').filter({ hasText: /^Passkey name saved\.$/ }).waitFor()
    await credential.getByText(friendlyName, { exact: true }).waitFor()
    await credential.getByText('Current session passkey', { exact: true }).waitFor()
    await page.reload()
    await credential.getByText(friendlyName, { exact: true }).waitFor()
    await page.screenshot({ path: join(evidence, 'passkey-renamed.png') })
    checks.renameWithPasskey = true
  } else if (management.status() === 404) {
    assert.equal(await credential.getByRole('button', { name: 'Rename Passkey', exact: true }).count(), 0)
  }

  if (enrollmentRequired) {
    phase = 'credential-enrollment'
    assert.equal(management.status(), 200)
    const [first] = await readManagement(context, current)
    const approve = origin + WireRoutes.SitePasskeyEnrollApprove
    let switched = false
    async function switchDevice(route) {
      const approved = await route.fetch({ maxRedirects: 0 })
      if (approved.status() === 200) {
        assert(!switched, 'The browser approved enrollment more than once.')
        await cdp.send('WebAuthn.removeVirtualAuthenticator', firstDevice)
        await addAuthenticator(cdp)
        switched = true
      }
      await route.fulfill({ response: approved })
    }
    await page.route(approve, switchDevice)
    try {
      const frames = [
        [WireRoutes.SitePasskeyEnrollBegin, FrameType.PasskeyLoginBegin],
        [WireRoutes.SitePasskeyEnrollApprove, FrameType.PasskeyRegisterBegin],
        [WireRoutes.SitePasskeyEnrollComplete, FrameType.EmptySuccess],
      ]
      const writes = frames.map(([path]) => page.waitForResponse(response =>
        response.request().method() === 'POST' && response.url() === origin + path))
      await inventoryRegion.getByRole('button', { name: 'Add Passkey', exact: true }).click()
      const enrollmentResults = await Promise.all(writes)
      for (const [index, result] of enrollmentResults.entries()) {
        assert.equal(result.status(), 200)
        assert((await result.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()] === current,
          'Enrollment must carry the current session handle at every stage.')
        assert.match(await result.headerValue('Cache-Control') ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
        const frame = decodeFrame(await result.body())
        assert.equal(frame.type, frames[index][1])
        if (frame.type === FrameType.PasskeyRegisterBegin) {
          const { options } = decodeEnrollmentBegin(frame.payload)
          assert.equal(options.excludeCredentials.length, 1, 'Enrollment must not replace the existing authenticator credential.')
        }
      }
      for (const accepted of enrollmentResults.slice(1)) {
        const original = accepted.request()
        const repeated = await context.request.post(original.url(), {
          headers: { ...sessionHeaders, Origin: origin, 'Content-Type': 'application/octet-stream' },
          data: original.postDataBuffer(),
        })
        assert.equal(repeated.status(), 401, 'A completed enrollment ceremony cannot be used twice.')
        assert.match(repeated.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
      }
      checks.enrollmentReplayDenied = true
      assert(switched, 'A second virtual authenticator must create the new Passkey.')
      await inventoryRegion.getByRole('status').filter({ hasText: /^Passkey added\.$/ }).waitFor()
      assert.equal(await inventoryRegion.getByRole('listitem').count(), 2)
      const enrolled = await readManagement(context, current)
      assert.equal(enrolled.length, 2)
      assert(enrolled[0].current && enrolled[0].reference === first.reference,
        'Enrollment must leave the original credential active in the current session.')
      assert(!enrolled[1].current && enrolled[1].reference !== first.reference)
      assert.equal(enrolled[1].lastUsedAt, null)
      secondCreatedAt = enrolled[1].createdAt.getTime()
      assert(secondCreatedAt > first.createdAt.getTime())
      checks.enrollmentWithCurrentPasskey = true
      await page.screenshot({ path: join(evidence, 'passkey-enrolled.png') })
    } finally {
      await page.unroute(approve, switchDevice)
    }
  }

  const security = await context.newPage()
  monitor(security)
  await security.goto(origin + securityPath)
  const credentials = security.getByRole('region', { name: 'Passkeys', exact: true })
  await credentials.getByText(renameRequired ? friendlyName : 'Current session passkey', { exact: true }).waitFor()

  phase = 'logout'
  const logout = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url() === `${origin}/api/v2/identity/sign-out.aeds`)
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  await page.waitForURL(`${origin}/`)
  assert.equal((await logout).status(), 200)
  assert.equal((await context.request.get(`${origin}/api/v2/identity/session.aeds`)).status(), 401)
  await security.getByText('to manage account security.', { exact: false }).waitFor()
  assert.equal(await credentials.count(), 0, 'The open tab must clear its passkey inventory after sign-out.')
  assert.equal(await security.getByText(friendlyName, { exact: true }).count(), 0)
  const signedOut = await context.request.get(origin + inventoryPath, { headers: { [WireHeaders.CurrentSession]: current } })
  assert.equal(signedOut.status(), 401)
  assert.match(signedOut.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
  if (renameRequired) {
    const signedOutManagement = await context.request.get(origin + managementPath, { headers: sessionHeaders })
    assert.equal(signedOutManagement.status(), 401)
    assert.match(signedOutManagement.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
    checks.signedOutManagementDenied = true
  }
  checks.signedOutInventoryDenied = true
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-session'))
  assert(!(await context.cookies()).some(cookie => cookie.name === 'fsus-v2-passkey-ceremony'))
  if (enrollmentRequired) {
    phase = 'second-device-assertion'
    await page.goto(origin + '/login')
    const signIn = page.waitForResponse(response => response.request().method() === 'POST' &&
      response.url() === origin + WireRoutes.PasskeyLoginComplete)
    await page.getByRole('button', { name: 'Log in with Passkey', exact: true }).click()
    await page.waitForURL(`${origin}/user/manage/article/write`)
    assert.equal((await signIn).status(), 200)
    const renewed = await context.request.get(`${origin}/api/v2/identity/session.aeds`)
    assert.equal(renewed.status(), 200)
    const next = renewed.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(/^[0-9a-f]{64}$/.test(next) && next !== current, 'The second device must start a new session.')
    const entries = await readManagement(context, next)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].createdAt.getTime(), secondCreatedAt)
    assert(entries[0].current && entries[0].lastUsedAt !== null,
      'The newly enrolled credential must authenticate the second session.')
    checks.secondPasskeySignIn = true
  }
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

function addAuthenticator(cdp) {
  return cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })
}

async function readManagement(context, currentSession) {
  const result = await context.request.get(origin + managementPath, {
    headers: { [WireHeaders.CurrentSession]: currentSession },
  })
  assert.equal(result.status(), 200)
  assert.match(result.headers()['cache-control'] ?? '', /(?:^|,\s*)no-store(?:,|$)/i)
  const data = decodeFrame(await result.body())
  assert.equal(data.type, FrameType.SitePasskeyManagement)
  return decodeSitePasskeyManagement(data.payload)
}

function monitor(page) {
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/')) responses.push([url.pathname, response.status()])
  })
}
