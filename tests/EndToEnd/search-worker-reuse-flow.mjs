import assert from 'node:assert/strict'
import { WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { exactButton } from './role-locators.mjs'
import * as search from './search-form-fixture.mjs'

const corpus = (url, origin) => url.origin === origin && url.pathname === WireRoutes.PublicSearchCorpus

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

function holdHead(context, origin, ordinal) {
  let heads = 0
  return search.holdRoute(context, url => corpus(url, origin),
    request => request.method() === 'HEAD' && ++heads === ordinal, 10_000, `Timed out waiting for HEAD ${ordinal}`)
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
      generation: headers[search.generationHeader], count: Number(headers[search.pagesHeader]),
    })
  }
  context.on('response', record)
  const race = await context.newPage()
  const result = tab => search.resultLink(tab, articleTitle)
  try {
    let start = received.length
    await page.goto(`${origin}/search`)
    await search.submitSearch(page, firstQuery)
    await result(page).waitFor()
    const oldGeneration = verifyDownload(received.slice(start))
    const worker = search.searchWorker(page)
    assert(worker, 'Search keeps its Worker after returning the first result')

    start = received.length
    await search.submitSearch(page, repeatQuery)
    await result(page).waitFor()
    verifyHeads(received.slice(start), oldGeneration, [204, 204])
    assert.equal(search.searchWorker(page), worker, 'An unchanged search route uses the same Worker')

    start = received.length
    await race.goto(`${origin}/search`)
    await search.submitSearch(race, firstQuery)
    await result(race).waitFor()
    verifyHeads(received.slice(start), oldGeneration, [204, 204])

    start = received.length
    const finalHead = await holdHead(context, origin, 2)
    try {
      await search.submitSearch(race, repeatQuery)
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
    await search.submitSearch(page, firstQuery)
    await search.noSearchMatches(page).waitFor()
    const replay = received.slice(start)
    verifyHeads(replay.slice(0, 1), oldGeneration, [409])
    const newGeneration = verifyDownload(replay.slice(1))
    assert.notEqual(newGeneration, oldGeneration)
    assert.equal(await result(page).count(), 0)

    start = received.length
    await exactButton(race, 'Retry').click()
    await search.noSearchMatches(race).waitFor()
    verifyHeads(received.slice(start), newGeneration, [204, 204])
    assert.equal(await result(race).count(), 0)

    const currentWorker = search.searchWorker(page)
    assert(currentWorker, 'The search Worker is available before navigation')
    const pendingHead = await holdHead(context, origin, 1)
    try {
      await search.submitSearch(page, repeatQuery)
      await pendingHead.reached()
      await Promise.all([
        currentWorker.waitForEvent('close', { timeout: 10_000 }),
        page.locator('nav.site-policy-links').getByRole('link', { name: /^(About|关于)$/ }).click(),
      ])
      await page.waitForURL(`${origin}/about`)
      pendingHead.release()
      await page.getByRole('heading', { name: /^(About|关于)$/ }).waitFor()
      assert.equal(search.searchWorker(page), undefined)
      assert.equal(await result(page).count(), 0)
    } finally {
      await pendingHead.close()
    }

    start = received.length
    await page.goto(`${origin}/search`)
    await search.submitSearch(page, firstQuery)
    await search.noSearchMatches(page).waitFor()
    verifyHeads(received.slice(start), newGeneration, [204, 204])

    observations.push(
      `Search corpus ${oldGeneration} passed ${replay.length - 2} page GETs for the replacement generation ${newGeneration}; an unchanged query route, a second tab, and returning to /search after Worker termination all reused sealed compact storage with two HEADs and zero page GETs. Withdrawal rejected both the cached preflight and a deliberately delayed final HEAD. Leaving search while a HEAD was pending terminated its Worker.`,
    )
  } finally {
    context.off('response', record)
    await race.close()
  }
}
