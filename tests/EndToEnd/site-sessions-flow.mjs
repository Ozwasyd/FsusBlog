import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { saveShot, withBrowserEvidence, withTempContext } from './isolated-browser-fixture.mjs'
import { assertEmpty, assertNoStore, assertStatus } from './response-status-fixture.mjs'
import { exactButton, exactHeading, exactText } from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'
import { enableAuthenticator, signInFreshSite, signInWithSitePasskey } from './webauthn-fixture.mjs'

const url = process.env.FSUSBLOG_TEST_SESSIONS_URL
const ticketInput = process.env.FSUSBLOG_TEST_SESSIONS_TICKETS
assert(url && ticketInput, 'Provide an isolated v2 URL and two one-use Passkey setup tickets.')
const origin = new URL(url).origin
assert.equal(new URL(origin).hostname, 'localhost', 'This fixture uses only generated localhost Passkeys.')
const tickets = JSON.parse(ticketInput)
const handleFormat = /^[0-9a-f]{64}$/
assert(Array.isArray(tickets) && tickets.length === 2 && tickets.every(ticket => handleFormat.test(ticket)) &&
  new Set(tickets).size === 2, 'Provide one unused setup ticket per reader account.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-sessions-browser')

const identity = '/api/v2/identity', currentPath = identity + '/session.aeds', listPath = identity + '/sessions.aeds'
const bulkPath = identity + '/sessions/revoke-others.aeds', securityPath = '/user/identity/mfa'
const currentHeader = 'X-Fsus-Current-Session', sessionCookie = 'fsus-v2-session'
const diagnostics = [], responses = [], checks = {}
const startedAt = new Date().toISOString()
const browser = await auth.launchIdentityBrowser()
const chromiumVersion = browser.version()
let phase = 'sign-in'

const current = session => ({ [currentHeader]: session.handle })
const revokePath = handle => `${identity}/sessions/${handle}/revoke.aeds`
const revokeButtons = page => exactButton(page, 'Revoke session')
const bulkButton = page => exactButton(page, 'Revoke other sessions')
const clean = text => text.replace(/[0-9a-f]{64}/gi, '[session-coordinate]')
const assertNotCredential = (artifact, sessions) => auth.assertNoCredentialLeak(artifact, sessions.map(s => s.cookie.value))
const expectCurrent = async (session, status) => assertStatus(await session.context.request.get(origin + currentPath), status)

await withBrowserEvidence(browser, evidence, 'site-sessions-result.json', failure => ({
  origin, startedAt, endedAt: new Date().toISOString(), chromium: chromiumVersion, phase, checks, responses, diagnostics,
  exitCode: failure ? 1 : 0,
}), async () => {
  const primary = await signIn('primary', { ticket: tickets[0] })
  const peer = await signIn('peer', { device: primary.authenticator }, { width: 375, height: 850 })
  const remaining = await signIn('remaining', { device: peer.authenticator })
  const foreign = await signIn('foreign', { ticket: tickets[1] })
  const allSessions = [primary, peer, remaining, foreign]
  assert.equal(new Set(allSessions.map(session => session.handle)).size, 4)
  const ownedSessions = [primary.handle, peer.handle, remaining.handle]

  phase = 'list'
  await openSecurity(primary)
  await openSecurity(peer)
  assert.deepEqual(new Set((await getSessions(primary, allSessions)).map(row => row.id)), new Set(ownedSessions))
  assert.deepEqual((await getSessions(foreign, allSessions)).map(row => row.id), [foreign.handle])
  assert.equal(await revokeButtons(primary.page).count(), 2)
  assert.equal(await revokeButtons(peer.page).count(), 2)
  await saveShot(primary.page, evidence, 'desktop-sessions.png', {})
  await saveShot(peer.page, evidence, 'mobile-sessions.png', {})
  checks.separateAccountLists = true
  checks.rawCredentialsAbsent = true

  phase = 'mutation-authorization'
  const rejectRevocation = async (handle, status, message) =>
    assertStatus(await primary.context.request.post(origin + revokePath(handle), { headers: current(primary) }), status, message)
  await rejectRevocation(foreign.handle, 404, 'A foreign session must be indistinguishable from an unknown session.')
  await rejectRevocation(randomBytes(32).toString('hex'), 404, 'Unknown sessions must return the same status as foreign sessions.')
  await rejectRevocation(primary.handle, 409, 'The current browser session has its own sign-out action.')
  let response = await primary.context.request.post(origin + bulkPath, {
    headers: { ...current(primary), Origin: 'https://cross-origin.invalid' },
  })
  assertStatus(response, 403, 'Session mutations must reject a foreign origin.')
  response = await primary.context.request.post(origin + bulkPath)
  assert(response.status() >= 400 && response.status() < 500, 'Mutations require a current-session precondition.')
  await withTempContext(browser, async anonymous =>
    assertStatus(await anonymous.request.get(origin + listPath, { headers: current(primary) }), 401, 'A session handle alone does not authenticate.'))
  checks.foreignAndCurrentRevocationDenied = true
  checks.crossOriginMutationDenied = true
  checks.sessionHandleIsNotCredential = true

  phase = 'stale-tab'
  for (const replacement of [peer, foreign]) {
    await primary.context.clearCookies({ name: sessionCookie })
    await primary.context.addCookies([replacement.cookie])
    response = await clickMutation(primary.page, bulkButton(primary.page), path => path === bulkPath)
    assertStatus(response, 409, 'A page pinned to its prior browser session must reject a replacement cookie.')
    await primary.page.getByRole('alert').filter({ hasText: 'The current browser session changed. Reload this page.' }).waitFor()
    assert.equal(await revokeButtons(primary.page).count(), 0)
    await primary.context.clearCookies({ name: sessionCookie })
    await primary.context.addCookies([primary.cookie])
    await openSecurity(primary)
  }
  assert.equal((await getSessions(foreign, allSessions)).length, 1)
  assert.deepEqual(new Set((await getSessions(peer, allSessions)).map(row => row.id)), new Set(ownedSessions))
  checks.stalePageRejected = true

  phase = 'single-revocation'
  response = await clickMutation(primary.page, revokeButtons(primary.page).first(),
    path => path.startsWith(identity + '/sessions/') && path.endsWith('/revoke.aeds'))
  await assertEmpty(response)
  const target = new URL(response.url()).pathname.split('/').at(-2)
  const revoked = [peer, remaining].find(session => session.handle === target)
  assert(revoked, 'The UI must address one of the other sessions for this account.')
  const survivor = revoked === peer ? remaining : peer
  await expectCurrent(revoked, 401)
  await expectCurrent(survivor, 200)
  await revokeButtons(primary.page).nth(1).waitFor({ state: 'hidden' })
  assert.equal(await revokeButtons(primary.page).count(), 1)
  checks.individualCookieRevoked = true

  phase = 'bulk-revocation'
  await assertEmpty(await clickMutation(primary.page, bulkButton(primary.page), path => path === bulkPath))
  await expectCurrent(survivor, 401)
  await expectCurrent(foreign, 200)
  await expectCurrent(primary, 200)
  assert.deepEqual((await getSessions(primary, allSessions)).map(row => row.id), [primary.handle])
  await revokeButtons(primary.page).first().waitFor({ state: 'hidden' })
  await exactText(primary.page, 'This browser').waitFor({ state: 'visible' })
  await saveShot(primary.page, evidence, 'after-revocation.png', {})
  checks.bulkPreservedCurrentAndForeign = true

  for (const session of [primary, foreign]) assertStatus(await session.context.request.post(origin + identity + '/sign-out.aeds'), 200)
  assert.deepEqual(diagnostics, [])
  phase = 'passed'
}, { mkdir: true })

async function signIn(name, { ticket, device }, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport })
  context.setDefaultTimeout(15_000)
  const page = await context.newPage()
  page.on('pageerror', error => diagnostics.push({ name, kind: 'uncaught', message: clean(error.message) }))
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:'))
      diagnostics.push({ name, kind: 'console', message: clean(message.text()) })
  })
  page.on('response', response => {
    const responseUrl = new URL(response.url())
    if (responseUrl.origin !== origin) return
    const path = clean(responseUrl.pathname)
    if (path.startsWith(identity + '/')) responses.push({ name, path, method: response.request().method(), status: response.status() })
    if (path.startsWith('/api/') && response.status() >= 500 || path.startsWith('/assets/') && response.status() >= 400)
      diagnostics.push({ name, kind: 'response', path, status: response.status() })
  })
  let authenticator
  if (ticket) authenticator = await signInFreshSite(page, origin, ticket)
  else {
    authenticator = await enableAuthenticator(context, page)
    const { credentials } = await device.cdp.send('WebAuthn.getCredentials', { authenticatorId: device.authenticatorId })
    assert.equal(credentials.length, 1)
    assert.equal(credentials[0].rpId, 'localhost')
    // Pass the test authenticator to another browser context with its latest assertion counter.
    await authenticator.cdp.send('WebAuthn.addCredential', { authenticatorId: authenticator.authenticatorId, credential: credentials[0] })
    await context.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
    assertStatus(await page.goto(origin + '/login'), 200)
    await signInWithSitePasskey(page, origin)
  }
  const cookie = (await context.cookies(origin)).find(item => item.name === sessionCookie)
  assert(cookie?.httpOnly, 'The authenticated browser cookie must remain HttpOnly.')
  const snapshot = await context.request.get(origin + currentPath)
  assertStatus(snapshot, 200)
  await assertNoStore(snapshot, 'The session response must not be cached.')
  const handle = snapshot.headers()[currentHeader.toLowerCase()]
  assert(handleFormat.test(handle), 'The session response must supply an opaque handle.')
  assert.equal(await auth.readSessionHandle(context, origin, currentPath), handle, 'The handle must remain stable for this session.')
  assertNotCredential(Buffer.from(handle), [{ cookie }])
  return { context, page, cookie, handle, authenticator }
}

async function openSecurity(session) {
  await session.page.goto(origin + securityPath)
  await exactHeading(session.page, 'Account').waitFor()
  await exactHeading(session.page, 'Active sessions').waitFor()
  await exactText(session.page, 'This browser').waitFor()
}

async function getSessions(session, fixtures) {
  const response = await session.context.request.get(origin + listPath, { headers: current(session) })
  assertStatus(response, 200)
  await assertNoStore(response, 'The session list must not be cached.')
  const body = await response.body()
  assertNotCredential(body, fixtures)
  const frame = decodeFrame(body)
  assert.equal(frame.type, 32796)
  const reader = new PodReader(frame.payload)
  assert.equal(reader.bool(), false, 'This fixture should fit in one response.')
  const count = reader.i32()
  assert(count >= 1 && count <= 3, 'Unexpected session count for isolated fixture.')
  const rows = Array.from({ length: count }, () => ({
    id: reader.text(64), expiresAt: reader.i64(), current: reader.bool(), method: reader.i32(), mfa: reader.bool(),
  }))
  reader.finish()
  assert.deepEqual(rows.filter(row => row.current).map(row => row.id), [session.handle])
  assert(rows.every(row => handleFormat.test(row.id) && row.expiresAt > BigInt(Date.now()) && row.method === 2 && !row.mfa))
  return rows
}

async function clickMutation(page, button, matches) {
  const [response] = await Promise.all([
    page.waitForResponse(candidate => {
      const target = new URL(candidate.url())
      return target.origin === origin && candidate.request().method() === 'POST' && matches(target.pathname)
    }),
    button.click(),
  ])
  return response
}
