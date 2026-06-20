import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'

const DEFAULT_DATABASE_NAME = 'fsusblog-comment-privacy-credentials'
const CREDENTIAL_STORE_NAME = 'credentials'
const DATABASE_VERSION = 1

export interface CommentPrivacyCredentialVaultPartition {
  credentialEpoch: number
  circuitId: string
  issuerPublicKeyHash: string
}

export interface CommentPrivacyStoredCredential
  extends CommentPrivacyCredentialVaultPartition,
    CommentPrivacyCredentialMaterial {
  expiresAtUnixMs: number
  issuerPublicKeyId?: string
}

export interface CommentPrivacyCredentialVault {
  get(partition: CommentPrivacyCredentialVaultPartition): Promise<CommentPrivacyStoredCredential | null>
  put(credential: CommentPrivacyStoredCredential): Promise<void>
  pruneExpired(nowUnixMs?: number): Promise<number>
  clear(partition?: Partial<CommentPrivacyCredentialVaultPartition>): Promise<void>
}

export interface CommentPrivacyCredentialVaultOptions {
  indexedDB?: IDBFactory | null
  databaseName?: string
  now?: () => number
}

type StoredCredentialRecord = CommentPrivacyStoredCredential & {
  id: string
}

export function createCommentPrivacyCredentialVault(
  options: CommentPrivacyCredentialVaultOptions = {}
): CommentPrivacyCredentialVault | null {
  const indexedDb = options.indexedDB ?? getGlobalIndexedDb()
  if (!indexedDb) {
    return null
  }

  return createIndexedDbCommentPrivacyCredentialVault({
    ...options,
    indexedDB: indexedDb
  })
}

export function createIndexedDbCommentPrivacyCredentialVault(
  options: CommentPrivacyCredentialVaultOptions & { indexedDB: IDBFactory }
): CommentPrivacyCredentialVault {
  const indexedDb = options.indexedDB
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME
  const now = options.now ?? (() => Date.now())
  let databasePromise: Promise<IDBDatabase> | null = null

  const openDatabase = (): Promise<IDBDatabase> => {
    if (databasePromise) {
      return databasePromise
    }

    databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDb.open(databaseName, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(CREDENTIAL_STORE_NAME)) {
          database.createObjectStore(CREDENTIAL_STORE_NAME, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('comment_privacy_vault_open_failed'))
    })

    return databasePromise
  }

  const objectStore = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    const database = await openDatabase()
    return database.transaction(CREDENTIAL_STORE_NAME, mode).objectStore(CREDENTIAL_STORE_NAME)
  }

  const getAllRecords = async (): Promise<StoredCredentialRecord[]> => {
    const store = await objectStore('readonly')
    const records = await idbRequestToPromise<unknown[]>(store.getAll())
    return records.filter(isStoredCredentialRecord).map(cloneRecord)
  }

  const deleteRecords = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) {
      return
    }

    const store = await objectStore('readwrite')
    await Promise.all(ids.map(id => idbRequestToPromise(store.delete(id))))
  }

  return {
    async get(partition) {
      const store = await objectStore('readwrite')
      const record = await idbRequestToPromise<unknown>(store.get(partitionKey(partition)))
      if (!isStoredCredentialRecord(record)) {
        return null
      }

      if (record.expiresAtUnixMs <= now()) {
        await idbRequestToPromise(store.delete(record.id))
        return null
      }

      return cloneCredentialRecord(record)
    },
    async put(credential) {
      const record = toStoredRecord(credential)
      const store = await objectStore('readwrite')
      await idbRequestToPromise(store.put(record))
    },
    async pruneExpired(nowUnixMs = now()) {
      const records = await getAllRecords()
      const expiredIds = records
        .filter(record => record.expiresAtUnixMs <= nowUnixMs)
        .map(record => record.id)
      await deleteRecords(expiredIds)
      return expiredIds.length
    },
    async clear(partition) {
      if (!partition) {
        const store = await objectStore('readwrite')
        await idbRequestToPromise(store.clear())
        return
      }

      const records = await getAllRecords()
      const matchingIds = records
        .filter(record => partitionMatches(record, partition))
        .map(record => record.id)
      await deleteRecords(matchingIds)
    }
  }
}

function idbRequestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('comment_privacy_vault_request_failed'))
  })
}

function toStoredRecord(credential: CommentPrivacyStoredCredential): StoredCredentialRecord {
  return {
    id: partitionKey(credential),
    credentialEpoch: credential.credentialEpoch,
    circuitId: credential.circuitId,
    issuerPublicKeyHash: credential.issuerPublicKeyHash,
    credentialSecret: cloneBytes(credential.credentialSecret),
    credentialCommitment: cloneBytes(credential.credentialCommitment),
    issuerSignature: cloneBytes(credential.issuerSignature),
    revocationWitness: cloneBytes(credential.revocationWitness),
    revocationHandleHash: credential.revocationHandleHash ? cloneBytes(credential.revocationHandleHash) : undefined,
    expiresAtUnixMs: credential.expiresAtUnixMs,
    credentialLevel: credential.credentialLevel,
    reputationBucket: credential.reputationBucket,
    issuerPublicKeyId: credential.issuerPublicKeyId
  }
}

function cloneCredentialRecord(record: StoredCredentialRecord): CommentPrivacyStoredCredential {
  return {
    credentialEpoch: record.credentialEpoch,
    circuitId: record.circuitId,
    issuerPublicKeyHash: record.issuerPublicKeyHash,
    credentialSecret: cloneBytes(record.credentialSecret),
    credentialCommitment: cloneBytes(record.credentialCommitment),
    issuerSignature: cloneBytes(record.issuerSignature),
    revocationWitness: cloneBytes(record.revocationWitness),
    revocationHandleHash: record.revocationHandleHash ? cloneBytes(record.revocationHandleHash) : undefined,
    expiresAtUnixMs: record.expiresAtUnixMs,
    credentialLevel: record.credentialLevel,
    reputationBucket: record.reputationBucket,
    issuerPublicKeyId: record.issuerPublicKeyId
  }
}

function cloneRecord(record: StoredCredentialRecord): StoredCredentialRecord {
  return {
    id: record.id,
    ...cloneCredentialRecord(record)
  }
}

function isStoredCredentialRecord(value: unknown): value is StoredCredentialRecord {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Partial<StoredCredentialRecord>
  return typeof record.id === 'string' &&
    Number.isFinite(record.credentialEpoch) &&
    typeof record.circuitId === 'string' &&
    typeof record.issuerPublicKeyHash === 'string' &&
    record.credentialSecret instanceof Uint8Array &&
    record.credentialCommitment instanceof Uint8Array &&
    record.issuerSignature instanceof Uint8Array &&
    record.revocationWitness instanceof Uint8Array &&
    typeof record.credentialLevel === 'string' &&
    typeof record.reputationBucket === 'string' &&
    Number.isFinite(record.expiresAtUnixMs)
}

function partitionMatches(
  record: CommentPrivacyCredentialVaultPartition,
  partition: Partial<CommentPrivacyCredentialVaultPartition>
): boolean {
  return (partition.credentialEpoch === undefined || record.credentialEpoch === partition.credentialEpoch) &&
    (partition.circuitId === undefined || record.circuitId === partition.circuitId) &&
    (partition.issuerPublicKeyHash === undefined || record.issuerPublicKeyHash === partition.issuerPublicKeyHash)
}

function partitionKey(partition: CommentPrivacyCredentialVaultPartition): string {
  return [
    String(partition.credentialEpoch),
    encodeURIComponent(partition.circuitId),
    encodeURIComponent(partition.issuerPublicKeyHash)
  ].join(':')
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function getGlobalIndexedDb(): IDBFactory | null {
  return typeof globalThis.indexedDB === 'undefined'
    ? null
    : globalThis.indexedDB
}
