import type { AxiosRequestConfig } from 'axios'
import service from '@/api/index'

export type ConversationStatus = 'open' | 'pending' | 'closed'
export type ConversationFilter = 'all' | 'unread' | 'system' | 'open' | 'pending' | 'closed'
export type SenderType = 'user' | 'admin' | 'system'

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
  targetUserId?: number | null
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
  getUserConversations(page: number, size: number, filter: ConversationFilter = 'all', config?: AxiosRequestConfig) {
    return service.get<PageResponse<ConversationListItemResponse>>('/v1/messages/conversations', {
      ...config,
      params: { page, size, filter: toFilterParam(filter) }
    })
  },

  getUserConversationDetail(conversationId: string | number, config?: AxiosRequestConfig) {
    return service.get<ConversationDetailResponse>(`/v1/messages/conversations/${conversationId}`, config)
  },

  createUserConversation(data: CreateConversationRequest, config?: AxiosRequestConfig) {
    return service.post<ConversationDetailResponse>('/v1/messages/conversations', data, {
      ...config,
      requiresPow: true
    } as AxiosRequestConfig)
  },

  replyUserConversation(conversationId: string | number, data: ReplyConversationRequest, config?: AxiosRequestConfig) {
    return service.post<ConversationMessageResponse>(`/v1/messages/conversations/${conversationId}/reply`, data, {
      ...config,
      requiresPow: true
    } as AxiosRequestConfig)
  },

  markConversationRead(conversationId: string | number, config?: AxiosRequestConfig) {
    return service.post<void>(`/v1/messages/conversations/${conversationId}/read`, {}, config)
  },

  adminGetConversations(page: number, size: number, filter: ConversationFilter = 'all', config?: AxiosRequestConfig) {
    return service.get<PageResponse<ConversationListItemResponse>>('/v1/admin/messages/conversations', {
      ...config,
      params: { page, size, filter: toFilterParam(filter) }
    })
  },

  adminGetConversationDetail(conversationId: string | number, config?: AxiosRequestConfig) {
    return service.get<ConversationDetailResponse>(`/v1/admin/messages/conversations/${conversationId}`, config)
  },

  adminReplyConversation(conversationId: string | number, data: ReplyConversationRequest, config?: AxiosRequestConfig) {
    return service.post<ConversationMessageResponse>(`/v1/admin/messages/conversations/${conversationId}/reply`, data, {
      ...config,
      requiresPow: true
    } as AxiosRequestConfig)
  },

  adminUpdateConversationStatus(conversationId: string | number, data: UpdateConversationStatusRequest, config?: AxiosRequestConfig) {
    return service.post<void>(`/v1/admin/messages/conversations/${conversationId}/status`, data, {
      ...config,
      requiresPow: true
    } as AxiosRequestConfig)
  },

  adminSendSystemMessage(data: SendSystemMessageRequest, config?: AxiosRequestConfig) {
    return service.post<ConversationDetailResponse>('/v1/admin/messages/system-send', data, {
      ...config,
      requiresPow: true
    } as AxiosRequestConfig)
  }
}

// 兼容别名，避免局部存量导入编译失败。
export type MessageItem = ConversationListItemResponse
