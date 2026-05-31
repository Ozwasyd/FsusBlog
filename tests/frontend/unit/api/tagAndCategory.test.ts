import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { getTags, createTag, updateTag, deleteTag } from '@/api/tag'
import { getCategories, createCategory, updateCategory, deleteCategory } from '@/api/category'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('tag API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue([])
  })

  it('getTags calls GET /Tag', async () => {
    await getTags()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/tag.aeds'
    }))
  })

  it('getTags passes config', async () => {
    const config = { signal: new AbortController().signal }
    await getTags(config)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      signal: config.signal
    }))
  })

  it('createTag sends binary mutation frame', async () => {
    await createTag('vue')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/tag',
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('updateTag sends binary mutation frame', async () => {
    await updateTag(5, 'react')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/tag/5',
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('deleteTag sends binary delete request', async () => {
    await deleteTag(3)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/tag/3',
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
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
      binaryUrl: '/api/binary/category.aeds'
    }))
  })

  it('createCategory sends binary mutation frame', async () => {
    await createCategory('Tech')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/category',
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('updateCategory sends binary mutation frame', async () => {
    await updateCategory(2, 'Science')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/category/2',
      requestOptions: expect.objectContaining({
        method: 'PUT',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('deleteCategory sends binary delete request', async () => {
    await deleteCategory(1)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/category/1',
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    }))
  })
})
