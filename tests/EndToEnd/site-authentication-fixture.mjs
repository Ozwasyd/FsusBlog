import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { launchChrome, openLocaleContext, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertEmpty, assertNoStore, assertStatus } from './response-status-fixture.mjs'
import { exactButton as button, exactLabel, exactText } from './role-locators.mjs'
import { requireWebPackage } from './web-package-fixture.mjs'
import { enableAuthenticator } from './webauthn-fixture.mjs'

const { expect, request } = requireWebPackage('@playwright/test')
export { expect, request, button, enableAuthenticator }
export { addAuthenticator } from './webauthn-fixture.mjs'

export function readTlsIdentityFixture(peerTicket, probe, error) {
  const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
  const ownerTicket = process.env.FSUSBLOG_TEST_SITE_TICKET
  const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
  assert(url.hostname === 'localhost' && url.protocol === 'https:' && ownerTicket && peerTicket &&
    ownerTicket !== peerTicket && probe && /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins), error)
  return { origin: url.origin, ownerTicket, pins }
}

export function siteApi(origin, waitForResponse) {
  function isApi(response, path, method) {
    return response.url() === origin + path && response.request().method() === method
  }
  function waitApi(target, path, method = 'POST') {
    return waitForResponse(target, response => isApi(response, path, method))
  }
  async function clickApi(page, path, label) {
    const [reply] = await Promise.all([waitApi(page, path), button(page, label).click()])
    return reply
  }
  return { isApi, waitApi, clickApi }
}

export async function secureLoginProtocol(page, response, message) {
  const security = await response?.securityDetails()
  assert(security?.protocol.startsWith('TLS') && await page.evaluate(() => window.isSecureContext), message)
  return security.protocol
}

export function readTlsPublicationFixture(error, hostname = '127.0.0.1') {
  const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
  const ticket = process.env.FSUSBLOG_TEST_SITE_TICKET
  const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
  assert(url.hostname === hostname && url.protocol === 'https:' && /^[0-9a-f]{64}$/.test(ticket ?? '') &&
    /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins ?? ''), error)
  return { url, origin: url.origin, ticket, pins }
}

export const launchIdentityBrowser = pins => launchChrome(pins ? [`--ignore-certificate-errors-spki-list=${pins}`] : [])

export async function assertBoundNoStore(response, handle, message) {
  assert.equal((await response.request().allHeaders())[WireHeaders.CurrentSession.toLowerCase()], handle, message)
  await assertNoStore(response)
}

export async function findCookie(context, url, name) {
  return (await context.cookies(url)).find(cookie => cookie.name === name)
}

export function recordIdentityResponse(origin, role, responses, faults) {
  return response => {
    const url = new URL(response.url())
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) return
    responses.push({ role, path: url.pathname, status: response.status() })
    if (response.status() >= 500) faults.push({ role, path: url.pathname, status: response.status() })
  }
}

export async function assertEmptySuccess(reply, cacheError) {
  await assertNoStore(reply, cacheError)
  await assertEmpty(reply)
}

export async function assertStaleSessionRejected(origin, cookies, extraCheck) {
  const stale = await request.newContext({ storageState: { cookies, origins: [] } })
  try {
    assertStatus(await stale.get(origin + WireRoutes.Session), 401)
    if (extraCheck) await extraCheck(stale)
  } finally { await stale.dispose() }
}

export async function readSessionHandle(context, origin, path = WireRoutes.Session) {
  const response = await context.request.get(origin + path)
  try {
    assertStatus(response, 200)
    const handle = response.headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(/^[0-9a-f]{64}$/.test(handle ?? ''), 'Expected an active 64-hex session handle.')
    return handle
  } finally { await response.dispose() }
}

export async function enrollFirstPasskey(page, ticket, clickApi, cacheError) {
  await button(page, 'Set up your first Passkey').click()
  await exactLabel(page, 'One-time setup ticket').fill(ticket)
  const reply = await clickApi(page, WireRoutes.PasskeyProvisionComplete, 'Create Passkey')
  if (cacheError) await assertEmptySuccess(reply, cacheError)
  else assertStatus(reply, 200)
  await exactText(page, 'Passkey created. Log in with your Passkey.').waitFor()
}

export function observeSiteContext(context, origin, role, responses, faults, timeout = 12_000) {
  context.setDefaultTimeout(timeout)
  context.setDefaultNavigationTimeout(timeout)
  context.on('page', page => page.on('pageerror', () => faults.push({ role, kind: 'uncaught-page-error' })))
  context.on('response', recordIdentityResponse(origin, role, responses, faults))
}

export async function openSiteBrowser(browser, origin, role, responses, faults, { timeout = 12_000, locale } = {}) {
  const context = await openLocaleContext(browser, origin, locale ? { locale } : undefined)
  observeSiteContext(context, origin, role, responses, faults, timeout)
  const page = await context.newPage()
  return { context, page, ...(await enableAuthenticator(context, page)) }
}

export function redactSecrets(error, secrets) {
  return secrets.reduce((value, secret) => value.replaceAll(secret, '[fixture secret]'), String(error))
    .replace(/\b[A-Za-z0-9_-]{43}\b|\b[a-f0-9]{64}\b/g, '[fixture token]')
}

export async function withRedactedEvidence(browser, evidence, filename, state, run) {
  const startedAt = new Date().toISOString()
  let redacted
  try {
    await withBrowserEvidence(browser, evidence, filename, failure => ({
      startedAt, finishedAt: new Date().toISOString(), origin: state.origin, chromium: browser.version(),
      phase: state.phase, checks: state.checks, responses: state.responses, faults: state.faults,
      failure: failure ? (redacted = redactSecrets(failure, state.secrets)) : undefined,
    }), run, { mkdir: true })
  } catch {
    throw new Error(`${state.phase}: ${redacted}`)
  }
}

export function assertNoCredentialLeak(artifact, tokens, message = 'Wire exposed a browser credential or its stored digest.') {
  for (const token of tokens) {
    const secret = Buffer.from(token, 'hex')
    const digest = createHash('sha256').update(secret).digest()
    assert(!artifact.includes(secret) && !artifact.includes(token) &&
      !artifact.includes(digest) && !artifact.includes(digest.toString('hex')), message)
    secret.fill(0)
  }
}

export async function setupSiteTotp(page, clickApi, secrets, missingSeed) {
  await button(page, 'Set up authenticator').click()
  const seed = await page.getByTestId('mfa-seed').textContent()
  assert(/^[A-Z2-7]{32}$/.test(seed), missingSeed)
  secrets.push(seed)
  const secret = readSeed(seed)
  const setupStep = Math.floor(Date.now() / 30_000)
  const setupCode = totp(secret, setupStep)
  secrets.push(setupCode)
  await page.getByLabel('Authenticator code', { exact: true }).fill(setupCode)
  assert.equal((await clickApi(page, WireRoutes.MfaSetupVerify, 'Enable verification')).status(), 200)
  await button(page, 'Hide recovery codes').click()
  return { secret, setupStep }
}

export async function completeSiteTotp(page, clickApi, secrets, secret, setupStep) {
  const code = totp(secret, Math.max(setupStep + 1, Math.floor(Date.now() / 30_000)))
  secrets.push(code)
  await page.getByLabel('Authenticator or recovery code', { exact: true }).fill(code)
  assertStatus(await clickApi(page, WireRoutes.MfaChallengeVerify, 'Verify and log in'), 200)
}

export function readSeed(seed) {
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

export function totp(secret, step) {
  const interval = Buffer.alloc(8)
  interval.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', secret).update(interval).digest()
  const offset = mac.at(-1) & 15
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}
