import type { CompactSearchStorage, PersistedCompactCorpus } from '../../Contracts/local-search.ts'
import { WireLayouts, WireLimits } from '../../Contracts/wire.generated.ts'

type CompactState = Readonly<{
  generation: string
  pageCount: number
  totalBytes: number
  digests: readonly string[]
  status: 'sealed'
}>

const databaseName = 'fsusblog-v2-compact-search-v1'
const metadataStore = 'metadata'
const pageStore = 'pages'
const stateKey = 'corpus'
const minimumPageBytes = WireLayouts.SearchPackagePayloadOffset + WireLayouts.SearchShardHeaderSize
const generationPattern = /^(0|[1-9][0-9]{0,18})$/
const digestPattern = /^[0-9a-f]{64}$/
const maxInt64 = 9_223_372_036_854_775_807n

export function canUseCompactSearchStorage(): boolean {
  try {
    return globalThis.isSecureContext &&
      typeof globalThis.indexedDB?.open === 'function' &&
      typeof globalThis.navigator?.locks?.request === 'function' &&
      typeof globalThis.crypto?.subtle?.digest === 'function'
  } catch {
    return false
  }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

function fixedBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && (!('resizable' in value) || value.resizable === false)
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes
  if (fixedBuffer(buffer) && byteOffset === 0 && byteLength === buffer.byteLength) return buffer
  const copy = new Uint8Array(byteLength)
  copy.set(bytes)
  return copy.buffer
}

function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && generationPattern.test(value) && BigInt(value) <= maxInt64
}

function validPageLength(length: number): boolean {
  return Number.isInteger(length) && length >= minimumPageBytes && length <= WireLimits.SearchCorpusPageBytes
}

function readState(value: unknown): CompactState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as Partial<CompactState>
  if (state.status !== 'sealed' || !validGeneration(state.generation) ||
      typeof state.pageCount !== 'number' || !Number.isInteger(state.pageCount) ||
      state.pageCount < 1 || state.pageCount > WireLimits.SearchCorpusMaxPages ||
      typeof state.totalBytes !== 'number' || !Number.isInteger(state.totalBytes) ||
      state.totalBytes < state.pageCount * minimumPageBytes ||
      state.totalBytes > WireLimits.SearchCorpusTotalBytes ||
      !Array.isArray(state.digests) || state.digests.length !== state.pageCount ||
      !state.digests.every(digest => typeof digest === 'string' && digestPattern.test(digest))) {
    return undefined
  }
  return {
    generation: state.generation,
    pageCount: state.pageCount,
    totalBytes: state.totalBytes,
    digests: [...state.digests],
    status: 'sealed',
  }
}

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', cancel)
      reject(error)
    }
    const cancel = () => fail(signal?.reason)
    request.onupgradeneeded = () => {
      if (settled || signal?.aborted) {
        request.transaction?.abort()
        return
      }
      request.result.createObjectStore(metadataStore)
      request.result.createObjectStore(pageStore)
    }
    request.onblocked = () => fail(new Error('Compact search storage is blocked'))
    request.onerror = () => fail(request.error)
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      signal?.removeEventListener('abort', cancel)
      resolve(request.result)
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

function clearDatabase(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([metadataStore, pageStore], 'readwrite')
    tx.objectStore(pagesStoreName()).clear()
    tx.objectStore(metadataStore).delete(stateKey)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Compact search clear aborted'))
  })
}

function pagesStoreName() { return pageStore }

function withLock<T>(signal: AbortSignal | undefined, work: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const options: LockOptions = signal ? { mode: 'exclusive', signal } : { mode: 'exclusive' }
  return navigator.locks.request(databaseName, options, async () => {
    signal?.throwIfAborted()
    const db = await openDatabase(signal)
    db.onversionchange = () => db.close()
    try {
      return await work(db)
    } finally {
      db.close()
    }
  })
}

function readSealed(db: IDBDatabase): Promise<{ state?: CompactState; buffers: ArrayBuffer[]; rawPresent: boolean }> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([metadataStore, pageStore], 'readonly')
    const metaReq = tx.objectStore(metadataStore).get(stateKey)
    const pages = tx.objectStore(pageStore)
    let state: CompactState | undefined
    let rawPresent = false
    const buffers: ArrayBuffer[] = []
    metaReq.onsuccess = () => {
      rawPresent = metaReq.result !== undefined
      state = readState(metaReq.result)
      if (!state) return
      for (let i = 1; i <= state.pageCount; i++) {
        const pageReq = pages.get(i)
        pageReq.onsuccess = () => {
          if (fixedBuffer(pageReq.result)) buffers[i - 1] = pageReq.result
        }
      }
    }
    tx.oncomplete = () => resolve({ state, buffers, rawPresent })
    tx.onabort = () => reject(tx.error ?? new Error('Compact search read aborted'))
  })
}

function writeSealed(db: IDBDatabase, state: CompactState, buffers: readonly ArrayBuffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([metadataStore, pageStore], 'readwrite')
    const metadata = tx.objectStore(metadataStore)
    const pages = tx.objectStore(pageStore)
    const existingReq = metadata.get(stateKey)
    existingReq.onsuccess = () => {
      const current = readState(existingReq.result)
      if (current && current.generation === state.generation && current.pageCount === state.pageCount &&
          current.totalBytes === state.totalBytes &&
          current.digests.every((digest, index) => digest === state.digests[index])) {
        return
      }
      pages.clear()
      for (let i = 0; i < buffers.length; i++) pages.put(buffers[i], i + 1)
      metadata.put(state, stateKey)
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Compact search write aborted'))
  })
}

export async function discardCompactSearchCorpus(generation: string, signal?: AbortSignal): Promise<void> {
  if (!canUseCompactSearchStorage() || !validGeneration(generation)) return
  await withLock(signal, async db => {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([metadataStore, pageStore], 'readwrite')
      const metadata = tx.objectStore(metadataStore)
      const pages = tx.objectStore(pageStore)
      const req = metadata.get(stateKey)
      req.onsuccess = () => {
        const state = readState(req.result)
        if (!state || state.generation === generation) {
          pages.clear()
          metadata.delete(stateKey)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error ?? new Error('Compact search discard aborted'))
    })
  })
}

export const compactSearchStorage: CompactSearchStorage = {
  async load(signal?: AbortSignal): Promise<PersistedCompactCorpus | undefined> {
    if (!canUseCompactSearchStorage()) return undefined
    return withLock(signal, async db => {
      const { state, buffers, rawPresent } = await readSealed(db)
      if (!state) {
        if (rawPresent) await clearDatabase(db).catch(() => {})
        return undefined
      }
      let total = 0
      const pages: Uint8Array[] = []
      for (let i = 0; i < state.pageCount; i++) {
        signal?.throwIfAborted()
        const buffer = buffers[i]
        if (!buffer || !validPageLength(buffer.byteLength)) {
          await clearDatabase(db).catch(() => {})
          return undefined
        }
        total += buffer.byteLength
        const digest = await sha256Hex(buffer)
        if (digest !== state.digests[i]) {
          await clearDatabase(db).catch(() => {})
          return undefined
        }
        pages.push(new Uint8Array(buffer))
      }
      if (total !== state.totalBytes) {
        await clearDatabase(db).catch(() => {})
        return undefined
      }
      return { generation: state.generation, pages }
    })
  },

  async save(corpus: PersistedCompactCorpus, signal?: AbortSignal): Promise<void> {
    if (!canUseCompactSearchStorage() || !validGeneration(corpus.generation)) return
    const pageCount = corpus.pages.length
    if (pageCount < 1 || pageCount > WireLimits.SearchCorpusMaxPages) return
    const buffers: ArrayBuffer[] = []
    const digests: string[] = []
    let totalBytes = 0
    for (const page of corpus.pages) {
      signal?.throwIfAborted()
      if (!validPageLength(page.byteLength)) return
      totalBytes += page.byteLength
      if (totalBytes > WireLimits.SearchCorpusTotalBytes) return
      const buffer = exactBuffer(page)
      buffers.push(buffer)
      digests.push(await sha256Hex(buffer))
    }
    const state: CompactState = { generation: corpus.generation, pageCount, totalBytes, digests, status: 'sealed' }
    await withLock(signal, db => writeSealed(db, state, buffers))
  },

  discard: discardCompactSearchCorpus,
}
