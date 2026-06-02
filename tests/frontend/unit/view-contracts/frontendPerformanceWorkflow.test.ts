import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url))
const readRepoFile = (path: string): string => readFileSync(repoFile(path), 'utf8')

describe('frontend performance workflow contract', () => {
  const binaryTransport = readRepoFile('src/frontend/src/services/binaryTransport.ts')
  const decodeWorker = readRepoFile('src/frontend/src/workers/wasmDecode.worker.ts')
  const localSearch = readRepoFile('src/frontend/src/services/localSearch.ts')
  const imageCompression = readRepoFile('src/frontend/src/utils/imageCompression.ts')
  const wasmImageCodec = readRepoFile('src/frontend/src/utils/wasmImageCodec.ts')
  const sseStore = readRepoFile('src/frontend/src/store/sse.ts')
  const commentStream = readRepoFile('src/frontend/src/composables/useArticleCommentStream.ts')
  const viewTask = readRepoFile('src/frontend/src/composables/useViewTask.ts')

  it('keeps normal AEDS worker aborts on a cancel protocol instead of worker reset', () => {
    expect(binaryTransport).toContain('const WORKER_IDLE_TTL_MS = 30000')
    expect(binaryTransport).toContain('function scheduleWorkerIdleTerminate')
    expect(binaryTransport).toContain('function postWorkerCancel')
    expect(binaryTransport).toContain("type: 'cancel'")
    expect(binaryTransport).toContain("emitRumMetric('binary_worker_init_count'")
    expect(binaryTransport).not.toContain("resetWorker(createAbortLikeError('binary_decode_aborted'))")

    expect(decodeWorker).toContain('const canceledRequests = new Set<number>()')
    expect(decodeWorker).toContain('let wasmReadyPromise: Promise<boolean> | null = null')
    expect(decodeWorker).toContain('function ensureWasmReady')
    expect(decodeWorker).toContain("event.data.type === 'cancel'")
    expect(decodeWorker).toContain('postDecodeResponse(response)')
    expect(decodeWorker).toContain('isRequestCanceled(requestId)')
  })

  it('removes redundant image, wasm codec, and SSE batch copies', () => {
    expect(imageCompression).toContain('rgba: imageData.data')
    expect(imageCompression).toContain('new Blob([encoded], { type: mimeType })')
    expect(imageCompression).not.toContain('Uint8Array.from(imageData.data)')
    expect(imageCompression).not.toContain('Uint8Array.from(encoded)')

    expect(wasmImageCodec).toContain('let simdSupportCache: boolean | null = null')
    expect(wasmImageCodec).toContain('rgba: Uint8Array | Uint8ClampedArray')
    expect(wasmImageCodec).toContain('return decodeUtf8(view)')
    expect(wasmImageCodec).not.toContain('decodeUtf8(Uint8Array.from(view))')

    expect(sseStore).toContain('Object.freeze(patches)')
    expect(sseStore).not.toContain('Object.freeze([...patches])')
  })

  it('keeps search index bytes out of long-lived JS state', () => {
    expect(localSearch).toContain('let loadedEntryKeys = new Set<string>()')
    expect(localSearch).toContain('const EMPTY_SEARCH_PACKAGE = buildSearchPackage([])')
    expect(localSearch).toContain('Promise.all(roles.map')
    expect(localSearch).toContain('type CombinedAbortSignal')
    expect(localSearch).toContain('combinedSignal.cleanup()')
    expect(localSearch).toContain('function shouldPreloadBackgroundShard')
    expect(localSearch).toContain('deviceMemory')
    expect(localSearch).toContain('saveData')
    expect(localSearch).toContain('requestIdleCallback')
    expect(localSearch).not.toContain('loadedEntries')
  })

  it('guards cooperative loading state and reply maps without broad object copies', () => {
    expect(viewTask).toContain('let runSeq = 0')
    expect(viewTask).toContain('const seq = ++runSeq')
    expect(viewTask).toContain('seq === runSeq')

    expect(commentStream).toContain('reactive<Record<string, boolean>>({})')
    expect(commentStream).toContain('loadingReplies[rootId] = true')
    expect(commentStream).toContain('delete loadingReplies[rootId]')
    expect(commentStream).not.toContain('loadingReplies.value = {')
  })
})
