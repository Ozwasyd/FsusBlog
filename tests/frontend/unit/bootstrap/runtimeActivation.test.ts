// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('runtimeActivation policy', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    const { resetRuntimeActivationForTests } = await import('@/bootstrap/runtimeActivation')
    resetRuntimeActivationForTests()
    vi.restoreAllMocks()
  })

  it('stays dormant until schedule/activate', async () => {
    const {
      runtimeActive,
      runtimeActivationPhase
    } = await import('@/bootstrap/runtimeActivation')

    expect(runtimeActivationPhase.value).toBe('dormant')
    expect(runtimeActive.value).toBe(false)
  })

  it('takeover scheduling becomes active without a second intent', async () => {
    const {
      runtimeActive,
      runtimeActivationPhase,
      scheduleRuntimeActivation
    } = await import('@/bootstrap/runtimeActivation')

    scheduleRuntimeActivation('takeover')
    expect(runtimeActivationPhase.value).toBe('scheduled')
    expect(runtimeActive.value).toBe(false)

    await waitFor(() => runtimeActive.value)

    expect(runtimeActivationPhase.value).toBe('active')
    expect(runtimeActive.value).toBe(true)
  })

  it('immediate activateRuntime is idempotent', async () => {
    const {
      activateRuntime,
      runtimeActive,
      scheduleRuntimeActivation
    } = await import('@/bootstrap/runtimeActivation')

    scheduleRuntimeActivation('immediate')
    await waitFor(() => runtimeActive.value)
    activateRuntime()
    activateRuntime()

    expect(runtimeActive.value).toBe(true)
  })

  it('after-first-paint stays scheduled until idle or intent', async () => {
    const {
      runtimeActive,
      runtimeActivationPhase,
      scheduleRuntimeActivation
    } = await import('@/bootstrap/runtimeActivation')

    scheduleRuntimeActivation('after-first-paint', {
      allowIdleActivation: false
    })
    expect(runtimeActivationPhase.value).toBe('scheduled')
    expect(runtimeActive.value).toBe(false)

    window.dispatchEvent(new Event('pointerdown'))
    await waitFor(() => runtimeActive.value)

    expect(runtimeActive.value).toBe(true)
  })

  it('after-first-paint can activate via idle fallback timer', async () => {
    const {
      runtimeActive,
      scheduleRuntimeActivation
    } = await import('@/bootstrap/runtimeActivation')

    const idleWindow = window as Omit<Window, 'requestIdleCallback'> & {
      requestIdleCallback?: typeof window.requestIdleCallback
    }
    const originalIdle = idleWindow.requestIdleCallback
    delete idleWindow.requestIdleCallback

    scheduleRuntimeActivation('after-first-paint', { allowIntentActivation: false })
    expect(runtimeActive.value).toBe(false)

    await waitFor(() => runtimeActive.value, 2500)

    expect(runtimeActive.value).toBe(true)

    if (originalIdle) {
      idleWindow.requestIdleCallback = originalIdle
    }
  })

  it('resetRuntimeActivationForTests restores dormant ownership', async () => {
    const {
      activateRuntime,
      resetRuntimeActivationForTests,
      runtimeActive,
      runtimeActivationPhase,
      scheduleRuntimeActivation
    } = await import('@/bootstrap/runtimeActivation')

    scheduleRuntimeActivation('takeover')
    await waitFor(() => runtimeActive.value)
    activateRuntime()
    expect(runtimeActive.value).toBe(true)

    resetRuntimeActivationForTests()
    expect(runtimeActivationPhase.value).toBe('dormant')
    expect(runtimeActive.value).toBe(false)
  })
})
