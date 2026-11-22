import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { FrameType } from '../../src/Contracts/wire.generated.ts'

const packages = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium } = packages('@playwright/test')
const url = process.env.FSUSBLOG_TEST_SESSIONS_URL
const ticketInput = process.env.FSUSBLOG_TEST_SESSIONS_TICKETS
assert(url && ticketInput, 'Provide an isolated v2 URL and four one-use session tickets.')
const origin = new URL(url).origin
const tickets = JSON.parse(ticketInput)
const handleFormat = /^[0-9a-f]{64}$/
assert(Array.isArray(tickets) && tickets.length === 4 && tickets.every(ticket => handleFormat.test(ticket)) &&
  new Set(tickets).size === 4, 'Provide three unused tickets for one account and an unused ticket for a different account.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-sessions-browser')
await mkdir(evidence, { recursive: true })

const identity = '/api/v2/identity'
const currentPath = identity + '/session.aeds'
const listPath = identity + '/sessions.aeds'
const bulkPath = identity + '/sessions/revoke-others.aeds'
const securityPath = '/user/identity/mfa'
const currentHeader = 'X-Fsus-Current-Session'
const sessionCookie = 'fsus-v2-session'
const diagnostics = []
const responses = []
const checks = {}
const startedAt = new Date().toISOString()
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true })
let phase = 'sign-in'
let failure
try {
  const primary = await signIn('primary', tickets[0], { width: 1280, height: 800 })
  const peer = await signIn('peer', tickets[1], { width: 375, height: 850 })
  const remaining = await signIn('remaining', tickets[2], { width: 1280, height: 800 })
  const foreign = await signIn('foreign', tickets[3], { width: 1280, height: 800 })
  const allSessions = [primary, peer, remaining, foreign]
  assert.equal(new Set(allSessions.map(session => session.handle)).size, 4)
  const ownedSessions = [primary.handle, peer.handle, remaining.handle]

  phase = 'list'
  await openSecurity(primary)
  await openSecurity(peer)
  const first = await getSessions(primary, allSessions)
  assert.deepEqual(new Set(first.map(row => row.id)), new Set(ownedSessions))
  assert.deepEqual((await getSessions(foreign, allSessions)).map(row => row.id), [foreign.handle])
  assert.equal(await revokeButtons(primary.page).count(), 2)
  assert.equal(await revokeButtons(peer.page).count(), 2)
  await primary.page.screenshot({ path: join(evidence, 'desktop-sessions.png') })
  await peer.page.screenshot({ path: join(evidence, 'mobile-sessions.png') })
  checks.separateAccountLists = true
  checks.rawCredentialsAbsent = true

  phase = 'mutation-authorization'
  let response = await primary.context.request.post(origin + revokePath(foreign.handle), { headers: current(primary) })
  assert.equal(response.status(), 404, 'A foreign session must be indistinguishable from an unknown session.')
  response = await primary.context.request.post(origin + revokePath(randomBytes(32).toString('hex')), {
    headers: current(primary),
  })
  assert.equal(response.status(), 404, 'Unknown sessions must return the same status as foreign sessions.')
  response = await primary.context.request.post(origin + revokePath(primary.handle), { headers: current(primary) })
  assert.equal(response.status(), 409, 'The current browser session has its own sign-out action.')
  response = await primary.context.request.post(origin + bulkPath, {
    headers: { ...current(primary), Origin: 'https://cross-origin.invalid' },
  })
  assert.equal(response.status(), 403, 'Session mutations must reject a foreign origin.')
  response = await primary.context.request.post(origin + bulkPath)
  assert(response.status() >= 400 && response.status() < 500, 'Mutations require a current-session precondition.')
  const anonymous = await browser.newContext()
  try {
    response = await anonymous.request.get(origin + listPath, { headers: current(primary) })
    assert.equal(response.status(), 401, 'A session handle alone does not authenticate.')
  } finally {
    await anonymous.close()
  }
  checks.foreignAndCurrentRevocationDenied = true
  checks.crossOriginMutationDenied = true
  checks.sessionHandleIsNotCredential = true

  phase = 'stale-tab'
  for (const replacement of [peer, foreign]) {
    await primary.context.clearCookies({ name: sessionCookie })
    await primary.context.addCookies([replacement.cookie])
    response = await clickMutation(primary.page, bulkButton(primary.page), path => path === bulkPath)
    assert.equal(response.status(), 409, 'A page pinned to its prior browser session must reject a replacement cookie.')
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
  assert.equal(response.status(), 200)
  decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
  const target = new URL(response.url()).pathname.split('/').at(-2)
  const revoked = [peer, remaining].find(session => session.handle === target)
  assert(revoked, 'The UI must address one of the other sessions for this account.')
  const survivor = revoked === peer ? remaining : peer
  assert.equal((await revoked.context.request.get(origin + currentPath)).status(), 401)
  assert.equal((await survivor.context.request.get(origin + currentPath)).status(), 200)
  await revokeButtons(primary.page).nth(1).waitFor({ state: 'hidden' })
  assert.equal(await revokeButtons(primary.page).count(), 1)
  checks.individualCookieRevoked = true

  phase = 'bulk-revocation'
  response = await clickMutation(primary.page, bulkButton(primary.page), path => path === bulkPath)
  assert.equal(response.status(), 200)
  decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
  assert.equal((await survivor.context.request.get(origin + currentPath)).status(), 401)
  assert.equal((await foreign.context.request.get(origin + currentPath)).status(), 200)
  assert.equal((await primary.context.request.get(origin + currentPath)).status(), 200)
  assert.deepEqual((await getSessions(primary, allSessions)).map(row => row.id), [primary.handle])
  await revokeButtons(primary.page).first().waitFor({ state: 'hidden' })
  await primary.page.getByText('This browser', { exact: true }).waitFor({ state: 'visible' })
  await primary.page.screenshot({ path: join(evidence, 'after-revocation.png') })
  checks.bulkPreservedCurrentAndForeign = true

  for (const session of [primary, foreign])
    assert.equal((await session.context.request.post(origin + identity + '/sign-out.aeds')).status(), 200)
  assert.deepEqual(diagnostics, [])
  phase = 'passed'
} catch (error) {
  failure = error
} finally {
  const chromiumVersion = browser.version()
  await browser.close()
  await writeFile(join(evidence, 'site-sessions-result.json'), JSON.stringify({
    origin, startedAt, endedAt: new Date().toISOString(), chromium: chromiumVersion, phase,
    checks, responses, diagnostics, exitCode: failure ? 1 : 0,
  }, null, 2))
}
if (failure) throw failure

function current(session) {
  return { [currentHeader]: session.handle }
}

function revokePath(handle) {
  return identity + '/sessions/' + handle + '/revoke.aeds'
}

function revokeButtons(page) {
  return page.getByRole('button', { name: 'Revoke session', exact: true })
}

function bulkButton(page) {
  return page.getByRole('button', { name: 'Revoke other sessions', exact: true })
}

async function signIn(name, ticket, viewport) {
  const context = await browser.newContext({ viewport })
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
    if (path.startsWith(identity + '/'))
      responses.push({ name, path, method: response.request().method(), status: response.status() })
    if (path.startsWith('/api/') && response.status() >= 500 || path.startsWith('/assets/') && response.status() >= 400)
      diagnostics.push({ name, kind: 'response', path, status: response.status() })
  })
  await page.goto(origin + '/login')
  const signedIn = page.waitForResponse(response =>
    response.url() === origin + identity + '/sign-in.aeds' && response.request().method() === 'POST')
  await page.getByLabel('Owner access key').fill(ticket)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  const response = await signedIn
  assert.equal(response.status(), 200, 'One-use fixture ticket was not accepted.')
  await page.waitForURL(origin + '/user/manage/article/write')
  const cookie = (await context.cookies(origin)).find(cookie => cookie.name === sessionCookie)
  assert(cookie && cookie.httpOnly, 'The authenticated browser cookie must remain HttpOnly.')
  const snapshot = await context.request.get(origin + currentPath)
  assert.equal(snapshot.status(), 200)
  assert(snapshot.headers()['cache-control']?.includes('no-store'), 'The session response must not be cached.')
  const handle = snapshot.headers()[currentHeader.toLowerCase()]
  assert(handleFormat.test(handle), 'The session response must supply an opaque handle.')
  assert(handle === await response.headerValue(currentHeader), 'The handle must remain stable for this session.')
  assertNotCredential(Buffer.from(handle), [{ cookie }])
  return { context, page, cookie, handle }
}

async function openSecurity(session) {
  await session.page.goto(origin + securityPath)
  await session.page.getByRole('heading', { name: 'Account', exact: true }).waitFor()
  await session.page.getByRole('heading', { name: 'Active sessions', exact: true }).waitFor()
  await session.page.getByText('This browser', { exact: true }).waitFor()
}

async function getSessions(session, fixtures) {
  const response = await session.context.request.get(origin + listPath, { headers: current(session) })
  assert.equal(response.status(), 200)
  assert(response.headers()['cache-control']?.includes('no-store'), 'The session list must not be cached.')
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
  assert(rows.every(row => handleFormat.test(row.id) && row.expiresAt > BigInt(Date.now()) && row.method === 1 && !row.mfa))
  return rows
}

function assertNotCredential(artifact, sessions) {
  for (const { cookie } of sessions) {
    const secret = Buffer.from(cookie.value, 'hex')
    const digest = createHash('sha256').update(secret).digest()
    assert(!artifact.includes(secret) && !artifact.includes(cookie.value) &&
      !artifact.includes(digest) && !artifact.includes(digest.toString('hex')),
      'The session wire exposed a browser credential or its stored digest.')
    secret.fill(0)
  }
}

async function clickMutation(page, button, matches) {
  const response = page.waitForResponse(candidate => {
    const url = new URL(candidate.url())
    return url.origin === origin && candidate.request().method() === 'POST' && matches(url.pathname)
  })
  await button.click()
  return await response
}

function clean(text) {
  return text.replace(/[0-9a-f]{64}/gi, '[session-coordinate]')
}
