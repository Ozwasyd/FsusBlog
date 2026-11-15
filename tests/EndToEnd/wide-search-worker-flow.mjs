import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeDraft, encodeArticleCommand, encodeSignIn, FrameType, WireHeaders, WireLayouts, WireLimits, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

const fixtureCount = 26_002
const deepPage = 2_601
const deepUrl = `/search?q=fixture&page=${deepPage}`
// Local IDF uses each FSPK page. The two-document tail ranks first. Article 12's
// category and tag lengthen it, leaving article 201 and 12 at the end of the ranking.
const deepIds = [201, 12]
const withdrawnQuery = '２６００２'
const cacheName = 'fsusblog-v2-wide-search-v1'
const timeout = 60_000
const pagePrefix = WireRoutes.PublicSearchWidePage.replace('{page}', '')
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const digestHeader = WireHeaders.SearchCorpusDigest.toLowerCase()
const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase()
const articleTitle = id => `Browser fixture ${id}`
const cards = page => page.locator('ol.article-list h2 a')
const worker = page => page.workers().find(worker => new URL(worker.url()).pathname.includes('/search.worker'))

export async function exerciseWideSearchWorker({ page, origin, manifest, withdraw, readManifest, observations }) {
  const context = page.context()
  const requests = []
  const responses = []
  const peer = await context.newPage()
  const onRequest = request => {
    const call = searchCall(request, origin)
    if (call) requests.push(call)
  }
  const onResponse = response => {
    const call = searchCall(response.request(), origin)
    if (call) {
      const headers = response.headers()
      responses.push({
        ...call, status: response.status(), generation: headers[generationHeader] ?? null,
        digest: headers[digestHeader] ?? null, pages: Number(headers[pagesHeader] ?? 0),
        cache: headers['cache-control'] ?? null, validator: headers.etag ?? null,
        length: Number(headers['content-length'] ?? 0), encoding: headers['content-encoding'] ?? null,
      })
    }
  }
  function collect(stage) {
    observations[stage] = { requests: requests.splice(0), responses: responses.splice(0) }
    return observations[stage]
  }
  context.on('request', onRequest)
  context.on('response', onResponse)
  try {
    const firstPage = await holdFirstPage(context, origin)
    try {
      await page.goto(origin + deepUrl)
      await firstPage.reached()
      const firstWorker = worker(page)
      assert(firstWorker, 'The first query owns a search Worker')
      await markSupersededVisibility(page)
      await submit(page, String(fixtureCount))
      await page.goBack()
      await page.waitForURL(url => url.pathname === '/search' &&
        url.searchParams.get('q') === 'fixture' && url.searchParams.get('page') === String(deepPage))
      assert.equal(worker(page), firstWorker, 'Superseding input retains the Worker loading the full generation')

      await peer.goto(origin + deepUrl)
      await peer.waitForFunction(async name => {
        const { held, pending } = await navigator.locks.query()
        return held.some(lock => lock.name === name && lock.mode === 'exclusive') &&
          pending.some(lock => lock.name === name && lock.mode === 'exclusive')
      }, cacheName, { timeout })
      assert.equal(await cards(page).count(), 0)
      assert.equal(await cards(peer).count(), 0)
      firstPage.release()
      await Promise.all([assertCards(page, deepIds), assertCards(peer, deepIds)])
      assert.equal(worker(page), firstWorker)
      assert(worker(peer) && worker(peer) !== firstWorker, 'The same-origin peer has an independent Worker')
      assert.equal(await page.evaluate(() => {
        const marker = window.__wideSearchFixtureSupersession
        marker.observer.disconnect()
        delete window.__wideSearchFixtureSupersession
        return marker.visible
      }), false, 'The intermediate search did not render its result')
      const cold = collect('coldSupersessionAndPeer')
      assert(cold.responses.some(call => call.kind === 'legacy' && call.status === 503))
      assertComplete(cold, manifest)
    } finally {
      await firstPage.close()
    }
    await assertDeepPage(page)
    await assertDeepPage(peer)
    observations.initialStorage = await inspectCache(peer, manifest)

    const peerWorker = worker(peer)
    await peer.reload()
    await assertCards(peer, deepIds)
    await assertDeepPage(peer)
    assert(worker(peer) && worker(peer) !== peerWorker, 'The reloaded tab has a fresh Worker')
    assertWarm(collect('warmIndependentWorker'), manifest)

    const middle = manifest.pages[Math.floor(manifest.pages.length / 2)]
    const damaged = await readCache(peer, middle.number)
    assert.equal(damaged.state?.owner, observations.initialStorage.owner)
    assert.equal(damaged.changed?.length, middle.length)
    assert.notEqual(damaged.changed?.before, damaged.changed?.after)
    observations.corruption = damaged.changed
    await submit(peer, String(fixtureCount))
    await peer.getByRole('alert').filter({ hasText: 'Could not load the articles.' }).waitFor({ timeout })
    assert.equal(await cards(peer).count(), 0, 'The corrupted sealed page suppresses all results')
    observations.corruptionCleanup = await waitForEmptyCache(peer)
    assertWarm(collect('corruptionRejectedWithoutRefetch'), manifest, 1)

    await peer.getByRole('button', { name: 'Retry', exact: true }).click()
    await assertCards(peer, [fixtureCount])
    assertComplete(collect('explicitAdmissionAfterCorruption'), manifest)
    const recovered = observations.recoveredStorage = await inspectCache(peer, manifest)
    assert.notEqual(recovered.owner, damaged.state.owner)

    const normalizedBoundary = String(fixtureCount) + '…'.repeat(41)
    assert.equal(normalizedBoundary.normalize('NFKC').length, WireLimits.SearchQueryChars)
    await submit(peer, normalizedBoundary)
    await assertCards(peer, [fixtureCount])
    const atLimit = collect('normalizedLengthAtLimit')
    assert(!atLimit.requests.some(call => call.kind === 'fas4'))
    assertWarm(atLimit, manifest)

    const beyondNormalizedBoundary = normalizedBoundary + '.'
    assert(beyondNormalizedBoundary.length < WireLimits.SearchQueryChars)
    assert.equal(beyondNormalizedBoundary.normalize('NFKC').length, WireLimits.SearchQueryChars + 1)
    await peer.goto(`${origin}/search?${new URLSearchParams({ q: beyondNormalizedBoundary })}`)
    const bookmarked = new URL(peer.url())
    assert.equal(bookmarked.pathname, '/search')
    assert.equal(bookmarked.searchParams.get('q'), beyondNormalizedBoundary)
    await peer.getByRole('status').filter({ hasText: /^Use at most 128 characters, including after normalization\.$/ }).waitFor({ timeout })
    const queryForm = peer.locator('form.search-form')
    assert.equal(await queryForm.getByRole('textbox', { name: 'Search articles' }).inputValue(), beyondNormalizedBoundary)
    assert(await queryForm.getByRole('button', { name: 'Search', exact: true }).isDisabled())
    assert.equal(await cards(peer).count(), 0)
    assert.equal(await peer.getByRole('alert').count(), 0)
    assert.equal(await peer.getByRole('button', { name: 'Retry', exact: true }).count(), 0)
    assert.deepEqual(collect('normalizedLengthOverLimit'), { requests: [], responses: [] })

    const outOfRange = new URLSearchParams({ q: String(fixtureCount), page: '2' })
    await peer.goto(`${origin}/search?${outOfRange}`)
    await peer.getByRole('status').filter({ hasText: /^There are no articles on this search result page\.$/ }).waitFor({ timeout })
    assert.equal(peer.url(), `${origin}/search?${outOfRange}`)
    assert.equal(await cards(peer).count(), 0)
    const pagination = peer.getByRole('navigation', { name: 'Search result pages' })
    assert.equal(await pagination.getByRole('link', { name: 'Next', exact: true }).count(), 0)
    assertWarm(collect('outOfRangePage'), manifest)

    await pagination.getByRole('link', { name: 'First page', exact: true }).click()
    await peer.waitForURL(`${origin}/search?q=${fixtureCount}`)
    await assertCards(peer, [fixtureCount])
    assertWarm(collect('returnToFirstPage'), manifest)

    const finalHead = await holdWindowHead(peer)
    try {
      await submit(peer, withdrawnQuery)
      const pins = await finalHead.reached()
      assert.deepEqual(pins, { generation: manifest.generation, digest: manifest.digest })
      assert.equal(await cards(peer).count(), 0, 'Prior cards clear while the window visibility check is held')
      await withdraw()
      await finalHead.release()
      await peer.getByRole('alert').filter({ hasText: 'Could not load the articles.' }).waitFor({ timeout })
      assert.equal(await cards(peer).count(), 0, 'A denied final HEAD does not publish the withdrawn card')
      observations.withdrawalCleanup = await waitForEmptyCache(peer)
      const denied = collect('withdrawalRejectedAtWindowHead')
      assertWarm(denied, manifest, 1)
      const failures = denied.responses.filter(call => call.kind === 'manifest' && call.method === 'HEAD' && call.status === 409)
      assert.equal(failures.length, 1)
      assertPins(failures[0], manifest)
      assert.equal(failures[0].cache, 'no-store')
      assert.equal(failures[0].generation, null)
      assert.equal(failures[0].digest, null)
    } finally {
      await finalHead.close()
    }

    const replacement = await readManifest()
    assert.notEqual(replacement.generation, manifest.generation)
    assert.notEqual(replacement.digest, manifest.digest)
    assert.equal(replacement.documentCount, fixtureCount - 1)
    await peer.getByRole('button', { name: 'Retry', exact: true }).click()
    await peer.getByText('No articles match your search.', { exact: true }).waitFor({ timeout })
    assert.equal(await cards(peer).count(), 0)
    assertComplete(collect('replacement'), replacement)
    observations.replacementStorage = await inspectCache(peer, replacement)
  } finally {
    collect('remaining')
    context.off('request', onRequest)
    context.off('response', onResponse)
    await peer.close()
  }
}

async function submit(page, query) {
  const form = page.locator('form.search-form')
  await form.getByRole('textbox', { name: 'Search articles' }).fill(query)
  await form.getByRole('button', { name: 'Search', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/search' && url.searchParams.get('q') === query)
}

async function assertCards(page, ids) {
  await page.locator('ol.article-list').getByRole('link', { name: articleTitle(ids[0]), exact: true }).waitFor({ timeout })
  assert.deepEqual(await cards(page).allTextContents(), ids.map(articleTitle))
  const paths = await cards(page).evaluateAll(links => links.map(link => new URL(link.href).pathname))
  assert.deepEqual(paths, ids.map(id => `/article/${id}`))
}

async function assertDeepPage(page) {
  const nav = page.getByRole('navigation', { name: 'Search result pages' })
  assert.equal(await nav.locator('span[aria-current="page"]').textContent(), `Page ${deepPage}`)
  assert.equal(await nav.getByRole('link', { name: 'Previous', exact: true }).count(), 1)
  assert.equal(await nav.getByRole('link', { name: 'Next', exact: true }).count(), 0)
}

async function markSupersededVisibility(page) {
  await page.evaluate(title => {
    const marker = { visible: false }
    const observer = new MutationObserver(() => {
      marker.visible ||= Array.from(document.querySelectorAll('ol.article-list h2 a'))
        .some(link => link.textContent === title)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    window.__wideSearchFixtureSupersession = { get visible() { return marker.visible }, observer }
  }, articleTitle(fixtureCount))
}

function searchCall(request, origin) {
  const url = new URL(request.url())
  if (url.origin !== origin) return undefined
  const kind = url.pathname === WireRoutes.PublicSearchWideManifest ? 'manifest' :
    url.pathname === WireRoutes.PublicSearchCorpus ? 'legacy' : url.pathname.startsWith(pagePrefix) ? 'raw' :
      url.pathname === WireRoutes.PublicSearch ? 'fas4' : undefined
  if (!kind) return undefined
  return {
    method: request.method(), kind, page: kind === 'raw' ? Number(url.pathname.slice(pagePrefix.length)) : null,
    params: Array.from(url.searchParams.keys()).sort(), requested: url.searchParams.get('generation'),
    requestedDigest: url.searchParams.get('digest'),
  }
}

function assertPins(call, manifest) {
  assert.deepEqual(call.params, ['digest', 'generation'])
  assert.equal(call.requested, manifest.generation)
  assert.equal(call.requestedDigest, manifest.digest)
}

function assertReads(batch, manifest, minimumSuccesses = 2) {
  assert(batch.requests.some(call => call.kind === 'manifest' && call.method === 'GET'), 'A real sealed manifest was requested')
  assert(batch.requests.filter(call => call.kind === 'manifest' && call.method === 'GET').every(call => !call.params.length))
  const heads = batch.responses.filter(call => call.kind === 'manifest' && call.method === 'HEAD' && call.status === 204)
  assert(heads.length >= minimumSuccesses, 'Expected successful pinned authority checks')
  for (const call of heads) {
    assertPins(call, manifest)
    assert.equal(call.generation, manifest.generation)
    assert.equal(call.digest, manifest.digest)
    assert.equal(call.pages, manifest.pages.length)
    assert.equal(call.cache, 'no-store')
  }
  assert(batch.responses.filter(call => call.kind === 'legacy').every(call => call.status === 503),
    'The compact endpoint accepts none of this fixture as a partial corpus')
}

function assertWarm(batch, manifest, minimumSuccesses) {
  assertReads(batch, manifest, minimumSuccesses)
  assert(!batch.requests.some(call => call.kind === 'raw'), 'An admitted corpus performs no raw page requests')
}

function assertComplete(batch, manifest) {
  assertReads(batch, manifest)
  const attempts = batch.requests.filter(call => call.kind === 'raw')
  assert.deepEqual(attempts.map(call => [call.method, call.page]), manifest.pages.map(page => ['GET', page.number]),
    'The route and same-origin peer shared one query-independent full download')
  for (const call of attempts) assertPins(call, manifest)
  const bodies = batch.responses.filter(call => call.kind === 'raw')
  assert.deepEqual(bodies.map(call => call.page), manifest.pages.map(page => page.number))
  for (const [index, call] of bodies.entries()) {
    const page = manifest.pages[index]
    assert.equal(call.status, 200)
    assert.equal(call.generation, manifest.generation)
    assert.equal(call.digest, manifest.digest)
    assert.equal(call.pages, manifest.pages.length)
    assert.equal(call.validator, `"${page.sha256}"`)
    assert.equal(call.cache, 'no-store')
    if (!call.encoding || call.encoding === 'identity') assert.equal(call.length, page.length)
  }
}

async function holdFirstPage(context, origin) {
  const arrived = Promise.withResolvers()
  const gate = Promise.withResolvers()
  const match = url => url.origin === origin && url.pathname === pagePrefix + '1'
  const hold = async route => {
    arrived.resolve()
    await gate.promise
    await route.continue().catch(() => {})
  }
  await context.route(match, hold, { times: 1 })
  return {
    async reached() {
      const timer = new AbortController()
      try {
        assert(await Promise.race([arrived.promise.then(() => true), delay(timeout, false, { signal: timer.signal })]),
          'Timed out waiting for raw wide page 1')
      } finally {
        timer.abort()
      }
    },
    release: gate.resolve,
    async close() {
      gate.resolve()
      await context.unroute(match, hold)
    },
  }
}

async function holdWindowHead(page) {
  await page.evaluate(path => {
    const original = window.fetch
    let release
    const gate = new Promise(resolve => { release = resolve })
    const state = window.__wideSearchFixtureHead = { pins: null, release, restore: () => { window.fetch = original } }
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input, location.href)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (state.pins || method !== 'HEAD' || url.origin !== location.origin || url.pathname !== path) {
        return original.call(window, input, init)
      }
      state.pins = { generation: url.searchParams.get('generation'), digest: url.searchParams.get('digest') }
      return gate.then(() => original.call(window, input, init))
    }
  }, WireRoutes.PublicSearchWideManifest)
  return {
    async reached() {
      const seen = await page.waitForFunction(() => window.__wideSearchFixtureHead?.pins, undefined, { timeout })
      return await seen.jsonValue()
    },
    async release() {
      await page.evaluate(() => window.__wideSearchFixtureHead.release())
    },
    async close() {
      await page.evaluate(() => {
        window.__wideSearchFixtureHead.release()
        window.__wideSearchFixtureHead.restore()
        delete window.__wideSearchFixtureHead
      })
    },
  }
}

async function readCache(page, corruptPage = null, lockTimeout = timeout) {
  return page.evaluate(({ name, corruptPage, timeout }) =>
    navigator.locks.request(name, { mode: 'exclusive', signal: AbortSignal.timeout(timeout) },
      () => new Promise((resolve, reject) => {
        const opened = indexedDB.open(name, 1)
        opened.onupgradeneeded = () => opened.transaction.abort()
        opened.onerror = () => reject(opened.error)
        opened.onsuccess = () => {
          const db = opened.result
          const tx = db.transaction(['metadata', 'pages'], corruptPage === null ? 'readonly' : 'readwrite')
          const metadata = tx.objectStore('metadata').get('corpus')
          const pages = tx.objectStore('pages')
          const count = pages.count()
          let changed
          tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Could not read the owned sealed page')) }
          tx.oncomplete = () => { db.close(); resolve({ state: metadata.result ?? null, storedPages: count.result, changed }) }
          if (corruptPage !== null) {
            const record = pages.get(corruptPage)
            record.onsuccess = () => {
              const row = record.result
              const state = metadata.result
              if (!row || state?.status !== 'sealed' || row.owner !== state.owner ||
                  !(row.body instanceof ArrayBuffer) || row.body.byteLength === 0) return tx.abort()
              const bytes = new Uint8Array(row.body)
              const offset = bytes.length - 1
              const before = bytes[offset]
              bytes[offset] ^= 1
              changed = { page: corruptPage, length: bytes.length, offset, before, after: bytes[offset] }
              pages.put(row, corruptPage)
            }
          }
        }
      })), { name: cacheName, corruptPage, timeout: lockTimeout })
}

async function inspectCache(page, manifest) {
  const { state, storedPages } = await readCache(page)
  const { owner, ...metadata } = state ?? {}
  assert(typeof owner === 'string' && owner.length > 0)
  assert.deepEqual({ ...metadata, storedPages }, {
    generation: manifest.generation, digest: manifest.digest, status: 'sealed', pageCount: manifest.pages.length,
    writtenPages: manifest.pages.length, byteCount: manifest.byteCount, writtenBytes: manifest.byteCount,
    storedPages: manifest.pages.length,
  })
  return { owner, ...metadata, storedPages }
}

async function waitForEmptyCache(page) {
  const end = Date.now() + timeout
  for (let remaining = timeout; remaining > 0; remaining = end - Date.now()) {
    const { state, storedPages } = await readCache(page, null, remaining)
    if (state === null && storedPages === 0) return { state, storedPages }
    await delay(50)
  }
  assert.fail('Expected the owning cache metadata and all owned pages to be removed')
}

async function sealedManifest(request) {
  const end = Date.now() + timeout
  do {
    const response = await request.get(WireRoutes.PublicSearchWideManifest)
    try {
      if (response.status() !== 503) {
        assert.equal(response.status(), 200)
        const { payload } = decodeFrame(await response.body(), FrameType.PublicSearchWideManifest)
        const bytes = Buffer.from(payload)
        const generation = bytes.readBigInt64LE(4).toString()
        const documentCount = bytes.readInt32LE(12)
        const pageCount = bytes.readInt32LE(16)
        const byteCount = Number(bytes.readBigInt64LE(20))
        const digest = bytes.subarray(28, WireLayouts.SearchWideManifestHeaderSize).toString('hex')
        assert.equal(bytes.readInt32LE(0), WireLayouts.SearchWideManifestVersion)
        assert.equal(generation, response.headers()[generationHeader])
        assert.equal(digest, response.headers()[digestHeader])
        assert.equal(String(pageCount), response.headers()[pagesHeader])
        assert(pageCount > WireLimits.SearchCorpusMaxPages && pageCount <= WireLimits.SearchWideCorpusMaxPages)
        assert.equal(bytes.length, WireLayouts.SearchWideManifestHeaderSize + pageCount * WireLayouts.SearchWideManifestPageRecordSize)
        const pages = Array.from({ length: pageCount }, (_, index) => {
          const at = WireLayouts.SearchWideManifestHeaderSize + index * WireLayouts.SearchWideManifestPageRecordSize
          const number = bytes.readInt32LE(at)
          assert.equal(number, index + 1)
          return { number, length: bytes.readInt32LE(at + 24),
            sha256: bytes.subarray(at + 28, at + WireLayouts.SearchWideManifestPageRecordSize).toString('hex') }
        })
        assert.equal(pages.reduce((sum, page) => sum + page.length, 0), byteCount)
        return { generation, documentCount, digest, byteCount, pages }
      }
    } finally {
      await response.dispose()
    }
    await delay(250)
  } while (Date.now() < end)
  assert.fail('The opt-in server did not seal the expected wide generation')
}

async function run() {
  const { launchIdentityBrowser, request } = await import('./site-authentication-fixture.mjs')
  const { postFrame } = await import('./browser-authoring-fixture.mjs')
  const url = new URL(process.env.FSUSBLOG_TEST_SITE_URL ?? 'http://invalid.test')
  const ticket = process.env.FSUSBLOG_TEST_SITE_TICKET
  const pins = process.env.FSUSBLOG_TEST_TLS_SPKI
  const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
  assert(url.protocol === 'https:' && ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    /^[0-9a-f]{64}$/.test(ticket ?? '') && /^[A-Za-z0-9+/]{43}=(?:,[A-Za-z0-9+/]{43}=)?$/.test(pins ?? '') && evidence,
  'Use the isolated Caddy HTTPS fixture with a disposable article-owner ticket and TLS leaf pins.')
  await mkdir(evidence, { recursive: true })
  const author = await request.newContext({ baseURL: url.origin })
  const browser = await launchIdentityBrowser(pins)
  const observations = { browser: browser.version(), origin: url.origin }
  try {
    const manifest = await sealedManifest(author)
    assert.equal(manifest.documentCount, fixtureCount)
    const context = await browser.newContext({ viewport: { width: 375, height: 850 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    const signIn = await post(WireRoutes.SignIn, FrameType.OperatorSignIn, encodeSignIn({ ticket }), FrameType.OperatorSession)
    assert(signIn.length > 0)
    await exerciseWideSearchWorker({
      page, origin: url.origin, manifest, observations,
      readManifest: () => sealedManifest(author),
      async withdraw() {
        const payload = encodeArticleCommand({ id: fixtureCount, expectedRevision: 1n, title: '', body: '', idempotencyKey: randomUUID() })
        const receipt = decodeDraft(await post(WireRoutes.Retract, FrameType.ArticleCommand, payload, FrameType.Draft))
        assert.equal(receipt.id, fixtureCount)
        assert.equal(receipt.revision, 2n)
        assert.equal(receipt.published, false)
      },
    })
  } finally {
    await Promise.all([browser.close(), author.dispose()])
    await writeFile(join(evidence, 'wide-search-worker.json'), JSON.stringify(observations, null, 2) + '\n')
  }

  async function post(path, type, payload, reply) {
    const response = await postFrame(author, path, type, payload)
    try {
      assert.equal(response.status(), 200)
      return decodeFrame(await response.body(), reply).payload
    } finally {
      await response.dispose()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run()
