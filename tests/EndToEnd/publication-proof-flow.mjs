import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { publicationProofPath } from '../../src/Contracts/article-publication-proof.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium, expect, request } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
const origin = url.origin
const ticket = process.env.FSUSBLOG_TEST_SITE_TICKET
const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
assert(url.hostname === '127.0.0.1' && url.protocol === 'https:' && /^[0-9a-f]{64}$/.test(ticket ?? '') &&
  /^[A-Za-z0-9+/]{43}=,[A-Za-z0-9+/]{43}=$/.test(pins ?? ''),
'Use the isolated publication proof HTTPS runner with a disposable site ticket and TLS leaf pins.')
const evidence = resolve(process.env.FSUSBLOG_TEST_EVIDENCE ?? 'artifacts/publication-proof-browser')
await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.FSUSBLOG_TEST_CHROME, headless: true,
  args: [`--ignore-certificate-errors-spki-list=${pins}`],
})
const author = await request.newContext({ baseURL: origin })
const page = await browser.newPage({ viewport: { width: 1280, height: 840 } })
const section = page.getByRole('region', { name: 'Publication verification' })
const verify = section.getByRole('button', { name: 'Verify publication' })
const status = section.getByRole('status')
const receipt = section.getByRole('link', { name: 'Signed receipt (JSON)' })
const calls = []
const faults = []
const expectedHttp = []
const absentReceipts = new Set()
const checks = {}
const keysPath = '/integrity/v2/keys.json'
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
     (code === '404' && [WireRoutes.SiteRefreshStatus, '/favicon.ico'].includes(source.pathname)) ||
     (code === '404' && absentReceipts.has(source.pathname)))) {
    expectedHttp.push({ path: source.pathname, status: Number(code) })
  } else {
    faults.push({ path: source?.pathname, message: message.text() })
  }
})

let failure
try {
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
  await expect(verify).toBeVisible()
  assert.deepEqual(calls, [])
  checks.tls = security.protocol
  checks.zeroProofRequestsOnLoad = true

  await verifies(firstProof)
  assert.deepEqual(calls, [firstProof, keysPath, firstProof])
  await section.screenshot({ path: join(evidence, 'publication-proof-desktop.png') })
  const [receiptPage] = await Promise.all([page.context().waitForEvent('page'), receipt.click()])
  await receiptPage.waitForLoadState()
  assert.equal(receiptPage.url(), origin + firstProof)
  await expect(receiptPage.locator('body')).toContainText(/"proofVersion"\s*:\s*2/)
  await receiptPage.close()
  checks.signedCurrentPublicationVerified = true

  await page.route(origin + firstProof, async route => {
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    await route.fulfill({ response, json: { ...await response.json(), signature: Buffer.alloc(64).toString('base64url') } })
  })
  await verify.click()
  await expect(status).toHaveText('The publication signature could not be verified.')
  await expect(receipt).toHaveCount(0)
  await page.unroute(origin + firstProof)
  checks.tamperedSignatureRejected = true

  await page.route(origin + keysPath, async route => {
    const response = await route.fetch()
    assert.equal(response.status(), 200)
    const keys = await response.json()
    keys.keys[0].compromisedAtUtc = '2026-11-15T00:00:00.000000Z'
    await route.fulfill({ response, json: keys })
  })
  await verify.click()
  await expect(status).toHaveText('The publication signature could not be verified.')
  await expect(receipt).toHaveCount(0)
  await page.unroute(origin + keysPath)
  checks.freshCompromisedRegistryRejected = true

  const nextTitle = 'Replacement Évidence 🌿'
  const changed = await command(WireRoutes.Save, first.id, first.revision, nextTitle, 'Replacement for the proof browser.')
  const updated = await command(WireRoutes.Publish, changed.id, changed.revision)
  const nextProof = await currentProof(updated.id)
  assert.notEqual(nextProof, firstProof)
  absentReceipts.add(firstProof)
  await verify.click()
  await expect(status).toContainText('Proof unavailable for this publication.')
  await expect(receipt).toHaveCount(0)
  assert.equal((await author.get(firstProof)).status(), 404)
  checks.staleArticleReplacementDenied = true

  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto(articleUrl)
  await expect(page.getByRole('heading', { name: nextTitle, exact: true })).toBeVisible()
  await page.clock.install()
  await verifies(nextProof)
  await section.screenshot({ path: join(evidence, 'publication-proof-mobile.png') })
  await receipt.focus()
  await page.clock.fastForward(30_001)
  await expect(verify).toBeFocused()
  await expect(status).toContainText('Verify again')
  await expect(receipt).toHaveCount(0)
  await verifies(nextProof)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(status).toContainText('Verify again')
  await expect(receipt).toHaveCount(0)
  checks.mobileExpiryAndVisibilityCleared = true

  await command(WireRoutes.Retract, updated.id, updated.revision)
  absentReceipts.add(nextProof)
  await verify.click()
  await expect(status).toContainText('Proof unavailable for this publication.')
  await expect(receipt).toHaveCount(0)
  assert.equal((await author.get(nextProof)).status(), 404)
  checks.withdrawnPublicationReceiptDenied = true
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

async function post(path, type, payload, output, headers = {}) {
  const response = await author.post(path, {
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    data: Buffer.from(encodeFrame(type, payload)),
  })
  assert.equal(response.status(), 200, path)
  return decodeFrame(await response.body(), output).payload
}

async function command(path, id, expectedRevision, title = '', body = '') {
  const idempotencyKey = randomUUID()
  return decodeDraft(await post(path, FrameType.ArticleCommand,
    encodeArticleCommand({ id, expectedRevision, idempotencyKey, title, body }), FrameType.Draft,
    { [WireHeaders.ClientMutationId]: idempotencyKey }))
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

async function verifies(path) {
  await verify.click()
  await expect(status).toContainText('Publication signature verified at')
  await expect(receipt).toHaveAttribute('href', path)
}
