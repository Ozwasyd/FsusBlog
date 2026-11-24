import { ProtocolError } from '../../Contracts/aeds.ts'
import { WireLimits } from '../../Contracts/wire.generated.ts'
import * as corpusDb from './searchStorageDatabase.ts'

export type WideSearchStorageIdentity = Readonly<{
  generation: string
  digest: string
  pageCount: number
  byteCount: number
}>

export interface WideSearchStorage {
  select(identity: WideSearchStorageIdentity): Promise<string | undefined>
  begin(identity: WideSearchStorageIdentity): Promise<string>
  append(owner: string, number: number, bytes: Uint8Array): Promise<void>
  seal(owner: string): Promise<void>
  read(owner: string, number: number): Promise<Uint8Array<ArrayBuffer>>
  discard(owner: string): Promise<void>
}

type State = WideSearchStorageIdentity & {
  owner: string
  status: 'loading' | 'sealed'
  writtenPages: number
  writtenBytes: number
}
type Stores = { state?: State; metadata: IDBObjectStore; pages: IDBObjectStore }
type Operation<T> = (stores: Stores, complete: (value: T) => void, guard: (work: () => void) => void) => void

const databaseName = 'fsusblog-v2-wide-search-v1'
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function canUseWideSearchStorage(): boolean {
  return corpusDb.isAvailable('wide')
}

/** The caller supplies the wall deadline and freshly verified public identity. */
export async function withWideSearchStorage<T>(signal: AbortSignal,
  operation: (storage: WideSearchStorage) => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  if (!canUseWideSearchStorage()) throw new ProtocolError('Wide search storage is unavailable')

  return navigator.locks.request(databaseName, { mode: 'exclusive', signal }, async () => {
    signal.throwIfAborted()
    const database = await corpusDb.open(databaseName, signal, () => new ProtocolError('Wide search storage is blocked'))
    const stop = new AbortController()
    const scoped = AbortSignal.any([signal, stop.signal])
    let pending: Promise<unknown> | undefined
    database.onversionchange = () => {
      stop.abort(new ProtocolError('Wide search storage changed version'))
      database.close()
    }
    database.onclose = () => stop.abort(new ProtocolError('Wide search storage closed'))

    async function run<V>(mode: IDBTransactionMode, work: Operation<V>): Promise<V> {
      scoped.throwIfAborted()
      if (pending) throw new ProtocolError('Concurrent wide search storage transaction')
      const task = transaction(database, mode, scoped, work)
      pending = task
      try {
        return await task
      } finally {
        pending = undefined
      }
    }

    const storage: WideSearchStorage = {
      select(identity) {
        const requested = copyIdentity(identity)
        return run('readonly', ({ state }, complete) => {
          complete(state?.status === 'sealed' && sameIdentity(state, requested) ? state.owner : undefined)
        })
      },

      begin(identity) {
        const requested = copyIdentity(identity)
        const owner = crypto.randomUUID()
        return run('readwrite', ({ state, metadata, pages }, complete) => {
          if (state?.status === 'sealed' && sameIdentity(state, requested))
            throw new ProtocolError('This wide search corpus is already sealed')
          pages.clear()
          metadata.put({ ...requested, owner, status: 'loading', writtenPages: 0, writtenBytes: 0 } satisfies State, corpusDb.stateKey)
          complete(owner)
        })
      },

      append(owner, number, bytes) {
        return run('readwrite', ({ state, metadata, pages }, complete) => {
          const loading = requireOwner(state, owner, 'loading')
          const length = bytes.byteLength
          if (number !== loading.writtenPages + 1 || number > loading.pageCount || !corpusDb.validPageLength(length))
            throw new ProtocolError('Invalid wide search page sequence or size')
          const next = { ...loading, writtenPages: number, writtenBytes: loading.writtenBytes + length }
          if (!validProgress(next)) throw new ProtocolError('Wide search storage budget exceeded')
          pages.add({ owner, length, body: corpusDb.exactPageBuffer(bytes) }, number)
          metadata.put(next, corpusDb.stateKey)
          complete(undefined)
        })
      },

      seal(owner) {
        return run('readwrite', ({ state, metadata, pages }, complete, guard) => {
          const loading = requireOwner(state, owner, 'loading')
          if (!completeProgress(loading)) throw new ProtocolError('Wide search storage is incomplete')
          const count = pages.count()
          count.onsuccess = () => guard(() => {
            if (count.result !== loading.pageCount) throw new ProtocolError('Wide search stored page count changed')
            metadata.put({ ...loading, status: 'sealed' } satisfies State, corpusDb.stateKey)
            complete(undefined)
          })
        })
      },

      read(owner, number) {
        return run<Uint8Array<ArrayBuffer>>('readonly', ({ state, pages }, complete, guard) => {
          const sealed = requireOwner(state, owner, 'sealed')
          if (!Number.isInteger(number) || number < 1 || number > sealed.pageCount)
            throw new ProtocolError('Invalid wide search stored page number')
          const request = pages.get(number)
          request.onsuccess = () => guard(() => {
            const row: unknown = request.result
            if (typeof row !== 'object' || row === null || !('owner' in row) || row.owner !== owner ||
                !('body' in row) || !corpusDb.isFixedBuffer(row.body) || !corpusDb.validPageLength(row.body.byteLength) ||
                !('length' in row) || row.length !== row.body.byteLength)
              throw new ProtocolError('Wide search stored page is unavailable')
            complete(new Uint8Array(row.body))
          })
        })
      },

      discard(owner) {
        return run('readwrite', ({ state, metadata, pages }, complete) => {
          if (state?.owner === owner) corpusDb.clearStores(metadata, pages)
          complete(undefined)
        })
      },
    }

    try {
      const result = await operation(storage)
      scoped.throwIfAborted()
      return result
    } finally {
      // Keep the cross-tab lock until any native transaction has observed cancellation.
      stop.abort()
      await pending?.catch(() => {})
      database.close()
    }
  })
}

function transaction<T>(database: IDBDatabase, mode: IDBTransactionMode, signal: AbortSignal,
  work: Operation<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction([corpusDb.metadataStore, corpusDb.pageStore], mode)
    const metadata = tx.objectStore(corpusDb.metadataStore)
    const pages = tx.objectStore(corpusDb.pageStore)
    let failure: unknown
    let value: { result: T } | undefined
    const complete = (result: T) => { value = { result } }
    const abort = (cause: unknown) => {
      try {
        tx.abort()
        failure ??= cause
      } catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
      }
    }
    const cancel = () => abort(signal.reason)
    const guard = (request: () => void) => {
      try {
        signal.throwIfAborted()
        request()
      } catch (error) {
        abort(error)
      }
    }
    tx.oncomplete = () => {
      signal.removeEventListener('abort', cancel)
      if (failure !== undefined) reject(failure)
      else if (value === undefined) reject(new ProtocolError('Wide search storage transaction completed without a result'))
      else resolve(value.result)
    }
    tx.onabort = () => {
      signal.removeEventListener('abort', cancel)
      reject(failure ?? tx.error ?? new ProtocolError('Wide search storage transaction aborted'))
    }
    signal.addEventListener('abort', cancel, { once: true })
    guard(() => {
      const request = metadata.get(corpusDb.stateKey)
      request.onsuccess = () => guard(() => work({ state: readState(request.result), metadata, pages }, complete, guard))
    })
  })
}

function copyIdentity(identity: WideSearchStorageIdentity): WideSearchStorageIdentity {
  const { generation, digest, pageCount, byteCount } = identity
  const copy = { generation, digest, pageCount, byteCount }
  if (!validIdentity(copy)) throw new ProtocolError('Invalid wide search storage identity')
  return copy
}

function validIdentity(value: Partial<WideSearchStorageIdentity>): boolean {
  const { generation, digest, pageCount, byteCount } = value
  return corpusDb.validGeneration(generation) &&
    typeof digest === 'string' && corpusDb.digestPattern.test(digest) &&
    typeof pageCount === 'number' && Number.isInteger(pageCount) && pageCount >= 1 &&
    pageCount <= WireLimits.SearchWideCorpusMaxPages &&
    typeof byteCount === 'number' && Number.isInteger(byteCount) && byteCount <= WireLimits.SearchWideCorpusTotalBytes &&
    byteCount >= pageCount * corpusDb.minimumPageBytes && byteCount <= pageCount * WireLimits.SearchCorpusPageBytes
}

function readState(value: unknown): State | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const state = value as State
  if (!validIdentity(state) || typeof state.owner !== 'string' || !ownerPattern.test(state.owner) ||
      state.status !== 'loading' && state.status !== 'sealed' || !validProgress(state) ||
      state.status === 'sealed' && !completeProgress(state)) return undefined
  const { generation, digest, pageCount, byteCount, owner, status, writtenPages, writtenBytes } = state
  return { generation, digest, pageCount, byteCount, owner, status, writtenPages, writtenBytes }
}

function requireOwner(state: State | undefined, owner: string, status: State['status']): State {
  if (!state || state.owner !== owner || state.status !== status) throw new ProtocolError('Wide search storage owner changed')
  return state
}

function sameIdentity(left: WideSearchStorageIdentity, right: WideSearchStorageIdentity): boolean {
  return left.generation === right.generation && left.digest === right.digest &&
    left.pageCount === right.pageCount && left.byteCount === right.byteCount
}

function validProgress(state: State): boolean {
  const { writtenPages, writtenBytes, pageCount, byteCount } = state
  return Number.isInteger(writtenPages) && writtenPages >= 0 && writtenPages <= pageCount &&
    Number.isInteger(writtenBytes) && writtenBytes >= writtenPages * corpusDb.minimumPageBytes &&
    writtenBytes <= writtenPages * WireLimits.SearchCorpusPageBytes &&
    byteCount - writtenBytes >= (pageCount - writtenPages) * corpusDb.minimumPageBytes &&
    byteCount - writtenBytes <= (pageCount - writtenPages) * WireLimits.SearchCorpusPageBytes
}

function completeProgress(state: State): boolean {
  return state.writtenPages === state.pageCount && state.writtenBytes === state.byteCount
}
