import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSiteStore } from '@/store/site'

const mockReadPublicHydrationPayload = vi.hoisted(() => vi.fn())

vi.mock('@/api/system', () => ({
  getSiteConfig: vi.fn(),
  getSiteComplianceConfig: vi.fn()
}))

vi.mock('@/bootstrap/publicHydrationBootstrap', () => ({
  readPublicHydrationPayload: mockReadPublicHydrationPayload
}))

import { getSiteComplianceConfig, getSiteConfig } from '@/api/system'
const mockGetSiteConfig = vi.mocked(getSiteConfig)
const mockGetSiteComplianceConfig = vi.mocked(getSiteComplianceConfig)

describe('useSiteStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockReadPublicHydrationPayload.mockReturnValue(null)
    mockGetSiteComplianceConfig.mockResolvedValue(null as never)
  })

  it('has default siteInfo values', () => {
    const store = useSiteStore()
    expect(store.siteInfo.author).toBe('Fsu')
    expect(store.siteInfo.description).toBe('工程记录、性能实验、UI 系统与 FsusBlog 构建过程。')
    expect(store.siteInfo.keywords).toBe('.NET, 前端性能, 系统设计, UI 系统, 技术博客, FsusBlog')
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

  it('normalizes compliance from the hydration payload before exposing shell state', () => {
    mockReadPublicHydrationPayload.mockReturnValueOnce({
      siteTitle: 'Seed',
      compliance: {
        enabled: true,
        regionMode: 'mainland-cn',
        copyrightOwner: ' Fsu ',
        copyrightStartYear: '2021',
        icpRecordNumber: ' ICP-1 ',
        policeRecordNumber: ' Police-1 '
      }
    })

    const store = useSiteStore()

    expect(store.complianceInfo).toMatchObject({
      enabled: true,
      regionMode: 'mainland-cn',
      copyrightOwner: 'Fsu',
      copyrightStartYear: 2021,
      icpRecordNumber: 'ICP-1',
      icpRecordUrl: 'https://beian.miit.gov.cn/',
      policeRecordNumber: 'Police-1',
      policeRecordUrl: 'https://beian.mps.gov.cn/'
    })
  })

  it('normalizes compliance from the public API before replacing hydration seed state', async () => {
    mockGetSiteConfig.mockResolvedValueOnce({
      title: 'My Blog',
      description: 'Test',
      keywords: 'test',
      author: 'Alice',
      ogImage: '',
      baseUrl: 'https://example.com'
    } as never)
    mockGetSiteComplianceConfig.mockResolvedValueOnce({
      enabled: true,
      regionMode: 'unknown',
      copyrightOwner: ' API Owner ',
      copyrightStartYear: '0',
      icpRecordNumber: ' ICP-2 ',
      policeRecordNumber: ' Police-2 '
    } as never)
    const store = useSiteStore()

    await store.fetchSiteInfo()

    expect(store.complianceInfo).toMatchObject({
      enabled: true,
      regionMode: 'global',
      copyrightOwner: 'API Owner',
      copyrightStartYear: null,
      icpRecordNumber: 'ICP-2',
      icpRecordUrl: 'https://beian.miit.gov.cn/',
      policeRecordNumber: 'Police-2',
      policeRecordUrl: 'https://beian.mps.gov.cn/'
    })
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
