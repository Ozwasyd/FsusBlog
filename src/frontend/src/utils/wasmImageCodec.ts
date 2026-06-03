import type { ImageCompressionOptions } from '@/api/upload'
import { AppErrorCode, createAppError } from '@/utils/appError'
import { decodeUtf8, encodeUtf8 } from '@/utils/utf8'
import { createSerializedExecutor, loadEmscriptenModule, resolveImageCodecAsset, type ImageCodecAssetKind } from '@wasm/runtime'

export type WasmCodecLevel = 'simd' | 'basic' | 'none'

interface WasmEncodeRequest {
  rgba: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  format: ImageCompressionOptions['format']
  quality: number
  preserveAlpha: boolean
}

export interface WasmImageCodec {
  level: Exclude<WasmCodecLevel, 'none'>
  version: string
  supportedFormats: ImageCompressionOptions['format'][]
  encode(request: WasmEncodeRequest): Promise<Uint8Array>
}

export type WasmEncodePipeline = 'wasm-simd' | 'wasm-basic' | 'wasm-none'

export interface WasmEncodeErrorMeta {
  format: ImageCompressionOptions['format']
  pipeline: WasmEncodePipeline
  reason: string
  codecLevel: WasmCodecLevel
  codecVersion?: string
  cause?: unknown
}

export class WasmEncodeError extends Error {
  readonly format: ImageCompressionOptions['format']
  readonly pipeline: WasmEncodePipeline
  readonly reason: string
  readonly codecLevel: WasmCodecLevel
  readonly codecVersion?: string
  readonly cause?: unknown

  constructor(meta: WasmEncodeErrorMeta) {
    super(`wasm_encode_failed:${meta.format}:${meta.pipeline}:${meta.reason}`)
    this.name = 'WasmEncodeError'
    this.format = meta.format
    this.pipeline = meta.pipeline
    this.reason = meta.reason
    this.codecLevel = meta.codecLevel
    this.codecVersion = meta.codecVersion
    this.cause = meta.cause
  }
}

type ImageCodecModule = {
  HEAPU8: Uint8Array
  _image_codec_alloc_buffer?: (size: number) => number
  _image_codec_free_buffer?: (ptr: number) => void
  _image_codec_encode?: (
    rgbaPtr: number,
    rgbaLen: number,
    width: number,
    height: number,
    formatPtr: number,
    quality: number,
    preserveAlpha: number
  ) => number
  _image_codec_get_last_output_ptr?: () => number
  _image_codec_get_last_output_len?: () => number
  _image_codec_get_last_error_ptr?: () => number
  _image_codec_get_last_error_len?: () => number
  _image_codec_get_last_error_code?: () => number
  _image_codec_get_level_ptr?: () => number
  _image_codec_get_level_len?: () => number
  _image_codec_get_version_ptr?: () => number
  _image_codec_get_version_len?: () => number
  _image_codec_get_supported_formats_bitmap?: () => number
}

const withImageCodecLock = createSerializedExecutor()
let simdSupportCache: boolean | null = null

function supportsSimd(): boolean {
  if (simdSupportCache !== null) {
    return simdSupportCache
  }

  try {
    const simdProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10,
      1, 8, 0, 65, 0, 253, 15, 253, 98, 11
    ])
    simdSupportCache = typeof WebAssembly !== 'undefined' && WebAssembly.validate(simdProbe)
    return simdSupportCache
  } catch {
    simdSupportCache = false
    return false
  }
}

function readUtf8(heap: Uint8Array, ptr: number, len: number): string {
  if (ptr <= 0 || len <= 0) {
    return ''
  }
  const view = heap.subarray(ptr, ptr + len)
  return decodeUtf8(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
}

function readBytes(heap: Uint8Array, ptr: number, len: number): Uint8Array {
  if (ptr <= 0 || len <= 0) {
    return new Uint8Array()
  }
  return heap.slice(ptr, ptr + len)
}

function parseSupportedFormats(
  getBitmap: (() => number) | undefined
): ImageCompressionOptions['format'][] {
  if (getBitmap) {
    const bitmap = getBitmap() >>> 0
    const mapping: Array<[ImageCompressionOptions['format'], number]> = [
      ['png', 1 << 0],
      ['jpeg', 1 << 1],
      ['webp', 1 << 2],
      ['avif', 1 << 3],
      ['gif', 1 << 4]
    ]
    return mapping.filter(([, bit]) => (bitmap & bit) !== 0).map(([format]) => format)
  }

  return []
}

function assertExport<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw createAppError(AppErrorCode.InvariantViolation, `wasm_image_codec_missing_export:${name}`)
  }
  return value
}

function codecLevelToPipeline(level: WasmCodecLevel): WasmEncodePipeline {
  if (level === 'simd') {
    return 'wasm-simd'
  }
  if (level === 'basic') {
    return 'wasm-basic'
  }
  return 'wasm-none'
}

function imageCodecErrorReason(code: number, fallback: string): string {
  switch (code) {
    case 1:
      return 'codec_invalid_input'
    case 2:
      return 'image_dimension_invalid'
    case 3:
      return 'codec_rgba_size_mismatch'
    case 4:
      return 'codec_format_not_supported'
    case 5:
      return 'codec_need_fallback'
    case 6:
      return 'codec_encode_failed'
    default:
      return fallback
  }
}

async function loadCodec(kind: ImageCodecAssetKind): Promise<WasmImageCodec | null> {
  const asset = resolveImageCodecAsset(kind)
  const mod = await loadEmscriptenModule<ImageCodecModule>(
    asset.moduleUrl,
    'createImageCodecModule',
    asset.wasmUrl
  )
  if (!mod) {
    return null
  }

  const alloc = assertExport(mod._image_codec_alloc_buffer, 'alloc_buffer')
  const free = assertExport(mod._image_codec_free_buffer, 'free_buffer')
  const encodeNative = assertExport(mod._image_codec_encode, 'encode')
  const getOutputPtr = assertExport(mod._image_codec_get_last_output_ptr, 'get_last_output_ptr')
  const getOutputLen = assertExport(mod._image_codec_get_last_output_len, 'get_last_output_len')
  const getErrorPtr = assertExport(mod._image_codec_get_last_error_ptr, 'get_last_error_ptr')
  const getErrorLen = assertExport(mod._image_codec_get_last_error_len, 'get_last_error_len')
  const getErrorCode = assertExport(mod._image_codec_get_last_error_code, 'get_last_error_code')
  const getLevelPtr = assertExport(mod._image_codec_get_level_ptr, 'get_level_ptr')
  const getLevelLen = assertExport(mod._image_codec_get_level_len, 'get_level_len')
  const getVersionPtr = assertExport(mod._image_codec_get_version_ptr, 'get_version_ptr')
  const getVersionLen = assertExport(mod._image_codec_get_version_len, 'get_version_len')
  const getSupportedFormatsBitmap = mod._image_codec_get_supported_formats_bitmap

  const levelRaw = readUtf8(mod.HEAPU8, getLevelPtr(), getLevelLen())
  const version = readUtf8(mod.HEAPU8, getVersionPtr(), getVersionLen()) || 'unknown'
  const level: Exclude<WasmCodecLevel, 'none'> = levelRaw === 'simd' ? 'simd' : 'basic'
  const supportedFormats = parseSupportedFormats(getSupportedFormatsBitmap)

  return {
    level,
    version,
    supportedFormats,
    async encode(request: WasmEncodeRequest): Promise<Uint8Array> {
      return await withImageCodecLock(async () => {
        const rgbaPtr = alloc(request.rgba.byteLength)
        if (rgbaPtr <= 0) {
          throw createAppError(AppErrorCode.InfraFailure, 'wasm_image_codec_alloc_failed')
        }

        const formatBytes = encodeUtf8(`${request.format}\0`)
        const formatPtr = alloc(formatBytes.byteLength)
        if (formatPtr <= 0) {
          free(rgbaPtr)
          throw createAppError(AppErrorCode.InfraFailure, 'wasm_image_codec_alloc_failed')
        }

        try {
          mod.HEAPU8.set(request.rgba, rgbaPtr)
          mod.HEAPU8.set(formatBytes, formatPtr)
          const ok = encodeNative(
            rgbaPtr,
            request.rgba.byteLength,
            request.width,
            request.height,
            formatPtr,
            request.quality,
            request.preserveAlpha ? 1 : 0
          )
          if (ok !== 1) {
            const errorCode = getErrorCode()
            const error = readUtf8(mod.HEAPU8, getErrorPtr(), getErrorLen()) || 'wasm_image_codec_failed'
            throw new WasmEncodeError({
              format: request.format,
              pipeline: codecLevelToPipeline(level),
              reason: imageCodecErrorReason(errorCode, error),
              codecLevel: level,
              codecVersion: version
            })
          }

          return readBytes(mod.HEAPU8, getOutputPtr(), getOutputLen())
        } finally {
          free(rgbaPtr)
          free(formatPtr)
        }
      })
    }
  }
}

let cachedCodecPromise: Promise<WasmImageCodec | null> | null = null

export async function getWasmImageCodec(): Promise<WasmImageCodec | null> {
  if (!cachedCodecPromise) {
    cachedCodecPromise = (async () => {
      const preferred: ImageCodecAssetKind = supportsSimd() ? 'simd' : 'basic'
      const primary = await loadCodec(preferred)
      if (primary) {
        return primary
      }
      return preferred === 'simd' ? await loadCodec('basic') : null
    })().catch(() => null)
  }

  return cachedCodecPromise
}

export async function getWasmSupportedFormats(): Promise<ImageCompressionOptions['format'][]> {
  const codec = await getWasmImageCodec()
  return codec?.supportedFormats ?? []
}

export function getWasmCapabilityLevel(): WasmCodecLevel {
  if (typeof WebAssembly === 'undefined') {
    return 'none'
  }
  return supportsSimd() ? 'simd' : 'basic'
}
