import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodeCommentRoots } from '../../src/Contracts/comment-read.ts'
import { readMfaProof } from '../../src/Contracts/mfa.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import { verifyAppearanceActivation } from './admin-appearance-flow.mjs'
import { verifyAdminArticleArchive } from './admin-article-archive-flow.mjs'
import { verifyAdminArticleRollback } from './admin-article-rollback-flow.mjs'
import { prepareAdminInboxWakeProbe, verifyAdminInbox } from './admin-inbox-flow.mjs'
import { seedModeration } from './admin-moderation-seed.mjs'
import { expectSignInHistory, rejectMismatchedSignInHistory } from './admin-sign-in-history-flow.mjs'
import { verifyAdminSitePages } from './admin-site-pages-flow.mjs'
import { verifyTaxonomy } from './admin-taxonomy-flow.mjs'
import * as adminFx from './admin-workspace-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import * as res from './response-status-fixture.mjs'
import { waitForUrlResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { FrameType, WireHeaders, WireLimits, WireRoutes: R } = wire
const env = process.env
const adminTicket = env.FSUSBLOG_TEST_ADMIN_TICKET
const siteTicket = env.FSUSBLOG_TEST_SITE_TICKET
const siteSessionToken = env.FSUSBLOG_TEST_SITE_SESSION
const revokeExecutable = env.FSUSBLOG_TEST_ADMIN_REVOKE
const moderatorBody = env.FSUSBLOG_TEST_ADMIN_MODERATOR_BODY
const taxonomySeed = env.FSUSBLOG_TEST_ADMIN_TAXONOMY_SEED
const pins = env.FSUSBLOG_TEST_TLS_SPKI
const moderationFixture = env.FSUSBLOG_TEST_ADMIN_MODERATION === '1'
const sitePagesFixture = env.FSUSBLOG_TEST_ADMIN_SITE_PAGES === '1'
assert(env.FSUSBLOG_TEST_ADMIN_URL && env.FSUSBLOG_TEST_SITE_URL && /^[0-9a-f]{64}$/.test(adminTicket ?? '') &&
  /^[0-9a-f]{64}$/.test(siteTicket ?? '') && /^[0-9a-f]{64}$/.test(siteSessionToken ?? ''),
'Provide isolated site/admin origins, two unused one-time fixture keys, and a seeded site session token.')
assert.notEqual(adminTicket, siteTicket, 'Use independent site and administrator fixture keys.')
assert.notEqual(adminTicket, siteSessionToken, 'Use independent site session and administrator bootstrap credentials.')
assert(!moderationFixture || (moderatorBody && revokeExecutable), 'Provide the moderation body and administrator revocation fixture.')
assert(!taxonomySeed || revokeExecutable, 'Provide the administrator revocation fixture for taxonomy acceptance.')
assert(!sitePagesFixture || revokeExecutable, 'Provide the administrator revocation fixture for site-page acceptance.')
assert([moderationFixture, taxonomySeed, sitePagesFixture].filter(Boolean).length <= 1,
  'Run administrator permission scenarios separately to preserve the rate budget.')
const adminOrigin = new URL(env.FSUSBLOG_TEST_ADMIN_URL)
const siteOrigin = new URL(env.FSUSBLOG_TEST_SITE_URL)
const adminBase = adminOrigin.origin
const siteBase = siteOrigin.origin
assert.equal(adminOrigin.hostname, moderationFixture ? 'admin.localhost' : 'localhost', 'The admin fixture requires its own relying party.')
assert.equal(siteOrigin.hostname, moderationFixture ? 'localhost' : '127.0.0.1', 'The site account fixture uses a different loopback host.')
const evidence = resolve(env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/admin-identity-browser')

const adminPath = '/api/v2/admin/identity'
const adminPage = adminBase + '/admin/identity'
const secureAdmin = adminOrigin.protocol === 'https:'
if (pins !== undefined) {
  assert(secureAdmin && siteOrigin.protocol === 'https:' &&
    /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins), 'TLS fixtures need two SHA-256 leaf public-key pins.')
}
const adminSessionUrl = adminBase + R.AdminSession
const adminCookieName = secureAdmin ? '__Host-FsusAdminSession' : 'fsus-v2-admin-session'
const siteCookieName = 'fsus-v2-session'
const revokedMessage = 'Your administrator session expired or was revoked. Log in again.'
const checks = {}, responses = [], faults = []
const startedAt = new Date().toISOString()
const browser = await auth.launchIdentityBrowser(pins)
const chromiumVersion = browser.version()
let phase = 'site-session'

async function withAnonymousRequest(run) {
  const client = await auth.request.newContext()
  try { return await run(client) } finally { await client.dispose() }
}

const expectGet = (context, url, status, ...message) => res.assertGetStatus(context.request, url, status, ...message)

async function clearCookieAndReload(page, context, priorCookie) {
  await context.clearCookies({ name: adminCookieName })
  if (priorCookie) await probeAdminCookie(adminSessionUrl, priorCookie, 200)
  await page.reload()
}

await isolated.withBrowserEvidence(browser, evidence, 'admin-identity-result.json', () => ({
  adminOrigin: adminBase, siteOrigin: siteBase, startedAt, endedAt: new Date().toISOString(),
  chromium: chromiumVersion, phase, checks, responses, faults, exitCode: phase === 'passed' ? 0 : 1,
}), async () => {
  const context = await isolated.openLocaleContext(browser, [adminBase, siteBase], { viewport: { width: 1280, height: 800 } })
  context.setDefaultTimeout(18_000)
  context.setDefaultNavigationTimeout(18_000)
  context.on('response', response => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith(adminPath + '/') && !url.pathname.startsWith('/api/v2/identity/')) return
    responses.push({ host: url.hostname, path: url.pathname, status: response.status() })
    if (response.status() >= 500) faults.push({ path: url.pathname, status: response.status() })
  })
  const site = await context.newPage()
  const admin = await context.newPage()
  for (const page of [site, admin]) page.on('pageerror', () => faults.push({ kind: 'uncaught-page-error' }))
  await auth.enableAuthenticator(context, admin)

  const rejectedSiteTicket = await context.request.post(adminBase + R.AdminBootstrapBegin, {
    headers: { [WireHeaders.AdminBootstrapToken]: siteTicket },
  })
  assert(rejectedSiteTicket.status() >= 400 && rejectedSiteTicket.status() < 500, 'An unspent site fixture key cannot bootstrap an administrator.')
  res.assertStatus(await adminFx.postBinary(context.request, siteBase + R.SignIn, siteBase, Buffer.alloc(0)),
    401, 'Raw ticket sign-in must fail closed with passkey_required.')
  await context.addCookies([{
    name: siteCookieName, value: siteSessionToken, url: siteBase,
    httpOnly: true, secure: siteOrigin.protocol === 'https:', sameSite: 'Lax',
  }])
  const siteCookie = await readCookie(context, siteBase + R.Session, siteCookieName)
  res.assertFields(siteCookie, { httpOnly: true, secure: siteOrigin.protocol === 'https:' })
  await res.readFrame(await context.request.get(siteBase + R.Session), FrameType.OperatorSession)
  await rejectSiteCredential(adminSessionUrl, siteCookie)
  checks.siteSessionCannotAuthorizeAdmin = true

  phase = 'bootstrap'
  const landing = await admin.goto(adminPage)
  if (secureAdmin) {
    assert.match((await landing.securityDetails())?.protocol ?? '', /^TLS/)
    assert.equal(await admin.evaluate(() => window.isSecureContext), true)
    checks.realHttpsWebAuthnContext = true
  }
  await loc.exactHeading(admin, 'Administrator access').waitFor()
  await res.assertGetAll(context.request, 401, [adminSessionUrl, adminBase + R.AdminOperationsStatus, adminBase + R.AdminSignInHistory])
  await res.assertGetAll(context.request, 404, [siteBase + R.AdminOperationsStatus, siteBase + R.AdminSignInHistory])
  await rejectSiteCredential(adminBase + R.AdminOperationsStatus, siteCookie)
  await probeAdminCookie(adminBase + R.AdminSignInHistory, siteCookie, 401)
  await loc.exactButton(admin, 'Set up administrator Passkey').click()
  await loc.exactLabel(admin, 'One-time administrator bootstrap key').fill(adminTicket)
  const registrationBegin = waitPost(admin, R.AdminBootstrapBegin)
  const registration = await clickAndWait(admin, R.AdminBootstrapComplete, 'Create administrator Passkey')
  assert.equal(await frameType(await registrationBegin), FrameType.PasskeyRegisterBegin)
  await res.assertEmpty(registration)
  await loc.exactText(admin, 'Administrator Passkey created. Log in with it to continue.').waitFor()
  await expectGet(context, adminSessionUrl, 401)
  assert(!await auth.findCookie(context, adminSessionUrl, adminCookieName))
  await rejectReplay(context, registration)
  const reusedTicket = await context.request.post(adminBase + R.AdminBootstrapBegin, {
    headers: { [WireHeaders.AdminBootstrapToken]: adminTicket },
  })
  assert(reusedTicket.status() >= 400 && reusedTicket.status() < 500, 'Completed registration must consume the bootstrap key.')
  checks.bootstrapRequiresPasskeyAndDoesNotSignIn = true
  checks.bootstrapCompletionCannotReplay = true

  phase = 'admin-login'
  const firstLogin = await logIn(admin)
  const initial = await snapshot(context)
  await adminFx.visitAdminWorkspace(admin, '/admin/site')
  await loc.exactHeading(admin, 'Service & version').waitFor()
  await adminFx.visitAdminWorkspace(admin, '/admin/interaction')
  await loc.exactTab(admin, 'Moderation queue').waitFor()
  await loc.exactTab(admin, 'Support inbox').click()
  await loc.exactHeading(admin, 'Support inbox').waitFor()
  await adminFx.visitAdminWorkspace(admin, '/admin/identity')
  await loc.exactButton(admin, 'Reload administrator access').waitFor({ state: 'detached' })
  checks.unifiedAdministratorAccessesWorkspaceSections = true
  const oldCookie = await adminSessionCookie(context)
  res.assertFields(oldCookie, { httpOnly: true, sameSite: 'Strict', path: secureAdmin ? '/' : adminPath, secure: secureAdmin, domain: adminOrigin.hostname })
  assertNoCredential(initial.body, oldCookie.value)
  await rejectMismatchedSignInHistory(admin, adminBase)
  checks.signInHistoryRejectsWrongSessionBinding = true
  const [initialSignIn] = await expectSignInHistory({ page: admin, context, origin: adminBase,
    generation: initial.principal.generation, currentCookie: oldCookie.value, expected: ['Current'] })
  await rejectReplay(context, firstLogin)
  assert((await adminSessionCookie(context)).value === oldCookie.value,
    'A replay must leave the current admin browser credential unchanged.')
  for (const [url, msg] of [[siteBase + R.AdminSession, 'Admin endpoints are unavailable on the site host.'],
    [adminBase + R.Session, 'The dedicated admin origin does not expose site identity routes.'],
    [adminBase + '/', 'The dedicated admin origin does not serve the public home page.']])
    await expectGet(context, url, 404, msg)
  await probeAdminCookie(siteBase + R.Session, oldCookie, 401)
  await credentialProbe(siteBase + R.Session, siteCookieName, oldCookie.value, 401)
  res.assertStatus(await context.request.post(adminBase + R.AdminSignOut, { headers: { Origin: siteBase } }), 403)
  await probeAdminCookie(adminSessionUrl, oldCookie, 200)
  Object.assign(checks, { adminSessionCannotAuthorizeSite: true, dedicatedOriginRoutesAreIsolated: true,
    assertionReplayDoesNotRotateSession: true, crossOriginLogoutDenied: true })

  phase = 'rotation'
  // Removing the local cookie leaves its server-side session active until fresh WebAuthn succeeds.
  await clearCookieAndReload(admin, context, oldCookie)
  await logIn(admin)
  const renewed = await snapshot(context)
  const newCookie = await adminSessionCookie(context)
  assert(newCookie.value !== oldCookie.value, 'Fresh administrator authentication must issue a different session credential.')
  assert.equal(renewed.principal.handle, initial.principal.handle)
  assert(renewed.principal.generation >= initial.principal.generation)
  await rejectRetiredAdminSession(oldCookie)
  assertNoCredential(renewed.body, newCookie.value)
  const [, retiredSignIn] = await expectSignInHistory({ page: admin, context, origin: adminBase,
    generation: renewed.principal.generation, currentCookie: newCookie.value, expected: ['Current', 'Ended'] })
  assert.equal(retiredSignIn.startedAt, initialSignIn.startedAt)
  await isolated.saveShot(admin, evidence, 'administrator-session.png', {})
  checks.freshPasskeyRotatesPriorAdminSession = true
  checks.recentSignInsAreBoundToOwnCurrentSession = true

  let finalCookie = newCookie
  if (revokeExecutable) {
    phase = 'offline-revocation'
    const checkWakeRevocation = env.FSUSBLOG_TEST_ADMIN_INBOX_LIVE === '1'
      ? await prepareAdminInboxWakeProbe(context, adminBase) : undefined
    if (checkWakeRevocation) await admin.bringToFront()
    await clearCookieAndReload(admin, context, newCookie)
    await revokeDuringLogin(admin, revokeExecutable)
    if (checkWakeRevocation) {
      await checkWakeRevocation()
      checks.adminInboxWakeRechecksRevocationAndRejectsClientMessages = true
    }
    await expectGet(context, adminSessionUrl, 401)
    await rejectRetiredAdminSession(newCookie)

    await logIn(admin)
    const fresh = await snapshot(context)
    finalCookie = await adminSessionCookie(context)
    assert.equal(fresh.principal.handle, renewed.principal.handle)
    assert(fresh.principal.generation > renewed.principal.generation, 'A new challenge must see the advanced generation.')
    assert(finalCookie.value !== newCookie.value, 'A new challenge must establish a different session credential.')
    await expectSignInHistory({ page: admin, context, origin: adminBase,
      generation: fresh.principal.generation, currentCookie: finalCookie.value, expected: ['Current', 'Ended', 'Ended'] })
    checks.offlineRevocationInvalidatesPendingChallenge = true
    checks.offlineRevocationRetiresOwnSignIn = true
  }

  const hasSpecializedScenario = Boolean(moderationFixture || taxonomySeed || sitePagesFixture ||
    env.FSUSBLOG_TEST_ADMIN_APPEARANCE === '1' || env.FSUSBLOG_TEST_ADMIN_INBOX === '1' ||
    env.FSUSBLOG_TEST_ADMIN_ARTICLE_ARCHIVE === '1' || env.FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK === '1')
  if (!hasSpecializedScenario) {
    phase = 'operations-status'
    finalCookie = await verifyOperationsStatus(admin, context, siteCookie, finalCookie, revokeExecutable)
    checks.operationsStatusBoundToCurrentAdminSession = true
  }

  if (moderationFixture) {
    phase = 'moderation'
    await isolated.withTempContext(browser, { viewport: { width: 1280, height: 800 } }, async reader => {
      const author = await reader.newPage()
      const articleId = await seedModeration({ reader: author, adminOrigin: adminBase, siteOrigin: siteBase, body: moderatorBody })
      await admin.bringToFront()
      finalCookie = await verifyModeration(admin, context, siteCookie, oldCookie, finalCookie, articleId, author)
    })
    Object.assign(checks, { moderationRequiresLiveAdministratorSession: true, moderationBodyIsTextAndPendingIsPrivate: true,
      moderationRevocationInvalidatesOldSessions: true, adminSensitivePasskeyProofIsScopedAndOneUse: true,
      onlineModerationClaimGenerationsAndVisibility: true, onlineModerationDecisionProofCannotReplay: true })
  }

  const permissionFixture = { page: admin, context, adminOrigin, siteOrigin, adminCookieName, siteCookie }
  const runPermission = (verify, extra = {}) =>
    verify({ ...permissionFixture, priorCookie: finalCookie, revoke: revokeExecutable, logIn, probe: credentialProbe, readCookie, evidence, ...extra })
  if (taxonomySeed) {
    phase = 'taxonomy'
    finalCookie = await runPermission(verifyTaxonomy, { seed: taxonomySeed, snapshot })
    Object.assign(checks, { taxonomyRequiresLiveAdministratorSession: true,
      taxonomyCountersAndCursorUseStoredRevisions: true, taxonomyRevocationInvalidatesOldSessions: true })
  }

  if (env.FSUSBLOG_TEST_ADMIN_APPEARANCE === '1') {
    assert(revokeExecutable, 'Provide the administrator revocation fixture for appearance acceptance.')
    phase = 'appearance-activation'
    finalCookie = await runPermission(verifyAppearanceActivation)
    checks.signedAppearanceActivationAndRollbackEvictSupersededAssets = true
  }

  if (sitePagesFixture) {
    phase = 'site-pages'
    finalCookie = await runPermission(verifyAdminSitePages)
    checks.pageReadsRequireLiveAdministratorSession = true
    checks.pageReadsMatchPublicAedsAndExcludeSiteHostAndWrites = true
    if (env.FSUSBLOG_TEST_ADMIN_SITE_PAGE_EDITOR === '1')
      checks.pagePublishUsesPasskeyPowAndVersionedPublicRepresentations = true
  }

  if (env.FSUSBLOG_TEST_ADMIN_INBOX === '1') {
    phase = 'support-inbox'
    if (env.FSUSBLOG_TEST_ADMIN_INBOX_LIVE === '1')
      assert(checks.adminInboxWakeRechecksRevocationAndRejectsClientMessages, 'Live administrator inbox acceptance requires the revocation fixture.')
    const viewport = admin.viewportSize()
    try { await verifyAdminInbox(admin, context, adminBase, siteBase, siteCookie, adminCookieName, credentialProbe, evidence) }
    finally { if (viewport) await admin.setViewportSize(viewport) }
    checks.adminInboxOnlyShowsPrivateThreadsToCurrentAdmin = true
  }

  const archive = env.FSUSBLOG_TEST_ADMIN_ARTICLE_ARCHIVE === '1'
  if (archive || env.FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK === '1') {
    phase = archive ? 'article-archive' : 'article-rollback'
    const bootstrap = env.FSUSBLOG_TEST_ADMIN_ARTICLE_OWNER
    assert(bootstrap, 'Provide a separate administrator Passkey bootstrap for the article owner.')
    await isolated.withTempContext(browser, async owner => {
      await signInFreshAdmin(await owner.newPage(), adminBase, bootstrap)
      await (archive ? verifyAdminArticleArchive : verifyAdminArticleRollback)({ ...permissionFixture, owner, probe: credentialProbe, evidence })
      await res.assertEmpty(await owner.request.post(adminBase + R.AdminSignOut, { headers: { Origin: adminBase } }))
    })
    finalCookie = await adminSessionCookie(context)
    if (archive) checks.articleArchiveAndRepublicationUseIndependentAdminAndStableReceipts = true
    else checks.articleRollbackUsesIndependentAdminAndStableReceipt = true
  }

  await adminFx.visitAdminWorkspace(admin, '/admin/identity')
  phase = 'logout'
  // Seed the site credential into the admin host only in this test to detect a shared cookie-clearing helper.
  await context.addCookies([{ ...siteCookie, domain: adminOrigin.hostname }])
  await res.assertEmpty(await clickAndWait(admin, R.AdminSignOut, 'Log out of administrator session'))
  await loc.exactButton(admin, 'Log in as administrator').waitFor()
  await res.assertGetAll(context.request, 401, [adminSessionUrl, adminBase + R.AdminOperationsStatus])
  for (const url of [adminSessionUrl, adminBase + R.AdminOperationsStatus, adminBase + R.AdminSignInHistory])
    await probeAdminCookie(url, finalCookie, 401)
  if (archive) {
    await probeAdminCookie(adminBase + adminPath + '/articles.aeds', finalCookie, 401)
    assert.equal(await loc.exactHeading(admin, 'Article inventory').count(), 0, 'Panel "Article inventory" must remain hidden.')
  }
  await expectGet(context, siteBase + R.Session, 200)
  assert((await readCookie(context, siteBase + R.Session, siteCookieName)).value === siteCookie.value,
    'Administrator logout must preserve the existing site cookie.')
  assert((await readCookie(context, adminBase + R.Session, siteCookieName)).value === siteCookie.value,
    'Administrator logout must also leave the site cookie name alone on its own host.')
  await res.assertEmpty(await context.request.post(siteBase + R.SignOut))
  await isolated.saveShot(admin, evidence, 'administrator-logged-out.png', {})
  checks.adminLogoutPreservesSiteSession = true
  assert.deepEqual(faults, [])
  phase = 'passed'
}, { mkdir: true })

async function logIn(page) {
  const destination = new URL(page.url()).pathname
  const [beginning, completed] = await Promise.all([
    waitPost(page, R.AdminPasskeyBegin),
    clickAndWait(page, R.AdminPasskeyComplete, 'Log in as administrator'),
  ])
  assert.equal(await frameType(beginning), FrameType.PasskeyLoginBegin)
  await res.assertEmpty(completed)
  await adminFx.visitAdminWorkspace(page, '/admin/identity')
  await loc.exactHeading(page, 'Administrator session').waitFor()
  await adminFx.visitAdminWorkspace(page, destination)
  return completed
}

async function revokeDuringLogin(page, executable) {
  const beginning = waitPost(page, R.AdminPasskeyBegin)
  const offlineRevocation = Promise.withResolvers()
  await page.route(adminBase + R.AdminPasskeyComplete, async route => {
    try {
      assert.equal(await frameType(await beginning), FrameType.PasskeyLoginBegin)
      await adminFx.runFixtureCommand(executable)
      await route.continue()
      offlineRevocation.resolve()
    } catch {
      await route.abort().catch(() => {})
      offlineRevocation.reject(new Error('The isolated offline revocation fixture did not complete.'))
    }
  }, { times: 1 })
  const [response] = await Promise.all([
    clickAndWait(page, R.AdminPasskeyComplete, 'Log in as administrator'), offlineRevocation.promise,
  ])
  res.assertStatus(response, 401, 'An assertion begun before the offline revocation must not establish a session.')
  await page.getByRole('alert').filter({ hasText: 'Could not log in with this administrator Passkey. Try again.' }).waitFor()
}

function waitPost(page, path) { return waitForUrlResponse(page, () => adminBase + path, 'POST', { timeout: 12_000 }) }

async function verifyOperationsStatus(page, context, siteCookie, priorCookie, revoke) {
  await adminFx.visitAdminWorkspace(page, '/admin/site')
  const endpoint = adminBase + R.AdminOperationsStatus
  const operationsSection = loc.exactRegion(page, 'Service & version')
  const statusButton = loc.exactButton(operationsSection, 'Re-check')
  const waitOperationsIdle = async () => {
    await statusButton.waitFor()
    await operationsSection.locator('button.is-loading').waitFor({ state: 'detached' })
  }
  const checkStatus = async () => {
    await waitOperationsIdle()
    return adminFx.clickForResponse(page, endpoint, statusButton)
  }
  const alert = text => page.getByRole('alert').filter({ hasText: text })
  const displayedSnapshot = loc.exactText(operationsSection, 'Public snapshot ready')

  await expectGet(context, siteBase + R.AdminOperationsStatus, 404)
  await rejectSiteCredential(endpoint, siteCookie)

  const active = await snapshot(context)
  const association = WireHeaders.AdminPermissionSession.toLowerCase()
  await displayedSnapshot.waitFor()
  const status = await checkStatus()
  res.assertStatus(status, 200)
  await res.assertNoStore(status)
  assert(active.binding && status.headers()[association] === active.binding)
  const body = await status.body()
  assertNoCredential(body, priorCookie.value)
  const observed = wire.decodeAdminOperationsStatus(decodeFrame(body, FrameType.AdminOperationsStatus).payload)
  assert.equal(observed.snapshotReady, true, 'This running fixture must report its published snapshot.')
  assert(observed.publicationWatermark >= 0n && observed.pendingPublicationEvents >= 0n)
  assert(observed.pendingPublicationEvents === 0n ? observed.oldestPendingAt === 0n : observed.oldestPendingAt > 0n)
  await loc.exactHeading(operationsSection, 'Service & version').waitFor()
  for (const name of ['Content sync', 'Version', 'Process start']) await loc.exactText(operationsSection, name).waitFor()

  await clearCookieAndReload(page, context)
  await logIn(page)
  await displayedSnapshot.waitFor()
  await waitOperationsIdle()
  const expired = await probeAdminCookie(endpoint, priorCookie, 401, true)
  const rotatedCookie = await adminSessionCookie(context)
  assert(rotatedCookie.value !== priorCookie.value)
  const rotated = await snapshot(context)
  const unavailable = alert('Could not check service and version status. Try again.')
  for (const [code, payload] of [[200, body], [401, expired]]) {
    await page.route(endpoint, route => route.fulfill({ status: code, body: payload, contentType: 'application/octet-stream',
      headers: { [association]: active.binding } }), { times: 1 })
    res.assertStatus(await checkStatus(), code)
    await unavailable.waitFor()
    await displayedSnapshot.waitFor({ state: 'hidden' })
    assert(await unavailable.isVisible(), 'A retired session response must not render or sign out the current administrator.')
    assert.equal(await alert(revokedMessage).count(), 0)
  }
  assert.equal((await checkStatus()).headers()[association], rotated.binding)
  await displayedSnapshot.waitFor()
  await waitOperationsIdle()
  checks.operationsStatusRejectsOtherSessionBinding = true
  await isolated.saveShot(page, evidence, 'administrator-operations-status.png', {})

  if (revoke) {
    await page.route(endpoint, async route => {
      const issued = await route.fetch()
      await adminFx.runFixtureCommand(revoke)
      await route.fulfill({ response: issued })
    }, { times: 1 })
    res.assertStatus(await checkStatus(), 200)
    await rejectRetiredAdminSession(rotatedCookie)
    await probeAdminCookie(endpoint, rotatedCookie, 401)
    await page.reload()
    const [cluster] = await Promise.all([
      waitForUrlResponse(page, () => adminBase + R.AdminClusterStatus, 'GET'), logIn(page),
    ])
    // This fixture performs several rapid refreshes. Allow the server's one-minute window to reset.
    if (cluster.status() === 429) await delay(60_000)
    else res.assertStatus(cluster, 200)
    checks.operationsStatusRecheckedAfterRevocation = true
    assert((await snapshot(context)).principal.generation > rotated.principal.generation)
    res.assertStatus(await checkStatus(), 200)
    await displayedSnapshot.waitFor()
  }
  return adminSessionCookie(context)
}

async function verifyModeration(page, context, siteCookie, priorCookie, currentCookie, articleId, author) {
  await adminFx.visitAdminWorkspace(page, '/admin/interaction')
  const publicRoute = siteBase + R.CommentRoots.replace('{articleId:int}', String(articleId))
  await withAnonymousRequest(async anonymous => {
    await res.assertGetStatus(anonymous, siteBase + '/article/' + articleId, 200, 'The pending comment requires a genuinely published article.')
    const payload = await res.readFrame(await anonymous.get(publicRoute), FrameType.CommentTreeRootCursor)
    assert(!Buffer.from(payload).includes(moderatorBody), 'A pending comment must stay hidden publicly.')
  })

  const endpoint = adminBase + R.AdminCommentQueue
  const section = loc.exactRegion(page, 'Moderation queue')
  const checkQueue = () => adminFx.clickForResponse(page, endpoint, loc.exactButton(section, 'Refresh'))
  const revoked = page.getByRole('alert').filter({ hasText: revokedMessage })
  const bodyText = loc.exactText(section, moderatorBody)
  await expectGet(context, siteBase + R.AdminCommentQueue, 404)
  await rejectSiteCredential(endpoint, siteCookie)
  await probeAdminCookie(endpoint, priorCookie, 401)
  const active = await snapshot(context)
  const queue = await checkQueue()
  res.assertStatus(queue, 200)
  await res.assertNoStore(queue)
  const payload = await queue.body()
  assertNoCredential(payload, currentCookie.value)
  const row = readModerationFixture(payload, articleId)
  await bodyText.waitFor()
  const displayedComment = section.getByRole('article').filter({ has: loc.exactText(page, moderatorBody) })
  await displayedComment.getByText(`Article ${articleId} · Comment ${row.commentId}`).waitFor()
  assert.equal(await displayedComment.locator('time').getAttribute('datetime'), new Date(Number(row.createdAt)).toISOString())
  assert.equal(await section.locator('[data-moderation-fixture]').count(), 0, 'Pending markup must render as plain text.')
  await isolated.saveShot(page, evidence, 'administrator-moderation-queue.png', {})
  await verifyAdminModerationProof(page, context, siteCookie, priorCookie, currentCookie, articleId, row, checkQueue)
  await verifyOnlineModeration(page, context, section, publicRoute, row, checkQueue)
  const timelinePath = commentId => R.AdminCommentTimeline.replace('{id:long}', String(commentId)) + `?articleId=${articleId}`
  const historyPath = timelinePath(row.commentId)
  const revisionsPath = R.AdminCommentRevisions.replace('{id:long}', row.commentId.toString())
  await expectGet(context, siteBase + revisionsPath, 404)
  await probeAdminCookie(adminBase + revisionsPath, siteCookie, 401)
  await loc.exactText(section, 'Look up by article & comment ID').click()
  const historyArticle = loc.exactLabel(section, 'Article ID')
  const historyComment = loc.exactLabel(section, 'Comment ID')
  const history = commentId => loc.exactDialog(page, `Comment history & revisions (Article ${articleId} · Comment ${commentId})`)
  const closeHistory = async dialog => { await loc.exactButton(dialog, 'Close').click(); await dialog.waitFor({ state: 'hidden' }) }
  async function openHistory(commentId, path, trigger = historyComment, status = 200) {
    await historyArticle.fill(String(articleId))
    await historyComment.fill(String(commentId))
    const reply = await adminFx.pressForResponse(page, adminBase + path, trigger)
    res.assertStatus(reply, status)
    if (status === 200) assert.equal(await reply.headerValue('cache-control'), 'no-store')
    return history(commentId)
  }
  assert.equal(await historyComment.getAttribute('inputmode'), 'numeric')
  const approvedHistory = await openHistory(row.commentId, historyPath)
  await expectGet(context, siteBase + historyPath, 404)
  res.assertStatus(await context.request.post(adminBase + historyPath), 404)
  await approvedHistory.getByRole('status').filter({ hasText: 'Current status: Approved.' }).waitFor()
  const entries = approvedHistory.locator('ul').getByRole('listitem')
  assert.deepEqual(await entries.locator('strong').allTextContents(), ['Submitted', 'Approved'])
  assert((await entries.nth(1).textContent()).includes('Moderation integration fixture'))
  await isolated.withViewport(page, 375, 800, async () => {
    await adminFx.assertFitsWidth(approvedHistory)
    await isolated.saveShot(approvedHistory, evidence, 'administrator-comment-history-375.png', {})
    await closeHistory(approvedHistory)
    const missingComment = '9007199254740993'
    const missingHistory = await openHistory(missingComment, timelinePath(missingComment), historyComment, 404)
    await missingHistory.getByRole('alert').filter({ hasText: 'Comment history was not found for these IDs.' }).waitFor()
    assert.equal(await missingHistory.getByRole('listitem').count(), 0, 'Changing the coordinate must clear the previous timeline.')
    await closeHistory(missingHistory)
  })
  checks.commentModerationHistory = true
  if (env.FSUSBLOG_TEST_ADMIN_COMMENT_BATCH === '1') {
    const { verifyAdminModerationBatch } = await import('./admin-comment-batch-flow.mjs')
    await verifyAdminModerationBatch({ page, context, section, adminOrigin: adminBase, publicRoute, evidence })
  } else {
    assert.equal(await section.getByRole('button', { name: 'Claim selected comments' }).count(), 0)
    res.assertStatus(await context.request.post(adminBase + R.AdminModerationBatchClaim), 404)
  }
  let editedHistoryPath
  if (env.FSUSBLOG_TEST_COMMENT_REPLY === '1') {
    const { verifyApprovedReply } = await import('./comment-reply-flow.mjs')
    const edited = await verifyApprovedReply({ recipient: author, browser: context.browser(), siteOrigin: siteBase, evidence, articleId, parentId: row.commentId,
      approve: async (body, commentId) => {
        await page.bringToFront()
        res.assertStatus(await checkQueue(), 200)
        const card = section.getByRole('article').filter({ has: loc.exactText(page, body) })
        const claim = await claimComment(page, card)
        assert.equal(claim.commentId, commentId)
        await applyModerationDecision(page, context, card, claim, 1, 'Approve with Passkey', 'Comment approved.')
      } })
    if (edited.editedBody) {
      editedHistoryPath = R.AdminCommentRevisions.replace('{id:long}', String(edited.commentId)) + `?articleId=${articleId}`
      await page.bringToFront()
      await isolated.withViewport(page, 375, 800, async () => {
        const revisionHistory = await openHistory(edited.commentId, editedHistoryPath, loc.exactButton(section, 'View comment revisions'))
        await loc.exactHeading(revisionHistory, 'Saved comment revisions').waitFor()
        await revisionHistory.and(page.locator(':focus-within')).waitFor()
        const items = revisionHistory.getByRole('listitem').filter({ has: page.getByText(/^Revision \d+$/, { exact: true }) })
        assert.deepEqual(await items.locator('strong').allTextContents(), ['Revision 2', 'Revision 1'])
        assert.equal(await items.first().locator('p').textContent(), edited.editedBody)
        assert.equal(await items.last().locator('p').textContent(), edited.originalBody)
        await loc.exactText(items.last(), 'Content SHA-256').click()
        assert.equal(await items.last().locator('code').textContent(), adminFx.sha256Hex(edited.originalBody))
        await adminFx.assertFitsWidth(revisionHistory)
        await isolated.saveShot(revisionHistory, evidence, 'administrator-comment-revisions-375.png', {})
        await closeHistory(revisionHistory)
      })
      checks.commentRevisionHistory = true
    }
  }
  if (env.FSUSBLOG_TEST_COMMENT_APPEAL === '1') {
    const { verifyCommentAppeal } = await import('./comment-appeal-flow.mjs')
    await verifyCommentAppeal({ page, context, author, siteOrigin: siteBase, adminOrigin: adminBase,
      publicRoute, rejectBody: moderatorBody + ' [reject fixture]', evidence })
  }

  await adminFx.runFixtureCommand(revokeExecutable)
  for (const url of [adminBase + historyPath, ...(editedHistoryPath ? [adminBase + editedHistoryPath] : []), endpoint])
    await probeAdminCookie(url, currentCookie, 401)
  res.assertStatus(await checkQueue(), 401)
  await revoked.waitFor()
  await bodyText.waitFor({ state: 'hidden' })
  await logIn(page)
  assert((await snapshot(context)).principal.generation > active.principal.generation)
  await res.assertGetAll(context.request, 200, [endpoint, adminBase + historyPath])
  return adminSessionCookie(context)
}

async function verifyOnlineModeration(page, context, section, publicRoute, expectedComment, checkQueue) {
  const card = body => section.getByRole('article').filter({ has: loc.exactText(page, body) })
  const approveCard = card(moderatorBody), rejectBody = moderatorBody + ' [reject fixture]', rejectCard = card(rejectBody)
  const claimButton = 'Claim comment for review'
  const firstResponse = await clickAndWait(page, R.AdminModerationClaim, claimButton, approveCard)
  const first = await readClaim(firstResponse)
  assert.equal(first.commentId, expectedComment.commentId)
  await loc.exactText(approveCard, 'Claimed for review').waitFor()
  await expectRepeatedPost(context, firstResponse, 409)

  const renewal = await clickAndWait(page, R.AdminModerationRenew, 'Renew claim', approveCard)
  const renewed = await readClaim(renewal)
  res.assertFields(renewed, { commentId: first.commentId, commentVersion: first.commentVersion, claimGeneration: first.claimGeneration })
  assert(renewed.claimVersion > first.claimVersion && renewed.expiresAt > first.expiresAt)
  await expectRepeatedPost(context, renewal, 409)

  const release = await clickAndWait(page, R.AdminModerationRelease, 'Release claim', approveCard)
  await res.assertEmpty(release)
  await expectRepeatedPost(context, release, 409)
  const reclaimed = await claimComment(page, approveCard)
  assert.equal(reclaimed.commentId, first.commentId)
  assert(reclaimed.claimGeneration > renewed.claimGeneration && reclaimed.claimToken !== renewed.claimToken,
    'Reacquisition must replace the original claim credential.')
  await expectRepeatedPost(context, renewal, 409)
  await isolated.saveShot(page, evidence, 'administrator-moderation-claimed.png', {})

  await applyModerationDecision(page, context, approveCard, reclaimed, 1, 'Approve with Passkey', 'Comment approved.')
  await approveCard.waitFor({ state: 'hidden' })
  res.assertStatus(await checkQueue(), 200)
  await loc.exactButton(rejectCard, claimButton).waitFor()
  await applyModerationDecision(page, context, rejectCard, await claimComment(page, rejectCard), 2, 'Reject with Passkey', 'Comment rejected.')
  await rejectCard.waitFor({ state: 'hidden' })
  res.assertStatus(await checkQueue(), 200)
  if (env.FSUSBLOG_TEST_ADMIN_COMMENT_BATCH !== '1')
    await loc.exactText(section, 'No comments are waiting for moderation.').waitFor()

  await withAnonymousRequest(async anonymous => {
    const comments = await res.readFrame(await anonymous.get(publicRoute), FrameType.CommentTreeRootCursor, decodeCommentRoots)
    assert(comments.items.some(row => row.node.id === first.commentId.toString() && row.node.content === moderatorBody),
      'The online approval must make the original comment visible publicly.')
    assert(!comments.items.some(row => row.node.content === rejectBody), 'The online rejection must keep its comment private.')
  })
  await isolated.saveShot(page, evidence, 'administrator-moderation-complete.png', {})
}

async function applyModerationDecision(page, context, card, claim, targetState, label, notice) {
  await loc.exactLabel(card, 'Reason for moderation decision').fill('Moderation integration fixture')
  const [begin, complete, applied] = await Promise.all([
    waitPost(page, R.AdminModerationStepUpBegin), waitPost(page, R.AdminStepUpComplete),
    clickAndWait(page, R.AdminModerationDecision, label, card),
  ])
  assert.equal(await frameType(begin), FrameType.PasskeyLoginBegin)
  const proof = await applied.request().headerValue(WireHeaders.MfaProof)
  adminFx.assertPasskeyProof(proof, 'The online decision must carry the fresh Passkey proof.')
  const assertionProof = readMfaProof(await res.readFrame(complete, FrameType.MfaChallengeResult), 'admin-sensitive', true)
  assert(proof === assertionProof, 'The decision must use the proof from that same real assertion.')
  assert(Buffer.from(begin.request().postDataBuffer()).equals(applied.request().postDataBuffer()),
    'The UI must submit the exact intent that was confirmed by Passkey.')
  const decision = wire.decodeAdminModerationDecision(decodeFrame(applied.request().postDataBuffer(), FrameType.AdminModerationDecision).payload)
  for (const key of ['articleId', 'commentId', 'commentVersion', 'claimToken', 'claimGeneration', 'claimVersion'])
    assert.equal(decision[key], claim[key], 'The authorized decision must bind the claimed comment and both versions.')
  res.assertFields(decision, { expectedStatus: 0, decision: targetState })
  await res.assertEmpty(applied)
  await loc.exactText(page, notice).waitFor()
  await expectRepeatedPost(context, applied, 428, proof)
  await expectRepeatedPost(context, applied, 428)
}

function claimComment(page, card) { return clickAndWait(page, R.AdminModerationClaim, 'Claim comment for review', card).then(readClaim) }

async function readClaim(response) {
  const claim = await res.readFrame(response, FrameType.AdminModerationClaim, wire.decodeAdminModerationClaim)
  assert(claim.articleId > 0 && claim.commentId > 0n && claim.commentVersion > 0n && claim.claimGeneration > 0n && claim.claimVersion > 0n)
  assert(claim.expiresAt > BigInt(Date.now()))
  adminFx.assertPasskeyProof(claim.claimToken)
  return claim
}

async function expectRepeatedPost(context, original, status, proof) {
  const response = await adminFx.postBinary(context.request, original.url(), adminBase,
    original.request().postDataBuffer(), proof ? { [WireHeaders.MfaProof]: proof } : {})
  res.assertStatus(response, status)
  if (status === 428) {
    assert(Buffer.from(decodeFrame(await response.body(), FrameType.ApiError).payload).includes('MFA_PROOF_REQUIRED'),
      'Invalid or missing proof must return MFA_PROOF_REQUIRED.')
  }
}

async function verifyAdminModerationProof(page, context, siteCookie, priorCookie, currentCookie, articleId, row, checkQueue) {
  const intent = { articleId, commentId: row.commentId, expectedStatus: 0, decision: 1, reason: 'Administrator proof fixture' }
  const postIntent = (client, data, session) => client.post(adminBase + R.AdminStepUpBegin, {
    headers: { 'Content-Type': 'application/octet-stream', ...(session ? { Cookie: adminCookieName + '=' + session } : {}) },
    data: adminFx.packFrame(FrameType.AdminModerationIntent, wire.encodeAdminModerationIntent(data)),
  })
  await withAnonymousRequest(async unauthenticated => {
    res.assertStatus(await postIntent(unauthenticated, intent, siteCookie.value), 401)
    res.assertStatus(await postIntent(unauthenticated, intent, priorCookie.value), 401)
  })
  res.assertStatus(await postIntent(context.request, { ...intent, commentId: BigInt('9223372036854775807') }), 404,
    'A proof challenge needs a real pending moderation target.')

  // Load the production TypeScript codecs into this browser. Only fixture module requests are intercepted.
  const modulePath = '/assets/test-admin-step-up/'
  await page.route(url => url.origin === adminBase && url.pathname.startsWith(modulePath), async route => {
    const name = new URL(route.request().url()).pathname.slice(modulePath.length)
    if (!/^(?:internal\/)?[a-z][a-z0-9.-]+\.ts$/.test(name)) return route.abort()
    const source = await readFile(new URL('../../src/Contracts/' + name, import.meta.url), 'utf8')
    await route.fulfill({ contentType: 'application/javascript', body: stripTypeScriptTypes(source) })
  })
  const [begin, complete, issued] = await Promise.all([
    waitPost(page, R.AdminStepUpBegin), waitPost(page, R.AdminStepUpComplete),
    page.evaluate(async ({ modulePath, articleId, commentId, expectedStatus, decision, reason }) => {
      const { proveAdminModeration } = await import(modulePath + 'admin-step-up.ts')
      return /^[A-Za-z0-9_-]{43}$/.test(await proveAdminModeration({ articleId, commentId: BigInt(commentId), expectedStatus, decision, reason }))
    }, { ...intent, commentId: intent.commentId.toString(), modulePath }),
  ])
  assert.equal(issued, true, 'The production browser codec must accept a signed administrator proof.')
  assert.equal(await frameType(begin), FrameType.PasskeyLoginBegin)
  assert.deepEqual(wire.decodeAdminModerationIntent(decodeFrame(begin.request().postDataBuffer(), FrameType.AdminModerationIntent).payload), intent)
  adminFx.assertPasskeyProof(readMfaProof(await res.readNoStoreFrame(complete, FrameType.MfaChallengeResult), 'admin-sensitive', true))
  assert((await adminSessionCookie(context)).value === currentCookie.value,
    'Administrator step-up must leave the current login credential unchanged.')

  const requestBody = complete.request().postDataBuffer()
  decodeFrame(requestBody, FrameType.PasskeyLoginCompleteRequest)
  const cookies = await complete.request().headerValue('Cookie')
  res.assertStatus(await context.request.post(adminBase + R.AdminStepUpComplete, {
    headers: { 'Content-Type': 'application/octet-stream', ...(cookies ? { Cookie: cookies } : {}) }, data: requestBody,
  }), 401, 'A completed administrator assertion must be one-use.')
  const queueAfterProof = await checkQueue()
  res.assertStatus(queueAfterProof, 200)
  assert.equal(readModerationFixture(await queueAfterProof.body(), articleId).commentId, intent.commentId,
    'Issuing a proof must leave the comment pending until a separate authorized transaction.')
}

function readModerationFixture(frame, articleId) {
  const reader = new PodReader(decodeFrame(frame, FrameType.AdminCommentQueue).payload)
  reader.bool()
  const count = reader.i32()
  assert(count > 0 && count <= WireLimits.AdminCommentQueueSize, 'The moderation fixture requires a bounded, nonempty queue.')
  let fixture = null
  for (let index = 0; index < count; index++) {
    const currentArticle = reader.i32(), commentId = reader.i64(), createdAt = reader.i64()
    const displayName = reader.text(WireLimits.PublicCommentHandleBytes), body = reader.text(WireLimits.AdminCommentQueueBodyBytes)
    assert(currentArticle > 0 && commentId > 0n && createdAt > 0n && displayName.length > 0)
    if (currentArticle === articleId && body === moderatorBody) fixture = { commentId, createdAt }
  }
  reader.finish()
  assert(fixture, 'The real moderation queue must contain the seeded pending comment.')
  return fixture
}

function clickAndWait(page, path, label, scope = page) {
  return adminFx.clickForResponse(page, adminBase + path, loc.exactButton(scope, label), 'POST', { timeout: 12_000 })
}

async function frameType(response) {
  res.assertStatus(response, 200)
  return decodeFrame(await response.body()).type
}

async function rejectReplay(context, original) {
  const payload = original.request().postDataBuffer()
  assert(payload?.length > 0)
  const headers = { 'Content-Type': 'application/octet-stream' }
  const ticket = await original.request().headerValue(WireHeaders.AdminBootstrapToken)
  if (ticket !== null) headers[WireHeaders.AdminBootstrapToken] = ticket
  const browserCookies = await original.request().headerValue('Cookie')
  if (browserCookies) headers.Cookie = browserCookies
  const replay = await context.request.post(original.url(), { headers, data: payload, maxRedirects: 0 })
  assert(replay.status() >= 400 && replay.status() < 500, 'A completed browser ceremony must be one-use.')
}

async function rejectSiteCredential(url, siteCookie) {
  await credentialProbe(url, siteCookieName, siteCookie.value, 401)
  await probeAdminCookie(url, siteCookie, 401)
}

async function rejectRetiredAdminSession(cookie) {
  await probeAdminCookie(adminSessionUrl, cookie, 401)
  await probeAdminCookie(adminBase + R.AdminSignInHistory, cookie, 401)
}

function probeAdminCookie(url, cookie, expectedStatus, ...capture) {
  return credentialProbe(url, adminCookieName, cookie.value, expectedStatus, ...capture)
}

function credentialProbe(url, name, value, expectedStatus, capture = false) {
  return withAnonymousRequest(async probe => {
    const response = await probe.get(url, { headers: { Cookie: name + '=' + value }, maxRedirects: 0 })
    res.assertStatus(response, expectedStatus, 'The explicitly selected credential must have its own scoped authority.')
    if (capture) return response.body()
  })
}

function adminSessionCookie(context) { return readCookie(context, adminSessionUrl, adminCookieName) }

async function readCookie(context, url, name) {
  const cookie = await auth.findCookie(context, url, name)
  assert(cookie, 'Expected authenticated browser credential is missing.')
  return cookie
}

async function snapshot(context) {
  const response = await context.request.get(adminSessionUrl)
  res.assertStatus(response, 200)
  await res.assertNoStore(response)
  const body = await response.body()
  const principal = wire.decodeAdminSessionSnapshot(decodeFrame(body, FrameType.AdminSessionSnapshot).payload)
  assert(principal.handle.length > 0 && principal.generation > 0n && principal.expiresAt > BigInt(Date.now()),
    'A real administrator session must have an active principal, generation, and expiration.')
  return { principal, body, binding: response.headers()[WireHeaders.AdminPermissionSession.toLowerCase()] }
}

function assertNoCredential(frame, token) {
  assert.equal(Buffer.from(token, 'hex').length, 32)
  auth.assertNoCredentialLeak(frame, [token], 'The session frame must omit all raw credentials and their stored digests.')
}
