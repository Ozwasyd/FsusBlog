import type { ApiRequestConfig } from './requestConfig'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/services/binaryTransport'
import { encodeAedsFrame, encodeStringMutationRequest } from './binaryFrame'

export type ConversationStatus = 'open' | 'pending' | 'closed'
export type ConversationFilter = 'all' | 'unread' | 'system' | 'open' | 'pending' | 'closed'

export interface ConversationMessagePreviewResponse {
  senderType: 0 | 1 | 2
  senderName?: string | null
  bodyPreview: string
  createdAt: string
}

export interface ConversationMessageResponse {
  messageId: string
  conversationId: string
  senderType: 0 | 1 | 2
  senderName?: string | null
  body: string
  createdAt: string
}

export interface ConversationListItemResponse {
  conversationId: string
  subject: string
  status: 0 | 1 | 2
  isSystemSource: boolean
  canReply: boolean
  unreadCount: number
  lastMessageAt: string
  updatedAt: string
  lastMessage?: ConversationMessagePreviewResponse | null
}

export interface ConversationDetailResponse {
  conversationId: string
  subject: string
  status: 0 | 1 | 2
  isSystemSource: boolean
  canReply: boolean
  unreadCount: number
  lastMessageAt: string
  messages: ConversationMessageResponse[]
}

export interface PageResponse<T> {
  items: T[]
  total: number
}

export interface CreateConversationRequest {
  subject: string
  body: string
}

export interface ReplyConversationRequest {
  body: string
}

export interface UpdateConversationStatusRequest {
  status: ConversationStatus
}

export interface SendSystemMessageRequest {
  targetAccountId: number
  subject: string
  body: string
}

export interface InboxConversationUpsertPayload {
  conversation: ConversationListItemResponse
  totalUnread?: number | null
  time?: string | null
}

export interface InboxMessageAppendPayload {
  conversationId: string
  message: ConversationMessageResponse
  conversationUnreadCount?: number | null
  totalUnread?: number | null
  time?: string | null
}

export interface InboxReadUpdatedPayload {
  conversationId: string
  lastReadMessageId?: string | null
  conversationUnreadCount: number
  totalUnread?: number | null
  time?: string | null
}

export interface InboxConversationClosedPayload {
  conversationId: string
  status: 0 | 1 | 2
  time: string
}

const toFilterParam = (filter?: ConversationFilter): string | undefined => {
  if (!filter || filter === 'all') return undefined
  return filter
}

export const messageApi = {
  getAccountConversations(page: number, size: number, filter: ConversationFilter = 'all', config?: ApiRequestConfig) {
    const search = conversationSearch(page, size, filter)
    return requestBinaryOnly<PageResponse<ConversationListItemResponse>>({
      binaryUrl: `/api/binary/messages/conversations?${search.toString()}`,
      frameType: FrameType.ConversationList,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  getAccountConversationDetail(conversationId: string | number, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationDetailResponse>({
      binaryUrl: `/api/binary/messages/conversations/${conversationId}`,
      frameType: FrameType.ConversationDetail,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  createAccountConversation(data: CreateConversationRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationDetailResponse>({
      binaryUrl: '/api/binary/messages/conversations',
      frameType: FrameType.ConversationDetail,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        body: encodeAedsFrame(FrameType.ConversationCreateRequest, encodeConversationCreateRequest(data))
      }
    })
  },

  replyAccountConversation(conversationId: string | number, data: ReplyConversationRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationMessageResponse>({
      binaryUrl: `/api/binary/messages/conversations/${conversationId}/reply`,
      frameType: FrameType.ConversationMessage,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        body: encodeAedsFrame(FrameType.ConversationReplyRequest, encodeStringMutationRequest(data.body))
      }
    })
  },

  markConversationRead(conversationId: string | number, config?: ApiRequestConfig) {
    return requestBinaryOnly<null>({
      binaryUrl: `/api/binary/messages/conversations/${conversationId}/read`,
      frameType: FrameType.EmptySuccess,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: { method: 'POST' }
    })
  },

  adminGetConversations(page: number, size: number, filter: ConversationFilter = 'all', config?: ApiRequestConfig) {
    const search = conversationSearch(page, size, filter)
    return requestBinaryOnly<PageResponse<ConversationListItemResponse>>({
      binaryUrl: `/api/binary/admin/messages/conversations?${search.toString()}`,
      frameType: FrameType.ConversationList,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  adminGetConversationDetail(conversationId: string | number, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationDetailResponse>({
      binaryUrl: `/api/binary/admin/messages/conversations/${conversationId}`,
      frameType: FrameType.ConversationDetail,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  adminReplyConversation(conversationId: string | number, data: ReplyConversationRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationMessageResponse>({
      binaryUrl: `/api/binary/admin/messages/conversations/${conversationId}/reply`,
      frameType: FrameType.ConversationMessage,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        body: encodeAedsFrame(FrameType.ConversationReplyRequest, encodeStringMutationRequest(data.body))
      }
    })
  },

  adminUpdateConversationStatus(conversationId: string | number, data: UpdateConversationStatusRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<null>({
      binaryUrl: `/api/binary/admin/messages/conversations/${conversationId}/status`,
      frameType: FrameType.EmptySuccess,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        body: encodeAedsFrame(FrameType.ConversationStatusRequest, encodeConversationStatusRequest(data.status))
      }
    })
  },

  adminSendSystemMessage(data: SendSystemMessageRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<ConversationDetailResponse>({
      binaryUrl: '/api/binary/admin/messages/system-send',
      frameType: FrameType.ConversationDetail,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        body: encodeAedsFrame(FrameType.SystemMessageRequest, encodeSystemMessageRequest(data))
      }
    })
  }
}

function conversationSearch(page: number, size: number, filter: ConversationFilter): URLSearchParams {
  const search = new URLSearchParams()
  search.set('page', String(page))
  search.set('size', String(size))
  const filterParam = toFilterParam(filter)
  if (filterParam) search.set('filter', filterParam)
  return search
}

function encodeConversationCreateRequest(data: CreateConversationRequest): Uint8Array {
  const subject = new TextEncoder().encode(data.subject)
  const body = new TextEncoder().encode(data.body)
  const blob = new Uint8Array(subject.byteLength + body.byteLength)
  const bytes = new Uint8Array(16 + 4 + blob.byteLength)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, 0, true)
  view.setInt32(4, subject.byteLength, true)
  view.setInt32(8, subject.byteLength, true)
  view.setInt32(12, body.byteLength, true)
  blob.set(subject, 0)
  blob.set(body, subject.byteLength)
  view.setInt32(16, blob.byteLength, true)
  bytes.set(blob, 20)
  return bytes
}

function encodeConversationStatusRequest(status: ConversationStatus): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setInt32(0, status === 'pending' ? 1 : status === 'closed' ? 2 : 0, true)
  return bytes
}

function encodeSystemMessageRequest(data: SendSystemMessageRequest): Uint8Array {
  const subject = new TextEncoder().encode(data.subject)
  const body = new TextEncoder().encode(data.body)
  const blob = new Uint8Array(subject.byteLength + body.byteLength)
  const bytes = new Uint8Array(32 + 4 + blob.byteLength)
  const view = new DataView(bytes.buffer)
  const target = BigInt(data.targetAccountId)
  view.setBigInt64(0, target, true)
  view.setUint8(8, 1)
  view.setInt32(16, 0, true)
  view.setInt32(20, subject.byteLength, true)
  view.setInt32(24, subject.byteLength, true)
  view.setInt32(28, body.byteLength, true)
  blob.set(subject, 0)
  blob.set(body, subject.byteLength)
  view.setInt32(32, blob.byteLength, true)
  bytes.set(blob, 36)
  return bytes
}
