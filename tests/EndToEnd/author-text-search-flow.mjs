import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeArticleSummary } from '../../src/Contracts/article-summary.ts'
import {
  decodeAuthorTextHeadingPage, decodeAuthorTextHeadingQuery, decodeAuthorTextSummaryPage, decodeAuthorTextSummaryQuery,
} from '../../src/Contracts/author-text-search.ts'
import { decodeDraft, FrameType, WireHeaders, WireLimits, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { editorSourceHandoffKey } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'

export async function exerciseAuthorTextSearch({ publisher, origin, article, bodyTerm, monitor, observations, articleCommand, publicFixture }) {
  const page = await publisher.context().newPage()
  let fixture
  const pagingFixtures = []
  try {
    monitor(page, 'author-full-text')
    await recordEditorHistory(page)
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
    async function search(text, includeHeading = false) {
      await query.fill(text)
      await results.waitFor({ state: 'detached' })
      for (let attempt = 0; attempt < 16; attempt++) {
        const reply = page.waitForResponse(isSearchReply)
        await (attempt === 0 ? start : next).click()
        const response = await reply
        const batch = await readSearchReply(response, includeHeading)
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

    const unfiltered = (await search(bodyTerm.toUpperCase())).batch
    assert.equal(unfiltered.total, 1)
    await results.getByText('共 1 篇', { exact: true }).waitFor()
    await verifyBodyMatch()
    const quotedHeading = String.raw`"literal \" field.heading:scopeprobe"`
    const quoted = await search(quotedHeading)
    assert.equal(readSearchQuery(quoted.response).query, quotedHeading)
    assert.equal(quoted.batch.total, 0)
    await search(`"${bodyTerm} 博客搜索"`)
    await verifyBodyMatch()
    const noPhrase = (await search(`"博客搜索 ${bodyTerm}"`)).batch
    assert.equal(noPhrase.total, 0)
    assert.deepEqual(noPhrase.stateCounts, [0, 0, 0, 0])
    await results.getByText('没有匹配的文章。', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px before publication, author full-text finds and highlights a saved body word beyond the inventory summary, folds its case, and matches the quoted mixed-script phrase only in source order.')

    if (publicFixture) {
      const filtered = (await search(`${bodyTerm} category:1 tag:4`)).batch
      assert.deepEqual(filtered.rows.map(row => row.id), [article.id])
      assert.equal(filtered.total, 1)
      assert.deepEqual(filtered.categories, [{ id: 1, name: 'Web engineering', count: 1 }])
      assert.deepEqual(filtered.tags, [{ id: 4, name: 'Café', count: 1 }])
      assert.equal(filtered.moreCategories || filtered.moreTags, false)
      await results.getByRole('region', { name: '分类分面', exact: true }).getByText('Web engineering', { exact: true }).waitFor()
      await results.getByRole('region', { name: '标签分面', exact: true }).getByText('Café', { exact: true }).waitFor()
      const otherCategory = (await search(`${bodyTerm} category:2 tag:4`)).batch
      assert.equal(otherCategory.total, 0)
      assert.deepEqual(otherCategory.categories, [])
      assert.deepEqual(otherCategory.tags, [])
    }
    await query.fill(`${bodyTerm} category:0`)
    const invalidFilter = page.waitForResponse(isSearchReply)
    await start.press('Enter')
    assert.equal((await invalidFilter).status(), 400)
    await page.getByText('搜索词格式无效。请检查关键词、引号和筛选条件。', { exact: true }).waitFor()
    assert.equal(await results.count(), 0)

    await form.getByText('全文搜索属性条件', { exact: true }).click()
    await form.getByRole('combobox', { name: '属性字段', exact: true }).click()
    await page.getByRole('option', { name: 'Editorial date · editorial-date', exact: true }).click()
    await form.getByLabel('属性值', { exact: true }).fill('2024-02-29T17:06:01.150Z')
    await form.getByRole('button', { name: '添加条件', exact: true }).click()
    const qualified = await search(bodyTerm)
    assert.deepEqual(qualified.batch.rows.map(row => row.id), [article.id])
    assert.equal(qualified.batch.total, 1)
    const withProperty = readSearchQuery(qualified.response)
    assert(withProperty.schema > 0n)
    assert.equal(withProperty.conditions.length, 1)
    assert.equal(withProperty.updatedUntilUnixMs, null)

    const until = form.getByLabel('更新截止日期（不含）', { exact: true })
    await until.fill('1970-01-01')
    const beforeEpoch = await search(bodyTerm)
    assert.deepEqual(readSearchQuery(beforeEpoch.response), { ...withProperty, updatedUntilUnixMs: 0n })
    assert.equal(beforeEpoch.batch.total, 0)
    await until.fill('')
    await form.getByRole('button', { name: '移除第 1 个筛选条件', exact: true }).click()
    const cleared = await search(bodyTerm)
    assert.equal(cleared.batch.total, 1)
    assert.deepEqual(readSearchQuery(cleared.response), {
      query: bodyTerm, cursor: '', updatedFromUnixMs: null, updatedUntilUnixMs: null, schema: 0n, conditions: [],
    })
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px the existing, enabled Editorial date property qualifies a saved body hit; adding a UTC cutoff excludes it, and clearing both conditions restores the unqualified search.')

    const pagingWord = `rankedpage${randomUUID().replaceAll('-', '')}`
    for (let i = 0; i <= WireLimits.AuthorTextSearchRows; i++) {
      pagingFixtures.push(await articleCommand(WireRoutes.Save, 0, 0n, `${pagingWord} ${i}`, 'Saved content'))
    }
    const publishedOnly = (await search(`${pagingWord} status:published`)).batch
    assert.equal(publishedOnly.total, 0)
    assert.deepEqual(publishedOnly.stateCounts, [0, 0, 0, 0])
    const first = (await search(`${pagingWord} status:draft`)).batch
    assert.equal(first.total, pagingFixtures.length)
    assert.deepEqual(first.stateCounts, [pagingFixtures.length, 0, 0, 0])
    await results.getByText(`共 ${pagingFixtures.length} 篇`, { exact: true }).waitFor()
    assert.equal(first.rows.length, WireLimits.AuthorTextSearchRows)
    assert(first.nextCursor)
    const pager = results.getByRole('navigation', { name: '全文搜索分页', exact: true })
    const previousPage = pager.getByRole('button', { name: '上一页', exact: true })
    const nextPage = pager.getByRole('button', { name: '下一页', exact: true })
    const listUrl = page.url()
    const navigatePage = async button => {
      const reply = page.waitForResponse(isSearchReply)
      await button.press('Enter')
      const response = await reply
      const batch = await readSearchReply(response)
      assert(batch.ready)
      assert.equal(batch.total, first.total)
      assert.deepEqual(batch.stateCounts, first.stateCounts)
      await results.getByRole('link', { name: batch.rows[0].title, exact: true }).waitFor()
      await page.getByText('正在搜索全文…', { exact: true }).waitFor({ state: 'detached' })
      assert.equal(page.url(), listUrl)
      return { batch, response }
    }
    assert.equal(await previousPage.getAttribute('aria-disabled'), 'true')
    const second = await navigatePage(nextPage)
    const tail = second.batch.rows[0]
    assert.equal(second.batch.rows.length, 1)
    assert.equal(second.batch.nextCursor, '')
    assert.equal(await nextPage.getAttribute('aria-disabled'), 'true')
    assert.deepEqual(new Set([...first.rows, ...second.batch.rows].map(row => row.id)), new Set(pagingFixtures.map(row => row.id)))
    assert.deepEqual((await navigatePage(previousPage)).batch.rows, first.rows)
    const again = await navigatePage(nextPage)
    assert.deepEqual(again.batch.rows, second.batch.rows)
    assert(await nextPage.and(page.locator(':focus')).count())

    const tailIndex = pagingFixtures.findIndex(item => item.id === tail.id)
    assert(tailIndex >= 0)
    pagingFixtures[tailIndex] = await articleCommand(WireRoutes.Save, tail.id, tail.revision, tail.title, 'Changed while viewing the second page')
    const stalePageReply = page.waitForResponse(isSearchReply)
    await results.getByRole('button', { name: '跳到命中位置', exact: true }).press('Enter')
    const stalePage = await stalePageReply
    assert.equal(stalePage.status(), 409)
    assert.deepEqual(stalePage.request().postDataBuffer(), again.response.request().postDataBuffer())
    await results.waitFor({ state: 'detached' })
    const restart = form.getByRole('button', { name: '回到第一页', exact: true })
    await restart.and(page.locator(':focus')).waitFor()
    assert.equal(page.url(), listUrl)
    const restartReply = page.waitForResponse(isSearchReply)
    await restart.press('Enter')
    const restarted = await readSearchReply(await restartReply)
    assert(restarted.ready)
    assert.equal(restarted.total, first.total)
    assert.deepEqual(restarted.stateCounts, first.stateCounts)
    await previousPage.waitFor()
    assert.equal(await previousPage.getAttribute('aria-disabled'), 'true')
    observations.push('Draft facets count every authorized text match across both ranked pages. Keyboard navigation and exact-cursor stale recovery work at 375px.')

    const nonce = randomUUID().replaceAll('-', '')
    const titleWord = `titlereveal${nonce}`
    const bodyWord = `bodyreveal${nonce}`
    const atxWord = `atxchapter${nonce}`
    const setextWord = `setextchapter${nonce}`
    const fencedWord = `fencedchapter${nonce}`
    const savedTitle = `航线 🧭 Cafe\u0301 ${titleWord} 私稿`
    const lines = [
      '准备 🧪 with e\u0301', '', '起点 𝄞 记录。', '', `${bodyWord} 博客搜索。`, '',
      `## 章节 🧪 ${atxWord}`, '', `航线 Cafe\u0301 ${setextWord}`, '---', '',
      '~~~markdown', `## ${fencedWord}`, '~~~', '',
    ]
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

    async function activate(word, source, kind, text = word.toUpperCase()) {
      const heading = kind === 'heading'
      const { batch, response } = await search(text, heading)
      assert.equal(readSearchQuery(response, heading).query, text)
      const row = exactHit(batch, fixture, source, kind, word)
      if (heading) {
        await results.getByText('章节标题', { exact: true }).waitFor()
        assert.equal(await results.locator('mark').textContent(), word)
      }
      assert.equal(await results.getByRole('link', { name: savedTitle, exact: true }).getAttribute('href'), new URL(editor).pathname)
      const recheck = page.waitForResponse(isSearchReply)
      const loadDraft = page.waitForResponse(isDraftReply)
      await jump().click()
      const repeated = await recheck
      assert.deepEqual(repeated.request().postDataBuffer(), response.request().postDataBuffer())
      assert.deepEqual(exactHit(await readSearchReply(repeated, heading), fixture, source, kind, word), row)
      await page.waitForURL(editor)
      await expectSavedDraft(await loadDraft)
      await success.waitFor()
      const name = kind === 'title' ? 'Title' : 'Body'
      await field(name).and(page.locator(':focus')).waitFor()
      const observed = await field(name).evaluate(control => ({
        native: control.tagName, value: control.value, start: control.selectionStart, end: control.selectionEnd,
      }))
      const offset = kind === 'title' ? source.indexOf(word) : projected.indexOf(word)
      if (kind !== 'title') assert(row.sourceStart > offset, 'The CRLF fixture must distinguish raw and textarea coordinates')
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
        for (const secret of [bodyWord, titleWord, atxWord, setextWord, fencedWord, savedTitle, createHash('sha256').update(raw).digest('hex')])
          assert(!value.includes(secret) && !value.includes(secret.toUpperCase()))
      }
    }

    await activate(bodyWord, raw, 'body')
    await activate(titleWord, savedTitle, 'title')
    assert.equal((await search(`field.heading:${fencedWord}`, true)).batch.total, 0)
    exactHit((await search(`field.markdown-body:${fencedWord}`)).batch, fixture, raw, 'body', fencedWord)
    await activate(atxWord, raw, 'heading', `status:draft FiElD.HeAdInG:${atxWord.toUpperCase()}`)
    await activate(setextWord, raw, 'heading', `field.heading:${setextWord}`)
    observations.push('At 375px, ATX and Setext hits highlight and reveal their exact native source carets through CRLF and Unicode; the fenced lookalike remains searchable only as Markdown body.')

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
    let revisedRaw = ['另一段 🚢', '', ...lines].join('\r\n')
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

    const rebase = page.getByRole('button', { name: '在新修订中重新定位', exact: true })
    await rebase.press('Enter')
    await page.getByText('此命中没有可用的跨修订编辑记录，可以查看原保存修订。', { exact: true }).waitFor()
    assert.equal(page.url(), list)
    assert.equal(draftReads.length, beforeStale)

    const viewHistorical = page.getByRole('button', { name: '查看原保存修订的命中位置', exact: true })
    await viewHistorical.waitFor()
    const currentAuthority = page.waitForResponse(isSearchReply)
    const currentRead = page.waitForResponse(isDraftReply)
    const comparePath = WireRoutes.DraftRevisionComparison.replace('{id:int}', String(fixture.id))
      .replace('{sourceRevision:long}', String(prior.revision))
    const earlierRead = page.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).pathname === comparePath)
    await viewHistorical.press('Enter')
    const authority = await currentAuthority
    assert.deepEqual(authority.request().postDataBuffer(), old.response.request().postDataBuffer())
    assert.deepEqual(exactHit(await readSearchReply(authority), fixture, revisedRaw, 'body', bodyWord), moved)
    await expectSavedDraft(await currentRead)
    const compared = await earlierRead
    assert.equal(compared.status(), 200)
    assert.equal(new URL(compared.url()).searchParams.get('revision'), String(fixture.revision))
    const matchSession = await authority.request().headerValue(WireHeaders.CurrentSession)
    assert(matchSession)
    assert.equal(await compared.request().headerValue(WireHeaders.CurrentSession), matchSession)
    const historical = page.getByRole('dialog', { name: 'Historical search position', exact: true })
    const earlierBody = historical.getByRole('textbox', { name: 'Earlier revision Markdown', exact: true })
    await earlierBody.and(page.locator(':focus')).waitFor()
    const originalOffset = projected.indexOf(bodyWord)
    assert.deepEqual(await earlierBody.evaluate(control => ({ readOnly: control.readOnly, text: control.value,
      start: control.selectionStart, end: control.selectionEnd })),
    { readOnly: true, text: projected, start: originalOffset, end: originalOffset + bodyWord.length })
    await expectEditorHistory(true)
    await page.keyboard.press('Escape')
    await historical.waitFor({ state: 'hidden' })
    await field('Title').waitFor()
    await backToSearch()

    const beforeInsertion = await search(bodyWord)
    const parentHit = exactHit(beforeInsertion.batch, fixture, revisedRaw, 'body', bodyWord)
    async function saveInsertions(anchors, frame) {
      const writer = await publisher.context().newPage()
      try {
        monitor(writer, 'author-saved-body-insertion')
        await writer.setViewportSize({ width: 375, height: 850 })
        await writer.goto(editor)
        const control = writer.getByLabel('Body', { exact: true })
        await control.waitFor()
        const waitForModel = value => writer.waitForFunction(
          expected => [...document.querySelectorAll('textarea')].some(text => text.value === expected), value)
        await waitForModel(revisedRaw.replaceAll('\r\n', '\n'))
        let expected = revisedRaw
        for (const anchor of anchors) {
          const rawOffset = expected.indexOf(anchor)
          assert(rawOffset >= 0)
          const offset = expected.slice(0, rawOffset).replaceAll('\r\n', '\n').length
          await control.evaluate((input, at) => { input.focus(); input.setSelectionRange(at, at) }, offset)
          await control.press(process.platform === 'darwin' ? 'Meta+b' : 'Control+b')
          expected = expected.slice(0, rawOffset) + '**text**' + expected.slice(rawOffset)
          await waitForModel(expected.replaceAll('\r\n', '\n'))
        }
        const saved = writer.waitForResponse(response => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === WireRoutes.Save)
        await writer.getByRole('button', { name: 'Save draft', exact: true }).click()
        const response = await saved
        assert.equal(response.status(), 200)
        decodeFrame(response.request().postDataBuffer(), frame)
        const updated = decodeDraft(decodeFrame(await response.body(), FrameType.Draft).payload)
        assert.equal(updated.revision, fixture.revision + 1n)
        assert.equal(updated.body, expected)
        revisedRaw = expected
        fixture = updated
      } finally {
        await writer.close()
      }
    }
    await saveInsertions([''], FrameType.ArticleBodyInsertionCommand)
    await prepareCurrentIndex(page, beforeInsertion.response, fixture.revision)
    const refreshed = page.waitForResponse(isSearchReply)
    await jump().press('Enter')
    const insertionHit = exactHit(await readSearchReply(await refreshed), fixture, revisedRaw, 'body', bodyWord)
    assert.equal(insertionHit.sourceStart - parentHit.sourceStart, '**text**'.length)
    const mapped = page.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).searchParams.get('map') === 'body-insertion')
    const currentAfterMap = page.waitForResponse(isDraftReply)
    await rebase.press('Enter')
    const receipt = await mapped
    assert.equal(receipt.status(), 200)
    decodeFrame(await receipt.body(), FrameType.DraftRevisionBodyInsertion)
    await expectSavedDraft(await currentAfterMap)
    await page.getByText('Opened the search result at its verified position in the newer revision.', { exact: true }).waitFor()
    const shifted = revisedRaw.replaceAll('\r\n', '\n').indexOf(bodyWord)
    const rebasedCaret = await field('Body').and(page.locator(':focus')).evaluate(input => [input.selectionStart, input.selectionEnd])
    assert.deepEqual(rebasedCaret, [shifted, shifted])
    await expectEditorHistory(true)
    await backToSearch()

    const beforeChain = await search(bodyWord)
    const chainSource = fixture
    const chainHit = exactHit(beforeChain.batch, fixture, revisedRaw, 'body', bodyWord)
    await saveInsertions(['起点', 'with '], FrameType.ArticleBodyInsertionsCommand)
    const unchanged = await articleCommand(WireRoutes.Save, fixture.id, fixture.revision, savedTitle + ' 春季', revisedRaw)
    assert.equal(unchanged.revision, fixture.revision + 1n)
    assert.equal(unchanged.body, revisedRaw)
    fixture = unchanged
    await saveInsertions(['博客搜索'], FrameType.ArticleBodyInsertionCommand)
    assert.equal(fixture.revision, chainSource.revision + 3n)
    await prepareCurrentIndex(page, beforeChain.response, fixture.revision)
    const chainCheck = page.waitForResponse(isSearchReply)
    await jump().press('Enter')
    const currentHit = exactHit(await readSearchReply(await chainCheck), fixture, revisedRaw, 'body', bodyWord)
    assert.equal(currentHit.sourceStart, chainHit.sourceStart + 2 * '**text**'.length)
    const chainReply = page.waitForResponse(response => response.request().method() === 'GET' &&
      new URL(response.url()).searchParams.get('map') === 'body-chain')
    const draftAfterChain = page.waitForResponse(isDraftReply)
    await rebase.press('Enter')
    const chain = await chainReply
    assert.equal(chain.status(), 200)
    decodeFrame(await chain.body(), FrameType.DraftRevisionBodyInsertionChain)
    assert.equal(chain.request().headers()[WireHeaders.CurrentSession.toLowerCase()],
      beforeChain.response.request().headers()[WireHeaders.CurrentSession.toLowerCase()])
    await expectSavedDraft(await draftAfterChain)
    await page.getByText('Opened the search result at its verified position in the newer revision.', { exact: true }).waitFor()
    const chainCaret = revisedRaw.replaceAll('\r\n', '\n').indexOf(bodyWord)
    assert.deepEqual(await field('Body').and(page.locator(':focus')).evaluate(input => [input.selectionStart, input.selectionEnd]),
      [chainCaret, chainCaret])
    await expectEditorHistory(true)
    await backToSearch()
    await search(bodyWord)

    await cancelRecheck({ page, jump, list, draftReads, fixture, revisedRaw, bodyWord, summary })
    observations.push('Private full-text jump rechecks a real saved revision, places the native body caret through CRLF/Unicode, selects the exact title range, preserves the plain editor link, and leaves only a one-use opaque value in history.')
    observations.push('A concurrently saved revision keeps the stale browser action in the results with focus, and navigating to the trash during its real delayed current check cannot reopen the editor.')
    observations.push('At 375px an explicit historical search action rechecks the newer saved revision and selects the original CRLF/Unicode hit in a read-only dialog without replacing the current draft.')
    observations.push('At 375px a saved FsusUI keyboard insertion rebases a CRLF/Unicode search hit into the next revision through the exact stored map. An unwitnessed revision still offers its verified historical source.')
    observations.push('At 375px two keyboard insertions in one save, an unchanged-body title revision, and a later insertion compose into one authenticated three-revision chain. The old result lands on the verified CRLF/Unicode body caret.')
  } finally {
    try {
      for (const article of [...pagingFixtures, ...(fixture ? [fixture] : [])]) {
        await articleCommand(WireRoutes.Delete, article.id, article.revision, '', '', FrameType.EmptySuccess)
      }
    } finally {
      await page.close()
    }
  }
}

export async function exerciseSummarySearchReveal({ publisher, origin, draft, source, word, monitor, observations }) {
  const page = await publisher.context().newPage()
  try {
    monitor(page, 'author-summary-search')
    await recordEditorHistory(page)
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('作者全文搜索', { exact: true }).click()
    const form = page.getByRole('form', { name: '作者全文搜索', exact: true })
    const query = form.getByLabel('全文搜索词', { exact: true })
    const results = page.getByRole('region', { name: '全文搜索结果', exact: true })
    async function search(text) {
      await query.fill(text)
      for (let attempt = 0; attempt < 16; attempt++) {
        const reply = page.waitForResponse(isSearchReply)
        await form.getByRole('button', { name: attempt === 0 ? '搜索全文' : '继续搜索', exact: true }).click()
        const response = await reply
        const batch = await readSearchReply(response)
        if (batch.ready) { await results.waitFor(); return { response, batch } }
      }
      assert.fail('The private summary index was not ready after 16 batches')
    }
    assert.equal((await search(`field.markdown-body:${word}`)).batch.total, 0)
    const first = await search(`field.summary:${word}`)
    assert.equal(first.batch.total, 1)
    const hit = exactHit(first.batch, draft, source, 'summary', word)
    await results.getByText('摘要', { exact: true }).waitFor()
    assert.equal(await results.locator('mark').textContent(), word)

    const recheck = page.waitForResponse(isSearchReply)
    const route = WireRoutes.ArticleSummary.replace('{id:int}', String(draft.id))
    const receipt = page.waitForResponse(response =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === route)
    await results.getByRole('button', { name: '跳到命中位置', exact: true }).press('Enter')
    const checked = await recheck
    assert.deepEqual(checked.request().postDataBuffer(), first.response.request().postDataBuffer())
    assert.deepEqual(exactHit(await readSearchReply(checked), draft, source, 'summary', word), hit)
    const loaded = await receipt
    assert.equal(loaded.status(), 200)
    assert.equal(new URL(loaded.url()).search, `?revision=${draft.revision}`)
    const credential = WireHeaders.CurrentSession.toLowerCase()
    assert(checked.request().headers()[credential])
    assert.equal(loaded.request().headers()[credential], checked.request().headers()[credential])
    assert.deepEqual(decodeArticleSummary(decodeFrame(await loaded.body(), FrameType.ArticleSummary).payload),
      { id: draft.id, revision: draft.revision, text: source })

    const editor = `${origin}/user/manage/article/edit/${draft.id}`
    await page.waitForURL(editor)
    const inspector = page.getByRole('dialog', { name: 'Article inspector', exact: true })
    const textarea = inspector.getByLabel('Summary text', { exact: true })
    await textarea.and(page.locator(':focus')).waitFor()
    assert.deepEqual(await textarea.evaluate(control => ({ start: control.selectionStart, end: control.selectionEnd,
      value: control.value, node: control.tagName })),
    { start: hit.sourceStart, end: hit.sourceEnd, value: source, node: 'TEXTAREA' })
    await page.getByText('Opened the search result at its saved position.', { exact: true }).waitFor()
    await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), editorSourceHandoffKey)
    const entries = await page.evaluate(path => window.__authorSearchHistory.filter(item => new URL(item.url).pathname === path),
      new URL(editor).pathname)
    assert(entries.length > 0 && entries.every(item => item.url === editor))
    const handoffs = entries.filter(item => Object.hasOwn(item.state ?? {}, editorSourceHandoffKey))
    assert.equal(handoffs.length, 1)
    assert.match(handoffs[0].state[editorSourceHandoffKey], /^[0-9a-f-]{36}$/)
    const allowed = ['back', 'current', 'forward', 'replaced', 'position', 'scroll', 'articleWorkspace', editorSourceHandoffKey]
    const digest = Buffer.from(hit.sourceDigest).toString('hex')
    for (const { state } of entries) {
      assert(Object.keys(state ?? {}).every(key => allowed.includes(key)))
      const value = JSON.stringify(state)
      assert([word, source, digest].every(secret => !value.includes(secret)))
    }
    observations.push('At 375px a saved Unicode summary is matched by its field, rechecked through the same AEDS request, and selected in the FsusUI Inspector after the exact signed-in revision reload.')
  } finally {
    await page.close()
  }
}

async function recordEditorHistory(page) {
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
}

function readSearchQuery(response, includeHeading = false) {
  const request = response.request().postDataBuffer()
  if (includeHeading) return decodeAuthorTextHeadingQuery(decodeFrame(request, FrameType.AuthorTextHeadingQuery).payload)
  return decodeAuthorTextSummaryQuery(decodeFrame(request, FrameType.AuthorTextSummaryQuery).payload)
}

function isSearchReply(response) {
  return response.request().method() === 'POST' && new URL(response.url()).pathname === WireRoutes.AuthorTextSearch
}

async function readSearchReply(response, includeHeading = false) {
  assert.equal(response.status(), 200)
  const bytes = await response.body()
  if (includeHeading) return decodeAuthorTextHeadingPage(decodeFrame(bytes, FrameType.AuthorTextHeadingPage).payload)
  return decodeAuthorTextSummaryPage(decodeFrame(bytes, FrameType.AuthorTextSummaryPage).payload)
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
