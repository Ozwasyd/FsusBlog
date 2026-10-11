import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, effectScope } from 'vue'
import { useAbortableTask } from '@/composables/useAbortableTask'
import { createArticleDocumentContextAdapter } from '@/services/authoring/articleDocumentContext'

// Helper to mount composable in a component context
function useComposable() {
  return useAbortableTask()
}

describe('useAbortableTask', () => {
  it('initial state: isRunning is false', () => {
    const task = useAbortableTask()
    expect(task.isRunning.value).toBe(false)
    expect(task.currentSignal.value).toBeNull()
  })

  it('run sets isRunning to true while executing', async () => {
    const task = useAbortableTask()
    let resolveTask!: (v: string) => void
    const promise = new Promise<string>(resolve => { resolveTask = resolve })

    const runPromise = task.run(() => promise)
    expect(task.isRunning.value).toBe(true)
    expect(task.currentSignal.value).not.toBeNull()

    resolveTask('done')
    const result = await runPromise
    expect(result).toBe('done')
    expect(task.isRunning.value).toBe(false)
  })

  it('cancel aborts the current task', async () => {
    const task = useAbortableTask()
    let capturedSignal!: AbortSignal
    const promise = new Promise<string>((_resolve, reject) => {
      // resolve never, simulating a hanging task
    })

    task.run((signal) => {
      capturedSignal = signal
      return promise
    })

    expect(task.isRunning.value).toBe(true)
    task.cancel()
    expect(capturedSignal.aborted).toBe(true)
    expect(task.isRunning.value).toBe(false)
  })

  it('run cancels previous task when called again', async () => {
    const task = useAbortableTask()
    let firstSignal!: AbortSignal

    // Start first run
    task.run((signal) => {
      firstSignal = signal
      return new Promise(() => {}) // never resolves
    })

    // Start second run - should cancel first
    const secondPromise = task.run(() => Promise.resolve('second'))
    expect(firstSignal.aborted).toBe(true)

    const result = await secondPromise
    expect(result).toBe('second')
  })

  it('cancel does nothing when no task is running', () => {
    const task = useAbortableTask()
    expect(() => task.cancel()).not.toThrow()
    expect(task.isRunning.value).toBe(false)
  })

  it('calls onUnmounted to cancel on component unmount', async () => {
    let taskApi!: ReturnType<typeof useAbortableTask>

    const Component = defineComponent({
      setup() {
        taskApi = useAbortableTask()
        return taskApi
      },
      template: '<div></div>'
    })

    const wrapper = mount(Component)

    let signal!: AbortSignal
    taskApi.run(s => { signal = s; return new Promise(() => {}) })
    expect(taskApi.isRunning.value).toBe(true)

    await wrapper.unmount()
    expect(signal.aborted).toBe(true)
  })
})

// Source controls only: UNRUN under current runtime/test/list holds.
// Actual original lease/adapter and actual executor future; no settlement receipt is fabricated.
describe('original request future settlement custody', () => {
  const createOwner = () => createArticleDocumentContextAdapter({
    articleId: null, draftId: 'draft:request-settlement', editorSessionId: 'session:request-settlement',
    siteScope: 'primary-site', userScope: 'user:request-settlement', content: ''
  })

  it('retains a canceled original lease until its actual executor future finishes', async () => {
    const owner = createOwner()
    const task = useAbortableTask({ registry: owner, kind: 'refresh', producerRef: 'source:request-settlement' })
    let finish!: (value: string) => void
    const future = new Promise<string>(resolve => { finish = resolve })
    const run = task.run(() => future)
    const pending = owner.pendingTaskRefs
    expect(pending).toHaveLength(1)
    task.cancel()
    expect(owner.pendingTaskRefs).toEqual(pending)
    await task.run(() => Promise.resolve('newer'))
    expect(owner.pendingTaskRefs).toEqual(pending)
    finish('older')
    await run
    expect(owner.pendingTaskRefs).toEqual([])
  })

  it('does not treat scope stop as settlement while the actual rejected future is pending', async () => {
    const owner = createOwner()
    const scope = effectScope()
    const task = scope.run(() => useAbortableTask({ registry: owner, kind: 'refresh' }))!
    let fail!: (error: Error) => void
    const future = new Promise<never>((_resolve, reject) => { fail = reject })
    const run = task.run(() => future)
    const rejection = expect(run).rejects.toThrow('real-executor-failure')
    scope.stop()
    expect(owner.pendingTaskRefs).toHaveLength(1)
    fail(new Error('real-executor-failure'))
    await rejection
    expect(owner.pendingTaskRefs).toEqual([])
  })
})
