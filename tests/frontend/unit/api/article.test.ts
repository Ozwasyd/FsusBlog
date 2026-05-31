import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  getArticles,
  getAdminArticles,
  getAdminArticleById,
  getArticleById,
  getFeaturedArticles,
  getHotArticles,
  createArticle,
  updateArticle,
  deleteArticle,
  restoreArticle,
  permanentDeleteArticle
} from '@/api/article'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('article API (binary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('getArticles calls requestBinaryOnly with default params', async () => {
    await getArticles({})
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/article/list/home/1/10.aeds',
      requestOptions: expect.objectContaining({ credentials: 'omit' })
    }))
  })

  it('getArticles applies categoryId filter', async () => {
    await getArticles({ categoryId: 5 })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toBe('/api/binary/article/list/category/5/1/10.aeds')
  })

  it('getArticles applies tagId filter', async () => {
    await getArticles({ tagId: 3, page: 2 })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toBe('/api/binary/article/list/tag/3/2/10.aeds')
  })

  it('getArticleById calls binary detail endpoint', async () => {
    await getArticleById(42)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/article/42.aeds',
      requestOptions: expect.objectContaining({ credentials: 'omit' }),
      frameType: expect.any(Number)
    }))
  })

  it('getHotArticles calls requestBinaryOnly with size param', async () => {
    await getHotArticles(5)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/article/hot/5.aeds',
      requestOptions: expect.objectContaining({ credentials: 'omit' })
    }))
  })

  it('getHotArticles uses default size 10', async () => {
    await getHotArticles()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/article/hot/10.aeds'
    }))
  })

  it('getFeaturedArticles calls binary featured endpoint', async () => {
    await getFeaturedArticles(4)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/article/featured/4.aeds',
      requestOptions: expect.objectContaining({ credentials: 'omit' }),
      frameType: expect.any(Number)
    }))
  })
})

describe('article API (admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('createArticle calls POST /Article with requiresPow', async () => {
    const data = { title: 'T', content: 'C', summary: 'S', categoryId: 1, tagIds: [] }
    await createArticle(data)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article',
      frameType: FrameType.MutationId,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('updateArticle calls PUT /Article/:id', async () => {
    const data = { title: 'T', content: 'C', summary: 'S', categoryId: 1, tagIds: [] }
    await updateArticle(10, data)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article/10',
      frameType: FrameType.MutationId,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('deleteArticle calls DELETE /Article/:id', async () => {
    await deleteArticle(10)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article/10',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    }))
  })

  it('restoreArticle calls PUT /Article/restore/:id', async () => {
    await restoreArticle(5)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article/restore/5',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true
      })
    }))
  })

  it('permanentDeleteArticle calls DELETE /Article/permanent/:id', async () => {
    await permanentDeleteArticle(7)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article/permanent/7',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    }))
  })

  it('getAdminArticles uses normal admin pipeline URL', async () => {
    await getAdminArticles({ page: 2, size: 20, status: 0 })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article?page=2&size=20&isDeleted=false&status=0',
      frameType: FrameType.ArticleList
    }))
  })

  it('getAdminArticleById uses admin detail URL', async () => {
    await getAdminArticleById(9)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/article/9',
      frameType: FrameType.ArticleDetail
    }))
  })

  it('does not export client AOT bundle upload APIs', async () => {
    const articleApi = await import('@/api/article')
    expect('uploadArticleAotBundle' in articleApi).toBe(false)
  })
})
