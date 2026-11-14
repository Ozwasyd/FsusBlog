import assert from 'node:assert/strict'
import test from 'node:test'
import { createInspectorFocus } from '../../src/Web/src/authoring/inspectorFocus.ts'

type Target = {
    name: string
    detached?: boolean
    hidden?: boolean
    disabled?: boolean
    internal?: boolean
}

function fixture() {
    const frames: { callback(): void; cancelled: boolean }[] = []
    const visited: string[] = []
    const launchers = {
        pane: { name: 'desktop' } as Target | null,
        drawer: { name: 'compact' } as Target | null,
    }
    const focus = createInspectorFocus<Target>({
        externalLauncher: (host) => launchers[host],
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
    return { focus, frames, visited, launchers }
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
    const { focus, frames, launchers, visited } = fixture()
    focus.open('pane', { name: 'removed desktop button', detached: true })
    const drawer = focus.rehost('drawer')!
    drawer.close()
    const result = drawer.closed()
    launchers.drawer = { name: 'replacement compact button' }
    frames[0]!.callback()
    assert.equal(await result, 'restored')
    assert.deepEqual(visited, ['replacement compact button'])
})

test('compact to desktop ignores old Drawer close signals and uses desktop on the next close', async () => {
    const { focus, frames, visited } = fixture()
    const drawer = focus.open('drawer', { name: 'hidden launcher', hidden: true })
    const pane = focus.rehost('pane')!
    assert.equal(drawer.close(), false)
    assert.equal(await drawer.closed(), 'cancelled')
    assert.equal(frames.length, 0)
    assert.equal(pane.close(), true)
    const result = pane.closed()
    frames[0]!.callback()
    assert.equal(await result, 'restored')
    assert.deepEqual(visited, ['desktop'])
})

for (const state of ['hidden', 'detached', 'disabled', 'internal'] as const) {
    test(`an opener that is ${state} does not receive restored focus`, async () => {
        const { focus, frames, visited } = fixture()
        const pane = focus.open('pane', { name: 'opener', [state]: true })
        pane.close()
        const result = pane.closed()
        frames[0]!.callback()
        assert.equal(await result, 'restored')
        assert.deepEqual(visited, ['desktop'])
    })
}

test('reopening cancels waiters and a late frame from the previous opening', async () => {
    const { focus, frames, visited } = fixture()
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
    const result = replacement.closed()
    frames[1]!.callback()
    assert.equal(await result, 'restored')
    assert.deepEqual(visited, ['second'])
})

test('resize during a pending close schedules recovery against the replacement host', async () => {
    const { focus, frames, visited } = fixture()
    const drawer = focus.open('drawer')
    drawer.close()
    const abandoned = drawer.closed()
    const pane = focus.rehost('pane')!
    assert.equal(await abandoned, 'cancelled')
    assert.equal(frames[0]!.cancelled, true)
    assert.equal(await drawer.closed(), 'cancelled')
    frames[0]!.callback()
    assert.deepEqual(visited, [])
    const result = pane.closed()
    frames[1]!.callback()
    assert.equal(await result, 'restored')
    assert.deepEqual(visited, ['desktop'])
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
    const { focus, frames, launchers, visited } = fixture()
    launchers.drawer = null
    const drawer = focus.open('drawer')
    drawer.close()
    const result = drawer.closed()
    frames[0]!.callback()
    assert.equal(await result, 'unavailable')
    assert.deepEqual(visited, [])
})
