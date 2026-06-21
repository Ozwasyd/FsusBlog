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

export interface AccountStatusPayload {
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
    author: {
      mode: 'anonymous' | 'public' | 'zk_anonymous'
      displayName: string
      displayLanguage: 'zh-CN' | 'en'
      badge?: string | null
      scopeLabel?: string | null
      credentialLevel?: string | null
    }
    authorAccountId?: number | null
    parentId?: string | null
    rootId?: string | null
    replyToAuthor?: {
      mode: 'anonymous' | 'public' | 'zk_anonymous'
      displayName: string
      displayLanguage: 'zh-CN' | 'en'
      badge?: string | null
      scopeLabel?: string | null
      credentialLevel?: string | null
    } | null
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

export const NotificationStreamEventType = {
  NoticeReceived: 1,
  GlobalNoticePublished: 2,
  UnreadCountUpdated: 3,
  AccountStatusChanged: 4,
  CommentAdded: 5,
  CommentRemoved: 6,
  MessageReceived: 7,
  ArticleChanged: 8,
  MessageRevoked: 9,
  CacheControl: 10,
  SearchIndexUpdated: 11,
  InboxConversationUpsert: 12,
  InboxMessageAppend: 13,
  InboxReadUpdated: 14,
  InboxConversationClosed: 15
} as const

export type NotificationStreamEventType = (typeof NotificationStreamEventType)[keyof typeof NotificationStreamEventType]

export const NotificationStreamFailureCodes = {
  AuthFailed: 'auth_failed',
  PowFailed: 'pow_failed',
  ProtocolMismatch: 'protocol_mismatch',
  NetworkError: 'network_error',
  ServerError: 'server_error',
  AccountBlocked: 'account_blocked',
  AccountDeleted: 'account_deleted',
  WebSocketRequired: 'websocket_required',
  RiskChallengeRequired: 'risk_challenge_required',
  RiskChallengeRejected: 'risk_challenge_rejected',
  RiskChallengeKindMismatch: 'risk_challenge_kind_mismatch',
  RiskControlBlocked: 'risk_control_blocked',
  RiskControlThrottled: 'risk_control_throttled'
} as const

export type NotificationStreamFailureCode = typeof NotificationStreamFailureCodes[keyof typeof NotificationStreamFailureCodes]

export interface NotificationStreamEventV2<TPayload = unknown> {
  id: number
  type: NotificationStreamEventType
  ts: number
  payload: TPayload
}

export interface NotificationStreamCursor {
  lastEventId: number
  recentEventIds: number[]
}

export interface NotificationStreamRuntimeState {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped'
  retryCount: number
  lastErrorCode: NotificationStreamFailureCode | null
  lastAppErrorCode: AppErrorCode | null
  lastErrorAt: number | null
  lastProtocolErrorAt: number | null
  connectedAt: number | null
  disconnectedAt: number | null
  cursor: NotificationStreamCursor
  reconnectCount: number
  duplicateEventCount: number
  protocolErrorCount: number
  replayMissCount: number
  lastBatchSize: number
  lastRenderDurationMs: number
}

export type NotificationStreamArticleRenderPatch = Readonly<{
  module: 'article'
  kind: 'changed' | 'reconnected'
  replayMissed?: boolean
  event?: NotificationStreamEventV2<ArticleUpdatePayload>
}>

export type NotificationStreamCommentRenderPatch = Readonly<{
  module: 'comment'
  kind: 'added' | 'removed'
  event: NotificationStreamEventV2<CommentAddedPayload | CommentRemovedPayload>
}>

export type NotificationStreamInboxRenderPatch = Readonly<{
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

export type NotificationStreamRenderPatch = NotificationStreamArticleRenderPatch | NotificationStreamCommentRenderPatch | NotificationStreamInboxRenderPatch
