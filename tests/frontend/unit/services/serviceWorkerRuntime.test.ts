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

  beforeEach(() => {
    vi.clearAllMocks()
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
  })

  it('notifies active and waiting workers and removes offline history plus legacy sensitive entries', async () => {
    const activeWorker = { postMessage: vi.fn() }
    const waitingWorker = { postMessage: vi.fn() }
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

    await clearPrivateBrowserState('shared-device')

    expect(activeWorker.postMessage).toHaveBeenCalledTimes(1)
    expect(waitingWorker.postMessage).toHaveBeenCalledTimes(1)
    expect(activeWorker.postMessage).toHaveBeenCalledWith({
      type: 'privacy.clear',
      reason: 'shared-device'
    })
    expect(deletedCaches).toEqual(expect.arrayContaining([
      'fsus-shell-v6:test-build',
      'fsus-search-v5:test-build'
    ]))
    expect(staticCache.requests.has(new URL('/assets/app.abcdef.js', window.location.origin).href)).toBe(true)
    expect(staticCache.requests.has(new URL('/api/binary/auth/me.aeds', window.location.origin).href)).toBe(false)
    expect(staticCache.requests.has(new URL('/private/account.png', window.location.origin).href)).toBe(false)
  })
})
