import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { publicationProofPath } from '../../src/Contracts/article-publication-proof.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { encodeSignIn, FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { verifyPublicationHead } from '../../tools/verify-publication-head.mjs'
import { verifyPublicationProof } from '../../tools/verify-publication-proof.mjs'
import { postFrame, readDraft, submitPublicationMutation } from './browser-authoring-fixture.mjs'
import { expect, launchIdentityBrowser, readTlsPublicationFixture, request } from './site-authentication-fixture.mjs'

const { origin, ticket, pins } = readTlsPublicationFixture(
  'Use the isolated publication proof HTTPS runner with a disposable site ticket and TLS leaf pins.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/publication-proof-browser')
await mkdir(evidence, { recursive: true })
const browser = await launchIdentityBrowser(pins)
const author = await request.newContext({ baseURL: origin })
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
const calls = []
const faults = []
const expectedHttp = []
const checks = {}
const keysPath = '/integrity/v2/keys.json'
const headPath = '/integrity/v2/log/head.json'
const checkHead = process.env.FSUSBLOG_TEST_PUBLICATION_HEAD === '1'
page.on('request', request => {
  const path = new URL(request.url()).pathname
  if (path.startsWith('/integrity/v2/')) calls.push(path)
})
page.on('pageerror', error => faults.push(error.message))
page.on('console', message => {
  if (message.type() !== 'error') return
  const source = URL.parse(message.location().url)
  const code = /^Failed to load resource: the server responded with a status of (\d+) /.exec(message.text())?.[1]
  if (source?.origin === origin &&
    ((code === '401' && source.pathname === WireRoutes.Session) ||
     (code === '404' && [WireRoutes.SiteRefreshStatus, '/favicon.ico'].includes(source.pathname)))) {
    expectedHttp.push({ path: source.pathname, status: Number(code) })
  } else {
    faults.push({ path: source?.pathname, message: message.text() })
  }
})

let failure
try {
  if (checkHead) {
    const response = await publicIntegrity(headPath)
    assert.equal(response.status, 404)
    await response.arrayBuffer()
    checks.anonymousEmptyHeadUnavailable = true
  }
  await post(WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
  const title = 'Original Évidence 🐈'
  const draft = await command(WireRoutes.Save, 0, 0n, title, 'Cafe\u0301\r\n\nProof browser fixture.\n')
  const first = await command(WireRoutes.Publish, draft.id, draft.revision)
  const firstProof = await currentProof(first.id)
  const articleUrl = `${origin}/article/${first.id}`
  const main = await page.goto(articleUrl)
  assert(main?.ok())
  const security = await main.securityDetails()
  assert(security?.protocol.startsWith('TLS') && await page.evaluate(() => window.isSecureContext))
  assert.equal(page.url(), articleUrl)
  await expect(page).toHaveTitle(/^Original Évidence 🐈 · /)
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(page.getByText('Proof browser fixture.', { exact: true })).toBeVisible()
  await readerHasNoProofUi()
  assert.deepEqual(calls, [])
  checks.tls = security.protocol
  checks.zeroProofRequestsOnLoad = true

  const manifest = JSON.parse(await publicJsonBytes(keysPath))
  const proof = JSON.parse(await publicJsonBytes(firstProof))
  assert.equal(proof.articleId, first.id)
  verifyPublicationProof(proof, manifest, origin)
  await page.screenshot({ path: join(evidence, 'publication-proof-desktop.png') })
  checks.signedCurrentPublicationVerified = true

  assert.throws(() => verifyPublicationProof({
    ...proof, signature: Buffer.alloc(64).toString('base64url'),
  }, manifest, origin), /Invalid native publication signature/)
  checks.tamperedSignatureRejected = true

  const compromised = structuredClone(manifest)
  const signingKey = compromised.keys.find(key => key.keyId === proof.keyId)
  assert(signingKey)
  signingKey.compromisedAtUtc = '2026-11-15T00:00:00.000000Z'
  assert.throws(() => verifyPublicationProof(proof, compromised, origin), /Native proof key is ineligible/)
  checks.freshCompromisedRegistryRejected = true
  const revoked = structuredClone(manifest)
  revoked.keys.find(key => key.keyId === proof.keyId).revokedAtUtc = proof.issuedAtUtc
  assert.throws(() => verifyPublicationProof(proof, revoked, origin), /Native proof key is ineligible/)
  checks.revokedAtIssuanceKeyRejected = true

  const nextTitle = 'Replacement Évidence 🌿'
  const changed = await command(WireRoutes.Save, first.id, first.revision, nextTitle, 'Replacement for the proof browser.')
  const updated = await command(WireRoutes.Publish, changed.id, changed.revision)
  const nextProof = await currentProof(updated.id)
  assert.notEqual(nextProof, firstProof)
  await unavailablePublicProof(firstProof)
  assert.equal((await author.get(firstProof)).status(), 404)
  checks.staleArticleReplacementDenied = true

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(articleUrl)
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible()
  await readerHasNoProofUi()
  verifyPublicationProof(JSON.parse(await publicJsonBytes(nextProof)),
    JSON.parse(await publicJsonBytes(keysPath)), origin)
  await page.screenshot({ path: join(evidence, 'publication-proof-mobile.png') })
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await readerHasNoProofUi()
  checks.mobileReaderHasNoProofUiOrRequests = true

  const publicHead = checkHead ? await verifyOpaqueHead(nextProof) : null
  await command(WireRoutes.Retract, updated.id, updated.revision)
  await unavailablePublicProof(nextProof)
  assert.equal((await author.get(nextProof)).status(), 404)
  checks.withdrawnPublicationReceiptDenied = true
  if (publicHead) {
    const withdrawn = await publicIntegrity(nextProof)
    assert.equal(withdrawn.status, 404)
    await withdrawn.arrayBuffer()
    const retained = await publicJsonBytes(headPath)
    assert.deepEqual(retained, publicHead)
    await writeFile(join(evidence, 'publication-head-after-withdrawal.json'), retained)
    checks.anonymousWithdrawnProofDeniedAndOpaqueHeadRetained = true
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(faults, [])
} catch (error) {
  failure = error
  await page.screenshot({ path: join(evidence, 'publication-proof-failure.png') }).catch(() => {})
} finally {
  await browser.close()
  await author.dispose()
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify({
    browser: browser.version(), checks, calls, expectedHttp, faults, failure: failure instanceof Error ? failure.message : undefined,
  }, null, 2) + '\n')
}
if (failure) throw failure

async function post(path, type, payload, output) {
  const response = await postFrame(author, path, type, payload)
  assert.equal(response.status(), 200, path)
  return decodeFrame(await response.body(), output).payload
}

async function command(path, id, expectedRevision, title = '', body = '') {
  return readDraft(await submitPublicationMutation(author, path, id, expectedRevision, title, body), path)
}

async function currentProof(id) {
  const detail = await author.get(WireRoutes.PublicArticle.replace('{id}', String(id)))
  assert.equal(detail.status(), 200)
  const article = decodeArticle(decodeFrame(await detail.body(), FrameType.ArticleDetail).payload)
  const path = publicationProofPath(article)
  await expect.poll(async () => {
    const response = await author.get(path)
    return response.status()
  }, { timeout: 12_000 }).toBe(200)
  return path
}

async function readerHasNoProofUi() {
  // Assert structure, not translated copy: neither locale should expose these controls.
  await expect(page.locator('.publication-proof, .article-rights')).toHaveCount(0)
  await expect(page.locator('a[href^="/integrity/v2/"]')).toHaveCount(0)
  assert.deepEqual(calls, [])
}

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
  const registry = await publicJsonBytes(keysPath)
  const proofBytes = await publicJsonBytes(proofPath)
  const manifest = JSON.parse(registry)
  const proof = JSON.parse(proofBytes)
  verifyPublicationProof(proof, manifest, origin)
  const headBytes = await publicJsonBytes(headPath)
  const head = JSON.parse(headBytes)
  const anchor = verifyPublicationHead(head, manifest, origin)
  assert.equal(anchor.sequence, '2')
  assert.notEqual(head.signature, proof.signature)
  await writeFile(join(evidence, 'publication-key-registry.json'), registry)
  await writeFile(join(evidence, 'publication-rights-before-withdrawal.json'), proofBytes)
  await writeFile(join(evidence, 'publication-head-before-withdrawal.json'), headBytes)
  checks.anonymousSignedOpaqueHeadVerified = anchor
  return headBytes
}
