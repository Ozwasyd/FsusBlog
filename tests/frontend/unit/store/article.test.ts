import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useArticleBinaryStore } from '@/store/article'

vi.mock('@/api/article', () => ({
  getArticleById: vi.fn()
}))

import { getArticleById } from '@/api/article'
const mockGetArticleById = vi.mocked(getArticleById)

describe('useArticleBinaryStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // clear localStorage
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  it('defaults useBinary to true when no localStorage entry', () => {
    const store = useArticleBinaryStore()
    expect(store.useBinary).toBe(true)
  })

  it('reads binary flag from localStorage', () => {
    localStorage.setItem('fsus.transport.binary', '0')
    const store = useArticleBinaryStore()
    expect(store.useBinary).toBe(false)
  })

  it('reads binary=true from localStorage', () => {
    localStorage.setItem('fsus.transport.binary', '1')
    const store = useArticleBinaryStore()
    expect(store.useBinary).toBe(true)
  })

  it('fetchArticleById calls getArticleById with id', async () => {
    const mockArticle = { id: 5, title: 'Test' } as never
    mockGetArticleById.mockResolvedValueOnce(mockArticle)
    const store = useArticleBinaryStore()
    const result = await store.fetchArticleById(5)
    expect(mockGetArticleById).toHaveBeenCalledWith(5, undefined)
    expect(result).toBe(mockArticle)
  })

  it('fetchArticleById passes signal when provided', async () => {
    const mockArticle = { id: 1, title: 'T' } as never
    mockGetArticleById.mockResolvedValueOnce(mockArticle)
    const controller = new AbortController()
    const store = useArticleBinaryStore()
    await store.fetchArticleById(1, controller.signal)
    expect(mockGetArticleById).toHaveBeenCalledWith(1, { signal: controller.signal })
  })
})
