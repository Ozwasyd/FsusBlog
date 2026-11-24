import assert from 'node:assert/strict'
import { canvasFixture, createCanvasThroughUi, expect, observePageErrors } from './browser-authoring-fixture.mjs'
import * as isolated from './isolated-browser-fixture.mjs'
import { signInFreshAdmin } from './webauthn-fixture.mjs'

const origin = new URL(process.env.FSUSBLOG_TEST_URL).origin
const evidence = process.env.FSUSBLOG_TEST_EVIDENCE
const diagnostics = [], observations = []
const browser = await isolated.launchChrome()
try {
  await isolated.withTempContext(browser, { reducedMotion: 'reduce' }, async context => {
    const page = observePageErrors(await context.newPage(), diagnostics)
    const canvas = canvasFixture(page, origin)
    await signInFreshAdmin(page, origin, process.env.FSUSBLOG_TEST_AUTHOR_BOOTSTRAP)
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 })
      await createCanvasThroughUi(page, origin, `Keyboard ${width}`)
      const board = canvas.board()
      await expect(board).toBeVisible()
      const bounds = await board.boundingBox()
      const inspector = await page.getByRole('complementary', { name: 'Selected Canvas record' }).boundingBox()
      assert(bounds && inspector)
      if (width > 700) {
        assert(bounds.width > 600, 'Keyboard instructions must not displace the graph into the narrow inspector column')
        assert(inspector.x >= bounds.x + bounds.width, 'The inspector stays beside the graph')
      } else assert(bounds.width > 300 && bounds.x + bounds.width <= width)
      for (let i = 0; i < 3; i++) {
        await canvas.addNote(`Keyboard note ${i}`)
        await expect(board.getByRole('button')).toHaveCount(i + 1)
      }
      const before = await canvas.graph(), nodes = board.getByRole('button')
      await expect(board).toHaveAccessibleDescription(/Page Up\/Down.*Enter\/Space/)
      await nodes.first().focus()
      const steps = [[0, 'PageUp', 0], [0, 'PageDown', 1], [1, 'PageDown', 2], [2, 'PageDown', 2], [2, 'Home', 0], [0, 'End', 2], [2, 'PageUp', 1]]
      for (const [from, key, to] of steps) {
        await nodes.nth(from).press(key)
        await expect(nodes.nth(to)).toBeFocused()
        if (from === 0 && key === 'PageDown') await expect(nodes.nth(1)).toHaveAccessibleDescription(/Use Outline/)
      }
      assert.deepEqual(await canvas.graph(), before, 'Focus traversal must not write viewport, selection, geometry or revision')
      const middleId = (await nodes.nth(1).getAttribute('id')).replace('canvas-board-node-', '')
      const middle = page.locator(`#canvas-board-node-${middleId}`)
      await middle.press('Enter')
      await expect(middle).toHaveAttribute('aria-pressed', 'true')
      await middle.press('ArrowRight')
      await expect.poll(async () => (await canvas.graph()).header.revision).toBe(before.header.revision + 1n)
      const after = await canvas.graph()
      assert.equal(after.nodes.find(n => n.id === middleId).geometry.x, before.nodes.find(n => n.id === middleId).geometry.x + 800)
      await expect(middle).toBeEnabled()
      await middle.focus()
      await middle.press('Tab')
      assert.equal(await board.evaluate(element => element.contains(document.activeElement)), false, 'Tab exits the roving node group')
      await page.reload()
      await expect(board).toBeVisible()
      assert.deepEqual(await canvas.graph(), after, 'Keyboard move survives real reload')
      await page.emulateMedia({ forcedColors: 'active' })
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && matchMedia('(forced-colors: active)').matches), true)
      await nodes.first().focus()
      await nodes.first().press('PageDown')
      await expect(nodes.nth(1)).toBeFocused()
      await isolated.saveShot(page, evidence, `canvas-keyboard-${width}.png`, { fullPage: true })
      await page.emulateMedia({ forcedColors: 'none' })
      observations.push({ width, nodes: 3, focusOnlyWrites: 0, persistedMoves: 1, reducedMotion: true, forcedColors: true })
    }
    assert.deepEqual(diagnostics, [])
    await isolated.writeEvidenceJson(evidence, 'canvas-keyboard.json', observations, false)
  })
} finally { await browser.close() }
