import type { CommentPrivacyCredentialMaterial } from './commentPrivacyTypes'
import {
  getCommentPrivacyLocalVaultGeneration,
  purgeCommentPrivacyCredentialState,
  registerCommentPrivacyCredentialPurgeHandler,
  zeroizeCommentPrivacyBytes
} from './commentPrivacyCredentialLifecycle'

export const COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE = 'disabled' as const
export const COMMENT_PRIVACY_LEGACY_DATABASE_NAMES = Object.freeze([
  'fsusblog-comment-privacy-credentials'
])

export interface CommentPrivacyCredentialVaultPartition {
  localVaultGeneration: string
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
  initialize?(): Promise<boolean>
  get(partition: CommentPrivacyCredentialVaultPartition): Promise<CommentPrivacyStoredCredential | null>
  put(credential: CommentPrivacyStoredCredential): Promise<void>
  pruneExpired(nowUnixMs?: number): Promise<number>
  clear(partition?: Partial<CommentPrivacyCredentialVaultPartition>): Promise<void>
}

export interface CommentPrivacyCredentialVaultOptions {
  indexedDB?: IDBFactory | null
  now?: () => number
}

let defaultMemoryVault: CommentPrivacyCredentialVault | null = null
let unregisterDefaultPurgeHandler: (() => void) | null = null

export function createCommentPrivacyCredentialVault(): CommentPrivacyCredentialVault {
  if (!defaultMemoryVault) {
    defaultMemoryVault = createMemoryOnlyCommentPrivacyCredentialVault()
    unregisterDefaultPurgeHandler = registerCommentPrivacyCredentialPurgeHandler(() => defaultMemoryVault?.clear())
  }
  return defaultMemoryVault
}

export function createMemoryOnlyCommentPrivacyCredentialVault(
  options: CommentPrivacyCredentialVaultOptions = {}
): CommentPrivacyCredentialVault {
  const now = options.now ?? (() => Date.now())
  const indexedDb = options.indexedDB === undefined ? getGlobalIndexedDb() : options.indexedDB
  const records = new Map<string, CommentPrivacyStoredCredential>()
  let initializationPromise: Promise<boolean> | null = null

  const clearMatching = (partition?: Partial<CommentPrivacyCredentialVaultPartition>): number => {
    let cleared = 0
    for (const [key, record] of records) {
      if (partition && !partitionMatches(record, partition)) {
        continue
      }
      zeroizeStoredCredential(record)
      records.delete(key)
      cleared += 1
    }
    return cleared
  }

  return {
    initialize() {
      if (!initializationPromise) {
        initializationPromise = deleteLegacyCredentialDatabases(indexedDb).then(
          () => true,
          async () => {
            clearMatching()
            await purgeCommentPrivacyCredentialState('migration-failure')
            return false
          }
        )
      }
      return initializationPromise
    },
    async get(partition) {
      const key = partitionKey(partition)
      const record = records.get(key)
      if (!record) {
        return null
      }
      if (record.expiresAtUnixMs <= now()) {
        zeroizeStoredCredential(record)
        records.delete(key)
        return null
      }
      return cloneCredentialRecord(record)
    },
    async put(credential) {
      const key = partitionKey(credential)
      const previous = records.get(key)
      if (previous) {
        zeroizeStoredCredential(previous)
      }
      records.set(key, cloneCredentialRecord(credential))
    },
    async pruneExpired(nowUnixMs = now()) {
      let pruned = 0
      for (const [key, record] of records) {
        if (record.expiresAtUnixMs > nowUnixMs) {
          continue
        }
        zeroizeStoredCredential(record)
        records.delete(key)
        pruned += 1
      }
      return pruned
    },
    async clear(partition) {
      clearMatching(partition)
    }
  }
}

export function currentCommentPrivacyVaultPartition(input: {
  credentialEpoch: number
  circuitId: string
  issuerPublicKeyHash: string
}): CommentPrivacyCredentialVaultPartition {
  return {
    localVaultGeneration: getCommentPrivacyLocalVaultGeneration(),
    credentialEpoch: input.credentialEpoch,
    circuitId: input.circuitId,
    issuerPublicKeyHash: input.issuerPublicKeyHash
  }
}

export async function deleteLegacyCommentPrivacyCredentialDatabases(
  indexedDb: IDBFactory | null = getGlobalIndexedDb()
): Promise<void> {
  try {
    await deleteLegacyCredentialDatabases(indexedDb)
  } catch (error) {
    await purgeCommentPrivacyCredentialState('migration-failure')
    throw error
  }
}

export function resetCommentPrivacyCredentialVaultForTests(): void {
  unregisterDefaultPurgeHandler?.()
  unregisterDefaultPurgeHandler = null
  defaultMemoryVault = null
}

function deleteLegacyCredentialDatabases(indexedDb: IDBFactory | null): Promise<void> {
  if (!indexedDb) {
    return Promise.resolve()
  }
  return Promise.all(COMMENT_PRIVACY_LEGACY_DATABASE_NAMES.map(name => deleteDatabase(indexedDb, name))).then(() => undefined)
}

function deleteDatabase(indexedDb: IDBFactory, name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDb.deleteDatabase(name)
    } catch (error) {
      reject(error)
      return
    }
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('comment_privacy_legacy_vault_delete_failed'))
    request.onblocked = () => reject(new Error('comment_privacy_legacy_vault_delete_blocked'))
  })
}

function cloneCredentialRecord(record: CommentPrivacyStoredCredential): CommentPrivacyStoredCredential {
  return {
    localVaultGeneration: record.localVaultGeneration,
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

function zeroizeStoredCredential(record: CommentPrivacyStoredCredential): void {
  zeroizeCommentPrivacyBytes(record.credentialSecret)
  zeroizeCommentPrivacyBytes(record.credentialCommitment)
  zeroizeCommentPrivacyBytes(record.issuerSignature)
  zeroizeCommentPrivacyBytes(record.revocationWitness)
  zeroizeCommentPrivacyBytes(record.revocationHandleHash)
}

function partitionMatches(
  record: CommentPrivacyCredentialVaultPartition,
  partition: Partial<CommentPrivacyCredentialVaultPartition>
): boolean {
  return (partition.localVaultGeneration === undefined || record.localVaultGeneration === partition.localVaultGeneration) &&
    (partition.credentialEpoch === undefined || record.credentialEpoch === partition.credentialEpoch) &&
    (partition.circuitId === undefined || record.circuitId === partition.circuitId) &&
    (partition.issuerPublicKeyHash === undefined || record.issuerPublicKeyHash === partition.issuerPublicKeyHash)
}

function partitionKey(partition: CommentPrivacyCredentialVaultPartition): string {
  return [
    encodeURIComponent(partition.localVaultGeneration),
    String(partition.credentialEpoch),
    encodeURIComponent(partition.circuitId),
    encodeURIComponent(partition.issuerPublicKeyHash)
  ].join(':')
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function getGlobalIndexedDb(): IDBFactory | null {
  return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB
}
