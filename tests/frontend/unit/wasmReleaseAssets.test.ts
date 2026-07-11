import { afterEach, describe, expect, it, vi } from 'vitest'

describe('release-scoped Wasm assets', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('binds Wasm URLs to the immutable frontend build id', async () => {
    vi.stubEnv('VITE_FSUSBLOG_BUILD_ID', 'release-20260711-abcdef')

    const assets = await import('../../../src/frontend/wasm/web/runtime/assets')

    expect(assets.WASM_PUBLIC_BASE).toBe('/release-assets/release-20260711-abcdef/wasm')
    expect(assets.AEDS_WASM_URL).toBe('/release-assets/release-20260711-abcdef/wasm/aeds_decoder.wasm')
  })

  it('rejects unsafe build ids and keeps the local development path', async () => {
    vi.stubEnv('VITE_FSUSBLOG_BUILD_ID', 'latest')

    const assets = await import('../../../src/frontend/wasm/web/runtime/assets')

    expect(assets.WASM_PUBLIC_BASE).toBe('/wasm')
  })
})
