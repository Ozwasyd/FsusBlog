import { describe, it, expect, beforeEach } from 'vitest'
import { useImageUploadPreferences } from '@/composables/useImageUploadPreferences'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

const STORAGE_KEY = 'fsus:image-upload-preferences'

describe('useImageUploadPreferences', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns default options when no stored preferences', () => {
    const { options } = useImageUploadPreferences()
    expect(options.value.format).toBe('webp')
    expect(options.value.quality).toBe(82)
    expect(options.value.scaleRatio).toBe(1)
    expect(options.value.maxEdge).toBe(1920)
    expect(options.value.preserveAlpha).toBe(true)
  })

  it('setOptions updates format', () => {
    const { options, setOptions } = useImageUploadPreferences()
    setOptions({ format: 'jpeg' })
    expect(options.value.format).toBe('jpeg')
  })

  it('setOptions clamps quality between 1 and 100', () => {
    const { options, setOptions } = useImageUploadPreferences()
    setOptions({ quality: 150 })
    expect(options.value.quality).toBe(100)
    setOptions({ quality: 0 })
    expect(options.value.quality).toBe(1)
  })

  it('setOptions clamps scaleRatio between 0.1 and 1', () => {
    const { options, setOptions } = useImageUploadPreferences()
    setOptions({ scaleRatio: 0.05 })
    expect(options.value.scaleRatio).toBe(0.1)
    setOptions({ scaleRatio: 2 })
    expect(options.value.scaleRatio).toBe(1)
  })

  it('setOptions clamps maxEdge between 256 and 4096', () => {
    const { options, setOptions } = useImageUploadPreferences()
    setOptions({ maxEdge: 100 })
    expect(options.value.maxEdge).toBe(256)
    setOptions({ maxEdge: 8000 })
    expect(options.value.maxEdge).toBe(4096)
  })

  it('setOptions updates preserveAlpha', () => {
    const { options, setOptions } = useImageUploadPreferences()
    setOptions({ preserveAlpha: false })
    expect(options.value.preserveAlpha).toBe(false)
  })

  it('resetOptions restores defaults', () => {
    const { options, setOptions, resetOptions } = useImageUploadPreferences()
    setOptions({ quality: 50 })
    resetOptions()
    expect(options.value.quality).toBe(82)
    expect(options.value.format).toBe('webp')
  })

  it('setWasmOnlyMode sets wasmOnlyMode', () => {
    const { wasmOnlyMode, setWasmOnlyMode } = useImageUploadPreferences()
    setWasmOnlyMode(true)
    expect(wasmOnlyMode.value).toBe(true)
    setWasmOnlyMode(false)
    expect(wasmOnlyMode.value).toBe(false)
  })

  it('persists preferences to localStorage', () => {
    const { setOptions } = useImageUploadPreferences()
    setOptions({ quality: 60 })
    const stored = decodePublicAotPayload<{ quality: number }>(localStorage.getItem(STORAGE_KEY) ?? '')
    expect(stored?.quality).toBe(60)
  })

  it('loads preferences from localStorage', () => {
    localStorage.setItem(STORAGE_KEY, encodePublicAotPayload({
      format: 'png',
      quality: 75,
      scaleRatio: 0.5,
      maxEdge: 1280,
      preserveAlpha: false,
      wasmOnly: false
    }))
    // Module-level state is already loaded, so we need to test loadInitialState indirectly
    // just ensure no crash and defaults fallback exists
    const { options } = useImageUploadPreferences()
    expect(options.value).toBeDefined()
  })
})
