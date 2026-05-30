import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { messageApi } from '@/api/message'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('message API binary transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('loads user conversations with binary list frame', async () => {
    await messageApi.getUserConversations(2, 20, 'unread')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/messages/conversations?page=2&size=20&filter=unread',
      frameType: FrameType.ConversationList
    }))
  })

  it('creates and replies through binary mutation frames', async () => {
    await messageApi.createUserConversation({ subject: 'Subject', body: 'Body' })
    await messageApi.replyUserConversation(7, { body: 'Reply' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/messages/conversations',
      frameType: FrameType.ConversationDetail,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/messages/conversations/7/reply',
      frameType: FrameType.ConversationMessage,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
  })

  it('uses binary admin message endpoints', async () => {
    await messageApi.adminGetConversations(1, 50, 'closed')
    await messageApi.adminGetConversationDetail(9)
    await messageApi.adminReplyConversation(9, { body: 'Admin reply' })
    await messageApi.adminUpdateConversationStatus(9, { status: 'closed' })
    await messageApi.adminSendSystemMessage({ targetUserId: 3, subject: 'Notice', body: 'Body' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/messages/conversations?page=1&size=50&filter=closed',
      frameType: FrameType.ConversationList
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/messages/conversations/9',
      frameType: FrameType.ConversationDetail
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/messages/conversations/9/reply',
      frameType: FrameType.ConversationMessage
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/messages/conversations/9/status',
      frameType: FrameType.EmptySuccess
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryUrl: '/api/binary/admin/messages/system-send',
      frameType: FrameType.ConversationDetail
    }))
  })
})
