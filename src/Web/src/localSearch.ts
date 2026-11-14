import { ApiError, ProtocolError } from '../../Contracts/aeds.ts'
import { decodeLocalSearchResult, verifySearchGeneration } from '../../Contracts/local-search.ts'

type SearchReply =
  | { ok: true; frame: Uint8Array; generation: string | null }
  | { ok: false; status: number; message: string }

export function createLocalSearch() {
  let worker: Worker | undefined
  let active: AbortController | undefined

  function dispose() {
    active?.abort()
    worker?.terminate()
    worker = undefined
  }

  async function search(query: string, signal: AbortSignal, page = 1, size = 10) {
    signal.throwIfAborted()
    if (active) dispose()
    const request = new AbortController()
    active = request
    const cancel = () => request.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const current = worker ??= new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
      const reply = await new Promise<SearchReply>((resolve, reject) => {
        function cleanup() {
          current.onmessage = null
          current.onerror = null
          current.onmessageerror = null
          request.signal.removeEventListener('abort', abort)
        }
        function abort() {
          cleanup()
          reject(request.signal.reason)
        }
        function fail() {
          cleanup()
          reject(new ProtocolError('Search worker failed'))
        }
        current.onmessage = (event: MessageEvent<SearchReply>) => {
          cleanup()
          resolve(event.data)
        }
        current.onerror = fail
        current.onmessageerror = fail
        request.signal.addEventListener('abort', abort, { once: true })
        current.postMessage({ query, page, size })
      })
      if (!reply.ok) {
        throw reply.status
          ? new ApiError(reply.message, reply.status)
          : new ProtocolError(reply.message)
      }
      const result = decodeLocalSearchResult(reply.frame)
      if (reply.generation !== null) await verifySearchGeneration(reply.generation, request.signal)
      request.signal.throwIfAborted()
      return result
    } catch (error) {
      if (active === request) dispose()
      throw error
    } finally {
      signal.removeEventListener('abort', cancel)
      if (active === request) active = undefined
    }
  }

  return { search, dispose }
}
