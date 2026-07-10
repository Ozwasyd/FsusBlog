import { describe, expect, it } from 'vitest'

describe('frontend unit browser globals', () => {
  it('exposes getComputedStyle for motion code running under happy-dom', () => {
    expect(globalThis.getComputedStyle).toBeTypeOf('function')
    expect(globalThis.Node).toBe(window.Node)
    expect(globalThis.getComputedStyle(document.documentElement)).toBeTruthy()
  })
})
