import { afterEach, describe, expect, it, vi } from 'vitest'

describe('release-scoped Wasm assets', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('binds Wasm URLs to the immutable frontend build id', async () => {
    vi.stubEnv('VITE_FSUSBLOG_BUILD_ID', '20260711010101-0123456789ab')

    const assets = await import('../../../src/frontend/wasm/web/runtime/assets')

    expect(assets.WASM_PUBLIC_BASE).toBe('/release-assets/20260711010101-0123456789ab/wasm')
    expect(assets.AEDS_RUNTIME_MANIFEST_URL).toBe('/release-assets/20260711010101-0123456789ab/wasm/aeds-runtime-manifest.json')
    expect(assets.resolveAedsAsset('basic')).toEqual({
      moduleUrl: '/release-assets/20260711010101-0123456789ab/wasm/aeds_decoder_basic.js',
      wasmUrl: '/release-assets/20260711010101-0123456789ab/wasm/aeds_decoder_basic.wasm'
    })
    expect(assets.resolveAedsAsset('speed')).toEqual({
      moduleUrl: '/release-assets/20260711010101-0123456789ab/wasm/aeds_decoder_speed.js',
      wasmUrl: '/release-assets/20260711010101-0123456789ab/wasm/aeds_decoder_speed.wasm'
    })
  })

  it('rejects unsafe build ids and keeps the local development path', async () => {
    vi.stubEnv('VITE_FSUSBLOG_BUILD_ID', 'latest')

    const assets = await import('../../../src/frontend/wasm/web/runtime/assets')

    expect(assets.WASM_PUBLIC_BASE).toBe('/wasm')
  })
})
