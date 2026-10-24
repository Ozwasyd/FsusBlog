import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePublicPageLifecycle } from '@/composables/usePublicPageLifecycle'

const cleanups: (() => void)[] = []

function mountLifecycle(options?: Parameters<typeof usePublicPageLifecycle>[0]) {
  let api: ReturnType<typeof usePublicPageLifecycle> | undefined
  const wrapper = mount(defineComponent({
    setup() {
      api = usePublicPageLifecycle(options)
      return () => null
    }
  }))
  if (!api) throw new Error('usePublicPageLifecycle was not created')
  // Settle DOM mount housekeeping before measuring the explicit sync timers.
  vi.runOnlyPendingTimers()
  const lifecycle = api
  cleanups.push(() => {
    if (lifecycle.isActive()) wrapper.unmount()
  })
  return { wrapper, api: lifecycle }
}

describe('usePublicPageLifecycle scheduled sync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Keep the DOM's numeric timer handles while advancing Node-hosted fake time.
    const domWindow: Window = window
    vi.spyOn(domWindow, 'setTimeout').mockImplementation((handler: TimerHandler, delay?: number) => {
      if (typeof handler !== 'function') throw new Error('expected a timer callback')
      return Number(globalThis.setTimeout(() => handler(), delay))
    })
  })

  afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup())
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('replaces a pending debounce and runs only the latest callback at its requested delay', () => {
    const { api } = mountLifecycle({ debounceMs: 50 })
    const first = vi.fn()
    const latest = vi.fn()
    expect(api.isActive()).toBe(true)
    api.scheduleSync(first)
    vi.advanceTimersByTime(20)
    api.scheduleSync(latest, 40)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(39)
    expect(first).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(latest).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending sync idempotently and allows a new sync with the default delay', () => {
    const { api } = mountLifecycle()
    const cancelled = vi.fn()
    const next = vi.fn()
    api.scheduleSync(cancelled)
    api.cancelScheduledSync()
    api.cancelScheduledSync()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(500)
    expect(cancelled).not.toHaveBeenCalled()
    api.scheduleSync(next)
    vi.advanceTimersByTime(499)
    expect(next).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('cancels pending work and disposes once on unmount, then suppresses inactive callbacks', () => {
    const onDispose = vi.fn()
    const { wrapper, api } = mountLifecycle({ onDispose })
    const callback = vi.fn()
    api.runIfActive(callback)
    expect(callback).toHaveBeenCalledTimes(1)
    callback.mockClear()
    api.scheduleSync(callback)
    wrapper.unmount()
    expect(api.isMounted.value).toBe(false)
    expect(api.isActive()).toBe(false)
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(500)
    expect(callback).not.toHaveBeenCalled()
    api.runIfActive(callback)
    api.scheduleSync(callback, 10)
    vi.advanceTimersByTime(10)
    expect(callback).not.toHaveBeenCalled()
    expect(onDispose).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
