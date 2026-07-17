#!/usr/bin/env node

import { availableParallelism } from 'node:os'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const decoderDirectory = resolve(process.env.FSUSBLOG_FRONTEND_DIST_ROOT
  ? join(process.env.FSUSBLOG_FRONTEND_DIST_ROOT, 'wasm')
  : resolve(root, 'src/frontend/dist/wasm'))
const decoderVariants = ['basic', 'speed'].map((tier) => ({
  tier,
  modulePath: join(decoderDirectory, `aeds_decoder_${tier}.js`),
  wasmPath: join(decoderDirectory, `aeds_decoder_${tier}.wasm`)
}))
const outputDirectory = resolve(root, '.tmp/fuzz/wasm')
const crashDirectory = join(outputDirectory, 'crashes')
const releaseEvidenceDirectory = resolve(root, '.tmp/release-evidence')
const namespace = process.env.FSUSBLOG_TEST_NAMESPACE || 'local'

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const grantedCpu = positiveInteger(
  process.env.FSUSBLOG_STEP_CPU_BUDGET
    ?? process.env.FSUSBLOG_TIER_CPU_UNITS
    ?? process.env.FSUSBLOG_BUNDLE_CPU_UNITS,
  Math.max(1, availableParallelism())
)
const seedsPerCorpus = positiveInteger(
  process.env.FSUSBLOG_WASM_FUZZ_SEEDS_PER_CORPUS,
  Math.max(64, grantedCpu * 64)
)

const corpus = [
  { id: 'aeds-decoder', payload: new Uint8Array([0, 1, 2, 3, 4, 255]), frameType: 1 },
  { id: 'markdown', payload: new TextEncoder().encode('# heading\n\n[link](https://example.invalid)'), frameType: 14 },
  { id: 'latex', payload: new TextEncoder().encode('\\\\int_0^1 x^2 \\, dx'), frameType: 14 },
  { id: 'mermaid', payload: new TextEncoder().encode('graph TD; A-->B; B-->A'), frameType: 14 },
  { id: 'malformed-binary', payload: new Uint8Array([0xff, 0, 0x80, 0x7f, 0x13, 0x37]), frameType: 9 }
]

function crc16(bytes) {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
    }
  }
  return crc & 0xffff
}

function validFrame(entry) {
  const frame = new Uint8Array(16 + entry.payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, 0x53444541, true)
  view.setUint8(4, 2)
  view.setUint8(5, 16)
  view.setUint16(6, 0, true)
  view.setUint16(8, entry.frameType, true)
  view.setUint32(10, entry.payload.byteLength, true)
  view.setUint16(14, crc16(entry.payload), true)
  frame.set(entry.payload, 16)
  return frame
}

function xorshift32(seed) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function mutate(base, seed, iteration) {
  const random = xorshift32(seed)
  const mutation = iteration % 6
  if (mutation === 0) {
    return Uint8Array.from({ length: random() % 96 + 1 }, () => random() & 0xff)
  }

  let output = new Uint8Array(base)
  if (mutation === 1) {
    output = output.subarray(0, random() % output.byteLength)
  } else if (mutation === 2) {
    const extended = new Uint8Array(output.byteLength + (random() % 128) + 1)
    extended.set(output)
    for (let index = output.byteLength; index < extended.byteLength; index += 1) extended[index] = random() & 0xff
    output = extended
  } else {
    const changes = 1 + (random() % Math.min(16, output.byteLength))
    for (let index = 0; index < changes; index += 1) {
      const offset = random() % output.byteLength
      output[offset] ^= 1 << (random() % 8)
    }
  }
  return output
}

function seedFor(corpusIndex, iteration) {
  return (0x9e3779b9 ^ Math.imul(corpusIndex + 1, 0x85ebca6b) ^ Math.imul(iteration + 1, 0xc2b2ae35)) >>> 0
}

function handleToken(value, label) {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(`${label}_invalid`)
  return value
}

function memoryOffset(value, label) {
  const offset = typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
  if (!Number.isSafeInteger(offset) || offset <= 0) throw new Error(`${label}_invalid`)
  return offset
}

function isNullAddress(value) {
  return value === 0 || value === 0n
}

async function writeEvidence(summary) {
  await mkdir(crashDirectory, { recursive: true })
  await mkdir(releaseEvidenceDirectory, { recursive: true })
  await writeFile(join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await writeFile(join(releaseEvidenceDirectory, 'fuzz-seeds.json'), `${JSON.stringify({
    status: summary.status,
    wasm: '.tmp/fuzz/wasm/summary.json',
    seeds: summary.seedPlan,
    seedsRun: summary.seedsRun,
    replayCommand: './tools/test.sh wasm-fuzz-regression',
    generatedAt: summary.generatedAt
  }, null, 2)}\n`)
}

const startedAt = new Date().toISOString()
let seedsRun = 0
let decoderDigest = ''
let decoderEvidence = []
let activeSeed = null

try {
  const decoders = []
  for (const variant of decoderVariants) {
    const wasmBinary = await readFile(variant.wasmPath)
    const sha256 = createHash('sha256').update(wasmBinary).digest('hex')
    const { default: createAedsModule } = await import(pathToFileURL(variant.modulePath).href)
    const instance = await createAedsModule({ wasmBinary, print: () => {}, printErr: () => {} })
    decoders.push({ ...variant, sha256, instance })
  }
  decoderEvidence = decoders.map(({ tier, modulePath, wasmPath, sha256 }) => ({
    tier,
    module: modulePath.slice(root.length + 1).replaceAll('\\', '/'),
    wasm: wasmPath.slice(root.length + 1).replaceAll('\\', '/'),
    sha256
  }))
  decoderDigest = createHash('sha256').update(decoderEvidence.map(item => `${item.tier}:${item.sha256}`).join('\n')).digest('hex')

  const decodeWithArena = (decoder, input) => {
    const { instance } = decoder
    if (input.byteLength === 0) {
      return { ok: instance._decode_io_buffer(0n, 0), frameType: 0, payloadLength: 0, payloadSha256: null, errorCode: instance._get_last_error_code() }
    }
    const inputToken = handleToken(instance._reserve_io_buffer(input.byteLength), `wasm_fuzz_arena_handle:${decoder.tier}`)
    const pointer = memoryOffset(instance._get_io_buffer_ptr(inputToken), `wasm_fuzz_arena_pointer:${decoder.tier}`)
    instance.HEAPU8.set(input, pointer)
    const ok = instance._decode_io_buffer(inputToken, input.byteLength)
    const payloadToken = ok === 1
      ? handleToken(instance._get_last_payload_token(), `wasm_fuzz_payload_handle:${decoder.tier}`)
      : 0n
    const payloadAddress = ok === 1 ? instance._get_last_payload_ptr(payloadToken) : 0
    const payloadPointer = ok === 1 && !isNullAddress(payloadAddress)
      ? memoryOffset(payloadAddress, `wasm_fuzz_payload_pointer:${decoder.tier}`)
      : 0
    const payloadLength = ok === 1 ? instance._get_last_payload_len(payloadToken) : 0
    const signature = {
      ok,
      frameType: ok === 1 ? instance._get_last_frame_type(payloadToken) : 0,
      payloadLength,
      payloadSha256: ok === 1 && payloadLength > 0
        ? createHash('sha256').update(instance.HEAPU8.subarray(payloadPointer, payloadPointer + payloadLength)).digest('hex')
        : null,
      errorCode: instance._get_last_error_code()
    }
    const replacementToken = handleToken(instance._reserve_io_buffer(input.byteLength), `wasm_fuzz_replacement_handle:${decoder.tier}`)
    if (!isNullAddress(instance._get_io_buffer_ptr(inputToken))) {
      throw new Error(`wasm_fuzz_input_handle_not_expired:${decoder.tier}`)
    }
    if (payloadToken !== 0n && !isNullAddress(instance._get_last_payload_ptr(payloadToken))) {
      throw new Error(`wasm_fuzz_payload_handle_survived_reserve:${decoder.tier}`)
    }
    if (isNullAddress(instance._get_io_buffer_ptr(replacementToken))) {
      throw new Error(`wasm_fuzz_replacement_handle_expired:${decoder.tier}`)
    }
    instance._clear_io_buffer(0)
    if (payloadToken !== 0n && !isNullAddress(instance._get_last_payload_ptr(payloadToken))) {
      throw new Error(`wasm_fuzz_payload_handle_not_expired:${decoder.tier}`)
    }
    for (let offset = 0; offset < input.byteLength; offset += Math.max(1, Math.floor(input.byteLength / 16))) {
      if (instance.HEAPU8[pointer + offset] !== 0) throw new Error(`wasm_fuzz_arena_clear_failed:${decoder.tier}`)
    }
    return signature
  }

  for (const [corpusIndex, entry] of corpus.entries()) {
    const base = validFrame(entry)
    for (let iteration = 0; iteration < seedsPerCorpus; iteration += 1) {
      const seed = seedFor(corpusIndex, iteration)
      activeSeed = { corpus: entry.id, iteration, seed }
      const input = mutate(base, seed, iteration)
      const results = decoders.map(decoder => decodeWithArena(decoder, input))
      for (const result of results) {
        if (result.ok !== 0 && result.ok !== 1) throw new Error(`wasm_fuzz_invalid_result:${result.ok}`)
      }
      if (JSON.stringify(results[0]) !== JSON.stringify(results[1])) {
        throw new Error(`wasm_fuzz_tier_differential:${JSON.stringify(results)}`)
      }
      seedsRun += 1
    }
  }

  const generatedAt = new Date().toISOString()
  await writeEvidence({
    status: 'ok',
    executionSource: 'fresh-wasm-runtime',
    namespace,
    corpus: corpus.map((entry) => entry.id),
    seedsRun,
    seedsPerCorpus,
    seedPlan: corpus.map((entry, corpusIndex) => ({
      corpus: entry.id,
      firstSeed: seedFor(corpusIndex, 0),
      count: seedsPerCorpus
    })),
    crashes: [],
    sanitizerOutput: null,
    decoder: { sha256: decoderDigest, abi: 'fsusblog.aeds.v4', tiers: decoderEvidence },
    blocker: null,
    startedAt,
    generatedAt
  })
  process.stdout.write(`[wasm-fuzz] executed ${seedsRun} seeds against ${decoderDigest}\n`)
} catch (error) {
  const generatedAt = new Date().toISOString()
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const crashName = `crash-${Date.now()}.json`
  await mkdir(crashDirectory, { recursive: true })
  await writeFile(join(crashDirectory, crashName), `${JSON.stringify({ activeSeed, error: message }, null, 2)}\n`)
  await writeEvidence({
    status: 'failure',
    executionSource: 'fresh-wasm-runtime',
    namespace,
    corpus: corpus.map((entry) => entry.id),
    seedsRun,
    seedsPerCorpus,
    seedPlan: corpus.map((entry, corpusIndex) => ({ corpus: entry.id, firstSeed: seedFor(corpusIndex, 0), count: seedsPerCorpus })),
    crashes: [`.tmp/fuzz/wasm/crashes/${crashName}`],
    sanitizerOutput: null,
    decoder: { sha256: decoderDigest || null, abi: 'fsusblog.aeds.v4', tiers: decoderEvidence },
    blocker: 'wasm-fuzz-execution-failed',
    error: message,
    startedAt,
    generatedAt
  })
  process.stderr.write(`[wasm-fuzz] ${message}\n`)
  process.exitCode = 1
}
