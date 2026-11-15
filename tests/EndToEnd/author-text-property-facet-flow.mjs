import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import {
  decodeAuthorTextPropertyFacetPage, decodeAuthorTextPropertyFacetQuery,
  decodeAuthorTextPropertySortPage, decodeAuthorTextPropertySortQuery,
  decodeAuthorTextPropertyTextPage, decodeAuthorTextPropertyTextQuery, decodeAuthorTextSummaryPage,
} from '../../src/Contracts/author-text-search.ts'
import { decodePropertyEditor, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import {
  decodePropertyCommandReceipt, decodePropertyDefinitionProjection, encodePropertyDefinitionProjectionCommand,
  encodePropertyWorkspaceRequest, FrameType, WireHeaders, WireRoutes,
} from '../../src/Contracts/wire.generated.ts'

export async function exerciseAuthorTextPropertyFacet({ publisher, origin, monitor, observations, articleCommand }) {
  const marker = `facetprobe${randomUUID().replaceAll('-', '')}`
  const textMarker = `propertyprobe${randomUUID().replaceAll('-', '')}`
  const privateText = `编校提示 🧭 ${textMarker}`
  const page = await publisher.context().newPage()
  const drafts = []
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
    }

    const sortable = await changeProjection(publisher, origin, fields.score, { sortable: true })
    const eligible = await changeProjection(publisher, origin, fields.subtitle, { searchEligible: true })

    monitor(page, 'author-property-facet')
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('作者全文搜索', { exact: true }).click()
    const form = page.getByRole('form', { name: '作者全文搜索', exact: true })
    const catalog = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyFilterCatalog)
    await form.getByText('全文搜索属性条件', { exact: true }).click()
    const catalogReply = await catalog
    assert.equal(catalogReply.status(), 200)
    assert.equal(new URL(catalogReply.url()).searchParams.get('projection'), '1')
    decodeFrame(await catalogReply.body(), FrameType.PropertyProjectionCatalog)
    const handle = catalogReply.request().headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(handle)
    const query = form.getByLabel('全文搜索词', { exact: true })
    await query.fill(marker)
    const selector = form.getByRole('combobox', { name: '属性分面字段', exact: true })
    const results = page.getByRole('region', { name: '全文搜索结果', exact: true })
    const facet = results.getByRole('region', { name: '属性分面', exact: true })
    const searchReply = response => new URL(response.url()).pathname === WireRoutes.AuthorTextSearch
    const submit = form.getByRole('button', { name: '搜索全文', exact: true })
    async function search(action = () => submit.click(), { direction, heading = false } = {}) {
      for (let i = 0; i < 16; i++) {
        const request = page.waitForResponse(searchReply)
        await (i === 0 ? action() : form.getByRole('button', { name: '继续搜索', exact: true }).click())
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
      await page.getByRole('option', { name: `${field.label} · ${field.machineKey}`, exact: true }).click()
      const measured = await search()
      assert.equal(measured.body.definitionId, field.definitionId)
      assert.equal(measured.body.definitionRevision, field.definitionRevision)
      assert(measured.body.search.schema > 0n)
      assert.equal(measured.reply.search.total, 4)
      await facet.getByRole('heading', { name: field.label, exact: true }).waitFor()
      return measured
    }
    const bucket = label => facet.getByRole('button', { name: `按此值筛选：${label}`, exact: true })
    async function counts(values) {
      for (const [label, total] of Object.entries(values)) {
        const row = facet.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) })
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
    await form.getByRole('button', { name: '移除第 1 个筛选条件', exact: true }).click()

    await select('stage')
    await counts({ 尚未设置: 1, 显式空值: 1, Ready: 1, 'On hold': 1 })
    await select('topics')
    await counts({ 尚未设置: 1, 显式空值: 1, 空选项集合: 1, Planning: 1, Review: 1 })
    assert.equal(await bucket('空选项集合').count(), 0)
    const sortSelector = form.getByRole('combobox', { name: '属性排序字段', exact: true })
    await sortSelector.click()
    assert.equal(await page.getByRole('option', { name: 'Editorial topics · editorial-topics', exact: true }).count(), 0)
    await page.getByRole('option', { name: 'Editorial score · editorial-score', exact: true }).click()
    const ascending = await search(undefined, { direction: 'ascending' })
    await verifyOrder(ascending, [3, 0, 1, 2])
    await results.getByText(/按\s+Editorial score\s+升序/).waitFor()
    await form.getByRole('combobox', { name: '属性排序方向', exact: true }).click()
    await page.getByRole('option', { name: '降序', exact: true }).click()
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
    await results.getByRole('button', { name: '跳到命中位置', exact: true }).press('Enter')
    const replay = await recheck
    assert.equal(replay.status(), 200)
    assert.deepEqual(replay.request().postDataBuffer(), membership.requestBytes)
    await page.waitForURL(`${origin}/user/manage/article/edit/${drafts[0].id}`)
    await page.getByText('Opened the search result at its saved position.', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).search, '')
    observations.push('At 375px, real author search counts unset, explicit null, false and empty sets separately, uses current catalog labels, and applies exact Boolean and option predicates.')
    observations.push('Typed score sorting orders 2 and 10 numerically in both directions with null and missing last, retains option counts for heading results, and rechecks the identical sorted facet request before revealing saved source.')
    await verifyPropertyText()

    async function verifyPropertyText() {
      await page.goto(`${origin}/user/manage/article/list`)
      await page.getByText('作者全文搜索', { exact: true }).click()
      const catalog = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyFilterCatalog)
      await form.getByText('全文搜索属性条件', { exact: true }).click()
      const current = (await catalog).request().headers()[WireHeaders.CurrentSession.toLowerCase()]
      assert(current)
      const scope = form.getByRole('combobox', { name: '搜索来源', exact: true })
      await scope.click()
      assert.equal(await page.getByRole('option', { name: 'Editorial score · editorial-score', exact: true }).count(), 0)
      await page.getByRole('option', { name: 'Article subtitle · article-subtitle', exact: true }).click()
      assert.equal(await sortSelector.count(), 0)
      assert.equal(await selector.count(), 0)
      await query.fill(`status:draft ${textMarker}`)
      const lexical = await searchProperty()
      assert.equal(lexical.page.total, 2)
      assert.deepEqual(new Set(lexical.page.rows.map(row => row.id)), new Set([drafts[0].id, drafts[2].id]))
      assert.equal(await results.getByText('Article subtitle', { exact: true }).count(), 2)
      assert.deepEqual(await results.locator('mark').allTextContents(), [textMarker, textMarker])
      assert.equal(await results.getByRole('button', { name: '跳到命中位置', exact: true }).count(), 0)
      assert.equal(await results.getByRole('link', { name: drafts[0].title, exact: true }).getAttribute('href'),
        `/user/manage/article/edit/${drafts[0].id}`)
      assert.equal(new URL(page.url()).search, '')

      const from = form.getByLabel('更新起始日期（含）', { exact: true })
      await from.fill('1970-01-01')
      await form.getByRole('combobox', { name: '属性字段', exact: true }).click()
      await page.getByRole('option', { name: 'Editorial approval · editorial-approval', exact: true }).click()
      await form.getByRole('button', { name: '添加条件', exact: true }).click()
      const filtered = await searchProperty()
      assert.equal(filtered.query.search.updatedFromUnixMs, 0n)
      assert.deepEqual(filtered.query.search.conditions, [{ definitionId: fields.approval.definitionId,
        definitionRevision: fields.approval.definitionRevision, comparison: 'equal', value: { kind: 'boolean', value: false } }])
      assert.deepEqual(filtered.page.rows.map(row => row.id), [drafts[0].id])

      await from.fill('')
      await form.getByRole('button', { name: '移除第 1 个筛选条件', exact: true }).click()
      await scope.click()
      await page.getByRole('option', { name: '文章全文', exact: true }).click()
      const ordinary = await submitSearch(FrameType.AuthorTextSummaryPage, decodeAuthorTextSummaryPage)
      assert.deepEqual(ordinary.page.rows.map(row => [row.id, row.field]), [[drafts[1].id, 'body']])
      observations.push('At 375px the explicitly selected Text property matches saved private text without body fallback, retains date/status and Boolean conditions, exposes the normal article link, and returns to ordinary body search when cleared.')

      async function searchProperty() {
        const found = await submitSearch(FrameType.AuthorTextPropertyTextPage, decodeAuthorTextPropertyTextPage)
        const sent = decodeAuthorTextPropertyTextQuery(decodeFrame(found.response.request().postDataBuffer(), FrameType.AuthorTextPropertyTextQuery).payload)
        assert.equal(sent.search.query, `status:draft ${textMarker}`)
        assert.equal(sent.search.schema, eligible.schemaRevision)
        assert.equal(sent.definitionId, fields.subtitle.definitionId)
        assert.equal(sent.definitionRevision, eligible.revision)
        assert(found.page.rows.every(row => row.field === 'property-text' && row.snippet.slice(row.highlightStart, row.highlightEnd) === textMarker))
        return { ...found, query: sent }
      }

      async function submitSearch(frame, decode) {
        for (let attempt = 0; attempt < 16; attempt++) {
          const waiting = page.waitForResponse(searchReply)
          await (attempt ? form.getByRole('button', { name: '继续搜索', exact: true }) : submit).click()
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
