import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { FrameType, WireHeaders, WireLayouts as L, WireLimits as Limit, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const argv = process.argv.slice(2)
assert.equal(argv.length, 3, 'Usage: nightly-wide-search-probe.mjs ORIGIN ORACLE_JSON EVIDENCE_DIR')
const [origin, oraclePath, evidence] = argv
const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
const chrome = process.env.FSUSBLOG_TEST_CHROME
assert.match(origin, /^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
assert.equal(new URL(origin).origin, origin)
assert(chrome && /^[A-Za-z0-9+/]{43}=$/.test(pins ?? '') && process.env.NODE_EXTRA_CA_CERTS,
  'Use the fixture Chromium, certificate authority, and public TLS leaf pin')

const cacheName = 'fsusblog-v2-wide-search-v1'
const pagePath = WireRoutes.PublicSearchWidePage.replace('{page}', '')
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const digestHeader = WireHeaders.SearchCorpusDigest.toLowerCase()
const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase()
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const hex = /^[0-9a-f]{64}$/
const documents = 85_000
const pages = documents / Limit.SearchIndexPageSize
const budgetMs = 180_000

const info = await lstat(oraclePath)
assert(info.isFile() && info.size > 0 && info.size <= 64 * 1024, 'Expected a bounded independent SQL oracle')
const oracleBytes = await readFile(oraclePath)
assert.equal(info.size, oracleBytes.length)
const oracle = JSON.parse(oracleBytes)
assert.deepEqual([oracle.version, oracle.profile, oracle.documentCount], [1, 'nightly', documents])
assert.match(oracle.fixtureSha256, hex)
assert.match(oracle.readbackSha256, hex)
assert.deepEqual(
  [oracle.bodyCanary.term, oracle.bodyCanary.id, oracle.bodyCanary.revision, oracle.bodyCanary.publication],
  ['c11body090000', 90_000, '3', '85000'])
assert.match(oracle.bodyCanary.bodySha256, hex)
assert.deepEqual([oracle.broad.term, oracle.broad.page, oracle.broad.size, oracle.broad.items.length],
  ['observations', 8500, 10, 10])
assert.equal(new Set(oracle.broad.items.map(row => row.id)).size, oracle.broad.size)
for (const row of [oracle.bodyCanary, ...oracle.broad.items]) {
  assert(Number.isInteger(row.id) && (row.id >= 1 && row.id <= 80_000 || row.id >= 85_001 && row.id <= 90_000))
  assert(typeof row.title === 'string' && row.title.includes(' observations ') && row.summary?.length === 200)
}

const { chromium, request } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const witness = {
  origin, oracleSha256: sha256(oracleBytes), fixtureSha256: oracle.fixtureSha256, readbackSha256: oracle.readbackSha256,
}
const api = await request.newContext({ baseURL: origin, timeout: 15_000 })
let browser
let closing
let disposing
const interrupted = new AbortController()
const closeBrowser = () => closing ??= browser?.close()
const disposeApi = () => disposing ??= api.dispose()
function stop(signal) {
  interrupted.abort(new Error(`Nightly wide browser probe received ${signal}`))
  void closeBrowser()?.catch(() => {})
  void disposeApi().catch(() => {})
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
const requests = []
const responses = []
function collect() {
  return { requests: requests.splice(0), responses: responses.splice(0) }
}

try {
  const manifest = await readManifest()
  witness.manifest = manifest
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: [`--ignore-certificate-errors-spki-list=${pins}`] })
  interrupted.signal.throwIfAborted()
  witness.chromium = browser.version()
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 375, height: 850 }, serviceWorkers: 'block' })
  context.on('request', request => {
    const entry = observeCall(request)
    if (entry) requests.push(entry)
  })
  context.on('response', response => {
    const entry = observeCall(response.request())
    if (!entry) return
    const headers = response.headers()
    responses.push({ ...entry, status: response.status(), generation: headers[generationHeader] ?? null,
      digest: headers[digestHeader] ?? null, pages: Number(headers[pagesHeader] ?? 0),
      length: Number(headers['content-length'] ?? 0), cache: headers['cache-control'] ?? null, etag: headers.etag ?? null })
  })
  const page = await context.newPage()
  const coldStart = performance.now()
  assert.equal(await page.goto(searchPath(oracle.bodyCanary.term)).then(response => response.status()), 200)
  const bodyCards = await readCards(page, [oracle.bodyCanary])
  witness.cold = { routeAndVisibleMs: elapsed(coldStart), items: bodyCards, ...collect() }
  assertBatch(witness.cold, manifest, true)
  witness.storage = await inspectStorage(page, manifest)
  witness.bodyDetails = await verifyBodyDetail(api, oracle.bodyCanary, manifest)

  const broadStart = performance.now()
  assert.equal(await page.goto(searchPath(oracle.broad.term, oracle.broad.page)).then(response => response.status()), 200)
  const deepCards = await readCards(page, oracle.broad.items)
  assert.equal(await page.locator('html').getAttribute('lang'), 'en')
  const nav = page.getByRole('navigation', { name: 'Search result pages' })
  assert.equal(await nav.locator('span[aria-current="page"]').textContent(), `Page ${oracle.broad.page}`)
  assert.equal(await nav.getByRole('link', { name: 'Previous', exact: true }).count(), 1)
  assert.equal(await nav.getByRole('link', { name: 'Next', exact: true }).count(), 0)
  witness.warm = { routeAndVisibleMs: elapsed(broadStart), page: oracle.broad.page, items: deepCards, ...collect() }
  assertBatch(witness.warm, manifest, false)
  const warmStorage = await inspectStorage(page, manifest)
  assert.equal(warmStorage.owner, witness.storage.owner, 'An independent Worker reused the same sealed IndexedDB generation')
  witness.warmStorage = warmStorage
  assert(!requests.some(call => call.kind === 'raw'), 'Expected no deferred warm corpus download')
  interrupted.signal.throwIfAborted()
} finally {
  witness.remaining = collect()
  try {
    await Promise.all([closeBrowser(), disposeApi()])
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await writeFile(join(evidence, 'wide-browser.json'), JSON.stringify(witness, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
}

function elapsed(start) {
  return Math.round((performance.now() - start) * 1000) / 1000
}

function searchPath(term, page = 1) {
  return `${origin}/search?${new URLSearchParams({ q: term, page: String(page) })}`
}

async function readCards(page, expected) {
  const cards = page.locator('ol.article-list > li > article')
  await cards.first().locator('h2 a').or(page.getByRole('alert')).first().waitFor({ timeout: budgetMs })
  const rows = await cards.evaluateAll(nodes => nodes.map(card => {
    const link = card.querySelector('h2 a')
    return { path: new URL(link.href).pathname, title: link.textContent, summary: card.querySelector('p').textContent }
  }))
  assert.deepEqual(rows, expected.map(row => ({ path: `/article/${row.id}`, title: row.title, summary: row.summary })))
  return rows
}

function observeCall(request) {
  const url = new URL(request.url())
  if (url.origin !== origin) return undefined
  const kind = url.pathname === WireRoutes.PublicSearchWideManifest ? 'manifest' :
    url.pathname === WireRoutes.PublicSearchCorpus ? 'compact' : url.pathname.startsWith(pagePath) ? 'raw' : undefined
  if (!kind) return undefined
  return { kind, method: request.method(), ordinal: kind === 'raw' ? url.pathname.slice(pagePath.length) : null,
    query: [...url.searchParams.keys()].sort(), requestedGeneration: url.searchParams.get('generation'),
    requestedDigest: url.searchParams.get('digest') }
}

function assertBatch(batch, manifest, cold) {
  assert.equal(batch.responses.filter(call => call.kind === 'compact' && call.status === 503).length, 1)
  const discovery = batch.responses.filter(call => call.kind === 'manifest' && call.method === 'GET')
  assert.equal(discovery.length, 1)
  assert.deepEqual(discovery[0].query, [])
  assert.equal(discovery[0].status, 200)
  const heads = batch.responses.filter(call => call.kind === 'manifest' && call.method === 'HEAD')
  assert.equal(heads.length, cold ? 3 : 2)
  const responses = batch.responses.filter(call => call.kind === 'raw')
  const requests = batch.requests.filter(call => call.kind === 'raw')
  const wanted = cold ? manifest.parts.map(part => String(part.number)) : []
  assert.deepEqual(requests.map(call => call.ordinal), wanted)
  assert.deepEqual(responses.map(call => call.ordinal), wanted)
  for (const call of [...heads, ...requests]) {
    assert.deepEqual(call.query, ['digest', 'generation'])
    assert.equal(call.requestedGeneration, manifest.generation)
    assert.equal(call.requestedDigest, manifest.digest)
    assert.equal(call.method, call.kind === 'raw' ? 'GET' : 'HEAD')
  }
  for (const call of [...discovery, ...heads, ...responses]) {
    assert.equal(call.generation, manifest.generation)
    assert.equal(call.digest, manifest.digest)
    assert.equal(call.pages, pages)
    assert.equal(call.cache, 'no-store')
    assert.equal(call.status, call.method === 'HEAD' ? 204 : 200)
  }
  for (const [index, call] of responses.entries()) {
    assert.equal(call.length, manifest.parts[index].length)
    assert.equal(call.etag, `"${manifest.parts[index].sha256}"`)
  }
  batch.rawBytes = responses.reduce((sum, call) => sum + call.length, 0)
  assert.equal(batch.rawBytes, cold ? manifest.bytes : 0)
}

async function readManifest() {
  const deadline = performance.now() + budgetMs
  while (performance.now() < deadline) {
    const response = await api.get(WireRoutes.PublicSearchWideManifest, { maxRedirects: 0 })
    try {
      if (response.status() !== 503) {
        assert.equal(response.status(), 200)
        const raw = await response.body()
        const { payload } = decodeFrame(raw, FrameType.PublicSearchWideManifest)
        const bytes = Buffer.from(payload)
        assert.equal(bytes.length, L.SearchWideManifestHeaderSize + pages * L.SearchWideManifestPageRecordSize)
        assert.equal(bytes.readInt32LE(0), L.SearchWideManifestVersion)
        const generation = String(bytes.readBigInt64LE(4))
        assert.match(generation, /^(0|[1-9][0-9]{0,18})$/)
        assert.equal(bytes.readInt32LE(12), documents)
        assert.equal(bytes.readInt32LE(16), pages)
        const total = Number(bytes.readBigInt64LE(20))
        assert(total > Limit.SearchCorpusTotalBytes && total <= Limit.SearchWideCorpusTotalBytes)
        const digest = bytes.subarray(28, L.SearchWideManifestHeaderSize).toString('hex')
        assert.equal(digest, createHash('sha256').update('public-search-fspk-manifest-v1\0', 'ascii')
          .update(bytes.subarray(12, 28)).update(bytes.subarray(L.SearchWideManifestHeaderSize)).digest('hex'))
        const headers = response.headers()
        assert.deepEqual([headers[generationHeader], headers[digestHeader], headers[pagesHeader], headers['cache-control']],
          [generation, digest, String(pages), 'no-store'])
        let offset = 0
        const idAt = ordinal => ordinal <= 80_000 ? ordinal : ordinal + 5_000
        const parts = Array.from({ length: pages }, (_, i) => {
          const row = L.SearchWideManifestHeaderSize + i * L.SearchWideManifestPageRecordSize
          const length = bytes.readInt32LE(row + 24)
          const descriptor = { number: bytes.readInt32LE(row), count: bytes.readInt32LE(row + 4),
            first: bytes.readInt32LE(row + 8), last: bytes.readInt32LE(row + 12), offset: Number(bytes.readBigInt64LE(row + 16)),
            length, sha256: bytes.subarray(row + 28, row + L.SearchWideManifestPageRecordSize).toString('hex') }
          assert.deepEqual([descriptor.number, descriptor.count, descriptor.first, descriptor.last, descriptor.offset],
            [i + 1, 200, idAt(i * 200 + 1), idAt((i + 1) * 200), offset])
          assert(length > 0 && length <= Limit.SearchCorpusPageBytes)
          offset += length
          return descriptor
        })
        assert.equal(offset, total)
        await writeFile(join(evidence, 'wide-manifest.aeds'), raw, { flag: 'wx', mode: 0o600 })
        return { generation, digest, bytes: total, parts }
      }
    } finally {
      await response.dispose()
    }
    await delay(250)
  }
  assert.fail('The server did not seal the full nightly corpus within the readiness budget')
}

async function inspectStorage(page, manifest) {
  const quota = await page.evaluate(() => navigator.storage.estimate())
  const sealed = await page.evaluate(name => new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => open.transaction.abort()
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(['metadata', 'pages'], 'readonly')
      const metadata = tx.objectStore('metadata').get('corpus')
      const count = tx.objectStore('pages').count()
      tx.onabort = () => { db.close(); reject(tx.error) }
      tx.oncomplete = () => { db.close(); resolve({ ...metadata.result, storedPages: count.result }) }
    }
  }), cacheName)
  const { owner, ...state } = sealed
  assert.match(owner, /^[0-9a-f-]{36}$/)
  assert.deepEqual(state, {
    generation: manifest.generation, digest: manifest.digest, status: 'sealed', pageCount: pages, writtenPages: pages,
    byteCount: manifest.bytes, writtenBytes: manifest.bytes, storedPages: pages,
  })
  return { owner, ...state, originStorageEstimate: quota }
}

async function verifyBodyDetail(api, expected, manifest) {
  const response = await api.get(WireRoutes.PublicArticle.replace('{id}', String(expected.id)), { maxRedirects: 0 })
  try {
    assert.equal(response.status(), 200)
    assert.equal(response.headers()[generationHeader], manifest.generation)
    const raw = await response.body()
    const { payload } = decodeFrame(raw, FrameType.ArticleDetail)
    const row = decodeArticle(payload)
    const actual = { id: row.id, revision: String(row.revision), publication: String(row.publication),
      title: row.title, summary: row.summary, bodySha256: sha256(row.body) }
    const { term, ...coordinates } = expected
    assert.deepEqual(actual, coordinates)
    assert(row.body.includes(term) && !row.title.includes(term) && !row.summary.includes(term))
    await writeFile(join(evidence, 'final-article.aeds'), raw, { flag: 'wx', mode: 0o600 })
    return actual
  } finally {
    await response.dispose()
  }
}
