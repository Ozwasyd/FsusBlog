import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
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

import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  getAdminPageData,
  getAdminSiteConfig,
  deleteImage,
  getPageData,
  getSiteConfig,
  refreshPageData,
  updatePageData,
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
      binaryUrl: '/api/binary/system/seo',
      frameType: FrameType.SeoConfig
    }))
  })

  it('getAdminSiteConfig uses binary seo frame', async () => {
    await getAdminSiteConfig()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/admin/seo',
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
      baseUrl: 'https://example.test'
    })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/seo',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getPageData uses binary page frame', async () => {
    await getPageData('about')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/page/about',
      frameType: FrameType.PageContent
    }))
  })

  it('getAdminPageData uses binary page frame', async () => {
    await getAdminPageData('about')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/admin/page/about',
      frameType: FrameType.PageContent
    }))
  })

  it('updatePageData sends binary page update request', async () => {
    await updatePageData({ slug: 'about', content: '# About' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/page',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('refreshPageData calls the page cache refresh endpoint', async () => {
    await refreshPageData('privacy')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/system/page/refresh/privacy',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true
      })
    }))
  })

  it('deleteImage sends binary file delete request', async () => {
    await deleteImage('/uploads/illustration/test.webp')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/file/delete',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

})
