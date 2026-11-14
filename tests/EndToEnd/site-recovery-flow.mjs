import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { decodeFrame, decodeSuccess, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeSession, encodeRecoveryKeyOperation, FrameType, WireHeaders, WireLayouts, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const packages = createRequire(new URL('../../src/Web/package.json', import.meta.url))
const { chromium, request } = packages('@playwright/test')
const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
const origin = url.origin
const ownerTicket = process.env.FSUSBLOG_TEST_SITE_TICKET
const peerTicket = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PEER_TICKET
const probeReservation = process.env.FSUSBLOG_TEST_SITE_RECOVERY_PROBE
const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
assert(url.hostname === 'localhost' && url.protocol === 'https:' &&
  ownerTicket && peerTicket && ownerTicket !== peerTicket && probeReservation &&
  /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins),
  'Provide a scratch HTTPS localhost site, two separate fixture accounts, the reservation probe and the local leaf certificate pins.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/site-recovery-browser')
await mkdir(evidence, { recursive: true })

const startedAt = new Date().toISOString()
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
  args: [`--ignore-certificate-errors-spki-list=${pins}`] })
const checks = {}
const responses = []
const faults = []
const secrets = [ownerTicket, peerTicket]
const siteCookieName = 'fsus-v2-session'
const rebindCookieName = 'fsus-v2-site-recovery'
const recoveryFailed = 'Could not recover this account. Check your Recovery Key and try again.'
const exec = promisify(execFile)
let phase = 'bootstrap'
let failure
try {
  const owner = await siteBrowser('owner')
  const replacement = await siteBrowser('replacement')
  const peer = await siteBrowser('peer', false)
  await peer.page.goto(origin + '/login')
  await peer.page.getByLabel('Owner access key').fill(peerTicket)
  const peerSignIn = await clickApi(peer.page, WireRoutes.SignIn, 'Log in')
  assert.equal(peerSignIn.status(), 200)
  await signedIn(peer.page)
  const peerState = await session(peer.context, 200)
  const peerCookie = await siteCookie(peer.context)

  const initialPage = await owner.page.goto(origin + '/login')
  const security = await initialPage?.securityDetails()
  assert(security?.protocol.startsWith('TLS') && await owner.page.evaluate(() => window.isSecureContext),
    'Recovery acceptance must use a real TLS browser context.')
  checks.tlsWebAuthn = security.protocol
  await owner.page.getByLabel('Owner access key').fill(ownerTicket)
  assert.equal((await clickApi(owner.page, WireRoutes.PasskeyProvisionComplete, 'Create Passkey')).status(), 200)
  await owner.page.getByText('Passkey created. Log in with your Passkey.', { exact: true }).waitFor()
  const initialLogin = await passkey(owner.page)
  const originalIdentity = await authLogin(initialLogin, 1)
  await signedIn(owner.page)
  const originalState = await session(owner.context, 200)
  assert(originalState.name !== peerState.name, 'The peer must be a separate authenticated account.')

  phase = 'configure-mfa'
  await owner.page.goto(origin + '/user/identity/mfa')
  await owner.page.getByRole('button', { name: 'Set up authenticator', exact: true }).click()
  const seed = await owner.page.getByTestId('mfa-seed').textContent()
  assert(/^[A-Z2-7]{32}$/.test(seed), 'The authenticator seed was unavailable.')
  secrets.push(seed)
  const secret = readSeed(seed)
  const setupStep = Math.floor(Date.now() / 30_000)
  const setupCode = totp(secret, setupStep)
  secrets.push(setupCode)
  await owner.page.getByLabel('Authenticator code', { exact: true }).fill(setupCode)
  assert.equal((await clickApi(owner.page, WireRoutes.MfaSetupVerify, 'Enable verification')).status(), 200)
  await owner.page.getByRole('button', { name: 'Hide recovery codes', exact: true }).click()
  const cookieBeforeRebind = await siteCookie(owner.context)
  const mfaState = await session(owner.context, 200)

  phase = 'require-step-up'
  const command = encodeFrame(FrameType.RecoveryKeyOperation, encodeRecoveryKeyOperation({ operation: 1 }))
  const unproved = await owner.context.request.post(origin + WireRoutes.RecoveryKeyIssue, {
    headers: { 'Content-Type': 'application/octet-stream', Origin: origin }, data: Buffer.from(command),
  })
  assert.equal(unproved.status(), 428)
  await button(owner.page, 'Create Recovery Key').waitFor()
  await setVerified(owner, false)
  const rejectedUv = owner.page.waitForResponse(response =>
    isApi(response, WireRoutes.RecoveryKeyStepUpComplete, 'POST'), { timeout: 1400 }).then(response => response.status(), error => {
    if (error.name !== 'TimeoutError') throw error
    return 'no browser submission'
  })
  assert.equal((await clickApi(owner.page, WireRoutes.RecoveryKeyStepUpBegin, 'Create Recovery Key')).status(), 200)
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
  assert.equal(retired.status(), 401)
  checks.rotatedKeyRejected = retired.status()
  await replacement.page.getByText(recoveryFailed, { exact: true }).waitFor()
  await session(owner.context, 200)

  phase = 'verify-response-loss'
  await replacement.page.getByLabel('Recovery Key', { exact: true }).fill(second)
  const lostVerification = await loseResponse(replacement.page, WireRoutes.RecoveryKeyVerify, async (upstream, sent) => {
    assertRecoveryCookie(upstream.headers()['set-cookie'])
    assert(Boolean((await sent.allHeaders())[WireHeaders.PowProof.toLowerCase()]), 'The lost verification omitted proof of work.')
  })
  const errorMessage = replacement.page.getByText(recoveryFailed, { exact: true })
  await Promise.all([
    lostVerification.result, button(replacement.page, 'Replace Passkey').click(),
  ])
  await errorMessage.waitFor()
  const cookies = await replacement.context.cookies(origin + WireRoutes.RecoveryKeyRebindBegin)
  assert(!cookies.some(cookie => cookie.name === rebindCookieName), 'Browser received the recovery cookie despite the dropped response.')
  assert(await replacement.page.getByLabel('Recovery Key', { exact: true }).inputValue() === '',
    'The key remained visible to the form after the lost response.')
  await reservationUnspent()
  checks.lostVerificationLeftKeyUnspent = true

  phase = 'rebind-response-loss'
  await replacement.page.getByLabel('Recovery Key', { exact: true }).fill(second)
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
  assert.equal(beginReply.status(), 200)
  checks.sameKeyRetriedAfterLostVerification = true
  checks.committedDespiteLostResponse = true
  const repeated = await clickApi(replacement.page, WireRoutes.RecoveryKeyRebindComplete, 'Retry Passkey replacement')
  await emptySuccess(repeated)
  assert(originalAttestation.equals(repeated.request().postDataBuffer()),
    'The browser did not repeat the same WebAuthn registration attestation.')
  assertNoSessionGrant(await repeated.headerValue('set-cookie'))
  await replacement.page.getByText('Passkey replaced. Log in with your new Passkey.', { exact: true }).waitFor()
  await session(replacement.context, 401)
  checks.identicalAttestationRetried = true
  checks.rebindGrantedNoSession = true

  phase = 'retire-old-identity'
  const stale = await request.newContext({ storageState: { cookies: [cookieBeforeRebind], origins: [] } })
  try { assert.equal((await stale.get(origin + WireRoutes.Session)).status(), 401) }
  finally { await stale.dispose() }
  checks.oldSessionRevoked = true
  await owner.context.clearCookies({ name: siteCookieName })
  assert.equal((await passkey(owner.page)).status(), 401)
  checks.oldPasskeyRejected = true
  await openRecovery(owner.page, second)
  const spent = await verifyRecovery(owner.page)
  assert.equal(spent.status(), 401)
  checks.usedKeyRejected = spent.status()

  phase = 'authenticate-replacement-with-mfa'
  const login = await passkey(replacement.page)
  assert.equal(await authLogin(login, 2), originalIdentity)
  await session(replacement.context, 401)
  await replacement.page.getByLabel('Authenticator or recovery code', { exact: true }).waitFor()
  const freshStep = Math.max(setupStep + 1, Math.floor(Date.now() / 30_000))
  const challengeCode = totp(secret, freshStep)
  secrets.push(challengeCode)
  await replacement.page.getByLabel('Authenticator or recovery code', { exact: true }).fill(challengeCode)
  assert.equal((await clickApi(replacement.page, WireRoutes.MfaChallengeVerify, 'Verify and log in')).status(), 200)
  await signedIn(replacement.page)
  const newState = await session(replacement.context, 200)
  assert(newState.name === originalState.name && newState.generation > preRecoveryState.generation,
    'The restored session did not preserve the account and advance its generation.')
  checks.replacementRequiredMfaBeforeSession = true

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

async function siteBrowser(role, authenticator = true) {
  const context = await browser.newContext()
  context.setDefaultTimeout(18_000)
  const page = await context.newPage()
  page.on('pageerror', () => faults.push({ role, kind: 'uncaught-page-error' }))
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return
    responses.push({ role, path: url.pathname, status: response.status() })
    if (response.status() >= 500) faults.push({ role, path: url.pathname, status: response.status() })
  })
  if (!authenticator) return { context, page }
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })
  return { context, page, cdp, authenticatorId }
}

function setVerified(fixture, isUserVerified) {
  return fixture.cdp.send('WebAuthn.setUserVerified', { authenticatorId: fixture.authenticatorId, isUserVerified })
}

function button(page, name) {
  return page.getByRole('button', { name, exact: true })
}

function isApi(response, path, method) {
  return response.url() === origin + path && response.request().method() === method
}

function waitApi(page, path) {
  return page.waitForResponse(response => isApi(response, path, 'POST'))
}

async function clickApi(page, path, name) {
  const [reply] = await Promise.all([waitApi(page, path), button(page, name).click()])
  return reply
}

async function emptySuccess(response) {
  assert.equal(response.status(), 200)
  const headers = 'allHeaders' in response ? await response.allHeaders() : response.headers()
  assert(headers['cache-control']?.includes('no-store'), 'Recovery response may be stored.')
  decodeSuccess(decodeFrame(await response.body(), FrameType.EmptySuccess).payload)
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
  assert.equal(reply.status(), status)
  if (status === 200) return decodeSession(decodeFrame(await reply.body(), FrameType.OperatorSession).payload)
}

async function signedIn(page) {
  await page.waitForURL(origin + '/user/manage/article/write')
  await page.getByRole('heading', { name: 'New article', exact: true }).waitFor()
}

async function passkey(page) {
  await page.goto(origin + '/login')
  return clickApi(page, WireRoutes.PasskeyLoginComplete, 'Log in with Passkey')
}

async function authLogin(response, expectedPhase) {
  assert.equal(response.status(), 200)
  const payload = decodeFrame(await response.body(), FrameType.AuthLoginFlow).payload
  assert.equal(payload[4], expectedPhase)
  const account = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(0, true)
  assert(account > 0, 'The Passkey login omitted the stable identity.')
  return account
}

async function issue(page, label) {
  const verified = waitApi(page, WireRoutes.RecoveryKeyStepUpComplete)
  const [verification, result] = await Promise.all([verified, clickApi(page, WireRoutes.RecoveryKeyIssue, label)])
  assert.equal(verification.status(), 200)
  assertWebAuthnUv(verification.request().postDataBuffer())
  assert.equal(result.status(), 200)
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
  await button(page, 'Recover with Recovery Key').click()
  await page.getByLabel('Recovery Key', { exact: true }).fill(key)
}

async function verifyRecovery(page) {
  const [reply, challenge] = await Promise.all([
    clickApi(page, WireRoutes.RecoveryKeyVerify, 'Replace Passkey'), waitApi(page, WireRoutes.RecoveryKeyPow),
  ])
  await assertRecoveryProof(reply, challenge)
  return reply
}

async function assertRecoveryProof(reply, challenge) {
  assert.equal(challenge.status(), 200)
  assert(Boolean((await reply.request().allHeaders())[WireHeaders.PowProof.toLowerCase()]),
    'The browser recovery request did not include its scoped proof of work.')
}

function readSeed(seed) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const letter of seed) {
    bits += 5
    value = (value << 5) | alphabet.indexOf(letter)
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >> bits) & 255)
    }
  }
  return Buffer.from(bytes)
}

function totp(secret, step) {
  const interval = Buffer.alloc(8)
  interval.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(interval).digest()
  const offset = mac.at(-1) & 15
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}
