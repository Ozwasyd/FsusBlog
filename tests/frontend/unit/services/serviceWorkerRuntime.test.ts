import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPrivateBrowserState } from '@/services/serviceWorkerRuntime'

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
    const url = request instanceof Request
      ? request.url
      : new URL(String(request), window.location.origin).href
    return this.requests.delete(url)
  }
}

describe('serviceWorkerRuntime private browser cleanup', () => {
  const originalServiceWorker = navigator.serviceWorker
  const originalCaches = globalThis.caches
  const originalIndexedDb = globalThis.indexedDB

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: originalServiceWorker,
      configurable: true
    })
    Object.defineProperty(globalThis, 'caches', {
      value: originalCaches,
      configurable: true
    })
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDb,
      configurable: true
    })
    localStorage.clear()
    sessionStorage.clear()
  })

  it('notifies active and waiting workers and removes offline history plus legacy sensitive entries', async () => {
    const activeWorker = createAcknowledgingWorker()
    const waitingWorker = createAcknowledgingWorker()
    const shellCache = new MemoryCache(['/article/1'])
    const searchCache = new MemoryCache(['/search/index.bin'])
    const staticCache = new MemoryCache([
      '/assets/app.abcdef.js',
      '/api/binary/auth/me.aeds',
      '/private/account.png'
    ])
    const cachesByName = new Map<string, MemoryCache>([
      ['fsus-shell-v6:test-build', shellCache],
      ['fsus-search-v5:test-build', searchCache],
      ['fsus-static-v4:legacy-build', staticCache]
    ])
    const deletedCaches: string[] = []

    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        controller: activeWorker,
        getRegistrations: vi.fn().mockResolvedValue([{
          active: activeWorker,
          waiting: waitingWorker,
          installing: null
        }])
      },
      configurable: true
    })
    Object.defineProperty(globalThis, 'caches', {
      value: {
        keys: vi.fn().mockImplementation(async () => [...cachesByName.keys()]),
        delete: vi.fn().mockImplementation(async (name: string) => {
          deletedCaches.push(name)
          return cachesByName.delete(name)
        }),
        open: vi.fn().mockImplementation(async (name: string) => cachesByName.get(name))
      },
      configurable: true
    })

    const result = await clearPrivateBrowserState('shared-device')

    expect(activeWorker.postMessage).toHaveBeenCalledTimes(1)
    expect(waitingWorker.postMessage).toHaveBeenCalledTimes(1)
    expect(activeWorker.postMessage).toHaveBeenCalledWith({
      type: 'privacy.clear',
      reason: 'shared-device'
    }, [expect.anything()])
    expect(result.serviceWorkerAcknowledged).toBe(true)
    expect(deletedCaches).toEqual(expect.arrayContaining([
      'fsus-shell-v6:test-build',
      'fsus-search-v5:test-build'
    ]))
    expect(staticCache.requests.has(new URL('/assets/app.abcdef.js', window.location.origin).href)).toBe(true)
    expect(staticCache.requests.has(new URL('/api/binary/auth/me.aeds', window.location.origin).href)).toBe(false)
    expect(staticCache.requests.has(new URL('/private/account.png', window.location.origin).href)).toBe(false)
  })

  it('panic wipe removes every FsusBlog cache and requests legacy vault deletion', async () => {
    const activeWorker = createAcknowledgingWorker()
    const cacheNames = new Set(['fsus-static-v5:test', 'fsus-shell-v6:test', 'other-app-cache'])
    const deleteDatabase = vi.fn(() => {
      const request = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      } as unknown as IDBOpenDBRequest
      queueMicrotask(() => request.onsuccess?.(new Event('success')))
      return request
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        controller: activeWorker,
        getRegistrations: vi.fn().mockResolvedValue([])
      },
      configurable: true
    })
    Object.defineProperty(globalThis, 'caches', {
      value: {
        keys: vi.fn().mockImplementation(async () => [...cacheNames]),
        delete: vi.fn().mockImplementation(async (name: string) => cacheNames.delete(name)),
        open: vi.fn()
      },
      configurable: true
    })
    Object.defineProperty(globalThis, 'indexedDB', {
      value: { deleteDatabase } as unknown as IDBFactory,
      configurable: true
    })

    const result = await clearPrivateBrowserState('panic')

    expect(activeWorker.postMessage).toHaveBeenCalledWith(
      { type: 'privacy.clear', reason: 'panic' },
      [expect.anything()]
    )
    expect(cacheNames).toEqual(new Set(['other-app-cache']))
    expect(deleteDatabase).toHaveBeenCalledWith('fsusblog-comment-privacy-credentials')
    expect(result).toMatchObject({
      registeredStorageCleared: true,
      credentialStateCleared: true,
      legacyCredentialDatabaseCleared: true,
      serviceWorkerAcknowledged: true,
      cacheStorageCleared: true
    })
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items.find(item => item.id === 'panic-all-caches')).toMatchObject({ status: 'removed' })
  })

  it('admin logout clears admin storage without erasing account state or notifying credential workers', async () => {
    const activeWorker = createAcknowledgingWorker()
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        controller: activeWorker,
        getRegistrations: vi.fn().mockResolvedValue([])
      },
      configurable: true
    })
    localStorage.setItem('fsus:article-draft:create', 'admin-private')
    localStorage.setItem('fsus:comment-draft:v1:account:1:root', 'account-private')
    localStorage.setItem('fsus:theme-mode', 'dark')
    sessionStorage.setItem('fsusblog_local_fixture_admin_session', '1')
    sessionStorage.setItem('fsusblog_local_fixture_session', '1')

    const result = await clearPrivateBrowserState('admin-logout')

    expect(localStorage.getItem('fsus:article-draft:create')).toBeNull()
    expect(sessionStorage.getItem('fsusblog_local_fixture_admin_session')).toBeNull()
    expect(localStorage.getItem('fsus:comment-draft:v1:account:1:root')).toBe('account-private')
    expect(sessionStorage.getItem('fsusblog_local_fixture_session')).toBe('1')
    expect(localStorage.getItem('fsus:theme-mode')).toBe('dark')
    expect(activeWorker.postMessage).not.toHaveBeenCalled()
    expect(result.credentialStateCleared).toBe(true)
    expect(result.items.find(item => item.id === 'article-drafts')?.status).toBe('removed')
    expect(result.items.find(item => item.id === 'comment-drafts')?.status).toBe('retained')
  })
})

function createAcknowledgingWorker() {
  return {
    postMessage: vi.fn((message: { type: string }, transfer: Transferable[] = []) => {
      const responsePort = transfer[0] as MessagePort | undefined
      responsePort?.postMessage({
        type: 'control-complete',
        controlType: message.type,
        result: { cleared: true }
      })
    })
  }
}
