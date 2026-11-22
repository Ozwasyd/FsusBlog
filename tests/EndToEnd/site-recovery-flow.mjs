import { exactText, exactLabel, roleWithExactName } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { assertStatus } from './response-status-fixture.mjs'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSession, encodeRecoveryKeyOperation, FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { assertEmptySuccess, button, enableAuthenticator, launchIdentityBrowser, readTlsIdentityFixture, recordIdentityResponse, request, secureLoginProtocol, setupSiteTotp, completeSiteTotp, siteApi } from './site-authentication-fixture.mjs'

const peerTicket = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PEER_TICKET
const probeReservation = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PROBE
const removeCurrent = process.env.FSUSBLOG_TEST_SITE_RECOVERY_REMOVE_CURRENT === '1'
const { origin, ownerTicket, pins } = readTlsIdentityFixture(peerTicket, probeReservation,
  'Provide a scratch HTTPS localhost site, two separate fixture accounts, the reservation probe and the local leaf certificate pins.')
const { isApi, waitApi, clickApi } = siteApi(origin, (page, predicate) => page.waitForResponse(predicate))
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-recovery-browser')
await mkdir(evidence, { recursive: true })

const startedAt = new Date().toISOString()
const browser = await launchIdentityBrowser(pins)
const checks = {}
const responses = []
const faults = []
const secrets = [ownerTicket, peerTicket]
const siteCookieName = 'fsus-v2-session'
const rebindCookieName = 'fsus-v2-site-recovery'
const recoveryFailed = 'Could not recover this account. Check your Recovery Key and try again.'
const emptySuccess = reply => assertEmptySuccess(reply, 'Recovery response may be stored.')
const exec = promisify(execFile)
let phase = 'bootstrap'
let failure
try {
  const owner = await siteBrowser('owner')
  const replacement = await siteBrowser('replacement')
  const peer = await siteBrowser('peer')
  await peer.page.goto(origin + '/login')
  await enrollPasskey(peer.page, peerTicket)
  const peerSignIn = await passkey(peer.page)
  await authLogin(peerSignIn, 1)
  await signedIn(peer.page)
  const peerState = await session(peer.context, 200)
  const peerCookie = await siteCookie(peer.context)

  const initialPage = await owner.page.goto(origin + '/login')
  checks.tlsWebAuthn = await secureLoginProtocol(owner.page, initialPage,
    'Recovery acceptance must use a real TLS browser context.')
  await enrollPasskey(owner.page, ownerTicket)
  const initialLogin = await passkey(owner.page)
  const originalIdentity = await authLogin(initialLogin, 1)
  await signedIn(owner.page)
  const originalState = await session(owner.context, 200)
  assert(originalState.name !== peerState.name, 'The peer must be a separate authenticated account.')

  phase = 'configure-mfa'
  await owner.page.goto(origin + '/user/identity/mfa')
  const { secret, setupStep } = await setupSiteTotp(owner.page, clickApi, secrets, 'The authenticator seed was unavailable.')
  const cookieBeforeRebind = await siteCookie(owner.context)
  const mfaState = await session(owner.context, 200)

  phase = 'require-step-up'
  const command = encodeFrame(FrameType.RecoveryKeyOperation, encodeRecoveryKeyOperation({ operation: 1 }))
  const unproved = await owner.context.request.post(origin + WireRoutes.RecoveryKeyIssue, {
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin }, data: Buffer.from(command),
  })
  assertStatus(unproved, 428)
  await button(owner.page, 'Create Recovery Key').waitFor()
  await setVerified(owner, false)
  const rejectedUv = owner.page.waitForResponse(response =>
    isApi(response, WireRoutes.RecoveryKeyStepUpComplete, 'POST'), { timeout: 1400 }).then(response => response.status(), error => {
    if (error.name !== 'TimeoutError') throw error
    return 'no browser submission'
  })
  assertStatus(await clickApi(owner.page, WireRoutes.RecoveryKeyStepUpBegin, 'Create Recovery Key'), 200)
  const browserBlocked = await rejectedUv
  const noIssuance = await owner.page.getByTestId('site-recovery-key').count() === 0
  assert(noIssuance && [401, 403, 'no browser submission'].includes(browserBlocked),
    'An unverified authenticator completed step-up.')
  await owner.page.reload()
  await setVerified(owner, true)
  checks.issueWithoutProof = unproved.status()
  checks.unverifiedAuthenticator = browserBlocked

  phase = 'issue-and-rotate'
  const first = await issue(owner.page, 'Create Recovery Key')
  const second = await issue(owner.page, 'Replace Recovery Key')
  assert(first !== second, 'Rotation returned the previous Recovery Key.')
  checks.creationAndRotationUsedWebAuthnUv = true
  checks.keyHiddenAfterReceipt = true
  const preRecoveryState = await session(owner.context, 200)
  assert(preRecoveryState.name === mfaState.name && preRecoveryState.generation === mfaState.generation,
    'Creating or rotating a key unexpectedly replaced the current identity.')

  phase = 'retired-key'
  await openRecovery(replacement.page, first)
  const retired = await verifyRecovery(replacement.page)
  assertStatus(retired, 401)
  checks.rotatedKeyRejected = retired.status()
  await exactText(replacement.page, recoveryFailed).waitFor()
  await session(owner.context, 200)

  if (removeCurrent) {
    phase = 'remove-final-passkey'
    const { page, context } = owner
    const authority = await context.request.get(origin + WireRoutes.Session)
    assertStatus(authority, 200)
    const handle = authority.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(/^[0-9a-f]{64}$/.test(handle), 'The current session handle is required.')
    const headers = { [WireHeaders.CurrentSession]: handle }
    const inventory = await context.request.get(origin + WireRoutes.SitePasskeys, { headers })
    assertStatus(inventory, 200)
    const list = decodeFrame(await inventory.body(), FrameType.SitePasskeys).payload
    assert.equal(new DataView(list.buffer, list.byteOffset, list.byteLength).getInt32(0, true), 1)

    const deniedBegin = await context.request.post(origin + WireRoutes.SitePasskeyRemoveCurrentBegin, {
      headers: { ...headers, Origin: origin },
    })
    assertStatus(deniedBegin, 401)
    await session(context, 200)
    checks.removalWithoutRecoveryDenied = true

    await button(page, 'Remove current Passkey').click()
    const keyField = exactLabel(page, 'Recovery Key to confirm removal')
    await keyField.fill(first)
    const [invalid, invalidProof] = await Promise.all([
      clickApi(page, WireRoutes.RecoveryKeyVerify, 'Remove with Passkey'), waitApi(page, WireRoutes.RecoveryKeyPow),
    ])
    await assertRecoveryProof(invalid, invalidProof)
    assertStatus(invalid, 401)
    await session(context, 200)
    checks.removalWithRotatedKeyDenied = true

    if (!await keyField.isVisible()) await button(page, 'Remove current Passkey').click()
    await keyField.fill(second)
    const [keyReply, powReply, began, complete] = await Promise.all([
      waitApi(page, WireRoutes.RecoveryKeyVerify), waitApi(page, WireRoutes.RecoveryKeyPow),
      waitApi(page, WireRoutes.SitePasskeyRemoveCurrentBegin), waitApi(page, WireRoutes.SitePasskeyRemoveCurrentComplete),
      button(page, 'Remove with Passkey').click(),
    ])
    await emptySuccess(keyReply)
    await assertRecoveryProof(keyReply, powReply)
    assertRecoveryCookie(await keyReply.headerValue('set-cookie'))
    assertStatus(began, 200)
    assert((await began.headerValue('cache-control'))?.includes('no-store'))
    decodeFrame(await began.body(), FrameType.PasskeyLoginBegin)
    await emptySuccess(complete)
    for (const response of [began, complete])
      assert.equal((await response.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], handle)
    assertWebAuthnUv(complete.request().postDataBuffer())
    const cookies = await context.cookies(origin + WireRoutes.SitePasskeyRemoveCurrentBegin)
    assert(!cookies.some(cookie => cookie.name === siteCookieName || cookie.name === rebindCookieName),
      'Removal left a site or rebind cookie in the original browser.')
    await session(context, 401)
    await keyField.waitFor({ state: 'hidden' })
    checks.finalPasskeyRemoved = true
  }

  phase = 'verify-response-loss'
  await exactLabel(replacement.page, 'Recovery Key').fill(second)
  const lostVerification = await loseResponse(replacement.page, WireRoutes.RecoveryKeyVerify, async (upstream, sent) => {
    assertRecoveryCookie(upstream.headers()['set-cookie'])
    assert(Boolean((await sent.allHeaders())[WireHeaders.PowProof.toLowerCase()]), 'The lost verification omitted proof of work.')
  })
  const errorMessage = exactText(replacement.page, recoveryFailed)
  await Promise.all([
    lostVerification.result, button(replacement.page, 'Replace Passkey').click(),
  ])
  await errorMessage.waitFor()
  const cookies = await replacement.context.cookies(origin + WireRoutes.RecoveryKeyRebindBegin)
  assert(!cookies.some(cookie => cookie.name === rebindCookieName), 'Browser received the recovery cookie despite the dropped response.')
  assert(await exactLabel(replacement.page, 'Recovery Key').inputValue() === '',
    'The key remained visible to the form after the lost response.')
  await reservationUnspent()
  checks.lostVerificationLeftKeyUnspent = true

  phase = 'rebind-response-loss'
  await exactLabel(replacement.page, 'Recovery Key').fill(second)
  const lostCompletion = await loseResponse(replacement.page, WireRoutes.RecoveryKeyRebindComplete, (_, sent) => {
    const body = sent.postDataBuffer()
    assert(body?.length, 'No real registration attestation was submitted.')
    return body
  }, reservationUnspent)
  const verified = waitApi(replacement.page, WireRoutes.RecoveryKeyVerify)
  const pow = waitApi(replacement.page, WireRoutes.RecoveryKeyPow)
  const rebindBegan = waitApi(replacement.page, WireRoutes.RecoveryKeyRebindBegin)
  const retry = button(replacement.page, 'Retry Passkey replacement').waitFor()
  const [verification, challenge, beginReply, originalAttestation] = await Promise.all([
    verified, pow, rebindBegan, lostCompletion.result, retry, button(replacement.page, 'Replace Passkey').click(),
  ])
  await emptySuccess(verification)
  await assertRecoveryProof(verification, challenge)
  assertRecoveryCookie(await verification.headerValue('set-cookie'))
  assertStatus(beginReply, 200)
  checks.sameKeyRetriedAfterLostVerification = true
  checks.committedDespiteLostResponse = true
  const repeated = await clickApi(replacement.page, WireRoutes.RecoveryKeyRebindComplete, 'Retry Passkey replacement')
  await emptySuccess(repeated)
  assert(originalAttestation.equals(repeated.request().postDataBuffer()),
    'The browser did not repeat the same WebAuthn registration attestation.')
  assertNoSessionGrant(await repeated.headerValue('set-cookie'))
  await exactText(replacement.page, 'Passkey replaced. Log in with your new Passkey.').waitFor()
  await session(replacement.context, 401)
  checks.identicalAttestationRetried = true
  checks.rebindGrantedNoSession = true

  phase = 'retire-old-identity'
  const stale = await request.newContext({ storageState: { cookies: [cookieBeforeRebind], origins: [] } })
  try { assertStatus(await stale.get(origin + WireRoutes.Session), 401) }
  finally { await stale.dispose() }
  checks.oldSessionRevoked = true
  await owner.context.clearCookies({ name: siteCookieName })
  assertStatus(await passkey(owner.page), 401)
  checks.oldPasskeyRejected = true
  await openRecovery(owner.page, second)
  const spent = await verifyRecovery(owner.page)
  assertStatus(spent, 401)
  checks.usedKeyRejected = spent.status()

  phase = 'authenticate-replacement-with-mfa'
  const login = await passkey(replacement.page)
  assert.equal(await authLogin(login, 2), originalIdentity)
  await session(replacement.context, 401)
  await exactLabel(replacement.page, 'Authenticator or recovery code').waitFor()
  await completeSiteTotp(replacement.page, clickApi, secrets, secret, setupStep)
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
  phase = 'passed'
} catch (error) {
  const redact = value => secrets.reduce((message, secret) => message.replaceAll(secret, '[fixture secret]'), value)
  failure = redact(String(error)).replace(/\b[A-Za-z0-9_-]{43}\b/g, '[fixture token]')
} finally {
  await browser.close()
  await writeFile(join(evidence, 'site-recovery-result.json'), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), origin, chromium: browser.version(),
    phase, checks, responses, faults, failure,
  }, null, 2))
}
if (failure) throw new Error(`${phase}: ${failure}`)

async function siteBrowser(role) {
  const context = await browser.newContext({ locale: 'en-US' })
  await context.addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
  context.setDefaultTimeout(18_000)
  context.setDefaultNavigationTimeout(18_000)
  const page = await context.newPage()
  page.on('pageerror', () => faults.push({ role, kind: 'uncaught-page-error' }))
  page.on('response', recordIdentityResponse(origin, role, responses, faults))
  const { cdp, authenticatorId } = await enableAuthenticator(context, page)
  return { context, page, cdp, authenticatorId }
}

function setVerified(fixture, isUserVerified) {
  return fixture.cdp.send('WebAuthn.setUserVerified', { authenticatorId: fixture.authenticatorId, isUserVerified })
}

function assertNoSessionGrant(header) {
  assert(!header?.includes(siteCookieName + '='), 'Recovery response changed the site session cookie.')
}

function assertRecoveryCookie(header) {
  assertNoSessionGrant(header)
  assert(/^fsus-v2-site-recovery=[^;]+;/i.test(header) &&
    /(?:^|;\s*)path=\/api\/v2\/identity\/recovery-key\/rebind(?:;|$)/i.test(header) &&
    /(?:^|;\s*)httponly(?:;|$)/i.test(header) &&
    /(?:^|;\s*)secure(?:;|$)/i.test(header) &&
    /(?:^|;\s*)samesite=strict(?:;|$)/i.test(header), 'Recovery ticket cookie lacked its required scope or security attributes.')
}

async function reservationUnspent() {
  const { stdout } = await exec(probeReservation, [], { timeout: 5000 })
  assert.equal(stdout.trim(), '1', 'PostgreSQL did not retain exactly one unspent key and current reservation.')
}

async function loseResponse(page, path, inspect, beforeRequest) {
  const result = Promise.withResolvers()
  await page.route(origin + path, async route => {
    let transport
    try {
      if (beforeRequest) await beforeRequest()
      // An independent cookie jar keeps responses blocked here from reaching the real browser.
      transport = await request.newContext()
      const sent = route.request()
      const upstream = await transport.post(sent.url(), {
        maxRedirects: 0, headers: await sent.allHeaders(), data: sent.postDataBuffer(),
      })
      await emptySuccess(upstream)
      assertNoSessionGrant(upstream.headers()['set-cookie'])
      const value = await inspect(upstream, sent)
      await route.abort('connectionreset')
      result.resolve(value)
    } catch (error) {
      await route.abort('failed').catch(() => {})
      result.reject(error)
    } finally {
      await transport?.dispose()
    }
  }, { times: 1 })
  return { result: result.promise }
}

async function siteCookie(context) {
  const cookie = (await context.cookies(origin)).find(candidate => candidate.name === siteCookieName)
  assert(cookie?.httpOnly && cookie.secure, 'The authenticated fixture lacks its secure site session cookie.')
  return cookie
}

async function session(context, status) {
  const reply = await context.request.get(origin + WireRoutes.Session)
  assertStatus(reply, status)
  if (status === 200) return decodeSession(decodeFrame(await reply.body(), FrameType.OperatorSession).payload)
}

async function signedIn(page) {
  await page.waitForURL(origin + '/user/identity/mfa')
  await roleWithExactName(page, 'heading', 'Account').waitFor()
}

async function enrollPasskey(page, ticket) {
  await button(page, 'Set up your first Passkey').click()
  await exactLabel(page, 'One-time setup ticket').fill(ticket)
  assertStatus(await clickApi(page, WireRoutes.PasskeyProvisionComplete, 'Create Passkey'), 200)
  await exactText(page, 'Passkey created. Log in with your Passkey.').waitFor()
}

async function passkey(page) {
  await page.goto(origin + '/login')
  return clickApi(page, WireRoutes.PasskeyLoginComplete, 'Log in with Passkey')
}

async function authLogin(response, expectedPhase) {
  assertStatus(response, 200)
  const payload = decodeFrame(await response.body(), FrameType.AuthLoginFlow).payload
  assert.equal(payload[4], expectedPhase)
  const account = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, true)
  assert(account > 0, 'The Passkey login omitted the stable identity.')
  return account
}

async function issue(page, label) {
  const verified = waitApi(page, WireRoutes.RecoveryKeyStepUpComplete)
  const [verification, result] = await Promise.all([verified, clickApi(page, WireRoutes.RecoveryKeyIssue, label)])
  assertStatus(verification, 200)
  assertWebAuthnUv(verification.request().postDataBuffer())
  assertStatus(result, 200)
  assert(Boolean((await result.request().allHeaders())[WireHeaders.MfaProof.toLowerCase()]), 'Key issuance omitted the step-up proof.')
  const keyNode = page.getByTestId('site-recovery-key')
  const key = await keyNode.textContent()
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
  const offset = view.getInt32(authenticatorRef, true)
  const size = view.getInt32(authenticatorRef + 4, true)
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
  const [reply, challenge] = await Promise.all([
    clickApi(page, WireRoutes.RecoveryKeyVerify, 'Replace Passkey'), waitApi(page, WireRoutes.RecoveryKeyPow),
  ])
  await assertRecoveryProof(reply, challenge)
  return reply
}

async function assertRecoveryProof(reply, challenge) {
  assertStatus(challenge, 200)
  assert(Boolean((await reply.request().allHeaders())[WireHeaders.PowProof.toLowerCase()]),
    'The browser recovery request did not include its scoped proof of work.')
}
