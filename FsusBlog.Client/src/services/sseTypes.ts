import type { AppErrorCode } from '@/utils/appError'
import type { ArticleListItemResponse } from '@/api/article'
import type {
  InboxConversationClosedPayload,
  InboxConversationUpsertPayload,
  InboxMessageAppendPayload,
  InboxReadUpdatedPayload
} from '@/api/message'

export interface NoticePayload {
  title: string
  unreadCount: number
  time: string
}

export interface UserStatusPayload {
  status: number
  reason: string | null
  time: string
}

export interface GlobalNoticePayload {
  id: string
  title: string
  time: string
}

export interface CommentAddedPayload {
  articleId: number
  comment: {
    id: string
    content: string
    createTime: string
    userName: string
    parentId?: string | null
    rootId?: string | null
    replyToUserId?: number | null
    replyToCommentId?: string | null
    depth?: number
    isDeleted?: boolean
  }
  time: string
}

export interface CommentRemovedPayload {
  articleId: number
  commentId: string
  rootId?: string | null
  parentId?: string | null
  time: string
}

export interface MessageRevokedPayload {
  messageId: string
  unreadCount?: number | null
  time?: string | null
}

export interface ArticleUpdatePayload {
  articleId: number
  action: 'Created' | 'Updated' | 'Deleted' | 'Restored'
  eventTime: string
  preview?: ArticleListItemResponse | null
}

export interface CacheControlPayload {
  type: 'shell.invalidate' | 'search-index.updated' | 'asset.clear'
  scope?: string | null
  cache?: string | null
  keys?: string[] | null
}

export interface SearchIndexUpdatePayload {
  version: string
  manifestUrl: string
  generatedAt: string
}

export interface PowParams {
  nonce: string
  salt: string
  fp: string
  signature: string
  difficulty: number
  timestamp: number
}

export enum SseEventType {
  NoticeReceived = 1,
  GlobalNoticePublished = 2,
  UnreadCountUpdated = 3,
  UserStatusChanged = 4,
  CommentAdded = 5,
  CommentRemoved = 6,
  MessageReceived = 7,
  ArticleChanged = 8,
  MessageRevoked = 9,
  CacheControl = 10,
  SearchIndexUpdated = 11,
  InboxConversationUpsert = 12,
  InboxMessageAppend = 13,
  InboxReadUpdated = 14,
  InboxConversationClosed = 15
}

export type SseFailureCode = 'auth_failed' | 'pow_failed' | 'protocol_mismatch' | 'network_error' | 'server_error'

export interface SseEventV2<TPayload = unknown> {
  id: number
  type: SseEventType
  ts: number
  payload: TPayload
}

export interface SseDeliveryCursor {
  lastEventId: number
  recentEventIds: number[]
}

export interface SseRuntimeState {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
  retryCount: number
  lastErrorCode: SseFailureCode | null
  lastAppErrorCode: AppErrorCode | null
  lastErrorAt: number | null
  lastProtocolErrorAt: number | null
  connectedAt: number | null
  disconnectedAt: number | null
  cursor: SseDeliveryCursor
  reconnectCount: number
  duplicateEventCount: number
  protocolErrorCount: number
  replayMissCount: number
  lastBatchSize: number
  lastRenderDurationMs: number
}

export type SseArticleRenderPatch = Readonly<{
  module: 'article'
  kind: 'changed' | 'reconnected'
  replayMissed?: boolean
  event?: SseEventV2<ArticleUpdatePayload>
}>

export type SseCommentRenderPatch = Readonly<{
  module: 'comment'
  kind: 'added' | 'removed'
  event: SseEventV2<CommentAddedPayload | CommentRemovedPayload>
}>

export type SseInboxRenderPatch = Readonly<{
  module: 'inbox'
  kind:
    | 'notice'
    | 'global-notice'
    | 'message-received'
    | 'message-revoked'
    | 'unread-count'
    | 'conversation-upsert'
    | 'message-append'
    | 'read-updated'
    | 'conversation-closed'
    | 'reconnected'
  eventId?: number
  ts?: number
  replayMissed?: boolean
  payload?:
    | NoticePayload
    | GlobalNoticePayload
    | MessageRevokedPayload
    | number
    | InboxConversationUpsertPayload
    | InboxMessageAppendPayload
    | InboxReadUpdatedPayload
    | InboxConversationClosedPayload
}>

export type SseRenderPatch = SseArticleRenderPatch | SseCommentRenderPatch | SseInboxRenderPatch
