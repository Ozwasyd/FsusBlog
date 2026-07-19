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
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.NotificationStream;

public sealed class MessageCenterService(
    ISqlSugarClient db,
    MessageCacheService cache,
    IMessageNotificationStreamPort notificationStreamPort,
    IConfiguration configuration,
    ILogger<MessageCenterService> logger) : IMessageQueryService, IMessageCommandService, IMessageRealtimePublisher, IMessageAdminQueueMaintenance, IMessageMutationOutboxDelivery
{
    private const int MaxSubjectLength = 160;
    private const int MaxBodyLength = 4000;
    private const int ConversationDetailPageSize = 50;

    public async Task<PageResponse<ConversationListItemResponse>> GetAccountConversationsAsync(
        int accountId,
        int size,
        string? filter,
        MessageConversationCursor? cursor)
    {
        long startedAt = Stopwatch.GetTimestamp();
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
        long snapshotMessageId = cursor?.SnapshotMessageId ?? await LoadConversationListSnapshotMessageIdAsync();
        int total = await CountSnapshotConversationsAsync(accountId, filter, snapshotMessageId);
        List<AccountConversationRow> rows = await LoadSnapshotConversationRowsAsync(
            accountId,
            filter,
            snapshotMessageId,
            cursor,
            pageSize + 1);
        bool hasMore = rows.Count > pageSize;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        var items = await BuildConversationListAsync(rows, includeUnread: true, snapshotMessageId);
        string? nextCursor = hasMore && rows.Count > 0
            ? new MessageConversationCursor(snapshotMessageId, rows[^1].LastMessageAt, rows[^1].ConversationId).Encode()
            : null;
        FsusObservability.RecordMessageCenterList("account", FsusObservability.GetElapsed(startedAt));
        return new PageResponse<ConversationListItemResponse>
        {
            Items = items,
            Total = total,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    public async Task<ConversationDetailResponse?> GetAccountConversationDetailAsync(int accountId, long conversationId, long? beforeMessageId = null)
    {
        var participant = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.AccountId == accountId && it.ConversationId == conversationId)
            .FirstAsync();
        if (participant is null)
        {
            return null;
        }

        var conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return null;
        }

        var page = await LoadConversationMessagePageAsync(conversationId, beforeMessageId, MessageViewer.Account);
        if (page.Messages.Count == 0)
        {
            return null;
        }
        return new ConversationDetailResponse
        {
            ConversationId = conversation.Id.ToString(),
            ReadSnapshotMessageId = page.Messages[^1].MessageId,
            PreviousCursor = page.PreviousCursor,
            HasOlder = page.HasOlder,
            Subject = conversation.Subject,
            Status = ToStatusValue(conversation.Status),
            IsSystemSource = conversation.IsSystemSource,
            CanReply = conversation.Status != ConversationStatus.Closed,
            UnreadCount = participant.UnreadCount,
            LastMessageAt = conversation.LastMessageAt,
            Messages = page.Messages
        };
    }

    public async Task<PageResponse<AdminConversationListItemResponse>> GetAdminConversationsAsync(
        int size,
        string? filter,
        MessageConversationCursor? cursor)
    {
        long startedAt = Stopwatch.GetTimestamp();
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
        long snapshotMessageId = cursor?.SnapshotMessageId ?? await LoadConversationListSnapshotMessageIdAsync();
        int total = await CountSnapshotConversationsAsync(null, filter, snapshotMessageId);
        List<AccountConversationRow> rows = await LoadSnapshotConversationRowsAsync(
            null,
            filter,
            snapshotMessageId,
            cursor,
            pageSize + 1);
        bool hasMore = rows.Count > pageSize;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        var items = await BuildAdminConversationListAsync(rows, snapshotMessageId);
        string? nextCursor = hasMore && rows.Count > 0
            ? new MessageConversationCursor(snapshotMessageId, rows[^1].LastMessageAt, rows[^1].ConversationId).Encode()
            : null;
        FsusObservability.RecordMessageCenterList("admin", FsusObservability.GetElapsed(startedAt));
        return new PageResponse<AdminConversationListItemResponse>
        {
            Items = items,
            Total = total,
            NextCursor = nextCursor,
            HasMore = hasMore
        };
    }

    public async Task<AdminConversationDetailResponse?> GetAdminConversationDetailAsync(long conversationId, long? beforeMessageId = null)
    {
        var conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return null;
        }

        AdminCounterpartyProjection counterparty = await LoadAdminCounterpartyProjectionAsync(conversation);
        var page = await LoadConversationMessagePageAsync(conversationId, beforeMessageId, MessageViewer.Admin);
        if (page.Messages.Count == 0)
        {
            return null;
        }
        int unreadCount = beforeMessageId.HasValue
            ? await LoadAdminQueueUnreadCountAsync(conversationId)
            : await AdvanceAdminQueueReadAsync(conversationId, long.Parse(page.Messages[^1].MessageId, CultureInfo.InvariantCulture), DateTime.UtcNow);
        return new AdminConversationDetailResponse
        {
            ConversationId = conversation.Id.ToString(),
            ReadSnapshotMessageId = page.Messages[^1].MessageId,
            PreviousCursor = page.PreviousCursor,
            HasOlder = page.HasOlder,
            Subject = conversation.Subject,
            Status = ToStatusValue(conversation.Status),
            IsSystemSource = conversation.IsSystemSource,
            CanReply = conversation.Status != ConversationStatus.Closed,
            UnreadCount = unreadCount,
            LastMessageAt = conversation.LastMessageAt,
            Messages = page.Messages,
            CounterpartyAccountId = counterparty.AccountId.ToString(CultureInfo.InvariantCulture),
            CounterpartyAccountStatus = counterparty.Status
        };
    }

    private async Task<int> LoadAdminQueueUnreadCountAsync(long conversationId)
    {
        var state = await db.Queryable<AdminConversationQueueState>().InSingleAsync(conversationId);
        return state?.UnreadCount ?? 0;
    }

    private async Task<AdminCounterpartyProjection> LoadAdminCounterpartyProjectionAsync(MessageConversation conversation)
    {
        if (!conversation.InitiatorAccountId.HasValue || conversation.InitiatorAccountId.Value <= 0)
        {
            return new AdminCounterpartyProjection(0, CounterpartyAccountStatusValue.Missing);
        }

        int accountId = conversation.InitiatorAccountId.Value;
        User? account = await db.Queryable<User>().InSingleAsync(accountId);
        return new AdminCounterpartyProjection(
            accountId,
            account is null ? CounterpartyAccountStatusValue.Missing : ToCounterpartyAccountStatus(account.Status));
    }

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

    private Task<int> IncrementAdminQueueUnreadAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT @ConversationId,
                   NULL,
                   COUNT(*)::integer,
                   NULL,
                   1,
                   @Now
            FROM msg_message message
            WHERE message.conversationid = @ConversationId
              AND message.sendertype = @AccountSenderType
              AND message.isinternalnote = false
            ON CONFLICT (conversationid) DO UPDATE
            SET unreadcount = msg_admin_queue_state.unreadcount + 1,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));

    private Task<int> EnsureAdminQueueStateAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT @ConversationId,
                   NULL,
                   COUNT(*) FILTER (
                       WHERE message.sendertype = @AccountSenderType
                         AND message.isinternalnote = false)::integer,
                   NULL,
                   1,
                   @Now
            FROM msg_message message
            WHERE message.conversationid = @ConversationId
            ON CONFLICT (conversationid) DO NOTHING;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));

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

    public async Task<int> RebuildAdminQueueStateAsync()
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT conversation.id AS conversationid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_conversation conversation
                LEFT JOIN msg_admin_queue_state state
                  ON state.conversationid = conversation.id
            ), rebuilt AS (
                SELECT resolved.conversationid,
                       resolved.lastreadmessageid,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.sendertype = @AccountSenderType
                             AND message.isinternalnote = false
                       ) AS unreadcount,
                       resolved.lastreadat
                FROM resolved
            )
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT rebuilt.conversationid,
                   rebuilt.lastreadmessageid,
                   rebuilt.unreadcount,
                   rebuilt.lastreadat,
                   1,
                   @Now
            FROM rebuilt
            ON CONFLICT (conversationid) DO UPDATE
            SET lastreadmessageid = EXCLUDED.lastreadmessageid,
                unreadcount = EXCLUDED.unreadcount,
                lastreadat = EXCLUDED.lastreadat,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now
            WHERE msg_admin_queue_state.lastreadmessageid IS DISTINCT FROM EXCLUDED.lastreadmessageid
               OR msg_admin_queue_state.unreadcount IS DISTINCT FROM EXCLUDED.unreadcount
               OR msg_admin_queue_state.lastreadat IS DISTINCT FROM EXCLUDED.lastreadat;
            """,
                new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
                new SugarParameter("@Now", DateTime.UtcNow));
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(transaction.ErrorException, "Admin message unread projection rebuild failed.");
            return 0;
        }

        logger.LogInformation("Message unread projection repaired. Scope: admin-all | ChangedRows: {ChangedRows}", changed);
        return changed;
    }

    public async Task<int> RebuildAdminQueueConversationAsync(long conversationId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await RebuildAdminQueueConversationCoreAsync(conversationId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Admin conversation unread projection rebuild failed. ConversationId: {ConversationId}",
                conversationId);
            return 0;
        }

        logger.LogInformation(
            "Message unread projection repaired. Scope: admin-conversation | ConversationId: {ConversationId} | ChangedRows: {ChangedRows}",
            conversationId,
            changed);
        return changed;
    }

    public async Task<int> RebuildConversationUnreadAsync(long conversationId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int participantChanged = 0;
        int adminChanged = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            participantChanged = await RebuildConversationParticipantUnreadCoreAsync(conversationId);
            adminChanged = await RebuildAdminQueueConversationCoreAsync(conversationId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Conversation unread projection rebuild failed. ConversationId: {ConversationId}",
                conversationId);
            return 0;
        }

        List<int> accountIds = await db.Queryable<ConversationParticipantState>()
            .Where(state => state.ConversationId == conversationId)
            .Select(state => state.AccountId)
            .ToListAsync();
        foreach (int accountId in accountIds.Distinct())
        {
            await RecoverAccountUnreadCacheAsync(accountId);
        }

        int changed = participantChanged + adminChanged;
        logger.LogInformation(
            "Message unread projection repaired. Scope: conversation | ConversationId: {ConversationId} | ParticipantRows: {ParticipantRows} | AdminRows: {AdminRows}",
            conversationId,
            participantChanged,
            adminChanged);
        return changed;
    }

    public async Task<int> RebuildAccountUnreadAsync(int accountId)
    {
        if (!IsUnreadRepairEnabled())
        {
            return 0;
        }

        int changed = 0;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await EnableUnreadRepairTransactionAsync();
            changed = await RebuildAccountParticipantUnreadCoreAsync(accountId);
        });
        if (!transaction.IsSuccess)
        {
            logger.LogError(
                transaction.ErrorException,
                "Account unread projection rebuild failed. AccountId: {AccountId}",
                accountId);
            return 0;
        }

        await RecoverAccountUnreadCacheAsync(accountId);
        logger.LogInformation(
            "Message unread projection repaired. Scope: account | AccountId: {AccountId} | ChangedRows: {ChangedRows}",
            accountId,
            changed);
        return changed;
    }

    private bool IsUnreadRepairEnabled()
        => configuration.GetValue<bool?>("Messages:UnreadRepairEnabled") ?? true;

    private Task EnableUnreadRepairTransactionAsync()
        => db.Ado.ExecuteCommandAsync("SELECT set_config('fsus.message_unread_repair', 'on', true);");

    private Task<int> RebuildConversationParticipantUnreadCoreAsync(long conversationId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT state.conversationid,
                       state.accountid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_participant_state state
                WHERE state.conversationid = @ConversationId
            ), rebuilt AS (
                SELECT resolved.*,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.isinternalnote = false
                             AND NOT (
                                 message.sendertype = @AccountSenderType
                                 AND message.senderaccountid = resolved.accountid
                             )
                       ) AS unreadcount
                FROM resolved
            )
            UPDATE msg_participant_state state
            SET lastreadmessageid = rebuilt.lastreadmessageid,
                unreadcount = rebuilt.unreadcount,
                lastreadat = rebuilt.lastreadat,
                updatedat = @Now
            FROM rebuilt
            WHERE state.conversationid = rebuilt.conversationid
              AND state.accountid = rebuilt.accountid
              AND (
                  state.lastreadmessageid IS DISTINCT FROM rebuilt.lastreadmessageid
                  OR state.unreadcount IS DISTINCT FROM rebuilt.unreadcount
                  OR state.lastreadat IS DISTINCT FROM rebuilt.lastreadat
              );
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", DateTime.UtcNow));

    private Task<int> RebuildAccountParticipantUnreadCoreAsync(int accountId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT state.conversationid,
                       state.accountid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = state.conversationid
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_participant_state state
                WHERE state.accountid = @AccountId
            ), rebuilt AS (
                SELECT resolved.*,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.isinternalnote = false
                             AND NOT (
                                 message.sendertype = @AccountSenderType
                                 AND message.senderaccountid = resolved.accountid
                             )
                       ) AS unreadcount
                FROM resolved
            )
            UPDATE msg_participant_state state
            SET lastreadmessageid = rebuilt.lastreadmessageid,
                unreadcount = rebuilt.unreadcount,
                lastreadat = rebuilt.lastreadat,
                updatedat = @Now
            FROM rebuilt
            WHERE state.conversationid = rebuilt.conversationid
              AND state.accountid = rebuilt.accountid
              AND (
                  state.lastreadmessageid IS DISTINCT FROM rebuilt.lastreadmessageid
                  OR state.unreadcount IS DISTINCT FROM rebuilt.unreadcount
                  OR state.lastreadat IS DISTINCT FROM rebuilt.lastreadat
              );
            """,
            new SugarParameter("@AccountId", accountId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", DateTime.UtcNow));

    private Task<int> RebuildAdminQueueConversationCoreAsync(long conversationId)
        => db.Ado.ExecuteCommandAsync(
            """
            WITH resolved AS (
                SELECT conversation.id AS conversationid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadmessageid
                           ELSE NULL
                       END AS lastreadmessageid,
                       CASE
                           WHEN state.lastreadmessageid IS NULL THEN NULL
                           WHEN EXISTS (
                               SELECT 1
                               FROM msg_message read_target
                               WHERE read_target.conversationid = conversation.id
                                 AND read_target.id = state.lastreadmessageid
                                 AND read_target.isinternalnote = false
                           ) THEN state.lastreadat
                           ELSE NULL
                       END AS lastreadat
                FROM msg_conversation conversation
                LEFT JOIN msg_admin_queue_state state
                  ON state.conversationid = conversation.id
                WHERE conversation.id = @ConversationId
            ), rebuilt AS (
                SELECT resolved.conversationid,
                       resolved.lastreadmessageid,
                       (
                           SELECT COUNT(*)::integer
                           FROM msg_message message
                           WHERE message.conversationid = resolved.conversationid
                             AND message.id > COALESCE(resolved.lastreadmessageid, 0)
                             AND message.sendertype = @AccountSenderType
                             AND message.isinternalnote = false
                       ) AS unreadcount,
                       resolved.lastreadat
                FROM resolved
            )
            INSERT INTO msg_admin_queue_state(
                conversationid,
                lastreadmessageid,
                unreadcount,
                lastreadat,
                version,
                updatedat)
            SELECT rebuilt.conversationid,
                   rebuilt.lastreadmessageid,
                   rebuilt.unreadcount,
                   rebuilt.lastreadat,
                   1,
                   @Now
            FROM rebuilt
            ON CONFLICT (conversationid) DO UPDATE
            SET lastreadmessageid = EXCLUDED.lastreadmessageid,
                unreadcount = EXCLUDED.unreadcount,
                lastreadat = EXCLUDED.lastreadat,
                version = msg_admin_queue_state.version + 1,
                updatedat = @Now
            WHERE msg_admin_queue_state.lastreadmessageid IS DISTINCT FROM EXCLUDED.lastreadmessageid
               OR msg_admin_queue_state.unreadcount IS DISTINCT FROM EXCLUDED.unreadcount
               OR msg_admin_queue_state.lastreadat IS DISTINCT FROM EXCLUDED.lastreadat;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", DateTime.UtcNow));

    private async Task RecoverAccountUnreadCacheAsync(int accountId)
    {
        try
        {
            await RefreshUnreadCacheAsync(accountId);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Message unread cache recovery failed. AccountId: {AccountId}",
                accountId);
        }
    }

    public Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(int accountId, string subject, string body)
        => CreateAccountTicketAsync(
            accountId,
            subject,
            body,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(
        int accountId,
        string subject,
        string body,
        string clientMutationId)
    {
        var normalizedSubject = NormalizeSubject(subject, "用户申诉");
        var normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        long conversationId = 0;
        long messageId = 0;
        MutationReplayState replayState = MutationReplayState.None;
        string requestHash = ComputeMutationRequestHash("create", normalizedSubject, normalizedBody);
        DateTime now = DateTime.UtcNow;

        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(MessageMutationPrincipalKinds.Account, accountId, mutationId);
            MessageConversation? existing = await FindConversationMutationAsync(
                MessageMutationPrincipalKinds.Account,
                accountId,
                mutationId);
            if (existing is not null)
            {
                conversationId = existing.Id;
                replayState = string.Equals(existing.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? MutationReplayState.Replay
                    : MutationReplayState.Conflict;
                return;
            }
            if (await FindMessageMutationAsync(MessageMutationPrincipalKinds.Account, accountId, mutationId) is not null)
            {
                replayState = MutationReplayState.Conflict;
                return;
            }

            var conversation = new MessageConversation
            {
                Id = SnowFlakeSingle.Instance.NextId(),
                Subject = normalizedSubject,
                InitiatorAccountId = accountId,
                Status = ConversationStatus.Open,
                IsSystemSource = false,
                CreatedByType = MessageSenderType.Account,
                CreatedByAccountId = accountId,
                ClientMutationPrincipalKind = MessageMutationPrincipalKinds.Account,
                ClientMutationPrincipalId = accountId,
                ClientMutationId = mutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now,
                UpdatedAt = now,
                LastMessageAt = now
            };
            conversationId = conversation.Id;
            messageId = SnowFlakeSingle.Instance.NextId();
            var firstMessage = new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = accountId,
                Body = normalizedBody,
                ClientMutationPrincipalKind = MessageMutationPrincipalKinds.Account,
                ClientMutationPrincipalId = accountId,
                ClientMutationId = mutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now
            };
            var participant = new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = accountId,
                LastReadMessageId = messageId,
                UnreadCount = 0,
                LastReadAt = now,
                UpdatedAt = now
            };

            await db.Insertable(conversation).ExecuteCommandAsync();
            await db.Insertable(firstMessage).ExecuteCommandAsync();
            await db.Insertable(participant).ExecuteCommandAsync();
            await db.Insertable(new AdminConversationQueueState
            {
                ConversationId = conversationId,
                UnreadCount = 1,
                Version = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await EnqueueMessageDeliveriesAsync(
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Account, accountId, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.MessageAppend, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null));
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-create-account-ticket"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "创建会话失败");
        }
        if (replayState == MutationReplayState.Conflict)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Conflict, "client_mutation_content_conflict");
        }

        var detail = await GetAccountConversationDetailAsync(accountId, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "会话创建后读取失败");
        }

        return Result<ConversationDetailResponse>.Success(detail with
        {
            IdempotencyReplay = replayState == MutationReplayState.Replay
        });
    }

    public Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(
        int accountId,
        long conversationId,
        long readThroughMessageId,
        string body)
        => ReplyAsAccountAsync(
            accountId,
            conversationId,
            readThroughMessageId,
            body,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(
        int accountId,
        long conversationId,
        long readThroughMessageId,
        string body,
        string clientMutationId)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Account,
            accountId,
            null,
            null,
            readThroughMessageId,
            MessageMutationPrincipalKinds.Account,
            accountId,
            mutationId));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Account);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        FsusObservability.RecordMessageCenterReply("account", FsusObservability.GetElapsed(startedAt));
        return Result<ConversationMessageResponse>.Success(message with
        {
            IdempotencyReplay = writeOutcome.IdempotencyReplay
        });
    }

    private async Task<ReplyWriteOutcome> WriteReplyAsync(ReplyWriteCommand command)
    {
        DateTime now = DateTime.UtcNow;
        long messageId = SnowFlakeSingle.Instance.NextId();
        string requestHash = ComputeMutationRequestHash(
            "reply",
            command.ConversationId.ToString(CultureInfo.InvariantCulture),
            command.ReadThroughMessageId?.ToString(CultureInfo.InvariantCulture) ?? "0",
            command.Body);
        ReplyWriteOutcome outcome = ReplyWriteOutcome.NotFound;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync(command.MutationPrincipalKind, command.MutationPrincipalId, command.ClientMutationId);
            ConversationMessage? existingMutation = await FindMessageMutationAsync(
                command.MutationPrincipalKind,
                command.MutationPrincipalId,
                command.ClientMutationId);
            if (existingMutation is not null)
            {
                outcome = string.Equals(existingMutation.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? ReplyWriteOutcome.Replayed(new ReplyDeliveryEvent(
                        existingMutation.ConversationId,
                        existingMutation.Id,
                        existingMutation.SenderType,
                        existingMutation.CreatedAt))
                    : ReplyWriteOutcome.IdempotencyConflict;
                return;
            }
            if (await FindConversationMutationAsync(
                    command.MutationPrincipalKind,
                    command.MutationPrincipalId,
                    command.ClientMutationId) is not null)
            {
                outcome = ReplyWriteOutcome.IdempotencyConflict;
                return;
            }

            ReplyConversationLock? conversation = await LoadReplyConversationForUpdateAsync(command.ConversationId);
            if (conversation is null)
            {
                outcome = ReplyWriteOutcome.NotFound;
                return;
            }

            if (conversation.Status == ConversationStatus.Closed)
            {
                outcome = ReplyWriteOutcome.Closed;
                return;
            }

            int unreadCount = 0;
            if (command.SenderType == MessageSenderType.Account)
            {
                ReplyParticipantLock? participant = await LoadReplyParticipantForUpdateAsync(
                    command.ConversationId,
                    command.SenderAccountId!.Value);
                if (participant is null)
                {
                    outcome = ReplyWriteOutcome.Forbidden;
                    return;
                }

                ReadAdvanceResult readAdvance = await AdvanceParticipantReadThroughAsync(
                    participant,
                    command.ReadThroughMessageId!.Value,
                    now);
                if (readAdvance.Outcome != ReadAdvanceOutcome.Accepted)
                {
                    outcome = readAdvance.Outcome == ReadAdvanceOutcome.CursorRegression
                        ? ReplyWriteOutcome.CursorRegression
                        : ReplyWriteOutcome.ReadTargetNotVisible;
                    return;
                }

                unreadCount = readAdvance.UnreadCount;
            }

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = command.ConversationId,
                SenderType = command.SenderType,
                SenderAccountId = command.SenderAccountId,
                SenderAdminPrincipalId = command.SenderAdminPrincipalId,
                SenderAdminSessionId = command.SenderAdminSessionId,
                Body = command.Body,
                ClientMutationPrincipalKind = command.MutationPrincipalKind,
                ClientMutationPrincipalId = command.MutationPrincipalId,
                ClientMutationId = command.ClientMutationId,
                MutationRequestHash = requestHash,
                CreatedAt = now
            }).ExecuteCommandAsync();

            int conversationUpdated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_conversation
                SET updatedat = @Now,
                    lastmessageat = @Now
                WHERE id = @ConversationId
                  AND status = @ExpectedStatus;
                """,
                new SugarParameter("@ConversationId", command.ConversationId),
                new SugarParameter("@ExpectedStatus", (int)conversation.Status),
                new SugarParameter("@Now", now));
            if (conversationUpdated != 1)
            {
                throw new ReplyWriteConflictException();
            }

            if (command.SenderType == MessageSenderType.Account)
            {
                await IncrementAdminQueueUnreadAsync(command.ConversationId, now);
            }
            else
            {
                await EnsureAdminQueueStateAsync(command.ConversationId, now);
                await RefreshParticipantsUnreadAfterAdminReplyAsync(command.ConversationId, now);
            }

            await EnqueueReplyDeliveriesAsync(command, messageId);

            outcome = ReplyWriteOutcome.Succeeded(
                unreadCount,
                new ReplyDeliveryEvent(command.ConversationId, messageId, command.SenderType, now));
        });

        if (transaction.IsSuccess)
        {
            return outcome;
        }

        if (transaction.ErrorException is ReplyWriteConflictException)
        {
            return ReplyWriteOutcome.Conflict;
        }

        logger.LogError(
            transaction.ErrorException,
            "Message reply transaction failed. ConversationId: {ConversationId} | SenderType: {SenderType}",
            command.ConversationId,
            command.SenderType);
        return ReplyWriteOutcome.InfraFailure;
    }

    private Task<int> RefreshParticipantsUnreadAfterAdminReplyAsync(long conversationId, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_participant_state state
            SET unreadcount = (
                    SELECT COUNT(*)::integer
                    FROM msg_message message
                    WHERE message.conversationid = state.conversationid
                      AND message.id > COALESCE(state.lastreadmessageid, 0)
                      AND message.isinternalnote = false
                      AND NOT (
                          message.sendertype = @AccountSenderType
                          AND message.senderaccountid = state.accountid
                      )
                ),
                updatedat = @Now
            WHERE state.conversationid = @ConversationId;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountSenderType", (int)MessageSenderType.Account),
            new SugarParameter("@Now", now));

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

    private static Result<ConversationMessageResponse> MapReplyWriteOutcome(ReplyWriteOutcome outcome)
        => outcome.Status switch
        {
            ReplyWriteStatus.Forbidden => Result<ConversationMessageResponse>.Failure(ErrorCode.Forbidden, "无权访问该会话"),
            ReplyWriteStatus.Closed => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话已关闭"),
            ReplyWriteStatus.Conflict => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话状态冲突"),
            ReplyWriteStatus.IdempotencyConflict => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "client_mutation_content_conflict"),
            ReplyWriteStatus.CursorRegression => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "已读位置不能后退"),
            ReplyWriteStatus.ReadTargetNotVisible => Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "已读位置不属于可见会话消息"),
            ReplyWriteStatus.InfraFailure => Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败"),
            _ => Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "会话不存在")
        };

    private enum ReadAdvanceOutcome
    {
        NotFound,
        Forbidden,
        Closed,
        TargetNotVisible,
        CursorRegression,
        Accepted
    }

    private readonly record struct ReadAdvanceResult(ReadAdvanceOutcome Outcome, int UnreadCount);

    private enum ReplyWriteStatus
    {
        NotFound,
        Forbidden,
        Closed,
        Conflict,
        IdempotencyConflict,
        CursorRegression,
        ReadTargetNotVisible,
        InfraFailure,
        Succeeded
    }

    private readonly record struct ReplyWriteCommand(
        long ConversationId,
        string Body,
        MessageSenderType SenderType,
        int? SenderAccountId,
        long? SenderAdminPrincipalId,
        string? SenderAdminSessionId,
        long? ReadThroughMessageId,
        string MutationPrincipalKind,
        long MutationPrincipalId,
        string ClientMutationId);

    private readonly record struct ReplyDeliveryEvent(
        long ConversationId,
        long MessageId,
        MessageSenderType SenderType,
        DateTime CreatedAt);

    private readonly record struct ReplyWriteOutcome(
        ReplyWriteStatus Status,
        int UnreadCount,
        ReplyDeliveryEvent DeliveryEvent,
        bool IdempotencyReplay)
    {
        public static ReplyWriteOutcome NotFound => new(ReplyWriteStatus.NotFound, 0, default, false);
        public static ReplyWriteOutcome Forbidden => new(ReplyWriteStatus.Forbidden, 0, default, false);
        public static ReplyWriteOutcome Closed => new(ReplyWriteStatus.Closed, 0, default, false);
        public static ReplyWriteOutcome Conflict => new(ReplyWriteStatus.Conflict, 0, default, false);
        public static ReplyWriteOutcome IdempotencyConflict => new(ReplyWriteStatus.IdempotencyConflict, 0, default, false);
        public static ReplyWriteOutcome CursorRegression => new(ReplyWriteStatus.CursorRegression, 0, default, false);
        public static ReplyWriteOutcome ReadTargetNotVisible => new(ReplyWriteStatus.ReadTargetNotVisible, 0, default, false);
        public static ReplyWriteOutcome InfraFailure => new(ReplyWriteStatus.InfraFailure, 0, default, false);
        public static ReplyWriteOutcome Succeeded(int unreadCount, ReplyDeliveryEvent deliveryEvent)
            => new(ReplyWriteStatus.Succeeded, unreadCount, deliveryEvent, false);
        public static ReplyWriteOutcome Replayed(ReplyDeliveryEvent deliveryEvent)
            => new(ReplyWriteStatus.Succeeded, 0, deliveryEvent, true);
    }

    private sealed class ReplyWriteConflictException : Exception
    {
    }

    private sealed record ReplyConversationLock(long Id, ConversationStatus Status);

    private sealed record ReplyParticipantLock(long ConversationId, int AccountId, long? LastReadMessageId);

    public async Task<Result> MarkConversationReadAsync(int accountId, long conversationId, long readThroughMessageId)
    {
        DateTime now = DateTime.UtcNow;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ReplyParticipantLock? participant = await LoadReplyParticipantForUpdateAsync(conversationId, accountId);
            if (participant is null)
            {
                return new MarkConversationReadResult(ReadAdvanceOutcome.NotFound, null, 0);
            }

            ReadAdvanceResult advanced = await AdvanceParticipantReadThroughAsync(participant, readThroughMessageId, now);
            if (advanced.Outcome == ReadAdvanceOutcome.Accepted)
            {
                await EnqueueMessageDeliveriesAsync(CreateDelivery(
                    readThroughMessageId,
                    MessageMutationOutboxEventKinds.ReadUpdated,
                    MessageMutationOutboxAudiences.Account,
                    accountId,
                    conversationId,
                    null,
                    readThroughMessageId));
            }
            return new MarkConversationReadResult(advanced.Outcome, readThroughMessageId, advanced.UnreadCount);
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(transaction, logger, "message-center-mark-read"))
        {
            return Result.Failure(ErrorCode.InfraFailure, "标记已读失败");
        }

        MarkConversationReadResult readResult = transaction.Data;
        if (readResult.Outcome == ReadAdvanceOutcome.NotFound)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
        }
        if (readResult.Outcome == ReadAdvanceOutcome.TargetNotVisible)
        {
            return Result.Failure(ErrorCode.NotFound, "已读位置不属于可见会话消息");
        }
        if (readResult.Outcome == ReadAdvanceOutcome.CursorRegression)
        {
            return Result.Failure(ErrorCode.Conflict, "已读位置不能后退");
        }

        return Result.Success();
    }

    private sealed record MarkConversationReadResult(ReadAdvanceOutcome Outcome, long? LastMessageId, int UnreadCount);

    public Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(
        long conversationId,
        string body,
        AdminMessageActor adminActor)
        => ReplyAsAdminAsync(
            conversationId,
            body,
            adminActor,
            SnowFlakeSingle.Instance.NextId().ToString(CultureInfo.InvariantCulture));

    public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(
        long conversationId,
        string body,
        AdminMessageActor adminActor,
        string clientMutationId)
    {
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }
        if (!TryNormalizeClientMutationId(clientMutationId, out string mutationId))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "client_mutation_id_invalid");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Admin,
            null,
            adminActor.AdminPrincipalId,
            adminActor.AdminSessionId,
            null,
            MessageMutationPrincipalKinds.Admin,
            adminActor.AdminPrincipalId,
            mutationId));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Admin);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        return Result<ConversationMessageResponse>.Success(message with
        {
            IdempotencyReplay = writeOutcome.IdempotencyReplay
        });
    }

    public async Task<Result<ConversationStatusMutationResultResponse>> UpdateConversationStatusAsync(
        long conversationId,
        ConversationStatusValue status,
        string reason,
        AdminMessageActor adminActor)
    {
        if (!adminActor.HasAdminPrincipal || string.IsNullOrWhiteSpace(adminActor.AdminSessionId))
        {
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Unauthorized, "admin_session_missing");
        }
        string normalizedReason = reason.Trim();
        if (normalizedReason.Length is < 1 or > 256)
        {
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Validation, "conversation_status_reason_invalid");
        }

        DateTime now = DateTime.UtcNow;
        ConversationStatusWriteOutcome outcome = ConversationStatusWriteOutcome.NotFound;
        ConversationStatus previousStatus = default;
        ConversationStatus currentStatus = default;
        ConversationStatus targetStatus = ToStatusEntity(status);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            ConversationStatusUpdateState? currentState = await LoadConversationStatusUpdateStateAsync(conversationId);
            if (currentState is null)
            {
                return;
            }
            previousStatus = currentState.Status;
            currentStatus = currentState.Status;

            if (currentState.Status == targetStatus)
            {
                outcome = ConversationStatusWriteOutcome.NoChange;
                return;
            }
            if (!IsAllowedStatusTransition(currentState.Status, targetStatus))
            {
                outcome = ConversationStatusWriteOutcome.InvalidTransition;
                return;
            }

            int affected = await TryUpdateConversationStatusAsync(conversationId, status, currentState, now);
            if (affected <= 0)
            {
                ConversationStatusUpdateState? concurrentState = await LoadConversationStatusUpdateStateAsync(conversationId);
                if (concurrentState is null)
                {
                    outcome = ConversationStatusWriteOutcome.NotFound;
                    return;
                }
                previousStatus = concurrentState.Status;
                currentStatus = concurrentState.Status;
                outcome = concurrentState.Status == targetStatus
                    ? ConversationStatusWriteOutcome.NoChange
                    : ConversationStatusWriteOutcome.Conflict;
                return;
            }
            currentStatus = targetStatus;

            await db.Insertable(new ConversationStatusEvent
            {
                Id = SnowFlakeSingle.Instance.NextId(),
                ConversationId = conversationId,
                PreviousStatus = previousStatus,
                CurrentStatus = currentStatus,
                AdminPrincipalId = adminActor.AdminPrincipalId,
                AdminSessionAuditReference = adminActor.AdminSessionId,
                Reason = normalizedReason,
                CreatedAt = now
            }).ExecuteCommandAsync();

            List<int> participants = await db.Queryable<ConversationParticipantState>()
                .Where(it => it.ConversationId == conversationId)
                .Select(it => it.AccountId)
                .ToListAsync();
            var deliveries = new List<MessageMutationOutbox>(participants.Count + 1);
            long mutationCoordinate = now.Ticks;
            for (int i = 0; i < participants.Count; i++)
            {
                deliveries.Add(CreateDelivery(
                    mutationCoordinate,
                    MessageMutationOutboxEventKinds.ConversationStatus,
                    MessageMutationOutboxAudiences.Account,
                    participants[i],
                    conversationId,
                    null,
                    null,
                    targetStatus));
            }
            deliveries.Add(CreateDelivery(
                mutationCoordinate,
                MessageMutationOutboxEventKinds.ConversationStatus,
                MessageMutationOutboxAudiences.Admins,
                null,
                conversationId,
                null,
                null,
                targetStatus));
            await EnqueueMessageDeliveriesAsync(deliveries.ToArray());
            outcome = ConversationStatusWriteOutcome.Succeeded;
        });
        if (!transaction.IsSuccess)
        {
            FsusObservability.RecordMessageCenterStatus("unknown", "unknown", "error");
            logger.LogError(transaction.ErrorException, "Message status transaction failed. ConversationId: {ConversationId}", conversationId);
            return Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.InfraFailure, "会话状态更新失败");
        }

        string previousStatusMetric = outcome == ConversationStatusWriteOutcome.NotFound
            ? "unknown"
            : ToStatusValue(previousStatus).ToString();
        string currentStatusMetric = outcome == ConversationStatusWriteOutcome.NotFound
            ? "unknown"
            : ToStatusValue(currentStatus).ToString();
        FsusObservability.RecordMessageCenterStatus(previousStatusMetric, currentStatusMetric, outcome.ToString());

        return outcome switch
        {
            ConversationStatusWriteOutcome.NotFound => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.NotFound, "会话不存在"),
            ConversationStatusWriteOutcome.InvalidTransition => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Conflict, "conversation_status_transition_invalid"),
            ConversationStatusWriteOutcome.Conflict => Result<ConversationStatusMutationResultResponse>.Failure(ErrorCode.Conflict, "会话状态已被其他管理员修改"),
            ConversationStatusWriteOutcome.NoChange => Result<ConversationStatusMutationResultResponse>.Success(
                new ConversationStatusMutationResultResponse(
                    ToStatusValue(previousStatus),
                    ToStatusValue(currentStatus),
                    ConversationStatusMutationOutcomeValue.NoChange)),
            _ => Result<ConversationStatusMutationResultResponse>.Success(
                new ConversationStatusMutationResultResponse(
                    ToStatusValue(previousStatus),
                    ToStatusValue(currentStatus),
                    ConversationStatusMutationOutcomeValue.Changed))
        };
    }

    private static bool IsAllowedStatusTransition(ConversationStatus previousStatus, ConversationStatus currentStatus)
        => (previousStatus, currentStatus) switch
        {
            (ConversationStatus.Open, ConversationStatus.Pending or ConversationStatus.Closed) => true,
            (ConversationStatus.Pending, ConversationStatus.Open or ConversationStatus.Closed) => true,
            (ConversationStatus.Closed, ConversationStatus.Open) => true,
            _ => false
        };

    private sealed record ConversationStatusUpdateState(ConversationStatus Status, string RowVersion);

    private enum ConversationStatusWriteOutcome
    {
        NotFound,
        InvalidTransition,
        Conflict,
        NoChange,
        Succeeded
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

    private Task<int> TryUpdateConversationStatusAsync(
        long conversationId,
        ConversationStatusValue status,
        ConversationStatusUpdateState currentState,
        DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_conversation
            SET status = @Status,
                updatedat = @UpdatedAt
            WHERE id = @ConversationId
              AND status = @ExpectedStatus
              AND xmin::text = @RowVersion;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@Status", (int)ToStatusEntity(status)),
            new SugarParameter("@ExpectedStatus", (int)currentState.Status),
            new SugarParameter("@RowVersion", currentState.RowVersion),
            new SugarParameter("@UpdatedAt", now));

    public Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(
        string subject,
        string body,
        long? targetAccountId,
        AdminMessageActor adminActor)
        => SendSystemMessageAsync(
            subject,
            body,
            targetAccountId,
            adminActor,
            SnowFlakeSingle.Instance.NextId());

    public async Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(
        string subject,
        string body,
        long? targetAccountId,
        AdminMessageActor adminActor,
        long sourceEventId,
        SystemMessageTargetPolicy targetPolicy = SystemMessageTargetPolicy.ActiveAccountOnly)
    {
        if (!targetAccountId.HasValue || targetAccountId.Value <= 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "目标账号不能为空");
        }
        if (targetAccountId.Value > int.MaxValue)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.NotFound, "system_message_target_not_found");
        }
        if (sourceEventId <= 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "source_event_id_invalid");
        }

        var normalizedSubject = NormalizeSubject(subject, "系统消息");
        var normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        int target = checked((int)targetAccountId.Value);
        bool hasAdminPrincipal = adminActor.HasAdminPrincipal;
        long conversationId = SnowFlakeSingle.Instance.NextId();
        long messageId = SnowFlakeSingle.Instance.NextId();
        string requestHash = ComputeMutationRequestHash(
            "system",
            target.ToString(CultureInfo.InvariantCulture),
            normalizedSubject,
            normalizedBody);
        MutationReplayState replayState = MutationReplayState.None;
        SystemMessageTargetValidation targetValidation = SystemMessageTargetValidation.Allowed;
        DateTime now = DateTime.UtcNow;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await AcquireMutationLockAsync("system", 0, sourceEventId.ToString(CultureInfo.InvariantCulture));
            MessageConversation? existing = await db.Queryable<MessageConversation>()
                .Where(item => item.SourceMessageId == sourceEventId)
                .FirstAsync();
            if (existing is not null)
            {
                conversationId = existing.Id;
                replayState = string.Equals(existing.MutationRequestHash, requestHash, StringComparison.Ordinal)
                    ? MutationReplayState.Replay
                    : MutationReplayState.Conflict;
                return;
            }

            if (!(configuration.GetValue<bool?>("Messages:SystemMessageTargetValidationEnabled") ?? true))
            {
                targetValidation = SystemMessageTargetValidation.Disabled;
                return;
            }

            SystemMessageTargetLock? targetState = await LoadSystemMessageTargetForUpdateAsync(target);
            targetValidation = ValidateSystemMessageTarget(targetState, targetPolicy);
            if (targetValidation != SystemMessageTargetValidation.Allowed)
            {
                return;
            }

            await db.Insertable(new MessageConversation
            {
                Id = conversationId,
                Subject = normalizedSubject,
                InitiatorAccountId = target,
                Status = ConversationStatus.Open,
                IsSystemSource = true,
                SourceMessageId = sourceEventId,
                MutationRequestHash = requestHash,
                CreatedByType = hasAdminPrincipal ? MessageSenderType.Admin : MessageSenderType.System,
                CreatedByAdminPrincipalId = hasAdminPrincipal ? adminActor.AdminPrincipalId : null,
                CreatedByAdminSessionId = hasAdminPrincipal ? adminActor.AdminSessionId : null,
                CreatedAt = now,
                UpdatedAt = now,
                LastMessageAt = now
            }).ExecuteCommandAsync();

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.System,
                Body = normalizedBody,
                CreatedAt = now
            }).ExecuteCommandAsync();

            await db.Insertable(new ConversationParticipantState
            {
                ConversationId = conversationId,
                AccountId = target,
                UnreadCount = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await db.Insertable(new AdminConversationQueueState
            {
                ConversationId = conversationId,
                UnreadCount = 0,
                Version = 1,
                UpdatedAt = now
            }).ExecuteCommandAsync();
            await EnqueueMessageDeliveriesAsync(
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Account, target, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.MessageAppend, MessageMutationOutboxAudiences.Account, target, conversationId, messageId, null),
                CreateDelivery(messageId, MessageMutationOutboxEventKinds.ConversationUpsert, MessageMutationOutboxAudiences.Admins, null, conversationId, messageId, null));
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-send-system-message"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建失败");
        }
        if (replayState == MutationReplayState.Conflict)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Conflict, "source_event_content_conflict");
        }
        Result<ConversationDetailResponse>? targetFailure = targetValidation switch
        {
            SystemMessageTargetValidation.Missing => Result<ConversationDetailResponse>.Failure(
                ErrorCode.NotFound,
                "system_message_target_not_found"),
            SystemMessageTargetValidation.Deleted => Result<ConversationDetailResponse>.Failure(
                ErrorCode.NotFound,
                "system_message_target_deleted"),
            SystemMessageTargetValidation.Restricted => Result<ConversationDetailResponse>.Failure(
                ErrorCode.Forbidden,
                "system_message_target_restricted"),
            SystemMessageTargetValidation.InvalidStatus => Result<ConversationDetailResponse>.Failure(
                ErrorCode.Forbidden,
                "system_message_target_status_invalid"),
            SystemMessageTargetValidation.Disabled => Result<ConversationDetailResponse>.Failure(
                ErrorCode.InfraFailure,
                "system_message_target_validation_disabled"),
            _ => null
        };
        if (targetFailure.HasValue)
        {
            return targetFailure.Value;
        }

        var detail = await GetAccountConversationDetailAsync(target, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建后读取失败");
        }

        return Result<ConversationDetailResponse>.Success(detail with
        {
            IdempotencyReplay = replayState == MutationReplayState.Replay
        });
    }

    public async Task SendAccountTransactionalNoticeAsync(int accountId, string subject, string body)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                subject,
                body,
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-transactional", accountId, subject, body)),
            "send-account-transactional-notice",
            accountId);

    public async Task SendCommentDeletedNoticeAsync(int targetAccountId, string articleTitle, string commentSnippet, string reason)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "评论处理通知",
                $"您在《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}",
                targetAccountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("comment-deleted", targetAccountId, articleTitle, commentSnippet, reason)),
            "send-comment-deleted-notice",
            targetAccountId);

    public async Task SendAccountBannedNoticeAsync(int accountId, string reason)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "账号处罚通知",
                $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}",
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-banned", accountId, reason),
                SystemMessageTargetPolicy.AllowRestrictedForGovernance),
            "send-account-banned-notice",
            accountId);
        await PushAccountStatusAsync(accountId, 1, reason);
    }

    public async Task SendAccountUnbannedNoticeAsync(int accountId)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync(
                "账号恢复通知",
                "您已解除账户管控。",
                accountId,
                AdminMessageActor.System,
                ComputeStableSourceEventId("account-unbanned", accountId),
                SystemMessageTargetPolicy.AllowRestrictedForGovernance),
            "send-account-unbanned-notice",
            accountId);
        await PushAccountStatusAsync(accountId, 0, null);
    }

    public Task PushAccountStatusAsync(long accountId, int status, string? reason)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.AccountStatusChanged,
            accountId,
            new AccountStatusPayload(status, reason, DateTime.UtcNow),
            "push-account-status");

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

    private static SystemMessageTargetValidation ValidateSystemMessageTarget(
        SystemMessageTargetLock? target,
        SystemMessageTargetPolicy policy)
    {
        if (target is null)
        {
            return SystemMessageTargetValidation.Missing;
        }
        if (target.DeletedAt.HasValue || target.Status == 2)
        {
            return SystemMessageTargetValidation.Deleted;
        }
        if (target.Status == 0)
        {
            return SystemMessageTargetValidation.Allowed;
        }
        if (target.Status == 1)
        {
            return policy == SystemMessageTargetPolicy.AllowRestrictedForGovernance
                ? SystemMessageTargetValidation.Allowed
                : SystemMessageTargetValidation.Restricted;
        }

        return SystemMessageTargetValidation.InvalidStatus;
    }

    public Task PushCommentRemoveAsync(int articleId, long commentId, long? rootId, long? parentId)
        => notificationStreamPort.PublishToContentFeedAsync(
            NotificationStreamEventType.CommentRemoved,
            new CommentRemovedPayload(articleId, commentId.ToString(), rootId?.ToString(), parentId?.ToString(), DateTime.UtcNow),
            "push-comment-removed");

    public Task PushCommentAddAsync(CommentAddedNotifyDto payload)
        => notificationStreamPort.PublishToContentFeedAsync(NotificationStreamEventType.CommentAdded, payload, "push-comment-added");

    public Task PushCacheControlAsync(CacheControlPayload payload)
        => notificationStreamPort.PublishToContentFeedAsync(NotificationStreamEventType.CacheControl, payload, "push-cache-control");

    public Task PushArticleChangedAsync(ArticleNoticeDto payload, string? idempotencyKey = null)
        => notificationStreamPort.PublishToContentFeedAsync(
            NotificationStreamEventType.ArticleChanged,
            payload,
            "push-article-changed",
            idempotencyKey);

    private async Task<List<ConversationListItemResponse>> BuildConversationListAsync(
        List<AccountConversationRow> rows,
        bool includeUnread,
        long? snapshotMessageId = null)
    {
        if (rows.Count == 0)
        {
            return [];
        }

        long[] ids = CollectConversationIds(rows);
        var lastMessageMap = await LoadLastMessageMapAsync(ids, snapshotMessageId);
        var items = new List<ConversationListItemResponse>(rows.Count);
        foreach (var row in rows)
        {
            lastMessageMap.TryGetValue(row.ConversationId, out var lastMessage);
            items.Add(new ConversationListItemResponse
            {
                ConversationId = row.ConversationId.ToString(),
                Subject = row.Subject,
                Status = ToStatusValue(row.Status),
                IsSystemSource = row.IsSystemSource,
                CanReply = row.Status != ConversationStatus.Closed,
                UnreadCount = includeUnread ? row.UnreadCount : 0,
                LastMessageAt = row.LastMessageAt,
                UpdatedAt = row.UpdatedAt,
                LastMessage = lastMessage
            });
        }

        return items;
    }

    private async Task<List<AdminConversationListItemResponse>> BuildAdminConversationListAsync(
        List<AccountConversationRow> rows,
        long? snapshotMessageId = null)
    {
        if (rows.Count == 0)
        {
            return [];
        }

        long[] ids = CollectConversationIds(rows);
        Dictionary<long, ConversationMessagePreviewResponse> lastMessageMap = await LoadLastMessageMapAsync(
            ids,
            snapshotMessageId,
            MessageViewer.Admin);
        var items = new List<AdminConversationListItemResponse>(rows.Count);
        foreach (AccountConversationRow row in rows)
        {
            lastMessageMap.TryGetValue(row.ConversationId, out ConversationMessagePreviewResponse? lastMessage);
            items.Add(new AdminConversationListItemResponse
            {
                ConversationId = row.ConversationId.ToString(CultureInfo.InvariantCulture),
                Subject = row.Subject,
                Status = ToStatusValue(row.Status),
                IsSystemSource = row.IsSystemSource,
                CanReply = row.Status != ConversationStatus.Closed,
                UnreadCount = row.UnreadCount,
                LastMessageAt = row.LastMessageAt,
                UpdatedAt = row.UpdatedAt,
                LastMessage = lastMessage,
                CounterpartyAccountId = row.CounterpartyAccountId.ToString(CultureInfo.InvariantCulture),
                CounterpartyAccountStatus = row.CounterpartyAccountStatus
            });
        }

        return items;
    }

    private async Task<ConversationMessagePage> LoadConversationMessagePageAsync(
        long conversationId,
        long? beforeMessageId,
        MessageViewer viewer)
    {
        var query = db.Queryable<ConversationMessage>()
            .Where(it => it.ConversationId == conversationId && !it.IsInternalNote)
            .WhereIF(beforeMessageId.HasValue, it => it.Id < beforeMessageId!.Value)
            .OrderBy(it => it.Id, OrderByType.Desc)
            .Take(ConversationDetailPageSize + 1);
        var rows = await query
            .ToListAsync();
        bool hasOlder = rows.Count > ConversationDetailPageSize;
        if (hasOlder)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        rows.Reverse();
        List<ConversationMessageResponse> messages = await MapMessagesAsync(rows, viewer);
        string? previousCursor = hasOlder && rows.Count > 0 ? rows[0].Id.ToString() : null;
        return new ConversationMessagePage(messages, previousCursor, hasOlder);
    }

    private async Task<Dictionary<long, ConversationMessagePreviewResponse>> LoadLastMessageMapAsync(
        long[] conversationIds,
        long? snapshotMessageId = null,
        MessageViewer viewer = MessageViewer.Account)
    {
        if (conversationIds.Length == 0)
        {
            return [];
        }

        List<ConversationMessage> rows = await LoadLastMessagesSingleQueryAsync(conversationIds, snapshotMessageId);
        var mapped = await MapMessagesAsync(rows, viewer);
        Dictionary<long, ConversationMessagePreviewResponse> mappedByMessageId = BuildMessagePreviewMap(mapped, logger);
        var latestRows = new List<(long ConversationId, long MessageId)>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            ConversationMessage row = rows[i];
            latestRows.Add((row.ConversationId, row.Id));
        }

        return BuildLatestMessageMap(latestRows, mappedByMessageId);
    }

    private async Task<List<ConversationMessage>> LoadLastMessagesSingleQueryAsync(
        long[] conversationIds,
        long? snapshotMessageId)
    {
        var parameters = new List<SugarParameter>(conversationIds.Length + 1);
        var placeholders = new string[conversationIds.Length];
        for (int i = 0; i < conversationIds.Length; i++)
        {
            string name = "@ConversationId" + i.ToString(CultureInfo.InvariantCulture);
            placeholders[i] = name;
            parameters.Add(new SugarParameter(name, conversationIds[i]));
        }

        string snapshotPredicate = string.Empty;
        if (snapshotMessageId.HasValue)
        {
            snapshotPredicate = "AND id <= @SnapshotMessageId";
            parameters.Add(new SugarParameter("@SnapshotMessageId", snapshotMessageId.Value));
        }

        string sql = $"""
            SELECT DISTINCT ON (conversationid)
                   id,
                   conversationid,
                   sendertype,
                   senderaccountid,
                   senderadminprincipalid,
                   senderadminsessionid,
                   body,
                   isinternalnote,
                   createdat
            FROM msg_message
            WHERE conversationid IN ({string.Join(", ", placeholders)})
              AND isinternalnote = false
              {snapshotPredicate}
            ORDER BY conversationid, id DESC;
            """;
        return await db.Ado.SqlQueryAsync<ConversationMessage>(sql, parameters.ToArray());
    }

    private static long[] CollectConversationIds(IReadOnlyList<AccountConversationRow> rows)
    {
        var ids = new long[rows.Count];
        for (int i = 0; i < rows.Count; i++)
        {
            ids[i] = rows[i].ConversationId;
        }

        return ids;
    }

    internal static Dictionary<long, ConversationMessagePreviewResponse> BuildLatestMessageMap(
        IReadOnlyList<(long ConversationId, long MessageId)> latestRows,
        IReadOnlyDictionary<long, ConversationMessagePreviewResponse> mappedByMessageId)
    {
        var latestByConversation = new Dictionary<long, ConversationMessagePreviewResponse>(latestRows.Count);
        foreach ((long conversationId, long messageId) in latestRows)
        {
            if (mappedByMessageId.TryGetValue(messageId, out ConversationMessagePreviewResponse? response))
            {
                latestByConversation[conversationId] = response;
            }
        }

        return latestByConversation;
    }

    internal static Dictionary<long, ConversationMessagePreviewResponse> BuildMessagePreviewMap(
        IReadOnlyList<ConversationMessageResponse> mapped,
        ILogger logger)
    {
        var mappedByMessageId = new Dictionary<long, ConversationMessagePreviewResponse>(mapped.Count);
        for (int i = 0; i < mapped.Count; i++)
        {
            ConversationMessageResponse item = mapped[i];
            if (!long.TryParse(item.MessageId, NumberStyles.Integer, CultureInfo.InvariantCulture, out long messageId))
            {
                logger.LogWarning(
                    "Skipping corrupt message center cache row. MessageId: {MessageId}",
                    item.MessageId);
                continue;
            }

            ConversationMessagePreviewResponse? preview = ToMessagePreview(item);
            if (preview is not null)
            {
                mappedByMessageId[messageId] = preview;
            }
        }

        return mappedByMessageId;
    }

    private static Task<List<ConversationMessageResponse>> MapMessagesAsync(List<ConversationMessage> rows)
        => MapMessagesAsync(rows, MessageViewer.Account);

    private static Task<List<ConversationMessageResponse>> MapMessagesAsync(
        List<ConversationMessage> rows,
        MessageViewer viewer)
    {
        if (rows.Count == 0)
        {
            return Task.FromResult<List<ConversationMessageResponse>>([]);
        }

        var result = new List<ConversationMessageResponse>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            var row = rows[i];
            result.Add(new ConversationMessageResponse
            {
                MessageId = row.Id.ToString(),
                ConversationId = row.ConversationId.ToString(),
                SenderType = ToSenderValue(row.SenderType),
                SenderName = ResolveSenderNameForViewer(row, viewer),
                Body = row.Body,
                CreatedAt = row.CreatedAt
            });
        }

        return Task.FromResult(result);
    }

    private async Task<ConversationMessageResponse?> BuildMessageResponseAsync(
        long conversationId,
        long messageId,
        MessageViewer viewer = MessageViewer.Account)
    {
        var row = await db.Queryable<ConversationMessage>()
            .Where(it => it.ConversationId == conversationId && it.Id == messageId)
            .FirstAsync();
        if (row is null)
        {
            return null;
        }

        return (await MapMessagesAsync([row], viewer)).FirstOrDefault();
    }

    private async Task<ConversationListItemResponse?> BuildConversationListItemForAccountAsync(int accountId, long conversationId)
    {
        var rows = await db.Queryable<ConversationParticipantState, MessageConversation>(
            (p, c) => p.ConversationId == c.Id)
            .Where((p, c) => p.AccountId == accountId && c.Id == conversationId)
            .Select((p, c) => new AccountConversationRow
            {
                ConversationId = c.Id,
                Subject = c.Subject,
                Status = c.Status,
                IsSystemSource = c.IsSystemSource,
                UnreadCount = p.UnreadCount,
                LastMessageAt = c.LastMessageAt,
                UpdatedAt = c.UpdatedAt
            })
            .ToListAsync();
        if (rows.Count == 0)
        {
            return null;
        }

        return (await BuildConversationListAsync(rows, includeUnread: true)).FirstOrDefault();
    }

    private async Task<AdminConversationListItemResponse?> BuildAdminConversationListItemAsync(long conversationId)
    {
        List<AccountConversationRow> rows = await db.Ado.SqlQueryAsync<AccountConversationRow>(
            """
            SELECT conversation.id AS conversationid,
                   conversation.subject,
                   conversation.status,
                   conversation.issystemsource,
                   COALESCE(admin_queue.unreadcount, 0) AS unreadcount,
                   conversation.lastmessageat,
                   conversation.updatedat,
                   COALESCE(conversation.initiatoraccountid, 0) AS counterpartyaccountid,
                   CASE
                       WHEN counterparty.id IS NULL OR counterparty.status NOT BETWEEN 0 AND 2 THEN @MissingStatus
                       ELSE counterparty.status
                   END AS counterpartyaccountstatus
            FROM msg_conversation conversation
            LEFT JOIN msg_admin_queue_state admin_queue ON admin_queue.conversationid = conversation.id
            LEFT JOIN sys_user counterparty ON counterparty.id = conversation.initiatoraccountid
            WHERE conversation.id = @ConversationId;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@MissingStatus", (int)CounterpartyAccountStatusValue.Missing));
        return (await BuildAdminConversationListAsync(rows)).FirstOrDefault();
    }

    private async Task EnqueueReplyDeliveriesAsync(ReplyWriteCommand command, long messageId)
    {
        var deliveries = new List<MessageMutationOutbox>();
        if (command.SenderType == MessageSenderType.Account)
        {
            int accountId = command.SenderAccountId!.Value;
            deliveries.Add(CreateDelivery(
                messageId,
                MessageMutationOutboxEventKinds.ReadUpdated,
                MessageMutationOutboxAudiences.Account,
                accountId,
                command.ConversationId,
                messageId,
                command.ReadThroughMessageId));
            deliveries.Add(CreateDelivery(
                messageId,
                MessageMutationOutboxEventKinds.MessageAppend,
                MessageMutationOutboxAudiences.Admins,
                null,
                command.ConversationId,
                messageId,
                null));
        }
        else
        {
            List<int> participants = await db.Queryable<ConversationParticipantState>()
                .Where(it => it.ConversationId == command.ConversationId)
                .Select(it => it.AccountId)
                .ToListAsync();
            for (int i = 0; i < participants.Count; i++)
            {
                deliveries.Add(CreateDelivery(
                    messageId,
                    MessageMutationOutboxEventKinds.ConversationUpsert,
                    MessageMutationOutboxAudiences.Account,
                    participants[i],
                    command.ConversationId,
                    messageId,
                    null));
                deliveries.Add(CreateDelivery(
                    messageId,
                    MessageMutationOutboxEventKinds.MessageAppend,
                    MessageMutationOutboxAudiences.Account,
                    participants[i],
                    command.ConversationId,
                    messageId,
                    null));
            }
        }

        deliveries.Add(CreateDelivery(
            messageId,
            MessageMutationOutboxEventKinds.ConversationUpsert,
            MessageMutationOutboxAudiences.Admins,
            null,
            command.ConversationId,
            messageId,
            null));
        await EnqueueMessageDeliveriesAsync(deliveries.ToArray());
    }

    private async Task EnqueueMessageDeliveriesAsync(params MessageMutationOutbox[] deliveries)
    {
        for (int i = 0; i < deliveries.Length; i++)
        {
            MessageMutationOutbox delivery = deliveries[i];
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO message_mutation_outbox(
                    deliverykey, eventkind, audiencekind, targetaccountid, conversationid,
                    messageid, readthroughmessageid, conversationstatus, status, attemptcount, nextattemptat, createdat)
                VALUES(
                    @DeliveryKey, @EventKind, @AudienceKind, CAST(@TargetAccountId AS integer), @ConversationId,
                    CAST(@MessageId AS bigint), CAST(@ReadThroughMessageId AS bigint), CAST(@ConversationStatus AS integer), @Status, 0, @NextAttemptAt, @CreatedAt)
                ON CONFLICT (deliverykey) DO NOTHING;
                """,
                new SugarParameter("@DeliveryKey", delivery.DeliveryKey),
                new SugarParameter("@EventKind", delivery.EventKind),
                new SugarParameter("@AudienceKind", delivery.AudienceKind),
                new SugarParameter("@TargetAccountId", (object?)delivery.TargetAccountId ?? DBNull.Value),
                new SugarParameter("@ConversationId", delivery.ConversationId),
                new SugarParameter("@MessageId", (object?)delivery.MessageId ?? DBNull.Value),
                new SugarParameter("@ReadThroughMessageId", (object?)delivery.ReadThroughMessageId ?? DBNull.Value),
                new SugarParameter("@ConversationStatus", delivery.ConversationStatus.HasValue ? (int)delivery.ConversationStatus.Value : DBNull.Value),
                new SugarParameter("@Status", delivery.Status),
                new SugarParameter("@NextAttemptAt", delivery.NextAttemptAt),
                new SugarParameter("@CreatedAt", delivery.CreatedAt));
        }
    }

    private static MessageMutationOutbox CreateDelivery(
        long mutationCoordinate,
        string eventKind,
        string audienceKind,
        int? targetAccountId,
        long conversationId,
        long? messageId,
        long? readThroughMessageId,
        ConversationStatus? conversationStatus = null)
    {
        DateTime now = DateTime.UtcNow;
        string target = targetAccountId?.ToString(CultureInfo.InvariantCulture) ?? "group";
        return new MessageMutationOutbox
        {
            DeliveryKey = $"message:{conversationId.ToString(CultureInfo.InvariantCulture)}:{mutationCoordinate.ToString(CultureInfo.InvariantCulture)}:{audienceKind}:{target}:{eventKind}",
            EventKind = eventKind,
            AudienceKind = audienceKind,
            TargetAccountId = targetAccountId,
            ConversationId = conversationId,
            MessageId = messageId,
            ReadThroughMessageId = readThroughMessageId,
            ConversationStatus = conversationStatus,
            Status = MessageMutationOutboxStatus.Pending,
            NextAttemptAt = now,
            CreatedAt = now
        };
    }

    public async Task DeliverAsync(MessageMutationOutbox delivery, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (delivery.AudienceKind == MessageMutationOutboxAudiences.Account && !delivery.TargetAccountId.HasValue)
        {
            throw new InvalidOperationException("Message outbox account delivery is missing its target.");
        }

        switch (delivery.EventKind)
        {
            case MessageMutationOutboxEventKinds.ConversationUpsert:
                if (delivery.AudienceKind == MessageMutationOutboxAudiences.Admins)
                {
                    await PublishConversationUpsertToAdminsAsync(delivery.ConversationId, delivery.DeliveryKey);
                    return;
                }

                int accountId = delivery.TargetAccountId!.Value;
                ConversationListItemResponse? accountItem = await BuildConversationListItemForAccountAsync(accountId, delivery.ConversationId);
                if (accountItem is null)
                {
                    throw new InvalidOperationException("Message outbox conversation projection is missing.");
                }
                int conversationTotalUnread = await RefreshUnreadCacheAsync(accountId);
                await PublishConversationUpsertAsync(accountId, accountItem, conversationTotalUnread, delivery.DeliveryKey);
                return;

            case MessageMutationOutboxEventKinds.MessageAppend:
                if (!delivery.MessageId.HasValue)
                {
                    throw new InvalidOperationException("Message outbox append is missing its message coordinate.");
                }
                MessageViewer viewer = delivery.AudienceKind == MessageMutationOutboxAudiences.Admins
                    ? MessageViewer.Admin
                    : MessageViewer.Account;
                ConversationMessageResponse? message = await BuildMessageResponseAsync(
                    delivery.ConversationId,
                    delivery.MessageId.Value,
                    viewer);
                if (message is null)
                {
                    throw new InvalidOperationException("Message outbox append projection is missing.");
                }
                if (delivery.AudienceKind == MessageMutationOutboxAudiences.Admins)
                {
                    int adminUnread = await LoadAdminQueueUnreadCountAsync(delivery.ConversationId);
                    await PublishMessageAppendAsync(
                        delivery.ConversationId.ToString(CultureInfo.InvariantCulture),
                        message,
                        adminUnread,
                        null,
                        null,
                        delivery.DeliveryKey);
                    return;
                }

                int messageTarget = delivery.TargetAccountId!.Value;
                ConversationParticipantState? participant = await db.Queryable<ConversationParticipantState>()
                    .Where(it => it.ConversationId == delivery.ConversationId && it.AccountId == messageTarget)
                    .FirstAsync();
                if (participant is null)
                {
                    throw new InvalidOperationException("Message outbox participant projection is missing.");
                }
                int messageTotalUnread = await RefreshUnreadCacheAsync(messageTarget);
                await PublishMessageAppendAsync(
                    delivery.ConversationId.ToString(CultureInfo.InvariantCulture),
                    message,
                    participant.UnreadCount,
                    messageTotalUnread,
                    messageTarget,
                    delivery.DeliveryKey);
                return;

            case MessageMutationOutboxEventKinds.ReadUpdated:
                int readTarget = delivery.TargetAccountId!.Value;
                ConversationParticipantState? readState = await db.Queryable<ConversationParticipantState>()
                    .Where(it => it.ConversationId == delivery.ConversationId && it.AccountId == readTarget)
                    .FirstAsync();
                if (readState is null)
                {
                    throw new InvalidOperationException("Message outbox read projection is missing.");
                }
                int readTotalUnread = await RefreshUnreadCacheAsync(readTarget);
                await PublishReadUpdatedAsync(
                    readTarget,
                    delivery.ConversationId,
                    readState.LastReadMessageId,
                    readState.UnreadCount,
                    readTotalUnread,
                    delivery.DeliveryKey);
                return;

            case MessageMutationOutboxEventKinds.ConversationStatus:
                if (!delivery.ConversationStatus.HasValue)
                {
                    throw new InvalidOperationException("Message outbox status projection is missing.");
                }
                if (delivery.AudienceKind == MessageMutationOutboxAudiences.Admins)
                {
                    await PublishConversationStatusChangedToAdminsAsync(
                        delivery.ConversationId,
                        ToStatusValue(delivery.ConversationStatus.Value),
                        delivery.DeliveryKey);
                    return;
                }
                await PublishConversationStatusChangedAsync(
                    delivery.TargetAccountId!.Value,
                    delivery.ConversationId,
                    ToStatusValue(delivery.ConversationStatus.Value),
                    delivery.DeliveryKey);
                return;

            default:
                throw new InvalidOperationException($"Unsupported message outbox event kind: {delivery.EventKind}");
        }
    }

    private async Task PublishConversationUpsertAsync(int accountId, ConversationDetailResponse detail, int? totalUnread = null)
    {
        var summary = new ConversationListItemResponse
        {
            ConversationId = detail.ConversationId,
            Subject = detail.Subject,
            Status = detail.Status,
            IsSystemSource = detail.IsSystemSource,
            CanReply = detail.CanReply,
            UnreadCount = detail.UnreadCount,
            LastMessageAt = detail.LastMessageAt,
            UpdatedAt = detail.LastMessageAt,
            LastMessage = ToMessagePreview(detail.Messages.LastOrDefault())
        };
        await PublishConversationUpsertAsync(accountId, summary, totalUnread);
    }

    private Task PublishConversationUpsertAsync(
        int accountId,
        ConversationListItemResponse summary,
        int? totalUnread = null,
        string? idempotencyKey = null)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxConversationUpsert,
            accountId,
            new InboxConversationUpsertPayload(summary, totalUnread, DateTime.UtcNow),
            "inbox-conversation-upsert",
            idempotencyKey);

    private async Task PublishConversationUpsertToAdminsAsync(long conversationId, string? idempotencyKey = null)
    {
        if (!IsAdminAccountProjectionEnabled())
        {
            return;
        }

        AdminConversationListItemResponse? summary = await BuildAdminConversationListItemAsync(conversationId);
        if (summary is null)
        {
            if (!string.IsNullOrWhiteSpace(idempotencyKey))
            {
                throw new InvalidOperationException("Admin conversation projection is missing.");
            }
            logger.LogWarning("Admin conversation projection missing. ConversationId: {ConversationId}", conversationId);
            return;
        }

        await notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationUpsert,
            new InboxConversationUpsertPayload(summary, null, DateTime.UtcNow),
            "admin-conversation-upsert",
            idempotencyKey);
    }

    private Task PublishMessageAppendAsync(
        string conversationId,
        ConversationMessageResponse message,
        int? conversationUnreadCount = null,
        int? totalUnread = null,
        int? targetAccountId = null,
        string? idempotencyKey = null)
    {
        var payload = new InboxMessageAppendPayload(conversationId, message, conversationUnreadCount, totalUnread, DateTime.UtcNow);
        if (targetAccountId.HasValue)
        {
            return notificationStreamPort.PublishToUserAsync(NotificationStreamEventType.InboxMessageAppend, targetAccountId.Value, payload, "inbox-message-append-user", idempotencyKey);
        }

        return notificationStreamPort.PublishToAdminUsersAsync(NotificationStreamEventType.InboxMessageAppend, payload, "inbox-message-append-admin", idempotencyKey);
    }

    private Task PublishReadUpdatedAsync(
        int accountId,
        long conversationId,
        long? lastReadMessageId,
        int conversationUnreadCount,
        int? totalUnread,
        string? idempotencyKey = null)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxReadUpdated,
            accountId,
            new InboxReadUpdatedPayload(conversationId.ToString(), lastReadMessageId?.ToString(), conversationUnreadCount, totalUnread, DateTime.UtcNow),
            "inbox-read-updated",
            idempotencyKey);

    private Task PublishConversationStatusChangedAsync(
        int accountId,
        long conversationId,
        ConversationStatusValue status,
        string? idempotencyKey = null)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxConversationStatusChanged,
            accountId,
            new InboxConversationStatusChangedPayload(conversationId.ToString(), status, DateTime.UtcNow),
            "inbox-conversation-status-changed",
            idempotencyKey);

    private Task PublishConversationStatusChangedToAdminsAsync(
        long conversationId,
        ConversationStatusValue status,
        string? idempotencyKey = null)
        => notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationStatusChanged,
            new InboxConversationStatusChangedPayload(conversationId.ToString(), status, DateTime.UtcNow),
            "inbox-conversation-status-changed-admin",
            idempotencyKey);

    private async Task PublishParticipantMessageFanoutAsync(
        long conversationId,
        ConversationMessageResponse message,
        IReadOnlyList<ConversationParticipantState> participants)
    {
        if (participants.Count == 0)
        {
            return;
        }

        IReadOnlyList<ParticipantMessageFanoutPayload> fanout = await PrepareParticipantMessageFanoutAsync(conversationId, message, participants);
        var tasks = new List<Task>(fanout.Count);
        for (int i = 0; i < fanout.Count; i++)
        {
            ParticipantMessageFanoutPayload payload = fanout[i];
            tasks.Add(PublishPreparedParticipantMessageAsync(conversationId, message, payload.Participant, payload.Item, payload.TotalUnread));
        }

        await Task.WhenAll(tasks);
    }

    private async Task<IReadOnlyList<ParticipantMessageFanoutPayload>> PrepareParticipantMessageFanoutAsync(
        long conversationId,
        ConversationMessageResponse message,
        IReadOnlyList<ConversationParticipantState> participants)
    {
        if (participants.Count == 0)
        {
            return [];
        }

        int[] accountIds = [.. participants.Select(static item => item.AccountId).Distinct()];
        long refreshStartedAt = Stopwatch.GetTimestamp();
        Task<Dictionary<int, int>> totalUnreadTask = LoadTotalUnreadMapAsync(accountIds);
        long buildStartedAt = Stopwatch.GetTimestamp();
        Task<Dictionary<int, ConversationListItemResponse>> itemTask = BuildParticipantConversationItemsAsync(conversationId, message, participants);
        await Task.WhenAll(totalUnreadTask, itemTask);
        FsusObservability.RecordMessageCenterFanoutRefresh(FsusObservability.GetElapsed(refreshStartedAt));
        FsusObservability.RecordMessageCenterFanoutBuildItem(FsusObservability.GetElapsed(buildStartedAt));
        Dictionary<int, int> totalUnreadMap = await totalUnreadTask;
        Dictionary<int, ConversationListItemResponse> itemMap = await itemTask;
        var payloads = new List<ParticipantMessageFanoutPayload>(participants.Count);
        for (int i = 0; i < participants.Count; i++)
        {
            ConversationParticipantState participant = participants[i];
            totalUnreadMap.TryGetValue(participant.AccountId, out int totalUnread);
            await cache.SetUnreadAsync(participant.AccountId, totalUnread);
            itemMap.TryGetValue(participant.AccountId, out ConversationListItemResponse? item);
            payloads.Add(new ParticipantMessageFanoutPayload(participant, item, totalUnread));
        }

        return payloads;
    }

    private async Task<Dictionary<int, int>> LoadTotalUnreadMapAsync(IReadOnlyCollection<int> accountIds)
    {
        if (accountIds.Count == 0)
        {
            return [];
        }

        using SqlSugarClient queryDb = db.CopyNew();
        var rows = await queryDb.Queryable<ConversationParticipantState>()
            .Where(it => accountIds.Contains(it.AccountId))
            .GroupBy(it => it.AccountId)
            .Select(it => new AccountUnreadRow
            {
                AccountId = it.AccountId,
                UnreadCount = SqlFunc.AggregateSum(it.UnreadCount)
            })
            .ToListAsync();
        var map = new Dictionary<int, int>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            AccountUnreadRow row = rows[i];
            map[row.AccountId] = row.UnreadCount;
        }

        return map;
    }

    private async Task<Dictionary<int, ConversationListItemResponse>> BuildParticipantConversationItemsAsync(
        long conversationId,
        ConversationMessageResponse message,
        IReadOnlyList<ConversationParticipantState> participants)
    {
        using SqlSugarClient queryDb = db.CopyNew();
        MessageConversation? conversation = await queryDb.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return [];
        }

        ConversationMessagePreviewResponse? lastMessage = ToMessagePreview(message);
        var map = new Dictionary<int, ConversationListItemResponse>(participants.Count);
        for (int i = 0; i < participants.Count; i++)
        {
            ConversationParticipantState participant = participants[i];
            map[participant.AccountId] = new ConversationListItemResponse
            {
                ConversationId = conversation.Id.ToString(CultureInfo.InvariantCulture),
                Subject = conversation.Subject,
                Status = ToStatusValue(conversation.Status),
                IsSystemSource = conversation.IsSystemSource,
                CanReply = conversation.Status != ConversationStatus.Closed,
                UnreadCount = participant.UnreadCount,
                LastMessageAt = conversation.LastMessageAt,
                UpdatedAt = conversation.UpdatedAt,
                LastMessage = lastMessage
            };
        }

        return map;
    }

    private async Task PublishPreparedParticipantMessageAsync(
        long conversationId,
        ConversationMessageResponse message,
        ConversationParticipantState participant,
        ConversationListItemResponse? item,
        int totalUnread)
    {
        if (item is not null)
        {
            await PublishConversationUpsertAsync(participant.AccountId, item, totalUnread);
        }

        await PublishMessageAppendAsync(conversationId.ToString(), message, participant.UnreadCount, totalUnread, participant.AccountId);
    }

    private async Task PublishAccountConversationUpsertThenMessageAppendAsync(
        int target,
        ConversationDetailResponse detail,
        int totalUnread)
    {
        await PublishConversationUpsertAsync(target, detail, totalUnread);
        await PublishMessageAppendAsync(detail.ConversationId, detail.Messages.Last(), 1, totalUnread, target);
    }

    private async Task<int> RefreshUnreadCacheAsync(int accountId)
        => await cache.RefreshUnreadAsync(accountId, () => LoadTotalUnreadAsync(accountId));

    private async Task<int> LoadTotalUnreadAsync(int accountId)
    {
        return await db.Queryable<ConversationParticipantState>()
            .Where(it => it.AccountId == accountId)
            .SumAsync(it => it.UnreadCount);
    }

    private static string NormalizeSubject(string? input, string fallback)
    {
        string value = string.IsNullOrWhiteSpace(input) ? fallback : input.Trim();
        return value.Length > MaxSubjectLength ? value[..MaxSubjectLength] : value;
    }

    private static string NormalizeBody(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return string.Empty;
        }

        string value = input.Trim();
        return value.Length > MaxBodyLength ? value[..MaxBodyLength] : value;
    }

    private Task AcquireMutationLockAsync(string principalKind, long principalId, string mutationId)
        => db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext(@PrincipalKind), hashtext(@MutationScope));",
            new SugarParameter("@PrincipalKind", principalKind),
            new SugarParameter("@MutationScope", string.Concat(
                principalId.ToString(CultureInfo.InvariantCulture),
                ":",
                mutationId)));

    private async Task<MessageConversation?> FindConversationMutationAsync(
        string principalKind,
        long principalId,
        string mutationId)
        => await db.Queryable<MessageConversation>()
            .Where(item => item.ClientMutationPrincipalKind == principalKind
                && item.ClientMutationPrincipalId == principalId
                && item.ClientMutationId == mutationId)
            .FirstAsync();

    private async Task<ConversationMessage?> FindMessageMutationAsync(
        string principalKind,
        long principalId,
        string mutationId)
        => await db.Queryable<ConversationMessage>()
            .Where(item => item.ClientMutationPrincipalKind == principalKind
                && item.ClientMutationPrincipalId == principalId
                && item.ClientMutationId == mutationId)
            .FirstAsync();

    private static bool TryNormalizeClientMutationId(string? value, out string normalized)
    {
        normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length is <= 0 or > 64)
        {
            return false;
        }

        return normalized.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':');
    }

    private static string ComputeMutationRequestHash(params string[] values)
    {
        var canonical = new StringBuilder();
        for (int i = 0; i < values.Length; i++)
        {
            string value = values[i];
            canonical.Append(value.Length.ToString(CultureInfo.InvariantCulture));
            canonical.Append(':');
            canonical.Append(value);
            canonical.Append(';');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical.ToString())));
    }

    private static long ComputeStableSourceEventId(string operation, int accountId, params string[] values)
    {
        string[] coordinates = new string[values.Length + 2];
        coordinates[0] = operation;
        coordinates[1] = accountId.ToString(CultureInfo.InvariantCulture);
        Array.Copy(values, 0, coordinates, 2, values.Length);
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(ComputeMutationRequestHash(coordinates)));
        long sourceEventId = BitConverter.ToInt64(digest, 0) & long.MaxValue;
        return sourceEventId == 0 ? 1 : sourceEventId;
    }

    private static ConversationStatusValue ToStatusValue(ConversationStatus status)
        => status switch
        {
            ConversationStatus.Pending => ConversationStatusValue.Pending,
            ConversationStatus.Closed => ConversationStatusValue.Closed,
            _ => ConversationStatusValue.Open
        };

    private static ConversationStatus ToStatusEntity(ConversationStatusValue status)
        => status switch
        {
            ConversationStatusValue.Pending => ConversationStatus.Pending,
            ConversationStatusValue.Closed => ConversationStatus.Closed,
            _ => ConversationStatus.Open
        };

    private static CounterpartyAccountStatusValue ToCounterpartyAccountStatus(int status)
        => status switch
        {
            0 => CounterpartyAccountStatusValue.Active,
            1 => CounterpartyAccountStatusValue.Restricted,
            2 => CounterpartyAccountStatusValue.Deleted,
            _ => CounterpartyAccountStatusValue.Missing
        };

    private static ConversationSenderValue ToSenderValue(MessageSenderType senderType)
        => senderType switch
        {
            MessageSenderType.Account => ConversationSenderValue.Account,
            MessageSenderType.Admin => ConversationSenderValue.Admin,
            _ => ConversationSenderValue.System
        };

    private static string ResolveSenderName(ConversationMessage row)
        => ResolveSenderNameForViewer(row, MessageViewer.Account);

    private static string ResolveSenderNameForViewer(ConversationMessage row, MessageViewer viewer)
    {
        if (row.SenderType == MessageSenderType.System)
        {
            return "系统";
        }

        if (row.SenderType == MessageSenderType.Admin)
        {
            return "管理员";
        }

        return viewer == MessageViewer.Admin
            ? row.SenderAccountId.HasValue
                ? $"账号 #{row.SenderAccountId.Value.ToString(CultureInfo.InvariantCulture)}"
                : "账号"
            : "你";
    }

    private bool IsAdminAccountProjectionEnabled()
        => configuration.GetValue<bool?>("Messages:AdminAccountProjectionEnabled") ?? true;

    private async Task<long> LoadConversationListSnapshotMessageIdAsync()
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT COALESCE(MAX(id), 0)::bigint AS snapshot_message_id FROM msg_message WHERE isinternalnote = false;");
        return await reader.ReadAsync() ? reader.ReadInt64("snapshot_message_id") : 0;
    }

    private async Task<int> CountSnapshotConversationsAsync(
        int? accountId,
        string? filter,
        long snapshotMessageId)
    {
        string queueStateJoin = accountId.HasValue
            ? "JOIN msg_participant_state participant ON participant.conversationid = conversation.id"
            : "LEFT JOIN msg_admin_queue_state admin_queue ON admin_queue.conversationid = conversation.id";
        string accountPredicate = accountId.HasValue ? "AND participant.accountid = @AccountId" : string.Empty;
        string filterPredicate = BuildSnapshotConversationFilter(filter, accountId.HasValue);
        var parameters = new List<SugarParameter>
        {
            new("@SnapshotMessageId", snapshotMessageId)
        };
        if (accountId.HasValue)
        {
            parameters.Add(new SugarParameter("@AccountId", accountId.Value));
        }

        string sql = $"""
            SELECT COUNT(*)::integer
            FROM msg_conversation conversation
            {queueStateJoin}
            WHERE EXISTS (
                SELECT 1
                FROM msg_message message
                WHERE message.conversationid = conversation.id
                  AND message.id <= @SnapshotMessageId
                  AND message.isinternalnote = false
            )
            {accountPredicate}
            {filterPredicate};
            """;
        return await db.Ado.GetIntAsync(sql, parameters.ToArray());
    }

    private async Task<List<AccountConversationRow>> LoadSnapshotConversationRowsAsync(
        int? accountId,
        string? filter,
        long snapshotMessageId,
        MessageConversationCursor? cursor,
        int take)
    {
        string queueStateJoin = accountId.HasValue
            ? "JOIN msg_participant_state participant ON participant.conversationid = conversation.id"
            : "LEFT JOIN msg_admin_queue_state admin_queue ON admin_queue.conversationid = conversation.id";
        string counterpartyJoin = accountId.HasValue
            ? string.Empty
            : "LEFT JOIN sys_user counterparty ON counterparty.id = conversation.initiatoraccountid";
        string counterpartyAccountIdProjection = accountId.HasValue
            ? "0"
            : "COALESCE(conversation.initiatoraccountid, 0)";
        string counterpartyStatusProjection = accountId.HasValue
            ? ((int)CounterpartyAccountStatusValue.Missing).ToString(CultureInfo.InvariantCulture)
            : $"CASE WHEN counterparty.id IS NULL OR counterparty.status NOT BETWEEN 0 AND 2 THEN {(int)CounterpartyAccountStatusValue.Missing} ELSE counterparty.status END";
        string accountPredicate = accountId.HasValue ? "AND participant.accountid = @AccountId" : string.Empty;
        string unreadProjection = accountId.HasValue ? "participant.unreadcount" : "COALESCE(admin_queue.unreadcount, 0)";
        string filterPredicate = BuildSnapshotConversationFilter(filter, accountId.HasValue);
        string cursorPredicate = cursor.HasValue
            ? "AND (latest.createdat < @CursorLastMessageAt OR (latest.createdat = @CursorLastMessageAt AND conversation.id < @CursorConversationId))"
            : string.Empty;
        var parameters = new List<SugarParameter>
        {
            new("@SnapshotMessageId", snapshotMessageId),
            new("@Take", take)
        };
        if (accountId.HasValue)
        {
            parameters.Add(new SugarParameter("@AccountId", accountId.Value));
        }
        if (cursor.HasValue)
        {
            parameters.Add(new SugarParameter("@CursorLastMessageAt", cursor.Value.LastMessageAt));
            parameters.Add(new SugarParameter("@CursorConversationId", cursor.Value.ConversationId));
        }

        string sql = $"""
            SELECT conversation.id AS conversationid,
                   conversation.subject,
                   conversation.status,
                   conversation.issystemsource,
                   {unreadProjection} AS unreadcount,
                   latest.createdat AS lastmessageat,
                   conversation.updatedat,
                   {counterpartyAccountIdProjection} AS counterpartyaccountid,
                   {counterpartyStatusProjection} AS counterpartyaccountstatus
            FROM msg_conversation conversation
            {queueStateJoin}
            {counterpartyJoin}
            JOIN LATERAL (
                SELECT message.id,
                       message.createdat
                FROM msg_message message
                WHERE message.conversationid = conversation.id
                  AND message.id <= @SnapshotMessageId
                  AND message.isinternalnote = false
                ORDER BY message.id DESC
                LIMIT 1
            ) latest ON true
            WHERE true
            {accountPredicate}
            {filterPredicate}
            {cursorPredicate}
            ORDER BY latest.createdat DESC,
                     conversation.id DESC
            LIMIT @Take;
            """;
        return await db.Ado.SqlQueryAsync<AccountConversationRow>(sql, parameters.ToArray());
    }

    private static string BuildSnapshotConversationFilter(string? filter, bool accountScope)
        => (TextHelpers.LowerTrimmed(filter) ?? string.Empty) switch
        {
            "unread" when accountScope => "AND participant.unreadcount > 0",
            "unread" => "AND COALESCE(admin_queue.unreadcount, 0) > 0",
            "system" => "AND conversation.issystemsource = true",
            "open" => $"AND conversation.status = {(int)ConversationStatus.Open}",
            "pending" => $"AND conversation.status = {(int)ConversationStatus.Pending}",
            "closed" => $"AND conversation.status = {(int)ConversationStatus.Closed}",
            _ => string.Empty
        };

    private static ConversationMessagePreviewResponse? ToMessagePreview(ConversationMessageResponse? message)
    {
        if (message is null)
        {
            return null;
        }

        return new ConversationMessagePreviewResponse
        {
            SenderType = message.SenderType,
            SenderName = message.SenderName,
            BodyPreview = message.Body.Length <= 96 ? message.Body : $"{message.Body[..96]}...",
            CreatedAt = message.CreatedAt
        };
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
