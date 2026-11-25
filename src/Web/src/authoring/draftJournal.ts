import { WireLimits } from '../../../Contracts/wire.generated.ts'

export const draftJournalLifetimeMs = 7 * 24 * 60 * 60 * 1000

const databaseName = 'fsusblog-v2-draft-recovery'
const recordsStore = 'recovery'
const scopesStore = 'scopes'
const maxRecords = 32
const maxBytes = 8 * 1024 * 1024
const encoder = new TextEncoder()
const scopeId = /^[a-zA-Z0-9:./_@-]{1,256}$/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digestHex = /^[0-9a-f]{64}$/

export interface DraftJournalScope { readonly site: string; readonly userId: string }
export type DraftTarget = Readonly<{ articleId: number }> | Readonly<{ createDraftId: string }>
export interface JournalSource { readonly title: string; readonly body: string }
export interface PendingSource extends JournalSource { readonly baseRevision: bigint; readonly editSequence: number }
export type RecoveryCandidate = Readonly<PendingSource & {
  readonly writer: string; readonly updatedAt: number; readonly expiresAt: number
  readonly relationship: 'restore' | 'compare'; readonly target?: DraftTarget
}>
type RecoveryRecord = PendingSource & DraftJournalScope & {
  key: [string, string, string, string]; document: string; writer: string; version: 1
  digest: string; createdAt: number; updatedAt: number; expiresAt: number; bytes: number
}

type Admission = 'stored' | 'stale' | 'full' | 'closed'
type PendingWrite = { document: string; sequence: number; cancelled: boolean }
type RecoveryCopy = Readonly<{ target: DraftTarget; source: PendingSource }>
type DiscardScope = Readonly<{ signal: AbortSignal; current: () => boolean }>

function documentKey(target: DraftTarget): string {
  if ('articleId' in target) {
    if (Number.isSafeInteger(target.articleId) && target.articleId > 0) return `article:${target.articleId}`
  } else if (uuid.test(target.createDraftId)) {
    return `draft:${target.createDraftId}`
  }
  throw new TypeError('Invalid draft identity')
}

function sourceBytes(source: JournalSource): number {
  const title = encoder.encode(source.title).length
  const body = encoder.encode(source.body).length
  if (title > WireLimits.TitleBytes || body > WireLimits.BodyBytes) throw new RangeError('Recovery record is too large')
  return title + body
}

async function sourceDigest(source: JournalSource): Promise<string> {
  const bytes = encoder.encode(JSON.stringify([source.title, source.body]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2)
    let blocked = false
    request.onupgradeneeded = event => {
      if (event.oldVersion === 0) request.result.createObjectStore(recordsStore, { keyPath: 'key' })
      request.result.createObjectStore(scopesStore)
    }
    request.onsuccess = () => blocked ? request.result.close() : resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => {
      blocked = true
      reject(new Error('Draft recovery database is blocked'))
    }
  })
}

function admitted(record: RecoveryRecord, now: number): boolean {
  if (record.version !== 1
    || typeof record.site !== 'string' || !scopeId.test(record.site)
    || typeof record.userId !== 'string' || !scopeId.test(record.userId)
    || typeof record.writer !== 'string' || !uuid.test(record.writer)
    || typeof record.document !== 'string'
    || !Array.isArray(record.key) || record.key.length !== 4
    || record.key[0] !== record.site || record.key[1] !== record.userId
    || record.key[2] !== record.document || record.key[3] !== record.writer
    || typeof record.digest !== 'string' || !digestHex.test(record.digest)
    || typeof record.title !== 'string' || typeof record.body !== 'string'
    || typeof record.baseRevision !== 'bigint' || record.baseRevision < 0n
    || !Number.isSafeInteger(record.editSequence) || record.editSequence < 1
    || !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.updatedAt)
    || record.createdAt > record.updatedAt || record.updatedAt > now
    || record.expiresAt !== record.updatedAt + draftJournalLifetimeMs || record.expiresAt <= now) return false
  try {
    return sourceBytes(record) === record.bytes
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
  }
}

function transaction<Result>(
  database: IDBDatabase,
  scope: DraftJournalScope,
  fn: (store: IDBObjectStore, records: RecoveryRecord[], generation: string, revoke: () => void) => Result,
  { mode = 'readwrite', signal, pruneInvalid = true }:
    { mode?: 'readonly' | 'readwrite'; signal?: AbortSignal; pruneInvalid?: boolean } = {},
): Promise<Result> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const tx = database.transaction([recordsStore, scopesStore], mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
    const abort = () => {
      try { tx.abort() } catch { /* A commit can already have completed when the scope changes. */ }
    }
    signal?.addEventListener('abort', abort, { once: true })
    const store = tx.objectStore(recordsStore)
    const scopes = tx.objectStore(scopesStore)
    const key = [scope.site, scope.userId]
    const readScope = scopes.get(key)
    let result: Result
    let error: unknown
    tx.oncomplete = () => {
      signal?.removeEventListener('abort', abort)
      resolve(result)
    }
    tx.onabort = () => {
      signal?.removeEventListener('abort', abort)
      reject(error ?? tx.error ?? new Error('Draft recovery transaction aborted'))
    }
    readScope.onsuccess = () => {
      const read = store.getAll()
      read.onsuccess = () => {
        try {
          const generation: unknown = readScope.result ?? ''
          if (typeof generation !== 'string') throw new TypeError('Invalid recovery scope generation')
          const now = Date.now()
          const live = (read.result as RecoveryRecord[]).filter(record => {
            const valid = admitted(record, now)
            if (!valid && mode === 'readwrite' && pruneInvalid) store.delete(record.key)
            return valid
          })
          result = fn(store, live, generation, () => { scopes.put(crypto.randomUUID(), key) })
        } catch (cause) {
          error = cause
          abort()
        }
      }
    }
  })
}

/**
 * Short-lived plaintext recovery in IndexedDB. Each independently opened journal gets a distinct
 * writer ID, so two browser tabs never silently overwrite or acknowledge each other's input.
 * Callers must authenticate a stable server user/site before opening, and purge after sign-out.
 */
export class DraftJournal {
  readonly #database: IDBDatabase
  readonly #scope: DraftJournalScope
  readonly #writer = crypto.randomUUID()
  readonly #pending = new Set<PendingWrite>()
  #generation = ''
  #closed = false

  private constructor(database: IDBDatabase, scope: DraftJournalScope) {
    this.#database = database
    this.#scope = Object.freeze({ ...scope })
    database.onversionchange = () => this.close()
  }

  static async open(scope: DraftJournalScope): Promise<DraftJournal> {
    if (!scopeId.test(scope.site) || !scopeId.test(scope.userId)) throw new TypeError('Invalid recovery scope')
    const journal = new DraftJournal(await openDatabase(), scope)
    try {
      journal.#generation = await transaction(journal.#database, journal.#scope, (_store, _records, generation) => generation)
      return journal
    } catch (error) {
      journal.close()
      throw error
    }
  }

  async write(target: DraftTarget, source: PendingSource): Promise<Admission> {
    const document = documentKey(target)
    const { title, body, baseRevision, editSequence } = source
    if (typeof baseRevision !== 'bigint' || baseRevision < 0n || !Number.isSafeInteger(editSequence) || editSequence < 1) {
      throw new TypeError('Invalid recovery revision')
    }
    if (this.#closed) return 'closed'
    const bytes = sourceBytes({ title, body })
    const pending = { document, sequence: editSequence, cancelled: false }
    this.#pending.add(pending)
    try {
      const digest = await sourceDigest({ title, body })
      if (this.#closed) return 'closed'
      return await transaction(this.#database, this.#scope, (store, live, generation) => {
        if (this.#closed || this.#generation !== generation) return 'closed'
        if (pending.cancelled) return 'stale'
        const current = live.find(record => this.#matches(document, record) && record.writer === this.#writer)
        if (current && editSequence <= current.editSequence) return 'stale'
        const usage = live.reduce((sum, record) => sum + record.bytes, 0) - (current?.bytes ?? 0)
        if ((!current && live.length >= maxRecords) || usage + bytes > maxBytes) return 'full'
        const now = Date.now()
        const mutated = current?.digest !== digest
        const updatedAt = mutated ? now : current.updatedAt
        const record: RecoveryRecord = {
          ...this.#scope, writer: this.#writer, document, version: 1, title, body, bytes, digest, baseRevision,
          key: [this.#scope.site, this.#scope.userId, document, this.#writer],
          editSequence, createdAt: current?.createdAt ?? now, updatedAt, expiresAt: updatedAt + draftJournalLifetimeMs,
        }
        store.put(record)
        return 'stored'
      })
    } finally {
      this.#pending.delete(pending)
    }
  }

  verifyCopies(copies: readonly RecoveryCopy[]): Promise<boolean> {
    return this.#checkCopies(copies)
  }

  discardCopies(copies: readonly RecoveryCopy[], scope: DiscardScope): Promise<boolean> {
    return this.#checkCopies(copies, scope)
  }

  async #checkCopies(copies: readonly RecoveryCopy[], discard?: DiscardScope): Promise<boolean> {
    if (this.#closed || discard?.signal.aborted || copies.length === 0 || copies.length > maxRecords) return false
    const expected = await Promise.all(copies.map(async ({ target, source }) => ({
      document: documentKey(target), source, digest: await sourceDigest(source),
    })))
    const documents = new Set(expected.map(copy => copy.document))
    if (this.#closed) return false
    const verified = await transaction(this.#database, this.#scope, (store, live, generation) => {
      if (this.#closed || this.#generation !== generation) return false
      if (discard && (!discard.current() || documents.size !== expected.length ||
          Array.from(this.#pending).some(write => documents.has(write.document)))) return false
      const owned = new Map(live.filter(record => record.writer === this.#writer && this.#matches(undefined, record))
        .map(record => [record.document, record]))
      const matched: RecoveryRecord[] = []
      for (const { document, source, digest } of expected) {
        const record = owned.get(document)
        if (!record || record.digest !== digest || record.baseRevision !== source.baseRevision ||
            record.editSequence !== source.editSequence || record.title !== source.title || record.body !== source.body) return false
        matched.push(record)
      }
      if (discard) for (const record of matched) store.delete(record.key)
      return true
    }, discard ? { signal: discard.signal, pruneInvalid: false } : { mode: 'readonly' })
    return verified && (discard !== undefined || !this.#closed)
  }

  async inspect(target: DraftTarget, durable: JournalSource & { revision: bigint }): Promise<readonly RecoveryCandidate[]> {
    const document = documentKey(target)
    const currentDigest = await sourceDigest(durable)
    if (this.#closed) return []
    const records = await transaction(this.#database, this.#scope, (store, live, generation) => live.filter(record => {
      if (this.#closed || this.#generation !== generation || !this.#matches(document, record)) return false
      if (record.digest !== currentDigest) return true
      store.delete(record.key)
      return false
    }))
    return this.#readCandidates(records, record => ({
      relationship: record.baseRevision === durable.revision ? 'restore' : 'compare',
    }))
  }

  async inspectNew(): Promise<readonly RecoveryCandidate[]> {
    if (this.#closed) return []
    const records = await transaction(this.#database, this.#scope, (_store, live, generation) =>
      this.#closed || this.#generation !== generation ? [] : live.filter(record =>
        this.#matches(undefined, record) && record.baseRevision === 0n &&
        record.document.startsWith('draft:') && uuid.test(record.document.slice(6))))
    return this.#readCandidates(records, record => ({
      relationship: 'restore', target: Object.freeze({ createDraftId: record.document.slice(6) }),
    }))
  }

  async #readCandidates(records: readonly RecoveryRecord[],
    describe: (record: RecoveryRecord) => Pick<RecoveryCandidate, 'relationship' | 'target'>): Promise<readonly RecoveryCandidate[]> {
    const candidates: RecoveryCandidate[] = []
    for (const record of records) {
      if (record.digest !== await sourceDigest(record) || record.expiresAt <= Date.now()) continue
      candidates.push(Object.freeze({
        writer: record.writer, baseRevision: record.baseRevision, editSequence: record.editSequence,
        updatedAt: record.updatedAt, expiresAt: record.expiresAt, title: record.title, body: record.body,
        ...describe(record),
      }))
    }
    if (this.#closed || candidates.length === 0) return []
    const active = await transaction(this.#database, this.#scope, (_store, _records, generation) => this.#generation === generation)
    return this.#closed || !active ? [] : Object.freeze(candidates.sort((a, b) => b.updatedAt - a.updatedAt))
  }

  acknowledge(target: DraftTarget, confirmedEditSequence: number, signal?: AbortSignal): Promise<boolean> {
    const document = documentKey(target)
    this.#cancelPending(document, pending => pending.sequence <= confirmedEditSequence)
    return this.#remove(record => this.#matches(document, record) && record.writer === this.#writer
      && record.editSequence <= confirmedEditSequence, false, signal)
  }

  discard(target: DraftTarget, candidate: Pick<RecoveryCandidate, 'writer' | 'editSequence'>): Promise<boolean> {
    const document = documentKey(target)
    if (candidate.writer === this.#writer) this.#cancelPending(document, pending => pending.sequence === candidate.editSequence)
    return this.#remove(record => this.#matches(document, record) && record.writer === candidate.writer
      && record.editSequence === candidate.editSequence)
  }

  purge(target?: DraftTarget): Promise<boolean> {
    const document = target && documentKey(target)
    this.#cancelPending(document, () => true)
    return this.#remove(record => this.#matches(document, record), document === undefined)
  }

  close(): void {
    this.#closed = true
    this.#database.close()
  }

  #matches(document: string | undefined, record: RecoveryRecord): boolean {
    return record.userId === this.#scope.userId && record.site === this.#scope.site
      && (document === undefined || record.document === document)
  }

  #cancelPending(document: string | undefined, match: (pending: PendingWrite) => boolean): void {
    for (const pending of this.#pending) {
      if ((document === undefined || pending.document === document) && match(pending)) pending.cancelled = true
    }
  }

  #remove(match: (record: RecoveryRecord) => boolean, revokeScope = false, signal?: AbortSignal): Promise<boolean> {
    return this.#closed ? Promise.resolve(false) : transaction(this.#database, this.#scope, (store, live, generation, revoke) => {
      if (this.#closed || this.#generation !== generation) return false
      if (revokeScope) revoke()
      for (const record of live) if (match(record)) store.delete(record.key)
      return true
    }, { signal })
  }
}
