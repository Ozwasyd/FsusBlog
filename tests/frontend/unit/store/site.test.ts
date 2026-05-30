import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSiteStore } from '@/store/site'

vi.mock('@/api/system', () => ({
  getSiteConfig: vi.fn()
}))

import { getSiteConfig } from '@/api/system'
const mockGetSiteConfig = vi.mocked(getSiteConfig)

describe('useSiteStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('has default siteInfo values', () => {
    const store = useSiteStore()
    expect(store.siteInfo.author).toBe('Fsu')
    expect(store.isLoaded).toBe(false)
    expect(store.isMobileSearchOpen).toBe(false)
  })

  it('setMobileSearchVisible sets isMobileSearchOpen', () => {
    const store = useSiteStore()
    store.setMobileSearchVisible(true)
    expect(store.isMobileSearchOpen).toBe(true)
    store.setMobileSearchVisible(false)
    expect(store.isMobileSearchOpen).toBe(false)
  })

  it('fetchSiteInfo calls getSiteConfig and updates siteInfo', async () => {
    const mockConfig = {
      title: 'My Blog',
      description: 'Test',
      keywords: 'test',
      author: 'Alice',
      ogImage: '',
      baseUrl: 'https://example.com'
    }
    mockGetSiteConfig.mockResolvedValueOnce(mockConfig as never)
    const store = useSiteStore()
    await store.fetchSiteInfo()
    expect(store.isLoaded).toBe(true)
    expect(store.siteInfo.title).toBe('My Blog')
    expect(store.siteInfo.author).toBe('Alice')
  })

  it('fetchSiteInfo does nothing if already loaded', async () => {
    mockGetSiteConfig.mockResolvedValue({ title: 'T' } as never)
    const store = useSiteStore()
    await store.fetchSiteInfo()
    await store.fetchSiteInfo() // second call should skip
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(1)
  })

  it('fetchSiteInfo with force=true re-fetches', async () => {
    mockGetSiteConfig.mockResolvedValue({ title: 'Updated', description: '', keywords: '', author: '', ogImage: '', baseUrl: '' } as never)
    const store = useSiteStore()
    await store.fetchSiteInfo()
    await store.fetchSiteInfo(true)
    expect(mockGetSiteConfig).toHaveBeenCalledTimes(2)
  })

  it('fetchSiteInfo handles fetch error gracefully', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetSiteConfig.mockRejectedValueOnce(new Error('network error'))
    const store = useSiteStore()
    await store.fetchSiteInfo()
    expect(store.isLoaded).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
