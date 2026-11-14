import { ApiError, ProtocolError } from '../../Contracts/aeds.ts'
import { decodeLocalSearchResult, verifySearchGeneration } from '../../Contracts/local-search.ts'

type SearchReply =
  | { ok: true; frame: Uint8Array; generation: string | null }
  | { ok: false; status: number; message: string }

export async function searchLocal(query: string, signal: AbortSignal, page = 1, size = 10) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' })
  const reply = await new Promise<SearchReply>((resolve, reject) => {
    function dispose() {
      worker.terminate()
      signal.removeEventListener('abort', abort)
    }
    function abort() {
      dispose()
      reject(signal.reason)
    }

    worker.onmessage = (event: MessageEvent<SearchReply>) => {
      dispose()
      resolve(event.data)
    }
    worker.onerror = () => {
      dispose()
      reject(new ProtocolError('Search worker failed'))
    }
    signal.addEventListener('abort', abort, { once: true })
    worker.postMessage({ query, page, size })
  })
  if (!reply.ok) {
    throw reply.status
      ? new ApiError(reply.message, reply.status)
      : new ProtocolError(reply.message)
  }
  const result = decodeLocalSearchResult(reply.frame)
  if (reply.generation !== null) await verifySearchGeneration(reply.generation, signal)
  signal.throwIfAborted()
  return result
}
