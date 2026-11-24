import assert from 'node:assert/strict'
import test from 'node:test'
import { createInspectorFocus } from '../../src/Web/src/authoring/inspectorFocus.ts'
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
import { expectFields } from './authoringFixture.ts'

type Target = { name: string; detached?: boolean; hidden?: boolean; disabled?: boolean; internal?: boolean }

function fixture() {
  const frames: { callback(): void; cancelled: boolean }[] = []
  const visited: string[] = []
  const launchers = { pane: { name: 'desktop' } as Target | null, drawer: { name: 'compact' } as Target | null }
  const focus = createInspectorFocus<Target>({
    externalLauncher: host => launchers[host],
    restore(target) {
      if (target.detached || target.hidden || target.disabled || target.internal) return false
      visited.push(target.name)
      return true
    },
    afterRender(callback) {
      const frame = { callback, cancelled: false }
      frames.push(frame)
      return () => { frame.cancelled = true }
    },
  })
  const settle = async (handle: { closed(): Promise<string> }, expected: string, names: string[], frameIndex = 0) => {
    const result = handle.closed()
    frames[frameIndex]!.callback()
    assert.equal(await result, expected)
    assert.deepEqual(visited, names)
  }
  return { focus, frames, visited, launchers, settle }
}

test('a reachable exact opener survives a responsive host change', async () => {
  const { focus, frames, visited } = fixture()
  const original = focus.open('pane', { name: 'exact opener' })
  const drawer = focus.rehost('drawer')!
  assert.equal(original.close(), false)
  assert.equal(await original.closed(), 'cancelled')
  assert.equal(drawer.close(), true)
  const result = drawer.closed()
  assert.equal(drawer.closed(), result)
  assert.deepEqual(visited, [])
  frames[0]!.callback()
  assert.equal(await result, 'restored')
  assert.deepEqual(visited, ['exact opener'])
})

test('desktop to compact uses the newly mounted external launcher after the leave', async () => {
  const { focus, launchers, settle } = fixture()
  focus.open('pane', { name: 'removed desktop button', detached: true })
  const drawer = focus.rehost('drawer')!
  drawer.close()
  launchers.drawer = { name: 'replacement compact button' }
  await settle(drawer, 'restored', ['replacement compact button'])
})

test('compact to desktop ignores old Drawer close signals and uses desktop on the next close', async () => {
  const { focus, frames, settle } = fixture()
  const drawer = focus.open('drawer', { name: 'hidden launcher', hidden: true })
  const pane = focus.rehost('pane')!
  assert.equal(drawer.close(), false)
  assert.equal(await drawer.closed(), 'cancelled')
  assert.equal(frames.length, 0)
  assert.equal(pane.close(), true)
  await settle(pane, 'restored', ['desktop'])
})

for (const state of ['hidden', 'detached', 'disabled', 'internal'] as const) {
  test(`an opener that is ${state} does not receive restored focus`, async () => {
    const { focus, settle } = fixture()
    const pane = focus.open('pane', { name: 'opener', [state]: true })
    pane.close()
    await settle(pane, 'restored', ['desktop'])
  })
}

test('reopening cancels waiters and a late frame from the previous opening', async () => {
  const { focus, frames, visited, settle } = fixture()
  const drawer = focus.open('drawer', { name: 'first' })
  drawer.close()
  const abandoned = drawer.closed()
  const replacement = focus.open('drawer', { name: 'second' })
  assert.equal(await abandoned, 'cancelled')
  assert.equal(frames[0]!.cancelled, true)
  frames[0]!.callback()
  assert.deepEqual(visited, [])
  assert.equal(drawer.close(), false)
  assert.equal(replacement.close(), true)
  await settle(replacement, 'restored', ['second'], 1)
})

test('resize during a pending close schedules recovery against the replacement host', async () => {
  const { focus, frames, visited, settle } = fixture()
  const drawer = focus.open('drawer')
  drawer.close()
  const abandoned = drawer.closed()
  const pane = focus.rehost('pane')!
  assert.equal(await abandoned, 'cancelled')
  assert.equal(frames[0]!.cancelled, true)
  assert.equal(await drawer.closed(), 'cancelled')
  frames[0]!.callback()
  assert.deepEqual(visited, [])
  await settle(pane, 'restored', ['desktop'], 1)
})

test('disposal settles outstanding waiters while late callbacks leave focus alone', async () => {
  const { focus, frames, visited } = fixture()
  const pane = focus.open('pane')
  pane.close()
  const result = pane.closed()
  focus.dispose()
  frames[0]!.callback()
  assert.equal(await result, 'cancelled')
  assert.equal(frames[0]!.cancelled, true)
  assert.equal(focus.rehost('drawer'), null)
  assert.deepEqual(visited, [])
})

test('an unavailable external launcher leaves focus alone', async () => {
  const { focus, launchers, settle } = fixture()
  launchers.drawer = null
  const drawer = focus.open('drawer')
  drawer.close()
  await settle(drawer, 'unavailable', [])
})

test('split layout metrics, pointer resize, and keyboard resize enforce bounds and LTR/RTL direction', () => {
  const measure = (width: number, preferredPrimaryWidth: number, comparisonReady = true) =>
    computeSplitLayoutMetrics({ width, rem: 16, preferredPrimaryWidth, twoSources: true, comparisonReady })
  expectFields(measure(900, defaultPrimaryWidth), {
    trackWidth: 900 - splitterWidthRem * 16,
    minimumShare: Math.ceil(100 * minimumEditorWidthRem * 16 / (900 - 16)),
    wideEditorArea: false, showComparison: false, splitColumns: undefined,
  })
  expectFields(measure((2 * minimumEditorWidthRem + splitterWidthRem) * 16, 50), {
    minimumShare: 50, wideEditorArea: true, showComparison: true, primaryWidth: 50,
    splitColumns: 'minmax(0, 50fr) 1rem minmax(0, 50fr)',
  })
  expectFields(measure(2400, 10), { minimumShare: 30, primaryWidth: 30, splitColumns: 'minmax(0, 30fr) 1rem minmax(0, 70fr)' })
  expectFields(measure(1440, 50, false), { wideEditorArea: true, showComparison: false, splitColumns: undefined })

  const controller = createSplitResizeController()
  const start = (pointerId: number, pointer: Partial<SplitPointerStart> = {}, track: Partial<SplitResizeStartContext> = {}) =>
    controller.start({ pointerId, isPrimary: true, button: 0, clientX: 500, ...pointer },
      { showComparison: true, primaryWidth: 50, direction: 1, trackWidth: 1000, ...track })
  const move = (pointerId: number, clientX: number, minimumShare: number) =>
    controller.move({ pointerId, clientX }, { showComparison: true, minimumShare })
  assert.equal(controller.isActive(), false)
  for (const [ptr, trk] of [[{ isPrimary: false }, {}], [{ button: 2 }, {}], [{}, { showComparison: false }], [{}, { trackWidth: 0 }]] as const)
    assert.equal(start(1, ptr, trk), false)

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

  assert.equal(start(9, {}, { direction: -1 }), true)
  assert.equal(move(9, 400, 35), 60)
  controller.cancel()
  assert.equal(controller.isActive(), false)
  assert.equal(move(9, 350, 35), undefined)

  const baseKey = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
  const ltr = { showComparison: true, primaryWidth: 50, minimumShare: 37, direction: 1 as const }
  const rtl = { ...ltr, direction: -1 as const }
  for (const [key, ctx, expected] of [
    [{ key: 'ArrowRight' }, ltr, 51], [{ key: 'ArrowLeft' }, ltr, 49], [{ key: 'Home' }, ltr, 37],
    [{ key: 'End' }, ltr, 63], [{ key: 'ArrowRight' }, rtl, 49], [{ key: 'ArrowLeft' }, rtl, 51],
    [{ key: 'Enter' }, ltr, undefined], [{ key: 'ArrowRight', shiftKey: true }, ltr, undefined],
    [{ key: 'ArrowRight' }, { ...ltr, showComparison: false }, undefined],
  ] as const) assert.equal(resolveKeyboardResize({ ...baseKey, ...key }, ctx), expected)
  assert.equal(clampPrimaryWidth(49.6, 35), 50)
})
