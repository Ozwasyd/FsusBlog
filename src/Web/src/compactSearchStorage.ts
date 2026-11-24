import type { CompactSearchStorage, PersistedCompactCorpus } from '../../Contracts/local-search.ts'
import { WireLimits } from '../../Contracts/wire.generated.ts'
import * as corpusDb from './searchStorageDatabase.ts'

type CompactState = Readonly<{
  generation: string
  pageCount: number
  totalBytes: number
  digests: readonly string[]
  status: 'sealed'
}>

const databaseName = 'fsusblog-v2-compact-search-v1'
export const canUseCompactSearchStorage = (): boolean => corpusDb.isAvailable('compact')

function readState(value: unknown): CompactState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Partial<CompactState>
  if (state.status !== 'sealed' || !corpusDb.validGeneration(state.generation) ||
      typeof state.pageCount !== 'number' || !Number.isInteger(state.pageCount) ||
      state.pageCount < 1 || state.pageCount > WireLimits.SearchCorpusMaxPages ||
      typeof state.totalBytes !== 'number' || !Number.isInteger(state.totalBytes) ||
      state.totalBytes < state.pageCount * corpusDb.minimumPageBytes ||
      state.totalBytes > WireLimits.SearchCorpusTotalBytes ||
      !Array.isArray(state.digests) || state.digests.length !== state.pageCount ||
      !state.digests.every(digest => typeof digest === 'string' && corpusDb.digestPattern.test(digest))) {
    return undefined
  }
  return {
    generation: state.generation, pageCount: state.pageCount, totalBytes: state.totalBytes,
    digests: [...state.digests], status: 'sealed',
  }
}

const clearDatabase = (db: IDBDatabase) =>
  corpusDb.runStoresTx(db, 'readwrite', 'Compact search clear aborted', ({ metadata, pages }) => {
    corpusDb.clearStores(metadata, pages)
  })

function withLock<T>(signal: AbortSignal | undefined, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  return navigator.locks.request(databaseName, signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' }, async () => {
    signal?.throwIfAborted()
    const db = await corpusDb.open(databaseName, signal, () => new Error('Compact search storage is blocked'))
    db.onversionchange = () => db.close()
    try { return await work(db) } finally { db.close() }
  })
}

function readSealed(db: IDBDatabase): Promise<{ state?: CompactState; buffers: ArrayBuffer[]; rawPresent: boolean }> {
  return corpusDb.runStoresTx(db, 'readonly', 'Compact search read aborted', ({ metadata, pages }) => {
    let state: CompactState | undefined, rawPresent = false
    const buffers: ArrayBuffer[] = []
    const metaReq = metadata.get(corpusDb.stateKey)
    metaReq.onsuccess = () => {
      rawPresent = metaReq.result !== undefined
      state = readState(metaReq.result)
      if (!state) return
      for (let i = 1; i <= state.pageCount; i++) {
        const pageReq = pages.get(i)
        pageReq.onsuccess = () => { if (corpusDb.isFixedBuffer(pageReq.result)) buffers[i - 1] = pageReq.result }
      }
    }
    return () => ({ state, buffers, rawPresent })
  })
}

function writeSealed(db: IDBDatabase, state: CompactState, buffers: readonly ArrayBuffer[]): Promise<void> {
  return corpusDb.runStoresTx(db, 'readwrite', 'Compact search write aborted', ({ metadata, pages }) => {
    const existingReq = metadata.get(corpusDb.stateKey)
    existingReq.onsuccess = () => {
      const current = readState(existingReq.result)
      if (current && current.generation === state.generation && current.pageCount === state.pageCount &&
          current.totalBytes === state.totalBytes && current.digests.every((digest, index) => digest === state.digests[index])) return
      pages.clear()
      for (let i = 0; i < buffers.length; i++) pages.put(buffers[i], i + 1)
      metadata.put(state, corpusDb.stateKey)
    }
  })
}

export async function discardCompactSearchCorpus(generation: string, signal?: AbortSignal): Promise<void> {
  if (!canUseCompactSearchStorage() || !corpusDb.validGeneration(generation)) return
  await withLock(signal, db => corpusDb.runStoresTx(db, 'readwrite', 'Compact search discard aborted', ({ metadata, pages }) => {
    const req = metadata.get(corpusDb.stateKey)
    req.onsuccess = () => {
      const state = readState(req.result)
      if (!state || state.generation === generation) corpusDb.clearStores(metadata, pages)
    }
  }))
}

export const compactSearchStorage: CompactSearchStorage = {
  async load(signal?: AbortSignal): Promise<PersistedCompactCorpus | undefined> {
    if (!canUseCompactSearchStorage()) return undefined
    return withLock(signal, async db => {
      const { state, buffers, rawPresent } = await readSealed(db)
      const clearAndEmpty = async () => { await clearDatabase(db).catch(() => {}); return undefined }
      if (!state) return rawPresent ? clearAndEmpty() : undefined
      let total = 0
      const pages: Uint8Array[] = []
      for (let i = 0; i < state.pageCount; i++) {
        signal?.throwIfAborted()
        const buffer = buffers[i]
        if (!buffer || !corpusDb.validPageLength(buffer.byteLength)) return clearAndEmpty()
        total += buffer.byteLength
        if (await corpusDb.sha256Hex(buffer) !== state.digests[i]) return clearAndEmpty()
        pages.push(new Uint8Array(buffer))
      }
      return total === state.totalBytes ? { generation: state.generation, pages } : clearAndEmpty()
    })
  },

  async save(corpus: PersistedCompactCorpus, signal?: AbortSignal): Promise<void> {
    if (!canUseCompactSearchStorage() || !corpusDb.validGeneration(corpus.generation)) return
    const pageCount = corpus.pages.length
    if (pageCount < 1 || pageCount > WireLimits.SearchCorpusMaxPages) return
    const buffers: ArrayBuffer[] = [], digests: string[] = []
    let totalBytes = 0
    for (const page of corpus.pages) {
      signal?.throwIfAborted()
      if (!corpusDb.validPageLength(page.byteLength)) return
      if ((totalBytes += page.byteLength) > WireLimits.SearchCorpusTotalBytes) return
      const buffer = corpusDb.exactPageBuffer(page)
      buffers.push(buffer)
      digests.push(await corpusDb.sha256Hex(buffer))
    }
    const state: CompactState = { generation: corpus.generation, pageCount, totalBytes, digests, status: 'sealed' }
    await withLock(signal, db => writeSealed(db, state, buffers))
  },

  discard: discardCompactSearchCorpus,
}
