#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const wasmDir = join(root, 'public', 'wasm')

const requiredFiles = [
  'image_codec_basic.js',
  'image_codec_basic.wasm',
  'image_codec_simd.js',
  'image_codec_simd.wasm'
]

let failed = false
for (const file of requiredFiles) {
  const filePath = join(wasmDir, file)
  if (!existsSync(filePath)) {
    console.error(`[image-codec-wasm] missing: ${file}`)
    failed = true
    continue
  }
  const size = readFileSync(filePath).byteLength
  if (size <= 0) {
    console.error(`[image-codec-wasm] empty: ${file}`)
    failed = true
  }
}

const moduleChecks = [
  {
    file: 'image_codec_basic.js',
    symbols: [
      'image_codec_encode',
      'image_codec_get_supported_formats_bitmap',
      'image_codec_get_supported_formats_json_ptr',
      'image_codec_get_supported_formats_json_len'
    ]
  },
  {
    file: 'image_codec_simd.js',
    symbols: [
      'image_codec_encode',
      'image_codec_get_supported_formats_bitmap',
      'image_codec_get_supported_formats_json_ptr',
      'image_codec_get_supported_formats_json_len'
    ]
  }
]

for (const check of moduleChecks) {
  const filePath = join(wasmDir, check.file)
  if (!existsSync(filePath)) {
    continue
  }
  const content = readFileSync(filePath, 'utf8')
  for (const symbol of check.symbols) {
    if (!content.includes(symbol)) {
      console.error(`[image-codec-wasm] symbol missing in ${check.file}: ${symbol}`)
      failed = true
    }
  }
}

if (failed) {
  process.exit(1)
}

console.log('[image-codec-wasm] ok artifacts=basic+simd')
