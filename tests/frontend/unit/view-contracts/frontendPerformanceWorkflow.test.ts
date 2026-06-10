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
  const notificationStreamStore = readRepoFile('src/frontend/src/store/notificationStream.ts')
  const commentStream = readRepoFile('src/frontend/src/composables/useArticleCommentStream.ts')
  const viewTask = readRepoFile('src/frontend/src/composables/useViewTask.ts')
  const commentList = readRepoFile('src/frontend/src/components/article/ArticleCommentsVirtualList.vue')
  const publicCommentIsland = readRepoFile('src/frontend/src/public-renderers/PublicArticleCommentsIsland.vue')
  const messagesPage = readRepoFile('src/frontend/src/views/user/Messages.vue')
  const markdownAdapter = readRepoFile('src/frontend/src/components/ui/MarkdownEditorAdapter.vue')
  const markdownRenderer = readRepoFile('src/frontend/src/components/ui/MarkdownRenderer.vue')
  const packageJson = readRepoFile('src/frontend/package.json')

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

  it('removes redundant image, wasm codec, and notification stream batch copies', () => {
    expect(imageCompression).toContain('rgba: imageData.data')
    expect(imageCompression).toContain('new Blob([encoded as unknown as BlobPart], { type: mimeType })')
    expect(imageCompression).not.toContain('Uint8Array.from(imageData.data)')
    expect(imageCompression).not.toContain('Uint8Array.from(encoded)')

    expect(wasmImageCodec).toContain('let simdSupportCache: boolean | null = null')
    expect(wasmImageCodec).toContain('rgba: Uint8Array | Uint8ClampedArray')
    expect(wasmImageCodec).toContain('return decodeUtf8(view.buffer.slice')
    expect(wasmImageCodec).not.toContain('decodeUtf8(Uint8Array.from(view))')

    expect(notificationStreamStore).toContain('Object.freeze(patches)')
    expect(notificationStreamStore).not.toContain('Object.freeze([...patches])')
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
    expect(commentStream).toContain('const replyControllerByRoot = new Map<string, AbortController>()')
    expect(commentStream).toContain('COMMENT_CONTENT_CONSTRAINT.replyRenderLimit')
    expect(commentStream).not.toContain('const replyTask = useAbortableTask()')
    expect(commentStream).not.toContain('loadingReplies.value = {')
  })

  it('keeps DOM and markdown render pressure budgets wired into frontend gates', () => {
    expect(packageJson).toContain('check:dom-depth-static')
    expect(packageJson).toContain('check:dom-budget')
    expect(packageJson).toContain('check:route-render-pressure')
    expect(packageJson).toContain('check:markdown-render-budget')

    expect(markdownAdapter).toContain('MARKDOWN_PREVIEW_DEBOUNCE_MS = 250')
    expect(markdownAdapter).toContain('LARGE_PREVIEW_CONTENT_BYTES = 80 * 1024')
    expect(markdownAdapter).toContain('v-if="isPreviewMounted"')
    expect(markdownAdapter).toContain('refreshManualPreview')
    expect(markdownRenderer).toContain('@features-activated')
    expect(markdownRenderer).toContain("emit('features-activated'")
    expect(markdownRenderer).not.toContain('markdownActivationService')
    expect(packageJson).toContain('"@ozwasyd/element-plus": "1.5.0"')

    expect(commentList).toContain('COMMENT_CONTENT_CONSTRAINT.rootRenderLimit')
    expect(commentList).toContain('visibleThreadItems')
    expect(publicCommentIsland).toContain('visibleRootLimit')
    expect(messagesPage).toContain('CONVERSATION_RENDER_WINDOW')
    expect(messagesPage).toContain('MESSAGE_RENDER_WINDOW')
    expect(messagesPage).toContain('visibleConversationRows')
    expect(messagesPage).not.toContain('v-show="showDetailPane"')
  })
})
