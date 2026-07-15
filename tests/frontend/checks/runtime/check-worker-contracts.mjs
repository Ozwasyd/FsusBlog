#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const errors = []

function assert(source, token, label) {
  if (!source.includes(token)) {
    errors.push(`${label}: missing ${token}`)
  }
}

const binaryTransport = read('src/frontend/src/services/binaryTransport.ts')
const decodeWorker = read('src/frontend/src/workers/wasmDecode.worker.ts')
const powWorker = read('src/frontend/src/workers/pow.worker.ts')
const wasmImageCodec = read('src/frontend/src/utils/wasmImageCodec.ts')
const localSearch = read('src/frontend/src/services/localSearch.ts')
const searchCmake = read('src/frontend/wasm/search/CMakeLists.txt')
const powCmake = read('src/frontend/wasm/pow/CMakeLists.txt')

assert(binaryTransport, 'const MAIN_THREAD_DECODE_MAX_BYTES = 4096', 'binary small-payload threshold')
assert(binaryTransport, 'const DECODE_WORKER_TIMEOUT_MS = 15000', 'binary worker timeout')
assert(binaryTransport, 'resolveAedsWorkerRuntimeModel().activeRequests', 'binary runtime-sized active budget')
assert(binaryTransport, 'Math.max(16, DECODE_WORKER_ACTIVE_LIMIT * 16)', 'binary runtime-sized queue backpressure')
assert(binaryTransport, 'postWorkerCancel(requestId)', 'binary abort cancel protocol')
assert(binaryTransport, 'resetWorker(timeoutError)', 'binary timeout terminates worker')
assert(binaryTransport, "addEventListener('messageerror'", 'binary messageerror handling')
assert(binaryTransport, 'handleWorkerFatalError', 'binary fatal worker handling')
assert(binaryTransport, 'worker.postMessage(request, [queued.buffer])', 'binary transferable buffer')

assert(decodeWorker, 'const canceledRequests = new Set<number>()', 'decode worker cancellation state')
assert(decodeWorker, 'let wasmReadyPromise: Promise<boolean> | null = null', 'decode worker wasm init cache')
assert(decodeWorker, "event.data.type === 'cancel'", 'decode worker cancel message')
assert(decodeWorker, 'frame_type_unexpected', 'decode worker frame mismatch')
assert(decodeWorker, 'payload_out_of_range', 'decode worker payload bounds error')
assert(decodeWorker, 'schema_mismatch', 'decode worker schema error')
assert(decodeWorker, 'postDecodeResponse(response)', 'decode worker response suppression')

assert(powWorker, "type === 'PING'", 'pow prewarm ping')
assert(powWorker, "type === 'CALC_SHARD'", 'pow shard entry')
assert(powWorker, 'solve_pow_range', 'pow shard range engine')
assert(powWorker, 'terminateShardWorkers()', 'pow shard cancellation')
assert(powWorker, 'failures >= shardCount', 'pow shard all-fail handling')
assert(powWorker, 'isThreadPoolCandidate', 'pow adaptive threaded candidate')
assert(powWorker, 'THREAD_POOL_FALLBACK_TIMEOUT_MS', 'pow shard timeout fallback')
assert(powWorker, 'POW_SHARDS_TIMEOUT', 'pow shard timeout error')
assert(powWorker, 'const ENABLE_THREAD_POOL_SHARDS = false', 'pow shard default-off guard')
assert(powWorker, 'POW_SOLVE_BATCH_ATTEMPTS', 'pow bounded solve batch')
assert(powWorker, 'calculateWithBoundedSolver', 'pow bounded solve loop')
assert(powWorker, 'yieldToWorkerEventLoop()', 'pow bounded solve yield')
assert(powWorker, 'deadlineAt', 'pow worker internal deadline')
assert(powWorker, 'POW_SOLVER_TIMEOUT', 'pow worker timeout error')

assert(wasmImageCodec, 'let simdSupportCache: boolean | null = null', 'image codec SIMD probe cache')
assert(wasmImageCodec, "const preferred: ImageCodecAssetKind = supportsSimd() ? 'simd' : 'basic'", 'image codec SIMD preference')
assert(wasmImageCodec, "preferred === 'simd' ? await loadCodec('basic') : null", 'image codec basic fallback')
assert(wasmImageCodec, 'WasmEncodeError', 'image codec explicit encode error')
assert(wasmImageCodec, 'supportedFormats', 'image codec supported formats')

assert(localSearch, 'function decodeSearchManifest', 'search manifest decoder')
assert(localSearch, 'combineAbortSignals', 'search abort combinator')
assert(localSearch, 'preloadBackgroundShard', 'search background preload')
assert(localSearch, 'invalidateSearchIndexMemory', 'search SW invalidation')
assert(localSearch, 'rankSearchPage(mapArticleSearchFromPodPayload(payload), query, sort)', 'search ranking post-runtime contract')
assert(searchCmake, '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', 'search wasm heap export')
assert(powCmake, '-sEXPORTED_RUNTIME_METHODS=[\\"HEAPU8\\"]', 'pow wasm heap export')
assert(powCmake, '_solve_pow_limited_c', 'pow wasm bounded node solver export')

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[worker-contracts] ${error}`)
  }
  process.exit(1)
}

console.log('[worker-contracts] ok decode-worker=1 pow-worker=1 image-codec=1 search-runtime=1')
