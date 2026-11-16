import { createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import assert from 'node:assert/strict'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasGraphHistory, decodeCanvasGraphPage } from '../../src/Contracts/canvas-graph.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

export async function exerciseCanvasHistory({ page, origin, screenshot, observations, monitor }) {
  const author = await page.context().newPage()
  const stale = await page.context().newPage()
  monitor(author, 'canvas-history')
  monitor(stale, 'canvas-history-stale')
  const title = `Canvas history ${Date.now()}`
  const button = (name, use = author) => use.getByRole('button', { name, exact: true })
  const dialog = name => author.getByRole('dialog', { name, exact: true })
  const viewport = () => author.getByRole('region', { name: 'Interactive Canvas Viewport' })
  const undo = () => button('Undo')
  const redo = () => button('Redo')
  const note = () => viewport().getByRole('button', { name: /History note/ })

  async function addNote(label) {
    await button('Add note').click()
    const add = dialog('Add node')
    await add.getByLabel('Note text').fill(label)
    await add.getByRole('button', { name: 'Save node', exact: true }).click()
    await viewport().getByRole('button', { name: new RegExp(label) }).waitFor()
    await add.waitFor({ state: 'hidden' })
  }

  async function state() {
    const id = new URL(author.url()).pathname.split('/').at(-1)
    const response = await author.request.get(origin + WireRoutes.CanvasGraphPage.replace('{id:guid}', id))
    assert.equal(response.status(), 200)
    return decodeCanvasGraphPage(decodeFrame(await response.body(), FrameType.CanvasGraphPage).payload)
  }

  async function history(revision) {
    const id = new URL(author.url()).pathname.split('/').at(-1)
    const path = WireRoutes.CanvasGraphHistory.replace('{id:guid}', id)
    const response = await author.request.get(`${origin}${path}?revision=${revision}`)
    assert.equal(response.status(), 200)
    const value = decodeCanvasGraphHistory(decodeFrame(await response.body(), FrameType.CanvasGraphHistory).payload)
    assert.equal(value.revision, BigInt(revision))
    return value
  }

  async function assertState(revision, count) {
    await author.getByText(`Revision ${revision} · ${count}/${count} nodes · 0/0 edges`, { exact: true }).waitFor()
    const graph = await state()
    assert.equal(graph.header.revision, BigInt(revision))
    assert.equal(graph.nodes.length, count)
    return graph
  }

  try {
    await createCanvasThroughUi(author, origin, title)
    await author.getByRole('heading', { name: title, exact: true }).waitFor()
    await assertState(1, 0)
    assert.deepEqual(await history(1), { revision: 1n, undoRevision: null, redoRevision: null })
    assert(await undo().isDisabled())
    assert(await redo().isDisabled())

    await addNote('History note')
    const original = (await assertState(2, 1)).nodes[0].geometry
    assert(await redo().isDisabled())
    await note().focus()
    await author.keyboard.press('Enter')
    await author.keyboard.press('ArrowRight')
    const moved = (await assertState(3, 1)).nodes[0].geometry
    assert.equal(moved.x, original.x + 800)

    await undo().click()
    await author.getByRole('status').filter({ hasText: 'Canvas change undone.' }).waitFor()
    assert.deepEqual((await assertState(4, 1)).nodes[0].geometry, original)
    await author.reload()
    await author.getByRole('heading', { name: title, exact: true }).waitFor()
    await redo().click({ trial: true })
    await redo().focus()
    await author.keyboard.press('Enter')
    await author.getByRole('status').filter({ hasText: 'Canvas change redone.' }).waitFor()
    assert.deepEqual((await assertState(5, 1)).nodes[0].geometry, moved)
    await author.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Interactive Canvas Viewport')

    await stale.goto(author.url())
    await button('Undo', stale).click({ trial: true })
    await viewport().focus()
    await author.keyboard.press('Control+z')
    assert.deepEqual((await assertState(6, 1)).nodes[0].geometry, original)
    await button('Undo', stale).click()
    await stale.getByRole('alert').filter({ hasText: 'The Canvas changed.' }).waitFor()
    assert.deepEqual((await state()).nodes[0].geometry, original)
    await button('Reload Canvas', stale).click()
    await button('Redo', stale).click({ trial: true })

    await addNote('New branch')
    await assertState(7, 2)
    assert.equal((await history(7)).redoRevision, null)
    await undo().click({ trial: true })
    assert(await redo().isDisabled())
    await screenshot(author, 'canvas-history-desktop')
    await author.setViewportSize({ width: 375, height: 850 })
    await author.reload()
    await author.getByRole('heading', { name: title, exact: true }).waitFor()
    assert(await redo().isDisabled())
    await undo().click()
    await assertState(8, 1)
    await redo().click()
    await assertState(9, 2)
    await screenshot(author, 'canvas-history-mobile')
    observations.push('Canvas history survives reload, restores geometry from committed revisions, refuses a stale browser tab, and clears redo on a new branch.')
  } catch (error) {
    await screenshot(author, 'canvas-history-failed').catch(() => {})
    throw error
  } finally {
    await author.close()
    await stale.close()
  }
}
