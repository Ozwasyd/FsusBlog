import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticle } from '../../src/Contracts/public-articles.ts'
import { LOCAL_SEARCH_PROFILE } from '../../src/Contracts/local-search.ts'
import { FrameType, WireLayouts as L, WireLimits as Limit, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { HEADERS, HEX64, parseLoopbackOrigin, readBoundedJson, sha256, writePrivate } from './nightly-owned-evidence.mjs'

const argv = process.argv.slice(2)
assert.equal(argv.length, 3, 'Usage: nightly-wide-search-probe.mjs ORIGIN ORACLE_JSON EVIDENCE_DIR')
const [origin, oraclePath, evidence] = argv
const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
const chrome = process.env.FSUSBLOG_TEST_CHROME
parseLoopbackOrigin(origin, 'https', 1)
assert(chrome && /^[A-Za-z0-9+/]{43}=$/.test(pins ?? '') && process.env.NODE_EXTRA_CA_CERTS,
  'Use the fixture Chromium, certificate authority, and public TLS leaf pin')

const cacheName = 'fsusblog-v2-wide-search-v1'
const pagePath = WireRoutes.PublicSearchWidePage.replace('{page}', '')
const documents = 85_000
const pages = documents / Limit.SearchIndexPageSize
const budgetMs = 180_000

const { bytes: oracleBytes, data: oracle } = readBoundedJson(oraclePath, 64 * 1024, 'Expected a bounded independent SQL oracle')
assert.deepEqual(
  [oracle.version, oracle.profile, oracle.rankProfile, oracle.documentCount, oracle.bodyCanary.term, oracle.bodyCanary.id,
    oracle.bodyCanary.revision, oracle.bodyCanary.publication, oracle.broad.term, oracle.broad.page,
    oracle.broad.size, oracle.broad.items.length, new Set(oracle.broad.items.map(r => r.id)).size],
  [2, 'nightly', LOCAL_SEARCH_PROFILE, documents,
    'c11body090000', 90_000, '3', '85000', 'observations', 8500, 10, 10, 10])
for (const hash of [oracle.fixtureSha256, oracle.readbackSha256, oracle.bodyCanary.bodySha256]) assert.match(hash, HEX64)
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
    responses.push({ ...entry, status: response.status(), generation: headers[HEADERS.generation] ?? null,
      digest: headers[HEADERS.digest] ?? null, pages: Number(headers[HEADERS.pages] ?? 0),
      length: Number(headers['content-length'] ?? 0), cache: headers['cache-control'] ?? null, etag: headers.etag ?? null })
  })
  const page = await context.newPage()
  const coldStart = performance.now()
  assert.equal(await page.goto(searchPath(oracle.bodyCanary.term)).then(response => response.status()), 200)
  const bodyCards = await readCards(page, [oracle.bodyCanary])
  witness.cold = { routeAndVisibleMs: elapsed(coldStart), items: bodyCards, ...collect() }
  assertBatch(witness.cold, manifest, true)
  witness.storage = await inspectStorage(page, manifest)
  witness.bodyDetails = await verifyBodyDetail(oracle.bodyCanary, manifest)

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
    writePrivate(join(evidence, 'wide-browser.json'), JSON.stringify(witness, null, 2) + '\n')
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
  const discovery = batch.responses.filter(c => c.kind === 'manifest' && c.method === 'GET')
  const heads = batch.responses.filter(c => c.kind === 'manifest' && c.method === 'HEAD')
  const responses = batch.responses.filter(c => c.kind === 'raw')
  const requests = batch.requests.filter(c => c.kind === 'raw')
  const wanted = cold ? manifest.parts.map(p => String(p.number)) : []
  assert.deepEqual(
    [batch.responses.filter(c => c.kind === 'compact' && c.status === 503).length, discovery.length, discovery[0]?.query,
      discovery[0]?.status, heads.length, requests.map(c => c.ordinal), responses.map(c => c.ordinal)],
    [1, 1, [], 200, cold ? 3 : 2, wanted, wanted])
  for (const call of [...heads, ...requests]) {
    assert.deepEqual([call.query, call.requestedGeneration, call.requestedDigest, call.method],
      [['digest', 'generation'], manifest.generation, manifest.digest, call.kind === 'raw' ? 'GET' : 'HEAD'])
  }
  for (const call of [...discovery, ...heads, ...responses]) {
    assert.deepEqual([call.generation, call.digest, call.pages, call.cache, call.status],
      [manifest.generation, manifest.digest, pages, 'no-store', call.method === 'HEAD' ? 204 : 200])
  }
  responses.forEach((call, i) => assert.deepEqual([call.length, call.etag], [manifest.parts[i].length, `"${manifest.parts[i].sha256}"`]))
  batch.rawBytes = responses.reduce((sum, call) => sum + call.length, 0)
  assert.equal(batch.rawBytes, cold ? manifest.bytes : 0)
}

async function withApiGet(path, handle) {
  const response = await api.get(path, { maxRedirects: 0 })
  try {
    return await handle(response)
  } finally {
    await response.dispose()
  }
}

async function readManifest() {
  const deadline = performance.now() + budgetMs
  while (performance.now() < deadline) {
    const manifest = await withApiGet(WireRoutes.PublicSearchWideManifest, async response => {
      if (response.status() === 503) return null
      assert.equal(response.status(), 200)
      const raw = await response.body()
      const bytes = Buffer.from(decodeFrame(raw, FrameType.PublicSearchWideManifest).payload)
      const generation = String(bytes.readBigInt64LE(4))
      const total = Number(bytes.readBigInt64LE(20))
      const digest = bytes.subarray(28, L.SearchWideManifestHeaderSize).toString('hex')
      const headers = response.headers()
      assert.match(generation, /^(0|[1-9][0-9]{0,18})$/)
      assert(total > Limit.SearchCorpusTotalBytes && total <= Limit.SearchWideCorpusTotalBytes)
      assert.deepEqual(
        [bytes.length, bytes.readInt32LE(0), bytes.readInt32LE(12), bytes.readInt32LE(16), digest,
          headers[HEADERS.generation], headers[HEADERS.digest], headers[HEADERS.pages], headers['cache-control']],
        [L.SearchWideManifestHeaderSize + pages * L.SearchWideManifestPageRecordSize, L.SearchWideManifestVersion, documents, pages,
          sha256(Buffer.from('public-search-fspk-manifest-v1\0', 'ascii'), bytes.subarray(12, 28), bytes.subarray(L.SearchWideManifestHeaderSize)),
          generation, digest, String(pages), 'no-store'])
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
      writePrivate(join(evidence, 'wide-manifest.aeds'), raw)
      return { generation, digest, bytes: total, parts }
    })
    if (manifest) return manifest
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

async function verifyBodyDetail(expected, manifest) {
  return withApiGet(WireRoutes.PublicArticle.replace('{id}', String(expected.id)), async response => {
    assert.equal(response.status(), 200)
    assert.equal(response.headers()[HEADERS.generation], manifest.generation)
    const raw = await response.body()
    const { payload } = decodeFrame(raw, FrameType.ArticleDetail)
    const row = decodeArticle(payload)
    const actual = { id: row.id, revision: String(row.revision), publication: String(row.publication),
      title: row.title, summary: row.summary, bodySha256: sha256(row.body) }
    const { term, ...coordinates } = expected
    assert.deepEqual(actual, coordinates)
    assert(row.body.includes(term) && !row.title.includes(term) && !row.summary.includes(term))
    writePrivate(join(evidence, 'final-article.aeds'), raw)
    return actual
  })
}
