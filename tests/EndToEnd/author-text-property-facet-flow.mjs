import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeAuthorTextPropertyFacetPage, decodeAuthorTextPropertyFacetQuery,
  decodeAuthorTextPropertySortPage, decodeAuthorTextPropertySortQuery,
  decodeAuthorTextPropertyTextPage, decodeAuthorTextPropertyTextQuery, decodeAuthorTextSummaryPage,
  decodeAuthorTextPropertyTextQualifiedPage, decodeAuthorTextPropertyTextQualifiedQuery,
  decodeAuthorTextPropertyTextMixedPage, decodeAuthorTextPropertyTextMixedQuery,
} from '../../src/Contracts/author-text-search.ts'
import { decodePropertyEditor, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import { decodePropertyTextHitRequest } from '../../src/Contracts/property-text-hit.ts'
import {
  decodeDraft, decodePropertyCommandReceipt, decodePropertyDefinitionProjection, encodePropertyDefinitionProjectionCommand,
  encodePropertyWorkspaceRequest, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'
import { editorSourceHandoffKey } from '../../src/Web/src/authoring/canvasEditorHandoff.ts'
import { exactButton, roleWithExactName, exactLabel, exactText } from './role-locators.mjs'

export async function exerciseAuthorTextPropertyFacet({ publisher, origin, monitor, observations, articleCommand }) {
  const marker = `facetprobe${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const textMarker = `propertyprobe${randomUUID().replaceAll('-', '')}`
  const privateText = `编校提示 🧭 ${textMarker} private`
  const page = await publisher.context().newPage()
  const drafts = []
  const valueRevisions = new Map()
  let fields
  try {
    for (const [index, values] of [
      { approval: false, topics: ['Planning', 'Review'], stage: 'Ready', score: '10', subtitle: privateText },
      { approval: null, topics: [], stage: null, score: null },
      { subtitle: privateText },
      { approval: true, topics: null, stage: 'On hold', score: '2' },
    ].entries()) {
      const body = `前言 🧭\n\n## ${marker}${index === 1 ? `\n\n${textMarker}` : ''}`
      const draft = await articleCommand(WireRoutes.Save, 0, 0n, `Typed facet draft ${index}`, body)
      drafts.push(draft)
      const coordinates = { articleId: draft.id, articleRevision: draft.revision }
      const workspace = await command(publisher, origin, WireRoutes.PropertyEditor, FrameType.PropertyWorkspaceRequest,
        encodePropertyWorkspaceRequest({ ...coordinates, schemaRevision: 0n, valueRevision: 0n, afterKey: '' }),
        FrameType.PropertyEditor, decodePropertyEditor)
      fields ??= Object.fromEntries(Object.entries({ approval: 'editorial-approval', topics: 'editorial-topics',
        stage: 'editorial-stage', score: 'editorial-score', subtitle: 'article-subtitle' }).map(([key, machineKey]) => {
        const field = workspace.fields.find(item => item.machineKey === machineKey)
        assert(field, key)
        return [key, field]
      }))
      let valueRevision = workspace.valueRevision
      for (const [key, stored] of Object.entries(values)) {
        const field = fields[key]
        const id = label => {
          const option = field.options.find(option => option.label === label)
          assert(option, label)
          return option.id
        }
        const value = stored === null ? { kind: 'null' }
          : key === 'approval' ? { kind: 'boolean', value: stored }
          : key === 'topics' ? { kind: 'multi-select', value: stored.map(id) }
          : key === 'score' ? { kind: 'number', value: stored }
          : key === 'subtitle' ? { kind: 'text', value: stored }
          : { kind: 'single-select', value: id(stored) }
        const receipt = await command(publisher, origin, WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
          encodePropertyValueCommand({ ...coordinates, schemaRevision: workspace.schemaRevision, valueRevision,
            definitionId: field.definitionId, definitionRevision: field.definitionRevision, requestId: randomUUID(), value }),
          FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt)
        assert.equal(receipt.definitionId, field.definitionId)
        assert.equal(receipt.revision, ++valueRevision)
      }
      valueRevisions.set(draft.id, valueRevision)
    }

    const sortable = await changeProjection(publisher, origin, fields.score, { sortable: true })
    const eligible = await changeProjection(publisher, origin, fields.subtitle, { searchEligible: true })

    monitor(page, 'author-property-facet')
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    await exactText(page, '作者全文搜索').click()
    const form = roleWithExactName(page, 'form', '作者全文搜索')
    const catalog = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyFilterCatalog)
    await exactText(form, '全文搜索属性条件').click()
    const catalogReply = await catalog
    assert.equal(catalogReply.status(), 200)
    assert.equal(new URL(catalogReply.url()).searchParams.get('projection'), '1')
    decodeFrame(await catalogReply.body(), FrameType.PropertyProjectionCatalog)
    const handle = catalogReply.request().headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(handle)
    const query = exactLabel(form, '全文搜索词')
    await query.fill(marker)
    const selector = roleWithExactName(form, 'combobox', '属性分面字段')
    const results = roleWithExactName(page, 'region', '全文搜索结果')
    const facet = roleWithExactName(results, 'region', '属性分面')
    const searchReply = response => new URL(response.url()).pathname === WireRoutes.AuthorTextSearch
    const submit = exactButton(form, '搜索全文')
    async function search(action = () => submit.click(), { direction, heading = false } = {}) {
      for (let i = 0; i < 16; i++) {
        const request = page.waitForResponse(searchReply)
        await (i === 0 ? action() : exactButton(form, '继续搜索').click())
        const response = await request
        assert.equal(response.status(), 200)
        const requestBytes = response.request().postDataBuffer()
        const body = direction
          ? decodeAuthorTextPropertySortQuery(decodeFrame(requestBytes, FrameType.AuthorTextPropertySortQuery).payload)
          : decodeAuthorTextPropertyFacetQuery(decodeFrame(requestBytes, FrameType.AuthorTextPropertyFacetQuery).payload)
        assert.equal(body.search.query, heading ? `field.heading:${marker}` : marker)
        assert.equal(body.includeHeading, heading)
        if (direction) {
          assert.equal(body.definitionId, fields.score.definitionId)
          assert.equal(body.definitionRevision, sortable.revision)
          assert.equal(body.direction, direction)
          assert.deepEqual(body.facet, { definitionId: fields.topics.definitionId, definitionRevision: fields.topics.definitionRevision })
          assert.equal(body.search.schema, eligible.schemaRevision)
        }
        assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], handle)
        const bytes = await response.body()
        const reply = direction ? decodeAuthorTextPropertySortPage(decodeFrame(bytes, FrameType.AuthorTextPropertySortPage).payload, heading, true)
          : decodeAuthorTextPropertyFacetPage(decodeFrame(bytes, FrameType.AuthorTextPropertyFacetPage).payload, false)
        if (reply.search.ready) { await facet.waitFor(); return { body, reply, requestBytes } }
        assert.equal(reply.facet, null)
      }
      assert.fail('The authorized property facet did not become ready')
    }
    async function select(key) {
      const field = fields[key]
      await selector.click()
      await roleWithExactName(page, 'option', `${field.label} · ${field.machineKey}`).click()
      const measured = await search()
      assert.equal(measured.body.definitionId, field.definitionId)
      assert.equal(measured.body.definitionRevision, field.definitionRevision)
      assert(measured.body.search.schema > 0n)
      assert.equal(measured.reply.search.total, 4)
      await roleWithExactName(facet, 'heading', field.label).waitFor()
      return measured
    }
    const bucket = label => exactButton(facet, `按此值筛选：${label}`)
    async function counts(values) {
      for (const [label, total] of Object.entries(values)) {
        const row = facet.locator('dl > div').filter({ has: exactText(page, label) })
        assert.equal(await row.locator('dd').textContent(), String(total), label)
      }
    }
    const approval = await select('approval')
    assert.deepEqual(approval.body.search.conditions, [])
    await counts({ 尚未设置: 1, 显式空值: 1, 否: 1, 是: 1 })
    const filtered = await search(() => bucket('否').press('Enter'))
    assert.deepEqual(filtered.body.search.conditions, [{ definitionId: fields.approval.definitionId,
      definitionRevision: fields.approval.definitionRevision, comparison: 'equal', value: { kind: 'boolean', value: false } }])
    assert.deepEqual(filtered.reply.search.rows.map(row => row.id), [drafts[0].id])
    await counts({ 尚未设置: 0, 显式空值: 0, 否: 1, 是: 0 })
    await exactButton(form, '移除第 1 个筛选条件').click()

    await select('stage')
    await counts({ 尚未设置: 1, 显式空值: 1, Ready: 1, 'On hold': 1 })
    await select('topics')
    await counts({ 尚未设置: 1, 显式空值: 1, 空选项集合: 1, Planning: 1, Review: 1 })
    assert.equal(await bucket('空选项集合').count(), 0)
    const sortSelector = roleWithExactName(form, 'combobox', '属性排序字段')
    await sortSelector.click()
    assert.equal(await roleWithExactName(page, 'option', 'Editorial topics · editorial-topics').count(), 0)
    await roleWithExactName(page, 'option', 'Editorial score · editorial-score').click()
    const ascending = await search(undefined, { direction: 'ascending' })
    await verifyOrder(ascending, [3, 0, 1, 2])
    await results.getByText(/按\s+Editorial score\s+升序/).waitFor()
    await roleWithExactName(form, 'combobox', '属性排序方向').click()
    await roleWithExactName(page, 'option', '降序').click()
    await query.fill(`field.heading:${marker}`)
    const descending = { direction: 'descending', heading: true }
    const orderedHeadings = await search(undefined, descending)
    await verifyOrder(orderedHeadings, [0, 3, 1, 2])
    assert(orderedHeadings.reply.search.rows.every(row => row.field === 'heading'))
    await counts({ 尚未设置: 1, 显式空值: 1, 空选项集合: 1, Planning: 1, Review: 1 })
    const membership = await search(() => bucket('Review').click(), descending)
    const review = fields.topics.options.find(option => option.label === 'Review')
    assert.deepEqual(membership.body.search.conditions, [{ definitionId: fields.topics.definitionId,
      definitionRevision: fields.topics.definitionRevision, comparison: 'multi-select-any-of',
      value: { kind: 'multi-select', value: [review.id] } }])
    assert.deepEqual(membership.reply.search.rows.map(row => row.id), [drafts[0].id])
    const recheck = page.waitForResponse(searchReply)
    await exactButton(results, '跳到命中位置').press('Enter')
    const replay = await recheck
    assert.equal(replay.status(), 200)
    assert.deepEqual(replay.request().postDataBuffer(), membership.requestBytes)
    await page.waitForURL(`${origin}/user/manage/article/edit/${drafts[0].id}`)
    await exactText(page, 'Opened the search result at its saved position.').waitFor()
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px, real author search counts unset, explicit null, false and empty sets separately, uses current catalog labels, and applies exact Boolean and option predicates.')
    observations.push('Typed score sorting orders 2 and 10 numerically in both directions with null and missing last, retains option counts for heading results, and rechecks the identical sorted facet request before revealing saved source.')
    await verifyPropertyText()

    async function verifyPropertyText() {
      const scope = roleWithExactName(form, 'combobox', '搜索来源')
      const inspector = roleWithExactName(page, 'dialog', 'Article inspector')
      const fieldInput = exactLabel(inspector, 'Article subtitle value')
      const success = exactText(page, 'Opened the search result at its saved property position.')
      const refused = exactText(page, 'The search position is no longer available. Return to article search and choose a current result.')
      const credential = WireHeaders.CurrentSession.toLowerCase()
      const list = `${origin}/user/manage/article/list`
      const jump = draft => exactButton(results.getByRole('listitem').filter({ has: roleWithExactName(page, 'link', draft.title) }), '跳到命中位置')
      let current = await openPropertySearch()
      const lexical = await searchProperty()
      assert.equal(lexical.page.total, 2)
      assert.deepEqual(new Set(lexical.page.rows.map(row => row.id)), new Set([drafts[0].id, drafts[2].id]))
      assert.equal(await exactText(results, 'Article subtitle').count(), 2)
      assert.deepEqual(await results.locator('mark').allTextContents(), [textMarker, textMarker])
      await jump(drafts[0]).waitFor()
      await jump(drafts[2]).waitFor()
      assert.equal(await roleWithExactName(results, 'link', drafts[0].title).getAttribute('href'),
        `/user/manage/article/edit/${drafts[0].id}`)
      assert.equal(new URL(page.url()).search, '')

      const from = exactLabel(form, '更新起始日期（含）')
      await from.fill('1970-01-01')
      await roleWithExactName(form, 'combobox', '属性字段').click()
      await roleWithExactName(page, 'option', 'Editorial approval · editorial-approval').click()
      await exactButton(form, '添加条件').click()
      const filtered = await searchProperty()
      assert.equal(filtered.query.search.updatedFromUnixMs, 0n)
      assert.deepEqual(filtered.query.search.conditions, [{ definitionId: fields.approval.definitionId,
        definitionRevision: fields.approval.definitionRevision, comparison: 'equal', value: { kind: 'boolean', value: false } }])
      assert.deepEqual(filtered.page.rows.map(row => row.id), [drafts[0].id])

      await from.fill('')
      await exactButton(form, '移除第 1 个筛选条件').click()
      await scope.click()
      await roleWithExactName(page, 'option', '文章全文').click()
      const ordinary = await submitSearch(FrameType.AuthorTextSummaryPage, decodeAuthorTextSummaryPage)
      assert.deepEqual(ordinary.page.rows.map(row => [row.id, row.field]), [[drafts[1].id, 'body']])
      observations.push('At 375px the explicitly selected Text property matches saved private text without body fallback, retains date/status and Boolean conditions, exposes the normal article link, and returns to ordinary body search when cleared.')

      current = await openPropertySearch()
      await selector.click()
      await roleWithExactName(page, 'option', 'Editorial approval · editorial-approval').click()
      await sortSelector.click()
      await roleWithExactName(page, 'option', 'Editorial score · editorial-score').click()
      const qualified = await searchProperty(true)
      assert.deepEqual(qualified.query.facet, { definitionId: fields.approval.definitionId, definitionRevision: fields.approval.definitionRevision })
      assert.deepEqual(qualified.query.sort, { definitionId: fields.score.definitionId, definitionRevision: sortable.revision, direction: 'ascending' })
      assert.deepEqual(qualified.page.rows.map(row => row.id), [drafts[0].id, drafts[2].id])
      await roleWithExactName(facet, 'heading', 'Editorial approval').waitFor()
      await counts({ 尚未设置: 1, 显式空值: 0, 否: 1, 是: 0 })

      await exactText(form, '同时匹配文章字段').click()
      assert(await roleWithExactName(form, 'checkbox', '同时匹配文章字段').isChecked())
      const mixed = `status:draft field.heading:${marker} field.property:`
      await query.fill(mixed + textMarker)
      const headings = await mixedSearch(mixed + textMarker)
      assert.deepEqual(headings.page.rows.map(row => [row.id, row.field]), [[drafts[0].id, 'heading'], [drafts[2].id, 'heading']])
      assert(headings.page.rows.every(row => row.snippet.slice(row.highlightStart, row.highlightEnd) === marker))
      const combined = `${mixed}"${textMarker} private"`
      await query.fill(combined)
      const positive = await mixedSearch(combined)
      assert.deepEqual(positive.page.rows.map(row => [row.id, row.field]), [[drafts[0].id, 'property-text'], [drafts[2].id, 'property-text']])
      await counts({ 尚未设置: 1, 显式空值: 0, 否: 1, 是: 0 })
      const draft = drafts[2]
      const hit = exactPropertyRow(positive.page, draft)
      const editor = `${origin}/user/manage/article/edit/${draft.id}`
      const draftRead = page.waitForResponse(response => response.request().method() === 'GET' &&
        new URL(response.url()).pathname === WireRoutes.Draft.replace('{id:int}', String(draft.id)))
      const pinRead = waitForExactProperty(draft, 0n)
      const editorRead = waitForExactProperty(draft, valueRevisions.get(draft.id))
      const refreshed = page.waitForResponse(searchReply)
      await jump(draft).press('Enter')
      await verifyRecheck(await refreshed, positive, draft, hit)
      await verifyRead(await pinRead, draft, hit, 0n)
      const saved = await draftRead
      assert.equal(saved.status(), 200)
      assert.equal(saved.request().headers()[credential], current)
      const savedDraft = decodeDraft(decodeFrame(await saved.body(), FrameType.Draft).payload)
      assert.equal(savedDraft.id, draft.id)
      assert.equal(savedDraft.revision, draft.revision)
      const rebound = await editorRead
      await verifyRead(rebound, draft, hit, valueRevisions.get(draft.id))
      const savedTiming = saved.request().timing()
      assert(savedTiming.responseEnd >= 0 && savedTiming.startTime + savedTiming.responseEnd <= rebound.request().timing().startTime)
      await page.waitForURL(editor)
      await fieldInput.and(page.locator(':focus')).waitFor()
      assert.deepEqual(await fieldInput.evaluate(input => ({ tag: input.tagName, value: input.value,
        start: input.selectionStart, end: input.selectionEnd, selected: input.value.slice(input.selectionStart, input.selectionEnd) })),
      { tag: 'INPUT', value: privateText, start: hit.sourceStart, end: hit.sourceEnd, selected: textMarker })
      await success.waitFor()
      await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), editorSourceHandoffKey)
      assert.equal(new URL(page.url()).search, '')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
      observations.push('At 375px a selected Text field combines with a Boolean property facet and numeric ordering. The visible facet totals and ordered property hits match the server reply.')
      observations.push('At 375px one query intersects a saved heading with a selected Text property. Heading weight wins equal terms, an exact property phrase wins the field change, and the query keeps typed ordering, facet totals, and the same raw property jump.')
      observations.push('At 375px a keyboard property hit replays identical search bytes, pins the exact saved value revision, and focuses and selects its UTF-16 range in the native FsusUI Inspector input.')

      current = await openPropertySearch()
      const stale = await searchProperty()
      const changing = drafts[0]
      const old = exactPropertyRow(stale.page, changing)
      const valueRevision = valueRevisions.get(changing.id)
      const replacement = `替换后的属性 ${randomUUID()}`
      const propertyRoute = url => url.origin === origin && url.pathname === WireRoutes.PropertyEditor
      let changed = false
      let mutationError
      const editBeforeInspectorRead = async route => {
        const request = exactPropertyRequest(route.request())
        if (!request || request.articleId !== changing.id || request.valueRevision !== valueRevision || changed)
          return route.fallback()
        changed = true
        try {
          assertRequest(route.request(), changing, old, valueRevision)
          const receipt = await command(publisher, origin, WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
            encodePropertyValueCommand({ articleId: changing.id, articleRevision: changing.revision, schemaRevision: eligible.schemaRevision,
              valueRevision, definitionId: fields.subtitle.definitionId, definitionRevision: eligible.revision,
              requestId: randomUUID(), value: { kind: 'text', value: replacement } }), FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt)
          assert.equal(receipt.definitionId, fields.subtitle.definitionId)
          assert.equal(receipt.schemaRevision, eligible.schemaRevision)
          assert.equal(receipt.revision, valueRevision + 1n)
        } catch (error) {
          mutationError = error
        }
        await route.continue()
      }
      await page.route(propertyRoute, editBeforeInspectorRead)
      try {
        const attempted = waitForExactProperty(changing, valueRevision)
        const repin = waitForExactProperty(changing, 0n)
        const recheck = page.waitForResponse(searchReply)
        await jump(changing).press('Enter')
        await verifyRecheck(await recheck, stale, changing, old)
        await verifyRead(await repin, changing, old, 0n)
        const denied = await attempted
        if (mutationError) throw mutationError
        assert(changed)
        assertRequest(denied.request(), changing, old, valueRevision)
        assert.equal(denied.status(), 409)
        const deniedBytes = await denied.body()
        decodeFrame(deniedBytes, FrameType.ApiError)
        assert(!deniedBytes.includes(Buffer.from(textMarker)) && !deniedBytes.includes(Buffer.from(replacement)))
        await page.waitForURL(`${origin}/user/manage/article/edit/${changing.id}`)
        await refused.waitFor()
        assert.equal(await success.count(), 0)
        assert.deepEqual(await fieldInput.evaluateAll(inputs => inputs.map(input => input.value)), [])
        assert.equal(await page.locator('mark', { hasText: textMarker }).count(), 0)
        await page.waitForFunction(key => !Object.hasOwn(history.state ?? {}, key), editorSourceHandoffKey)
        assert.equal(new URL(page.url()).search, '')
      } finally {
        await page.unroute(propertyRoute, editBeforeInspectorRead)
      }
      observations.push('A real saved value edit after the search recheck and pin makes the Inspector read return 409. The stale result supplies no value or selection and the handoff is consumed.')

      async function openPropertySearch() {
        await page.goto(list)
        await exactText(page, '作者全文搜索').click()
        const catalog = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyFilterCatalog)
        await exactText(form, '全文搜索属性条件').click()
        const session = (await catalog).request().headers()[credential]
        assert(session)
        await scope.click()
        assert.equal(await roleWithExactName(page, 'option', 'Editorial score · editorial-score').count(), 0)
        await roleWithExactName(page, 'option', 'Article subtitle · article-subtitle').click()
        await query.fill(`status:draft ${textMarker}`)
        return session
      }

      async function verifyRecheck(response, previous, draft, hit) {
        assert.equal(response.status(), 200)
        assert.equal(response.request().headers()[credential], current)
        assert.deepEqual(response.request().postDataBuffer(), previous.response.request().postDataBuffer())
        const fresh = previous.decode(decodeFrame(await response.body(), previous.frame).payload)
        assert.deepEqual(exactPropertyRow(fresh, draft), hit)
      }

      function exactPropertyRow(batch, draft) {
        assert(batch.ready)
        const row = batch.rows.find(item => item.id === draft.id)
        assert(row)
        assert.equal(row.title, draft.title)
        assert.equal(row.revision, draft.revision)
        assert.equal(row.field, 'property-text')
        assert.equal(row.snippet.slice(row.highlightStart, row.highlightEnd), textMarker)
        const start = privateText.indexOf(textMarker)
        const end = start + textMarker.length
        assert(start > 0)
        assert.deepEqual([row.sourceStart, row.sourceEnd], [start, end])
        assert.deepEqual([row.sourceByteStart, row.sourceByteEnd],
          [Buffer.byteLength(privateText.slice(0, start)), Buffer.byteLength(privateText.slice(0, end))])
        assert(row.sourceByteStart > row.sourceStart)
        assert.deepEqual(Buffer.from(row.sourceDigest), createHash('sha256').update(privateText).digest())
        return row
      }

      function exactPropertyRequest(request) {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== WireRoutes.PropertyEditor) return undefined
        const bytes = request.postDataBuffer()
        if (!bytes) return undefined
        const packet = decodeFrame(bytes)
        return packet.type === FrameType.PropertyTextHitRequest ? decodePropertyTextHitRequest(packet.payload) : undefined
      }

      function waitForExactProperty(draft, revision) {
        return page.waitForResponse(response => {
          const request = exactPropertyRequest(response.request())
          return request?.articleId === draft.id && request.valueRevision === revision
        })
      }

      function assertRequest(request, draft, hit, valueRevision) {
        assert.equal(request.headers()[credential], current)
        const { sourceDigest, ...coordinates } = exactPropertyRequest(request)
        assert.deepEqual(coordinates, {
          articleId: draft.id, articleRevision: draft.revision, schemaRevision: eligible.schemaRevision, valueRevision,
          definitionId: fields.subtitle.definitionId, definitionRevision: eligible.revision,
        })
        assert.deepEqual(Buffer.from(sourceDigest), Buffer.from(hit.sourceDigest))
      }

      async function verifyRead(response, draft, hit, requestedRevision) {
        assertRequest(response.request(), draft, hit, requestedRevision)
        assert.equal(response.status(), 200)
        const workspace = decodePropertyEditor(decodeFrame(await response.body(), FrameType.PropertyEditor).payload)
        assert.deepEqual([workspace.articleId, workspace.articleRevision, workspace.schemaRevision, workspace.valueRevision, workspace.nextKey],
          [draft.id, draft.revision, eligible.schemaRevision, valueRevisions.get(draft.id), ''])
        assert.equal(workspace.fields.length, 1)
        assert.deepEqual(workspace.fields[0], { ...fields.subtitle, definitionRevision: eligible.revision,
          value: { kind: 'text', value: privateText } })
      }

      async function searchProperty(qualified = false) {
        const frame = qualified ? FrameType.AuthorTextPropertyTextQualifiedPage : FrameType.AuthorTextPropertyTextPage
        const decode = qualified ? payload => decodeAuthorTextPropertyTextQualifiedPage(payload, true).search : decodeAuthorTextPropertyTextPage
        const requestFrame = qualified ? FrameType.AuthorTextPropertyTextQualifiedQuery : FrameType.AuthorTextPropertyTextQuery
        const decodeQuery = qualified ? decodeAuthorTextPropertyTextQualifiedQuery : decodeAuthorTextPropertyTextQuery
        const found = await submitSearch(frame, decode)
        const sent = decodeQuery(decodeFrame(found.response.request().postDataBuffer(), requestFrame).payload)
        assert.equal(sent.search.query, `status:draft ${textMarker}`)
        assert.equal(sent.search.schema, eligible.schemaRevision)
        assert.equal(sent.definitionId, fields.subtitle.definitionId)
        assert.equal(sent.definitionRevision, eligible.revision)
        assert(found.page.rows.every(row => row.field === 'property-text' && row.snippet.slice(row.highlightStart, row.highlightEnd) === textMarker))
        return { ...found, query: sent, frame, decode }
      }

      async function mixedSearch(expected) {
        const frame = FrameType.AuthorTextPropertyTextMixedPage
        const decode = payload => decodeAuthorTextPropertyTextMixedPage(payload, true, true).search
        const found = await submitSearch(frame, decode)
        const sent = decodeAuthorTextPropertyTextMixedQuery(decodeFrame(found.response.request().postDataBuffer(),
          FrameType.AuthorTextPropertyTextMixedQuery).payload)
        assert.deepEqual(sent, { ...qualified.query, search: { ...qualified.query.search, query: expected }, includeHeading: true })
        assert.equal(found.page.total, 2)
        return { ...found, frame, decode }
      }

      async function submitSearch(frame, decode) {
        for (let attempt = 0; attempt < 16; attempt++) {
          const waiting = page.waitForResponse(searchReply)
          await (attempt ? exactButton(form, '继续搜索') : submit).click()
          const response = await waiting
          assert.equal(response.status(), 200)
          assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], current)
          const reply = decode(decodeFrame(await response.body(), frame).payload)
          if (reply.ready) { await results.waitFor(); return { page: reply, response } }
        }
        assert.fail('The authorized property index did not become ready')
      }
    }

    async function verifyOrder(measured, indices) {
      assert.deepEqual(measured.reply.search.rows.map(row => row.id), indices.map(index => drafts[index].id))
      assert.deepEqual(await results.getByRole('link').allTextContents(), indices.map(index => drafts[index].title))
    }
  } finally {
    await page.close()
    for (const draft of drafts) await articleCommand(WireRoutes.Delete, draft.id, draft.revision, '', '', FrameType.EmptySuccess)
  }
}

async function changeProjection(publisher, origin, field, changes) {
  const response = await publisher.request.get(`${origin}${WireRoutes.PropertySchemaCommand}?definition=${field.definitionId}`)
  assert.equal(response.status(), 200)
  const projection = decodePropertyDefinitionProjection(decodeFrame(await response.body(), FrameType.PropertyDefinitionProjection).payload)
  assert.equal(projection.definitionId, field.definitionId)
  const changed = await command(publisher, origin, WireRoutes.PropertySchemaCommand, FrameType.PropertyDefinitionProjectionCommand,
    encodePropertyDefinitionProjectionCommand({ ...projection, ...changes, requestId: randomUUID() }),
    FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt)
  assert.equal(changed.definitionId, field.definitionId)
  assert.equal(changed.revision, projection.definitionRevision + 1n)
  return changed
}

async function command(publisher, origin, route, type, value, receipt, decode) {
  const response = await publisher.request.post(`${origin}${route}`, {
    data: Buffer.from(encodeFrame(type, value)), headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(response.status(), 200, route)
  return decode(decodeFrame(await response.body(), receipt).payload)
}
