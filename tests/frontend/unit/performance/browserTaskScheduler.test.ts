import { describe, expect, it, vi } from 'vitest'
import { createBrowserTaskScheduler, type BrowserTaskSchedulerOptions } from '@/performance/browserTaskScheduler'

function environment(overrides: BrowserTaskSchedulerOptions['environment'] = {}) {
  let now = 10
  return {
    scheduler: null,
    now: () => now++,
    visibility: () => 'visible' as const,
    setTimer: (callback: () => void) => {
      queueMicrotask(callback)
      return 1
    },
    clearTimer: vi.fn(),
    ...overrides
  }
}

describe('browser task scheduler', () => {
  it('uses the native capability when available', async () => {
    const nativeYield = vi.fn().mockResolvedValue(undefined)
    const scheduler = createBrowserTaskScheduler({
      minimumIntervalMs: 0,
      environment: environment({ scheduler: { yield: nativeYield } })
    })

    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({
      path: 'native',
      nativeFailure: null,
      visibility: 'visible'
    })
    expect(nativeYield).toHaveBeenCalledOnce()
  })

  it('uses a timer fallback when the capability is absent', async () => {
    const scheduler = createBrowserTaskScheduler({ minimumIntervalMs: 0, environment: environment() })

    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({
      path: 'fallback',
      nativeFailure: null
    })
  })

  it('records a rejected native capability before falling back', async () => {
    const scheduler = createBrowserTaskScheduler({
      minimumIntervalMs: 0,
      environment: environment({ scheduler: { yield: vi.fn().mockRejectedValue(new Error('native failed')) } })
    })

    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({
      path: 'fallback',
      nativeFailure: 'rejected'
    })
  })

  it('rejects before scheduling when already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('navigation replaced'))
    const scheduler = createBrowserTaskScheduler({ environment: environment() })

    await expect(scheduler.yieldToBrowser({ signal: controller.signal })).rejects.toThrow('navigation replaced')
  })

  it('cancels a pending fallback timer without an unhandled continuation', async () => {
    let callback: (() => void) | undefined
    const clearTimer = vi.fn()
    const controller = new AbortController()
    const scheduler = createBrowserTaskScheduler({
      environment: environment({
        setTimer: (next: () => void) => {
          callback = next
          return 7
        },
        clearTimer
      })
    })

    const pending = scheduler.yieldToBrowser({ signal: controller.signal })
    controller.abort(new DOMException('component unmounted', 'AbortError'))
    await expect(pending).rejects.toThrow('component unmounted')
    expect(clearTimer).toHaveBeenCalledWith(7)
    expect(callback).toBeTypeOf('function')
  })

  it('throttles tight-loop calls until the minimum interval passes', async () => {
    let now = 100
    const scheduler = createBrowserTaskScheduler({
      minimumIntervalMs: 8,
      environment: environment({ now: () => now })
    })

    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({ path: 'fallback' })
    now = 104
    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({ path: 'throttled' })
    now = 109
    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({ path: 'fallback' })
  })

  it('reports background visibility without claiming equivalent priority', async () => {
    const scheduler = createBrowserTaskScheduler({
      minimumIntervalMs: 0,
      environment: environment({ visibility: () => 'hidden' as const })
    })

    await expect(scheduler.yieldToBrowser()).resolves.toMatchObject({
      path: 'fallback',
      visibility: 'hidden'
    })
  })
})
