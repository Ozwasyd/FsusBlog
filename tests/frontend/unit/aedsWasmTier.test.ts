import { afterEach, describe, expect, it, vi } from 'vitest'

describe('AEDS Wasm tier selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('uses feature validation and keeps scalar as the only non-SIMD candidate', async () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false)
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')

    expect(runtime.supportsAedsSimd()).toBe(false)
    expect(runtime.resolveAedsTierCandidates()).toEqual(['basic'])
  })

  it('tries speed then basic sequentially when SIMD validates', async () => {
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(true)
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')

    expect(runtime.supportsAedsSimd()).toBe(true)
    expect(runtime.resolveAedsTierCandidates()).toEqual(['speed', 'basic'])
  })

  it('does not download basic when speed succeeds', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const attempts: string[] = []

    const selected = await runtime.initializeAedsTierSequentially(['speed', 'basic'], async tier => {
      attempts.push(tier)
      return true
    })

    expect(attempts).toEqual(['speed'])
    expect(selected).toEqual({ tier: 'speed', fallbackReason: null })
  })

  it('loads basic only after speed initialization rejects and never decodes during selection', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const attempts: string[] = []

    const selected = await runtime.initializeAedsTierSequentially(['speed', 'basic'], async tier => {
      attempts.push(tier)
      if (tier === 'speed') throw new Error('speed_compile_failed')
      return true
    })

    expect(attempts).toEqual(['speed', 'basic'])
    expect(selected).toEqual({ tier: 'basic', fallbackReason: 'speed_compile_failed' })
  })
})
