import { computed, reactive } from 'vue'
import type { ImageCompressionOptions } from '@/api/upload'
import { decodePublicAotPayload, encodePublicAotPayload } from '@/bootstrap/publicAotBinaryPayload'

const STORAGE_KEY = 'fsus:image-upload-preferences'

const defaults: ImageCompressionOptions = {
  format: 'webp',
  quality: 82,
  scaleRatio: 1,
  maxEdge: 1920,
  preserveAlpha: true
}

interface ImageUploadPreferenceState extends ImageCompressionOptions {
  wasmOnly: boolean
}

function loadInitialState(): ImageCompressionOptions {
  if (typeof window === 'undefined') {
    return { ...defaults }
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...defaults }
    }

    const parsed = decodePublicAotPayload<Partial<ImageUploadPreferenceState>>(raw) ?? {}
    return {
      format: parsed.format ?? defaults.format,
      quality: typeof parsed.quality === 'number' ? parsed.quality : defaults.quality,
      scaleRatio: typeof parsed.scaleRatio === 'number' ? parsed.scaleRatio : defaults.scaleRatio,
      maxEdge: typeof parsed.maxEdge === 'number' ? parsed.maxEdge : defaults.maxEdge,
      preserveAlpha: typeof parsed.preserveAlpha === 'boolean' ? parsed.preserveAlpha : defaults.preserveAlpha
    }
  } catch {
    return { ...defaults }
  }
}

const state = reactive<ImageCompressionOptions>(loadInitialState())
const wasmOnly = reactive({ value: false })

function loadWasmOnly(): boolean {
  if (typeof window === 'undefined') {
    return false
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return false
    const parsed = decodePublicAotPayload<Partial<ImageUploadPreferenceState>>(raw) ?? {}
    return !!parsed.wasmOnly
  } catch {
    return false
  }
}
wasmOnly.value = loadWasmOnly()

function persist(): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, encodePublicAotPayload({
    ...state,
    wasmOnly: wasmOnly.value
  } satisfies ImageUploadPreferenceState))
}

export function useImageUploadPreferences() {
  const options = computed(() => state)
  const wasmOnlyMode = computed(() => wasmOnly.value)

  const setOptions = (next: Partial<ImageCompressionOptions>): void => {
    if (next.format) state.format = next.format
    if (typeof next.quality === 'number') state.quality = Math.min(100, Math.max(1, Math.round(next.quality)))
    if (typeof next.scaleRatio === 'number') state.scaleRatio = Math.min(1, Math.max(0.1, next.scaleRatio))
    if (typeof next.maxEdge === 'number') state.maxEdge = Math.min(4096, Math.max(256, Math.round(next.maxEdge)))
    if (typeof next.preserveAlpha === 'boolean') state.preserveAlpha = next.preserveAlpha
    persist()
  }

  const resetOptions = (): void => {
    Object.assign(state, defaults)
    wasmOnly.value = false
    persist()
  }

  const setWasmOnlyMode = (enabled: boolean): void => {
    wasmOnly.value = !!enabled
    persist()
  }

  return {
    options,
    wasmOnlyMode,
    setOptions,
    setWasmOnlyMode,
    resetOptions
  }
}
