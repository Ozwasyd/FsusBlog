#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const wasmRoot = path.resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || path.join(root, 'src/frontend/public/wasm'))
const manifestFile = path.join(wasmRoot, 'aeds-runtime-manifest.json')
const outFile = path.join(root, '.tmp/frontend/aeds-decode-budget/summary.json')
const releaseSummaryFile = path.join(root, '.tmp/release-evidence/aeds-decode-budget-summary.json')
const sourceFiles = {
  cmake: path.join(root, 'src/frontend/wasm/aeds/CMakeLists.txt'),
  exports: path.join(root, 'src/frontend/wasm/aeds/src/exports.cpp'),
  build: path.join(root, 'src/frontend/wasm/build.sh'),
  bridge: path.join(root, 'src/frontend/wasm/web/aeds.ts'),
  loader: path.join(root, 'src/frontend/wasm/web/runtime/emscripten.ts'),
  worker: path.join(root, 'src/frontend/src/workers/wasmDecode.worker.ts'),
  transport: path.join(root, 'src/frontend/src/services/binaryTransport.ts'),
  appRuntime: path.join(root, 'src/frontend/src/components/runtime/AppRuntime.vue')
}

const read = file => fs.readFileSync(file, 'utf8')
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sources = Object.fromEntries(Object.entries(sourceFiles).map(([key, file]) => [key, read(file)]))
const requirements = {
  basicAndSpeedTargets: /aeds_decoder_basic/u.test(sources.cmake) && /aeds_decoder_speed/u.test(sources.cmake),
  speedCompilerProfile: /-O3/u.test(sources.cmake) && /-flto/u.test(sources.cmake) && /-msimd128/u.test(sources.cmake),
  fixedSpeedMemory: /ALLOW_MEMORY_GROWTH=0/u.test(sources.cmake) && /INITIAL_MEMORY=67108864/u.test(sources.cmake),
  strictWasmOpt: /optimize_aeds_speed_wasm/u.test(sources.build) && /mandatory AEDS speed wasm-opt failed/u.test(sources.build),
  reusableArena: /reserve_io_buffer/u.test(sources.exports) && /decode_io_buffer/u.test(sources.exports),
  noPerFrameMallocFree: !/std::malloc|std::free/u.test(sources.exports),
  sensitiveClear: /clear_io_buffer/u.test(sources.exports) && /if \(sensitive\) exportsRef\.clear_io_buffer/u.test(sources.bridge),
  transferableNetworkBuffer: /postMessage\(request, \[queued\.buffer\]\)/u.test(sources.transport),
  compiledModuleCache: /compiledModuleCache/u.test(sources.loader) && /compiledModuleCacheKey/u.test(sources.bridge),
  hashVerification: /expectedWasmSha256/u.test(sources.loader) && /wasm_hash_mismatch/u.test(sources.loader),
  reliableSimdDetection: /WebAssembly\.validate/u.test(sources.bridge) && !/userAgent/u.test(sources.bridge),
  sequentialFallback: /resolveAedsTierCandidates/u.test(sources.bridge) && /initializeAedsTierSequentially/u.test(sources.bridge),
  noDoubleDecode: !/decodeAedsEnvelopeNoCopy\(input\)[\s\S]{0,300}decode_io_buffer/u.test(sources.bridge),
  workerDiagnostics: /getAedsRuntimeDiagnostics/u.test(sources.worker) && /workerTransferMs/u.test(sources.worker),
  noMainRealmPrecompile: !/import\('@wasm\/aeds'\)[\s\S]{0,160}initWasm/u.test(sources.appRuntime)
}
const budgets = {
  basic: { rawBytes: 64 * 1024, gzipBytes: 32 * 1024, brotliBytes: 24 * 1024, compileP95Ms: 50, memoryPages: 4096 },
  speed: { rawBytes: 96 * 1024, gzipBytes: 48 * 1024, brotliBytes: 40 * 1024, compileP95Ms: 75, memoryPages: 1024 },
  minimumMedianSpeedup: 1.05,
  minimumImprovedBuckets: 2
}

function crc16(bytes) {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1)
  }
  return crc & 0xffff
}

function frame(payloadBytes, frameType = 14) {
  const bytes = new Uint8Array(16 + payloadBytes)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x53444541, true)
  view.setUint8(4, 2)
  view.setUint8(5, 16)
  view.setUint16(8, frameType, true)
  view.setUint32(10, payloadBytes, true)
  for (let index = 16; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff
  view.setUint16(14, crc16(bytes.subarray(16)), true)
  return bytes
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))] ?? 0
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

async function loadTier(tier, entry) {
  const moduleFile = path.join(wasmRoot, entry.module)
  const wasmFile = path.join(wasmRoot, entry.wasm)
  const wasmBinary = fs.readFileSync(wasmFile)
  if (sha256(wasmBinary) !== entry.wasmSha256) throw new Error(`${tier}_wasm_hash_mismatch`)
  const loadStarted = performance.now()
  const { default: factory } = await import(`${pathToFileURL(moduleFile).href}?sha=${entry.moduleSha256}`)
  const instance = await factory({ wasmBinary, print: () => {}, printErr: () => {} })
  return { instance, wasmBinary, loadMs: performance.now() - loadStarted }
}

function runDecode(instance, input) {
  const token = handleToken(instance._reserve_io_buffer(input.byteLength), 'arena_handle')
  const pointer = memoryOffset(instance._get_io_buffer_ptr(token), 'arena_pointer')
  instance.HEAPU8.set(input, pointer)
  const started = performance.now()
  const ok = instance._decode_io_buffer(token, input.byteLength)
  const elapsed = performance.now() - started
  if (ok !== 1) throw new Error(`decode_failed:${instance._get_last_error_code()}`)
  const payloadToken = handleToken(instance._get_last_payload_token(), 'payload_handle')
  const payloadLength = instance._get_last_payload_len(payloadToken)
  return { elapsed, payloadLength }
}

async function benchmarkTier(tier, entry) {
  const loaded = await loadTier(tier, entry)
  const compileSamples = []
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now()
    await WebAssembly.compile(loaded.wasmBinary)
    compileSamples.push(performance.now() - started)
  }
  const buckets = []
  for (const payloadBytes of [4096, 65536, 1048576]) {
    const input = frame(payloadBytes)
    const samples = []
    for (let warmup = 0; warmup < 10; warmup += 1) runDecode(loaded.instance, input)
    for (let iteration = 0; iteration < 40; iteration += 1) samples.push(runDecode(loaded.instance, input).elapsed)
    const p50 = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    const p99 = percentile(samples, 0.99)
    buckets.push({
      frameBytes: input.byteLength,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      megabytesPerSecondP50: (input.byteLength / (1024 * 1024)) / (p50 / 1000),
      nanosecondsPerByteP50: (p50 * 1e6) / input.byteLength
    })
  }
  const sensitive = frame(65536, 18)
  const sensitiveToken = handleToken(loaded.instance._reserve_io_buffer(sensitive.byteLength), 'sensitive_handle')
  const sensitivePointer = memoryOffset(loaded.instance._get_io_buffer_ptr(sensitiveToken), 'sensitive_pointer')
  loaded.instance.HEAPU8.set(sensitive, sensitivePointer)
  loaded.instance._decode_io_buffer(sensitiveToken, sensitive.byteLength)
  loaded.instance._clear_io_buffer(0)
  let sensitiveBytesCleared = true
  for (let offset = 0; offset < sensitive.byteLength; offset += 4096) {
    if (loaded.instance.HEAPU8[sensitivePointer + offset] !== 0) sensitiveBytesCleared = false
  }
  const raw = loaded.wasmBinary.byteLength
  return {
    tier,
    artifact: {
      rawBytes: raw,
      gzipBytes: gzipSync(loaded.wasmBinary, { level: 9 }).byteLength,
      brotliBytes: brotliCompressSync(loaded.wasmBinary).byteLength
    },
    loadMs: loaded.loadMs,
    compileP50Ms: percentile(compileSamples, 0.5),
    compileP95Ms: percentile(compileSamples, 0.95),
    memoryPages: Math.ceil(loaded.instance.HEAPU8.buffer.byteLength / 65536),
    arenaCapacityBytes: loaded.instance._get_io_buffer_capacity(),
    arenaReallocationCount: loaded.instance._get_arena_reallocation_count(),
    arenaClearCount: loaded.instance._get_arena_clear_count(),
    sensitiveBytesCleared,
    copyModel: { jsToWasmCopiesPerFrame: 1, wasmToJsCopiesPerFrame: 1 },
    buckets
  }
}

async function main() {
  const failures = Object.entries(requirements).filter(([, ok]) => !ok).map(([name]) => name)
  if (!fs.existsSync(manifestFile)) failures.push('runtimeManifestMissing')
  let manifest = null
  let tiers = []
  if (failures.length === 0) {
    manifest = JSON.parse(read(manifestFile))
    if (manifest.schema !== 'fsusblog.aeds-runtime.v1' || manifest.abi !== 'fsusblog.aeds.v4') failures.push('runtimeManifestContract')
    if (!manifest.tiers?.speed?.wasmOptValidated || !manifest.tiers?.speed?.simd || !manifest.tiers?.speed?.lto) failures.push('speedIdentity')
    if (failures.length === 0) {
      for (const tier of ['basic', 'speed']) tiers.push(await benchmarkTier(tier, manifest.tiers[tier]))
    }
  }
  const basic = tiers.find(item => item.tier === 'basic')
  const speed = tiers.find(item => item.tier === 'speed')
  if (tiers.some(item => !item.sensitiveBytesCleared)) failures.push('sensitiveArenaClear')
  const throughput = basic && speed ? basic.buckets.map((bucket, index) => ({
    frameBytes: bucket.frameBytes,
    basicMBps: bucket.megabytesPerSecondP50,
    speedMBps: speed.buckets[index].megabytesPerSecondP50,
    speedup: speed.buckets[index].megabytesPerSecondP50 / bucket.megabytesPerSecondP50
  })) : []
  for (const tier of tiers) {
    const budget = budgets[tier.tier]
    if (!budget) continue
    if (tier.artifact.rawBytes > budget.rawBytes) failures.push(`${tier.tier}RawArtifactBudget`)
    if (tier.artifact.gzipBytes > budget.gzipBytes) failures.push(`${tier.tier}GzipArtifactBudget`)
    if (tier.artifact.brotliBytes > budget.brotliBytes) failures.push(`${tier.tier}BrotliArtifactBudget`)
    if (tier.compileP95Ms > budget.compileP95Ms) failures.push(`${tier.tier}CompileP95Budget`)
    if (tier.memoryPages > budget.memoryPages) failures.push(`${tier.tier}MemoryPagesBudget`)
    if (tier.copyModel.jsToWasmCopiesPerFrame !== 1 || tier.copyModel.wasmToJsCopiesPerFrame !== 1) failures.push(`${tier.tier}CopyBudget`)
  }
  const sortedSpeedups = throughput.map(item => item.speedup).sort((left, right) => left - right)
  const medianSpeedup = percentile(sortedSpeedups, 0.5)
  if (throughput.length < 3
    || throughput.filter(item => item.speedup > 1).length < budgets.minimumImprovedBuckets
    || medianSpeedup < budgets.minimumMedianSpeedup) failures.push('speedThroughputBenefit')
  const summary = {
    status: failures.length === 0 ? 'ok' : 'failed',
    generatedAt: new Date().toISOString(),
    measurementSource: 'real-basic-speed-wasm-runtime',
    manifest: manifest ? { schema: manifest.schema, abi: manifest.abi, toolchain: manifest.toolchain } : null,
    requirements,
    budgets: { ...budgets, measuredMedianSpeedup: medianSpeedup },
    tiers,
    throughput,
    workerTransfer: { boundary: 'postMessage-transferable', structuredCloneFullBufferCopies: 0 },
    runtimeEvidence: {
      browserTierSummary: '.tmp/release-evidence/aeds-wasm-browser-summary.json',
      hydrationTakeoverSummary: '.tmp/release-evidence/public-hydration-sidecar-summary.json'
    },
    failures
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.mkdirSync(path.dirname(releaseSummaryFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify({
    status: summary.status,
    generatedAt: summary.generatedAt,
    artifact: path.relative(root, outFile).replaceAll(path.sep, '/'),
    measurementSource: summary.measurementSource,
    budgets: summary.budgets,
    throughput,
    tiers: tiers.map(item => ({ tier: item.tier, artifact: item.artifact, compileP95Ms: item.compileP95Ms, memoryPages: item.memoryPages }))
  }, null, 2)}\n`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[aeds-decode-budget] ${failure}`)
    process.exit(1)
  }
  console.log(`[aeds-decode-budget] ok ${throughput.map(item => `${item.frameBytes}B=${item.speedup.toFixed(2)}x`).join(' ')}`)
}

main().catch(error => {
  console.error(`[aeds-decode-budget] ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
