import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useAbortableTask } from '@/composables/useAbortableTask'

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
