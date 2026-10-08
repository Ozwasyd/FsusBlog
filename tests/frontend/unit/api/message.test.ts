import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
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
    await messageApi.getAccountConversations(20, 'unread', 'cursor-2')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_messages_conversations',
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.ConversationList
    }))
    expect(queryToString(mockBinary.mock.calls[0][0].binaryRoute?.query)).toBe('size=20&filter=unread&cursor=cursor-2')
  })

  it('creates and replies through binary mutation frames', async () => {
    await messageApi.createAccountConversation({ subject: 'Subject', body: 'Body' })
    await messageApi.replyAccountConversation(7, { body: 'Reply', readThroughMessageId: '11' })
    await messageApi.markConversationRead(7, '11')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_messages_conversations' },
      frameType: FrameType.ConversationDetailV2,
      requestOptions: expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fsus-Client-Mutation-Id': expect.any(String) }),
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
        headers: expect.objectContaining({ 'X-Fsus-Client-Mutation-Id': expect.any(String) }),
        body: expect.any(ArrayBuffer)
      })
    }))
    const replyCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_post_messages_conversations_id_long_reply'
    )?.[0]
    const replyFrame = new DataView(replyCall?.requestOptions?.body as ArrayBuffer)
    expect(replyFrame.getUint16(8, true)).toBe(FrameType.AccountConversationReplyRequest)
    expect(replyFrame.getBigInt64(16, true)).toBe(11n)

    const readCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_post_messages_conversations_id_long_read'
    )?.[0]
    const readFrame = new DataView(readCall?.requestOptions?.body as ArrayBuffer)
    expect(readFrame.getUint16(8, true)).toBe(FrameType.ConversationReadRequest)
    expect(readFrame.getBigInt64(16, true)).toBe(11n)
  })

  it('rejects oversized Unicode content before transport without truncating it', () => {
    const oversizedSubject = `${'😀'.repeat(160)}x`
    expect(() => messageApi.createAccountConversation({ subject: oversizedSubject, body: '正文' }))
      .toThrow('message_subject_grapheme_limit_exceeded')
    expect(mockBinary).not.toHaveBeenCalled()

    const oversizedBody = 'a'.repeat(4001)
    expect(() => messageApi.replyAccountConversation(7, { body: oversizedBody, readThroughMessageId: '11' }))
      .toThrow('message_body_grapheme_limit_exceeded')
    expect(mockBinary).not.toHaveBeenCalled()
  })

  it('reuses mutation identity for double click, timeout retry and response loss', async () => {
    const request = { subject: 'Stable subject', body: 'Stable body' }

    const first = messageApi.createAccountConversation(request)
    const second = messageApi.createAccountConversation(request)
    const doubleClickIds = mockBinary.mock.calls.slice(0, 2).map(([call]) =>
      call.requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']
    )
    expect(doubleClickIds[0]).toBe(doubleClickIds[1])
    await Promise.all([first, second])

    mockBinary.mockRejectedValueOnce({ status: 408 })
    await expect(messageApi.replyAccountConversation(7, {
      body: 'Timeout retry',
      readThroughMessageId: '11'
    })).rejects.toEqual({ status: 408 })
    const timeoutId = mockBinary.mock.calls.at(-1)?.[0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']
    await messageApi.replyAccountConversation(7, {
      body: 'Timeout retry',
      readThroughMessageId: '11'
    })
    expect(mockBinary.mock.calls.at(-1)?.[0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']).toBe(timeoutId)

    mockBinary.mockRejectedValueOnce(new TypeError('response lost'))
    await expect(messageApi.adminReplyConversation(9, { body: 'Response loss' })).rejects.toThrow('response lost')
    const responseLossId = mockBinary.mock.calls.at(-1)?.[0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']
    await messageApi.adminReplyConversation(9, { body: 'Response loss' })
    expect(mockBinary.mock.calls.at(-1)?.[0].requestOptions?.headers?.['X-Fsus-Client-Mutation-Id']).toBe(responseLossId)
  })

  it('loads bounded account thread pages with beforeMessageId', async () => {
    await messageApi.getAccountConversationDetail(7, '123')

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_messages_conversations_id_long',
        params: { id: 7 },
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.ConversationDetailV3
    }))
    expect(queryToString(mockBinary.mock.calls[0][0].binaryRoute?.query)).toBe('beforeMessageId=123')
  })

  it('loads reconnect deltas with afterMessageId and a caller abort signal', async () => {
    const controller = new AbortController()
    await messageApi.getAccountConversationDelta(7, '456', { signal: controller.signal })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_messages_conversations_id_long',
        params: { id: 7 },
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.ConversationDetailV3,
      signal: controller.signal
    }))
    expect(queryToString(mockBinary.mock.calls[0][0].binaryRoute?.query)).toBe('afterMessageId=456')
  })

  it('uses binary admin message endpoints', async () => {
    await messageApi.adminGetConversations(50, 'closed', 'admin-cursor')
    await messageApi.adminGetConversationDetail(9, '321')
    await messageApi.adminReplyConversation(9, { body: 'Admin reply' })
    await messageApi.adminUpdateConversationStatus(9, { status: 'closed', reason: 'resolved_by_admin' })
    await messageApi.adminSendSystemMessage({ targetAccountId: 3, subject: 'Notice', body: 'Body' })

    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_admin_messages_conversations',
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.AdminConversationList
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: expect.objectContaining({
        operationId: 'binary_get_admin_messages_conversations_id_long',
        params: { id: 9 },
        query: expect.any(URLSearchParams)
      }),
      frameType: FrameType.AdminConversationDetail
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_reply',
        params: { id: 9 }
      },
      frameType: FrameType.ConversationMessage,
      requestOptions: expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fsus-Client-Mutation-Id': expect.any(String) })
      })
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_status',
        params: { id: 9 }
      },
      frameType: FrameType.ConversationStatusMutationResult
    }))
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_post_admin_messages_system_send' },
      frameType: FrameType.ConversationDetailV2,
      requestOptions: expect.objectContaining({
        headers: expect.objectContaining({ 'X-Fsus-Source-Event-Id': expect.stringMatching(/^[1-9][0-9]*$/) })
      })
    }))
    const adminListCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_get_admin_messages_conversations'
    )?.[0]
    expect(queryToString(adminListCall?.binaryRoute?.query)).toBe('size=50&filter=closed&cursor=admin-cursor')
    const adminDetailCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_get_admin_messages_conversations_id_long'
    )?.[0]
    expect(queryToString(adminDetailCall?.binaryRoute?.query)).toBe('beforeMessageId=321')
    const statusCall = mockBinary.mock.calls.find(([request]) =>
      request.binaryRoute?.operationId === 'binary_post_admin_messages_conversations_id_long_status'
    )?.[0]
    const statusFrame = new Uint8Array(statusCall?.requestOptions?.body as ArrayBuffer)
    const statusView = new DataView(statusFrame.buffer, statusFrame.byteOffset, statusFrame.byteLength)
    expect(statusView.getUint16(8, true)).toBe(FrameType.ConversationStatusRequest)
    expect(statusView.getInt32(16, true)).toBe(2)
    expect(new TextDecoder().decode(statusFrame.subarray(32))).toBe('resolved_by_admin')
  })
})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
