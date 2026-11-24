import assert from 'node:assert/strict'
import { WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { canvasFixture, createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import { exerciseCanvasBundle } from './canvas-bundle-flow.mjs'
import { exerciseCanvasReferences } from './canvas-reference-flow.mjs'
import { assertStatus } from './response-status-fixture.mjs'
import { waitForPathResponse } from './response-wait-fixture.mjs'
import * as loc from './role-locators.mjs'

export async function exerciseCanvas({ page, origin, targetArticle, createDraft, screenshot, observations, monitor }) {
  const client = await page.context().newPage()
  monitor(client, 'canvas')
  const other = await page.context().newPage()
  monitor(other, 'canvas-stale')
  const title = `Browser planning ${Date.now()}`
  const sourceBody = 'Unchanged article source before link review.\n\n# Planning ^planning\n\nReview later. ^later'
  const source = await createDraft('Canvas draft source', sourceBody)
  const canvas = canvasFixture(client, origin)
  const button = (name, tab = client) => loc.exactButton(tab, name)
  const heading = (name, tab = client) => loc.exactHeading(tab, name)
  const draft = () => canvas.draft(source.id)
  const state = (offset = 0, revision) => canvas.graph(undefined, offset, revision)

  async function addReference(kind, options, label) {
    await canvas.addReference(kind, options)
    await loc.exactButton(canvas.outline(), label).waitFor()
  }

  async function connectToTarget(label, edgeType) {
    await loc.exactButton(canvas.outline(), `Article reference ${source.id}`).click()
    await button('Connect').click()
    const connect = canvas.dialog('Connect nodes')
    await connect.getByLabel('Target node').selectOption({ label: `Article reference ${targetArticle.id}` })
    if (edgeType) await connect.getByLabel('Edge type').selectOption(edgeType)
    await connect.getByLabel('Edge label (optional)').fill(label)
    await loc.exactButton(connect, 'Save edge').click()
    await loc.exactButton(canvas.outline(), label).click()
  }

  try {
    await createCanvasThroughUi(client, origin, title)
    await heading(title).waitFor()
    assert.equal((await state()).header.revision, 1n)
    await canvas.assertAnonymousDenied(client.url(), title, WireRoutes.CanvasGraphList)

    await canvas.addNote('Private spatial note')
    const node = canvas.board().getByRole('button', { name: /Private spatial note/ })
    await node.waitFor()
    await node.scrollIntoViewIfNeeded()
    await node.click({ trial: true })
    const box = await node.boundingBox()
    assert(box)
    await client.mouse.move(box.x + 20, box.y + 20)
    await client.mouse.down()
    await client.mouse.move(box.x + 72, box.y + 55, { steps: 5 })
    const moved = waitForPathResponse(client, () => WireRoutes.CanvasGraphWrite, 'POST')
    await client.mouse.up()
    assertStatus(await moved, 200)
    await loc.exactText(client, 'Revision 3 · 1/1 nodes · 0/0 edges').waitFor()
    assert.deepEqual((await state()).nodes[0].geometry, { x: 8700, y: 7000, width: 17000, height: 10000 })
    await node.focus()
    await client.keyboard.press('Enter')
    await client.keyboard.press('ArrowRight')
    await loc.exactText(client, 'Revision 4 · 1/1 nodes · 0/0 edges').waitFor()
    assert.equal((await state()).nodes[0].geometry.x, 9500)
    await screenshot(client, 'canvas-workspace-desktop')

    await other.goto(client.url())
    await button('Rename Canvas', other).waitFor()
    await button('Outline').click()
    await addReference(undefined, { articleId: source.id }, `Article reference ${source.id}`)
    await addReference(undefined, { articleId: targetArticle.id }, `Article reference ${targetArticle.id}`)
    await addReference('heading-reference', { articleId: source.id, anchor: 'planning' }, `Heading reference ${source.id}`)
    await addReference('block-reference', { articleId: source.id, anchor: 'later', pinned: source.revision }, `Block reference ${source.id}`)
    await button('Add frame').click()
    const add = canvas.dialog('Add node')
    await add.getByLabel('Frame name').fill('Planning frame')
    await loc.exactLabel(add, 'Loaded frame members').selectOption({ label: 'Private spatial note' })
    await loc.exactButton(add, 'Save node').click()
    await loc.exactButton(canvas.outline(), 'Planning frame').click()
    await loc.exactText(client, '1 member').waitFor()

    await connectToTarget('Visual planning line')
    assert.equal(await button('Review article link').count(), 0)
    const review = canvas.dialog('Review article link')
    await button('Review visual connection').click()
    await loc.exactText(review, 'Use the selected visual connection as an article link. The connection stays in the Canvas.').waitFor()
    await loc.exactButton(review, 'Cancel').click()
    await review.waitFor({ state: 'hidden' })
    assert.equal((await draft()).body, sourceBody)
    await connectToTarget('Article source link', 'explicit-reference-note')
    await button('Review article link').click()
    await loc.exactText(review, `Add this Markdown to the end of article ${source.id}'s private draft.`).waitFor()
    assert((await review.locator('pre').innerText()).endsWith(`](/article/${targetArticle.id})`))
    await loc.exactButton(review, 'Cancel').click()
    assert.equal((await draft()).body, sourceBody)
    await button('Review article link').click()
    await loc.exactButton(review, 'Confirm link').click()
    await client.getByRole('status').filter({ hasText: 'Link added to a new article draft.' }).waitFor()
    const linked = await draft()
    assert.equal(linked.revision, source.revision + 1n)
    assert(linked.body.startsWith(sourceBody))
    assert(linked.body.endsWith(`](/article/${targetArticle.id})`))

    await loc.exactButton(canvas.outline(), 'Visual planning line').click()
    const selectedPreview = client.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === WireRoutes.CanvasPreview && url.searchParams.get('edge') === 'visual-only'
    })
    await button('Review visual connection').click()
    assertStatus(await selectedPreview, 200)
    const visualInsertion = await review.locator('pre').textContent()
    assert(visualInsertion.endsWith(`](/article/${targetArticle.id})`))
    assert.equal((await draft()).body, linked.body)
    const visualConfirm = waitForPathResponse(client, () => WireRoutes.CanvasConfirm)
    await loc.exactButton(review, 'Confirm link').click()
    assertStatus(await visualConfirm, 200)
    await review.waitFor({ state: 'hidden' })
    const visualLinked = await draft()
    assert.equal(visualLinked.revision, linked.revision + 1n)
    assert.equal(visualLinked.body, linked.body + visualInsertion)
    const nodePage = await state()
    assert(nodePage.nextOffset !== null)
    const edgePage = await state(nodePage.nextOffset, nodePage.header.revision)
    assert.equal(edgePage.edges.find(edge => edge.label === 'Visual planning line')?.kind, 'visual-only')

    await button('Rename Canvas', other).click()
    const rename = loc.exactDialog(other, 'Rename Canvas')
    await rename.getByLabel('Canvas title').fill('Stale rename')
    await loc.exactButton(rename, 'Save Canvas').click()
    await rename.getByRole('alert').filter({ hasText: 'The Canvas changed.' }).waitFor()
    await other.keyboard.press('Escape')
    await button('Reload Canvas', other).click()
    await heading(title, other).waitFor()

    await client.setViewportSize({ width: 375, height: 850 })
    await client.reload()
    await heading(title).waitFor()
    await canvas.board().getByRole('button', { name: /Private spatial note/ }).waitFor()
    await canvas.board().focus()
    const panned = waitForPathResponse(client, () => WireRoutes.CanvasGraphWrite, 'POST')
    await client.keyboard.press('ArrowRight')
    assertStatus(await panned, 200)
    await client.getByRole('status').filter({ hasText: 'Canvas saved.' }).waitFor()
    assert.equal((await state()).header.viewport.x, 3200)
    await canvas.board().scrollIntoViewIfNeeded()
    await screenshot(client, 'canvas-workspace-mobile')
    await client.reload()
    await heading(title).waitFor()
    assert.equal((await state()).header.viewport.x, 3200)
    await button('Delete Canvas').click()
    await loc.exactButton(canvas.dialog('Delete Canvas'), 'Delete').click()
    await heading('Canvases').waitFor()
    assert.equal(await loc.exactLink(client, title).count(), 0)
    assert.equal((await draft()).body, visualLinked.body)
    await exerciseCanvasReferences({ page: client, origin, createDraft, screenshot, observations })
    await exerciseCanvasBundle({ page: client, origin, createDraft, screenshot, observations })
    observations.push('Canvas saves pointer and keyboard moves, all five node kinds and both edge kinds, previews without writing, confirms explicit and selected visual links while preserving their edge kinds, rejects a stale tab, reloads at 375px, and deletes only the Canvas.')
  } catch (error) {
    await screenshot(client, 'canvas-failed').catch(() => {})
    throw error
  } finally {
    await client.close()
    await other.close()
  }
}
