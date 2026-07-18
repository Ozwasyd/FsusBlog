import { describe, expect, it, vi } from 'vitest'
import {
  createUnitAnimationFrameEnvironment
} from '../../support/unit/animationFrameEnvironment'

describe('frontend unit browser globals', () => {
  it('exposes getComputedStyle for motion code running under happy-dom', () => {
    expect(globalThis.getComputedStyle).toBeTypeOf('function')
    expect(globalThis.Node).toBe(window.Node)
    expect(globalThis.getComputedStyle(document.documentElement)).toBeTruthy()
    expect(globalThis.requestAnimationFrame).toBeTypeOf('function')
    expect(globalThis.cancelAnimationFrame).toBeTypeOf('function')
    expect(window.requestAnimationFrame).toBe(globalThis.requestAnimationFrame)
    expect(window.cancelAnimationFrame).toBe(globalThis.cancelAnimationFrame)
  })

  it('cancels queued animation frames before browser globals are torn down', async () => {
    const environment = createUnitAnimationFrameEnvironment()
    const callback = vi.fn()

    expect(environment.request(callback)).not.toBe(0)
    environment.dispose()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(callback).not.toHaveBeenCalled()
    expect(environment.request(callback)).toBe(0)
  })
})
