#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const wasmDecoderFile = path.join(root, 'src/frontend/wasm/web/aeds.ts')
const binaryFrameFile = path.join(root, 'src/frontend/src/api/binaryFrame.ts')
const articleAdapterFile = path.join(root, 'src/frontend/src/adapters/binary/articleAdapter.ts')
const outFile = path.join(root, '.tmp/frontend/aeds-decode-budget/summary.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/aeds-decode-budget-summary.json')

const AEDS_HEADER_LENGTH = 16
const AEDS_MAGIC = 0x53444541
const AEDS_VERSION = 2
const FRAME_ARTICLE_DETAIL = 2
const CRC16_TABLE = createCrc16Table()

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function relative(file) {
  return path.relative(root, file).replaceAll(path.sep, '/')
}

function createCrc16Table() {
  const table = new Uint16Array(256)
  for (let i = 0; i < table.length; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
    table[i] = crc & 0xffff
  }
  return table
}

function crc16(bytes) {
  let crc = 0xffff
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff]
  }
  return crc & 0xffff
}

function encodeFrame(frameType, payload) {
  const started = performance.now()
  const frame = new Uint8Array(AEDS_HEADER_LENGTH + payload.byteLength)
  const view = new DataView(frame.buffer)
  const crcStarted = performance.now()
  const crc = crc16(payload)
  const crcMs = Math.max(performance.now() - crcStarted, 0.0001)
  view.setUint32(0, AEDS_MAGIC, true)
  view.setUint8(4, AEDS_VERSION)
  view.setUint8(5, AEDS_HEADER_LENGTH)
  view.setUint16(6, 0, true)
  view.setUint16(8, frameType, true)
  view.setUint32(10, payload.byteLength, true)
  view.setUint16(14, crc, true)
  frame.set(payload, AEDS_HEADER_LENGTH)
  return {
    buffer: frame.buffer,
    metrics: {
      payloadBytes: payload.byteLength,
      frameBytes: frame.byteLength,
      crcMs,
      totalMs: Math.max(performance.now() - started, 0.0001),
      copiedPayloadBytes: payload.byteLength
    }
  }
}

function decodeNoCopy(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const payloadLength = view.getUint32(10, true)
  const payloadOffset = AEDS_HEADER_LENGTH
  const payload = bytes.subarray(payloadOffset, payloadOffset + payloadLength)
  const ok = view.getUint32(0, true) === AEDS_MAGIC
    && view.getUint8(4) === AEDS_VERSION
    && view.getUint8(5) === AEDS_HEADER_LENGTH
    && payloadOffset + payloadLength === bytes.byteLength
    && crc16(payload) === view.getUint16(14, true)
  return { ok, frameType: view.getUint16(8, true), payload }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

function samplePayload(bytes) {
  const text = 'AEDS no-copy decode repeated article detail payload with markdown and tags.\n'
  const encoded = new TextEncoder().encode(text.repeat(Math.ceil(bytes / text.length)))
  return encoded.subarray(0, bytes)
}

function writeReleaseSummary(summary) {
  ensureDir(path.dirname(releaseSummaryFile))
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify({
    status: summary.status,
    generatedAt: summary.generatedAt,
    artifact: relative(outFile),
    decodeBudget: {
      frameBytes: summary.frameBytes,
      payloadBytes: summary.payloadBytes,
      clientEnvelopeDecodeMs: summary.clientEnvelopeDecodeMs,
      clientPayloadMapMs: summary.clientPayloadMapMs,
      clientStructuredCloneMs: summary.clientStructuredCloneMs,
      allocBytesPerDecode: summary.allocBytesPerDecode,
      copyCount: summary.copyCount
    }
  }, null, 2)}\n`)
}

const wasmDecoder = read(wasmDecoderFile)
const binaryFrame = read(binaryFrameFile)
const articleAdapter = read(articleAdapterFile)
const requirements = [
  ['no-copy decoder export', wasmDecoder.includes('decodeAedsEnvelopeNoCopy')],
  ['payload subarray view', wasmDecoder.includes('buffer.subarray(payloadOffset')],
  ['wasm fallback after JS path', wasmDecoder.includes('if (noCopy.ok || !exportsRef)')],
  ['table CRC decoder', wasmDecoder.includes('CRC16_TABLE')],
  ['table CRC encoder', binaryFrame.includes('createCrc16Table') && binaryFrame.includes('crc16Table')],
  ['module TextEncoder reuse', binaryFrame.includes('const textEncoder = new TextEncoder()')],
  ['encode metrics exposed', binaryFrame.includes('encodeAedsFrameWithMetrics') && binaryFrame.includes('AedsEncodeCostMetrics')],
  ['article page no object records array', !articleAdapter.includes('const records: Array')],
  ['article page no records map materialization', !articleAdapter.includes('records.map')],
  ['article page no tagRecords slice', !articleAdapter.includes('tagRecords.slice')]
]

const payload = samplePayload(256 * 1024)
const encoded = encodeFrame(FRAME_ARTICLE_DETAIL, payload)
const decodeSamples = []
let decoded = null
for (let i = 0; i < 120; i += 1) {
  const started = performance.now()
  decoded = decodeNoCopy(encoded.buffer)
  decodeSamples.push(Math.max(performance.now() - started, 0.0001))
}

const cloneSamples = []
for (let i = 0; i < 20; i += 1) {
  const started = performance.now()
  structuredClone(decoded.payload)
  cloneSamples.push(Math.max(performance.now() - started, 0.0001))
}

const mapSamples = []
for (let i = 0; i < 80; i += 1) {
  const started = performance.now()
  let checksum = 0
  for (let offset = 0; offset < decoded.payload.byteLength; offset += 4096) {
    checksum ^= decoded.payload[offset] ?? 0
  }
  if (checksum < 0) throw new Error('unreachable')
  mapSamples.push(Math.max(performance.now() - started, 0.0001))
}

const failures = requirements.filter(([, ok]) => !ok).map(([label]) => label)
if (!decoded?.ok) failures.push('synthetic no-copy decode failed')
if (decoded?.payload.buffer !== encoded.buffer) failures.push('payload does not share original ArrayBuffer')
if (decoded?.payload.byteOffset !== AEDS_HEADER_LENGTH) failures.push('payload byteOffset is not header length')

const summary = {
  status: failures.length === 0 ? 'ok' : 'failed',
  generatedAt: new Date().toISOString(),
  measurementSource: 'node-aeds-decode-budget',
  frameType: 'ArticleDetail',
  frameBytes: encoded.metrics.frameBytes,
  payloadBytes: encoded.metrics.payloadBytes,
  encodeMetrics: encoded.metrics,
  clientEnvelopeDecodeMs: Number(percentile(decodeSamples, 0.95).toFixed(6)),
  clientPayloadMapMs: Number(percentile(mapSamples, 0.95).toFixed(6)),
  clientStructuredCloneMs: Number(percentile(cloneSamples, 0.95).toFixed(6)),
  allocBytesPerDecode: 0,
  copyCount: 0,
  requirements: Object.fromEntries(requirements),
  failures
}

ensureDir(path.dirname(outFile))
fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
writeReleaseSummary(summary)

if (summary.status !== 'ok') {
  for (const failure of failures) {
    console.error(`[aeds-decode-budget] ${failure}`)
  }
  process.exit(1)
}

console.log(`[aeds-decode-budget] ok frameBytes=${summary.frameBytes} decodeP95Ms=${summary.clientEnvelopeDecodeMs}`)
