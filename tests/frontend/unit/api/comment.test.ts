import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import {
  createComment,
  getComments,
  getThreadReplies,
  getMyComments,
  deleteComment
} from '@/api/comment'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('comment API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({} as never)
  })

  it('createComment sends binary mutation frame', async () => {
    const dto = { articleId: 1, content: 'Hello', nonce: 'n', salt: 's', answer: 1 }
    await createComment(dto as never)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/comment',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('getComments calls requestBinaryOnly with articleId', async () => {
    await getComments(5)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: expect.stringContaining('/api/binary/comment/5')
    }))
  })

  it('getComments includes cursor when provided', async () => {
    await getComments(5, 'cursor-abc')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=cursor-abc')
  })

  it('getComments uses default limit 10', async () => {
    await getComments(5)
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('limit=10')
  })

  it('getThreadReplies calls requestBinaryOnly with articleId and rootId', async () => {
    await getThreadReplies(1, 'root-123')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('/api/binary/comment/1/thread/root-123')
    expect(call.binaryUrl).toContain('limit=20')
  })

  it('getThreadReplies includes cursor', async () => {
    await getThreadReplies(1, 'root-123', 'cursor-xyz')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=cursor-xyz')
  })

  it('getMyComments calls requestBinaryOnly with user endpoint', async () => {
    await getMyComments()
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('/api/binary/comment/me')
    expect(call.binaryUrl).toContain('limit=10')
  })

  it('getMyComments includes cursor when provided', async () => {
    await getMyComments('my-cursor')
    const call = mockBinary.mock.calls[0][0]
    expect(call.binaryUrl).toContain('cursor=my-cursor')
  })

  it('deleteComment sends binary delete request', async () => {
    await deleteComment('123')
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/comment/123',
      frameType: FrameType.EmptySuccess,
      requestOptions: expect.objectContaining({
        method: 'DELETE',
        requiresPow: true
      })
    }))
  })
})
