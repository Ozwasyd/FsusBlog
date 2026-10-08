import { buildFsusBinaryRoute, fsusBinaryRouteDescriptors } from '@/generated/fsusBinaryRoutes'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
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
      requestOptions: expect.objectContaining({ })
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
    await getArticles({ tagId: 3 })
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryRoute).toEqual(expect.objectContaining({
      operationId: 'binary_get_article_list_tag_tagId_page_size_aeds',
      params: { tagId: 3, page: 1, size: 10 }
    }))
  })

  it('getArticles rejects cursorless deep pages before transport', () => {
    expect(() => getArticles({ page: 2 })).toThrow('article_cursor_required')
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('getArticles rejects a cursor on the first page before transport', () => {
    expect(() => getArticles({ page: 1, cursor: 'unexpected_cursor' }))
      .toThrow('article_cursor_not_allowed_on_first_page')
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('getArticles forwards the opaque cursor without parsing it', async () => {
    await getArticles({ page: 2, cursor: 'AQIDBA_filter-bound-checksum' })
    expectBinaryRoute('binary_get_article_list_home_page_size_aeds', FrameType.ArticleList, {
      params: { page: 2, size: 10 },
      query: 'cursor=AQIDBA_filter-bound-checksum'
    })
  })

  it('getArticles forwards cursor-bound search and sort inputs', async () => {
    await getArticles({
      page: 2,
      cursor: 'opaque_cursor',
      keyword: '  cursor pagination  ',
      sort: 'relevance'
    })
    expectBinaryRoute('binary_get_article_list_home_page_size_aeds', FrameType.ArticleList, {
      params: { page: 2, size: 10 },
      query: 'cursor=opaque_cursor&keyword=cursor+pagination&sort=relevance'
    })
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
      requestOptions: expect.objectContaining({ }),
    })
  })

  it('getArticleById forwards AbortSignal to the binary transport', async () => {
    const controller = new AbortController()

    await getArticleById(42, { signal: controller.signal })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_article_id_aeds',
        params: { id: 42 }
      }),
      frameType: FrameType.ArticleDetail,
      requestOptions: expect.objectContaining({ }),
      signal: controller.signal
    }))
  })

  it('getHotArticles calls requestBinaryOnly with size param', async () => {
    await getHotArticles(5)
    expectBinaryRoute('binary_get_article_hot_size_aeds', FrameType.ArticleHot, {
      params: { size: 5 },
      requestOptions: expect.objectContaining({ })
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
      requestOptions: expect.objectContaining({ }),
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
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].credentialPolicy).toBe('omit')
    expect(fsusBinaryRouteDescriptors[call.binaryRoute.operationId].requiresPow).toBe(false)
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
        body: expect.any(ArrayBuffer)
      })
    })
  })

  it('createArticle reuses the mutation id after a lost response and clears it after success', async () => {
    const data = { title: 'Retry', content: 'C', summary: 'S', categoryId: 1, tagIds: [] }
    mockBinary.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce({ articleId: 42 } as never)

    await expect(createArticle(data)).rejects.toThrow('response lost')
    const firstId = mockBinary.mock.calls[0][0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']
    await createArticle(data)
    const retryId = mockBinary.mock.calls[1][0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']

    expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
    expect(retryId).toBe(firstId)
  })

  it('createArticle encodes ArticleWriteRequest V5 preserve mode without a base revision', async () => {
    const data = { title: 'T', content: 'C', summary: 'S', categoryId: 1, tagIds: [] }
    await createArticle(data)

    const parsed = parseArticleWriteRequestPayload(getMutationPayload())

    expect(parsed.version).toBe(5)
    expect(parsed.baseRevisionId).toBe(0n)
    expect(parsed.rightsMutation).toBe(0)
    expect(parsed.flags).toBe(15)
    expect(parsed.copyrightYear).toBe(0)
    expect(parsed.maxExcerptChars).toBe(300)
    expect(parsed.rights.licenseType).toBe('all-rights-reserved')
    expect(parsed.rights.copyPolicy).toBe('append-attribution')
    expect(parsed.rights.copyrightHolder).toBe('')
    expect(parsed.rights.rightsStatement).toBe('')
    expect(parsed.rights.attributionTemplate).toBe('')
  })

  it('createArticle encodes ArticleWriteRequest V5 explicit rights replacement', async () => {
    await createArticle({
      title: 'T',
      content: 'C',
      summary: 'S',
      categoryId: 1,
      tagIds: [5, 3],
      rights: {
        enabled: true,
        licenseType: 'CC-BY-4.0',
        copyrightHolder: 'Fésus',
        copyrightYear: 2026,
        rightsStatement: 'Line one\nLine two',
        attributionTemplate: '{title} — {holder}',
        copyPolicy: 'append-attribution',
        maxExcerptChars: 128,
        allowCodeCopy: true,
        showPublicBadge: false,
        proofBindingEnabled: true
      }
    })

    const parsed = parseArticleWriteRequestPayload(getMutationPayload())

    expect(parsed.tagIds).toEqual([5, 3])
    expect(parsed.version).toBe(5)
    expect(parsed.rightsMutation).toBe(1)
    expect(parsed.flags).toBe(27)
    expect(parsed.copyrightYear).toBe(2026)
    expect(parsed.maxExcerptChars).toBe(128)
    expect(parsed.rights.licenseType).toBe('CC-BY-4.0')
    expect(parsed.rights.copyrightHolder).toBe('Fésus')
    expect(parsed.rights.rightsStatement).toBe('Line one\nLine two')
    expect(parsed.rights.attributionTemplate).toBe('{title} — {holder}')
    expect(parsed.rights.copyPolicy).toBe('append-attribution')
  })

  it('updateArticle calls PUT /Article/:id', async () => {
    const data = { title: 'T', content: 'C', summary: 'S', categoryId: 1, tagIds: [], baseRevisionId: '8123' }
    await updateArticle(10, data)
    expectBinaryRoute('binary_put_admin_article_id_int', FrameType.MutationId, {
      params: { id: 10 },
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    })
    expect(parseArticleWriteRequestPayload(getMutationPayload()).baseRevisionId).toBe(8123n)
  })

  it('updateArticle encodes explicit rights reset independently from a replacement payload', async () => {
    const data = {
      title: 'T',
      content: 'C',
      summary: 'S',
      categoryId: 1,
      tagIds: [],
      resetRights: true
    }
    await updateArticle(10, data)

    expect(parseArticleWriteRequestPayload(getMutationPayload()).rightsMutation).toBe(2)
  })

  it('deleteArticle calls DELETE /Article/:id', async () => {
    await deleteArticle(10)
    expectBinaryRoute('binary_delete_admin_article_id_int', FrameType.EmptySuccess, {
      params: { id: 10 },
      requestOptions: expect.objectContaining({
      })
    })
  })

  it('restoreArticle calls PUT /Article/restore/:id', async () => {
    await restoreArticle(5)
    expectBinaryRoute('binary_put_admin_article_restore_id_int', FrameType.EmptySuccess, {
      params: { id: 5 },
      requestOptions: expect.objectContaining({
      })
    })
  })

  it('permanentDeleteArticle calls DELETE /Article/permanent/:id', async () => {
    await permanentDeleteArticle(7)
    expectBinaryRoute('binary_delete_admin_article_permanent_id_int', FrameType.EmptySuccess, {
      params: { id: 7 },
      requestOptions: expect.objectContaining({
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

function getMutationPayload(): Uint8Array {
  const body = mockBinary.mock.calls[0]?.[0]?.requestOptions?.body
  expect(body).toBeInstanceOf(ArrayBuffer)
  const frame = body as ArrayBuffer
  const header = new DataView(frame, 0, 16)
  expect(header.getUint16(8, true)).toBe(FrameType.ArticleWriteRequest)
  const payloadLength = header.getUint32(10, true)
  return new Uint8Array(frame, 16, payloadLength)
}

function parseArticleWriteRequestPayload(payload: Uint8Array): {
  tagIds: number[]
  version: number
  rightsMutation: number
  baseRevisionId: bigint
  flags: number
  copyrightYear: number
  maxExcerptChars: number
  rights: Record<'licenseType' | 'copyrightHolder' | 'rightsStatement' | 'attributionTemplate' | 'copyPolicy', string>
} {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const decoder = new TextDecoder()
  const tagCount = view.getInt32(4, true)
  let cursor = 40
  const tagIds: number[] = []
  for (let i = 0; i < tagCount; i += 1) {
    tagIds.push(view.getInt32(cursor, true))
    cursor += 4
  }

  const articleBlobLength = view.getInt32(cursor, true)
  cursor += 4 + articleBlobLength
  cursor += 4
  cursor += 8
  const version = view.getInt32(cursor, true)
  cursor += 4
  const rightsMutation = view.getInt32(cursor, true)
  cursor += 4
  const flags = view.getInt32(cursor, true)
  cursor += 4
  const copyrightYear = view.getInt32(cursor, true)
  cursor += 4
  const maxExcerptChars = view.getInt32(cursor, true)
  cursor += 4

  const sliceRefs = Array.from({ length: 5 }, () => {
    const offset = view.getInt32(cursor, true)
    const length = view.getInt32(cursor + 4, true)
    cursor += 8
    return { offset, length }
  })
  const rightsBlobLength = view.getInt32(cursor, true)
  cursor += 4
  const rightsBlob = payload.subarray(cursor, cursor + rightsBlobLength)
  cursor += rightsBlobLength
  const baseRevisionId = view.getBigInt64(cursor, true)
  const readSlice = (index: number) => {
    const slice = sliceRefs[index]!
    expect(slice).toBeDefined()
    return decoder.decode(rightsBlob.subarray(slice.offset, slice.offset + slice.length))
  }

  return {
    tagIds,
    version,
    rightsMutation,
    baseRevisionId,
    flags,
    copyrightYear,
    maxExcerptChars,
    rights: {
      licenseType: readSlice(0),
      copyrightHolder: readSlice(1),
      rightsStatement: readSlice(2),
      attributionTemplate: readSlice(3),
      copyPolicy: readSlice(4)
    }
  }
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
