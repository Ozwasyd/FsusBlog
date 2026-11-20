import { ApiError, ProtocolError } from '../../Contracts/aeds.ts'
import { api } from '../../Contracts/client.ts'
import {
  decodeLocalSearchResult, verifySearchGeneration, type PublicSearchSort,
} from '../../Contracts/local-search.ts'
import { discardCompactSearchCorpus } from './compactSearchStorage.ts'
import type { SearchCommand, SearchReply, WorkerSearchMode } from './search.worker.ts'
import { verifyWideSearchGeneration } from './wideSearchWire.ts'

export type PublicSearchMode = 'auto' | 'local' | 'server'

function readPublicSearchMode(): PublicSearchMode {
  const value = document.head.querySelector<HTMLMetaElement>('meta[name="fsus-public-search-mode"]')?.content
  return value === 'server' || value === 'local' ? value : 'auto'
}

export function createLocalSearch() {
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

  async function search(
    query: string,
    signal: AbortSignal,
    page = 1,
    size = 10,
    sort: PublicSearchSort = 'relevance',
  ) {
    signal.throwIfAborted()
    active?.abort()
    const request = new AbortController()
    const id = ++sequence
    active = request
    const cancel = () => request.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const mode = readPublicSearchMode()
      if (mode === 'server' || (mode === 'auto' && preferServer)) {
        const result = await api.search(query, request.signal, { sort, page, size })
        request.signal.throwIfAborted()
        return result
      }
      const workerMode: WorkerSearchMode = mode === 'local' ? 'local' : 'auto'
      const current = worker ??= startWorker()
      const reply = await new Promise<SearchReply>((resolve, reject) => {
        function cleanup() {
          current.removeEventListener('message', receive)
          request.signal.removeEventListener('abort', abort)
        }
        function abort() {
          cleanup()
          current.postMessage({ kind: 'cancel', id } satisfies SearchCommand)
          reject(request.signal.reason)
        }
        function receive(event: MessageEvent<SearchReply>) {
          if (event.data.id !== id) return
          cleanup()
          resolve(event.data)
        }
        current.addEventListener('message', receive)
        request.signal.addEventListener('abort', abort, { once: true })
        current.postMessage({ kind: 'search', id, query, page, size, sort, mode: workerMode } satisfies SearchCommand)
      })
      if (!reply.ok) {
        throw reply.status
          ? new ApiError(reply.message, reply.status)
          : new ProtocolError(reply.message)
      }
      if ('fallback' in reply) {
        const result = await api.search(query, request.signal, { sort, page, size })
        request.signal.throwIfAborted()
        preferServer = true
        if (worker === current) stopWorker()
        return result
      }
      const result = decodeLocalSearchResult(reply.frame)
      const visibility = reply.visibility
      if (visibility?.kind === 'wide') {
        try {
          const limit = 5_000
          const deadline = Date.now() + limit
          await verifyWideSearchGeneration(visibility.identity, AbortSignal.any([request.signal, AbortSignal.timeout(limit)]))
          if (Date.now() >= deadline) throw new DOMException('Public search visibility check timed out', 'TimeoutError')
        } catch (error) {
          if (!request.signal.aborted &&
              (error instanceof ProtocolError || error instanceof ApiError && (error.status === 409 || error.status === 404))) {
            current.postMessage({ kind: 'invalidate', identity: visibility.identity } satisfies SearchCommand)
          }
          throw error
        }
      } else if (visibility?.kind === 'compact') {
        try {
          await verifySearchGeneration(visibility.generation, request.signal)
        } catch (error) {
          if (!request.signal.aborted) {
            if (worker === current) stopWorker()
            if (error instanceof ProtocolError || error instanceof ApiError &&
                (error.status === 409 || error.status === 404 || error.status === 503)) {
              await discardCompactSearchCorpus(visibility.generation).catch(() => {})
            }
          }
          throw error
        }
      }
      request.signal.throwIfAborted()
      return result
    } finally {
      signal.removeEventListener('abort', cancel)
      if (active === request) active = undefined
    }
  }

  return { search, dispose }
}
