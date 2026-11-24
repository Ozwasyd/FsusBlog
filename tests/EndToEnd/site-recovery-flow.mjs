import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import * as wire from '../../src/Contracts/wire.generated.ts'
import * as adminFx from './admin-workspace-fixture.mjs'
import { assertNoStore, assertStatus, readFrame } from './response-status-fixture.mjs'
import { exactHeading, exactLabel, exactText } from './role-locators.mjs'
import * as auth from './site-authentication-fixture.mjs'

const { FrameType, WireHeaders, WireLayouts, WireRoutes: R } = wire
const { button } = auth
const peerTicket = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PEER_TICKET
const probeReservation = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PROBE
const removeCurrent = process.env.FSUSBLOG_TEST_SITE_RECOVERY_REMOVE_CURRENT === '1'
const { origin, ownerTicket, pins } = auth.readTlsIdentityFixture(peerTicket, probeReservation,
  'Provide a scratch HTTPS localhost site, two separate fixture accounts, the reservation probe and the local leaf certificate pins.')
const { isApi, waitApi, clickApi } = auth.siteApi(origin, (page, predicate) => page.waitForResponse(predicate))
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-recovery-browser')

const browser = await auth.launchIdentityBrowser(pins)
const state = { origin, phase: 'bootstrap', checks: {}, responses: [], faults: [], secrets: [ownerTicket, peerTicket] }
const { checks, responses, faults, secrets } = state
const siteCookieName = 'fsus-v2-session', rebindCookieName = 'fsus-v2-site-recovery'
const recoveryFailed = 'Could not recover this account. Check your Recovery Key and try again.'
const emptySuccess = reply => auth.assertEmptySuccess(reply, 'Recovery response may be stored.')

await auth.withRedactedEvidence(browser, evidence, 'site-recovery-result.json', state, async () => {
  const open = role => auth.openSiteBrowser(browser, origin, role, responses, faults, { timeout: 18_000, locale: 'en-US' })
  const owner = await open('owner'), replacement = await open('replacement'), peer = await open('peer')
  await peer.page.goto(origin + '/login')
  await auth.enrollFirstPasskey(peer.page, peerTicket, clickApi)
  await authLogin(await passkey(peer.page), 1)
  await signedIn(peer.page)
  const peerState = await session(peer.context, 200), peerCookie = await siteCookie(peer.context)

  const initialPage = await owner.page.goto(origin + '/login')
  checks.tlsWebAuthn = await auth.secureLoginProtocol(owner.page, initialPage, 'Recovery acceptance must use a real TLS browser context.')
  await auth.enrollFirstPasskey(owner.page, ownerTicket, clickApi)
  const originalIdentity = await authLogin(await passkey(owner.page), 1)
  await signedIn(owner.page)
  const originalState = await session(owner.context, 200)
  assert(originalState.name !== peerState.name, 'The peer must be a separate authenticated account.')

  state.phase = 'configure-mfa'
  await owner.page.goto(origin + '/user/identity/mfa')
  const { secret, setupStep } = await auth.setupSiteTotp(owner.page, clickApi, secrets, 'The authenticator seed was unavailable.')
  const cookieBeforeRebind = await siteCookie(owner.context), mfaState = await session(owner.context, 200)

  state.phase = 'require-step-up'
  const unproved = await adminFx.postBinary(owner.context.request, origin + R.RecoveryKeyIssue, origin,
    adminFx.packFrame(FrameType.RecoveryKeyOperation, wire.encodeRecoveryKeyOperation({ operation: 1 })))
  assertStatus(unproved, 428)
  await button(owner.page, 'Create Recovery Key').waitFor()
  await setVerified(owner, false)
  const rejectedUv = owner.page.waitForResponse(response =>
    isApi(response, R.RecoveryKeyStepUpComplete, 'POST'), { timeout: 1400 }).then(response => response.status(), error => {
    if (error.name !== 'TimeoutError') throw error
    return 'no browser submission'
  })
  assertStatus(await clickApi(owner.page, R.RecoveryKeyStepUpBegin, 'Create Recovery Key'), 200)
  const browserBlocked = await rejectedUv
  assert(await owner.page.getByTestId('site-recovery-key').count() === 0 && [401, 403, 'no browser submission'].includes(browserBlocked),
    'An unverified authenticator completed step-up.')
  await owner.page.reload()
  await setVerified(owner, true)
  checks.issueWithoutProof = unproved.status()
  checks.unverifiedAuthenticator = browserBlocked

  state.phase = 'issue-and-rotate'
  const first = await issue(owner.page, 'Create Recovery Key')
  const second = await issue(owner.page, 'Replace Recovery Key')
  assert(first !== second, 'Rotation returned the previous Recovery Key.')
  checks.creationAndRotationUsedWebAuthnUv = true
  checks.keyHiddenAfterReceipt = true
  const preRecoveryState = await session(owner.context, 200)
  assert(preRecoveryState.name === mfaState.name && preRecoveryState.generation === mfaState.generation,
    'Creating or rotating a key unexpectedly replaced the current identity.')

  state.phase = 'retired-key'
  await openRecovery(replacement.page, first)
  const retired = await verifyRecovery(replacement.page)
  assertStatus(retired, 401)
  checks.rotatedKeyRejected = retired.status()
  await exactText(replacement.page, recoveryFailed).waitFor()
  await session(owner.context, 200)

  if (removeCurrent) {
    state.phase = 'remove-final-passkey'
    const { page, context } = owner
    const handle = await auth.readSessionHandle(context, origin)
    const headers = { [WireHeaders.CurrentSession]: handle }
    const list = await readFrame(await context.request.get(origin + R.SitePasskeys, { headers }), FrameType.SitePasskeys)
    assert.equal(new DataView(list.buffer, list.byteOffset, list.byteLength).getInt32(0, true), 1)
    assertStatus(await context.request.post(origin + R.SitePasskeyRemoveCurrentBegin, { headers: { ...headers, Origin: origin } }), 401)
    await session(context, 200)
    checks.removalWithoutRecoveryDenied = true

    await button(page, 'Remove current Passkey').click()
    const keyField = exactLabel(page, 'Recovery Key to confirm removal')
    await keyField.fill(first)
    const [invalid, invalidProof] = await Promise.all([clickApi(page, R.RecoveryKeyVerify, 'Remove with Passkey'), waitApi(page, R.RecoveryKeyPow)])
    await assertRecoveryProof(invalid, invalidProof)
    assertStatus(invalid, 401)
    await session(context, 200)
    checks.removalWithRotatedKeyDenied = true

    if (!await keyField.isVisible()) await button(page, 'Remove current Passkey').click()
    await keyField.fill(second)
    const [keyReply, powReply, began, complete] = await Promise.all([
      waitApi(page, R.RecoveryKeyVerify), waitApi(page, R.RecoveryKeyPow),
      waitApi(page, R.SitePasskeyRemoveCurrentBegin), waitApi(page, R.SitePasskeyRemoveCurrentComplete),
      button(page, 'Remove with Passkey').click(),
    ])
    await emptySuccess(keyReply)
    await assertRecoveryProof(keyReply, powReply)
    assertRecoveryCookie(await keyReply.headerValue('set-cookie'))
    await assertNoStore(began)
    await readFrame(began, FrameType.PasskeyLoginBegin)
    await emptySuccess(complete)
    for (const response of [began, complete])
      assert.equal((await response.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], handle)
    assertWebAuthnUv(complete.request().postDataBuffer())
    const cookies = await context.cookies(origin + R.SitePasskeyRemoveCurrentBegin)
    assert(!cookies.some(cookie => cookie.name === siteCookieName || cookie.name === rebindCookieName),
      'Removal left a site or rebind cookie in the original browser.')
    await session(context, 401)
    await keyField.waitFor({ state: 'hidden' })
    checks.finalPasskeyRemoved = true
  }

  state.phase = 'verify-response-loss'
  await exactLabel(replacement.page, 'Recovery Key').fill(second)
  const lostVerification = await loseResponse(replacement.page, R.RecoveryKeyVerify, async (upstream, sent) => {
    assertRecoveryCookie(upstream.headers()['set-cookie'])
    assert(Boolean((await sent.allHeaders())[WireHeaders.PowProof.toLowerCase()]), 'The lost verification omitted proof of work.')
  })
  await Promise.all([lostVerification.result, button(replacement.page, 'Replace Passkey').click()])
  await exactText(replacement.page, recoveryFailed).waitFor()
  const cookies = await replacement.context.cookies(origin + R.RecoveryKeyRebindBegin)
  assert(!cookies.some(cookie => cookie.name === rebindCookieName), 'Browser received the recovery cookie despite the dropped response.')
  assert(await exactLabel(replacement.page, 'Recovery Key').inputValue() === '', 'The key remained visible to the form after the lost response.')
  await reservationUnspent()
  checks.lostVerificationLeftKeyUnspent = true

  state.phase = 'rebind-response-loss'
  await exactLabel(replacement.page, 'Recovery Key').fill(second)
  const lostCompletion = await loseResponse(replacement.page, R.RecoveryKeyRebindComplete, (_, sent) => {
    const body = sent.postDataBuffer()
    assert(body?.length, 'No real registration attestation was submitted.')
    return body
  }, reservationUnspent)
  const [verification, challenge, beginReply, originalAttestation] = await Promise.all([
    waitApi(replacement.page, R.RecoveryKeyVerify), waitApi(replacement.page, R.RecoveryKeyPow),
    waitApi(replacement.page, R.RecoveryKeyRebindBegin), lostCompletion.result,
    button(replacement.page, 'Retry Passkey replacement').waitFor(), button(replacement.page, 'Replace Passkey').click(),
  ])
  await emptySuccess(verification)
  await assertRecoveryProof(verification, challenge)
  assertRecoveryCookie(await verification.headerValue('set-cookie'))
  assertStatus(beginReply, 200)
  checks.sameKeyRetriedAfterLostVerification = true
  checks.committedDespiteLostResponse = true
  const repeated = await clickApi(replacement.page, R.RecoveryKeyRebindComplete, 'Retry Passkey replacement')
  await emptySuccess(repeated)
  assert(originalAttestation.equals(repeated.request().postDataBuffer()), 'The browser did not repeat the same WebAuthn registration attestation.')
  assertNoSessionGrant(await repeated.headerValue('set-cookie'))
  await exactText(replacement.page, 'Passkey replaced. Log in with your new Passkey.').waitFor()
  await session(replacement.context, 401)
  checks.identicalAttestationRetried = true
  checks.rebindGrantedNoSession = true

  state.phase = 'retire-old-identity'
  await auth.assertStaleSessionRejected(origin, [cookieBeforeRebind])
  checks.oldSessionRevoked = true
  await owner.context.clearCookies({ name: siteCookieName })
  assertStatus(await passkey(owner.page), 401)
  checks.oldPasskeyRejected = true
  await openRecovery(owner.page, second)
  const spent = await verifyRecovery(owner.page)
  assertStatus(spent, 401)
  checks.usedKeyRejected = spent.status()

  state.phase = 'authenticate-replacement-with-mfa'
  assert.equal(await authLogin(await passkey(replacement.page), 2), originalIdentity)
  await session(replacement.context, 401)
  await exactLabel(replacement.page, 'Authenticator or recovery code').waitFor()
  await auth.completeSiteTotp(replacement.page, clickApi, secrets, secret, setupStep)
  await signedIn(replacement.page)
  const newState = await session(replacement.context, 200)
  assert(newState.name === originalState.name && newState.generation > preRecoveryState.generation,
    'The restored session did not preserve the account and advance its generation.')
  checks.replacementRequiredMfaBeforeSession = true
  if (removeCurrent) checks.removedAccountRecoveredWithSameKey = true

  const peerAfter = await session(peer.context, 200)
  assert(peerAfter.name === peerState.name && peerAfter.generation === peerState.generation &&
    (await siteCookie(peer.context)).value === peerCookie.value, 'The peer account was changed by another account’s recovery.')
  checks.independentPeerUnaffected = true
  assert.deepEqual(faults, [])
  state.phase = 'passed'
})

function setVerified(fixture, isUserVerified) {
  return fixture.cdp.send('WebAuthn.setUserVerified', { authenticatorId: fixture.authenticatorId, isUserVerified })
}

function assertNoSessionGrant(header) { assert(!header?.includes(siteCookieName + '='), 'Recovery response changed the site session cookie.') }

function assertRecoveryCookie(header) {
  assertNoSessionGrant(header)
  assert(/^fsus-v2-site-recovery=[^;]+;/i.test(header) &&
    /(?:^|;\s*)path=\/api\/v2\/identity\/recovery-key\/rebind(?:;|$)/i.test(header) &&
    /(?:^|;\s*)httponly(?:;|$)/i.test(header) && /(?:^|;\s*)secure(?:;|$)/i.test(header) &&
    /(?:^|;\s*)samesite=strict(?:;|$)/i.test(header), 'Recovery ticket cookie lacked its required scope or security attributes.')
}

async function reservationUnspent() {
  const { stdout } = await adminFx.runFixtureCommand(probeReservation, [], 5_000)
  assert.equal(stdout.trim(), '1', 'PostgreSQL did not retain exactly one unspent key and current reservation.')
}

async function loseResponse(page, path, inspect, beforeRequest) {
  const result = Promise.withResolvers()
  await page.route(origin + path, async route => {
    let transport
    try {
      if (beforeRequest) await beforeRequest()
      // An independent cookie jar keeps responses blocked here from reaching the real browser.
      transport = await auth.request.newContext()
      const sent = route.request()
      const upstream = await transport.post(sent.url(), { maxRedirects: 0, headers: await sent.allHeaders(), data: sent.postDataBuffer() })
      await emptySuccess(upstream)
      assertNoSessionGrant(upstream.headers()['set-cookie'])
      const value = await inspect(upstream, sent)
      await route.abort('connectionreset')
      result.resolve(value)
    } catch (error) {
      await route.abort('failed').catch(() => {})
      result.reject(error)
    } finally { await transport?.dispose() }
  }, { times: 1 })
  return { result: result.promise }
}

async function siteCookie(context) {
  const cookie = (await context.cookies(origin)).find(candidate => candidate.name === siteCookieName)
  assert(cookie?.httpOnly && cookie.secure, 'The authenticated fixture lacks its secure site session cookie.')
  return cookie
}

async function session(context, status) {
  const reply = await context.request.get(origin + R.Session)
  assertStatus(reply, status)
  if (status === 200) return readFrame(reply, FrameType.OperatorSession, wire.decodeSession)
}

async function signedIn(page) {
  await page.waitForURL(origin + '/user/identity/mfa')
  await exactHeading(page, 'Account').waitFor()
}

async function passkey(page) {
  await page.goto(origin + '/login')
  return clickApi(page, R.PasskeyLoginComplete, 'Log in with Passkey')
}

async function authLogin(response, expectedPhase) {
  const payload = await readFrame(response, FrameType.AuthLoginFlow)
  assert.equal(payload[4], expectedPhase)
  const account = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, true)
  assert(account > 0, 'The Passkey login omitted the stable identity.')
  return account
}

async function issue(page, label) {
  const [verification, result] = await Promise.all([waitApi(page, R.RecoveryKeyStepUpComplete), clickApi(page, R.RecoveryKeyIssue, label)])
  assertStatus(verification, 200)
  assertWebAuthnUv(verification.request().postDataBuffer())
  assertStatus(result, 200)
  assert(Boolean((await result.request().allHeaders())[WireHeaders.MfaProof.toLowerCase()]), 'Key issuance omitted the step-up proof.')
  const keyNode = page.getByTestId('site-recovery-key'), key = await keyNode.textContent()
  assert(/^frk_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/.test(key), 'The issued key was missing or malformed.')
  secrets.push(key)
  await button(page, 'Hide Recovery Key').click()
  await keyNode.waitFor({ state: 'detached' })
  return key
}

function assertWebAuthnUv(body) {
  const payload = decodeFrame(body, FrameType.PasskeyLoginCompleteRequest).payload
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const authenticatorRef = WireLayouts.PasskeyCompleteBlobRefsOffset + 3 * WireLayouts.PasskeySliceSize
  const offset = view.getInt32(authenticatorRef, true), size = view.getInt32(authenticatorRef + 4, true)
  const blobStart = WireLayouts.PasskeyLoginCompleteSize + 4
  assert(offset >= 0 && size >= 37 && blobStart + offset + size <= payload.length)
  assert((payload[blobStart + offset + 32] & 4) !== 0, 'WebAuthn did not attest user verification.')
}

async function openRecovery(page, key) {
  await page.goto(origin + '/login')
  await button(page, 'Can’t use your Passkey?').click()
  await exactLabel(page, 'Recovery Key').fill(key)
}

async function verifyRecovery(page) {
  const [reply, challenge] = await Promise.all([clickApi(page, R.RecoveryKeyVerify, 'Replace Passkey'), waitApi(page, R.RecoveryKeyPow)])
  await assertRecoveryProof(reply, challenge)
  return reply
}

async function assertRecoveryProof(reply, challenge) {
  assertStatus(challenge, 200)
  assert(Boolean((await reply.request().allHeaders())[WireHeaders.PowProof.toLowerCase()]),
    'The browser recovery request did not include its scoped proof of work.')
}
