import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, decodeSuccess, encodeFrame } from '../../src/Contracts/aeds.ts'
import { PodReader } from '../../src/Contracts/binary.ts'
import { decodeCommentRoots } from '../../src/Contracts/comment-read.ts'
import { readMfaProof } from '../../src/Contracts/mfa.ts'
import { verifyTaxonomy } from './admin-taxonomy-flow.mjs'
import { verifyAdminSitePages } from './admin-site-pages-flow.mjs'
import { verifyAppearanceActivation } from './admin-appearance-flow.mjs'
import { verifyAdminArticleRollback } from './admin-article-rollback-flow.mjs'
import { verifyAdminInbox } from './admin-inbox-flow.mjs'
import { expectPanelHidden, expectPermissions, verifyMismatchedPermissionSession } from './admin-permissions-flow.mjs'
import { expectSignInHistory, rejectMismatchedSignInHistory } from './admin-sign-in-history-flow.mjs'
import {
  decodeAdminModerationClaim, decodeAdminModerationDecision, decodeAdminModerationIntent, decodeAdminOperationsStatus, decodeAdminSessionSnapshot,
  encodeAdminModerationIntent, FrameType, WireHeaders, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const packages = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium, request } = packages('@playwright/test')
const adminUrl = process.env.FSUSBLOG_TEST_ADMIN_URL
const siteUrl = process.env.FSUSBLOG_TEST_SITE_URL
const adminTicket = process.env.FSUSBLOG_TEST_ADMIN_TICKET
const siteTicket = process.env.FSUSBLOG_TEST_SITE_TICKET
const revokeExecutable = process.env.FSUSBLOG_TEST_ADMIN_REVOKE
const auditGrant = process.env.FSUSBLOG_TEST_ADMIN_AUDIT_GRANT
const auditRevoke = process.env.FSUSBLOG_TEST_ADMIN_AUDIT_REVOKE
const moderatorGrant = process.env.FSUSBLOG_TEST_ADMIN_MODERATOR_GRANT
const moderatorRevoke = process.env.FSUSBLOG_TEST_ADMIN_MODERATOR_REVOKE
const moderatorSeed = process.env.FSUSBLOG_TEST_ADMIN_MODERATOR_SEED
const moderatorBody = process.env.FSUSBLOG_TEST_ADMIN_MODERATOR_BODY
const taxonomyGrant = process.env.FSUSBLOG_TEST_ADMIN_TAXONOMY_GRANT
const taxonomyRevoke = process.env.FSUSBLOG_TEST_ADMIN_TAXONOMY_REVOKE
const taxonomySeed = process.env.FSUSBLOG_TEST_ADMIN_TAXONOMY_SEED
const sitePagesGrant = process.env.FSUSBLOG_TEST_ADMIN_SITE_PAGES_GRANT
const sitePagesRevoke = process.env.FSUSBLOG_TEST_ADMIN_SITE_PAGES_REVOKE
assert(adminUrl && siteUrl && /^[0-9a-f]{64}$/.test(adminTicket ?? '') && /^[0-9a-f]{64}$/.test(siteTicket ?? ''),
  'Provide isolated site/admin origins and two unused one-time fixture keys.')
assert.notEqual(adminTicket, siteTicket, 'Use independent site and administrator fixture keys.')
assert(Boolean(auditGrant) === Boolean(auditRevoke), 'Provide both offline audit permission executables to test grant and revoke.')
const moderationFixture = [moderatorGrant, moderatorRevoke, moderatorSeed, moderatorBody]
assert(moderationFixture.every(Boolean) || moderationFixture.every(value => !value),
  'Provide grant, revoke, seed and test body together for moderation acceptance.')
const taxonomyFixture = [taxonomyGrant, taxonomyRevoke, taxonomySeed]
assert(taxonomyFixture.every(Boolean) || taxonomyFixture.every(value => !value),
  'Provide grant, revoke and seed executables together for taxonomy acceptance.')
assert(Boolean(sitePagesGrant) === Boolean(sitePagesRevoke), 'Provide both offline site-page permission executables.')
assert([moderatorGrant, auditGrant, taxonomyGrant, sitePagesGrant].filter(Boolean).length <= 1,
  'Run administrator permission scenarios separately to preserve the rate budget.')
const adminOrigin = new URL(adminUrl)
const siteOrigin = new URL(siteUrl)
assert.equal(adminOrigin.hostname, 'localhost', 'The admin WebAuthn fixture uses localhost as its relying party.')
assert.equal(siteOrigin.hostname, '127.0.0.1', 'The site account fixture uses a different loopback host.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/admin-identity-browser')
await mkdir(evidence, { recursive: true })

const adminPath = '/api/v2/admin/identity'
const adminPage = adminOrigin.origin + '/admin/identity'
const {
  AdminBootstrapBegin: bootstrapBegin, AdminBootstrapComplete: bootstrapComplete, AdminPasskeyBegin: passkeyBegin,
  AdminPasskeyComplete: passkeyComplete, AdminSession: adminSession, AdminSignOut: adminLogout,
  AdminOperationsStatus: operationsStatus, AdminCommentQueue: moderationQueue,
  AdminStepUpBegin: stepUpBegin, AdminStepUpComplete: stepUpComplete,
  AdminEffectivePermissions: permissions, AdminSignInHistory: signInHistory,
  AdminModerationClaim: moderationClaim, AdminModerationRenew: moderationRenew, AdminModerationRelease: moderationRelease,
  AdminModerationDecision: moderationDecision, AdminModerationStepUpBegin: moderationStepUpBegin,
  CommentRoots: commentRoots,
  Session: siteSession, SignIn: siteSignIn, SignOut: siteSignOut,
} = WireRoutes
const secureAdmin = adminOrigin.protocol === 'https:'
const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
if (pins !== undefined) {
  assert(secureAdmin && siteOrigin.protocol === 'https:' &&
    /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins), 'TLS fixtures need two SHA-256 leaf public-key pins.')
}
const adminCookieName = secureAdmin ? '__Host-FsusAdminSession' : 'fsus-v2-admin-session'
const siteCookieName = 'fsus-v2-session'
const checks = {}
const responses = []
const faults = []
const startedAt = new Date().toISOString()
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
  args: pins ? [`--ignore-certificate-errors-spki-list=${pins}`] : [] })
let phase = 'site-session'
let failure
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  context.on('response', response => {
    const url = new URL(response.url())
    if (!url.pathname.startsWith(adminPath + '/') && !url.pathname.startsWith('/api/v2/identity/')) return
    responses.push({ host: url.hostname, path: url.pathname, status: response.status() })
    if (response.status() >= 500) faults.push({ path: url.pathname, status: response.status() })
  })
  const site = await context.newPage()
  const admin = await context.newPage()
  for (const page of [site, admin]) page.on('pageerror', () => faults.push({ kind: 'uncaught-page-error' }))
  const authenticator = await context.newCDPSession(admin)
  await authenticator.send('WebAuthn.enable')
  await authenticator.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })

  const rejectedSiteTicket = await context.request.post(adminOrigin.origin + bootstrapBegin, {
    headers: { [WireHeaders.AdminBootstrapToken]: siteTicket },
  })
  assert(rejectedSiteTicket.status() >= 400 && rejectedSiteTicket.status() < 500, 'An unspent site fixture key cannot bootstrap an administrator.')
  await site.goto(siteOrigin.origin + '/login')
  await site.getByLabel('Owner access key').fill(siteTicket)
  const siteLogin = await clickAndWait(site, siteOrigin, siteSignIn, 'Log in')
  assert.equal(siteLogin.status(), 200)
  await site.waitForURL(siteOrigin.origin + '/user/manage/article/write')
  const siteCookie = await readCookie(context, siteOrigin.origin + siteSession, siteCookieName)
  assert.equal(siteCookie.httpOnly, true)
  assert.equal(siteCookie.secure, siteOrigin.protocol === 'https:')
  const siteState = await context.request.get(siteOrigin.origin + siteSession)
  assert.equal(decodeFrame(await siteState.body()).type, FrameType.OperatorSession)
  await credentialProbe(adminOrigin.origin + adminSession, siteCookieName, siteCookie.value, 401)
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, siteCookie.value, 401)
  checks.siteSessionCannotAuthorizeAdmin = true

  phase = 'bootstrap'
  const landing = await admin.goto(adminPage)
  if (secureAdmin) {
    assert.match((await landing.securityDetails())?.protocol ?? '', /^TLS/)
    assert.equal(await admin.evaluate(() => window.isSecureContext), true)
    checks.realHttpsWebAuthnContext = true
  }
  await admin.getByRole('heading', { name: 'Administrator access', exact: true }).waitFor()
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 401)
  assert.equal((await context.request.get(adminOrigin.origin + permissions)).status(), 401)
  assert.equal((await context.request.get(siteOrigin.origin + permissions)).status(), 404)
  assert.equal((await context.request.get(adminOrigin.origin + signInHistory)).status(), 401)
  assert.equal((await context.request.get(siteOrigin.origin + signInHistory)).status(), 404)
  await credentialProbe(adminOrigin.origin + permissions, siteCookieName, siteCookie.value, 401)
  await credentialProbe(adminOrigin.origin + permissions, adminCookieName, siteCookie.value, 401)
  await credentialProbe(adminOrigin.origin + signInHistory, adminCookieName, siteCookie.value, 401)
  await admin.getByRole('button', { name: 'Set up administrator Passkey', exact: true }).click()
  await admin.getByLabel('One-time administrator bootstrap key', { exact: true }).fill(adminTicket)
  const registrationBegin = waitPost(admin, adminOrigin, bootstrapBegin)
  const registration = await clickAndWait(admin, adminOrigin, bootstrapComplete, 'Create administrator Passkey')
  assert.equal(await frameType(await registrationBegin), FrameType.PasskeyRegisterBegin)
  await assertEmpty(registration)
  await admin.getByText('Administrator Passkey created. Log in with it to continue.', { exact: true }).waitFor()
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 401)
  assert(!(await context.cookies(adminOrigin.origin + adminSession)).some(cookie => cookie.name === adminCookieName))
  await rejectReplay(context, registration)
  const reusedTicket = await context.request.post(adminOrigin.origin + bootstrapBegin, {
    headers: { [WireHeaders.AdminBootstrapToken]: adminTicket },
  })
  assert(reusedTicket.status() >= 400 && reusedTicket.status() < 500, 'Completed registration must consume the bootstrap key.')
  checks.bootstrapRequiresPasskeyAndDoesNotSignIn = true
  checks.bootstrapCompletionCannotReplay = true

  phase = 'admin-login'
  const firstLogin = await logIn(admin)
  const initial = await snapshot(context)
  assert.equal(await expectPermissions(admin, context, adminOrigin.origin, ['admin.manage']), initial.principal.generation)
  for (const heading of ['Operations status', 'Moderation queue', 'Taxonomy usage', 'Site pages',
    'Site appearance', 'Restore a published article revision']) await expectPanelHidden(admin, heading)
  await admin.getByRole('button', { name: 'Reload administrator access', exact: true }).waitFor({ state: 'detached' })
  await admin.getByRole('heading', { name: 'Support inbox', exact: true }).waitFor()
  checks.independentAdministratorStartsWithExactOwnGrant = true
  const oldCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
  assert.equal(oldCookie.httpOnly, true)
  assert.equal(oldCookie.sameSite, 'Strict')
  assert.equal(oldCookie.path, secureAdmin ? '/' : adminPath)
  assert.equal(oldCookie.secure, secureAdmin)
  assert.equal(oldCookie.domain, adminOrigin.hostname)
  assertNoCredential(initial.body, oldCookie.value)
  if (auditGrant && auditRevoke) {
    await rejectMismatchedSignInHistory(admin, adminOrigin.origin)
    checks.signInHistoryRejectsWrongSessionBinding = true
  }
  const [initialSignIn] = await expectSignInHistory({ page: admin, context, origin: adminOrigin.origin,
    generation: initial.principal.generation, currentCookie: oldCookie.value, expected: ['Current'] })
  await rejectReplay(context, firstLogin)
  assert((await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)).value === oldCookie.value,
    'A replay must leave the current admin browser credential unchanged.')
  const wrongHost = await context.request.get(siteOrigin.origin + adminSession)
  assert.equal(wrongHost.status(), 404, 'Admin endpoints are unavailable on the site host.')
  assert.equal((await context.request.get(adminOrigin.origin + siteSession)).status(), 404,
    'The dedicated admin origin does not expose site identity routes.')
  assert.equal((await context.request.get(adminOrigin.origin + '/')).status(), 404,
    'The dedicated admin origin does not serve the public home page.')
  await credentialProbe(siteOrigin.origin + siteSession, adminCookieName, oldCookie.value, 401)
  await credentialProbe(siteOrigin.origin + siteSession, siteCookieName, oldCookie.value, 401)
  const crossOriginLogout = await context.request.post(adminOrigin.origin + adminLogout, { headers: { Origin: siteOrigin.origin } })
  assert.equal(crossOriginLogout.status(), 403)
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, oldCookie.value, 200)
  checks.adminSessionCannotAuthorizeSite = true
  checks.dedicatedOriginRoutesAreIsolated = true
  checks.assertionReplayDoesNotRotateSession = true
  checks.crossOriginLogoutDenied = true

  phase = 'rotation'
  // Removing the local cookie leaves its server-side session active until fresh WebAuthn succeeds.
  await context.clearCookies({ name: adminCookieName })
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, oldCookie.value, 200)
  await admin.reload()
  await logIn(admin)
  const renewed = await snapshot(context)
  const newCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
  assert(newCookie.value !== oldCookie.value, 'Fresh administrator authentication must issue a different session credential.')
  assert.equal(renewed.principal.handle, initial.principal.handle)
  assert(renewed.principal.generation >= initial.principal.generation)
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, oldCookie.value, 401)
  await credentialProbe(adminOrigin.origin + signInHistory, adminCookieName, oldCookie.value, 401)
  assertNoCredential(renewed.body, newCookie.value)
  const [, retiredSignIn] = await expectSignInHistory({ page: admin, context, origin: adminOrigin.origin,
    generation: renewed.principal.generation, currentCookie: newCookie.value, expected: ['Current', 'Ended'] })
  assert.equal(retiredSignIn.startedAt, initialSignIn.startedAt)
  await admin.screenshot({ path: join(evidence, 'administrator-session.png') })
  checks.freshPasskeyRotatesPriorAdminSession = true
  checks.recentSignInsAreBoundToOwnCurrentSession = true

  let finalCookie = newCookie
  if (revokeExecutable) {
    phase = 'offline-revocation'
    await context.clearCookies({ name: adminCookieName })
    await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, newCookie.value, 200)
    await admin.reload()
    await revokeDuringLogin(admin, revokeExecutable)
    assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 401)
    await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, newCookie.value, 401)
    await credentialProbe(adminOrigin.origin + signInHistory, adminCookieName, newCookie.value, 401)

    await logIn(admin)
    const fresh = await snapshot(context)
    finalCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
    assert.equal(fresh.principal.handle, renewed.principal.handle)
    assert(fresh.principal.generation > renewed.principal.generation, 'A new challenge must see the advanced generation.')
    assert(finalCookie.value !== newCookie.value, 'A new challenge must establish a different session credential.')
    await expectSignInHistory({ page: admin, context, origin: adminOrigin.origin,
      generation: fresh.principal.generation, currentCookie: finalCookie.value, expected: ['Current', 'Ended', 'Ended'] })
    checks.offlineRevocationInvalidatesPendingChallenge = true
    checks.offlineRevocationRetiresOwnSignIn = true
  }

  if (auditGrant && auditRevoke) {
    phase = 'operations-permission'
    await verifyMismatchedPermissionSession(admin, context, adminOrigin.origin)
    checks.adminPermissionProjectionRejectsWrongSessionBinding = true
    finalCookie = await verifyOperationsPermissions(admin, context, siteCookie, finalCookie, auditGrant, auditRevoke)
    checks.operationsRequireIndependentAuditGrant = true
    checks.operationsGrantAndRevokeInvalidateOldSessions = true
    checks.currentPermissionsDriveVisiblePanelsAndTrackRevocation = true
  }

  if (moderatorGrant) {
    phase = 'moderation-permission'
    finalCookie = await verifyModerationPermissions(admin, context, siteCookie, finalCookie)
    checks.moderationRequiresIndependentGrant = true
    checks.moderationBodyIsTextAndPendingIsPrivate = true
    checks.moderationGrantAndRevokeInvalidateOldSessions = true
    checks.adminSensitivePasskeyProofIsScopedAndOneUse = true
    checks.onlineModerationClaimGenerationsAndVisibility = true
    checks.onlineModerationDecisionProofCannotReplay = true
  }

  if (taxonomyGrant) {
    phase = 'taxonomy-permission'
    finalCookie = await verifyTaxonomy({ page: admin, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
      priorCookie: finalCookie, grant: taxonomyGrant, revoke: taxonomyRevoke, seed: taxonomySeed, logIn,
      probe: credentialProbe, snapshot, readCookie, evidence })
    checks.taxonomyRequiresIndependentGrant = true
    checks.taxonomyCountersAndCursorUseStoredRevisions = true
    checks.taxonomyGrantAndRevokeInvalidateOldSessions = true
  }

  if (process.env.FSUSBLOG_TEST_ADMIN_APPEARANCE === '1') {
    phase = 'appearance-activation'
    finalCookie = await verifyAppearanceActivation({ page: admin, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
      priorCookie: finalCookie, grant: process.env.FSUSBLOG_TEST_APPEARANCE_GRANT, revoke: process.env.FSUSBLOG_TEST_APPEARANCE_REVOKE,
      logIn, probe: credentialProbe, readCookie, evidence })
    checks.signedAppearanceActivationAndRollbackEvictSupersededAssets = true
  }

  if (sitePagesGrant) {
    phase = 'site-page-permission'
    finalCookie = await verifyAdminSitePages({ page: admin, context, adminOrigin, siteOrigin, adminCookieName, siteCookie,
      priorCookie: finalCookie, grant: sitePagesGrant, revoke: sitePagesRevoke, logIn, probe: credentialProbe, readCookie, evidence })
    checks.pageReadsRequireIndependentSystemConfig = true
    checks.pageReadsMatchPublicAedsAndExcludeSiteHostAndWrites = true
    if (process.env.FSUSBLOG_TEST_ADMIN_SITE_PAGE_EDITOR === '1')
      checks.pagePublishUsesPasskeyPowAndVersionedPublicRepresentations = true
  }

  if (process.env.FSUSBLOG_TEST_ADMIN_INBOX === '1') {
    phase = 'support-inbox'
    await verifyAdminInbox(admin, context, adminOrigin.origin, siteOrigin.origin, siteCookie, adminCookieName, credentialProbe, evidence)
    checks.adminInboxOnlyShowsPrivateThreadsToCurrentAdmin = true
  }

  if (process.env.FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK === '1') {
    phase = 'article-rollback'
    await verifyAdminArticleRollback({ page: admin, context, adminOrigin, siteOrigin,
      grant: process.env.FSUSBLOG_TEST_ADMIN_ARTICLE_ROLLBACK_GRANT, logIn, evidence })
    finalCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
    checks.articleRollbackUsesIndependentAdminAndStableReceipt = true
  }

  phase = 'logout'
  // Seed the site credential into the admin host only in this test to detect a shared cookie-clearing helper.
  await context.addCookies([{ ...siteCookie, domain: adminOrigin.hostname }])
  await assertEmpty(await clickAndWait(admin, adminOrigin, adminLogout, 'Log out of administrator session'))
  await admin.getByRole('button', { name: 'Log in as administrator', exact: true }).waitFor()
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 401)
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, finalCookie.value, 401)
  assert.equal((await context.request.get(adminOrigin.origin + permissions)).status(), 401)
  await credentialProbe(adminOrigin.origin + permissions, adminCookieName, finalCookie.value, 401)
  await credentialProbe(adminOrigin.origin + signInHistory, adminCookieName, finalCookie.value, 401)
  const stillSignedIn = await context.request.get(siteOrigin.origin + siteSession)
  assert.equal(stillSignedIn.status(), 200)
  assert((await readCookie(context, siteOrigin.origin + siteSession, siteCookieName)).value === siteCookie.value,
    'Administrator logout must preserve the existing site cookie.')
  assert((await readCookie(context, adminOrigin.origin + siteSession, siteCookieName)).value === siteCookie.value,
    'Administrator logout must also leave the site cookie name alone on its own host.')
  await assertEmpty(await context.request.post(siteOrigin.origin + siteSignOut))
  await admin.screenshot({ path: join(evidence, 'administrator-logged-out.png') })
  checks.adminLogoutPreservesSiteSession = true
  assert.deepEqual(faults, [])
  phase = 'passed'
} catch (error) {
  failure = error
} finally {
  const chromiumVersion = browser.version()
  await browser.close()
  await writeFile(join(evidence, 'admin-identity-result.json'), JSON.stringify({
    adminOrigin: adminOrigin.origin, siteOrigin: siteOrigin.origin, startedAt, endedAt: new Date().toISOString(),
    chromium: chromiumVersion, phase, checks, responses, faults, exitCode: failure ? 1 : 0,
  }, null, 2))
}
if (failure) throw failure

async function logIn(page) {
  const beginning = waitPost(page, adminOrigin, passkeyBegin)
  const completed = await clickAndWait(page, adminOrigin, passkeyComplete, 'Log in as administrator')
  assert.equal(await frameType(await beginning), FrameType.PasskeyLoginBegin)
  await assertEmpty(completed)
  await page.getByRole('heading', { name: 'Administrator session', exact: true }).waitFor()
  return completed
}

async function revokeDuringLogin(page, executable) {
  const completedUrl = adminOrigin.origin + passkeyComplete
  const beginning = waitPost(page, adminOrigin, passkeyBegin)
  const offlineRevocation = Promise.withResolvers()
  await page.route(completedUrl, async route => {
    try {
      assert.equal(await frameType(await beginning), FrameType.PasskeyLoginBegin)
      await promisify(execFile)(executable, [], { timeout: 8_000 })
      await route.continue()
      offlineRevocation.resolve()
    } catch {
      await route.abort().catch(() => {})
      offlineRevocation.reject(new Error('The isolated offline revocation fixture did not complete.'))
    }
  }, { times: 1 })
  const [response] = await Promise.all([
    clickAndWait(page, adminOrigin, passkeyComplete, 'Log in as administrator'),
    offlineRevocation.promise,
  ])
  assert.equal(response.status(), 401, 'An assertion begun before the offline revocation must not establish a session.')
  await page.getByRole('alert').filter({ hasText: 'Could not log in with this administrator Passkey. Try again.' }).waitFor()
}

function waitPost(page, origin, path) {
  return page.waitForResponse(response => response.url() === origin.origin + path && response.request().method() === 'POST',
    { timeout: 12_000 })
}

async function verifyOperationsPermissions(page, context, siteCookie, priorCookie, grant, revoke) {
  const endpoint = adminOrigin.origin + operationsStatus
  const statusButton = page.getByRole('button', { name: 'Check operations status', exact: true })
  const checkStatus = async () => (await Promise.all([
    page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'GET'),
    statusButton.click(),
  ]))[0]
  const revokedMessage = 'Your administrator session expired or was revoked. Log in again.'
  const alert = text => page.getByRole('alert').filter({ hasText: text })
  const displayedSnapshot = page.getByText('Public snapshot', { exact: true })
  const generation = (await snapshot(context)).principal.generation

  assert.equal((await context.request.get(siteOrigin.origin + operationsStatus)).status(), 404)
  await credentialProbe(endpoint, siteCookieName, siteCookie.value, 401)
  await credentialProbe(endpoint, adminCookieName, siteCookie.value, 401)
  assert.equal((await context.request.get(endpoint)).status(), 403, 'An administrator login alone must not grant operations status.')
  await expectPanelHidden(page, 'Operations status')
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 200)

  await promisify(execFile)(grant, [], { timeout: 8_000 })
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, priorCookie.value, 401)
  await credentialProbe(adminOrigin.origin + permissions, adminCookieName, priorCookie.value, 401)
  await credentialProbe(endpoint, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await displayedSnapshot.waitFor({ state: 'hidden' })
  await logIn(page)
  const granted = await snapshot(context)
  assert(granted.principal.generation > generation)
  assert.equal(await expectPermissions(page, context, adminOrigin.origin, ['admin.manage', 'audit.read']), granted.principal.generation)
  await expectPanelHidden(page, 'Moderation queue')
  const grantedCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
  assert(grantedCookie.value !== priorCookie.value)
  const status = await checkStatus()
  assert.equal(status.status(), 200)
  assert((await status.headerValue('Cache-Control'))?.includes('no-store'))
  const body = await status.body()
  assertNoCredential(body, grantedCookie.value)
  const observed = decodeAdminOperationsStatus(decodeFrame(body, FrameType.AdminOperationsStatus).payload)
  assert.equal(observed.snapshotReady, true, 'This running fixture must report its published snapshot.')
  assert(observed.publicationWatermark >= 0n && observed.pendingPublicationEvents >= 0n)
  assert(observed.pendingPublicationEvents === 0n ? observed.oldestPendingAt === 0n : observed.oldestPendingAt > 0n)
  await page.getByRole('heading', { name: 'Operations status', exact: true }).waitFor()
  for (const name of ['Public snapshot', 'Publication watermark', 'Pending publication events'])
    await page.getByText(name, { exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'administrator-operations-status.png') })

  await promisify(execFile)(revoke, [], { timeout: 8_000 })
  await credentialProbe(adminOrigin.origin + adminSession, adminCookieName, grantedCookie.value, 401)
  await credentialProbe(adminOrigin.origin + permissions, adminCookieName, grantedCookie.value, 401)
  await credentialProbe(endpoint, adminCookieName, grantedCookie.value, 401)
  assert.equal((await checkStatus()).status(), 401)
  await alert(revokedMessage).waitFor()
  await displayedSnapshot.waitFor({ state: 'hidden' })
  await logIn(page)
  const revoked = await snapshot(context)
  assert(revoked.principal.generation > granted.principal.generation)
  assert.equal(await expectPermissions(page, context, adminOrigin.origin, ['admin.manage']), revoked.principal.generation)
  assert.equal((await context.request.get(endpoint)).status(), 403, 'Revoking audit permission must retain login only.')
  await expectPanelHidden(page, 'Operations status')
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 200)
  return readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
}

async function verifyModerationPermissions(page, context, siteCookie, priorCookie) {
  const run = promisify(execFile)
  const { stdout } = await run(moderatorSeed, [], { timeout: 20_000 })
  assert(/^[1-9][0-9]*$/.test(stdout.trim()), 'The moderation fixture must output one published article ID.')
  const articleId = Number(stdout.trim())
  assert(Number.isSafeInteger(articleId) && articleId <= 2_147_483_647)
  const publicRoute = siteOrigin.origin + commentRoots.replace('{articleId:int}', String(articleId))
  const anonymous = await request.newContext()
  try {
    const publicArticle = await anonymous.get(siteOrigin.origin + '/article/' + articleId)
    assert.equal(publicArticle.status(), 200, 'The pending comment requires a genuinely published article.')
    const publicComments = await anonymous.get(publicRoute)
    assert.equal(publicComments.status(), 200)
    const publicFrame = decodeFrame(await publicComments.body(), FrameType.CommentTreeRootCursor)
    assert(!Buffer.from(publicFrame.payload).includes(moderatorBody), 'A pending comment must stay hidden publicly.')
  } finally { await anonymous.dispose() }

  const endpoint = adminOrigin.origin + moderationQueue
  const section = page.getByRole('region', { name: 'Moderation queue', exact: true })
  const load = section.getByRole('button', { name: 'Load moderation queue', exact: true })
  const checkQueue = async () => (await Promise.all([
    page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'GET'),
    load.click(),
  ]))[0]
  const revoked = page.getByRole('alert').filter({ hasText: 'Your administrator session expired or was revoked. Log in again.' })
  const bodyText = section.getByText(moderatorBody, { exact: true })
  const generation = (await snapshot(context)).principal.generation
  assert.equal((await context.request.get(siteOrigin.origin + moderationQueue)).status(), 404)
  await credentialProbe(endpoint, siteCookieName, siteCookie.value, 401)
  await credentialProbe(endpoint, adminCookieName, siteCookie.value, 401)
  assert.equal((await context.request.get(endpoint)).status(), 403, 'Administrator access alone must not grant moderation read.')
  await expectPanelHidden(page, 'Moderation queue')
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 200)
  assert.equal((await postModerationIntent(context.request, moderationIntent(articleId, 1n))).status(), 403)

  await run(moderatorGrant, [], { timeout: 8_000 })
  await credentialProbe(endpoint, adminCookieName, priorCookie.value, 401)
  await page.reload()
  await logIn(page)
  const granted = await snapshot(context)
  assert(granted.principal.generation > generation)
  const grantedCookie = await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
  assert(grantedCookie.value !== priorCookie.value)
  const queue = await checkQueue()
  assert.equal(queue.status(), 200)
  assert((await queue.headerValue('Cache-Control'))?.includes('no-store'))
  const payload = await queue.body()
  assertNoCredential(payload, grantedCookie.value)
  const row = readModerationFixture(payload, articleId)
  await bodyText.waitFor()
  const displayedComment = section.getByRole('article').filter({ has: page.getByText(moderatorBody, { exact: true }) })
  await displayedComment.getByText(`Article ${articleId} · Comment ${row.commentId}`).waitFor()
  assert.equal(await displayedComment.locator('time').getAttribute('datetime'), new Date(Number(row.createdAt)).toISOString())
  assert.equal(await section.locator('[data-moderation-fixture]').count(), 0, 'Pending markup must render as plain text.')
  await page.screenshot({ path: join(evidence, 'administrator-moderation-queue.png') })
  const intent = await verifyAdminModerationProof(page, context, siteCookie, priorCookie, grantedCookie, articleId, row, checkQueue)
  await verifyOnlineModeration(page, context, section, publicRoute, row, checkQueue)
  if (process.env.FSUSBLOG_TEST_COMMENT_REPLY === '1') {
    const { verifyApprovedReply } = await import('./comment-reply-flow.mjs')
    await verifyApprovedReply({ browser: context.browser(), siteOrigin: siteOrigin.origin, evidence, articleId, parentId: row.commentId,
      approve: async (body, commentId) => {
        await page.bringToFront()
        assert.equal((await checkQueue()).status(), 200)
        const card = section.getByRole('article').filter({ has: page.getByText(body, { exact: true }) })
        const claim = await readClaim(await clickModeration(page, card, moderationClaim, 'Claim comment for review'))
        assert.equal(claim.commentId, commentId)
        await applyModerationDecision(page, context, card, claim, 1, 'Approve with Passkey', 'Comment approved.')
      } })
  }
  if (process.env.FSUSBLOG_TEST_COMMENT_APPEAL === '1') {
    const { verifyCommentAppeal } = await import('./comment-appeal-flow.mjs')
    await verifyCommentAppeal({ page, context, siteOrigin: siteOrigin.origin, adminOrigin: adminOrigin.origin,
      publicRoute, rejectBody: moderatorBody + ' [reject fixture]', evidence, logIn })
  }

  await run(moderatorRevoke, [], { timeout: 8_000 })
  await credentialProbe(endpoint, adminCookieName, grantedCookie.value, 401)
  assert.equal((await checkQueue()).status(), 401)
  await revoked.waitFor()
  await bodyText.waitFor({ state: 'hidden' })
  await logIn(page)
  assert((await snapshot(context)).principal.generation > granted.principal.generation)
  assert.equal((await postModerationIntent(context.request, intent)).status(), 403)
  assert.equal((await context.request.get(endpoint)).status(), 403, 'Removing moderation authority must preserve only login.')
  await expectPanelHidden(page, 'Moderation queue')
  assert.equal((await context.request.get(adminOrigin.origin + adminSession)).status(), 200)
  return readCookie(context, adminOrigin.origin + adminSession, adminCookieName)
}

async function verifyOnlineModeration(page, context, section, publicRoute, expectedComment, checkQueue) {
  const card = body => section.getByRole('article').filter({ has: page.getByText(body, { exact: true }) })
  const approveCard = card(moderatorBody)
  const rejectBody = moderatorBody + ' [reject fixture]'
  const rejectCard = card(rejectBody)
  const claimButton = 'Claim comment for review'
  const firstResponse = await clickModeration(page, approveCard, moderationClaim, claimButton)
  const first = await readClaim(firstResponse)
  assert.equal(first.commentId, expectedComment.commentId)
  await approveCard.getByText('Claimed for review', { exact: true }).waitFor()
  await expectRepeatedPost(context, firstResponse, 409)

  const renewal = await clickModeration(page, approveCard, moderationRenew, 'Renew claim')
  const renewed = await readClaim(renewal)
  assert.equal(renewed.commentId, first.commentId)
  assert.equal(renewed.commentVersion, first.commentVersion)
  assert.equal(renewed.claimGeneration, first.claimGeneration)
  assert(renewed.claimVersion > first.claimVersion && renewed.expiresAt > first.expiresAt)
  await expectRepeatedPost(context, renewal, 409)

  const release = await clickModeration(page, approveCard, moderationRelease, 'Release claim')
  await assertEmpty(release)
  await expectRepeatedPost(context, release, 409)
  const reclaimed = await readClaim(await clickModeration(page, approveCard, moderationClaim, claimButton))
  assert.equal(reclaimed.commentId, first.commentId)
  assert(reclaimed.claimGeneration > renewed.claimGeneration)
  assert(reclaimed.claimToken !== renewed.claimToken, 'Reacquisition must replace the original claim credential.')
  await expectRepeatedPost(context, renewal, 409)
  await page.screenshot({ path: join(evidence, 'administrator-moderation-claimed.png') })

  await applyModerationDecision(page, context, approveCard, reclaimed, 1, 'Approve with Passkey', 'Comment approved.')
  await approveCard.waitFor({ state: 'hidden' })
  assert.equal((await checkQueue()).status(), 200)
  await rejectCard.getByRole('button', { name: claimButton, exact: true }).waitFor()
  const rejected = await readClaim(await clickModeration(page, rejectCard, moderationClaim, claimButton))
  await applyModerationDecision(page, context, rejectCard, rejected, 2, 'Reject with Passkey', 'Comment rejected.')
  await rejectCard.waitFor({ state: 'hidden' })
  assert.equal((await checkQueue()).status(), 200)
  await section.getByText('No comments are waiting for moderation.', { exact: true }).waitFor()

  const anonymous = await request.newContext()
  try {
    const publicComments = await anonymous.get(publicRoute)
    assert.equal(publicComments.status(), 200)
    const comments = decodeCommentRoots(decodeFrame(await publicComments.body(), FrameType.CommentTreeRootCursor).payload)
    assert(comments.items.some(row => row.node.id === first.commentId.toString() && row.node.content === moderatorBody),
      'The online approval must make the original comment visible publicly.')
    assert(!comments.items.some(row => row.node.content === rejectBody), 'The online rejection must keep its comment private.')
  } finally { await anonymous.dispose() }
  await page.screenshot({ path: join(evidence, 'administrator-moderation-complete.png') })
}

async function applyModerationDecision(page, context, card, claim, targetState, label, notice) {
  await card.getByLabel('Reason for moderation decision', { exact: true }).fill('Moderation integration fixture')
  const [begin, complete, applied] = await Promise.all([
    waitPost(page, adminOrigin, moderationStepUpBegin),
    waitPost(page, adminOrigin, stepUpComplete),
    clickModeration(page, card, moderationDecision, label),
  ])
  assert.equal(await frameType(begin), FrameType.PasskeyLoginBegin)
  assert.equal(await frameType(complete), FrameType.MfaChallengeResult)
  const decisionRequest = applied.request()
  const proof = await decisionRequest.headerValue(WireHeaders.MfaProof)
  assert(/^[A-Za-z0-9_-]{43}$/.test(proof ?? ''), 'The online decision must carry the fresh Passkey proof.')
  const assertionProof = readMfaProof(decodeFrame(await complete.body(), FrameType.MfaChallengeResult).payload, 'admin-sensitive', true)
  assert(proof === assertionProof, 'The decision must use the proof from that same real assertion.')
  assert(Buffer.from(begin.request().postDataBuffer()).equals(decisionRequest.postDataBuffer()),
    'The UI must submit the exact intent that was confirmed by Passkey.')
  const decision = decodeAdminModerationDecision(decodeFrame(decisionRequest.postDataBuffer(), FrameType.AdminModerationDecision).payload)
  assert(decision.articleId === claim.articleId && decision.commentId === claim.commentId &&
    decision.commentVersion === claim.commentVersion && decision.claimToken === claim.claimToken &&
    decision.claimGeneration === claim.claimGeneration && decision.claimVersion === claim.claimVersion &&
    decision.expectedStatus === 0 && decision.decision === targetState,
  'The authorized decision must bind the claimed comment and both versions.')
  await assertEmpty(applied)
  await page.getByText(notice, { exact: true }).waitFor()
  await expectRepeatedPost(context, applied, 428, proof)
  await expectRepeatedPost(context, applied, 428)
}

async function clickModeration(page, card, path, name) {
  const [response] = await Promise.all([
    waitPost(page, adminOrigin, path),
    card.getByRole('button', { name, exact: true }).click(),
  ])
  return response
}

async function readClaim(response) {
  assert.equal(response.status(), 200)
  const claim = decodeAdminModerationClaim(decodeFrame(await response.body(), FrameType.AdminModerationClaim).payload)
  assert(claim.articleId > 0 && claim.commentId > 0n && claim.commentVersion > 0n && claim.claimGeneration > 0n && claim.claimVersion > 0n)
  assert(claim.expiresAt > BigInt(Date.now()) && /^[A-Za-z0-9_-]{43}$/.test(claim.claimToken))
  return claim
}

async function expectRepeatedPost(context, original, status, proof) {
  const response = await context.request.post(original.url(), {
    headers: { 'Content-Type': 'application/octet-stream', Origin: adminOrigin.origin,
      ...(proof ? { [WireHeaders.MfaProof]: proof } : {}) },
    data: original.request().postDataBuffer(),
  })
  assert.equal(response.status(), status)
  if (status === 428) {
    const error = decodeFrame(await response.body(), FrameType.ApiError)
    assert(Buffer.from(error.payload).includes('MFA_PROOF_REQUIRED'), 'Invalid or missing proof must return MFA_PROOF_REQUIRED.')
  }
}

async function verifyAdminModerationProof(page, context, siteCookie, priorCookie, grantedCookie, articleId, row, checkQueue) {
  const intent = moderationIntent(articleId, row.commentId)
  const unauthenticated = await request.newContext()
  try {
    assert.equal((await postModerationIntent(unauthenticated, intent, siteCookie.value)).status(), 401)
    assert.equal((await postModerationIntent(unauthenticated, intent, priorCookie.value)).status(), 401)
  } finally { await unauthenticated.dispose() }
  const wrongTarget = { ...intent, commentId: BigInt('9223372036854775807') }
  assert.equal((await postModerationIntent(context.request, wrongTarget)).status(), 404,
    'A proof challenge needs a real pending moderation target.')

  // Load the production TypeScript codecs into this browser. Only fixture module requests are intercepted.
  const modulePath = '/assets/test-admin-step-up/'
  await page.route(adminOrigin.origin + modulePath + '*.ts', async route => {
    const name = new URL(route.request().url()).pathname.slice(modulePath.length)
    if (!/^[a-z][a-z0-9.-]+\.ts$/.test(name)) return route.abort()
    const source = await readFile(new URL('../../src/Contracts/' + name, import.meta.url), 'utf8')
    await route.fulfill({ contentType: 'application/javascript', body: stripTypeScriptTypes(source) })
  })
  const [begin, complete, issued] = await Promise.all([
    waitPost(page, adminOrigin, stepUpBegin),
    waitPost(page, adminOrigin, stepUpComplete),
    page.evaluate(async ({ modulePath, articleId, commentId, expectedStatus, decision, reason }) => {
      const { proveAdminModeration } = await import(modulePath + 'admin-step-up.ts')
      const proof = await proveAdminModeration({ articleId, commentId: BigInt(commentId), expectedStatus, decision, reason })
      return /^[A-Za-z0-9_-]{43}$/.test(proof)
    }, { ...intent, commentId: intent.commentId.toString(), modulePath }),
  ])
  assert.equal(issued, true, 'The production browser codec must accept a signed administrator proof.')
  assert.equal(await frameType(begin), FrameType.PasskeyLoginBegin)
  assert.deepEqual(decodeAdminModerationIntent(decodeFrame(begin.request().postDataBuffer(), FrameType.AdminModerationIntent).payload), intent)
  assert.equal(complete.status(), 200)
  assert((await complete.headerValue('Cache-Control'))?.includes('no-store'))
  const result = decodeFrame(await complete.body(), FrameType.MfaChallengeResult)
  assert(/^[A-Za-z0-9_-]{43}$/.test(readMfaProof(result.payload, 'admin-sensitive', true)))
  assert((await readCookie(context, adminOrigin.origin + adminSession, adminCookieName)).value === grantedCookie.value,
    'Administrator step-up must leave the current login credential unchanged.')

  const requestBody = complete.request().postDataBuffer()
  decodeFrame(requestBody, FrameType.PasskeyLoginCompleteRequest)
  const cookies = await complete.request().headerValue('Cookie')
  const replay = await context.request.post(adminOrigin.origin + stepUpComplete, {
    headers: { 'Content-Type': 'application/octet-stream', ...(cookies ? { Cookie: cookies } : {}) }, data: requestBody,
  })
  assert.equal(replay.status(), 401, 'A completed administrator assertion must be one-use.')
  const queueAfterProof = await checkQueue()
  assert.equal(queueAfterProof.status(), 200)
  assert.equal(readModerationFixture(await queueAfterProof.body(), articleId).commentId, intent.commentId,
    'Issuing a proof must leave the comment pending until a separate authorized transaction.')
  return intent
}

function moderationIntent(articleId, commentId) {
  return { articleId, commentId, expectedStatus: 0, decision: 1, reason: 'Administrator proof fixture' }
}

function postModerationIntent(client, intent, session) {
  return client.post(adminOrigin.origin + stepUpBegin, {
    headers: { 'Content-Type': 'application/octet-stream', ...(session ? { Cookie: adminCookieName + '=' + session } : {}) },
    data: Buffer.from(encodeFrame(FrameType.AdminModerationIntent, encodeAdminModerationIntent(intent))),
  })
}

function readModerationFixture(frame, articleId) {
  const reader = new PodReader(decodeFrame(frame, FrameType.AdminCommentQueue).payload)
  reader.bool()
  const count = reader.i32()
  assert(count > 0 && count <= WireLimits.AdminCommentQueueSize, 'The moderation fixture requires a bounded, nonempty queue.')
  let fixture = null
  for (let index = 0; index < count; index++) {
    const currentArticle = reader.i32()
    const commentId = reader.i64()
    const createdAt = reader.i64()
    const displayName = reader.text(WireLimits.PublicCommentHandleBytes)
    const body = reader.text(WireLimits.AdminCommentQueueBodyBytes)
    assert(currentArticle > 0 && commentId > 0n && createdAt > 0n && displayName.length > 0)
    if (currentArticle === articleId && body === moderatorBody) fixture = { commentId, createdAt }
  }
  reader.finish()
  assert(fixture, 'The real moderation queue must contain the seeded pending comment.')
  return fixture
}

async function clickAndWait(page, origin, path, label) {
  const [response] = await Promise.all([
    waitPost(page, origin, path),
    page.getByRole('button', { name: label, exact: true }).click(),
  ])
  return response
}

async function frameType(response) {
  assert.equal(response.status(), 200)
  return decodeFrame(await response.body()).type
}

async function assertEmpty(response) {
  assert.equal(response.status(), 200)
  decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
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

async function credentialProbe(url, name, value, expectedStatus) {
  const probe = await request.newContext()
  try {
    const response = await probe.get(url, { headers: { Cookie: name + '=' + value }, maxRedirects: 0 })
    assert.equal(response.status(), expectedStatus, 'The explicitly selected credential must have its own scoped authority.')
  } finally { await probe.dispose() }
}

async function readCookie(context, url, name) {
  const cookie = (await context.cookies(url)).find(item => item.name === name)
  assert(cookie, 'Expected authenticated browser credential is missing.')
  return cookie
}

async function snapshot(context) {
  const response = await context.request.get(adminOrigin.origin + adminSession)
  assert.equal(response.status(), 200)
  assert(response.headers()['cache-control']?.includes('no-store'))
  const body = await response.body()
  const principal = decodeAdminSessionSnapshot(decodeFrame(body, FrameType.AdminSessionSnapshot).payload)
  assert(principal.handle.length > 0 && principal.generation > 0n && principal.expiresAt > BigInt(Date.now()),
    'A real administrator session must have an active principal, generation, and expiration.')
  return { principal, body }
}

function assertNoCredential(frame, token) {
  const value = Buffer.from(token, 'hex')
  const digest = createHash('sha256').update(value).digest()
  assert(value.length === 32 && !frame.includes(value) && !frame.includes(token) && !frame.includes(digest) &&
    !frame.includes(digest.toString('hex')), 'The session frame must omit all raw credentials and their stored digests.')
  value.fill(0)
}
