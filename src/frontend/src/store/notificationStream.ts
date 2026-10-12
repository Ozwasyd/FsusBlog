import { defineStore } from 'pinia';
import { reactive, ref, shallowRef } from 'vue';

import { createNotificationStreamRenderScheduler } from '@/services/notificationStreamRenderScheduler';
import { NotificationStreamEventType, NotificationStreamFailureCodes, type NotificationStreamArticleRenderPatch, type NotificationStreamCommentRenderPatch, type NotificationStreamCursor, type NotificationStreamEventV2, type NotificationStreamFailureCode, type NotificationStreamInboxRenderPatch, type NotificationStreamRenderPatch, type NotificationStreamRuntimeState, type AccountStatusPayload, type CacheControlPayload, type SessionRevokedPayload } from '@/services/notificationStreamTypes';
import { AppErrorCode } from '@/utils/appError';

function createInitialState(): NotificationStreamRuntimeState
{
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
    };
}

function notificationStreamFailureCodeToAppErrorCode(code: NotificationStreamFailureCode): AppErrorCode
{
    switch (code)
    {
        case NotificationStreamFailureCodes.AuthFailed:
            return AppErrorCode.Unauthorized;
        case NotificationStreamFailureCodes.PowFailed:
        case NotificationStreamFailureCodes.AccountBlocked:
        case NotificationStreamFailureCodes.RiskChallengeRequired:
        case NotificationStreamFailureCodes.RiskChallengeRejected:
        case NotificationStreamFailureCodes.RiskChallengeKindMismatch:
        case NotificationStreamFailureCodes.RiskControlBlocked:
            return AppErrorCode.Forbidden;
        case NotificationStreamFailureCodes.RiskControlThrottled:
            return AppErrorCode.RateLimited;
        case NotificationStreamFailureCodes.AccountDeleted:
            return AppErrorCode.Unauthorized;
        case NotificationStreamFailureCodes.ProtocolMismatch:
        case NotificationStreamFailureCodes.WebSocketRequired:
            return AppErrorCode.ProtocolFailure;
        case NotificationStreamFailureCodes.NetworkError:
        case NotificationStreamFailureCodes.ServerError:
        default:
            return AppErrorCode.InfraFailure;
    }
}

export const useNotificationStreamStore = defineStore('notification-stream', () =>
{
    const runtime = reactive<NotificationStreamRuntimeState>(createInitialState());
    const unreadCount = ref(0);
    const userStatus = shallowRef<AccountStatusPayload | null>(null);
    const userStatusRevision = ref(0);
    const sessionRevocation = shallowRef<SessionRevokedPayload | null>(null);
    const sessionRevocationRevision = ref(0);
    let sessionRevokedHandler: (() => void) | null = null;

    const articleBatch = shallowRef<readonly NotificationStreamArticleRenderPatch[]>([]);
    const articleRevision = ref(0);

    const commentBatch = shallowRef<readonly NotificationStreamCommentRenderPatch[]>([]);
    const commentRevision = ref(0);
    const commentPolicyRevision = ref(0);

    const inboxBatch = shallowRef<readonly NotificationStreamInboxRenderPatch[]>([]);
    const inboxRevision = ref(0);

    const scheduler = createNotificationStreamRenderScheduler({
        onFlush(module, patches, stats)
        {
            runtime.lastBatchSize = stats.batchSize;
            runtime.lastRenderDurationMs = stats.durationMs;

            if (module === 'article')
            {
                articleBatch.value = Object.freeze(patches) as readonly NotificationStreamArticleRenderPatch[];
                articleRevision.value += 1;
                return;
            }

            if (module === 'comment')
            {
                commentBatch.value = Object.freeze(patches) as readonly NotificationStreamCommentRenderPatch[];
                commentRevision.value += 1;
                return;
            }

            inboxBatch.value = Object.freeze(patches) as readonly NotificationStreamInboxRenderPatch[];
            inboxRevision.value += 1;
        }
    });

    const schedulePatch = (patch: NotificationStreamRenderPatch): void =>
    {
        scheduler.schedule(patch);
    };

    const syncCursor = (cursor: NotificationStreamCursor): void =>
    {
        runtime.cursor = {
            lastEventId: cursor.lastEventId,
            recentEventIds: [...cursor.recentEventIds]
        };
    };

    const resetCursor = (): void =>
    {
        runtime.cursor = {
            lastEventId: 0,
            recentEventIds: []
        };
    };

    const setStatus = (status: NotificationStreamRuntimeState['status'], retryCount = runtime.retryCount): void =>
    {
        runtime.status = status;
        runtime.retryCount = retryCount;

        if (status === 'connected')
        {
            runtime.connectedAt = Date.now();
            runtime.disconnectedAt = null;
            runtime.lastErrorCode = null;
            runtime.lastAppErrorCode = null;
            return;
        }

        if (status === 'reconnecting' || status === 'idle' || status === 'stopped')
        {
            runtime.disconnectedAt = Date.now();
        }
    };

    const recordDuplicateEvent = (): void =>
    {
        runtime.duplicateEventCount += 1;
    };

    const recordProtocolError = (): void =>
    {
        runtime.protocolErrorCount += 1;
        runtime.lastErrorCode = NotificationStreamFailureCodes.ProtocolMismatch;
        runtime.lastAppErrorCode = AppErrorCode.ProtocolFailure;
        runtime.lastErrorAt = Date.now();
        runtime.lastProtocolErrorAt = runtime.lastErrorAt;
    };

    const recordHandshakeFailure = (code: NotificationStreamFailureCode): void =>
    {
        runtime.lastErrorCode = code;
        runtime.lastAppErrorCode = notificationStreamFailureCodeToAppErrorCode(code);
        runtime.lastErrorAt = Date.now();
        if (code === NotificationStreamFailureCodes.ProtocolMismatch)
        {
            runtime.protocolErrorCount += 1;
            runtime.lastProtocolErrorAt = runtime.lastErrorAt;
        }
    };

    const recordReconnect = (replayMissed: boolean): void =>
    {
        runtime.reconnectCount += 1;
        if (replayMissed)
        {
            runtime.replayMissCount += 1;
        }

        schedulePatch({
            module: 'article',
            kind: 'reconnected',
            replayMissed
        });
        schedulePatch({
            module: 'inbox',
            kind: 'reconnected',
            replayMissed
        });
    };

    const consumeEvent = (event: NotificationStreamEventV2): void =>
    {
        switch (event.type)
        {
            case NotificationStreamEventType.NoticeReceived: {
                const payload = event.payload as { unreadCount?: number; };
                unreadCount.value = Number(payload.unreadCount ?? unreadCount.value);
                schedulePatch({
                    module: 'inbox',
                    kind: 'notice',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }

            case NotificationStreamEventType.GlobalNoticePublished:
                schedulePatch({
                    module: 'inbox',
                    kind: 'global-notice',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;

            case NotificationStreamEventType.UnreadCountUpdated:
                unreadCount.value = Math.max(0, Number(event.payload ?? 0));
                schedulePatch({
                    module: 'inbox',
                    kind: 'unread-count',
                    eventId: event.id,
                    ts: event.ts,
                    payload: unreadCount.value
                });
                return;

            case NotificationStreamEventType.AccountStatusChanged:
                userStatus.value = event.payload as AccountStatusPayload;
                userStatusRevision.value += 1;
                return;

            case NotificationStreamEventType.SessionRevoked:
                sessionRevocation.value = event.payload as SessionRevokedPayload;
                sessionRevocationRevision.value += 1;
                sessionRevokedHandler?.();
                return;

            case NotificationStreamEventType.CommentAdded:
                schedulePatch({
                    module: 'comment',
                    kind: 'added',
                    event: event as never
                });
                return;

            case NotificationStreamEventType.CommentRemoved:
                schedulePatch({
                    module: 'comment',
                    kind: 'removed',
                    event: event as never
                });
                return;

            case NotificationStreamEventType.CacheControl: {
                const payload = event.payload as CacheControlPayload;
                if (payload.type === 'comment-policy.updated')
                {
                    commentPolicyRevision.value += 1;
                }
                return;
            }

            case NotificationStreamEventType.MessageReceived:
                schedulePatch({
                    module: 'inbox',
                    kind: 'message-received',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;

            case NotificationStreamEventType.ArticleChanged:
                schedulePatch({
                    module: 'article',
                    kind: 'changed',
                    event: event as never
                });
                return;

            case NotificationStreamEventType.MessageRevoked: {
                const payload = event.payload as { unreadCount?: number | null; };
                if (payload.unreadCount !== undefined && payload.unreadCount !== null)
                {
                    unreadCount.value = Math.max(0, Number(payload.unreadCount));
                }
                schedulePatch({
                    module: 'inbox',
                    kind: 'message-revoked',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }

            case NotificationStreamEventType.InboxConversationUpsert: {
                const payload = event.payload as { totalUnread?: number | null; };
                if (payload.totalUnread !== undefined && payload.totalUnread !== null)
                {
                    unreadCount.value = Math.max(0, Number(payload.totalUnread));
                }
                schedulePatch({
                    module: 'inbox',
                    kind: 'conversation-upsert',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }

            case NotificationStreamEventType.InboxMessageAppend: {
                const payload = event.payload as { totalUnread?: number | null; };
                if (payload.totalUnread !== undefined && payload.totalUnread !== null)
                {
                    unreadCount.value = Math.max(0, Number(payload.totalUnread));
                }
                schedulePatch({
                    module: 'inbox',
                    kind: 'message-append',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }

            case NotificationStreamEventType.InboxReadUpdated: {
                const payload = event.payload as { totalUnread?: number | null; };
                if (payload.totalUnread !== undefined && payload.totalUnread !== null)
                {
                    unreadCount.value = Math.max(0, Number(payload.totalUnread));
                }
                schedulePatch({
                    module: 'inbox',
                    kind: 'read-updated',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }

            case NotificationStreamEventType.InboxConversationStatusChanged: {
                schedulePatch({
                    module: 'inbox',
                    kind: 'conversation-status-changed',
                    eventId: event.id,
                    ts: event.ts,
                    payload: event.payload as never
                });
                return;
            }
        }
    };

    const dispose = (): void =>
    {
        scheduler.cancel();
    };

    const setSessionRevokedHandler = (
        handler: (() => void) | null,
        ownsWrite?: () => boolean,
        expected?: () => void
    ): void =>
    {
        if ((ownsWrite && !ownsWrite()) || (expected && sessionRevokedHandler !== expected))
        {
            return;
        }
        sessionRevokedHandler = handler;
    };

    return {
        runtime,
        unreadCount,
        userStatus,
        userStatusRevision,
        sessionRevocation,
        sessionRevocationRevision,
        articleBatch,
        articleRevision,
        commentBatch,
        commentRevision,
        commentPolicyRevision,
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
        setSessionRevokedHandler,
        dispose
    };
});
