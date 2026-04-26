import { defineStore } from 'pinia'
import { reactive, ref, shallowRef } from 'vue'
import { createSseRenderScheduler } from '@/services/sseRenderScheduler'
import { SseEventType, SseFailureCodes, type SseArticleRenderPatch, type SseCommentRenderPatch, type SseDeliveryCursor, type SseEventV2, type SseFailureCode, type SseInboxRenderPatch, type SseRenderPatch, type SseRuntimeState, type UserStatusPayload } from '@/services/sseTypes'
import { AppErrorCode } from '@/utils/appError'

function createInitialState(): SseRuntimeState {
  return {
    status: 'idle',
    retryCount: 0,
    lastErrorCode: null,
    lastAppErrorCode: null,
    lastErrorAt: null,
    lastProtocolErrorAt: null,
    connectedAt: null,
    disconnectedAt: null,
    cursor: {
      lastEventId: 0,
      recentEventIds: []
    },
    reconnectCount: 0,
    duplicateEventCount: 0,
    protocolErrorCount: 0,
    replayMissCount: 0,
    lastBatchSize: 0,
    lastRenderDurationMs: 0
  }
}

function sseFailureCodeToAppErrorCode(code: SseFailureCode): AppErrorCode {
  switch (code) {
    case SseFailureCodes.AuthFailed:
      return AppErrorCode.Unauthorized
    case SseFailureCodes.PowFailed:
      return AppErrorCode.Forbidden
    case SseFailureCodes.ProtocolMismatch:
      return AppErrorCode.ProtocolFailure
    case SseFailureCodes.NetworkError:
    case SseFailureCodes.ServerError:
    default:
      return AppErrorCode.InfraFailure
  }
}

export const useSseStore = defineStore('sse', () => {
  const runtime = reactive<SseRuntimeState>(createInitialState())
  const unreadCount = ref(0)
  const userStatus = shallowRef<UserStatusPayload | null>(null)
  const userStatusRevision = ref(0)

  const articleBatch = shallowRef<readonly SseArticleRenderPatch[]>([])
  const articleRevision = ref(0)

  const commentBatch = shallowRef<readonly SseCommentRenderPatch[]>([])
  const commentRevision = ref(0)

  const inboxBatch = shallowRef<readonly SseInboxRenderPatch[]>([])
  const inboxRevision = ref(0)

  const scheduler = createSseRenderScheduler({
    onFlush(module, patches, stats) {
      runtime.lastBatchSize = stats.batchSize
      runtime.lastRenderDurationMs = stats.durationMs

      if (module === 'article') {
        articleBatch.value = Object.freeze([...patches]) as readonly SseArticleRenderPatch[]
        articleRevision.value += 1
        return
      }

      if (module === 'comment') {
        commentBatch.value = Object.freeze([...patches]) as readonly SseCommentRenderPatch[]
        commentRevision.value += 1
        return
      }

      inboxBatch.value = Object.freeze([...patches]) as readonly SseInboxRenderPatch[]
      inboxRevision.value += 1
    }
  })

  const schedulePatch = (patch: SseRenderPatch): void => {
    scheduler.schedule(patch)
  }

  const syncCursor = (cursor: SseDeliveryCursor): void => {
    runtime.cursor = {
      lastEventId: cursor.lastEventId,
      recentEventIds: [...cursor.recentEventIds]
    }
  }

  const resetCursor = (): void => {
    runtime.cursor = {
      lastEventId: 0,
      recentEventIds: []
    }
  }

  const setStatus = (status: SseRuntimeState['status'], retryCount = runtime.retryCount): void => {
    runtime.status = status
    runtime.retryCount = retryCount

    if (status === 'connected') {
      runtime.connectedAt = Date.now()
      runtime.disconnectedAt = null
      runtime.lastErrorCode = null
      runtime.lastAppErrorCode = null
      return
    }

    if (status === 'reconnecting' || status === 'idle' || status === 'stopped') {
      runtime.disconnectedAt = Date.now()
    }
  }

  const recordDuplicateEvent = (): void => {
    runtime.duplicateEventCount += 1
  }

  const recordProtocolError = (): void => {
    runtime.protocolErrorCount += 1
    runtime.lastErrorCode = SseFailureCodes.ProtocolMismatch
    runtime.lastAppErrorCode = AppErrorCode.ProtocolFailure
    runtime.lastErrorAt = Date.now()
    runtime.lastProtocolErrorAt = runtime.lastErrorAt
  }

  const recordHandshakeFailure = (code: SseFailureCode): void => {
    runtime.lastErrorCode = code
    runtime.lastAppErrorCode = sseFailureCodeToAppErrorCode(code)
    runtime.lastErrorAt = Date.now()
    if (code === SseFailureCodes.ProtocolMismatch) {
      runtime.protocolErrorCount += 1
      runtime.lastProtocolErrorAt = runtime.lastErrorAt
    }
  }

  const recordReconnect = (replayMissed: boolean): void => {
    runtime.reconnectCount += 1
    if (replayMissed) {
      runtime.replayMissCount += 1
    }

    schedulePatch({
      module: 'article',
      kind: 'reconnected',
      replayMissed
    })
    schedulePatch({
      module: 'inbox',
      kind: 'reconnected',
      replayMissed
    })
  }

  const consumeEvent = (event: SseEventV2): void => {
    switch (event.type) {
      case SseEventType.NoticeReceived: {
        const payload = event.payload as SseEventV2['payload'] & { unreadCount?: number }
        unreadCount.value = Number(payload.unreadCount ?? unreadCount.value)
        schedulePatch({
          module: 'inbox',
          kind: 'notice',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }

      case SseEventType.GlobalNoticePublished:
        schedulePatch({
          module: 'inbox',
          kind: 'global-notice',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return

      case SseEventType.UnreadCountUpdated:
        unreadCount.value = Math.max(0, Number(event.payload ?? 0))
        schedulePatch({
          module: 'inbox',
          kind: 'unread-count',
          eventId: event.id,
          ts: event.ts,
          payload: unreadCount.value
        })
        return

      case SseEventType.UserStatusChanged:
        userStatus.value = event.payload as UserStatusPayload
        userStatusRevision.value += 1
        return

      case SseEventType.CommentAdded:
        schedulePatch({
          module: 'comment',
          kind: 'added',
          event: event as never
        })
        return

      case SseEventType.CommentRemoved:
        schedulePatch({
          module: 'comment',
          kind: 'removed',
          event: event as never
        })
        return

      case SseEventType.MessageReceived:
        schedulePatch({
          module: 'inbox',
          kind: 'message-received',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return

      case SseEventType.ArticleChanged:
        schedulePatch({
          module: 'article',
          kind: 'changed',
          event: event as never
        })
        return

      case SseEventType.MessageRevoked: {
        const payload = event.payload as { unreadCount?: number | null }
        if (payload.unreadCount !== undefined && payload.unreadCount !== null) {
          unreadCount.value = Math.max(0, Number(payload.unreadCount))
        }
        schedulePatch({
          module: 'inbox',
          kind: 'message-revoked',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }

      case SseEventType.InboxConversationUpsert: {
        const payload = event.payload as { totalUnread?: number | null }
        if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
          unreadCount.value = Math.max(0, Number(payload.totalUnread))
        }
        schedulePatch({
          module: 'inbox',
          kind: 'conversation-upsert',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }

      case SseEventType.InboxMessageAppend: {
        const payload = event.payload as { totalUnread?: number | null }
        if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
          unreadCount.value = Math.max(0, Number(payload.totalUnread))
        }
        schedulePatch({
          module: 'inbox',
          kind: 'message-append',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }

      case SseEventType.InboxReadUpdated: {
        const payload = event.payload as { totalUnread?: number | null }
        if (payload.totalUnread !== undefined && payload.totalUnread !== null) {
          unreadCount.value = Math.max(0, Number(payload.totalUnread))
        }
        schedulePatch({
          module: 'inbox',
          kind: 'read-updated',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }

      case SseEventType.InboxConversationClosed: {
        schedulePatch({
          module: 'inbox',
          kind: 'conversation-closed',
          eventId: event.id,
          ts: event.ts,
          payload: event.payload as never
        })
        return
      }
      }
    }

  const dispose = (): void => {
    scheduler.cancel()
  }

  return {
    runtime,
    unreadCount,
    userStatus,
    userStatusRevision,
    articleBatch,
    articleRevision,
    commentBatch,
    commentRevision,
    inboxBatch,
    inboxRevision,
    syncCursor,
    resetCursor,
    setStatus,
    recordDuplicateEvent,
    recordProtocolError,
    recordHandshakeFailure,
    recordReconnect,
    consumeEvent,
    dispose
  }
})
