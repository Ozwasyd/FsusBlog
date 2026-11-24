import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { decodeApiError, decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorArticlePage } from '../../src/Contracts/author-articles.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { authorFixture, openWorkspaceDialog } from './browser-authoring-fixture.mjs'
import { assertStatus, readFrame } from './response-status-fixture.mjs'
import { exactCheckbox, exactLabel, exactLink, exactText, roleWithExactName } from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { FrameType, WireHeaders, WireRoutes: R } = wire
const { button, expect } = auth
const emptySuccess = reply => auth.assertEmptySuccess(reply, 'Authentication response may be stored.')
const peerTicket = process.env.FSUSBLOG_TEST_SITE_REFRESH_PEER_TICKET
const probe = process.env.FSUSBLOG_TEST_SITE_REFRESH_PROBE
const { origin, ownerTicket, pins } = auth.readTlsIdentityFixture(peerTicket, probe,
  'Provide the isolated native TLS runner with two separate accounts and the PostgreSQL fixture probe.')
const adminOrigin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL).origin
const adminBootstrap = process.env.FSUSBLOG_TEST_ADMIN_TICKET
const adminPeerBootstrap = process.env.FSUSBLOG_TEST_SITE_REFRESH_ADMIN_PEER
assert(adminOrigin !== origin && adminBootstrap && adminPeerBootstrap)
const adminFxAuthor = authorFixture(adminOrigin, [])
const englishLocale = { name: 'fsus_locale', value: 'en', url: origin }
const { isApi, waitApi, clickApi } = auth.siteApi(origin, (target, predicate) => target.waitForEvent('response', { predicate, timeout: 12_000 }))
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-refresh-browser')

const cookieNames = { access: 'fsus-v2-session', refresh: '__Secure-FsusSiteRefresh' }
const refreshPath = '/api/v2/identity/refresh'
const browser = await auth.launchIdentityBrowser(pins)
const state = {
  origin, phase: 'configure-mfa', checks: {}, responses: [], faults: [],
  secrets: [ownerTicket, peerTicket, adminBootstrap, adminPeerBootstrap],
}
const { checks, responses, faults, secrets: sensitive } = state

await auth.withRedactedEvidence(browser, evidence, 'site-refresh-result.json', state, async () => {
  const owner = await auth.openSiteBrowser(browser, origin, 'owner', responses, faults)
  const peer = await auth.openSiteBrowser(browser, origin, 'peer', responses, faults)
  const document = await owner.page.goto(origin + '/login')
  checks.tlsWebAuthn = await auth.secureLoginProtocol(owner.page, document, 'Persistent session acceptance requires a real TLS browser context.')
  assertStatus(await owner.context.request.get(origin + R.SiteRefreshAvailability), 200)
  assertStatus(await owner.context.request.get(origin + R.SiteRefreshStatus), 401)
  await auth.enrollFirstPasskey(owner.page, ownerTicket, clickApi, 'Authentication response may be stored.')
  await passkey(owner.page, false, 1)
  const original = await checkSession(owner.context, 200)
  await owner.page.goto(origin + '/user/identity/mfa')
  const { secret, setupStep } = await auth.setupSiteTotp(owner.page, clickApi, sensitive, 'The fixture authenticator seed was unavailable.')
  assertStatus(await clickApi(owner.page, R.SignOut, 'Log out'), 200)
  await owner.page.waitForURL(origin + '/')

  state.phase = 'ordinary-browser-session'
  await peer.page.goto(origin + '/login')
  await auth.enrollFirstPasskey(peer.page, peerTicket, clickApi, 'Authentication response may be stored.')
  await passkey(peer.page, false, 1)
  const peerState = await checkSession(peer.context, 200)
  const peerCookie = await cookie(peer.context, 'access')
  assert(peerState.name !== original.name && !peerState.persistent && peerCookie.expires === -1,
    'The separate non-opted-in Passkey session should be a browser cookie.')
  assertStatus(await peer.context.request.get(origin + R.SiteRefreshStatus), 401)
  assertStatus(await rotateVia(peer.context.request), 401)
  await checkSession(peer.context, 200)
  checks.nonOptedInOwnSession = true

  state.phase = 'persistent-mfa'
  await passkey(owner.page, true, 2)
  await checkSession(owner.context, 401)
  assertStatus(await owner.context.request.get(origin + R.SiteRefreshStatus), 401)
  assert(!(await cookie(owner.context, 'refresh', false)), 'MFA-pending login received a persistent credential.')
  await auth.completeSiteTotp(owner.page, clickApi, sensitive, secret, setupStep)
  const active = await checkSession(owner.context, 200)
  assert(active.name === original.name && active.persistent, 'MFA completion did not establish the same account’s persistent session.')
  assertStatus(await owner.context.request.get(origin + R.SiteRefreshStatus), 200)
  const oldAccess = await cookie(owner.context, 'access'), oldRefresh = await cookie(owner.context, 'refresh')
  assertCookieOptions(oldAccess, oldRefresh)
  checks.persistentCredentialsFollowMfa = true

  state.phase = 'two-tab-restoration'
  // Keep the persistent cookie jar in memory and discard the original browser context.
  const persisted = await owner.context.storageState()
  persisted.cookies = persisted.cookies.filter(item => item.expires > Date.now() / 1000)
  await owner.context.close()
  const restored = await browser.newContext({ storageState: persisted })
  await restored.addCookies([englishLocale])
  auth.observeSiteContext(restored, origin, 'restored', responses, faults)
  const writer = await restored.newPage()
  await writer.bringToFront()
  await signInFreshAdmin(writer, adminOrigin, adminBootstrap)
  const authoringHandle = await auth.readSessionHandle(restored, adminOrigin, R.AuthoringSession)
  const workspace = await openDirtyWorkspace(writer, authoringHandle)
  const first = await restored.newPage(), second = await restored.newPage()
  const stale = await auth.request.newContext({ storageState: { cookies: [oldAccess, oldRefresh], origins: [] } })
  await probeRow('expire-access')
  await checkSession(restored, 401)
  assert((await cookie(restored, 'refresh')).value === oldRefresh.value, 'Reopened browser did not retain its persistent credential.')
  await holdBothExpiredReads(first, second)
  const fired = []
  restored.on('response', response => { if (isApi(response, R.SiteRefreshRotate, 'POST')) fired.push(response) })
  try {
    const [rotated] = await Promise.all([waitApi(restored, R.SiteRefreshRotate, 'POST'), first.goto(origin + '/login'), second.goto(origin + '/login')])
    await emptySuccess(rotated)
    const concurrent = await rotateVia(stale)
    await refreshError(concurrent, 409, 'REFRESH_ROTATION_CONFLICT')
    assert(!concurrent.headers()['set-cookie'], 'A concurrent request changed browser credentials.')
    checks.concurrentGenerationRejected = concurrent.status()
    await Promise.all([first, second].map(page => exactLink(page, 'Account').waitFor()))
    assert.equal(fired.length, 1, 'Expected one rotation for both tabs sharing the persistent cookie jar.')
    const fresh = await checkSession(restored, 200)
    assert(fresh.name === active.name && fresh.generation === active.generation && fresh.persistent,
      'Rotation changed identity, account generation or session policy.')
    assert(fresh.handle !== active.handle && fresh.continuity === active.continuity,
      'The access identifier did not rotate within the same session family.')
    const newAccess = await cookie(restored, 'access'), newRefresh = await cookie(restored, 'refresh')
    assertCookieOptions(newAccess, newRefresh)
    assert(fresh.expiresAt < newRefresh.expires * 1000, 'The active session was given the refresh credential’s longer expiry.')
    assert(newAccess.value !== oldAccess.value && newRefresh.value !== oldRefresh.value, 'Rotation did not replace both opaque credential values.')
    checks.twoTabsRestoredViaOneRotation = true

    state.phase = 'reader-rotation-preserves-editor'
    assert.equal(await auth.readSessionHandle(restored, adminOrigin, R.AuthoringSession), authoringHandle)
    await verifyDirtyWorkspace(writer, workspace)
    checks.readerRotationRetainedDirtyWorkspaceAndInspector = true
    state.phase = 'persist-dirty-workspace'
    await writer.bringToFront()
    await button(roleWithExactName(writer, 'complementary', 'Article inspector'), 'Close').click()
    const saved = await saveFromEditor(writer)
    const retained = await readFrame(saved, FrameType.Draft, wire.decodeDraft)
    assert((await saved.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()] === authoringHandle,
      'The preserved workspace must continue using its separate administrator credential.')
    assert(retained.title === workspace.title && retained.body === workspace.body, 'The preserved dirty inputs were not saved byte for byte.')
    checks.dirtyWorkspaceSavedUsingIndependentAdminCredential = true

    state.phase = 'stale-editor-create-rejected'
    await rejectStaleDraftCreate(await restored.storageState(), authoringHandle)
    checks.staleCreateRejectedAfterAccountSwitch = true

    state.phase = 'rotation-replay'
    await probeRow('expire-grace')
    await refreshError(await rotateVia(stale), 401, 'REFRESH_FAMILY_COMPROMISED')
    await checkSession(restored, 401)
    assertStatus(await rotateVia(restored.request), 401)
    checks.retiredTokenReplayRevokedFamily = true
  } finally { await stale.dispose() }
  const peerAfter = await checkSession(peer.context, 200)
  assert(peerAfter.name === peerState.name && peerAfter.generation === peerState.generation &&
    (await cookie(peer.context, 'access')).value === peerCookie.value, 'An independent session changed during another account’s rotation.')
  checks.independentAccountUnaffected = true

  state.phase = 'persistent-sign-out'
  await emptySuccess(await clickApi(peer.page, R.SignOut, 'Log out'))
  await peer.page.waitForURL(origin + '/')
  await checkSession(peer.context, 401)
  await passkey(peer.page, true, 1)
  const signedOutAccess = await cookie(peer.context, 'access'), signedOutRefresh = await cookie(peer.context, 'refresh')
  await emptySuccess(await clickApi(peer.page, R.SiteRefreshSignOut, 'Log out'))
  await checkSession(peer.context, 401)
  assert(!(await cookie(peer.context, 'refresh', false)) && !(await cookie(peer.context, 'access', false)),
    'Sign-out left authentication cookies in the browser.')
  await auth.assertStaleSessionRejected(origin, [signedOutAccess, signedOutRefresh], async client => assertStatus(await rotateVia(client), 401))
  checks.persistentSignOutRevokedBothCredentials = true
  assert.deepEqual(faults, [])
  state.phase = 'passed'
})

async function passkey(page, remember, expectedPhase) {
  await page.goto(origin + '/login')
  const choice = exactCheckbox(page, 'Keep me signed in'), label = exactText(page, 'Keep me signed in')
  await label.waitFor()
  assert.equal(await choice.isChecked(), false, 'Persistent sign-in must be an explicit choice.')
  if (remember) {
    await label.click()
    assert.equal(await choice.isChecked(), true)
  }
  const reply = await clickApi(page, R.PasskeyLoginComplete, 'Log in with Passkey')
  assert.equal((await readFrame(reply, FrameType.AuthLoginFlow))[4], expectedPhase)
  if (expectedPhase === 1) await page.waitForURL(origin + '/user/identity/mfa')
}

async function checkSession(context, status) {
  const reply = await context.request.get(origin + R.Session)
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
    return { ...wire.decodeSession(decodeFrame(await reply.body(), FrameType.OperatorSession).payload), expiresAt, persistent, handle, continuity }
  }
}

async function cookie(context, kind, required = true) {
  const value = (await context.cookies(origin + (kind === 'refresh' ? R.SiteRefreshRotate : R.Session))).find(candidate => candidate.name === cookieNames[kind])
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

const rotateVia = api => api.post(origin + R.SiteRefreshRotate, { headers: { Origin: origin }, maxRedirects: 0 })

async function refreshError(reply, status, message) {
  assert.equal(decodeApiError(await readFrame(reply, FrameType.ApiError, null, status), status).message, message)
}

async function probeRow(action) {
  const { stdout } = await adminFx.runFixtureCommand(probe, [action], 5_000)
  assert.equal(stdout.trim(), '1', 'Expected one fixture row to move its expiry boundary.')
}

async function holdBothExpiredReads(first, second) {
  // Each tab observes the expired access before either can elect a rotation leader.
  const both = Promise.withResolvers()
  let ready = 0
  await Promise.all([first, second].map(page => page.route(origin + R.Session, async route => {
    const expired = await route.fetch({ maxRedirects: 0 })
    if (++ready === 2) both.resolve()
    await both.promise
    await route.fulfill({ response: expired })
  }, { times: 1 })))
}

async function openDirtyWorkspace(writer, handle) {
  const savedTitle = 'Persistent workspace baseline'
  const { id } = await adminFxAuthor.createDraft(writer.context(), savedTitle, 'Saved Markdown.', handle)
  await writer.goto(adminOrigin + '/admin/articles/workspace')
  const workspace = await openWorkspaceDialog(writer)
  await exactLabel(workspace, 'Article ID').fill(String(id))
  await button(workspace, 'Open article').click()
  await writer.waitForURL(adminOrigin + '/admin/articles/edit/' + id)
  await expect(workspace).toBeHidden()
  await expect(exactLabel(writer, 'Title')).toHaveValue(savedTitle)
  await button(roleWithExactName(writer, 'tablist', 'Open articles'), 'Pin ' + savedTitle).click()
  const title = 'Unsaved title spanning session rotation', body = 'Unsaved Markdown spanning session rotation.\n\nSecond paragraph.'
  await exactLabel(writer, 'Title').fill(title)
  await exactLabel(writer, 'Body').fill(body)
  await button(writer, 'Inspector').click()
  await verifyDirtyWorkspace(writer, { title, body })
  return { title, body }
}

async function verifyDirtyWorkspace(writer, workspace) {
  const tabs = roleWithExactName(writer, 'tablist', 'Open articles')
  await expect(tabs.getByRole('tab', { selected: true })).toContainText(workspace.title)
  await expect(button(tabs, 'Unpin ' + workspace.title)).toHaveAttribute('aria-pressed', 'true')
  await expect(exactLabel(writer, 'Title')).toHaveValue(workspace.title)
  await expect(exactLabel(writer, 'Body')).toHaveValue(workspace.body)
  await expect(roleWithExactName(writer, 'complementary', 'Article inspector')).toBeVisible()
}

async function saveFromEditor(page) {
  await page.bringToFront()
  const save = button(page, 'Save draft')
  await expect(save).toBeEnabled()
  return adminFx.clickForResponse(page, adminOrigin + R.Save, save, 'POST')
}

async function rejectStaleDraftCreate(storageState, handle) {
  const swapped = await browser.newContext({ storageState }), peer = await browser.newContext()
  auth.observeSiteContext(swapped, origin, 'stale-writer', responses, faults)
  const page = await swapped.newPage(), title = 'Stale author cross-account fixture'
  try {
    await signInFreshAdmin(await peer.newPage(), adminOrigin, adminPeerBootstrap)
    const peerHandle = await auth.readSessionHandle(peer, adminOrigin, R.AuthoringSession)
    assert.notEqual(peerHandle, handle)
    const peerCookies = await peer.cookies(adminOrigin)
    await page.goto(adminOrigin + '/admin/articles/write')
    await exactLabel(page, 'Title').fill(title)
    await exactLabel(page, 'Body').fill('This draft belongs to the originally authenticated account.')
    const submitted = Promise.withResolvers()
    await page.route(adminOrigin + R.Save, async route => {
      try {
        const outgoing = route.request(), headers = await outgoing.allHeaders()
        assert(headers[WireHeaders.CurrentSession.toLowerCase()] === handle, 'The editor did not submit its original credential identifier.')
        await swapped.addCookies(peerCookies)
        const response = await swapped.request.post(outgoing.url(), {
          headers: { Origin: adminOrigin, 'Content-Type': headers['content-type'],
            [WireHeaders.CurrentSession]: headers[WireHeaders.CurrentSession.toLowerCase()] },
          data: outgoing.postDataBuffer(),
        })
        await route.fulfill({ response })
        submitted.resolve()
      } catch (error) { await route.abort('failed').catch(() => {}); submitted.reject(error) }
    }, { times: 1 })
    const [rejected] = await Promise.all([saveFromEditor(page), submitted.promise])
    await refreshError(rejected, 409, 'The current browser session changed. Reload before making changes.')
    assert(await auth.readSessionHandle(swapped, adminOrigin, R.AuthoringSession) === peerHandle,
      'The stale write fixture was not using the peer account’s actual access credential.')
    const inventory = await readFrame(await peer.request.get(adminOrigin + R.AuthorArticles, { params: { keyword: title } }),
      FrameType.AuthorArticlePage, decodeAuthorArticlePage)
    assert.equal(inventory.total, 0, 'A cross-account write created an article in the peer inventory.')
  } finally {
    await peer.close()
    await swapped.close()
  }
}
