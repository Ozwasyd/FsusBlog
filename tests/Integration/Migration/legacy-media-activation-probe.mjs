import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { api } from '../../../src/Contracts/client.ts'
import { articleMedia, privateArticlePreview } from '../../../src/Contracts/article-media.ts'
import { WireRoutes } from '../../../src/Contracts/wire.generated.ts'

const [base, asset, ownerFile, outsiderFile, normalized] = process.argv.slice(2)
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
async function readImage(path, headers = {}) {
  const response = await fetch(path, { headers })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.equal(response.headers.get('cache-control'), 'private,no-store')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
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
await signIn(outsiderFile)
await hidden(raw)
await hidden(WireRoutes.ArticleMediaPreview, previewHeader)
cookie = undefined
await hidden(raw)
await hidden(WireRoutes.ArticleMediaPreview, previewHeader)
const publicPage = await fetch('/article/42')
assert.equal(publicPage.status, 200)
const html = await publicPage.text()
assert(/published (?:☃|&#9731;|&#x2603;)/i.test(html) && !html.includes('Private edit') && !html.includes(asset))
console.log(JSON.stringify({ restoredOwnerReads: 2, rejectedPrivateReads: 6, retainedPublicRevision: 2,
  bytes: bytes.length, contentSha256: createHash('sha256').update(bytes).digest('hex') }))
