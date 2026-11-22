import { assertStatus } from './response-status-fixture.mjs'
import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleHot } from '../../src/Contracts/article-hot.ts'
import { FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { roleWithExactName, exactText } from './role-locators.mjs'

const hotPath = WireRoutes.PublicArticleHot.replace('{size}', '10')
const generationHeader = WireHeaders.SearchIndexGeneration.toLowerCase()
const visibleLimit = 5
const wrongTag = '"browser-test-mismatched-article-hot-validator"'

async function readRanking(response) {
  assertStatus(response, 200)
  const { etag, [generationHeader]: generation } = response.headers()
  assert.match(etag, /^"[0-9a-f]{64}"$/)
  assert.match(generation, /^[0-9]+$/)
  const items = decodeArticleHot(decodeFrame(await response.body(), FrameType.ArticleHot).payload)
  assert(items.length >= 6 && items.length <= 10, 'Fixture needs more ranked articles than the home panel displays')
  assert.deepEqual(items, [...items].sort((left, right) => right.views - left.views || right.id - left.id))
  return { items, generation, etag }
}

function assertProof(response, ranking) {
  assertStatus(response, 204)
  assert.equal(new URL(response.url()).searchParams.get('generation'), ranking.generation)
  assert.equal(response.headers()[generationHeader], ranking.generation)
  assert.equal(response.headers().etag, ranking.etag)
}

function bounded(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10_000)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function pauseFirst(page, urlMatches, method) {
  const reached = Promise.withResolvers()
  const release = Promise.withResolvers()
  const finished = Promise.withResolvers()
  let paused = false
  await page.route(urlMatches, async route => {
    const request = route.request()
    if (paused || request.method() !== method) return route.fallback()
    paused = true
    try {
      const oldGet = method === 'GET' ? await route.fetch() : undefined
      reached.resolve({ request, response: oldGet })
      await release.promise
      const response = oldGet ?? await route.fetch()
      await route.fulfill({ response })
      finished.resolve({ status: response.status() })
    } catch (error) {
      reached.resolve({ error })
      finished.resolve({ error })
    }
  })
  return {
    release: () => release.resolve(),
    async reached() {
      const result = await bounded(reached.promise, `paused ranking ${method}`)
      if (result.error) throw result.error
      return result
    },
    finished: () => bounded(finished.promise, `released ranking ${method}`),
  }
}

export async function exercisePublicHotArticles({ browser, origin, enabled, expected, advance, observations = [], monitor, screenshot }) {
  const site = new URL(origin).origin
  const urlMatches = url => url.origin === site && url.pathname === hotPath
  const marker = 'meta[name="fsus-public-hot-articles"][content="1"]'
  const diagnostics = []

  async function visit(scenario) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
    try {
      await context.addCookies([{ name: 'fsus_locale', value: 'en', url: site }])
      const page = await context.newPage()
      const requests = []
      const responses = []
      const failing = []
      page.on('request', request => {
        if (urlMatches(new URL(request.url()))) requests.push(request)
      })
      page.on('response', response => {
        if (urlMatches(new URL(response.url()))) responses.push(response)
      })
      page.on('requestfailed', request => {
        if (urlMatches(new URL(request.url()))) failing.push(request)
      })
      page.on('pageerror', error => diagnostics.push(error.message))
      monitor?.(page, 'public-hot-articles')
      await page.addInitScript(() => {
        window.__fsusHotArticleMounts = []
        new MutationObserver(() => {
          const panel = document.getElementById('popular-articles-heading')?.closest('section')
          if (!panel) return
          const links = [...panel.querySelectorAll('a')].map(link => link.getAttribute('href'))
          const mounts = window.__fsusHotArticleMounts
          if (JSON.stringify(mounts.at(-1)) !== JSON.stringify(links)) mounts.push(links)
        }).observe(document, { childList: true, subtree: true, characterData: true })
      })
      await scenario({ page, requests, responses, failing })
    } finally {
      await context.close()
    }
  }

  const panel = page => roleWithExactName(page, 'region', 'Popular articles')
  const articleLinks = page => page.locator('ol.article-list h2 a')
  const mounts = page => page.evaluate(() => window.__fsusHotArticleMounts)
  const next = page => roleWithExactName(roleWithExactName(page, 'navigation', 'Article pages'), 'link', 'Next')

  async function start(page) {
    const result = await page.goto(site + '/')
    assertStatus(result, 200)
    await roleWithExactName(page, 'heading', 'Latest posts').waitFor()
    await next(page).waitFor()
    assert.equal(await page.locator(marker).count(), enabled ? 1 : 0)
  }

  async function older(page) {
    await next(page).click()
    await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('page') === '2' && !!url.searchParams.get('cursor'))
    await exactText(roleWithExactName(page, 'navigation', 'Article pages'), 'Page 2').waitFor()
    await articleLinks(page).first().waitFor()
    await roleWithExactName(page, 'heading', 'Latest posts').waitFor()
    assert.equal(await panel(page).count(), 0)
  }

  async function assertPanel(page, { items }) {
    const region = panel(page)
    await region.waitFor()
    assert.equal(await region.count(), 1)
    assert(await region.evaluate(node => {
      const list = document.querySelector('ol.article-list')
      return node.tagName === 'SECTION' && list &&
        !!(node.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING)
    }))
    const top = items.slice(0, visibleLimit)
    assert.deepEqual(await region.getByRole('link').evaluateAll(links => links.map(link => ({
      text: link.textContent.trim(), href: link.getAttribute('href'),
    }))), top.map(item => ({ text: item.title, href: `/article/${item.id}` })))
    const format = new Intl.NumberFormat('en')
    for (const [index, item] of top.entries()) {
      await exactText(region.getByRole('listitem').nth(index), `${format.format(item.views)} ${item.views === 1 ? 'read' : 'reads'}`).waitFor()
    }
  }

  if (!enabled) {
    await visit(async ({ page, requests }) => {
      await start(page)
      assert.equal(await panel(page).count(), 0)
      await older(page)
      assert.equal(requests.length, 0)
      assert.deepEqual(await mounts(page), [])
      assertStatus(await page.request.get(site + hotPath), 404)
      observations.push({ scenario: 'public-hot-disabled', browserHotRequests: requests.length })
    })
    assert.deepEqual(diagnostics, [])
    return observations
  }

  await visit(async ({ page, requests, responses }) => {
    const proof = await pauseFirst(page, urlMatches, 'HEAD')
    try {
      await start(page)
      const { request } = await proof.reached()
      const ranking = await readRanking(responses[0])
      if (expected) assert.deepEqual(ranking.items.slice(0, expected.length), expected)
      assert.equal(new URL(request.url()).searchParams.get('generation'), ranking.generation)
      assert.equal(await panel(page).count(), 0)
      assert.deepEqual(await mounts(page), [])
      const primary = await articleLinks(page).allTextContents()
      assert.equal(primary.length, 10)
      proof.release()
      const completed = await proof.finished()
      if (completed.error) throw completed.error
      await assertPanel(page, ranking)
      assertProof(responses[1], ranking)
      assert.deepEqual(await articleLinks(page).allTextContents(), primary)
      await screenshot?.(page, 'public-hot-articles')
      await older(page)
      assert.deepEqual(requests.map(request => request.method()), ['GET', 'HEAD'])
      assert(requests.every(request => !request.headers().cookie && !request.headers().authorization))
      observations.push({ scenario: 'public-hot-confirmed', ranked: ranking.items, rendered: visibleLimit,
        generation: ranking.generation, validator: ranking.etag, pageTwoExtraRequests: 0 })
    } finally {
      proof.release()
    }
  })

  await visit(async ({ page, requests, responses, failing }) => {
    const old = await pauseFirst(page, urlMatches, 'GET')
    try {
      await start(page)
      const { request, response } = await old.reached()
      const ranking = await readRanking(response)
      await older(page)
      old.release()
      const completed = await old.finished()
      await page.waitForLoadState('networkidle')
      const aborted = failing.includes(request)
      if (completed.error) assert(aborted, String(completed.error))
      assert(aborted || responses.some(receipt => receipt.request() === request && receipt.status() === 200))
      assert.equal(await panel(page).count(), 0)
      assert.deepEqual(await mounts(page), [])
      assert.deepEqual(requests.map(item => item.method()), ['GET'])
      observations.push({ scenario: 'public-hot-navigation', oldGeneration: ranking.generation, oldGetAborted: aborted })
    } finally {
      old.release()
    }
  })

  if (advance) {
    await visit(async ({ page, responses }) => {
      const proof = await pauseFirst(page, urlMatches, 'HEAD')
      try {
        await start(page)
        await proof.reached()
        const prior = await readRanking(responses[0])
        assert.equal(await panel(page).count(), 0)
        await advance({ generation: prior.generation, items: prior.items })
        const changedResponse = page.waitForResponse(response => urlMatches(new URL(response.url())) &&
          response.request().method() === 'GET' && response.headers()[generationHeader] !== prior.generation, { timeout: 5_000 })
        proof.release()
        const [completed, fresh] = await Promise.all([proof.finished(), changedResponse])
        if (completed.error) throw completed.error
        assert.equal(completed.status, 409)
        const current = await readRanking(fresh)
        assert.notEqual(current.generation, prior.generation)
        assert.notEqual(current.etag, prior.etag)
        await assertPanel(page, current)
        assert.deepEqual(responses.map(response => response.status()), [200, 409, 200, 204])
        assertProof(responses[3], current)
        assert.deepEqual(await mounts(page), [current.items.slice(0, visibleLimit).map(item => `/article/${item.id}`)])
        observations.push({ scenario: 'public-hot-real-authority-change', oldGeneration: prior.generation,
          generation: current.generation, previousRanked: prior.items, ranked: current.items })
      } finally {
        proof.release()
      }
    })
  }

  await visit(async ({ page, requests, responses }) => {
    const upstreamStatuses = []
    await page.route(urlMatches, async route => {
      if (route.request().method() !== 'HEAD') return route.fallback()
      const native = await route.fetch()
      upstreamStatuses.push(native.status())
      await route.fulfill({ response: native, headers: { ...native.headers(), etag: wrongTag } })
    })
    await start(page)
    await page.waitForLoadState('networkidle')
    assert.deepEqual(upstreamStatuses, [204, 204])
    assert.deepEqual(requests.map(request => request.method()), ['GET', 'HEAD', 'GET', 'HEAD'])
    for (const response of responses.filter(item => item.request().method() === 'HEAD')) {
      assert.equal(response.headers().etag, wrongTag)
    }
    assert.equal(await panel(page).count(), 0)
    assert.deepEqual(await mounts(page), [])
    observations.push({ scenario: 'public-hot-injected-validator-mismatch', proofs: upstreamStatuses.length })
  })

  assert.deepEqual(diagnostics, [])
  return observations
}
