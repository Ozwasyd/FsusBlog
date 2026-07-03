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
  getRelatedReading,
  getHotArticles,
  createArticle,
  updateArticle,
  deleteArticle,
  restoreArticle,
  permanentDeleteArticle
} from '@/api/article'

const mockBinary = vi.mocked(requestBinaryOnly)

const expectBinaryRoute = (
  operationId: string,
  frameType: FrameType,
  options: {
    params?: Record<string, unknown>
    query?: string
    requestOptions?: unknown
  } = {}
) => {
  expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
    binaryRoute: expect.objectContaining({
      operationId,
      ...(options.params ? { params: options.params } : {}),
      ...(options.query ? { query: expect.any(URLSearchParams) } : {})
    }),
    frameType,
    ...(options.requestOptions ? { requestOptions: options.requestOptions } : {})
  }))

  if (options.query) {
    const call = mockBinary.mock.calls.find(([request]) => request.binaryRoute?.operationId === operationId)?.[0]
    expect(call?.binaryRoute?.query?.toString()).toBe(options.query)
  }
}

describe('article API (binary)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('getArticles calls requestBinaryOnly with default params', async () => {
    await getArticles({})
    expectBinaryRoute('binary_get_article_list_home_page_size_aeds', FrameType.ArticleList, {
      params: { page: 1, size: 10 },
      requestOptions: expect.objectContaining({ credentials: 'omit' })
    })
  })

  it('getArticles applies categoryId filter', async () => {
    await getArticles({ categoryId: 5 })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_article_list_category_categoryId_page_size_aeds',
      params: { categoryId: 5, page: 1, size: 10 }
    }))
  })

  it('getArticles applies tagId filter', async () => {
    await getArticles({ tagId: 3, page: 2 })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_article_list_tag_tagId_page_size_aeds',
      params: { tagId: 3, page: 2, size: 10 }
    }))
  })

  it('getArticles can target archive artifact route', async () => {
    await getArticles({ listKind: 'archive' })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_article_list_archive_page_size_aeds',
      params: { page: 1, size: 10 }
    }))
  })

  it('getArticleById calls binary detail endpoint', async () => {
    await getArticleById(42)
    expectBinaryRoute('binary_get_article_id_aeds', FrameType.ArticleDetail, {
      params: { id: 42 },
      requestOptions: expect.objectContaining({ credentials: 'omit' }),
    })
  })

  it('getHotArticles calls requestBinaryOnly with size param', async () => {
    await getHotArticles(5)
    expectBinaryRoute('binary_get_article_hot_size_aeds', FrameType.ArticleHot, {
      params: { size: 5 },
      requestOptions: expect.objectContaining({ credentials: 'omit' })
    })
  })

  it('getHotArticles uses default size 10', async () => {
    await getHotArticles()
    expectBinaryRoute('binary_get_article_hot_size_aeds', FrameType.ArticleHot, {
      params: { size: 10 }
    })
  })

  it('getFeaturedArticles calls binary featured endpoint', async () => {
    await getFeaturedArticles(4)
    expectBinaryRoute('binary_get_article_featured_size_aeds', FrameType.ArticleFeatured, {
      params: { size: 4 },
      requestOptions: expect.objectContaining({ credentials: 'omit' }),
    })
  })

  it('getRelatedReading does not request pow headers', async () => {
    await getRelatedReading(42)
    const call = mockBinary.mock.calls[0][0]
    expect(call).toEqual(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_article_articleId_int_related_aeds',
        params: { articleId: 42 }
      }),
      frameType: FrameType.ArticleRelatedReading
    }))
    expect(call.requestOptions).toEqual(expect.objectContaining({ credentials: 'omit' }))
    expect(call.requestOptions?.requiresPow).toBeUndefined()
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
    expectBinaryRoute('binary_post_admin_article', FrameType.MutationId, {
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    })
  })

  it('updateArticle calls PUT /Article/:id', async () => {
    const data = { title: 'T', content: 'C', summary: 'S', categoryId: 1, tagIds: [] }
    await updateArticle(10, data)
    expectBinaryRoute('binary_put_admin_article_id_int', FrameType.MutationId, {
      params: { id: 10 },
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    })
  })

  it('deleteArticle calls DELETE /Article/:id', async () => {
    await deleteArticle(10)
    expectBinaryRoute('binary_delete_admin_article_id_int', FrameType.EmptySuccess, {
      params: { id: 10 },
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    })
  })

  it('restoreArticle calls PUT /Article/restore/:id', async () => {
    await restoreArticle(5)
    expectBinaryRoute('binary_put_admin_article_restore_id_int', FrameType.EmptySuccess, {
      params: { id: 5 },
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true
      })
    })
  })

  it('permanentDeleteArticle calls DELETE /Article/permanent/:id', async () => {
    await permanentDeleteArticle(7)
    expectBinaryRoute('binary_delete_admin_article_permanent_id_int', FrameType.EmptySuccess, {
      params: { id: 7 },
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    })
  })

  it('getAdminArticles uses normal admin pipeline URL', async () => {
    await getAdminArticles({ page: 2, size: 20, status: 0 })
    expectBinaryRoute('binary_get_admin_article', FrameType.ArticleList, {
      query: 'page=2&size=20&isDeleted=false&status=0'
    })
  })

  it('getAdminArticles serializes keyword and taxonomy filters', async () => {
    await getAdminArticles({ page: 1, size: 10, keyword: '  中文 keyword / a&b  ', categoryId: 3, tagId: 5 })
    expectBinaryRoute('binary_get_admin_article', FrameType.ArticleList, {
      query: 'page=1&size=10&isDeleted=false&keyword=%E4%B8%AD%E6%96%87+keyword+%2F+a%26b&categoryId=3&tagId=5'
    })
  })

  it('getAdminArticleById uses admin detail URL', async () => {
    await getAdminArticleById(9)
    expectBinaryRoute('binary_get_admin_article_id_int', FrameType.ArticleDetail, {
      params: { id: 9 }
    })
  })

  it('does not export client AOT bundle upload APIs', async () => {
    const articleApi = await import('@/api/article')
    expect('uploadArticleAotBundle' in articleApi).toBe(false)
  })
})
