import { ApiError } from '../../Contracts/aeds.ts'
import { createCorpusSearch } from '../../Contracts/local-search.ts'
import { createWideSearch } from './wideSearch.ts'
import { canUseWideSearchStorage } from './wideSearchStorage.ts'
import type { WideSearchIdentity } from './wideSearchWire.ts'

type SearchRequest = { kind: 'search'; id: number; query: string; page: number; size: number }
type Visibility = { kind: 'compact'; generation: string } | { kind: 'wide'; identity: WideSearchIdentity }
type WorkerResult = { frame: Uint8Array<ArrayBuffer>; visibility: Visibility | null }
export type SearchCommand = SearchRequest | { kind: 'cancel'; id: number } |
  { kind: 'invalidate'; identity: WideSearchIdentity }
export type SearchReply =
  | { id: number; ok: true; frame: Uint8Array; visibility: Visibility | null }
  | { id: number; ok: false; status: number; message: string }

const compact = createCorpusSearch()
const wide = createWideSearch()
let pending: SearchRequest | undefined
let running: { id: number; controller: AbortController } | undefined

async function runSearch({ query, page, size }: SearchRequest, signal: AbortSignal): Promise<WorkerResult> {
  async function searchCompact(): Promise<WorkerResult> {
    const { frame, generation } = await compact(query, signal, page, size)
    return { frame, visibility: generation === null ? null : { kind: 'compact', generation } }
  }
  async function searchWide(): Promise<WorkerResult | undefined> {
    const result = await wide.search(query, page, size, signal)
    return result && { frame: result.frame, visibility: result.identity === null ? null : { kind: 'wide', identity: result.identity } }
  }

  if (wide.prefersWide()) return await searchWide() ?? await searchCompact()
  try {
    return await searchCompact()
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof ApiError) || error.status !== 503 || !canUseWideSearchStorage()) throw error
    const result = await searchWide()
    if (!result) throw error
    return result
  }
}

async function pump() {
  while (pending && !running) {
    const job: SearchRequest = pending
    pending = undefined
    const controller = new AbortController()
    running = { id: job.id, controller }
    try {
      const { frame, visibility } = await runSearch(job, controller.signal)
      if (!controller.signal.aborted) {
        self.postMessage({ id: job.id, ok: true, frame, visibility } satisfies SearchReply, { transfer: [frame.buffer] })
      }
    } catch (error) {
      if (!controller.signal.aborted) self.postMessage({
        id: job.id,
        ok: false,
        status: error instanceof ApiError ? error.status : 0,
        message: error instanceof Error ? error.message : 'Search worker failed',
      } satisfies SearchReply)
    } finally {
      running = undefined
    }
  }
}

self.addEventListener('message', ({ data }: MessageEvent<SearchCommand>) => {
  switch (data.kind) {
    case 'search':
      pending = data
      running?.controller.abort()
      void pump()
      break
    case 'cancel':
      if (pending?.id === data.id) pending = undefined
      if (running?.id === data.id) running.controller.abort()
      break
    case 'invalidate':
      void wide.invalidate(data.identity).catch(() => {})
      break
  }
})
