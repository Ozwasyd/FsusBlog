import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampPrimaryWidth,
  computeSplitLayoutMetrics,
  createSplitResizeController,
  defaultPrimaryWidth,
  minimumEditorWidthRem,
  resolveKeyboardResize,
  splitterWidthRem,
  type SplitPointerStart,
  type SplitResizeStartContext,
} from '../../src/Web/src/authoring/splitLayoutModel.ts'

test('split layout metrics enforce 29rem minimums, 30% clamp, and wide-area threshold', () => {
  function measure(width: number, preferredPrimaryWidth: number, comparisonReady = true) {
    return computeSplitLayoutMetrics({ width, rem: 16, preferredPrimaryWidth, twoSources: true, comparisonReady })
  }
  const narrow = measure(900, defaultPrimaryWidth)
  assert.equal(narrow.trackWidth, 900 - splitterWidthRem * 16)
  assert.equal(narrow.minimumShare, Math.ceil(100 * minimumEditorWidthRem * 16 / (900 - 16)))
  assert.equal(narrow.wideEditorArea, false)
  assert.equal(narrow.showComparison, false)
  assert.equal(narrow.splitColumns, undefined)

  const exactWide = measure((2 * minimumEditorWidthRem + splitterWidthRem) * 16, 50)
  assert.equal(exactWide.minimumShare, 50)
  assert.equal(exactWide.wideEditorArea, true)
  assert.equal(exactWide.showComparison, true)
  assert.equal(exactWide.primaryWidth, 50)
  assert.equal(exactWide.splitColumns, 'minmax(0, 50fr) 1rem minmax(0, 50fr)')

  const ultraWide = measure(2400, 10)
  assert.equal(ultraWide.minimumShare, 30)
  assert.equal(ultraWide.primaryWidth, 30)
  assert.equal(ultraWide.splitColumns, 'minmax(0, 30fr) 1rem minmax(0, 70fr)')

  const unready = measure(1440, 50, false)
  assert.equal(unready.wideEditorArea, true)
  assert.equal(unready.showComparison, false)
  assert.equal(unready.splitColumns, undefined)
})

test('pointer resize controller validates primary left button, tracks LTR/RTL drag, clamps, and cancels cleanly', () => {
  const controller = createSplitResizeController()
  function start(pointerId: number, pointer: Partial<SplitPointerStart> = {}, track: Partial<SplitResizeStartContext> = {}) {
    return controller.start({ pointerId, isPrimary: true, button: 0, clientX: 500, ...pointer },
      { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000, ...track })
  }
  function move(pointerId: number, clientX: number, minimumShare: number) {
    return controller.move({ pointerId, clientX }, { showComparison: true, minimumShare })
  }
  assert.equal(controller.isActive(), false)

  // Rejects non-primary, secondary mouse button, hidden comparison, or invalid track width.
  assert.equal(start(1, { isPrimary: false }), false)
  assert.equal(start(1, { button: 2 }), false)
  assert.equal(start(1, {}, { showComparison: false }), false)
  assert.equal(start(1, {}, { trackWidth: 0 }), false)

  // LTR drag starts, ignores concurrent second pointer, clamps within [38, 62].
  assert.equal(start(7), true)
  assert.equal(controller.isActive(), true)
  assert.equal(start(8), false)
  assert.equal(move(8, 600, 38), undefined)
  assert.equal(move(7, 580, 38), 58)
  assert.equal(move(7, 900, 38), 62)
  assert.equal(move(7, 100, 38), 38)
  assert.equal(controller.end(8), false)
  assert.equal(controller.isActive(), true)
  assert.equal(controller.end(7), true)
  assert.equal(controller.isActive(), false)
  assert.equal(move(7, 600, 38), undefined)

  // RTL drag inverts delta sign and cancel clears active pointer on layout collapse.
  assert.equal(start(9, {}, { direction: -1 }), true)
  assert.equal(move(9, 400, 35), 60)
  controller.cancel()
  assert.equal(controller.isActive(), false)
  assert.equal(move(9, 350, 35), undefined)
})

test('keyboard resize handles arrows, Home, End, LTR/RTL direction, and rejects modified keys', () => {
  const baseKey = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  const ltr = { showComparison: true, primaryWidth: 50, minimumShare: 37, direction: 1 as const }
  const rtl = { showComparison: true, primaryWidth: 50, minimumShare: 37, direction: -1 as const }

  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowRight' }, ltr), 51)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowLeft' }, ltr), 49)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'Home' }, ltr), 37)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'End' }, ltr), 63)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowRight' }, rtl), 49)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowLeft' }, rtl), 51)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'Enter' }, ltr), undefined)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowRight', shiftKey: true }, ltr), undefined)
  assert.equal(resolveKeyboardResize({ ...baseKey, key: 'ArrowRight' }, { ...ltr, showComparison: false }), undefined)
  assert.equal(clampPrimaryWidth(49.6, 35), 50)
})
