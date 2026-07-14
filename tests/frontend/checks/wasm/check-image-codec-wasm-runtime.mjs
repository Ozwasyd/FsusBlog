#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function pickExport(raw, name) {
  const direct = raw[name]
  if (direct) {
    return direct
  }
  const underscored = raw[`_${name}`]
  if (underscored) {
    return underscored
  }
  throw new Error(`wasm_export_missing:${name}`)
}

function resolveCodecAsset(kind) {
  const fileBase = kind === 'simd' ? 'image_codec_simd' : 'image_codec_basic'
  const wasmRoot = resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
    || `${process.cwd()}/public/wasm`)
  return {
    moduleUrl: pathToFileURL(resolve(wasmRoot, `${fileBase}.js`)).href,
    wasmUrl: pathToFileURL(resolve(wasmRoot, `${fileBase}.wasm`)).href
  }
}

async function loadCodecModule(kind) {
  const asset = resolveCodecAsset(kind)
  const wasmBinary = readFileSync(fileURLToPath(asset.wasmUrl))
  const moduleRef = await import(asset.moduleUrl)
  const factory = moduleRef.default ?? moduleRef.createImageCodecModule
  assert(typeof factory === 'function', `[image-codec-wasm-runtime] missing factory: ${kind}`)
  const savedDirname = globalThis.__dirname
  globalThis.__dirname = fileURLToPath(asset.moduleUrl).replace(/\/[^/]+$/, '')
  try {
    return await factory({
      wasmBinary,
      locateFile: (path) => path.endsWith('.wasm') ? asset.wasmUrl : path,
      print: () => {},
      printErr: () => {}
    })
  } finally {
    if (savedDirname === undefined) {
      delete globalThis.__dirname
    } else {
      globalThis.__dirname = savedDirname
    }
  }
}

function readUtf8(module, ptr, len) {
  if (ptr <= 0 || len <= 0) {
    return ''
  }
  const view = module.HEAPU8.subarray(ptr, ptr + len)
  return new TextDecoder().decode(view)
}

function readBytes(module, ptr, len) {
  if (ptr <= 0 || len <= 0) {
    return new Uint8Array()
  }
  return module.HEAPU8.slice(ptr, ptr + len)
}

function isValidEncoded(bytes, format) {
  if (bytes.byteLength < 8) {
    return false
  }
  if (format === 'png') {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  }
  if (format === 'jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8
  }
  if (format === 'webp') {
    return bytes.byteLength >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  }
  if (format === 'avif') {
    return bytes.byteLength >= 12
      && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
      && bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66
  }
  return false
}

async function runCase(kind) {
  const module = await loadCodecModule(kind)
  const alloc = pickExport(module, 'image_codec_alloc_buffer')
  const free = pickExport(module, 'image_codec_free_buffer')
  const encode = pickExport(module, 'image_codec_encode')
  const getOutputPtr = pickExport(module, 'image_codec_get_last_output_ptr')
  const getOutputLen = pickExport(module, 'image_codec_get_last_output_len')
  const getErrorPtr = pickExport(module, 'image_codec_get_last_error_ptr')
  const getErrorLen = pickExport(module, 'image_codec_get_last_error_len')
  const getFormatsBitmap = pickExport(module, 'image_codec_get_supported_formats_bitmap')
  const formatsMask = getFormatsBitmap()
  const formats = {
    png: (formatsMask & 1) !== 0,
    jpeg: (formatsMask & 2) !== 0,
    webp: (formatsMask & 4) !== 0,
    avif: (formatsMask & 8) !== 0
  }
  assert(formats.png === true, `[image-codec-wasm-runtime] png not supported: ${kind}`)
  assert(formats.jpeg === true, `[image-codec-wasm-runtime] jpeg not supported: ${kind}`)

  const candidates = ['png', 'jpeg', 'webp', 'avif']
  const enabledFormats = candidates.filter((name) => formats[name] === true)

  const width = 2
  const height = 2
  const rgba = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 0, 255
  ])

  for (const format of enabledFormats) {
    const rgbaPtr = alloc(rgba.byteLength)
    const formatBytes = new TextEncoder().encode(`${format}\0`)
    const formatPtr = alloc(formatBytes.byteLength)
    try {
      assert(rgbaPtr > 0 && formatPtr > 0, `[image-codec-wasm-runtime] alloc failed: ${kind}:${format}`)
      module.HEAPU8.set(rgba, rgbaPtr)
      module.HEAPU8.set(formatBytes, formatPtr)
      const ok = encode(rgbaPtr, rgba.byteLength, width, height, formatPtr, 82, 1)
      if (ok !== 1) {
        const error = readUtf8(module, getErrorPtr(), getErrorLen())
        throw new Error(`[image-codec-wasm-runtime] encode failed: ${kind}:${format}:${error || 'unknown'}`)
      }
      const encoded = readBytes(module, getOutputPtr(), getOutputLen())
      assert(isValidEncoded(encoded, format), `[image-codec-wasm-runtime] invalid payload: ${kind}:${format}`)
    } finally {
      free(rgbaPtr)
      free(formatPtr)
    }
  }
}

async function main() {
  await runCase('basic')
  await runCase('simd')
  console.log('[image-codec-wasm-runtime] ok basic+simd')
}

main().catch((error) => {
  console.error('[image-codec-wasm-runtime] fatal:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
