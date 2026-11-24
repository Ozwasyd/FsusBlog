import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { publicationProofPath } from '../../src/Contracts/article-publication-proof.ts'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { verifyPublicationHead } from '../../tools/verify-publication-head.mjs'
import { verifyPublicationProof } from '../../tools/verify-publication-proof.mjs'
import { readDraft, submitPublicationMutation } from './browser-authoring-fixture.mjs'
import { saveShot, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import { assertStatus, fetchPublicArticle } from './response-status-fixture.mjs'
import { exactHeading, exactText } from './role-locators.mjs'
import { expect, launchIdentityBrowser, readTlsPublicationFixture, secureLoginProtocol } from './site-authentication-fixture.mjs'
import { signInFreshAdmin, signInFreshSite } from './webauthn-fixture.mjs'

const { origin, ticket, pins } = readTlsPublicationFixture(
  'Use the isolated publication proof HTTPS runner with a disposable site ticket and TLS leaf pins.', 'localhost')
const admin = new URL(process.env.FSUSBLOG_TEST_ADMIN_URL)
const bootstrap = process.env.FSUSBLOG_TEST_ADMIN_TICKET
assert(admin.protocol === 'https:' && admin.hostname === 'admin.localhost' && /^[a-f0-9]{64}$/.test(bootstrap ?? ''),
  'Use the isolated administrator origin and its fixture Passkey setup ticket.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/publication-proof-browser')
const browser = await launchIdentityBrowser(pins)
const calls = [], faults = [], expectedHttp = [], checks = {}
const keysPath = '/integrity/v2/keys.json', headPath = '/integrity/v2/log/head.json'
const checkHead = process.env.FSUSBLOG_TEST_PUBLICATION_HEAD === '1'
const writeRaw = (file, data) => writeFile(join(evidence, file), data)
let page

await withBrowserEvidence(browser, evidence, 'browser-result.json', failure => ({
  browser: browser.version(), checks, calls, expectedHttp, faults, failure: failure instanceof Error ? failure.message : undefined,
}), async () => {
  const author = await browser.newContext(), reader = await browser.newContext()
  page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
  page.on('request', req => { const path = new URL(req.url()).pathname; if (path.startsWith('/integrity/v2/')) calls.push(path) })
  page.on('pageerror', error => faults.push(error.message))
  page.on('console', message => {
    if (message.type() !== 'error') return
    const source = URL.parse(message.location().url)
    const code = /^Failed to load resource: the server responded with a status of (\d+) /.exec(message.text())?.[1]
    if (source?.origin === origin && ((code === '401' && [WireRoutes.Session, WireRoutes.SiteRefreshStatus].includes(source.pathname)) ||
      (code === '404' && [WireRoutes.SiteRefreshStatus, '/favicon.ico'].includes(source.pathname)))) {
      expectedHttp.push({ path: source.pathname, status: Number(code) })
    } else faults.push({ path: source?.pathname, message: message.text() })
  })

  const command = async (path, id, expectedRevision, title = '', body = '') =>
    readDraft(await submitPublicationMutation(author.request, admin.origin + path, id, expectedRevision, title, body), path)

  async function currentProof(id) {
    const path = publicationProofPath(await fetchPublicArticle(reader.request, origin, id))
    await expect.poll(async () => (await reader.request.get(origin + path)).status(), { timeout: 12_000 }).toBe(200)
    return path
  }

  async function readerHasNoProofUi() {
    // Assert structure, not translated copy: neither locale should expose these controls.
    await expect(page.locator('.publication-proof, .article-rights')).toHaveCount(0)
    await expect(page.locator('a[href^="/integrity/v2/"]')).toHaveCount(0)
    assert.deepEqual(calls, [])
  }

  if (checkHead) {
    await unavailablePublicProof(headPath)
    checks.anonymousEmptyHeadUnavailable = true
  }
  await signInFreshAdmin(await author.newPage(), admin.origin, bootstrap)
  await signInFreshSite(await reader.newPage(), origin, ticket)
  assertStatus(await reader.request.get(origin + WireRoutes.Session), 200)
  const title = 'Original Évidence 🐈'
  const draft = await command(WireRoutes.Save, 0, 0n, title, 'Cafe\u0301\r\n\nProof browser fixture.\n')
  const first = await command(WireRoutes.Publish, draft.id, draft.revision)
  const firstProof = await currentProof(first.id)
  const articleUrl = `${origin}/article/${first.id}`
  const main = await page.goto(articleUrl)
  assert(main?.ok())
  checks.tls = await secureLoginProtocol(page, main)
  assert.equal(page.url(), articleUrl)
  await expect(page).toHaveTitle(/^Original Évidence 🐈 · /)
  await expect(exactHeading(page, title)).toBeVisible()
  await expect(exactText(page, 'Proof browser fixture.')).toBeVisible()
  await readerHasNoProofUi()
  assert.deepEqual(calls, [])
  checks.zeroProofRequestsOnLoad = true

  const manifest = JSON.parse(await publicJsonBytes(keysPath))
  const proof = JSON.parse(await publicJsonBytes(firstProof))
  assert.equal(proof.articleId, first.id)
  verifyPublicationProof(proof, manifest, origin)
  await saveShot(page, evidence, 'publication-proof-desktop.png', {})
  checks.signedCurrentPublicationVerified = true

  assert.throws(() => verifyPublicationProof({ ...proof, signature: Buffer.alloc(64).toString('base64url') }, manifest, origin),
    /Invalid native publication signature/)
  checks.tamperedSignatureRejected = true

  const assertIneligibleKey = (field, value) => {
    const mutated = structuredClone(manifest)
    const signingKey = mutated.keys.find(key => key.keyId === proof.keyId)
    assert(signingKey)
    signingKey[field] = value
    assert.throws(() => verifyPublicationProof(proof, mutated, origin), /Native proof key is ineligible/)
  }
  assertIneligibleKey('compromisedAtUtc', '2026-11-15T00:00:00.000000Z')
  checks.freshCompromisedRegistryRejected = true
  assertIneligibleKey('revokedAtUtc', proof.issuedAtUtc)
  checks.revokedAtIssuanceKeyRejected = true

  const nextTitle = 'Replacement Évidence 🌿'
  const changed = await command(WireRoutes.Save, first.id, first.revision, nextTitle, 'Replacement for the proof browser.')
  const updated = await command(WireRoutes.Publish, changed.id, changed.revision)
  const nextProof = await currentProof(updated.id)
  assert.notEqual(nextProof, firstProof)
  await unavailablePublicProof(firstProof)
  assertStatus(await reader.request.get(origin + firstProof), 404)
  checks.staleArticleReplacementDenied = true

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(articleUrl)
  await expect(exactHeading(page, nextTitle)).toBeVisible()
  await readerHasNoProofUi()
  verifyPublicationProof(JSON.parse(await publicJsonBytes(nextProof)), JSON.parse(await publicJsonBytes(keysPath)), origin)
  await saveShot(page, evidence, 'publication-proof-mobile.png', {})
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await readerHasNoProofUi()
  checks.mobileReaderHasNoProofUiOrRequests = true

  const publicHead = checkHead ? await verifyOpaqueHead(nextProof) : null
  await command(WireRoutes.Retract, updated.id, updated.revision)
  await unavailablePublicProof(nextProof)
  assertStatus(await reader.request.get(origin + nextProof), 404)
  checks.withdrawnPublicationReceiptDenied = true
  if (publicHead) {
    await unavailablePublicProof(nextProof)
    const retained = await publicJsonBytes(headPath)
    assert.deepEqual(retained, publicHead)
    await writeRaw('publication-head-after-withdrawal.json', retained)
    checks.anonymousWithdrawnProofDeniedAndOpaqueHeadRetained = true
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(faults, [])
}, {
  mkdir: true, newline: true,
  onError: () => page && saveShot(page, evidence, 'publication-proof-failure.png', {}).catch(() => {}),
})

async function unavailablePublicProof(path) {
  const response = await publicIntegrity(path)
  assert.equal(response.status, 404)
  await response.arrayBuffer()
}

async function publicIntegrity(path) {
  // The runner supplies the fixture CA to Node. These requests have no author cookie jar.
  const response = await fetch(new URL(path, origin), {
    credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
  })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('set-cookie'), null)
  return response
}

async function publicJsonBytes(path) {
  const response = await publicIntegrity(path)
  assert.equal(response.status, 200, path)
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/)
  return Buffer.from(await response.arrayBuffer())
}

async function verifyOpaqueHead(proofPath) {
  const registry = await publicJsonBytes(keysPath), proofBytes = await publicJsonBytes(proofPath)
  const manifest = JSON.parse(registry), proof = JSON.parse(proofBytes)
  verifyPublicationProof(proof, manifest, origin)
  const headBytes = await publicJsonBytes(headPath), head = JSON.parse(headBytes)
  const anchor = verifyPublicationHead(head, manifest, origin)
  assert.equal(anchor.sequence, '2')
  assert.notEqual(head.signature, proof.signature)
  await writeRaw('publication-key-registry.json', registry)
  await writeRaw('publication-rights-before-withdrawal.json', proofBytes)
  await writeRaw('publication-head-before-withdrawal.json', headBytes)
  checks.anonymousSignedOpaqueHeadVerified = anchor
  return headBytes
}
