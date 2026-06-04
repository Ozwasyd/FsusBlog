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
import { COMMENT_CONTENT_CONSTRAINT } from '@/utils/contentFilter'

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

  it('createComment rejects over-limit content before opening binary transport', async () => {
    const dto = { articleId: 1, content: 'a'.repeat(COMMENT_CONTENT_CONSTRAINT.maxChars + 1), nonce: 'n', salt: 's', answer: 1 }

    await expect(createComment(dto as never)).rejects.toThrow(COMMENT_CONTENT_CONSTRAINT.charLengthMessage)
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('getComments calls requestBinaryOnly with articleId', async () => {
    await getComments(5)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: expect.stringContaining('/api/binary/comment/5'),
      requestOptions: expect.objectContaining({ requiresPow: true })
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
    expect(call.requestOptions).toEqual(expect.objectContaining({ requiresPow: true }))
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
