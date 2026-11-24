import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { authorFixture } from './browser-authoring-fixture.mjs'
import { launchChrome, withBrowserEvidence } from './isolated-browser-fixture.mjs'
import * as search from './search-form-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const { FSUSBLOG_TEST_URL, FSUSBLOG_TEST_SITE_URL, FSUSBLOG_TEST_ADMIN_URL, FSUSBLOG_TEST_AUTHOR_BOOTSTRAP: bootstrap,
  FSUSBLOG_TEST_TLS_SPKI: tlsPins, FSUSBLOG_TEST_EVIDENCE: evidence } = process.env
const origin = FSUSBLOG_TEST_SITE_URL ?? FSUSBLOG_TEST_URL
const adminOrigin = FSUSBLOG_TEST_ADMIN_URL ?? origin
assert(origin && bootstrap && evidence)
if (origin.startsWith('https:')) assert.match(tlsPins ?? '', /^[A-Za-z0-9+/]{43}=(?:,[A-Za-z0-9+/]{43}=)?$/)
const browser = await launchChrome(tlsPins ? [`--ignore-certificate-errors-spki-list=${tlsPins}`] : [])
const received = []
const stages = {}
const title = 'Browser fixture new'
const patchType = 'application/vnd.fsus.search-patch'
const admin = authorFixture(adminOrigin, [])
const hash = bytes => createHash('sha256').update(bytes).digest()

await withBrowserEvidence(
  browser,
  evidence,
  'search-corpus-reuse.json',
  () => ({ browser: browser.version(), stages, remaining: received }),
  async () => {
    const owner = await browser.newPage()
    await signInFreshAdmin(owner, adminOrigin, bootstrap)
    const visitor = await browser.newPage({ viewport: { width: 375, height: 850 } })
    await visitor.context().addCookies([{ name: 'fsus_locale', value: 'en', url: origin }])
    visitor.context().on('response', response => {
      const url = new URL(response.url())
      if (url.origin !== origin || url.pathname !== WireRoutes.PublicSearchCorpus) return
      const request = response.request()
      const headers = response.headers()
      received.push({
        method: request.method(), page: Number(url.searchParams.get('page')),
        requested: url.searchParams.get('generation'), conditional: request.headers()['if-none-match'] ?? null,
        status: response.status(), generation: headers[search.generationHeader] ?? null,
        pages: Number(headers[search.pagesHeader] ?? 0), validator: headers.etag ?? null,
        length: Number(headers['content-length'] ?? 0),
        type: headers['content-type'], cache: headers['cache-control'], base: url.searchParams.get('baseGeneration'),
      })
    })
    const result = name => search.resultLink(visitor, name)
    const submit = query => search.submitSearch(visitor, query)

    await visitor.goto(`${origin}/search?q=fixture`)
    await result('Browser fixture 220').waitFor()
    const worker = search.searchWorker(visitor)
    assert(worker)
    const initial = stages.initial = received.splice(0)
    assert.deepEqual(initial.map(({ method, page, status }) => [method, page, status]),
      [['GET', 1, 200], ['GET', 2, 200], ['HEAD', 0, 204]])
    const [first, last] = initial
    assert.match(first.validator, /^"[0-9a-f]{64}"$/)
    assert.match(last.validator, /^"[0-9a-f]{64}"$/)
    assert(first.length > 0 && last.length > 0)

    const published = await admin.publishDraft(owner, await admin.createDraft(owner, title, 'An extra public article.'))
    await submit('Fixture')
    await result(title).waitFor()
    stages.published = checkedRefresh(first, last)
    assert.notEqual(stages.published[1].generation, first.generation)
    assert.notEqual(stages.published[2].validator, last.validator)
    assert(visitor.workers().includes(worker))

    await admin.retractDraft(owner, published)
    await submit('fIxTuRe')
    await result('Browser fixture 220').waitFor()
    assert.equal(await result(title).count(), 0)
    stages.withdrawn = checkedRefresh(stages.published[1], stages.published[2])
    assert.notEqual(stages.withdrawn[1].generation, stages.published[1].generation)
    assert.equal(stages.withdrawn[2].validator, last.validator)
    assert(visitor.workers().includes(worker))

    const longRunTitle = 'Cjkboundarycanary'
    // The ASCII prefix keeps the CJK run out of the indexed summary.
    const longRun = '博客' + '雪'.repeat(4095) + '搜雪索'
    const longPublication = await admin.publishDraft(owner, await admin.createDraft(owner, longRunTitle, 'x'.repeat(200) + ' ' + longRun))
    assert.equal(longPublication.published, true)
    await submit('博客')
    await result(longRunTitle).waitFor()
    stages.longCjkExact = checkedRefresh(stages.withdrawn[1], stages.withdrawn[2])
    const longGeneration = stages.longCjkExact[3].generation
    assert.notEqual(longGeneration, stages.withdrawn[3].generation)
    assert.notEqual(stages.longCjkExact[2].validator, stages.withdrawn[2].validator)

    await submit('搜索')
    await search.noSearchMatches(visitor).waitFor()
    assert.equal(await result(longRunTitle).count(), 0)
    stages.longCjkNonAdjacent = checkedWarm(longGeneration)

    await submit('搜')
    await result(longRunTitle).waitFor()
    stages.longCjkScalar = checkedWarm(longGeneration)
    assert(visitor.workers().includes(worker))

    const pageUrl = generation => `${origin}${WireRoutes.PublicSearchCorpus}?page=2&generation=${generation}`
    const readPage = async generation => {
      const response = await fetch(pageUrl(generation))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get(search.generationHeader), generation)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      const bytes = Buffer.from(await response.arrayBuffer())
      const validator = `"${hash(bytes).toString('hex')}"`
      assert.equal(response.headers.get('etag'), validator)
      return { bytes, validator }
    }
    const oldPage = await readPage(longGeneration)
    const replaced = await admin.publishDraft(owner, await admin.saveDraft(owner, longPublication, 'x'.repeat(200) + ' ' + longRun + '!'))
    assert.equal(replaced.published, true)
    const firstPage = await fetch(`${origin}${WireRoutes.PublicSearchCorpus}?page=1`)
    assert.equal(firstPage.status, 200)
    const targetGeneration = firstPage.headers.get(search.generationHeader)
    assert.match(targetGeneration, /^(0|[1-9][0-9]{0,18})$/)
    assert.notEqual(targetGeneration, longGeneration)
    await firstPage.arrayBuffer()
    const full = await readPage(targetGeneration)

    const candidate = visitor.context().waitForEvent('response', response =>
      new URL(response.url()).searchParams.get('baseGeneration') === longGeneration)
    const confirmed = visitor.waitForResponse(response => response.request().method() === 'HEAD' && response.status() === 204 &&
      new URL(response.url()).searchParams.get('generation') === targetGeneration)
    await submit('博客')
    const delta = await candidate
    await confirmed
    await result(longRunTitle).waitFor()
    const changed = stages.patchRefresh = checkedRefresh(stages.longCjkExact[1], stages.longCjkExact[2])
    assert.equal(changed[2].generation, targetGeneration)
    assert.equal(changed[2].base, longGeneration)
    assert.equal(changed[2].type, patchType)
    assert.equal(changed[2].cache, 'no-store')
    assert.equal(changed[2].validator, null)
    assert.equal(delta.headers()[WireHeaders.SearchCorpusTargetDigest.toLowerCase()], full.validator.slice(1, -1))
    assert(visitor.workers().includes(worker))

    // Read production HTTP bytes independently of the Worker and its decoder.
    const patch = await delta.body()
    assert.equal(patch.subarray(0, 4).toString(), 'FSPT')
    assert.equal(patch.readUInt32LE(4), 4)
    assert.equal(patch.readBigInt64LE(8).toString(), longGeneration)
    assert.equal(patch.readBigInt64LE(16).toString(), targetGeneration)
    assert.equal(patch.readUInt32LE(24), 2)
    assert.equal(patch.readUInt32LE(28), oldPage.bytes.length)
    assert.equal(patch.readUInt32LE(32), full.bytes.length)
    assert.deepEqual(patch.subarray(44, 76), hash(oldPage.bytes))
    assert.deepEqual(patch.subarray(76, 108), hash(full.bytes))
    const prefix = patch.readUInt32LE(36)
    const suffix = patch.readUInt32LE(40)
    const recovered = Buffer.concat([oldPage.bytes.subarray(0, prefix), patch.subarray(108),
      oldPage.bytes.subarray(oldPage.bytes.length - suffix)])
    assert.deepEqual(recovered, full.bytes)
    assert(patch.length <= Math.min(65536, Math.floor(full.bytes.length / 2)))
    const fhs = recovered.readUInt32LE(20)
    assert.equal(recovered.subarray(fhs, fhs + 4).toString(), 'FHS2')
    const rows = fhs + recovered.readUInt32LE(fhs + 40)
    const rowCount = recovered.readUInt32LE(fhs + 20)
    const row = Array.from({ length: rowCount }, (_, index) => rows + index * 76)
      .find(offset => recovered.readUInt32LE(offset) === replaced.id)
    assert.notEqual(row, undefined)
    assert.equal(recovered.readBigInt64LE(row + 52), replaced.revision)
    assert.equal(oldPage.bytes.readBigInt64LE(row + 52), longPublication.revision)
    assert(recovered.readBigInt64LE(row + 64) > oldPage.bytes.readBigInt64LE(row + 64))
    assert.equal(recovered.readUInt32LE(row + 72), oldPage.bytes.readUInt32LE(row + 72) + 1)
    stages.patchProof = { oldPageBytes: oldPage.bytes.length, fullPageBytes: full.bytes.length, patchBytes: patch.length,
      targetValidator: full.validator, articleId: replaced.id, revision: replaced.revision.toString(),
      publication: recovered.readBigInt64LE(row + 64).toString(), publicationNo: recovered.readUInt32LE(row + 72) }

    const fetchPatch = (base, validator) => fetch(`${pageUrl(targetGeneration)}&baseGeneration=${base}`, {
      headers: { Accept: `${patchType}, application/octet-stream`, 'If-None-Match': validator },
    })
    for (const [base, validator] of [['0', oldPage.validator], [longGeneration, stages.initial[0].validator]]) {
      const response = await fetchPatch(base, validator)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/octet-stream')
      assert.equal(response.headers.get('etag'), full.validator)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), full.bytes)
    }

    await admin.retractDraft(owner, replaced)
    const stale = await fetchPatch(longGeneration, oldPage.validator)
    assert.equal(stale.status, 409)
    assert.notEqual(stale.headers.get('content-type'), patchType)
    await stale.arrayBuffer()
    await submit('搜')
    await search.noSearchMatches(visitor).waitFor()
    stages.patchWithdrawn = checkedRefresh(changed[1], { ...changed[2], validator: full.validator })
    assert.equal(stages.patchWithdrawn[2].type, 'application/octet-stream')
    assert.equal(await result(longRunTitle).count(), 0)
  },
  { newline: true },
)

function checkedRefresh(priorFirst, priorLast) {
  const batch = received.splice(0)
  assert.deepEqual(batch.map(({ method, page, status }) => [method, page, status]),
    [['HEAD', 0, 409], ['GET', 1, 304], ['GET', 2, 200], ['HEAD', 0, 204]])
  const [stale, unchanged, changed, current] = batch
  assert.equal(stale.requested, priorFirst.generation)
  assert.equal(unchanged.length, 0)
  assert.equal(unchanged.conditional, priorFirst.validator)
  assert.equal(unchanged.validator, priorFirst.validator)
  assert.equal(changed.conditional, priorLast.validator)
  assert(changed.length > 0)
  assert.equal(unchanged.pages, 2)
  assert.equal(changed.pages, 2)
  assert.equal(changed.requested, unchanged.generation)
  assert.equal(current.requested, unchanged.generation)
  assert.equal(current.generation, unchanged.generation)
  return batch
}

function checkedWarm(generation) {
  const batch = received.splice(0)
  assert.deepEqual(batch.map(call => [call.method, call.page, call.status, call.requested, call.generation]),
    Array.from({ length: 2 }, () => ['HEAD', 0, 204, generation, generation]))
  return batch
}
