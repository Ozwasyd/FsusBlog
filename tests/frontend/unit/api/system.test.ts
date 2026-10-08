import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

vi.mock('@/api/index', () => ({
  default: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn()
  }
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import {
  getAdminPageData,
  getAdminSiteComplianceConfig,
  getAdminSiteConfig,
  deleteImage,
  getPageData,
  getSiteComplianceConfig,
  getSiteConfig,
  refreshPageData,
  updatePageData,
  updateSiteComplianceConfig,
  updateSiteConfig
} from '@/api/system'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('system API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('getSiteConfig uses binary seo frame', async () => {
    await getSiteConfig()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_seo' },
      frameType: FrameType.SeoConfig
    }))
  })

  it('getAdminSiteConfig uses binary seo frame', async () => {
    await getAdminSiteConfig()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_admin_seo' },
      frameType: FrameType.SeoConfig
    }))
  })

  it('updateSiteConfig sends binary seo update request', async () => {
    await updateSiteConfig({
      title: 'Fsus',
      description: 'Forward',
      keywords: 'blog',
      author: 'Fsu',
      ogImage: '/og.webp',
      baseUrl: 'https://example.test',
      faviconSvgUrl: '/favicon.svg',
      faviconIcoUrl: '/favicon.ico',
      faviconPngUrl: '/favicon.png',
      appleTouchIconUrl: '/apple-touch-icon.png',
      manifestName: 'Fsus Manifest',
      manifestShortName: 'Fsus',
      pwaIcon192Url: '/icon-192.png',
      pwaIcon512Url: '/icon-512.png',
      pwaMaskableIconUrl: '/maskable-512.png',
      themeColor: '#0f0f11',
      backgroundColor: '#fcfcfc',
      siteLogoUrl: '/site-logo.svg',
      siteLogoDarkUrl: '/site-logo-dark.svg',
      siteWordmarkUrl: '/wordmark.svg',
      adminLogoUrl: '/admin-logo.svg',
      adminCollapsedIconUrl: '/admin-icon.svg',
      loginLogoUrl: '/login-logo.svg',
      loginIconUrl: '/login-icon.svg'
    })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_system_seo' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getSiteComplianceConfig uses binary compliance frame', async () => {
    await getSiteComplianceConfig()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_compliance' },
      frameType: FrameType.SiteComplianceConfig
    }))
  })

  it('getAdminSiteComplianceConfig uses admin binary compliance frame', async () => {
    await getAdminSiteComplianceConfig()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_admin_compliance' },
      frameType: FrameType.SiteComplianceConfig
    }))
  })

  it('updateSiteComplianceConfig sends binary compliance update request', async () => {
    await updateSiteComplianceConfig({
      enabled: true,
      regionMode: 'mainland-cn',
      copyrightOwner: 'Fsus',
      copyrightStartYear: 2024,
      copyrightText: '保留所有权利。',
      contentLicenseName: 'CC BY-NC-SA 4.0',
      contentLicenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      icpRecordNumber: '京ICP备2026000000号-1',
      icpRecordUrl: 'https://beian.miit.gov.cn/',
      policeRecordNumber: '京公网安备11000002000000号',
      policeRecordUrl: 'https://beian.mps.gov.cn/',
      policeBadgeIconUrl: '',
      operatorName: '',
      contactEmail: 'name@example.test'
    })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_system_compliance' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getPageData uses binary page frame', async () => {
    await getPageData('about')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_page_slug', params: { slug: 'about' } },
      frameType: FrameType.PageContent
    }))
  })

  it('getAdminPageData uses binary page frame', async () => {
    await getAdminPageData('about')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_system_admin_page_slug', params: { slug: 'about' } },
      frameType: FrameType.PageContent
    }))
  })

  it('updatePageData sends binary page update request', async () => {
    await updatePageData({ slug: 'about', content: '# About' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_system_page' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('refreshPageData calls the page cache refresh endpoint', async () => {
    await refreshPageData('privacy')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_system_page_refresh_slug', params: { slug: 'privacy' } },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
      })
    }))
  })

  it('deleteImage sends canonical AssetId in the binary file delete request', async () => {
    await deleteImage('3f3b2e7a-1d2e-4f8a-9c5b-6a7b8c9d0e1f')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_delete_file_delete' },
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
