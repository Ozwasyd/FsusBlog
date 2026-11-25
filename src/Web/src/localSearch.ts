import { ApiError, ProtocolError } from '../../Contracts/aeds.ts'
import { api, type PublicSearchResultItem, type PublicSearchV2Page } from '../../Contracts/client.ts'
import {
  decodeLocalSearchResult, verifySearchGeneration, type PublicSearchSort,
} from '../../Contracts/local-search.ts'
import { WireLimits } from '../../Contracts/wire.generated.ts'
import { discardCompactSearchCorpus } from './compactSearchStorage.ts'
import type { SearchCommand, SearchReply, WorkerSearchMode } from './search.worker.ts'
import { verifyWideSearchGeneration } from './wideSearchWire.ts'

export type PublicSearchMode = 'auto' | 'local' | 'server'
export type PublicSearchDisplayResult = PublicSearchV2Page & Readonly<{
  usesCursors: boolean
  restartedFromGenerationChange?: boolean
}>
export type LocalSearchOptions = Readonly<{
  requestTimeoutMs?: number
}>

const defaultRequestTimeoutMs = 15_000

export function readPublicSearchMode(): PublicSearchMode {
  const value = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-search-mode"]')?.content
  return value === 'auto' || value === 'local' ? value : 'server'
}

function adaptLocalPage(
  items: readonly import('../../Contracts/public-articles.ts').ArticleCard[],
  total: number,
  page: number,
  size: number,
  generation: string,
  restartedFromGenerationChange?: boolean,
): PublicSearchDisplayResult {
  const adapted: PublicSearchResultItem[] = items.map(item => ({
    ...item,
    matchTier: 'primary',
    snippetField: 'none',
    snippet: '',
    highlights: [],
  }))
  return {
    generation,
    profileVersion: WireLimits.SearchFas4Profile,
    analyzerVersion: WireLimits.SearchAnalyzerVersion,
    total,
    totalRelation: 'exact',
    primaryCount: total,
    relaxedCount: 0,
    hasMore: page * size < total,
    nextCursor: null,
    items: adapted,
    usesCursors: false,
    ...(restartedFromGenerationChange ? { restartedFromGenerationChange: true } : {}),
  }
}

function isServerGenerationChange(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.details === 'search_generation_changed'
}

export function createLocalSearch(options?: LocalSearchOptions) {
  const requestTimeoutMs = options?.requestTimeoutMs ?? defaultRequestTimeoutMs
  let worker: Worker | undefined
  let active: AbortController | undefined
  let sequence = 0
  let preferServer = false

  function stopWorker() {
    worker?.terminate()
    worker = undefined
  }

  function dispose() {
    active?.abort()
    stopWorker()
    preferServer = false
  }

  function startWorker() {
    const instance = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
    function fail() {
      if (worker !== instance) return
      active?.abort(new ProtocolError('Search worker failed'))
      stopWorker()
    }
    instance.addEventListener('error', fail)
    instance.addEventListener('messageerror', fail)
    return instance
  }

  async function runServerSearch(
    query: string,
    signal: AbortSignal,
    page: number,
    size: number,
    sort: PublicSearchSort,
    cursor?: string,
  ): Promise<PublicSearchDisplayResult> {
    if (page > 1 && !cursor) {
      throw new ApiError('Invalid or expired search cursor.', 400, 'search_cursor_invalid')
    }
    try {
      const result = await api.searchV2(query, signal, { sort, size, cursor })
      signal.throwIfAborted()
      return { ...result, usesCursors: true }
    } catch (error) {
      signal.throwIfAborted()
      if (isServerGenerationChange(error)) {
        // Safe single automatic recovery on identified generation change:
        // discard obsolete cursor/page state and restart coherently from page 1 within the original deadline.
        const restarted = await api.searchV2(query, signal, { sort, size, cursor: undefined })
        signal.throwIfAborted()
        return { ...restarted, usesCursors: true, restartedFromGenerationChange: true }
      }
      throw error
    }
  }

  async function executeWorkerSearch(
    current: Worker,
    id: number,
    query: string,
    page: number,
    size: number,
    sort: PublicSearchSort,
    workerMode: WorkerSearchMode,
    signal: AbortSignal,
  ): Promise<SearchReply> {
    return new Promise<SearchReply>((resolve, reject) => {
      function cleanup() {
        current.removeEventListener('message', receive)
        signal.removeEventListener('abort', abort)
      }
      function abort() {
        cleanup()
        current.postMessage({ kind: 'cancel', id } satisfies SearchCommand)
        reject(signal.reason)
      }
      function receive(event: MessageEvent<SearchReply>) {
        if (event.data.id !== id) return
        cleanup()
        resolve(event.data)
      }
      current.addEventListener('message', receive)
      signal.addEventListener('abort', abort, { once: true })
      current.postMessage({ kind: 'search', id, query, page, size, sort, mode: workerMode } satisfies SearchCommand)
    })
  }

  async function search(
    query: string,
    signal: AbortSignal,
    page = 1,
    size = 10,
    sort: PublicSearchSort = 'relevance',
    cursor?: string,
  ): Promise<PublicSearchDisplayResult> {
    signal.throwIfAborted()
    active?.abort()
    const request = new AbortController()
    active = request
    const cancel = () => request.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    const deadlineSignal = requestTimeoutMs > 0
      ? AbortSignal.any([request.signal, AbortSignal.timeout(requestTimeoutMs)])
      : request.signal
    try {
      const mode = readPublicSearchMode()
      if (mode === 'server' || (mode === 'auto' && (preferServer || typeof Worker === 'undefined'))) {
        return await runServerSearch(query, deadlineSignal, page, size, sort, cursor)
      }
      if (typeof Worker === 'undefined') {
        throw new ProtocolError('Local search requires browser Web Worker support.')
      }
      const workerMode: WorkerSearchMode = mode === 'local' ? 'local' : 'auto'

      for (let attempt = 0; attempt < 2; attempt++) {
        deadlineSignal.throwIfAborted()
        const targetPage = attempt === 0 ? page : 1
        const targetCursor = attempt === 0 ? cursor : undefined
        const id = ++sequence
        const current = worker ??= startWorker()
        const reply = await executeWorkerSearch(current, id, query, targetPage, size, sort, workerMode, deadlineSignal)
        if (!reply.ok) {
          if (reply.status === 409) {
            if (worker === current) stopWorker()
            if (attempt === 0) continue
            throw new ApiError(reply.message, 409, 'search_generation_changed')
          }
          throw reply.status
            ? new ApiError(reply.message, reply.status)
            : new ProtocolError(reply.message)
        }
        if ('fallback' in reply) {
          const result = await runServerSearch(query, deadlineSignal, targetPage, size, sort, targetCursor)
          preferServer = true
          if (worker === current) stopWorker()
          return attempt > 0 ? { ...result, restartedFromGenerationChange: true } : result
        }
        const result = decodeLocalSearchResult(reply.frame)
        const visibility = reply.visibility
        let generation = '0'
        if (visibility?.kind === 'wide') {
          generation = visibility.identity.generation
          try {
            const limit = 5_000
            const deadline = Date.now() + limit
            await verifyWideSearchGeneration(visibility.identity, AbortSignal.any([deadlineSignal, AbortSignal.timeout(limit)]))
            if (Date.now() >= deadline) throw new DOMException('Public search visibility check timed out', 'TimeoutError')
          } catch (error) {
            if (!deadlineSignal.aborted &&
                (error instanceof ProtocolError || error instanceof ApiError && (error.status === 409 || error.status === 404))) {
              current.postMessage({ kind: 'invalidate', identity: visibility.identity } satisfies SearchCommand)
            }
            throw error
          }
        } else if (visibility?.kind === 'compact') {
          generation = visibility.generation
          try {
            await verifySearchGeneration(visibility.generation, deadlineSignal)
          } catch (error) {
            if (!deadlineSignal.aborted) {
              if (worker === current) stopWorker()
              if (error instanceof ProtocolError || error instanceof ApiError &&
                  (error.status === 409 || error.status === 404 || error.status === 503)) {
                await discardCompactSearchCorpus(visibility.generation).catch(() => {})
              }
              if (error instanceof ApiError && error.status === 409) {
                if (attempt === 0) continue
                throw new ApiError(error.message, 409, 'search_generation_changed')
              }
            }
            throw error
          }
        }
        deadlineSignal.throwIfAborted()
        return adaptLocalPage(result.items, result.total, targetPage, size, generation, attempt > 0)
      }
      throw new ApiError('Published articles have changed. Start from the first page to see current search results.', 409, 'search_generation_changed')
    } finally {
      signal.removeEventListener('abort', cancel)
      if (active === request) active = undefined
    }
  }

  return { search, dispose }
}
