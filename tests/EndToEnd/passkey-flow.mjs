import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeEnrollmentBegin } from '../../src/Contracts/passkey.ts'
import { decodeSitePasskeyManagement, encodeSitePasskeyRemove } from '../../src/Contracts/site-passkey-names.ts'
import { encodeSignIn, FrameType, WireHeaders, WireRoutes as R } from '../../src/Contracts/wire.generated.ts'
import { postBinary } from './admin-workspace-fixture.mjs'
import { postFrame } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as res from './response-status-fixture.mjs'
import * as loc from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'

const { expect } = auth
const origin = process.env.FSUSBLOG_TEST_PASSKEY_URL
const ticket = process.env.FSUSBLOG_TEST_PASSKEY_TICKET
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/passkey-browser')
assert(origin && ticket, 'Provide an isolated Passkey-enabled V2 origin and one unused provisioning ticket.')

const start = new Date().toISOString()
const responses = [], errors = [], checks = {}
const renameRequired = process.env.FSUSBLOG_TEST_PASSKEY_RENAME === '1'
const removeCurrent = process.env.FSUSBLOG_TEST_PASSKEY_REMOVE_CURRENT === '1'
const removalRequired = removeCurrent || process.env.FSUSBLOG_TEST_PASSKEY_REMOVE === '1'
const removalRollbackRequired = process.env.FSUSBLOG_TEST_PASSKEY_REMOVE_ROLLBACK === '1'
assert(!removalRollbackRequired || (removalRequired && !removeCurrent), 'Use remove-other mode to verify database rollback.')
const enrollmentRequired = removalRequired || process.env.FSUSBLOG_TEST_PASSKEY_ENROLL === '1'
const friendlyName = 'Writing laptop 🔐'
const securityPath = '/user/identity/mfa'
const sessionHeader = WireHeaders.CurrentSession.toLowerCase()
let phase = 'start'
const browser = await auth.launchIdentityBrowser()

function monitor(page) {
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin === origin && url.pathname.startsWith('/api/')) responses.push([url.pathname, response.status()])
  })
}

async function readManagement(context, currentSession) {
  const result = await context.request.get(origin + R.SitePasskeyManagement, { headers: { [WireHeaders.CurrentSession]: currentSession } })
  return res.readNoStoreFrame(result, FrameType.SitePasskeyManagement, decodeSitePasskeyManagement)
}

// Browser and HTTP evidence omit provisioning secrets and credential bodies.
await isolated.withBrowserEvidence(browser, evidence, 'passkey-result.json', failure => ({
  origin, start, end: new Date().toISOString(), chromium: browser.version(), phase, checks, responses, errors,
  exitCode: failure ? 1 : 0,
}), async () => {
  const context = await isolated.openLocaleContext(browser, origin, { viewport: { width: 1280, height: 800 } })
  context.setDefaultTimeout(30_000)
  const page = await context.newPage()
  monitor(page)
  const { cdp, authenticatorId: firstAuthenticatorId } = await auth.enableAuthenticator(context, page)
  const waitPost = path => page.waitForResponse(response => response.request().method() === 'POST' && response.url() === origin + path)
  const sessionCookie = () => auth.findCookie(context, origin, 'fsus-v2-session')
  const shot = filename => isolated.saveShot(page, evidence, filename, {})
  let secondCreatedAt

  phase = 'ticket-cannot-sign-in'
  const deniedTicket = await postFrame(context.request, origin + R.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }))
  res.assertStatus(deniedTicket, 401)
  assert.equal(deniedTicket.headers()['set-cookie'], undefined)
  assert(!await sessionCookie())
  checks.setupTicketCannotSignIn = true

  phase = 'provision'
  await page.goto(`${origin}/login`)
  await expect(loc.exactButton(page, 'Log in with Passkey')).toBeVisible()
  const setupTicket = loc.exactLabel(page, 'One-time setup ticket')
  await expect(setupTicket).toHaveCount(0)
  await expect(loc.exactButton(page, 'Create Passkey')).toHaveCount(0)
  await loc.exactText(page, 'Set up your first Passkey').click()
  await setupTicket.fill(ticket)
  await loc.exactButton(page, 'Create Passkey').click()
  await loc.exactText(page, 'Passkey created. Log in with your Passkey.').waitFor({ timeout: 10_000 })
  assert(!await sessionCookie())
  await expect(setupTicket).toHaveCount(0)
  checks.rejectedTicketStillProvisionsWithoutSession = true
  await shot('passkey-created.png')

  phase = 'assertion'
  const assertionStarted = Date.now()
  await loc.exactButton(page, 'Log in with Passkey').click()
  await page.waitForURL(origin + securityPath)
  checks.passkeyLoginAfterProvision = true
  await loc.exactHeading(page, 'Account').waitFor()
  const cookie = await sessionCookie()
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.expires === -1)
  const current = await auth.readSessionHandle(context, origin)
  await shot('passkey-signed-in.png')

  phase = 'credential-inventory'
  const sessionHeaders = { [WireHeaders.CurrentSession]: current }
  const response = await context.request.get(origin + R.SitePasskeys, { headers: sessionHeaders })
  const inventoryPayload = await res.readNoStoreFrame(response, FrameType.SitePasskeys)
  assert.equal(inventoryPayload.byteLength, 23, 'One row must expose only its two timestamps and three flags.')
  assert.equal(new DataView(inventoryPayload.buffer, inventoryPayload.byteOffset).getInt32(0, true), 1)

  const managed = page.waitForResponse(reply => reply.request().method() === 'GET' && reply.url() === origin + R.SitePasskeyManagement)
  await page.goto(origin + securityPath)
  const management = await managed
  assert([200, 404].includes(management.status()), 'Expected the current management inventory or a legacy fallback.')
  assert.equal((await management.request().allHeaders())[sessionHeader], current)
  if (management.status() === 200) await res.readNoStoreFrame(management, FrameType.SitePasskeyManagement)
  const inventoryRegion = loc.exactRegion(page, 'Passkeys')
  await loc.exactHeading(inventoryRegion, 'Passkeys').waitFor()
  const credential = inventoryRegion.getByRole('listitem')
  for (const label of ['Current session passkey', 'Created', 'Last used', 'Backup eligible', 'Backed up'])
    await loc.exactText(credential, label).waitFor()
  const times = credential.locator('time')
  assert.equal(await times.count(), 2)
  const createdAt = Date.parse(await times.first().getAttribute('datetime') ?? '')
  const usedAt = Date.parse(await times.last().getAttribute('datetime') ?? '')
  assert(createdAt >= Date.parse(start) - 1_000 && createdAt <= usedAt, 'The created timestamp must precede the login assertion.')
  assert(usedAt >= assertionStarted - 1_000 && usedAt <= Date.now() + 1_000, 'The displayed last-used timestamp must reflect the completed login assertion.')
  checks.inventory = true
  await shot('passkey-inventory.png')

  if (renameRequired) {
    phase = 'credential-rename'
    res.assertStatus(management, 200)
    await loc.exactButton(credential, 'Rename Passkey').click()
    const save = loc.exactButton(credential, 'Save with Passkey')
    assert(await save.isDisabled(), 'A blank name cannot be submitted.')
    await loc.exactLabel(credential, 'Passkey name').fill(friendlyName)
    const began = waitPost(R.SitePasskeyRenameBegin), completed = waitPost(R.SitePasskeyRenameComplete)
    await save.click()
    for (const mutationResponse of await Promise.all([began, completed])) {
      res.assertStatus(mutationResponse, 200)
      await auth.assertBoundNoStore(mutationResponse, current)
    }
    await inventoryRegion.getByRole('status').filter({ hasText: /^Passkey name saved\.$/ }).waitFor()
    const expectRenamed = async file => {
      await loc.exactText(credential, friendlyName).waitFor()
      await loc.exactText(credential, 'Current session passkey').waitFor()
      await shot(file)
    }
    await expectRenamed('passkey-renamed-live.png')
    await page.reload()
    await expectRenamed('passkey-renamed.png')
    checks.renameWithPasskey = true
  } else if (management.status() === 404) {
    assert.equal(await loc.exactButton(credential, 'Rename Passkey').count(), 0)
  }

  if (enrollmentRequired) {
    phase = 'credential-enrollment'
    res.assertStatus(management, 200)
    const [first] = await readManagement(context, current)
    const approve = origin + R.SitePasskeyEnrollApprove
    let switched = false
    async function switchDevice(route) {
      const approved = await route.fetch({ maxRedirects: 0 })
      if (approved.status() === 200) {
        assert(!switched, 'The browser approved enrollment more than once.')
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: firstAuthenticatorId })
        await auth.addAuthenticator(cdp)
        switched = true
      }
      await route.fulfill({ response: approved })
    }
    await page.route(approve, switchDevice)
    try {
      const frames = [
        [R.SitePasskeyEnrollBegin, FrameType.PasskeyLoginBegin],
        [R.SitePasskeyEnrollApprove, FrameType.PasskeyRegisterBegin],
        [R.SitePasskeyEnrollComplete, FrameType.EmptySuccess],
      ]
      const writes = frames.map(([path]) => waitPost(path))
      await loc.exactButton(inventoryRegion, 'Add Passkey').click()
      const enrollmentResults = await Promise.all(writes)
      for (const [index, result] of enrollmentResults.entries()) {
        await auth.assertBoundNoStore(result, current, 'Enrollment must carry the current session handle at every stage.')
        const payload = await res.readFrame(result, frames[index][1])
        if (frames[index][1] === FrameType.PasskeyRegisterBegin) {
          assert.equal(decodeEnrollmentBegin(payload).options.excludeCredentials.length, 1, 'Enrollment must not replace the existing authenticator credential.')
        }
      }
      for (const accepted of enrollmentResults.slice(1)) {
        const original = accepted.request()
        const repeated = await postBinary(context.request, original.url(), origin, original.postDataBuffer(), sessionHeaders)
        res.assertStatus(repeated, 401, 'A completed enrollment ceremony cannot be used twice.')
        await res.assertNoStore(repeated)
      }
      checks.enrollmentReplayDenied = true
      assert(switched, 'A second virtual authenticator must create the new Passkey.')
      await inventoryRegion.getByRole('status').filter({ hasText: /^Passkey added\.$/ }).waitFor()
      assert.equal(await inventoryRegion.getByRole('listitem').count(), 2)
      const enrolled = await readManagement(context, current)
      assert.equal(enrolled.length, 2)
      assert(enrolled[0].current && enrolled[0].reference === first.reference, 'Enrollment must leave the original credential active in the current session.')
      assert(!enrolled[1].current && enrolled[1].reference !== first.reference)
      assert.equal(enrolled[1].lastUsedAt, null)
      secondCreatedAt = enrolled[1].createdAt.getTime()
      assert(secondCreatedAt > first.createdAt.getTime())
      checks.enrollmentWithCurrentPasskey = true
      await shot('passkey-enrolled.png')
    } finally { await page.unroute(approve, switchDevice) }
  }

  const surviving = removeCurrent ? await browser.newContext() : null
  if (surviving) {
    await surviving.addCookies([cookie])
    await context.clearCookies({ name: 'fsus-v2-session' })
  } else {
    const security = await context.newPage()
    monitor(security)
    await security.goto(origin + securityPath)
    const credentials = loc.exactRegion(security, 'Passkeys')
    await loc.exactText(credentials, renameRequired ? friendlyName : 'Current session passkey').waitFor()

    phase = 'logout'
    const logout = waitPost(R.SignOut)
    await loc.exactButton(page, 'Log out').click()
    await page.waitForURL(`${origin}/`)
    res.assertStatus(await logout, 200)
    await res.assertGetStatus(context.request, origin + R.Session, 401)
    await security.getByText('to manage your account.', { exact: false }).waitFor()
    assert.equal(await credentials.count(), 0, 'The open tab must clear its passkey inventory after sign-out.')
    assert.equal(await loc.exactText(security, friendlyName).count(), 0)
    for (const path of [R.SitePasskeys, ...(renameRequired ? [R.SitePasskeyManagement] : [])]) {
      const denied = await context.request.get(origin + path, { headers: sessionHeaders })
      res.assertStatus(denied, 401)
      await res.assertNoStore(denied)
    }
    if (renameRequired) checks.signedOutManagementDenied = true
    checks.signedOutInventoryDenied = true
    assert(!await sessionCookie())
    assert(!await auth.findCookie(context, origin, 'fsus-v2-passkey-ceremony'))
  }
  if (enrollmentRequired) {
    phase = 'second-device-assertion'
    await page.goto(origin + '/login')
    const signIn = waitPost(R.PasskeyLoginComplete)
    await loc.exactButton(page, 'Log in with Passkey').click()
    await page.waitForURL(origin + securityPath)
    res.assertStatus(await signIn, 200)
    const next = await auth.readSessionHandle(context, origin)
    assert(next !== current, 'The second device must start a new session.')
    const entries = await readManagement(context, next)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].createdAt.getTime(), secondCreatedAt)
    assert(entries[0].current && entries[0].lastUsedAt !== null, 'The newly enrolled credential must authenticate the second session.')
    checks.secondPasskeySignIn = true
    if (removalRequired) {
      phase = 'credential-removal'
      await page.goto(origin + securityPath)
      const rows = inventoryRegion.getByRole('listitem')
      const selectedIndex = removeCurrent ? 0 : 1
      const selected = rows.nth(selectedIndex)
      await loc.exactText(rows.first(), 'Current session passkey').waitFor()
      const remove = loc.exactButton(selected, removeCurrent ? 'Remove current Passkey' : 'Remove Passkey')
      const confirm = loc.exactButton(selected, 'Remove with Passkey')
      const confirmation = !removeCurrent && renameRequired ? `Remove ${friendlyName}?` : /^Remove .+\?$/
      assert.equal(await loc.exactButton(rows.first(), 'Remove Passkey').count(), 0)
      const removedCookie = removeCurrent && await sessionCookie()

      let starts = 0
      const observeStart = request => {
        if (request.method() === 'POST' && request.url() === origin + R.SitePasskeyRemoveBegin) starts++
      }
      page.on('request', observeStart)
      try {
        await remove.click()
        await selected.getByText(confirmation).waitFor()
        await loc.exactButton(selected, 'Cancel').click()
        await confirm.waitFor({ state: 'hidden' })
        assert.equal(starts, 0, 'Opening and canceling confirmation must not start approval.')
        assert.equal(await rows.count(), 2)
      } finally { page.off('request', observeStart) }
      checks.removalRequiresConfirmation = true

      await remove.click()
      const began = waitPost(R.SitePasskeyRemoveBegin), completed = waitPost(R.SitePasskeyRemoveComplete)
      await confirm.click()
      const [begin, complete] = await Promise.all([began, completed])
      for (const [result, status, type] of [[begin, 200, FrameType.PasskeyLoginBegin],
        removalRollbackRequired ? [complete, 503, FrameType.ApiError] : [complete, 200, FrameType.EmptySuccess]]) {
        await auth.assertBoundNoStore(result, next, 'Removal must carry the newly signed-in device session handle.')
        await res.readFrame(result, type, null, status)
      }
      const target = Buffer.from(decodeFrame(begin.request().postDataBuffer(), FrameType.SitePasskeyRemove).payload)
      assert.equal(target.length, 40)
      assert(target.subarray(0, 32).toString('hex') === entries[selectedIndex].reference && target.readBigInt64LE(32) === entries[selectedIndex].revision,
        'Approval must address the selected device and its displayed revision.')
      if (removalRollbackRequired) {
        await loc.exactText(inventoryRegion, 'Could not confirm Passkey removal. Reload Passkeys to check.').waitFor()
        await loc.exactButton(inventoryRegion, 'Reload Passkeys').click()
        await loc.exactButton(selected, 'Remove Passkey').waitFor()
        assert.equal(await rows.count(), 2)
      } else if (removeCurrent) {
        await inventoryRegion.waitFor({ state: 'hidden' })
        assert(!await sessionCookie())
        assert(removedCookie && surviving, 'Both independent device sessions must have existed before removal.')
        await auth.assertStaleSessionRejected(origin, [removedCookie])
        const remainingRows = await readManagement(surviving, current)
        assert.equal(remainingRows.length, 1)
        const [remaining] = remainingRows
        assert(remaining.current && remaining.createdAt.getTime() === createdAt)
        res.assertStatus(await postBinary(surviving.request, origin + R.SitePasskeyRemoveBegin, origin,
          Buffer.from(encodeSitePasskeyRemove(remaining.reference, remaining.revision)), sessionHeaders), 409)
        checks.removalRevokedCurrentSession = true
        checks.otherSessionSurvived = true
        checks.ordinaryLastRemovalDenied = true
      } else {
        res.assertStatus(await postBinary(context.request, complete.url(), origin, complete.request().postDataBuffer(),
          { [WireHeaders.CurrentSession]: next }), 401, 'The completed removal cannot be used twice.')
        await inventoryRegion.getByRole('status').filter({ hasText: /^Passkey removed\.$/ }).waitFor()
        assert.equal(await rows.count(), 1)
        assert.equal(await loc.exactButton(inventoryRegion, 'Remove Passkey').count(), 0)
        checks.removalReplayDenied = true
      }
      if (!removeCurrent) {
        assert.equal(await auth.readSessionHandle(context, origin), next, 'The current session must survive removal.')
        const remaining = await readManagement(context, next)
        if (removalRollbackRequired) {
          assert(remaining.length === 2 && remaining.every((item, i) => item.reference === entries[i].reference &&
            item.current === entries[i].current && item.revision === entries[i].revision && item.name === entries[i].name &&
            item.lastUsedAt?.getTime() === entries[i].lastUsedAt?.getTime()), 'The failed removal must leave both devices unchanged.')
          checks.removalRolledBack = true
        } else {
          assert.equal(remaining.length, 1)
          assert(remaining[0].current && remaining[0].reference === entries[0].reference, 'Only the second device must remain after removing the first.')
          checks.removeOtherPasskey = true
          await shot('passkey-removed.png')
        }
      }
    }
  }
  assert.deepEqual(errors, [])
  assert(responses.some(([path, status]) => path === '/api/binary/auth/passkey/login/complete' && status === 200))
  assert(responses.some(([path, status]) => path === '/api/v2/identity/passkey/register/complete.aeds' && status === 200))
  phase = 'passed'
}, { mkdir: true })
