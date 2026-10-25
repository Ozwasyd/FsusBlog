import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBVersionChangeEvent } from 'fake-indexeddb'
import {
  COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE,
  COMMENT_PRIVACY_LEGACY_DATABASE_NAMES,
  createCommentPrivacyCredentialVault,
  createMemoryOnlyCommentPrivacyCredentialVault,
  currentCommentPrivacyVaultPartition,
  resetCommentPrivacyCredentialVaultForTests,
  type CommentPrivacyCredentialVaultPartition
} from '@/privacy/commentPrivacyCredentialVault'
import {
  getCommentPrivacyLocalVaultGeneration,
  purgeCommentPrivacyCredentialState,
  resetCommentPrivacyCredentialLifecycleForTests
} from '@/privacy/commentPrivacyCredentialLifecycle'

describe('commentPrivacyCredentialVault', () => {
  beforeEach(() => {
    resetCommentPrivacyCredentialVaultForTests()
    resetCommentPrivacyCredentialLifecycleForTests()
  })

  afterEach(() => {
    resetCommentPrivacyCredentialVaultForTests()
    resetCommentPrivacyCredentialLifecycleForTests()
  })

  it('uses one memory-only production singleton and never opens a credential database', async () => {
    const first = createCommentPrivacyCredentialVault()
    const second = createCommentPrivacyCredentialVault()

    expect(COMMENT_PRIVACY_CREDENTIAL_PERSISTENCE_MODE).toBe('disabled')
    expect(first).toBe(second)
    await expect(first.initialize?.()).resolves.toBe(true)
  })

  it('prevents account A credential reuse after logout or account switch before account B', async () => {
    for (const reason of ['logout', 'account-switch'] as const) {
      resetCommentPrivacyCredentialVaultForTests()
      resetCommentPrivacyCredentialLifecycleForTests()
      const vault = createCommentPrivacyCredentialVault()
      const accountAPartition = partition('issuer-a')
      const accountASecret = new Uint8Array([1, 2, 3])

      await vault.put(credential(accountAPartition, accountASecret, Date.now() + 60_000))
      expect((await vault.get(accountAPartition))?.credentialSecret).toEqual(accountASecret)

      const previousGeneration = getCommentPrivacyLocalVaultGeneration()
      await purgeCommentPrivacyCredentialState(reason, { broadcast: false })
      const accountBPartition = partition('issuer-a')

      expect(accountBPartition.localVaultGeneration).not.toBe(previousGeneration)
      expect(accountBPartition).not.toHaveProperty('userId')
      expect(accountBPartition).not.toHaveProperty('sessionId')
      await expect(vault.get(accountAPartition)).resolves.toBeNull()
      await expect(vault.get(accountBPartition)).resolves.toBeNull()
    }
  })

  it('deletes the real fake-IndexedDB legacy plaintext database and leaves its dump empty', async () => {
    const indexedDB = new IDBFactory()
    const legacyDatabaseName = COMMENT_PRIVACY_LEGACY_DATABASE_NAMES[0]
    await seedLegacyCredentialDatabase(indexedDB, legacyDatabaseName)
    expect(await dumpLegacyCredentialDatabase(indexedDB, legacyDatabaseName)).toEqual([
      expect.objectContaining({ credentialSecret: new Uint8Array([1, 2, 3]) })
    ])
    const vault = createMemoryOnlyCommentPrivacyCredentialVault({ indexedDB: indexedDB as unknown as IDBFactory })

    await expect(vault.initialize?.()).resolves.toBe(true)

    expect(await dumpLegacyCredentialDatabase(indexedDB, legacyDatabaseName)).toEqual([])
  })

  it('fails closed and rotates generation when legacy database deletion is blocked', async () => {
    const indexedDB = createDeleteOnlyIndexedDb(undefined, true)
    const vault = createMemoryOnlyCommentPrivacyCredentialVault({ indexedDB })
    const oldPartition = partition('issuer-a')
    await vault.put(credential(oldPartition, new Uint8Array([9, 8, 7]), 5_000))
    const previousGeneration = getCommentPrivacyLocalVaultGeneration()

    await expect(vault.initialize?.()).resolves.toBe(false)

    expect(getCommentPrivacyLocalVaultGeneration()).not.toBe(previousGeneration)
    await expect(vault.get(oldPartition)).resolves.toBeNull()
  })
})

function partition(issuerPublicKeyHash: string): CommentPrivacyCredentialVaultPartition {
  return currentCommentPrivacyVaultPartition({
    credentialEpoch: 20260620,
    circuitId: 'fsus.anonymous.comment.v5',
    issuerPublicKeyHash
  })
}

async function seedLegacyCredentialDatabase(indexedDB: IDBFactory, databaseName: string): Promise<void> {
  const database = await openDatabase(indexedDB, databaseName, event => {
    const request = event.target as IDBOpenDBRequest
    request.result.createObjectStore('credentials', { keyPath: 'id' })
  })
  const transaction = database.transaction('credentials', 'readwrite')
  transaction.objectStore('credentials').put({
    id: 'credential',
    credentialSecret: new Uint8Array([1, 2, 3]),
    issuerSignature: new Uint8Array([4, 5, 6]),
    revocationWitness: new Uint8Array([7, 8, 9])
  })
  await transactionDone(transaction)
  database.close()
}

async function dumpLegacyCredentialDatabase(indexedDB: IDBFactory, databaseName: string): Promise<unknown[]> {
  const databases = await indexedDB.databases()
  if (!databases.some(database => database.name === databaseName)) {
    return []
  }
  const database = await openDatabase(indexedDB, databaseName)
  if (!database.objectStoreNames.contains('credentials')) {
    database.close()
    return []
  }
  const transaction = database.transaction('credentials', 'readonly')
  const request = transaction.objectStore('credentials').getAll()
  const values = await requestResult(request)
  await transactionDone(transaction)
  database.close()
  return values
}

function openDatabase(
  indexedDB: IDBFactory,
  databaseName: string,
  onUpgrade?: (event: IDBVersionChangeEvent) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = event => onUpgrade?.(event)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

function credential(partitionValue: CommentPrivacyCredentialVaultPartition, secret: Uint8Array, expiresAtUnixMs: number) {
  return {
    ...partitionValue,
    credentialSecret: secret,
    credentialCommitment: new Uint8Array([21, 22, 23]),
    issuerSignature: new Uint8Array([4, 5, 6]),
    revocationWitness: new Uint8Array([7, 8, 9]),
    credentialLevel: 'strong_anonymous',
    reputationBucket: 'rep:low',
    expiresAtUnixMs
  }
}

function createDeleteOnlyIndexedDb(onDelete?: () => void, blocked = false): IDBFactory {
  return {
    deleteDatabase: vi.fn(() => {
      const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      } as unknown as IDBOpenDBRequest
      queueMicrotask(() => {
        if (blocked) {
          request.onblocked?.(new IDBVersionChangeEvent('blocked'))
          return
        }
        onDelete?.()
        request.onsuccess?.(new Event('success'))
      })
      return request
    })
  } as unknown as IDBFactory
}
