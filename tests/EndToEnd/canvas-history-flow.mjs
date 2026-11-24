import assert from 'node:assert/strict'
import { decodeCanvasGraphHistory } from '../../src/Contracts/canvas-graph.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { canvasFixture, createCanvasThroughUi } from './browser-authoring-fixture.mjs'
import { getFrame } from './response-status-fixture.mjs'
import { exactButton, exactText, roleWithExactName } from './role-locators.mjs'

export async function exerciseCanvasHistory({ page, origin, screenshot, observations, monitor }) {
  const author = await page.context().newPage()
  const stale = await page.context().newPage()
  monitor(author, 'canvas-history')
  monitor(stale, 'canvas-history-stale')
  const title = `Canvas history ${Date.now()}`
  const canvas = canvasFixture(author, origin)
  const button = (name, use = author) => exactButton(use, name)
  const heading = () => roleWithExactName(author, 'heading', title)
  const undo = () => button('Undo')
  const redo = () => button('Redo')
  const note = () => canvas.board().getByRole('button', { name: /History note/ })

  async function addNote(label) {
    await canvas.addNote(label)
    await canvas.board().getByRole('button', { name: new RegExp(label) }).waitFor()
  }

  async function history(revision) {
    const path = WireRoutes.CanvasGraphHistory.replace('{id:guid}', canvas.documentId())
    const value = await getFrame(author.request, `${origin}${path}?revision=${revision}`,
      FrameType.CanvasGraphHistory, decodeCanvasGraphHistory)
    assert.equal(value.revision, BigInt(revision))
    return value
  }

  async function assertState(revision, count) {
    await exactText(author, `Revision ${revision} · ${count}/${count} nodes · 0/0 edges`).waitFor()
    const graph = await canvas.graph()
    assert.equal(graph.header.revision, BigInt(revision))
    assert.equal(graph.nodes.length, count)
    return graph
  }

  try {
    await createCanvasThroughUi(author, origin, title)
    await heading().waitFor()
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
    await heading().waitFor()
    await redo().click({ trial: true })
    await redo().focus()
    await author.keyboard.press('Enter')
    await author.getByRole('status').filter({ hasText: 'Canvas change redone.' }).waitFor()
    assert.deepEqual((await assertState(5, 1)).nodes[0].geometry, moved)
    await author.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Interactive Canvas Viewport')

    await stale.goto(author.url())
    await button('Undo', stale).click({ trial: true })
    await canvas.board().focus()
    await author.keyboard.press('Control+z')
    assert.deepEqual((await assertState(6, 1)).nodes[0].geometry, original)
    await button('Undo', stale).click()
    await stale.getByRole('alert').filter({ hasText: 'The Canvas changed.' }).waitFor()
    assert.deepEqual((await canvas.graph()).nodes[0].geometry, original)
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
    await heading().waitFor()
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
