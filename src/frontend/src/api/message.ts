import type { ApiRequestConfig } from './requestConfig'
import { FrameType } from '@wasm/protocol/frame'
import { requestBinaryOnly } from '@/composition/binaryTransport'
import type {
  AdminConversationDetailResponse,
  AdminConversationListItemResponse,
  BinaryPageResponse,
  ConversationDetailResponse,
  ConversationListItemResponse,
  ConversationMessagePreviewResponse,
  ConversationMessageResponse
} from '@/contracts/binaryApi'
import { encodeAedsFrame, encodeStringMutationRequest } from './binaryFrame'

export type ConversationStatus = 'open' | 'pending' | 'closed'
export type ConversationFilter = 'all' | 'unread' | 'system' | 'open' | 'pending' | 'closed'

export type {
  AdminConversationDetailResponse,
  AdminConversationListItemResponse,
  ConversationDetailResponse,
  ConversationListItemResponse,
  ConversationMessagePreviewResponse,
  ConversationMessageResponse
} from '@/contracts/binaryApi'

export type PageResponse<T> = BinaryPageResponse<T>

export interface CreateConversationRequest {
  subject: string
  body: string
  clientMutationId?: string
}

export interface ReplyConversationRequest {
  body: string
  readThroughMessageId?: string
  clientMutationId?: string
}

export interface UpdateConversationStatusRequest {
  status: ConversationStatus
}

export interface SendSystemMessageRequest {
  targetAccountId: number
  subject: string
  body: string
  sourceEventId?: string
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
  getAccountConversations(size: number, filter: ConversationFilter = 'all', cursor?: string | null, config?: ApiRequestConfig) {
    const search = conversationSearch(size, filter, cursor)
    return requestBinaryOnly<PageResponse<ConversationListItemResponse>>({
      binaryRoute: {
        operationId: 'binary_get_messages_conversations',
        query: search
      },
      frameType: FrameType.ConversationList,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  getAccountConversationDetail(conversationId: string | number, beforeMessageId?: string | null, config?: ApiRequestConfig) {
    const query = new URLSearchParams()
    if (beforeMessageId) query.set('beforeMessageId', beforeMessageId)
    return requestBinaryOnly<ConversationDetailResponse>({
      binaryRoute: {
        operationId: 'binary_get_messages_conversations_id_long',
        params: { id: conversationId },
        query
      },
      frameType: FrameType.ConversationDetailV3,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  createAccountConversation(data: CreateConversationRequest, config?: ApiRequestConfig) {
    const identity = resolveStableIdentity(`account-create:${data.subject}\u001f${data.body}`, data.clientMutationId)
    return settleStableIdentity(identity, requestBinaryOnly<ConversationDetailResponse>({
      binaryRoute: { operationId: 'binary_post_messages_conversations' },
      frameType: FrameType.ConversationDetailV2,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        headers: { 'X-Fsus-Client-Mutation-Id': identity.value },
        body: encodeAedsFrame(FrameType.ConversationCreateRequest, encodeConversationCreateRequest(data))
      }
    }))
  },

  replyAccountConversation(conversationId: string | number, data: ReplyConversationRequest & { readThroughMessageId: string }, config?: ApiRequestConfig) {
    const identity = resolveStableIdentity(
      `account-reply:${conversationId}:${data.readThroughMessageId}:${data.body}`,
      data.clientMutationId
    )
    return settleStableIdentity(identity, requestBinaryOnly<ConversationMessageResponse>({
      binaryRoute: {
        operationId: 'binary_post_messages_conversations_id_long_reply',
        params: { id: conversationId }
      },
      frameType: FrameType.ConversationMessage,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        headers: { 'X-Fsus-Client-Mutation-Id': identity.value },
        body: encodeAedsFrame(
          FrameType.AccountConversationReplyRequest,
          encodeAccountConversationReplyRequest(data.readThroughMessageId, data.body)
        )
      }
    }))
  },

  markConversationRead(conversationId: string | number, readThroughMessageId: string, config?: ApiRequestConfig) {
    return requestBinaryOnly<null>({
      binaryRoute: {
        operationId: 'binary_post_messages_conversations_id_long_read',
        params: { id: conversationId }
      },
      frameType: FrameType.EmptySuccess,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        body: encodeAedsFrame(
          FrameType.ConversationReadRequest,
          encodeConversationReadRequest(readThroughMessageId)
        )
      }
    })
  },

  adminGetConversations(size: number, filter: ConversationFilter = 'all', cursor?: string | null, config?: ApiRequestConfig) {
    const search = conversationSearch(size, filter, cursor)
    return requestBinaryOnly<PageResponse<AdminConversationListItemResponse>>({
      binaryRoute: {
        operationId: 'binary_get_admin_messages_conversations',
        query: search
      },
      frameType: FrameType.AdminConversationList,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  adminGetConversationDetail(conversationId: string | number, beforeMessageId?: string | null, config?: ApiRequestConfig) {
    const query = new URLSearchParams()
    if (beforeMessageId) query.set('beforeMessageId', beforeMessageId)
    return requestBinaryOnly<AdminConversationDetailResponse>({
      binaryRoute: {
        operationId: 'binary_get_admin_messages_conversations_id_long',
        params: { id: conversationId },
        query
      },
      frameType: FrameType.AdminConversationDetail,
      signal: config?.signal as AbortSignal | undefined
    })
  },

  adminReplyConversation(conversationId: string | number, data: ReplyConversationRequest, config?: ApiRequestConfig) {
    const identity = resolveStableIdentity(`admin-reply:${conversationId}:${data.body}`, data.clientMutationId)
    return settleStableIdentity(identity, requestBinaryOnly<ConversationMessageResponse>({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_reply',
        params: { id: conversationId }
      },
      frameType: FrameType.ConversationMessage,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        headers: { 'X-Fsus-Client-Mutation-Id': identity.value },
        body: encodeAedsFrame(FrameType.ConversationReplyRequest, encodeStringMutationRequest(data.body))
      }
    }))
  },

  adminUpdateConversationStatus(conversationId: string | number, data: UpdateConversationStatusRequest, config?: ApiRequestConfig) {
    return requestBinaryOnly<null>({
      binaryRoute: {
        operationId: 'binary_post_admin_messages_conversations_id_long_status',
        params: { id: conversationId }
      },
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
    const identity = resolveStableSourceEvent(
      `system:${data.targetAccountId}:${data.subject}\u001f${data.body}`,
      data.sourceEventId
    )
    return settleStableIdentity(identity, requestBinaryOnly<ConversationDetailResponse>({
      binaryRoute: { operationId: 'binary_post_admin_messages_system_send' },
      frameType: FrameType.ConversationDetailV2,
      signal: config?.signal as AbortSignal | undefined,
      requestOptions: {
        method: 'POST',
        requiresPow: true,
        headers: { 'X-Fsus-Source-Event-Id': identity.value },
        body: encodeAedsFrame(FrameType.SystemMessageRequest, encodeSystemMessageRequest(data))
      }
    }))
  }
}

type StableIdentity = { key: string | null; value: string }
const pendingMutationIdentities = new Map<string, string>()

function resolveStableIdentity(key: string, explicit?: string): StableIdentity {
  if (explicit?.trim()) return { key: null, value: explicit.trim() }
  const existing = pendingMutationIdentities.get(key)
  if (existing) return { key, value: existing }
  const value = globalThis.crypto?.randomUUID?.() ?? `message-${Date.now()}-${Math.random().toString(16).slice(2)}`
  pendingMutationIdentities.set(key, value)
  return { key, value }
}

function resolveStableSourceEvent(key: string, explicit?: string): StableIdentity {
  if (explicit?.trim()) return { key: null, value: explicit.trim() }
  const existing = pendingMutationIdentities.get(key)
  if (existing) return { key, value: existing }
  const bytes = new Uint8Array(8)
  globalThis.crypto?.getRandomValues?.(bytes)
  let value = 0n
  for (let index = 0; index < bytes.length; index += 1) value = (value << 8n) | BigInt(bytes[index] ?? 0)
  value &= 0x7fffffffffffffffn
  if (value === 0n) value = BigInt(Date.now())
  const encoded = value.toString()
  pendingMutationIdentities.set(key, encoded)
  return { key, value: encoded }
}

async function settleStableIdentity<T>(identity: StableIdentity, request: Promise<T>): Promise<T> {
  try {
    const result = await request
    if (identity.key) pendingMutationIdentities.delete(identity.key)
    return result
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : 0
    if (identity.key && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      pendingMutationIdentities.delete(identity.key)
    }
    throw error
  }
}

function conversationSearch(size: number, filter: ConversationFilter, cursor?: string | null): URLSearchParams {
  const search = new URLSearchParams()
  search.set('size', String(size))
  const filterParam = toFilterParam(filter)
  if (filterParam) search.set('filter', filterParam)
  if (cursor) search.set('cursor', cursor)
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

function encodeConversationReadRequest(readThroughMessageId: string): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(readThroughMessageId), true)
  return bytes
}

function encodeAccountConversationReplyRequest(readThroughMessageId: string, body: string): Uint8Array {
  const encoded = new TextEncoder().encode(body)
  const bytes = new Uint8Array(16 + 4 + encoded.byteLength)
  const view = new DataView(bytes.buffer)
  view.setBigInt64(0, BigInt(readThroughMessageId), true)
  view.setInt32(8, 0, true)
  view.setInt32(12, encoded.byteLength, true)
  view.setInt32(16, encoded.byteLength, true)
  bytes.set(encoded, 20)
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
