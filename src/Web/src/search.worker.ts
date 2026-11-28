import { ApiError } from '../../Contracts/aeds.ts'
import { createCorpusSearch, type PublicSearchSort } from '../../Contracts/local-search.ts'
import { compactSearchStorage } from './compactSearchStorage.ts'
import { createWideSearch } from './wideSearch.ts'
import { canUseWideSearchStorage } from './wideSearchStorage.ts'
import type { WideSearchIdentity } from './wideSearchWire.ts'

export type WorkerSearchMode = 'auto' | 'local'
type SearchRequest = {
  kind: 'search'
  id: number
  query: string
  page: number
  size: number
  sort: PublicSearchSort
  mode: WorkerSearchMode
}
type Visibility = { kind: 'compact'; generation: string } | { kind: 'wide'; identity: WideSearchIdentity }
type WorkerResult =
  | { frame: Uint8Array<ArrayBuffer>; visibility: Visibility | null }
  | { fallback: 'server' }
export type SearchCommand = SearchRequest | { kind: 'cancel'; id: number } |
  { kind: 'invalidate'; identity: WideSearchIdentity }
export type SearchReply =
  | { id: number; ok: true; frame: Uint8Array; visibility: Visibility | null }
  | { id: number; ok: true; fallback: 'server' }
  | { id: number; ok: false; status: number; message: string }
export type SearchWorkerMessage = SearchReply | { id: number; stage: 'wide-admission' }

const compact = createCorpusSearch({ storage: compactSearchStorage })
const wide = createWideSearch()
let pending: SearchRequest | undefined
let running: { id: number; controller: AbortController; wideAdmission: boolean } | undefined

function postWideAdmission(id: number) {
  self.postMessage({ id, stage: 'wide-admission' } satisfies SearchWorkerMessage)
}

async function runSearch({ query, page, size, sort, mode }: SearchRequest, signal: AbortSignal,
  onWideAdmission: () => void): Promise<WorkerResult> {
  async function searchCompact(): Promise<WorkerResult> {
    const { frame, generation } = await compact(query, signal, page, size, sort)
    return { frame, visibility: generation === null ? null : { kind: 'compact', generation } }
  }
  async function searchWide(): Promise<WorkerResult | undefined> {
    const result = await wide.search(query, page, size, signal, sort, onWideAdmission)
    return result && { frame: result.frame, visibility: result.identity === null ? null : { kind: 'wide', identity: result.identity } }
  }

  let triedWide = false
  if (wide.prefersWide()) {
    triedWide = true
    const wideResult = await searchWide()
    if (wideResult) return wideResult
  }
  try {
    return await searchCompact()
  } catch (error) {
    signal.throwIfAborted()
    if (!(error instanceof ApiError) || (error.status !== 503 && !(mode === 'auto' && error.status === 404))) throw error
    if (!triedWide && canUseWideSearchStorage()) {
      const result = await searchWide()
      if (result) return result
    }
    if (mode === 'auto') return { fallback: 'server' }
    throw error
  }
}

async function pump() {
  while (pending && !running) {
    const job: SearchRequest = pending
    pending = undefined
    const controller = new AbortController()
    const operation = { id: job.id, controller, wideAdmission: false }
    running = operation
    try {
      const outcome = await runSearch(job, controller.signal, () => {
        operation.wideAdmission = true
        if (!controller.signal.aborted) postWideAdmission(job.id)
        // A queued query inherits admission while the superseded query finishes sealing the corpus.
        if (pending) postWideAdmission(pending.id)
      })
      if (!controller.signal.aborted) {
        if ('fallback' in outcome) {
          self.postMessage({ id: job.id, ok: true, fallback: outcome.fallback } satisfies SearchReply)
        } else {
          self.postMessage(
            { id: job.id, ok: true, frame: outcome.frame, visibility: outcome.visibility } satisfies SearchReply,
            { transfer: [outcome.frame.buffer] },
          )
        }
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
      if (running?.wideAdmission) postWideAdmission(data.id)
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
