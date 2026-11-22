import assert from 'node:assert/strict'
import { assertStatus } from './response-status-fixture.mjs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeApiError, decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import { decodeDraft, decodeSession, encodeArticleCommand, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertEmptySuccess, button, enableAuthenticator, expect, launchIdentityBrowser, readTlsIdentityFixture, recordIdentityResponse, request, secureLoginProtocol, setupSiteTotp, completeSiteTotp, siteApi } from './site-authentication-fixture.mjs'
import { roleWithExactName } from './role-locators.mjs'

const emptySuccess = reply => assertEmptySuccess(reply, 'Authentication response may be stored.')
const exec = promisify(execFile)
const peerTicket = process.env.FSUSBLOG_TEST_SITE_REFRESH_PEER_TICKET
const probe = process.env.FSUSBLOG_TEST_SITE_REFRESH_PROBE
const { origin, ownerTicket, pins } = readTlsIdentityFixture(peerTicket, probe,
  'Provide the isolated native TLS runner with two separate accounts and the PostgreSQL fixture probe.')
const { isApi, waitApi, clickApi } = siteApi(origin, (target, predicate) =>
  target.waitForEvent('response', { predicate, timeout: 12_000 }))
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-refresh-browser')
await mkdir(evidence, { recursive: true })

const cookieNames = { access: 'fsus-v2-session', refresh: '__Secure-FsusSiteRefresh' }
const refreshPath = '/api/v2/identity/refresh'
const {
  SiteRefreshAvailability: refreshAvailability,
  SiteRefreshStatus: refreshStatus,
  SiteRefreshRotate: rotate,
  SiteRefreshSignOut: refreshSignOut,
} = WireRoutes
const browser = await launchIdentityBrowser(pins)
const startedAt = new Date().toISOString()
const checks = {}
const responses = []
const faults = []
const sensitive = [ownerTicket, peerTicket]
let phase = 'configure-mfa'
let failure
try {
  const owner = await openBrowser('owner')
  const peer = await openBrowser('peer')
  const document = await owner.page.goto(origin + '/login')
  checks.tlsWebAuthn = await secureLoginProtocol(owner.page, document,
    'Persistent session acceptance requires a real TLS browser context.')
  assertStatus(await owner.context.request.get(origin + refreshAvailability), 200)
  assertStatus(await owner.context.request.get(origin + refreshStatus), 401)
  await enroll(owner.page, ownerTicket)
  await passkey(owner.page, false, 1)
  const original = await checkSession(owner.context, 200)
  await owner.page.goto(origin + '/user/identity/mfa')
  const { secret, setupStep } = await setupSiteTotp(owner.page, clickApi, sensitive, 'The fixture authenticator seed was unavailable.')
  assertStatus(await clickApi(owner.page, WireRoutes.SignOut, 'Log out'), 200)
  await owner.page.waitForURL(origin + '/')

  phase = 'ordinary-browser-session'
  await peer.page.goto(origin + '/login')
  await enroll(peer.page, peerTicket)
  await passkey(peer.page, false, 1)
  const peerState = await checkSession(peer.context, 200)
  const peerCookie = await cookie(peer.context, 'access')
  assert(peerState.name !== original.name && !peerState.persistent && peerCookie.expires === -1,
    'The separate non-opted-in Passkey session should be a browser cookie.')
  assertStatus(await peer.context.request.get(origin + refreshStatus), 401)
  assertStatus(await rotateVia(peer.context.request), 401)
  await checkSession(peer.context, 200)
  checks.nonOptedInOwnSession = true

  phase = 'persistent-mfa'
  await passkey(owner.page, true, 2)
  await checkSession(owner.context, 401)
  assertStatus(await owner.context.request.get(origin + refreshStatus), 401)
  assert(!(await cookie(owner.context, 'refresh', false)), 'MFA-pending login received a persistent credential.')
  await completeSiteTotp(owner.page, clickApi, sensitive, secret, setupStep)
  const active = await checkSession(owner.context, 200)
  assert(active.name === original.name && active.persistent, 'MFA completion did not establish the same account’s persistent session.')
  assertStatus(await owner.context.request.get(origin + refreshStatus), 200)
  const oldAccess = await cookie(owner.context, 'access')
  const oldRefresh = await cookie(owner.context, 'refresh')
  assertCookieOptions(oldAccess, oldRefresh)
  checks.persistentCredentialsFollowMfa = true

  phase = 'two-tab-restoration'
  // Keep the persistent cookie jar in memory and discard the original browser context.
  const persisted = await owner.context.storageState()
  persisted.cookies = persisted.cookies.filter(cookie => cookie.expires > Date.now() / 1000)
  await owner.context.close()
  const restored = await browser.newContext({ storageState: persisted })
  observe(restored, 'restored')
  const writer = await restored.newPage()
  const first = await restored.newPage()
  const second = await restored.newPage()
  const workspace = await openDirtyWorkspace(writer, active.handle)
  const stale = await request.newContext({ storageState: { cookies: [oldAccess, oldRefresh], origins: [] } })
  await probeRow('expire-access')
  await checkSession(restored, 401)
  assert((await cookie(restored, 'refresh')).value === oldRefresh.value, 'Reopened browser did not retain its persistent credential.')
  await holdBothExpiredReads(first, second)
  const rotation = Promise.withResolvers()
  await writer.route(origin + WireRoutes.Session, async route => {
    await rotation.promise
    await route.continue()
  })
  const fired = []
  restored.on('response', response => {
    if (isApi(response, rotate, 'POST')) fired.push(response)
  })
  try {
    const [rotated] = await Promise.all([
      waitApi(restored, rotate, 'POST'), first.goto(origin + '/login'), second.goto(origin + '/login'),
    ])
    await emptySuccess(rotated)
    const concurrent = await rotateVia(stale)
    await refreshError(concurrent, 409, 'REFRESH_ROTATION_CONFLICT')
    assert(!concurrent.headers()['set-cookie'], 'A concurrent request changed browser credentials.')
    checks.concurrentGenerationRejected = concurrent.status()
    const writerObserved = writer.waitForResponse(response => isApi(response, WireRoutes.Session, 'GET') && response.status() === 200)
    rotation.resolve()
    await Promise.all([first, second].map(page => roleWithExactName(page, 'link', 'Continue to writing').waitFor()))
    assert.equal(fired.length, 1, 'Expected one rotation for both tabs sharing the persistent cookie jar.')
    const fresh = await checkSession(restored, 200)
    assert(fresh.name === active.name && fresh.generation === active.generation && fresh.persistent,
      'Rotation changed identity, account generation or session policy.')
    assert(fresh.handle !== active.handle && fresh.continuity === active.continuity,
      'The access identifier did not rotate within the same session family.')
    const newAccess = await cookie(restored, 'access')
    const newRefresh = await cookie(restored, 'refresh')
    assertCookieOptions(newAccess, newRefresh)
    assert(fresh.expiresAt < newRefresh.expires * 1000, 'The active session was given the refresh credential’s longer expiry.')
    assert(newAccess.value !== oldAccess.value && newRefresh.value !== oldRefresh.value,
      'Rotation did not replace both opaque credential values.')
    checks.twoTabsRestoredViaOneRotation = true

    phase = 'same-family-editor-continuity'
    const writerSession = await writerObserved
    assert((await writerSession.allHeaders())[WireHeaders.CurrentSession.toLowerCase()] === fresh.handle,
      'The open workspace did not fetch the newly rotated credential.')
    await verifyDirtyWorkspace(writer, workspace)
    checks.sameFamilyRetainedDirtyWorkspaceAndInspector = true
    phase = 'persist-dirty-workspace'
    await writer.bringToFront()
    await button(roleWithExactName(writer, 'complementary', 'Article inspector'), 'Close').click()
    const saved = await saveFromEditor(writer)
    assertStatus(saved, 200)
    const sent = await saved.request().allHeaders()
    assert(sent[WireHeaders.CurrentSession.toLowerCase()] === fresh.handle,
      'The preserved workspace did not write using the rotated credential identifier.')
    const retained = decodeDraft(decodeFrame(await saved.body(), FrameType.Draft).payload)
    assert(retained.title === workspace.title && retained.body === workspace.body,
      'The preserved dirty inputs were not saved byte for byte.')
    checks.dirtyWorkspaceSavedUsingRotatedCredential = true

    phase = 'stale-editor-create-rejected'
    await rejectStaleDraftCreate([newAccess, newRefresh], fresh.handle, peer, peerCookie)
    checks.staleCreateRejectedAfterAccountSwitch = true

    phase = 'rotation-replay'
    await probeRow('expire-grace')
    const replay = await rotateVia(stale)
    await refreshError(replay, 401, 'REFRESH_FAMILY_COMPROMISED')
    await checkSession(restored, 401)
    assertStatus(await rotateVia(restored.request), 401)
    checks.retiredTokenReplayRevokedFamily = true
  } finally {
    rotation.resolve()
    await stale.dispose()
  }
  const peerAfter = await checkSession(peer.context, 200)
  assert(peerAfter.name === peerState.name && peerAfter.generation === peerState.generation &&
    (await cookie(peer.context, 'access')).value === peerCookie.value, 'An independent session changed during another account’s rotation.')
  checks.independentAccountUnaffected = true

  phase = 'persistent-sign-out'
  await emptySuccess(await clickApi(peer.page, WireRoutes.SignOut, 'Log out'))
  await peer.page.waitForURL(origin + '/')
  await checkSession(peer.context, 401)
  await passkey(peer.page, true, 1)
  const signedOutAccess = await cookie(peer.context, 'access')
  const signedOutRefresh = await cookie(peer.context, 'refresh')
  await emptySuccess(await clickApi(peer.page, refreshSignOut, 'Log out'))
  await checkSession(peer.context, 401)
  assert(!(await cookie(peer.context, 'refresh', false)) && !(await cookie(peer.context, 'access', false)),
    'Sign-out left authentication cookies in the browser.')
  const beforeLogout = await request.newContext({
    storageState: { cookies: [signedOutAccess, signedOutRefresh], origins: [] },
  })
  try {
    assertStatus(await beforeLogout.get(origin + WireRoutes.Session), 401)
    assertStatus(await rotateVia(beforeLogout), 401)
  } finally { await beforeLogout.dispose() }
  checks.persistentSignOutRevokedBothCredentials = true
  assert.deepEqual(faults, [])
  phase = 'passed'
} catch (error) {
  failure = sensitive.reduce((value, secret) => value.replaceAll(secret, '[fixture secret]'), String(error))
    .replace(/\b[A-Za-z0-9_-]{43}\b|\b[a-f0-9]{64}\b/g, '[fixture token]')
} finally {
  await browser.close()
  await writeFile(join(evidence, 'site-refresh-result.json'), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), origin, chromium: browser.version(), phase, checks, responses, faults, failure,
  }, null, 2))
}
if (failure) throw new Error(`${phase}: ${failure}`)

function observe(context, role) {
  context.setDefaultTimeout(12_000)
  context.on('page', page => page.on('pageerror', () => faults.push({ role, kind: 'uncaught-page-error' })))
  context.on('response', recordIdentityResponse(origin, role, responses, faults))
}

async function openBrowser(role) {
  const context = await browser.newContext()
  observe(context, role)
  const page = await context.newPage()
  await enableAuthenticator(context, page)
  return { context, page }
}

async function enroll(page, ticket) {
  await page.getByLabel('Owner access key').fill(ticket)
  await emptySuccess(await clickApi(page, WireRoutes.PasskeyProvisionComplete, 'Create Passkey'))
  await page.getByText('Passkey created. Log in with your Passkey.', { exact: true }).waitFor()
}

async function passkey(page, remember, phase) {
  await page.goto(origin + '/login')
  const choice = roleWithExactName(page, 'checkbox', 'Keep me signed in')
  const label = page.getByText('Keep me signed in', { exact: true })
  await label.waitFor()
  assert.equal(await choice.isChecked(), false, 'Persistent sign-in must be an explicit choice.')
  if (remember) {
    await label.click()
    assert.equal(await choice.isChecked(), true)
  }
  const reply = await clickApi(page, WireRoutes.PasskeyLoginComplete, 'Log in with Passkey')
  assertStatus(reply, 200)
  const login = decodeFrame(await reply.body(), FrameType.AuthLoginFlow)
  assert.equal(login.payload[4], phase)
  if (phase === 1) await page.waitForURL(origin + '/user/manage/article/write')
}

async function checkSession(context, status) {
  const reply = await context.request.get(origin + WireRoutes.Session)
  assertStatus(reply, status)
  if (status === 200) {
    const headers = reply.headers()
    const expiresAt = Date.parse(headers[WireHeaders.AccessExpiresAtUtc.toLowerCase()])
    const persistent = headers[WireHeaders.SiteRefresh.toLowerCase()] === 'persistent'
    const handle = headers[WireHeaders.CurrentSession.toLowerCase()]
    const continuity = headers[WireHeaders.SiteSessionContinuity.toLowerCase()]
    assert(Number.isFinite(expiresAt) && expiresAt > Date.now(), 'Live session response lacked its actual access expiry.')
    assert(/^[a-f0-9]{64}$/.test(handle) && (!persistent || /^[a-f0-9]{64}$/.test(continuity)),
      'Live session response lacked its credential identifier or persistent continuity.')
    return { ...decodeSession(decodeFrame(await reply.body(), FrameType.OperatorSession).payload), expiresAt, persistent, handle, continuity }
  }
}

async function cookie(context, kind, required = true) {
  const path = kind === 'refresh' ? rotate : WireRoutes.Session
  const value = (await context.cookies(origin + path)).find(candidate => candidate.name === cookieNames[kind])
  if (required) assert(value?.value, `Expected a ${kind} cookie.`)
  return value
}

function assertCookieOptions(access, refresh) {
  assert(access.httpOnly && refresh.httpOnly && access.secure && refresh.secure &&
    access.sameSite === 'Strict' && refresh.sameSite === 'Strict', 'Persistent credentials lacked protected cookie options.')
  assert.equal(access.path, '/', 'The access cookie path changed.')
  assert.equal(refresh.path, refreshPath, 'The refresh cookie path is broader than expected.')
  const lifetime = refresh.expires - Date.now() / 1000
  assert(lifetime > 0 && lifetime <= 30 * 86400 + 5, `Refresh cookie lifetime was outside 30 days (${Math.round(lifetime)} seconds).`)
  assert(Math.abs(access.expires - refresh.expires) <= 1, 'Persistent cookie expirations differed by more than one second.')
}

function rotateVia(api) {
  return api.post(origin + rotate, { headers: { Origin: origin }, maxRedirects: 0 })
}

async function refreshError(reply, status, message) {
  assertStatus(reply, status)
  const frame = decodeFrame(await reply.body(), FrameType.ApiError)
  assert.equal(decodeApiError(frame.payload, status).message, message)
}

async function probeRow(action) {
  const { stdout } = await exec(probe, [action], { timeout: 5000 })
  assert.equal(stdout.trim(), '1', 'Expected one fixture row to move its expiry boundary.')
}

async function holdBothExpiredReads(first, second) {
  // Each tab observes the expired access before either can elect a rotation leader.
  const both = Promise.withResolvers()
  let ready = 0
  await Promise.all([first, second].map(page => page.route(origin + WireRoutes.Session, async route => {
    const expired = await route.fetch({ maxRedirects: 0 })
    if (++ready === 2) both.resolve()
    await both.promise
    await route.fulfill({ response: expired })
  }, { times: 1 })))
}

async function openDirtyWorkspace(writer, handle) {
  const savedTitle = 'Persistent workspace baseline'
  const draft = encodeFrame(FrameType.ArticleCommand, encodeArticleCommand({
    id: 0, expectedRevision: 0n, idempotencyKey: randomUUID(), title: savedTitle, body: 'Saved Markdown.',
  }))
  const stored = await writer.context().request.post(origin + WireRoutes.Save, {
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin, [WireHeaders.CurrentSession]: handle },
    data: Buffer.from(draft),
  })
  assertStatus(stored, 200)
  const { id } = decodeDraft(decodeFrame(await stored.body(), FrameType.Draft).payload)
  await writer.goto(origin + '/user/manage/article/workspace')
  await writer.getByLabel('Article ID', { exact: true }).fill(String(id))
  await button(writer, 'Open article').click()
  await writer.waitForURL(origin + '/user/manage/article/edit/' + id)
  await expect(writer.getByLabel('Title', { exact: true })).toHaveValue(savedTitle)
  await button(writer, 'Pin ' + savedTitle).click()
  const title = 'Unsaved title spanning session rotation'
  const body = 'Unsaved Markdown spanning session rotation.\n\nSecond paragraph.'
  await writer.getByLabel('Title', { exact: true }).fill(title)
  await writer.getByLabel('Body', { exact: true }).fill(body)
  await button(writer, 'Inspector').click()
  await verifyDirtyWorkspace(writer, { title, body })
  return { title, body }
}

async function verifyDirtyWorkspace(writer, workspace) {
  const selected = roleWithExactName(writer, 'tablist', 'Open articles').getByRole('tab', { selected: true })
  await expect(selected).toContainText(workspace.title)
  await expect(button(writer, 'Unpin ' + workspace.title)).toHaveAttribute('aria-pressed', 'true')
  await expect(writer.getByLabel('Title', { exact: true })).toHaveValue(workspace.title)
  await expect(writer.getByLabel('Body', { exact: true })).toHaveValue(workspace.body)
  await expect(roleWithExactName(writer, 'complementary', 'Article inspector')).toBeVisible()
}

async function saveFromEditor(page) {
  await page.bringToFront()
  const save = button(page, 'Save draft')
  await expect(save).toBeEnabled()
  return clickApi(page, WireRoutes.Save, 'Save draft')
}

async function rejectStaleDraftCreate(cookies, handle, peer, peerCookie) {
  const swapped = await browser.newContext({ storageState: { cookies, origins: [] } })
  observe(swapped, 'stale-writer')
  const page = await swapped.newPage()
  const title = 'Stale author cross-account fixture'
  try {
    await page.goto(origin + '/user/manage/article/write')
    await page.getByLabel('Title', { exact: true }).fill(title)
    await page.getByLabel('Body', { exact: true }).fill('This draft belongs to the originally authenticated account.')
    const submitted = Promise.withResolvers()
    await page.route(origin + WireRoutes.Save, async route => {
      try {
        const outgoing = route.request()
        const headers = await outgoing.allHeaders()
        assert(headers[WireHeaders.CurrentSession.toLowerCase()] === handle,
          'The editor did not submit its original credential identifier.')
        await swapped.clearCookies({ name: cookieNames.refresh })
        await swapped.addCookies([peerCookie])
        const response = await swapped.request.post(outgoing.url(), {
          headers: {
            Origin: origin, 'Content-Type': headers['content-type'],
            [WireHeaders.CurrentSession]: headers[WireHeaders.CurrentSession.toLowerCase()],
          },
          data: outgoing.postDataBuffer(),
        })
        await route.fulfill({ response })
        submitted.resolve()
      } catch (error) {
        await route.abort('failed').catch(() => {})
        submitted.reject(error)
      }
    }, { times: 1 })
    const [rejected] = await Promise.all([saveFromEditor(page), submitted.promise])
    await refreshError(rejected, 409, 'The current browser session changed. Reload before making changes.')
    assert((await checkSession(swapped, 200)).name === (await checkSession(peer.context, 200)).name,
      'The stale write fixture was not using the peer account’s actual access credential.')
    const inventory = await peer.context.request.get(origin + WireRoutes.AuthorArticles, { params: { keyword: title } })
    assertStatus(inventory, 200)
    assert.equal(decodeAuthorArticlePage(decodeFrame(await inventory.body(), FrameType.AuthorArticlePage).payload).total, 0,
      'A cross-account write created an article in the peer inventory.')
  } finally {
    await swapped.close()
  }
}
