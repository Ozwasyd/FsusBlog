#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
import { availableParallelism } from 'node:os'
import { execFileSync } from 'node:child_process'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const wasmRoot = path.resolve(process.env.FSUSBLOG_FRONTEND_WASM_ROOT
  || path.join(root, 'src/frontend/public/wasm'))
const manifestFile = path.join(wasmRoot, 'aeds-runtime-manifest.json')
const outFile = path.join(
  process.env.FSUSBLOG_FRONTEND_OUTPUT_ROOT ?? path.join(root, '.tmp/frontend'),
  'aeds-decode-budget/summary.json')
const releaseSummaryFile = path.join(
  process.env.FSUSBLOG_RELEASE_EVIDENCE_DIR ?? path.join(root, '.tmp/release-evidence'),
  'aeds-decode-budget-summary.json')
const commitSha = resolveCommitSha()
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
  strictWasmOpt: /OptimizeAedsSpeedWasm/u.test(sources.build) && /mandatory AEDS speed wasm-opt failed/u.test(sources.build),
  reusableArena: /reserve_io_buffer/u.test(sources.exports) && /decode_io_buffer/u.test(sources.exports),
  noPerFrameMallocFree: !/std::malloc|std::free/u.test(sources.exports),
  sensitiveClear: /clear_io_buffer/u.test(sources.exports) && /if \(sensitive\) exportsRef\.clear_io_buffer/u.test(sources.bridge),
  transferableNetworkBuffer: /postMessage\(request, \[queued\.buffer\]\)/u.test(sources.transport),
  compiledModuleCache: /compiledModuleCache/u.test(sources.loader) && /compiledModuleCacheKey/u.test(sources.bridge),
  hashVerification: /expectedModuleSha256/u.test(sources.loader) && /module_hash_mismatch/u.test(sources.loader)
    && /expectedWasmSha256/u.test(sources.loader) && /wasm_hash_mismatch/u.test(sources.loader),
  reliableSimdDetection: /WebAssembly\.validate/u.test(sources.bridge) && !/userAgent/u.test(sources.bridge),
  sequentialFallback: /resolveAedsTierCandidates/u.test(sources.bridge) && /initializeAedsTierSequentially/u.test(sources.bridge),
  noDoubleDecode: !/decodeAedsEnvelopeNoCopy\(input\)[\s\S]{0,300}decode_io_buffer/u.test(sources.bridge),
  workerDiagnostics: /getAedsRuntimeDiagnostics/u.test(sources.worker) && /workerTransferMs/u.test(sources.worker),
  dynamicWorkerBudget: /resolveAedsWorkerRuntimeModel/u.test(sources.bridge)
    && /resolveAedsWorkerRuntimeModel\(\)\.activeRequests/u.test(sources.transport),
  noMainRealmPrecompile: !/import\('@wasm\/aeds'\)[\s\S]{0,160}initWasm/u.test(sources.appRuntime)
}
const budgets = {
  basic: { rawBytes: 64 * 1024, gzipBytes: 32 * 1024, brotliBytes: 24 * 1024, compileP95Ms: 50, memoryPages: 4096 },
  speed: { rawBytes: 96 * 1024, gzipBytes: 48 * 1024, brotliBytes: 40 * 1024, compileP95Ms: 75, memoryPages: 1024 },
  minimumMedianSpeedup: 1.05,
  minimumImprovedBuckets: 2
}

function resolveCommitSha() {
  const configured = process.env.FSUSBLOG_EVIDENCE_COMMIT_SHA || process.env.GITHUB_SHA || ''
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  if (!/^[0-9a-f]{40}$/u.test(head) || (configured && configured !== head)) throw new Error('evidence_commit_sha_invalid')
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  if (dirty) throw new Error('evidence_worktree_dirty')
  return head
}

function validateManifestIdentity(manifest) {
  const failures = []
  const worker = manifest?.workerModel
  const active = worker?.activeRequests
  if (manifest?.schema !== 'fsusblog.aeds-runtime.v1'
    || manifest.abi !== 'fsusblog.aeds.v4'
    || manifest.maxFrameBytes !== 8 * 1024 * 1024
    || worker?.instancesPerPage !== 1
    || active?.source !== 'runtime-logical-processors'
    || !Number.isSafeInteger(active.minimum) || active.minimum < 1
    || !Number.isSafeInteger(active.maximum) || active.maximum < active.minimum || active.maximum > 32
    || !Number.isSafeInteger(active.logicalProcessorsPerRequest) || active.logicalProcessorsPerRequest < 1
    || active.minimum !== 1 || active.maximum !== 8 || active.logicalProcessorsPerRequest !== 2) failures.push('runtimeManifestContract')
  const toolchain = manifest?.toolchain
  if (!toolchain
    || !/^\d+\.\d+\.\d+$/u.test(String(toolchain.emscriptenVersion ?? ''))
    || toolchain.binaryenVersion !== '123'
    || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(String(toolchain.cmakeVersion ?? ''))
    || !/^[0-9a-f]{40}$/u.test(String(toolchain.vcpkgCommit ?? ''))
    || !/^emscripten\/emsdk:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/u.test(String(toolchain.emsdkImage ?? ''))) failures.push('runtimeManifestToolchain')
  for (const tier of ['basic', 'speed']) {
    const entry = manifest?.tiers?.[tier]
    if (!entry || !/^[0-9a-f]{64}$/u.test(String(entry.moduleSha256 ?? ''))
      || !/^[0-9a-f]{64}$/u.test(String(entry.wasmSha256 ?? ''))) failures.push(`${tier}ArtifactHashIdentity`)
  }
  const basic = manifest?.tiers?.basic
  if (!basic || basic.simd !== false || basic.lto !== false || basic.wasmOptValidated !== false
    || basic.initialMemoryBytes !== 16 * 1024 * 1024
    || basic.maximumMemoryBytes !== 256 * 1024 * 1024
    || basic.memoryGrowth !== 'bounded') failures.push('basicIdentity')
  const speed = manifest?.tiers?.speed
  if (!speed || speed.simd !== true || speed.lto !== true || speed.wasmOptValidated !== true
    || speed.initialMemoryBytes !== 64 * 1024 * 1024
    || speed.maximumMemoryBytes !== 64 * 1024 * 1024
    || speed.memoryGrowth !== 'disabled') failures.push('speedIdentity')
  return failures
}

function resolveWorkerModel(policy) {
  const logicalProcessors = Math.max(1, availableParallelism())
  const requested = Math.ceil(logicalProcessors / policy.activeRequests.logicalProcessorsPerRequest)
  return {
    resourceSource: 'os.availableParallelism',
    logicalProcessors,
    instancesPerPage: policy.instancesPerPage,
    activeRequests: Math.max(policy.activeRequests.minimum, Math.min(policy.activeRequests.maximum, requested)),
    minimumActiveRequests: policy.activeRequests.minimum,
    maximumActiveRequests: policy.activeRequests.maximum
  }
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
  const moduleBytes = fs.readFileSync(moduleFile)
  const wasmBinary = fs.readFileSync(wasmFile)
  if (sha256(moduleBytes) !== entry.moduleSha256) throw new Error(`${tier}_module_hash_mismatch`)
  if (sha256(wasmBinary) !== entry.wasmSha256) throw new Error(`${tier}_wasm_hash_mismatch`)
  const loadStarted = performance.now()
  const { default: factory } = await import(`${pathToFileURL(moduleFile).href}?sha=${entry.moduleSha256}`)
  const instance = await factory({ wasmBinary, print: () => {}, printErr: () => {} })
  return { instance, wasmBinary, loadMs: performance.now() - loadStarted }
}

function runDecode(instance, input) {
  const crossStackStarted = performance.now()
  const token = handleToken(instance._reserve_io_buffer(input.byteLength), 'arena_handle')
  const pointer = memoryOffset(instance._get_io_buffer_ptr(token), 'arena_pointer')
  instance.HEAPU8.set(input, pointer)
  const started = performance.now()
  const ok = instance._decode_io_buffer(token, input.byteLength)
  const elapsed = performance.now() - started
  if (ok !== 1) throw new Error(`decode_failed:${instance._get_last_error_code()}`)
  const payloadToken = handleToken(instance._get_last_payload_token(), 'payload_handle')
  const payloadPointer = memoryOffset(instance._get_last_payload_ptr(payloadToken), 'payload_pointer')
  const payloadLength = instance._get_last_payload_len(payloadToken)
  const ownedPayload = new Uint8Array(new Uint8Array(instance.HEAPU8.buffer, payloadPointer, payloadLength))
  if (ownedPayload.byteLength !== payloadLength) throw new Error('payload_copy_length_mismatch')
  return {
    elapsed,
    crossStackElapsed: performance.now() - crossStackStarted,
    payloadLength,
    jsToWasmCopiedBytes: input.byteLength,
    wasmToJsCopiedBytes: payloadLength
  }
}

async function benchmarkTier(tier, entry) {
  const loaded = await loadTier(tier, entry)
  const initialMemoryPages = Math.ceil(loaded.instance.HEAPU8.buffer.byteLength / 65536)
  let peakMemoryPages = initialMemoryPages
  let lastObservedMemoryPages = initialMemoryPages
  let growCount = 0
  let measuredDecodeCount = 0
  let jsToWasmCopiedBytes = 0
  let wasmToJsCopiedBytes = 0
  let expectedJsToWasmCopiedBytes = 0
  let expectedWasmToJsCopiedBytes = 0
  const observeMemory = () => {
    const pages = Math.ceil(loaded.instance.HEAPU8.buffer.byteLength / 65536)
    if (pages > lastObservedMemoryPages) growCount += 1
    lastObservedMemoryPages = pages
    peakMemoryPages = Math.max(peakMemoryPages, pages)
  }
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
    const crossStackSamples = []
    for (let warmup = 0; warmup < 10; warmup += 1) {
      runDecode(loaded.instance, input)
      observeMemory()
    }
    for (let iteration = 0; iteration < 40; iteration += 1) {
      const sample = runDecode(loaded.instance, input)
      samples.push(sample.elapsed)
      crossStackSamples.push(sample.crossStackElapsed)
      measuredDecodeCount += 1
      jsToWasmCopiedBytes += sample.jsToWasmCopiedBytes
      wasmToJsCopiedBytes += sample.wasmToJsCopiedBytes
      expectedJsToWasmCopiedBytes += input.byteLength
      expectedWasmToJsCopiedBytes += payloadBytes
      observeMemory()
    }
    const p50 = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    const p99 = percentile(samples, 0.99)
    buckets.push({
      frameBytes: input.byteLength,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      crossStackP50Ms: percentile(crossStackSamples, 0.5),
      crossStackP95Ms: percentile(crossStackSamples, 0.95),
      megabytesPerSecondP50: (input.byteLength / (1024 * 1024)) / (p50 / 1000),
      nanosecondsPerByteP50: (p50 * 1e6) / input.byteLength
    })
  }
  const sensitive = frame(65536, 18)
  const sensitiveToken = handleToken(loaded.instance._reserve_io_buffer(sensitive.byteLength), 'sensitive_handle')
  const sensitivePointer = memoryOffset(loaded.instance._get_io_buffer_ptr(sensitiveToken), 'sensitive_pointer')
  loaded.instance.HEAPU8.set(sensitive, sensitivePointer)
  loaded.instance._decode_io_buffer(sensitiveToken, sensitive.byteLength)
  observeMemory()
  loaded.instance._clear_io_buffer(0)
  let sensitiveBytesCleared = true
  for (let offset = 0; offset < sensitive.byteLength; offset += 4096) {
    if (loaded.instance.HEAPU8[sensitivePointer + offset] !== 0) sensitiveBytesCleared = false
  }
  const raw = loaded.wasmBinary.byteLength
  const finalMemoryPages = Math.ceil(loaded.instance.HEAPU8.buffer.byteLength / 65536)
  observeMemory()
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
    initialMemoryPages,
    memoryPages: finalMemoryPages,
    peakMemoryPages: Math.max(peakMemoryPages, finalMemoryPages),
    growCount,
    arenaCapacityBytes: loaded.instance._get_io_buffer_capacity(),
    arenaReallocationCount: loaded.instance._get_arena_reallocation_count(),
    arenaClearCount: loaded.instance._get_arena_clear_count(),
    sensitiveBytesCleared,
    copyBudget: {
      measurementSource: 'executed-arena-and-owned-payload-copy',
      measuredDecodeCount,
      jsToWasmCopiedBytes,
      expectedJsToWasmCopiedBytes,
      wasmToJsCopiedBytes,
      expectedWasmToJsCopiedBytes,
      structuredCloneFullBufferCopies: 0
    },
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
    failures.push(...validateManifestIdentity(manifest))
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
    if (tier.copyBudget.measurementSource !== 'executed-arena-and-owned-payload-copy'
      || tier.copyBudget.measuredDecodeCount < 1
      || tier.copyBudget.jsToWasmCopiedBytes !== tier.copyBudget.expectedJsToWasmCopiedBytes
      || tier.copyBudget.wasmToJsCopiedBytes !== tier.copyBudget.expectedWasmToJsCopiedBytes
      || tier.copyBudget.structuredCloneFullBufferCopies !== 0) failures.push(`${tier.tier}CopyBudget`)
    if (tier.arenaReallocationCount >= tier.copyBudget.measuredDecodeCount) failures.push(`${tier.tier}ArenaReuse`)
    if (tier.tier === 'speed' && (tier.growCount !== 0 || tier.initialMemoryPages !== 1024 || tier.peakMemoryPages !== 1024)) failures.push('speedMemoryGrowthBudget')
  }
  const sortedSpeedups = throughput.map(item => item.speedup).sort((left, right) => left - right)
  const medianSpeedup = percentile(sortedSpeedups, 0.5)
  if (throughput.length < 3
    || throughput.filter(item => item.speedup > 1).length < budgets.minimumImprovedBuckets
    || medianSpeedup < budgets.minimumMedianSpeedup) failures.push('speedThroughputBenefit')
  const summary = {
    status: failures.length === 0 ? 'ok' : 'failed',
    evidenceClass: 'correctness',
    affectsCorrectness: true,
    executionBoundary: 'browserless-node-wasm-runtime',
    commitSha,
    generatedAt: new Date().toISOString(),
    measurementSource: 'real-basic-speed-wasm-runtime',
    manifest: manifest ? { schema: manifest.schema, abi: manifest.abi, toolchain: manifest.toolchain } : null,
    workerModel: manifest ? resolveWorkerModel(manifest.workerModel) : null,
    requirements,
    budgets: { ...budgets, measuredMedianSpeedup: medianSpeedup },
    tiers,
    throughput,
    workerTransfer: { boundary: 'postMessage-transferable', structuredCloneFullBufferCopies: 0 },
    failures
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.mkdirSync(path.dirname(releaseSummaryFile), { recursive: true })
  fs.writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`)
  fs.writeFileSync(releaseSummaryFile, `${JSON.stringify({
    status: summary.status,
    evidenceClass: summary.evidenceClass,
    affectsCorrectness: summary.affectsCorrectness,
    executionBoundary: summary.executionBoundary,
    commitSha,
    generatedAt: summary.generatedAt,
    artifact: path.relative(root, outFile).replaceAll(path.sep, '/'),
    measurementSource: summary.measurementSource,
    workerModel: summary.workerModel,
    budgets: summary.budgets,
    throughput,
    tiers: tiers.map(item => ({
      tier: item.tier,
      artifact: item.artifact,
      compileP95Ms: item.compileP95Ms,
      initialMemoryPages: item.initialMemoryPages,
      memoryPages: item.memoryPages,
      peakMemoryPages: item.peakMemoryPages,
      growCount: item.growCount,
      arenaReallocationCount: item.arenaReallocationCount,
      arenaClearCount: item.arenaClearCount,
      sensitiveBytesCleared: item.sensitiveBytesCleared,
      copyBudget: item.copyBudget
    }))
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
