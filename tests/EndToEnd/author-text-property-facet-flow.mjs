import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { decodeFrame, encodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeAuthorTextPropertyFacetPage, decodeAuthorTextPropertyFacetQuery } from '../../src/Contracts/author-text-search.ts'
import { decodePropertyEditor, encodePropertyValueCommand } from '../../src/Contracts/property-values.ts'
import { decodePropertyCommandReceipt, encodePropertyWorkspaceRequest, FrameType, WireHeaders, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseAuthorTextPropertyFacet({ publisher, origin, monitor, observations, articleCommand }) {
  const marker = `facetprobe${randomUUID().replaceAll('-', '')}`
  const page = await publisher.context().newPage()
  const drafts = []
  let fields
  try {
    for (const [index, values] of [
      { approval: false, topics: ['Planning', 'Review'], stage: 'Ready' },
      { approval: null, topics: [], stage: null },
      {},
      { approval: true, topics: null, stage: 'On hold' },
    ].entries()) {
      const draft = await articleCommand(WireRoutes.Save, 0, 0n, `Typed facet draft ${index}`, `前言 🧭 ${marker}`)
      drafts.push(draft)
      const coordinates = { articleId: draft.id, articleRevision: draft.revision }
      const workspace = await command(publisher, origin, WireRoutes.PropertyEditor, FrameType.PropertyWorkspaceRequest,
        encodePropertyWorkspaceRequest({ ...coordinates, schemaRevision: 0n, valueRevision: 0n, afterKey: '' }),
        FrameType.PropertyEditor, decodePropertyEditor)
      fields ??= Object.fromEntries(['approval', 'topics', 'stage'].map(key => {
        const field = workspace.fields.find(item => item.machineKey === `editorial-${key}`)
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
          : { kind: 'single-select', value: id(stored) }
        const receipt = await command(publisher, origin, WireRoutes.PropertyValueCommand, FrameType.PropertyValueCommand,
          encodePropertyValueCommand({ ...coordinates, schemaRevision: workspace.schemaRevision, valueRevision,
            definitionId: field.definitionId, definitionRevision: field.definitionRevision, requestId: randomUUID(), value }),
          FrameType.PropertyCommandReceipt, decodePropertyCommandReceipt)
        assert.equal(receipt.definitionId, field.definitionId)
        assert.equal(receipt.revision, ++valueRevision)
      }
    }

    monitor(page, 'author-property-facet')
    await page.setViewportSize({ width: 375, height: 850 })
    await page.goto(`${origin}/user/manage/article/list`)
    await page.getByText('作者全文搜索', { exact: true }).click()
    const form = page.getByRole('form', { name: '作者全文搜索', exact: true })
    const catalog = page.waitForResponse(response => new URL(response.url()).pathname === WireRoutes.PropertyFilterCatalog)
    await form.getByText('全文搜索属性条件', { exact: true }).click()
    const catalogReply = await catalog
    assert.equal(catalogReply.status(), 200)
    const handle = catalogReply.request().headers()[WireHeaders.CurrentSession.toLowerCase()]
    assert(handle)
    const query = form.getByLabel('全文搜索词', { exact: true })
    await query.fill(marker)
    const selector = form.getByRole('combobox', { name: '属性分面字段', exact: true })
    const results = page.getByRole('region', { name: '全文搜索结果', exact: true })
    const facet = results.getByRole('region', { name: '属性分面', exact: true })
    const searchReply = response => new URL(response.url()).pathname === WireRoutes.AuthorTextSearch
    const submit = form.getByRole('button', { name: '搜索全文', exact: true })
    async function search(action = () => submit.click()) {
      for (let i = 0; i < 16; i++) {
        const request = page.waitForResponse(searchReply)
        await (i === 0 ? action() : form.getByRole('button', { name: '继续搜索', exact: true }).click())
        const response = await request
        assert.equal(response.status(), 200)
        const requestBytes = response.request().postDataBuffer()
        const body = decodeAuthorTextPropertyFacetQuery(decodeFrame(requestBytes, FrameType.AuthorTextPropertyFacetQuery).payload)
        assert.equal(body.search.query, marker)
        assert.equal(body.includeHeading, false)
        assert.equal(response.request().headers()[WireHeaders.CurrentSession.toLowerCase()], handle)
        const reply = decodeAuthorTextPropertyFacetPage(decodeFrame(await response.body(), FrameType.AuthorTextPropertyFacetPage).payload, false)
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
    const membership = await search(() => bucket('Review').click())
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
    observations.push('At 375px, real author search counts unset, explicit null, false and empty sets separately, uses current catalog labels, applies exact Boolean and option predicates, and rechecks the identical facet request before revealing saved source.')
  } finally {
    await page.close()
    for (const draft of drafts) await articleCommand(WireRoutes.Delete, draft.id, draft.revision, '', '', FrameType.EmptySuccess)
  }
}

async function command(publisher, origin, route, type, value, receipt, decode) {
  const response = await publisher.request.post(`${origin}${route}`, {
    data: Buffer.from(encodeFrame(type, value)), headers: { 'Content-Type': 'application/octet-stream' },
  })
  assert.equal(response.status(), 200, route)
  return decode(decodeFrame(await response.body(), receipt).payload)
}
