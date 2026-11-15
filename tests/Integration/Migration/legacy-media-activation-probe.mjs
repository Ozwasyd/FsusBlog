import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { api } from '../../../src/Contracts/client.ts'
import { articleMedia, privateArticlePreview } from '../../../src/Contracts/article-media.ts'
import { WireRoutes } from '../../../src/Contracts/wire.generated.ts'

const [base, asset, ownerFile, outsiderFile, normalized, historical, secondCurrent, historicalFile, secondCurrentFile] = process.argv.slice(2)
const url = new URL(base)
assert.equal(url.hostname, '127.0.0.1')
assert.equal(url.protocol, 'http:')
assert.match(asset, /^[0-9a-f-]{36}$/)
const bytes = await readFile(normalized)
const native = globalThis.fetch
let cookie

globalThis.fetch = async (path, options) => {
  const headers = new Headers(options?.headers)
  if (cookie) headers.set('Cookie', cookie)
  const response = await native(new URL(path, url), { ...options, headers, redirect: 'error' })
  const minted = response.headers.get('set-cookie')?.match(/\bfsus-v2-session=[a-f0-9]{64}\b/)?.[0]
  if (minted) cookie = minted
  return response
}

async function signIn(file) {
  cookie = undefined
  const session = await api.signIn((await readFile(file, 'utf8')).trim())
  assert(cookie && session.canAuthor && session.siteSessionId)
  return session.siteSessionId
}

const raw = WireRoutes.PrivateMediaRead.replace('{id}', asset)
async function readImage(path, headers = {}, expected = bytes, contentType = 'image/png') {
  const response = await fetch(path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), contentType)
  assert.equal(response.headers.get('cache-control'), 'private,no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
}
async function hidden(path, headers = {}) {
  const response = await fetch(path, { headers })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('cache-control'), 'private,no-store')
  assert.equal((await response.arrayBuffer()).byteLength, 0)
}

const current = await signIn(ownerFile)
await readImage(raw)
const listing = await articleMedia(42, 3n, current)
assert.equal(listing.entries.length, 1)
assert.equal(listing.entries[0].id, asset)
assert.deepEqual(Buffer.from(await (await privateArticlePreview(listing.entries[0].ticket)).arrayBuffer()), bytes)
const previewHeader = { Authorization: `Bearer ${listing.entries[0].ticket}` }
await hidden(raw, { Range: 'bytes=0-0' })
await hidden(WireRoutes.ArticleMediaPreview)
const rawFor = id => WireRoutes.PrivateMediaRead.replace('{id}', id)
if (historical) {
  await hidden(rawFor(historical))
  await hidden(rawFor(secondCurrent))
}
const secondSession = await signIn(outsiderFile)
if (historical) {
  await readImage(rawFor(historical), {}, await readFile(historicalFile))
  const secondBytes = await readFile(secondCurrentFile)
  await readImage(rawFor(secondCurrent), {}, secondBytes, 'image/jpeg')
  const second = await articleMedia(43, 2n, secondSession)
  assert.deepEqual(second.entries.map(entry => entry.id), [secondCurrent])
  const secondPreview = await privateArticlePreview(second.entries[0].ticket)
  assert.equal(secondPreview.type, 'image/jpeg')
  assert.deepEqual(Buffer.from(await secondPreview.arrayBuffer()), secondBytes)
  const stale = WireRoutes.ArticleMedia.replace('{id:int}', '43') + '?revision=1'
  const rejected = await fetch(stale)
  assert.equal(rejected.status, 409)
  await rejected.body?.cancel()
  const draft = await fetch('/article/43')
  assert.equal(draft.status, 404)
  await draft.body?.cancel()
}
await hidden(raw)
await hidden(WireRoutes.ArticleMediaPreview, previewHeader)
cookie = undefined
await hidden(raw)
await hidden(WireRoutes.ArticleMediaPreview, previewHeader)
const publicPage = await fetch('/article/42')
assert.equal(publicPage.status, 200)
const html = await publicPage.text()
assert(/published (?:☃|&#9731;|&#x2603;)/i.test(html) && !html.includes('Private edit') && !html.includes(asset))
console.log(JSON.stringify({ restoredOwnerReads: historical ? 5 : 2, rejectedPrivateReads: historical ? 8 : 6,
  historicalPreviewRejected: Boolean(historical), jpegRestored: Boolean(historical), retainedPublicRevision: 2,
  bytes: bytes.length, contentSha256: createHash('sha256').update(bytes).digest('hex') }))
