import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFrame } from '../../src/Contracts/aeds.ts'
import { decodeCanvasGraphPage } from '../../src/Contracts/canvas-graph.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'
import { signInFreshAdmin } from './webauthn-fixture.mjs'
import { observePageErrors, button, chromium, createCanvasThroughUi, expect } from './browser-authoring-fixture.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const diagnostics = [], observations = []
const browser = await chromium.launch({ executablePath: process.env.FSUSBLOG_TEST_CHROME })
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' })
  const page = observePageErrors(await context.newPage(), diagnostics)
  await signInFreshAdmin(page, origin, process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await createCanvasThroughUi(page, origin, `Keyboard ${width}`)
    const board = page.getByRole('region', { name: 'Interactive Canvas Viewport' })
    await expect(board).toBeVisible()
    const bounds = await board.boundingBox()
    const inspector = await page.getByRole('complementary', { name: 'Selected Canvas record' }).boundingBox()
    assert(bounds && inspector)
    if (width > 700) {
      assert(bounds.width > 600, 'Keyboard instructions must not displace the graph into the narrow inspector column')
      assert(inspector.x >= bounds.x + bounds.width, 'The inspector stays beside the graph')
    } else assert(bounds.width > 300 && bounds.x + bounds.width <= width)
    for (let i = 0; i < 3; i++) {
      await button(page, 'Add note').click()
      const form = page.getByRole('dialog', { name: 'Add node', exact: true })
      await form.getByLabel('Note text').fill(`Keyboard note ${i}`)
      await button(form, 'Save node').click()
      await expect(form).not.toBeVisible()
      await expect(board.getByRole('button')).toHaveCount(i + 1)
    }
    const state = async () => {
      const id = new URL(page.url()).pathname.split('/').at(-1)
      const response = await page.request.get(origin + WireRoutes.CanvasGraphPage.replace('{id:guid}', id))
      assert.equal(response.status(), 200)
      return decodeCanvasGraphPage(decodeFrame(await response.body(), FrameType.CanvasGraphPage).payload)
    }
    const before = await state(), nodes = board.getByRole('button')
    await expect(board).toHaveAccessibleDescription(/Page Up\/Down.*Enter\/Space/)
    await nodes.first().focus()
    await nodes.first().press('PageUp')
    await expect(nodes.first()).toBeFocused()
    await nodes.first().press('PageDown')
    await expect(nodes.nth(1)).toBeFocused()
    await expect(nodes.nth(1)).toHaveAccessibleDescription(/Use Outline/)
    await nodes.nth(1).press('PageDown')
    await expect(nodes.last()).toBeFocused()
    await nodes.last().press('PageDown')
    await expect(nodes.last()).toBeFocused()
    await nodes.last().press('Home')
    await expect(nodes.first()).toBeFocused()
    await nodes.first().press('End')
    await expect(nodes.last()).toBeFocused()
    await nodes.last().press('PageUp')
    await expect(nodes.nth(1)).toBeFocused()
    assert.deepEqual(await state(), before, 'Focus traversal must not write viewport, selection, geometry or revision')
    const middleId = (await nodes.nth(1).getAttribute('id')).replace('canvas-board-node-', '')
    const middle = page.locator(`#canvas-board-node-${middleId}`)
    await middle.press('Enter')
    await expect(middle).toHaveAttribute('aria-pressed', 'true')
    await middle.press('ArrowRight')
    await expect.poll(async () => (await state()).header.revision).toBe(before.header.revision + 1n)
    const after = await state()
    const oldNode = before.nodes.find(node => node.id === middleId)
    const moved = after.nodes.find(node => node.id === middleId)
    assert.equal(moved.geometry.x, oldNode.geometry.x + 800)
    await expect(middle).toBeEnabled()
    await middle.focus()
    await middle.press('Tab')
    assert.equal(await board.evaluate(element => element.contains(document.activeElement)), false, 'Tab exits the roving node group')
    await page.reload()
    await expect(board).toBeVisible()
    assert.deepEqual(await state(), after, 'Keyboard move survives real reload')
    await page.emulateMedia({ forcedColors: 'active' })
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(forced-colors: active)').matches), true)
    await nodes.first().focus()
    await nodes.first().press('PageDown')
    await expect(nodes.nth(1)).toBeFocused()
    await page.screenshot({ path: join(process.env.FSUSBLOG_TEST_EVIDENCE, `canvas-keyboard-${width}.png`), fullPage: true })
    await page.emulateMedia({ forcedColors: 'none' })
    observations.push({ width, nodes: 3, focusOnlyWrites: 0, persistedMoves: 1, reducedMotion: true, forcedColors: true })
  }
  assert.deepEqual(diagnostics, [])
  await writeFile(join(process.env.FSUSBLOG_TEST_EVIDENCE, 'canvas-keyboard.json'), JSON.stringify(observations, null, 2))
  await context.close()
} finally { await browser.close() }
