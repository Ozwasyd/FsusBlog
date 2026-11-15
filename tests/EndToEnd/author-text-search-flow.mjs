import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorTextSearchPage } from '../../src/Contracts/author-text-search.ts'
import { decodeDraft, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { editorSourceHandoffKey } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'

export async function exerciseAuthorTextSearch({ publisher, origin, article, bodyTerm, monitor, observations, articleCommand }) {
  const page = await publisher.context().newPage()
  let fixture
  try {
    monitor(page, 'author-full-text')
    await page.addInitScript(() => {
      window.__authorSearchHistory = []
      for (const method of ['pushState', 'replaceState']) {
        const write = History.prototype[method]
        History.prototype[method] = function (...args) {
          const result = Reflect.apply(write, this, args)
          window.__authorSearchHistory.push({ method, url: location.href, state: structuredClone(history.state) })
          return result
        }
      }
    })
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    const inventory = page.getByRole('form', { name: '筛选文章', exact: true })
    await inventory.getByLabel('标题或摘要', { exact: true }).fill(bodyTerm)
    await inventory.getByRole('button', { name: '搜索', exact: true }).click()
    await page.getByRole('region', { name: '文章列表', exact: true }).getByText('共 0 篇', { exact: true }).waitFor()

    const summary = page.getByText('作者全文搜索', { exact: true })
    await summary.click()
    const form = page.getByRole('form', { name: '作者全文搜索', exact: true })
    const query = form.getByLabel('全文搜索词', { exact: true })
    const start = form.getByRole('button', { name: '搜索全文', exact: true })
    const next = form.getByRole('button', { name: '继续搜索', exact: true })
    const results = page.getByRole('region', { name: '全文搜索结果', exact: true })
    async function search(text) {
      await query.fill(text)
      await results.waitFor({ state: 'detached' })
      for (let attempt = 0; attempt < 16; attempt++) {
        const reply = page.waitForResponse(isSearchReply)
        await (attempt === 0 ? start : next).click()
        const response = await reply
        const batch = await readSearchReply(response)
        if (batch.ready) { await results.waitFor(); return { batch, response } }
        await next.waitFor()
        assert.equal(await results.count(), 0, 'Incomplete index batches must not render partial results')
      }
      assert.fail('The isolated author fixture index was not ready after 16 batches')
    }

    async function verifyBodyMatch() {
      const link = results.getByRole('link', { name: article.title, exact: true })
      assert.equal(await link.getAttribute('href'), `/user/manage/article/edit/${article.id}`)
      assert.equal(await results.getByRole('listitem').count(), 1)
      await results.getByText('正文', { exact: true }).waitFor()
      assert.equal(await results.locator('mark').textContent(), bodyTerm)
    }

    await search(bodyTerm.toUpperCase())
    await verifyBodyMatch()
    await search(`"${bodyTerm} 博客搜索"`)
    await verifyBodyMatch()
    await search(`"博客搜索 ${bodyTerm}"`)
    await results.getByText('没有匹配的文章。', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px before publication, author full-text finds and highlights a saved body word beyond the inventory summary, folds its case, and matches the quoted mixed-script phrase only in source order.')
    const nonce = randomUUID().replaceAll('-', '')
    const titleWord = `titlereveal${nonce}`
    const bodyWord = `bodyreveal${nonce}`
    const savedTitle = `航线 🧭 Cafe\u0301 ${titleWord} 私稿`
    const lines = ['准备 🧪 with e\u0301', '', '起点 𝄞 记录。', '', `${bodyWord} 博客搜索。`, '']
    const raw = lines.join('\r\n')
    const projected = lines.join('\n')
    fixture = await articleCommand(WireRoutes.Save, 0, 0n, savedTitle, raw)
    assert.equal(fixture.body, raw)
    const editor = `${origin}/user/manage/article/edit/${fixture.id}`
    const list = `${origin}/user/manage/article/list`
    const draftRead = WireRoutes.Draft.replace('{id:int}', String(fixture.id))
    const field = name => page.getByLabel(name, { exact: true })
    const jump = () => results.getByRole('button', { name: '跳到命中位置', exact: true })
    const success = page.getByText('Opened the search result at its saved position.', { exact: true })
    const recentSearchCalls = []
    const draftReads = []
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === WireRoutes.AuthorTextSearch) recentSearchCalls.push(request)
      if (request.method() === 'GET' && new URL(request.url()).pathname === draftRead) draftReads.push(request)
    })

    async function backToSearch() {
      await page.goBack()
      await page.waitForURL(list)
      if (!await form.isVisible()) await summary.click()
      await form.waitFor()
    }

    async function activate(word, source, kind) {
      const { batch } = await search(word.toUpperCase())
      const row = exactHit(batch, fixture, source, kind, word)
      assert.equal(await results.getByRole('link', { name: savedTitle, exact: true }).getAttribute('href'), new URL(editor).pathname)
      const recheck = page.waitForResponse(isSearchReply)
      const loadDraft = page.waitForResponse(isDraftReply)
      await jump().click()
      assert.deepEqual(exactHit(await readSearchReply(await recheck), fixture, source, kind, word), row)
      await page.waitForURL(editor)
      await expectSavedDraft(await loadDraft)
      await success.waitFor()
      const name = kind === 'title' ? 'Title' : 'Body'
      await field(name).and(page.locator(':focus')).waitFor()
      const observed = await field(name).evaluate(control => ({
        native: control.tagName, value: control.value, start: control.selectionStart, end: control.selectionEnd,
      }))
      const offset = kind === 'title' ? source.indexOf(word) : projected.indexOf(word)
      if (kind === 'body') assert(row.sourceStart > offset, 'The CRLF fixture must distinguish raw and textarea coordinates')
      assert.deepEqual(observed, { native: kind === 'title' ? 'INPUT' : 'TEXTAREA', value: kind === 'title' ? savedTitle : projected,
        start: offset, end: kind === 'title' ? offset + word.length : offset })
      await expectEditorHistory(true)
      await backToSearch()
    }

    const isDraftReply = response => response.request().method() === 'GET' && new URL(response.url()).pathname === draftRead
    async function expectSavedDraft(response) {
      assert.equal(response.status(), 200)
      assert.deepEqual(decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload), fixture)
    }

    async function expectEditorHistory(usedHandoff) {
      assert.equal(page.url(), editor)
      await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), editorSourceHandoffKey)
      const editorPath = new URL(editor).pathname
      const states = await page.evaluate(path => window.__authorSearchHistory.splice(0)
        .filter(item => new URL(item.url).pathname === path), editorPath)
      assert(states.length > 0)
      assert(states.every(item => item.url === editor))
      const handoffs = states.filter(item => Object.hasOwn(item.state ?? {}, editorSourceHandoffKey))
      assert.equal(handoffs.length, Number(usedHandoff))
      if (usedHandoff) {
        assert.equal(handoffs[0].method, 'pushState')
        assert.match(handoffs[0].state[editorSourceHandoffKey], /^[0-9a-f-]{36}$/)
      }
      const allowed = ['back', 'current', 'forward', 'replaced', 'position', 'scroll', 'articleWorkspace', editorSourceHandoffKey]
      for (const { state } of states) {
        assert(Object.keys(state ?? {}).every(key => allowed.includes(key)), 'Only router state and the opaque selector may be written')
        const value = JSON.stringify(state)
        for (const secret of [bodyWord, titleWord, savedTitle, createHash('sha256').update(raw).digest('hex')])
          assert(!value.includes(secret) && !value.includes(secret.toUpperCase()))
      }
    }

    await activate(bodyWord, raw, 'body')
    await activate(titleWord, savedTitle, 'title')

    await search(titleWord)
    const beforeLink = recentSearchCalls.length
    const plainRead = page.waitForResponse(isDraftReply)
    await results.getByRole('link', { name: savedTitle, exact: true }).click()
    await page.waitForURL(editor)
    await expectSavedDraft(await plainRead)
    await field('Title').waitFor()
    assert.equal(await success.count(), 0)
    assert.equal(recentSearchCalls.length, beforeLink)
    await expectEditorHistory(false)
    await backToSearch()

    const old = await search(bodyWord)
    const prior = exactHit(old.batch, fixture, raw, 'body', bodyWord)
    const focus = jump()
    await focus.focus()
    const revisedRaw = ['另一段 🚢', '', ...lines].join('\r\n')
    fixture = await articleCommand(WireRoutes.Save, fixture.id, fixture.revision, savedTitle, revisedRaw)
    assert.equal(fixture.revision, prior.revision + 1n)
    await prepareCurrentIndex(page, old.response, fixture.revision)
    const staleCheck = page.waitForResponse(isSearchReply)
    const beforeStale = draftReads.length
    await focus.press('Enter')
    const moved = exactHit(await readSearchReply(await staleCheck), fixture, revisedRaw, 'body', bodyWord)
    assert(moved.sourceStart > prior.sourceStart)
    await page.getByText('原命中已变化或不可用。搜索结果已更新，请重新选择。', { exact: true }).waitFor()
    await focus.and(page.locator(':focus')).waitFor()
    assert.equal(page.url(), list)
    assert.equal(draftReads.length, beforeStale)
    assert.equal(await field('Title').count(), 0)
    assert.equal(await page.evaluate(key => Object.hasOwn(history.state ?? {}, key), editorSourceHandoffKey), false)

    await cancelRecheck({ page, jump, list, draftReads, fixture, revisedRaw, bodyWord, summary })
    observations.push('Private full-text jump rechecks a real saved revision, places the native body caret through CRLF/Unicode, selects the exact title range, preserves the plain editor link, and leaves only a one-use opaque value in history.')
    observations.push('A concurrently saved revision keeps the stale browser action in the results with focus, and navigating to the trash during its real delayed current check cannot reopen the editor.')
  } finally {
    try {
      if (fixture) await articleCommand(WireRoutes.Delete, fixture.id, fixture.revision, '', '', FrameType.EmptySuccess)
    } finally {
      await page.close()
    }
  }
}

function isSearchReply(response) {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === WireRoutes.AuthorTextSearch
}

async function readSearchReply(response) {
  assert.equal(response.status(), 200)
  return decodeAuthorTextSearchPage(decodeFrame(await response.body(), FrameType.AuthorTextSearchPage).payload)
}

function exactHit(batch, draft, source, field, word) {
  assert(batch.ready)
  assert.equal(batch.rows.length, 1)
  const [row] = batch.rows
  assert.equal(row.id, draft.id)
  assert.equal(row.revision, draft.revision)
  assert.equal(row.title, draft.title)
  assert.equal(row.field, field)
  assert.equal(row.snippet.slice(row.highlightStart, row.highlightEnd), word)
  const start = source.indexOf(word)
  const end = start + word.length
  assert(start > 0)
  assert.equal(row.sourceStart, start)
  assert.equal(row.sourceEnd, end)
  assert.equal(row.sourceByteStart, Buffer.byteLength(source.slice(0, start)))
  assert.equal(row.sourceByteEnd, Buffer.byteLength(source.slice(0, end)))
  assert(row.sourceByteStart > row.sourceStart, 'The Unicode prefix must distinguish byte and UTF-16 offsets')
  assert.deepEqual(Buffer.from(row.sourceDigest), createHash('sha256').update(source).digest())
  return row
}

async function prepareCurrentIndex(page, previous, revision) {
  const request = previous.request()
  const handle = request.headers()[WireHeaders.CurrentSession.toLowerCase()]
  const data = request.postDataBuffer()
  assert(handle && data)
  for (let attempt = 0; attempt < 16; attempt++) {
    const warm = await page.request.post(request.url(), {
      data, headers: { 'Content-Type': 'application/octet-stream', [WireHeaders.CurrentSession]: handle },
    })
    const batch = await readSearchReply(warm)
    if (batch.ready) {
      assert.equal(batch.rows[0]?.revision, revision)
      return
    }
  }
  assert.fail('The saved revision was not available after 16 authenticated index batches')
}

async function cancelRecheck({ page, jump, list, draftReads, fixture, revisedRaw, bodyWord, summary }) {
  const remote = Promise.withResolvers()
  const release = Promise.withResolvers()
  const finished = Promise.withResolvers()
  const target = url => url.pathname === WireRoutes.AuthorTextSearch
  let captured
  const aborts = []
  const observeAbort = request => { if (request === captured) aborts.push(request.failure()?.errorText) }
  const handler = async route => {
    if (captured || route.request().method() !== 'POST') return route.fallback()
    captured = route.request()
    try {
      const receipt = await route.fetch({ timeout: 5_000 })
      remote.resolve({ receipt })
      await release.promise
      await route.fulfill({ response: receipt })
      finished.resolve(undefined)
    } catch (error) {
      remote.resolve({ error })
      finished.resolve(error)
    }
  }
  page.on('requestfailed', observeAbort)
  await page.route(target, handler)
  const previouslyRead = draftReads.length
  try {
    const entered = page.waitForRequest(request => request.method() === 'POST' && target(new URL(request.url())))
    await jump().click()
    await entered
    await page.getByText('正在复查正文命中位置…', { exact: true }).waitFor()
    const { receipt, error } = await remote.promise
    if (error) throw error
    exactHit(await readSearchReply(receipt), fixture, revisedRaw, 'body', bodyWord)
    assert.equal(page.url(), list)

    const trashUrl = new URL('/user/manage/article/trash', list).href
    await page.getByRole('link', { name: '回收站', exact: true }).click()
    await page.waitForURL(trashUrl)
    await page.getByRole('heading', { name: '回收站', exact: true }).waitFor()
    await summary.waitFor({ state: 'detached' })
    release.resolve()
    const fulfillmentError = await finished.promise
    await page.waitForLoadState('networkidle')
    if (fulfillmentError) assert(aborts.length > 0, String(fulfillmentError))
    assert.equal(page.url(), trashUrl)
    assert.equal(draftReads.length, previouslyRead)
    const destination = await page.evaluate(key => ({
      pending: window.__authorSearchHistory.some(item => Object.hasOwn(item.state ?? {}, key)),
      current: Object.hasOwn(history.state ?? {}, key),
      editors: window.__authorSearchHistory.filter(item => new URL(item.url).pathname.includes('/article/edit/')).length,
    }), editorSourceHandoffKey)
    assert.deepEqual(destination, { pending: false, current: false, editors: 0 })
  } finally {
    release.resolve()
    await page.unroute(target, handler)
    page.off('requestfailed', observeAbort)
  }
}
