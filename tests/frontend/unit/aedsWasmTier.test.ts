import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AedsRuntimeManifest } from '@wasm/aeds'

function runtimeManifest(): AedsRuntimeManifest {
  const hash = 'a'.repeat(64)
  return {
    schema: 'fsusblog.aeds-runtime.v1' as const,
    abi: 'fsusblog.aeds.v4',
    maxFrameBytes: 8 * 1024 * 1024,
    workerModel: {
      instancesPerPage: 1 as const,
      activeRequests: {
        source: 'runtime-logical-processors' as const,
        minimum: 1,
        maximum: 8,
        logicalProcessorsPerRequest: 2
      }
    },
    toolchain: {
      emscriptenVersion: '6.0.0',
      binaryenVersion: '123',
      cmakeVersion: '4.3.3',
      vcpkgCommit: 'b'.repeat(40),
      emsdkImage: `emscripten/emsdk:6.0.0@sha256:${'c'.repeat(64)}`
    },
    tiers: {
      basic: {
        module: 'aeds_decoder_basic.js',
        wasm: 'aeds_decoder_basic.wasm',
        moduleSha256: hash,
        wasmSha256: hash,
        simd: false,
        lto: false,
        wasmOptValidated: false,
        initialMemoryBytes: 16 * 1024 * 1024,
        maximumMemoryBytes: 256 * 1024 * 1024,
        memoryGrowth: 'bounded' as const
      },
      speed: {
        module: 'aeds_decoder_speed.js',
        wasm: 'aeds_decoder_speed.wasm',
        moduleSha256: hash,
        wasmSha256: hash,
        simd: true,
        lto: true,
        wasmOptValidated: true,
        initialMemoryBytes: 64 * 1024 * 1024,
        maximumMemoryBytes: 64 * 1024 * 1024,
        memoryGrowth: 'disabled' as const
      }
    }
  }
}

describe('AEDS Wasm tier selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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

  it('uses a typed runtime error for loader boundary failures', async () => {
    const { WasmRuntimeError } = await vi.importActual<
      typeof import('@wasm/runtime/emscripten')
    >('@wasm/runtime/emscripten')
    const error = new WasmRuntimeError('wasm_hash_mismatch')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('WasmRuntimeError')
    expect(error.code).toBe('wasm_hash_mismatch')
    expect(error.message).toBe('wasm_hash_mismatch')
  })

  it('rejects tampered JavaScript module bytes before importing the module', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('export default () => null')))
    const { loadEmscriptenModule } = await vi.importActual<
      typeof import('@wasm/runtime/emscripten')
    >('@wasm/runtime/emscripten')

    await expect(loadEmscriptenModule(
      'https://example.test/aeds.js',
      'createAedsModule',
      'https://example.test/aeds.wasm',
      { expectedModuleSha256: '0'.repeat(64) }
    )).rejects.toMatchObject({ code: 'module_hash_mismatch' })
  })

  it('derives the active request budget from bounded runtime resources', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const policy = runtimeManifest().workerModel

    expect(runtime.resolveAedsWorkerRuntimeModel(policy, 1)).toMatchObject({
      logicalProcessors: 1,
      activeRequests: 1
    })
    expect(runtime.resolveAedsWorkerRuntimeModel(policy, 64)).toMatchObject({
      logicalProcessors: 64,
      activeRequests: 8
    })
  })

  it('accepts only the complete v4 manifest identity', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')

    expect(() => runtime.validateAedsRuntimeManifest(runtimeManifest())).not.toThrow()
  })

  it('rejects a missing JavaScript module hash before loading a tier', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const manifest = runtimeManifest()
    manifest.tiers.speed.moduleSha256 = ''

    expect(() => runtime.validateAedsRuntimeManifest(manifest)).toThrow('aeds_manifest_tier_invalid:speed')
  })

  it('rejects a basic tier that does not retain the bounded scalar memory profile', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const manifest = runtimeManifest()
    manifest.tiers.basic.maximumMemoryBytes = 64 * 1024 * 1024

    expect(() => runtime.validateAedsRuntimeManifest(manifest)).toThrow('aeds_manifest_basic_identity_invalid')
  })

  it.each([
    ['SIMD', (manifest: ReturnType<typeof runtimeManifest>) => { manifest.tiers.speed.simd = false }],
    ['LTO', (manifest: ReturnType<typeof runtimeManifest>) => { manifest.tiers.speed.lto = false }],
    ['validated wasm-opt', (manifest: ReturnType<typeof runtimeManifest>) => {
      manifest.tiers.speed.wasmOptValidated = false
    }],
    ['fixed maximum memory', (manifest: ReturnType<typeof runtimeManifest>) => {
      manifest.tiers.speed.maximumMemoryBytes = 128 * 1024 * 1024
    }],
    ['disabled memory growth', (manifest: ReturnType<typeof runtimeManifest>) => {
      manifest.tiers.speed.memoryGrowth = 'bounded'
    }]
  ])('rejects a speed tier without %s identity', async (_field, mutate) => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const manifest = runtimeManifest()
    mutate(manifest)

    expect(() => runtime.validateAedsRuntimeManifest(manifest)).toThrow('aeds_manifest_speed_identity_invalid')
  })

  it('rejects an unpinned Binaryen toolchain identity', async () => {
    const runtime = await vi.importActual<typeof import('@wasm/aeds')>('@wasm/aeds')
    const manifest = runtimeManifest()
    manifest.toolchain.binaryenVersion = 'latest'

    expect(() => runtime.validateAedsRuntimeManifest(manifest)).toThrow('aeds_manifest_toolchain_invalid')
  })
})
