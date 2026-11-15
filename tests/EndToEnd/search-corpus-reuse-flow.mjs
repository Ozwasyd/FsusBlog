import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeDraft, encodeArticleCommand, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const { chromium } = createRequire(new URL('../../src/Web/package.json', import.meta.url))('@playwright/test')
const { FSUSBLOG_TEST_URL: origin, FSUSBLOG_TEST_TICKET: ticket, FSUSBLOG_TEST_CHROME: executablePath,
  FSUSBLOG_TEST_EVIDENCE: evidence } = process.env
assert(origin && ticket && evidence)
const browser = await chromium.launch({ headless: true, executablePath })
const received = []
const stages = {}
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase()
const title = 'Browser fixture new'
try {
  const owner = await browser.newPage()
  await owner.goto(`${origin}/login`)
  await owner.getByLabel('Owner access key').fill(ticket)
  await owner.getByRole('button', { name: 'Log in', exact: true }).click()
  await owner.getByRole('heading', { name: 'New article' }).waitFor()

  const visitor = await browser.newPage({ viewport: { width: 375, height: 850 } })
  visitor.context().on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== origin || url.pathname !== WireRoutes.PublicSearchCorpus) return
    const request = response.request()
    const headers = response.headers()
    received.push({
      method: request.method(), page: Number(url.searchParams.get('page')),
      requested: url.searchParams.get('generation'), conditional: request.headers()['if-none-match'] ?? null,
      status: response.status(), generation: headers[generationHeader] ?? null,
      pages: Number(headers[pagesHeader] ?? 0), validator: headers.etag ?? null,
      length: Number(headers['content-length'] ?? 0),
    })
  })

  await visitor.goto(`${origin}/search?q=fixture`)
  await result('Browser fixture 220').waitFor()
  const worker = visitor.workers().find(worker => new URL(worker.url()).pathname.includes('/search.worker'))
  assert(worker)
  const initial = stages.initial = received.splice(0)
  assert.deepEqual(initial.map(({ method, page, status }) => [method, page, status]),
    [['GET', 1, 200], ['GET', 2, 200], ['HEAD', 0, 204]])
  const [first, last] = initial
  assert.match(first.validator, /^"[0-9a-f]{64}"$/)
  assert.match(last.validator, /^"[0-9a-f]{64}"$/)
  assert(first.length > 0 && last.length > 0)

  const saved = await command(WireRoutes.Save, 0, 0n, title, 'An extra public article.')
  const published = await command(WireRoutes.Publish, saved.id, saved.revision)
  await submit('Fixture')
  await result(title).waitFor()
  stages.published = checkedRefresh(first, last)
  assert.notEqual(stages.published[1].generation, first.generation)
  assert.notEqual(stages.published[2].validator, last.validator)
  assert(visitor.workers().includes(worker))

  await command(WireRoutes.Retract, published.id, published.revision)
  await submit('fIxTuRe')
  await result('Browser fixture 220').waitFor()
  assert.equal(await result(title).count(), 0)
  stages.withdrawn = checkedRefresh(stages.published[1], stages.published[2])
  assert.notEqual(stages.withdrawn[1].generation, stages.published[1].generation)
  assert.equal(stages.withdrawn[2].validator, last.validator)
  assert(visitor.workers().includes(worker))

  function result(name) {
    return visitor.locator('ol.article-list').getByRole('link', { name, exact: true })
  }

  async function submit(query) {
    const form = visitor.locator('form.search-form')
    await form.getByRole('textbox', { name: 'Search articles' }).fill(query)
    await form.getByRole('button', { name: 'Search', exact: true }).click()
    await visitor.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === query)
  }

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

  async function command(route, id, expectedRevision, title = '', body = '') {
    const payload = encodeArticleCommand({ id, expectedRevision, title, body, idempotencyKey: randomUUID() })
    const response = await owner.request.post(`${origin}${route}`, {
      data: Buffer.from(encodeFrame(FrameType.ArticleCommand, payload)),
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    assert.equal(response.status(), 200)
    return decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
  }
} finally {
  await writeFile(join(evidence, 'search-corpus-reuse.json'), JSON.stringify({
    browser: browser.version(), stages, remaining: received,
  }, null, 2) + '\n')
  await browser.close()
}
