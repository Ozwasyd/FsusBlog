using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Validation;

using SqlSugar;

namespace FsusBlog.Server.Services.NotificationStream;

public sealed partial class MessageCenterService(
    ISqlSugarClient db,
    MessageCacheService cache,
    IMessageNotificationStreamPort notificationStreamPort,
    IConfiguration configuration,
    ILogger<MessageCenterService> logger,
    TimeProvider timeProvider) : IMessageQueryService, IMessageCommandService, IMessageRealtimePublisher, IMessageAdminQueueMaintenance, IMessageMutationOutboxDelivery
{
    private const int ConversationDetailPageSize = 50;
    private DateTime UtcNow => timeProvider.GetUtcNow().UtcDateTime;

    private async Task<int> AdvanceAdminQueueReadAsync(long conversationId, long readThroughMessageId, DateTime now)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            VALUES (
                @ConversationId,
                @ReadThroughMessageId,
                (
                    SELECT COUNT(*)::integer
                    FROM msg_message message
                    WHERE message.conversationid = @ConversationId
                      AND message.id > @ReadThroughMessageId
                      AND message.sendertype = @AccountSenderType
                      AND message.isinternalnote = false
                ),
                @Now,
                1,
                @Now)
            ON CONFLICT (conversationid) DO UPDATE
            SET lastreadmessageid = GREATEST(
                    COALESCE(msg_admin_queue_state.lastreadmessageid, 0),
                    EXCLUDED.lastreadmessageid),
                unreadcount = (
                    SELECT COUNT(*)::integer
                    FROM msg_message message
                    WHERE message.conversationid = @ConversationId
                      AND message.id > GREATEST(
                          COALESCE(msg_admin_queue_state.lastreadmessageid, 0),
                          @ReadThroughMessageId)
                      AND message.sendertype = @AccountSenderType
                      AND message.isinternalnote = false
                ),
                lastreadat = @Now,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now
            RETURNING unreadcount;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@ReadThroughMessageId", readThroughMessageId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));
        return await reader.ReadAsync() ? reader.ReadInt32("unreadcount") : 0;
    }

    public async Task<AdminQueueConsistencyReport> CheckAdminQueueConsistencyAsync()
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH queue_consistency AS (
                SELECT conversation.id,
                       state.conversationid IS NULL AS missing_state,
                       state.lastreadmessageid IS NOT NULL
                           AND NOT EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) AS invalid_read_cursor,
                       COALESCE(state.unreadcount, 0) <> (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = conversation.id
                             AND message.id > COALESCE(state.lastreadmessageid, 0)
                             AND message.sendertype = @AccountSenderType
                             AND message.isinternalnote = false
                       ) AS unread_mismatch
                FROM msg_conversation conversation
                LEFT JOIN msg_admin_queue_state state
                  ON state.conversationid = conversation.id
            )
            SELECT COUNT(*)::integer AS conversation_count,
                   COUNT(*) FILTER (WHERE missing_state)::integer AS missing_state_count,
                   COUNT(*) FILTER (WHERE unread_mismatch)::integer AS unread_mismatch_count,
                   COUNT(*) FILTER (WHERE invalid_read_cursor)::integer AS invalid_read_cursor_count
            FROM queue_consistency;
            """,
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account));
        if (!await reader.ReadAsync())
        {
            return default;
        }

        return new AdminQueueConsistencyReport(
            reader.ReadInt32("conversation_count"),
            reader.ReadInt32("missing_state_count"),
            reader.ReadInt32("unread_mismatch_count"),
            reader.ReadInt32("invalid_read_cursor_count"));
    }

    private async Task<ReplyConversationLock?> LoadReplyConversationForUpdateAsync(long conversationId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   status
            FROM msg_conversation
            WHERE id = @ConversationId
            FOR UPDATE;
            """,
            new SugarParameter("@ConversationId", conversationId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new ReplyConversationLock(
            reader.ReadInt64("id"),
            (ConversationStatus)reader.ReadInt32("status"));
    }

    private async Task<ReplyParticipantLock?> LoadReplyParticipantForUpdateAsync(long conversationId, int accountId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT conversationid,
                   accountid,
                   lastreadmessageid
            FROM msg_participant_state
            WHERE conversationid = @ConversationId
              AND accountid = @AccountId
            FOR UPDATE;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new ReplyParticipantLock(
            reader.ReadInt64("conversationid"),
            reader.ReadInt32("accountid"),
            reader.IsNull("lastreadmessageid") ? null : reader.ReadInt64("lastreadmessageid"));
    }

    private async Task<ReadAdvanceResult> AdvanceParticipantReadThroughAsync(
        ReplyParticipantLock participant,
        long readThroughMessageId,
        DateTime now)
    {
        if (participant.LastReadMessageId > readThroughMessageId)
        {
            return new ReadAdvanceResult(ReadAdvanceOutcome.CursorRegression, 0);
        }

        int visibleTarget = await db.Queryable<ConversationMessage>()
            .Where(it =>
                it.ConversationId == participant.ConversationId &&
                it.Id == readThroughMessageId &&
                !it.IsInternalNote)
            .CountAsync();
        if (visibleTarget != 1)
        {
            return new ReadAdvanceResult(ReadAdvanceOutcome.TargetNotVisible, 0);
        }

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE msg_participant_state state
            SET lastreadmessageid = @ReadThroughMessageId,
                lastreadat = @Now,
                updatedat = @Now,
                unreadcount = (
                    SELECT COUNT(*)::integer
                    FROM msg_message message
                    WHERE message.conversationid = @ConversationId
                      AND message.id > @ReadThroughMessageId
                      AND message.isinternalnote = false
                      AND NOT (
                          message.sendertype = @AccountSenderType
                          AND message.senderaccountid = @AccountId
                      )
                )
            WHERE state.conversationid = @ConversationId
              AND state.accountid = @AccountId
            RETURNING state.unreadcount;
            """,
            new SugarParameter("@ConversationId", participant.ConversationId),
            new SugarParameter("@AccountId", participant.AccountId),
            new SugarParameter("@ReadThroughMessageId", readThroughMessageId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));
        if (!await reader.ReadAsync())
        {
            return new ReadAdvanceResult(ReadAdvanceOutcome.TargetNotVisible, 0);
        }

        return new ReadAdvanceResult(ReadAdvanceOutcome.Accepted, reader.ReadInt32("unreadcount"));
    }

    private async Task<ConversationStatusUpdateState?> LoadConversationStatusUpdateStateAsync(long conversationId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT status,
                   xmin::text AS row_version
            FROM msg_conversation
            WHERE id = @ConversationId;
            """,
            new SugarParameter("@ConversationId", conversationId));

        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new ConversationStatusUpdateState(
            (ConversationStatus)reader.ReadInt32("status"),
            reader.ReadString("row_version"));
    }

    private async Task<SystemMessageTargetLock?> LoadSystemMessageTargetForUpdateAsync(int accountId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id,
                   status,
                   deleted_at
            FROM sys_user
            WHERE id = @AccountId
            FOR UPDATE;
            """,
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        return new SystemMessageTargetLock(
            reader.ReadInt32("id"),
            reader.ReadInt32("status"),
            reader.IsNull("deleted_at") ? null : reader.ReadDateTime("deleted_at"));
    }

    private async Task<long> LoadConversationListSnapshotMessageIdAsync()
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(MAX(id), 0)::bigint AS snapshot_message_id FROM msg_message WHERE isinternalnote = false;");
        return await reader.ReadAsync() ? reader.ReadInt64("snapshot_message_id") : 0;
    }

    private Task LogNotificationFailureAsync(Result<ConversationDetailResponse> result, string operation, int accountId)
    {
        if (result.IsFailure)
        {
            logger.LogWarning(
                "Message notification failed. Operation: {Operation} | AccountId: {AccountId} | Code: {Code} | Message: {Message}",
                operation,
                accountId,
                result.Error.Code,
                result.Error.Message);
        }

        return Task.CompletedTask;
    }

    private sealed class AccountConversationRow
    {
        public long ConversationId
        {
            get; set;
        }
        public string Subject { get; set; } = string.Empty;
        public ConversationStatus Status
        {
            get; set;
        }
        public bool IsSystemSource
        {
            get; set;
        }
        public int UnreadCount
        {
            get; set;
        }
        public DateTime LastMessageAt
        {
            get; set;
        }
        public DateTime UpdatedAt
        {
            get; set;
        }
        public int CounterpartyAccountId
        {
            get; set;
        }
        public CounterpartyAccountStatusValue CounterpartyAccountStatus
        {
            get; set;
        } = CounterpartyAccountStatusValue.Missing;
    }

    private enum MessageViewer
    {
        Account,
        Admin
    }

    private enum MutationReplayState
    {
        None,
        Replay,
        Conflict
    }

    private sealed record SystemMessageTargetLock(int AccountId, int Status, DateTime? DeletedAt);

    private enum SystemMessageTargetValidation
    {
        Allowed,
        Missing,
        Deleted,
        Restricted,
        InvalidStatus,
        Disabled
    }

    private readonly record struct AdminCounterpartyProjection(
        int AccountId,
        CounterpartyAccountStatusValue Status);

    private sealed record ParticipantMessageFanoutPayload(
        ConversationParticipantState Participant,
        ConversationListItemResponse? Item,
        int TotalUnread);

    private sealed record ConversationMessagePage(
        List<ConversationMessageResponse> Messages,
        string? PreviousCursor,
        bool HasOlder);

    private sealed class AccountUnreadRow
    {
        public int AccountId
        {
            get; set;
        }
        public int UnreadCount
        {
            get; set;
        }
    }
}
