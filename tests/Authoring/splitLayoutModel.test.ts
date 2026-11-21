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
} from '../../src/Web/src/authoring/splitLayoutModel.ts'

test('split layout metrics enforce 29rem minimums, 30% clamp, and wide-area threshold', () => {
  const narrow = computeSplitLayoutMetrics({
    width: 900,
    rem: 16,
    preferredPrimaryWidth: defaultPrimaryWidth,
    twoSources: true,
    comparisonReady: true,
  })
  assert.equal(narrow.trackWidth, 900 - splitterWidthRem * 16)
  assert.equal(narrow.minimumShare, Math.ceil(100 * minimumEditorWidthRem * 16 / (900 - 16)))
  assert.equal(narrow.wideEditorArea, false)
  assert.equal(narrow.showComparison, false)
  assert.equal(narrow.splitColumns, undefined)

  const exactWide = computeSplitLayoutMetrics({
    width: (2 * minimumEditorWidthRem + splitterWidthRem) * 16,
    rem: 16,
    preferredPrimaryWidth: 50,
    twoSources: true,
    comparisonReady: true,
  })
  assert.equal(exactWide.minimumShare, 50)
  assert.equal(exactWide.wideEditorArea, true)
  assert.equal(exactWide.showComparison, true)
  assert.equal(exactWide.primaryWidth, 50)
  assert.equal(exactWide.splitColumns, 'minmax(0, 50fr) 1rem minmax(0, 50fr)')

  const ultraWide = computeSplitLayoutMetrics({
    width: 2400,
    rem: 16,
    preferredPrimaryWidth: 10,
    twoSources: true,
    comparisonReady: true,
  })
  assert.equal(ultraWide.minimumShare, 30)
  assert.equal(ultraWide.primaryWidth, 30)
  assert.equal(ultraWide.splitColumns, 'minmax(0, 30fr) 1rem minmax(0, 70fr)')

  const unready = computeSplitLayoutMetrics({
    width: 1440,
    rem: 16,
    preferredPrimaryWidth: 50,
    twoSources: true,
    comparisonReady: false,
  })
  assert.equal(unready.wideEditorArea, true)
  assert.equal(unready.showComparison, false)
  assert.equal(unready.splitColumns, undefined)
})

test('pointer resize controller validates primary left button, tracks LTR/RTL drag, clamps, and cancels cleanly', () => {
  const controller = createSplitResizeController()
  assert.equal(controller.isActive(), false)

  // Rejects non-primary, secondary mouse button, hidden comparison, or invalid track width.
  assert.equal(controller.start(
    { pointerId: 1, isPrimary: false, button: 0, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000 },
  ), false)
  assert.equal(controller.start(
    { pointerId: 1, isPrimary: true, button: 2, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000 },
  ), false)
  assert.equal(controller.start(
    { pointerId: 1, isPrimary: true, button: 0, clientX: 500 },
    { showComparison: false, primaryWidth: 50, direction: 1, trackWidth: 1000 },
  ), false)
  assert.equal(controller.start(
    { pointerId: 1, isPrimary: true, button: 0, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 0 },
  ), false)

  // LTR drag starts, ignores concurrent second pointer, clamps within [38, 62].
  assert.equal(controller.start(
    { pointerId: 7, isPrimary: true, button: 0, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000 },
  ), true)
  assert.equal(controller.isActive(), true)
  assert.equal(controller.start(
    { pointerId: 8, isPrimary: true, button: 0, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000 },
  ), false)
  assert.equal(controller.move({ pointerId: 8, clientX: 600 }, { showComparison: true, minimumShare: 38 }), undefined)
  assert.equal(controller.move({ pointerId: 7, clientX: 580 }, { showComparison: true, minimumShare: 38 }), 58)
  assert.equal(controller.move({ pointerId: 7, clientX: 900 }, { showComparison: true, minimumShare: 38 }), 62)
  assert.equal(controller.move({ pointerId: 7, clientX: 100 }, { showComparison: true, minimumShare: 38 }), 38)
  assert.equal(controller.end(8), false)
  assert.equal(controller.isActive(), true)
  assert.equal(controller.end(7), true)
  assert.equal(controller.isActive(), false)
  assert.equal(controller.move({ pointerId: 7, clientX: 600 }, { showComparison: true, minimumShare: 38 }), undefined)

  // RTL drag inverts delta sign and cancel clears active pointer on layout collapse.
  assert.equal(controller.start(
    { pointerId: 9, isPrimary: true, button: 0, clientX: 500 },
    { showComparison: true, primaryWidth: 50, direction: -1, trackWidth: 1000 },
  ), true)
  assert.equal(controller.move({ pointerId: 9, clientX: 400 }, { showComparison: true, minimumShare: 35 }), 60)
  controller.cancel()
  assert.equal(controller.isActive(), false)
  assert.equal(controller.move({ pointerId: 9, clientX: 350 }, { showComparison: true, minimumShare: 35 }), undefined)
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
