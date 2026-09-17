import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import {
  clearRegisteredPrivateState,
  clearRegisteredPrivateStorage,
  PRIVATE_STORAGE_REGISTRY,
  purgeRetiredArticleDraftMetadata,
  registerPrivateStateCleanupHandler,
  RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY,
  RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX,
  resetPrivateStateCleanupHandlersForTests,
  type PrivateStateCleanupTrigger,
  type PrivateStorageRegistryEntry
} from '@/services/privateStorageRegistry'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) }
  }
}

class MemoryCache {
  readonly requests = new Map<string, Request>()

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const request = new Request(new URL(path, window.location.origin))
      this.requests.set(request.url, request)
    }
  }

  async keys(): Promise<readonly Request[]> {
    return [...this.requests.values()]
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const url = request instanceof Request ? request.url : new URL(String(request), window.location.origin).href
    return this.requests.delete(url)
  }
}

function memoryCacheStorage(entries: ReadonlyArray<readonly [string, readonly string[]]>) {
  const caches = new Map(entries.map(([name, paths]) => [name, new MemoryCache(paths)]))
  return {
    caches,
    adapter: {
      keys: vi.fn(async () => [...caches.keys()]),
      delete: vi.fn(async (name: string) => caches.delete(name)),
      open: vi.fn(async (name: string) => caches.get(name)!)
    }
  }
}

function storedKey(entry: Extract<PrivateStorageRegistryEntry, { medium: 'local-storage' | 'session-storage' }>): string {
  return entry.matcher.type === 'exact' ? entry.matcher.value : `${entry.matcher.value}fixture`
}

function seedWebStorage(local: Storage, session: Storage): void {
  for (const entry of PRIVATE_STORAGE_REGISTRY) {
    if (entry.medium !== 'local-storage' && entry.medium !== 'session-storage') continue
    const storage = entry.medium === 'local-storage' ? local : session
    storage.setItem(storedKey(entry), entry.dataScope)
  }
}

async function seedArticleRecoveryDatabase(indexedDB: IDBFactory): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('fsusblog-article-recovery-journal', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('entries', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
}

function webEntry(id: string) {
  const entry = PRIVATE_STORAGE_REGISTRY.find(candidate => candidate.id === id)
  if (!entry || (entry.medium !== 'local-storage' && entry.medium !== 'session-storage')) {
    throw new Error(`missing web storage entry ${id}`)
  }
  return entry
}

describe('private storage registry', () => {
  beforeEach(() => resetPrivateStateCleanupHandlersForTests())
  afterEach(() => resetPrivateStateCleanupHandlersForTests())

  it('is machine readable, unique, and covers every required data scope and medium', () => {
    expect(new Set(PRIVATE_STORAGE_REGISTRY.map(entry => entry.id)).size).toBe(PRIVATE_STORAGE_REGISTRY.length)
    expect(new Set(PRIVATE_STORAGE_REGISTRY.map(entry => entry.dataScope))).toEqual(new Set([
      'public', 'account', 'admin', 'session', 'temporary'
    ]))
    expect(new Set(PRIVATE_STORAGE_REGISTRY.map(entry => entry.medium))).toEqual(new Set([
      'local-storage', 'session-storage', 'indexed-db', 'cache-storage', 'runtime'
    ]))
    for (const entry of PRIVATE_STORAGE_REGISTRY) {
      expect(entry.id).toMatch(/^[a-z0-9-]+$/)
      if (entry.dataScope === 'public') expect(entry.clearOn).toEqual([])
    }
  })

  it('purges retired create/edit metadata without reading values or deleting unrelated storage', () => {
    const local = memoryStorage()
    const getItem = vi.spyOn(local, 'getItem')
    local.setItem(RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY, '{"content":"must-not-be-decoded"}')
    local.setItem(`${RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX}42`, '{"title":"must-not-be-shown"}')
    local.setItem('fsus:article-draft:preview', 'unrelated')
    local.setItem('unrelated-private-key', 'retained')

    expect(purgeRetiredArticleDraftMetadata(local)).toEqual([
      RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY,
      `${RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX}42`
    ])
    expect(getItem).not.toHaveBeenCalled()
    expect(local.getItem(RETIRED_ARTICLE_DRAFT_CREATE_METADATA_KEY)).toBeNull()
    expect(local.getItem(`${RETIRED_ARTICLE_DRAFT_EDIT_METADATA_PREFIX}42`)).toBeNull()
    expect(local.getItem('fsus:article-draft:preview')).toBe('unrelated')
    expect(local.getItem('unrelated-private-key')).toBe('retained')
  })

  it.each<PrivateStateCleanupTrigger>(['logout', 'account-switch', 'session-expired'])(
    '%s clears account, session, and temporary entries without deleting admin or public state',
    async trigger => {
      const local = memoryStorage()
      const session = memoryStorage()
      seedWebStorage(local, session)

      const result = await clearRegisteredPrivateState({ trigger, local, session })

      expect(result.complete).toBe(true)
      expect(result.items).toHaveLength(PRIVATE_STORAGE_REGISTRY.length)
      for (const entry of PRIVATE_STORAGE_REGISTRY) {
        if (entry.medium !== 'local-storage' && entry.medium !== 'session-storage') continue
        const storage = entry.medium === 'local-storage' ? local : session
        const shouldClear = entry.clearOn.includes(trigger)
        if (shouldClear) {
          expect(storage.getItem(storedKey(entry)), entry.id).toBeNull()
        } else {
          expect(storage.getItem(storedKey(entry)), entry.id).not.toBeNull()
        }
      }
    }
  )

  it('admin logout clears only admin and shared temporary entries', async () => {
    const local = memoryStorage()
    const session = memoryStorage()
    const indexedDB = new IDBFactory()
    seedWebStorage(local, session)
    await seedArticleRecoveryDatabase(indexedDB)

    const result = await clearRegisteredPrivateState({
      trigger: 'admin-logout',
      local,
      session,
      indexedDb: indexedDB
    })

    expect(result.complete).toBe(true)
    expect(result.items.find(item => item.id === 'article-recovery-journal')).toMatchObject({
      medium: 'indexed-db',
      status: 'removed',
      affected: 1
    })
    expect(session.getItem(storedKey(webEntry('local-fixture-admin')))).toBeNull()
    expect(local.getItem(storedKey(webEntry('public-comment-drafts')))).not.toBeNull()
    expect(session.getItem(storedKey(webEntry('local-fixture-account')))).not.toBeNull()
    expect(local.getItem(storedKey(webEntry('theme-mode')))).not.toBeNull()
  })

  it.each<PrivateStateCleanupTrigger>([
    'logout',
    'account-switch',
    'session-expired',
    'admin-logout',
    'panic',
    'migration-failure',
    'shared-device'
  ])('%s deletes the bounded article recovery database', async trigger => {
    const indexedDB = new IDBFactory()
    await seedArticleRecoveryDatabase(indexedDB)

    const result = await clearRegisteredPrivateState({
      trigger,
      local: memoryStorage(),
      session: memoryStorage(),
      indexedDb: indexedDB
    })

    expect(result.items.find(item => item.id === 'article-recovery-journal')).toMatchObject({
      status: 'removed',
      affected: 1
    })
    expect((await indexedDB.databases()).some(database => (
      database.name === 'fsusblog-article-recovery-journal'
    ))).toBe(false)
  })

  it('is idempotent and reports not-present for an already removed item', async () => {
    const local = memoryStorage()
    const session = memoryStorage()
    seedWebStorage(local, session)

    const first = clearRegisteredPrivateStorage({ local, session, trigger: 'logout' })
    const second = clearRegisteredPrivateStorage({ local, session, trigger: 'logout' })

    expect(first.failed).toEqual([])
    expect(first.removed.length).toBeGreaterThan(0)
    expect(second.failed).toEqual([])
    expect(second.items.find(item => item.id === 'public-comment-drafts')?.status).toBe('not-present')
  })

  it('clears registered cache families and sensitive requests but preserves public assets and other apps', async () => {
    const cacheStorage = memoryCacheStorage([
      ['fsus-shell-v6:test', ['/article/1']],
      ['fsus-static-v5:test', ['/assets/app.js', '/api/binary/auth/me.aeds', '/admin/users']],
      ['other-app-cache', ['/account/private']]
    ])

    const result = await clearRegisteredPrivateState({
      trigger: 'logout',
      local: memoryStorage(),
      session: memoryStorage(),
      cacheStorage: cacheStorage.adapter
    })

    expect(result.complete).toBe(true)
    expect(cacheStorage.caches.has('fsus-shell-v6:test')).toBe(false)
    expect(cacheStorage.caches.has('other-app-cache')).toBe(true)
    const staticCache = cacheStorage.caches.get('fsus-static-v5:test')!
    expect(staticCache.requests.has(new URL('/assets/app.js', window.location.origin).href)).toBe(true)
    expect(staticCache.requests.has(new URL('/api/binary/auth/me.aeds', window.location.origin).href)).toBe(false)
  })

  it('uses registered runtime handlers with a Pinia fixture and keeps account/admin planes separate', async () => {
    setActivePinia(createPinia())
    const useFixtureStore = defineStore('storage-registry-fixture', {
      state: () => ({ accountValue: 'account-secret', adminValue: 'admin-secret' })
    })
    const store = useFixtureStore()
    registerPrivateStateCleanupHandler('account-pinia', () => { store.accountValue = '' })
    registerPrivateStateCleanupHandler('admin-pinia', () => { store.adminValue = '' })

    const accountResult = await clearRegisteredPrivateState({ trigger: 'logout' })
    expect(store.accountValue).toBe('')
    expect(store.adminValue).toBe('admin-secret')
    expect(accountResult.items.find(item => item.id === 'account-pinia')).toMatchObject({ status: 'cleared', affected: 1 })
    expect(accountResult.items.find(item => item.id === 'admin-pinia')?.status).toBe('retained')

    await clearRegisteredPrivateState({ trigger: 'admin-logout' })
    expect(store.adminValue).toBe('')
  })

  it('returns stable per-item failures without blocking independent cleanup handlers', async () => {
    const completed = vi.fn()
    registerPrivateStateCleanupHandler('challenge-proof-runtime', () => { throw new Error('secret detail') })
    registerPrivateStateCleanupHandler('challenge-proof-runtime', completed)

    const result = await clearRegisteredPrivateState({ trigger: 'logout' })

    expect(result.complete).toBe(false)
    expect(result.failed).toContain('challenge-proof-runtime')
    expect(result.items.find(item => item.id === 'challenge-proof-runtime')).toMatchObject({
      status: 'failed',
      affected: 1
    })
    expect(JSON.stringify(result)).not.toContain('secret detail')
    expect(completed).toHaveBeenCalledOnce()
  })
})
