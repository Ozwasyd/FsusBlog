import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { getTags, getTagExactMetadata, getTagExactMetadataByName, createTag, updateTag, deleteTag } from '@/api/tag'
import { getCategories, getCategoryExactMetadata, createCategory, updateCategory, deleteCategory } from '@/api/category'
import { FrameType } from '@wasm/protocol/frame'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('tag API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue([])
  })

  it('getTags calls GET /Tag', async () => {
    await getTags()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_tag_aeds' }
    }))
  })

  it('getTags passes config', async () => {
    const config = { signal: new AbortController().signal }
    await getTags(config)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      signal: config.signal
    }))
  })

  it('getTagExactMetadata calls GET /tag/{id}.aeds', async () => {
    const config = { signal: new AbortController().signal }
    await getTagExactMetadata(11, config)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_tag_id_int_aeds', params: { id: 11 } },
      frameType: FrameType.TaxonomyExactMetadata,
      signal: config.signal
    }))
  })

  it('getTagExactMetadataByName calls GET /tag/by-name.aeds', async () => {
    await getTagExactMetadataByName('C#')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_get_tag_by_name_aeds',
        query: expect.any(URLSearchParams)
      },
      frameType: FrameType.TaxonomyExactMetadata
    }))
    const query = mockBinary.mock.calls.at(-1)?.[0]?.binaryRoute?.query
    expect(query).toBeInstanceOf(URLSearchParams)
    expect(query.get('name')).toBe('C#')
  })

  it('createTag sends binary mutation frame', async () => {
    await createTag({ name: 'vue', description: '  Vue tag 😀  ' })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_tag' },
      frameType: FrameType.MutationId,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readTaxonomyMetadataRequestBody()).toEqual({
      name: 'vue',
      description: '  Vue tag 😀  '
    })
  })

  it('updateTag sends binary mutation frame', async () => {
    await updateTag(5, 'react')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_tag_id_int', params: { id: 5 } },
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('deleteTag sends binary delete request', async () => {
    await deleteTag(3)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_delete_tag_id_int', params: { id: 3 } },
      requestOptions: expect.objectContaining({
      })
    }))
  })
})

describe('category API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue([])
  })

  it('getCategories calls GET /Category', async () => {
    await getCategories()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_category_aeds' }
    }))
  })

  it('getCategoryExactMetadata calls GET /category/{id}.aeds', async () => {
    const config = { signal: new AbortController().signal }
    await getCategoryExactMetadata(7, config)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_category_id_int_aeds', params: { id: 7 } },
      frameType: FrameType.TaxonomyExactMetadata,
      signal: config.signal
    }))
  })

  it('createCategory sends binary mutation frame', async () => {
    await createCategory('Tech')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_category' },
      frameType: FrameType.MutationId,
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('updateCategory sends binary mutation frame', async () => {
    await updateCategory(2, { name: 'Science', description: null })
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_put_category_id_int', params: { id: 2 } },
      requestOptions: expect.objectContaining({
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(readTaxonomyMetadataRequestBody()).toEqual({
      name: 'Science',
      description: null
    })
  })

  it('deleteCategory sends binary delete request', async () => {
    await deleteCategory(1)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_delete_category_id_int', params: { id: 1 } },
      requestOptions: expect.objectContaining({
      })
    }))
  })
})

function readTaxonomyMetadataRequestBody(): { name: string; description: string | null } {
  const call = mockBinary.mock.calls.at(-1)?.[0]
  const body = call?.requestOptions?.body
  expect(body).toBeInstanceOf(ArrayBuffer)
  const frame = new Uint8Array(body as ArrayBuffer)
  const payload = frame.subarray(16)
  expect(payload.byteLength).toBeGreaterThanOrEqual(140)
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const decoder = new TextDecoder()
  const nameEnd = payload.subarray(0, 128).indexOf(0)
  const name = decoder.decode(payload.subarray(0, nameEnd < 0 ? 128 : nameEnd))
  const descriptionOffset = view.getInt32(128, true)
  const descriptionLength = view.getInt32(132, true)
  const blobLength = view.getInt32(136, true)
  expect(descriptionOffset).toBe(0)
  expect(descriptionLength).toBe(blobLength)
  const description = decoder.decode(payload.subarray(140, 140 + blobLength))
  return { name, description: description.length === 0 ? null : description }
}

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
