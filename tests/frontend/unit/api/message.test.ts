import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/services/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/services/binaryTransport'
import { messageApi } from '@/api/message'

const mockBinary = vi.mocked(requestBinaryOnly)

const queryToString = (query: unknown): string => {
  if (query instanceof URLSearchParams) {
    return query.toString()
  }

  return new URLSearchParams(query as Record<string, string>).toString()
}

describe('message API binary transport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue(null as never)
  })

  it('loads account conversations with binary list frame', async () => {
    await messageApi.getAccountConversations(2, 20, 'unread')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_messages_conversations',
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.ConversationList
    }))
    expect(queryToString(mockBinary.mock.calls[0][0].binaryRoute?.query)).toBe('page=2&size=20&filter=unread')
  })

  it('creates and replies through binary mutation frames', async () => {
    await messageApi.createAccountConversation({ subject: 'Subject', body: 'Body' })
    await messageApi.replyAccountConversation(7, { body: 'Reply' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_messages_conversations' },
      frameType: FrameType.ConversationDetail,
      requestOptions: expect.objectContaining({
        method: 'POST',
        requiresPow: true,
        body: expect.any(ArrayBuffer)
      })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_post_messages_conversations_id_long_reply',
        params: { id: 7 }
      },
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
    await messageApi.adminSendSystemMessage({ targetAccountId: 3, subject: 'Notice', body: 'Body' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_admin_messages_conversations',
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.ConversationList
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_get_admin_messages_conversations_id_long',
        params: { id: 9 }
      },
      frameType: FrameType.ConversationDetail
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_reply',
        params: { id: 9 }
      },
      frameType: FrameType.ConversationMessage
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_status',
        params: { id: 9 }
      },
      frameType: FrameType.EmptySuccess
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_admin_messages_system_send' },
      frameType: FrameType.ConversationDetail
    }))
    const adminListCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_get_admin_messages_conversations'
    )?.[0]
    expect(queryToString(adminListCall?.binaryRoute?.query)).toBe('page=1&size=50&filter=closed')
  })
})
