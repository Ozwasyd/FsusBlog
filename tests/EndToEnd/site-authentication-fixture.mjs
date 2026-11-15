import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { decodeFrame, decodeSuccess } from '../../src/Contracts/aeds.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect, request } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
export { expect, request }

export function readTlsIdentityFixture(peerTicket, probe, error) {
  const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
  const ownerTicket = process.env.FSUSBLOG_TEST_SITE_TICKET
  const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
  assert(url.hostname === 'localhost' && url.protocol === 'https:' && ownerTicket && peerTicket &&
    ownerTicket !== peerTicket && probe && /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins), error)
  return { origin: url.origin, ownerTicket, pins }
}

export function launchIdentityBrowser(pins) {
  return chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
    args: pins ? [`--ignore-certificate-errors-spki-list=${pins}`] : undefined })
}

export function addAuthenticator(cdp) {
  return cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } })
}

export async function enableAuthenticator(context, page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await addAuthenticator(cdp)
  return { cdp, authenticatorId }
}

export function button(page, name) {
  return page.getByRole('button', { name, exact: true })
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
  assert.equal(reply.status(), 200)
  const headers = 'allHeaders' in reply ? await reply.allHeaders() : reply.headers()
  assert(headers['cache-control']?.includes('no-store'), cacheError)
  decodeSuccess(decodeFrame(await reply.body(), FrameType.EmptySuccess).payload)
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
