import { exactText, roleWithExactName } from './role-locators.mjs'
import assert from 'node:assert/strict'
import { submitSearch as submit } from './search-form-fixture.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'

const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const pagesHeader = WireHeaders.SearchIndexPages.toLowerCase()
const corpus = (url, origin) => url.origin === origin && url.pathname === WireRoutes.PublicSearchCorpus
const noMatches = page => exactText(page, 'No articles match your search.')
const searchWorker = page => page.workers().find(worker => new URL(worker.url()).pathname.includes('/search.worker'))


function verifyDownload(responses) {
  const [first] = responses
  assert.equal(first?.method, 'GET', 'A fresh corpus starts with page one')
  const { count, generation } = first
  assert.match(generation, /^(0|[1-9][0-9]{0,18})$/)
  assert(Number.isInteger(count) && count > 0 && count <= WireLimits.SearchCorpusMaxPages)
  assert.equal(responses.length, count + 1, 'Expected the complete corpus and its final HEAD')
  for (let page = 1; page <= count; page++) {
    assert.deepEqual(responses[page - 1], {
      method: 'GET', page, requested: page === 1 ? null : generation, status: 200, generation, count,
    })
  }
  verifyHeads(responses.slice(count), generation, [204])
  return generation
}

function verifyHeads(responses, generation, statuses) {
  assert.deepEqual(responses.map(({ method, page, requested, status }) => ({ method, page, requested, status })),
    statuses.map(status => ({ method: 'HEAD', page: 0, requested: generation, status })))
  for (const response of responses) {
    if (response.status === 204) assert.equal(response.generation, generation)
  }
}

async function holdHead(context, origin, ordinal) {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const timer = new AbortController()
  const match = url => corpus(url, origin)
  let heads = 0
  const handler = async (route, request) => {
    if (request.method() !== 'HEAD' || ++heads !== ordinal) return route.continue()
    entered.resolve()
    await release.promise
    // Chromium may have already cancelled the intercepted fetch after worker termination.
    await route.continue().catch(() => {})
  }
  await context.route(match, handler)
  return {
    async reached() {
      const seen = await Promise.race([entered.promise.then(() => true), delay(10_000, false, { signal: timer.signal })])
      timer.abort()
      assert(seen, `Timed out waiting for HEAD ${ordinal}`)
    },
    release: release.resolve,
    async close() {
      release.resolve()
      timer.abort()
      await context.unroute(match, handler)
    },
  }
}

export async function exerciseSearchWorkerReuse({ page, origin, articleTitle, firstQuery, repeatQuery, withdraw, observations }) {
  const context = page.context()
  const received = []
  const record = response => {
    const url = new URL(response.url())
    if (!corpus(url, origin)) return
    const headers = response.headers()
    received.push({
      method: response.request().method(), page: Number(url.searchParams.get('page')),
      requested: url.searchParams.get('generation'), status: response.status(),
      generation: headers[generationHeader], count: Number(headers[pagesHeader]),
    })
  }
  context.on('response', record)
  const race = await context.newPage()
  const result = tab => roleWithExactName(tab.locator('ol.article-list'), 'link', articleTitle)
  try {
    let start = received.length
    await page.goto(`${origin}/search`)
    await submit(page, firstQuery)
    await result(page).waitFor()
    const oldGeneration = verifyDownload(received.slice(start))
    const worker = searchWorker(page)
    assert(worker, 'Search keeps its Worker after returning the first result')

    start = received.length
    await submit(page, repeatQuery)
    await result(page).waitFor()
    verifyHeads(received.slice(start), oldGeneration, [204, 204])
    assert.equal(searchWorker(page), worker, 'An unchanged search route uses the same Worker')

    start = received.length
    await race.goto(`${origin}/search`)
    await submit(race, firstQuery)
    await result(race).waitFor()
    verifyHeads(received.slice(start), oldGeneration, [204, 204])

    start = received.length
    const finalHead = await holdHead(context, origin, 2)
    try {
      await submit(race, repeatQuery)
      await finalHead.reached()
      verifyHeads(received.slice(start), oldGeneration, [204])
      assert.equal(await result(race).count(), 0, 'Previous results clear before revalidation')
      await withdraw()
      finalHead.release()
      await race.getByRole('alert').filter({ hasText: 'Could not load the articles.' }).waitFor()
      verifyHeads(received.slice(start), oldGeneration, [204, 409])
      assert.equal(await result(race).count(), 0, 'A final HEAD rejection must suppress the withdrawn result')
    } finally {
      await finalHead.close()
    }

    start = received.length
    await submit(page, firstQuery)
    await noMatches(page).waitFor()
    const replay = received.slice(start)
    verifyHeads(replay.slice(0, 1), oldGeneration, [409])
    const newGeneration = verifyDownload(replay.slice(1))
    assert.notEqual(newGeneration, oldGeneration)
    assert.equal(await result(page).count(), 0)

    start = received.length
    await roleWithExactName(race, 'button', 'Retry').click()
    await noMatches(race).waitFor()
    verifyHeads(received.slice(start), newGeneration, [204, 204])
    assert.equal(await result(race).count(), 0)

    const currentWorker = searchWorker(page)
    assert(currentWorker, 'The search Worker is available before navigation')
    const pendingHead = await holdHead(context, origin, 1)
    try {
      await submit(page, repeatQuery)
      await pendingHead.reached()
      await Promise.all([
        currentWorker.waitForEvent('close', { timeout: 10_000 }),
        page.locator('nav.site-policy-links').getByRole('link', { name: /^(About|关于)$/ }).click(),
      ])
      await page.waitForURL(`${origin}/about`)
      pendingHead.release()
      await page.getByRole('heading', { name: /^(About|关于)$/ }).waitFor()
      assert.equal(searchWorker(page), undefined)
      assert.equal(await result(page).count(), 0)
    } finally {
      await pendingHead.close()
    }

    start = received.length
    await page.goto(`${origin}/search`)
    await submit(page, firstQuery)
    await noMatches(page).waitFor()
    verifyHeads(received.slice(start), newGeneration, [204, 204])

    observations.push(
      `Search corpus ${oldGeneration} passed ${replay.length - 2} page GETs for the replacement generation ${newGeneration}; an unchanged query route, a second tab, and returning to /search after Worker termination all reused sealed compact storage with two HEADs and zero page GETs. Withdrawal rejected both the cached preflight and a deliberately delayed final HEAD. Leaving search while a HEAD was pending terminated its Worker.`,
    )
  } finally {
    context.off('response', record)
    await race.close()
  }
}
