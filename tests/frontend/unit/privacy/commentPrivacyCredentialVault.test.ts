import { describe, expect, it, vi } from 'vitest'
import {
  createIndexedDbCommentPrivacyCredentialVault,
  type CommentPrivacyCredentialVaultPartition
} from '@/privacy/commentPrivacyCredentialVault'

describe('commentPrivacyCredentialVault', () => {
  it('partitions credentials by epoch circuit and issuer hash, prunes expired records, and clears active entries', async () => {
    let now = 1_000
    const fakeIndexedDb = createFakeIndexedDb()
    const vault = createIndexedDbCommentPrivacyCredentialVault({
      databaseName: 'comment-privacy-vault-test',
      indexedDB: fakeIndexedDb,
      now: () => now
    })
    const expiredPartition = partition('issuer-a')
    const activePartition = partition('issuer-b')

    await vault.put({
      ...expiredPartition,
      credentialSecret: new Uint8Array([1, 2, 3]),
      issuerSignature: new Uint8Array([4, 5, 6]),
      revocationWitness: new Uint8Array([7, 8, 9]),
      expiresAtUnixMs: 1_500
    })
    await vault.put({
      ...activePartition,
      credentialSecret: new Uint8Array([10, 11, 12]),
      issuerSignature: new Uint8Array([13, 14, 15]),
      revocationWitness: new Uint8Array([16, 17, 18]),
      expiresAtUnixMs: 5_000
    })

    now = 2_000

    await expect(vault.pruneExpired()).resolves.toBe(1)
    await expect(vault.get(expiredPartition)).resolves.toBeNull()

    const active = await vault.get(activePartition)
    expect([...(active?.credentialSecret ?? [])]).toEqual([10, 11, 12])
    expect([...(active?.issuerSignature ?? [])]).toEqual([13, 14, 15])
    expect([...(active?.revocationWitness ?? [])]).toEqual([16, 17, 18])

    await vault.clear(activePartition)

    await expect(vault.get(activePartition)).resolves.toBeNull()
    expect(globalThis.localStorage.length).toBe(0)
    expect(globalThis.sessionStorage.length).toBe(0)
  })
})

function partition(issuerPublicKeyHash: string): CommentPrivacyCredentialVaultPartition {
  return {
    credentialEpoch: 20260620,
    circuitId: 'fsus.anonymous.comment.v1',
    issuerPublicKeyHash
  }
}

function createFakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>()

  return {
    open: vi.fn((name: string) => {
      const request = createRequest<FakeDatabase>()
      queueMicrotask(() => {
        const db = new FakeDatabase(stores, name)
        request.result = db
        request.onupgradeneeded?.(createEvent(request) as IDBVersionChangeEvent)
        request.onsuccess?.(createEvent(request))
      })
      return request as unknown as IDBOpenDBRequest
    })
  } as unknown as IDBFactory
}

class FakeDatabase {
  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  } as DOMStringList

  constructor(
    private readonly stores: Map<string, Map<string, unknown>>,
    readonly name: string
  ) {}

  createObjectStore(name: string): void {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map())
    }
  }

  transaction(name: string): FakeTransaction {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map())
    }
    return new FakeTransaction(this.stores.get(name) ?? new Map())
  }
}

class FakeTransaction {
  constructor(private readonly store: Map<string, unknown>) {}

  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.store)
  }
}

class FakeObjectStore {
  constructor(private readonly store: Map<string, unknown>) {}

  get(key: string): IDBRequest {
    const request = createRequest<unknown>()
    queueMicrotask(() => {
      request.result = cloneValue(this.store.get(key))
      request.onsuccess?.(createEvent(request))
    })
    return request as unknown as IDBRequest
  }

  getAll(): IDBRequest {
    const request = createRequest<unknown[]>()
    queueMicrotask(() => {
      request.result = Array.from(this.store.values()).map(cloneValue)
      request.onsuccess?.(createEvent(request))
    })
    return request as unknown as IDBRequest
  }

  put(value: { id: string }): IDBRequest {
    const request = createRequest<string>()
    queueMicrotask(() => {
      this.store.set(value.id, cloneValue(value))
      request.result = value.id
      request.onsuccess?.(createEvent(request))
    })
    return request as unknown as IDBRequest
  }

  delete(key: string): IDBRequest {
    const request = createRequest<undefined>()
    queueMicrotask(() => {
      this.store.delete(key)
      request.result = undefined
      request.onsuccess?.(createEvent(request))
    })
    return request as unknown as IDBRequest
  }

  clear(): IDBRequest {
    const request = createRequest<undefined>()
    queueMicrotask(() => {
      this.store.clear()
      request.result = undefined
      request.onsuccess?.(createEvent(request))
    })
    return request as unknown as IDBRequest
  }
}

type FakeRequest<T> = {
  result: T | undefined
  error: DOMException | null
  onsuccess: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onupgradeneeded: ((event: IDBVersionChangeEvent) => void) | null
}

function createRequest<T>(): FakeRequest<T> {
  return {
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null
  }
}

function createEvent<T>(request: FakeRequest<T>): Event {
  return { target: request } as unknown as Event
}

function cloneValue<T>(value: T): T {
  return value === undefined
    ? value
    : structuredClone(value)
}
