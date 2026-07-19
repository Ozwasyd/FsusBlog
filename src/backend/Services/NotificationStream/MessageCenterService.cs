using System.Data.Common;
using System.Diagnostics;
using System.Globalization;

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
    ILogger<MessageCenterService> logger) : IMessageQueryService, IMessageCommandService, IMessageRealtimePublisher, IMessageAdminQueueMaintenance
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

    public Task<int> RebuildAdminQueueStateAsync()
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

    public async Task<Result<ConversationDetailResponse>> CreateAccountTicketAsync(int accountId, string subject, string body)
    {
        var normalizedSubject = NormalizeSubject(subject, "用户申诉");
        var normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        long conversationId = 0;
        long messageId = 0;
        DateTime now = DateTime.UtcNow;

        var tran = await db.Ado.UseTranAsync(async () =>
        {
            var conversation = new MessageConversation
            {
                Id = SnowFlakeSingle.Instance.NextId(),
                Subject = normalizedSubject,
                InitiatorAccountId = accountId,
                Status = ConversationStatus.Open,
                IsSystemSource = false,
                CreatedByType = MessageSenderType.Account,
                CreatedByAccountId = accountId,
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
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-create-account-ticket"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "创建会话失败");
        }

        var detail = await GetAccountConversationDetailAsync(accountId, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "会话创建后读取失败");
        }

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        ConversationMessageResponse? adminMessage = await BuildMessageResponseAsync(conversationId, messageId, MessageViewer.Admin);
        await Task.WhenAll(
            PublishConversationUpsertAsync(accountId, detail),
            adminMessage is null
                ? Task.CompletedTask
                : PublishMessageAppendAsync(detail.ConversationId, adminMessage, conversationUnreadCount: 0, totalUnread: totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        return Result<ConversationDetailResponse>.Success(detail);
    }

    public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(
        int accountId,
        long conversationId,
        long readThroughMessageId,
        string body)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Account,
            accountId,
            null,
            null,
            readThroughMessageId));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Account);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        ConversationMessageResponse? adminMessage = await BuildMessageResponseAsync(
            conversationId,
            writeOutcome.DeliveryEvent.MessageId,
            MessageViewer.Admin);
        await Task.WhenAll(
            PublishReadUpdatedAsync(accountId, conversationId, readThroughMessageId, writeOutcome.UnreadCount, totalUnread),
            adminMessage is null
                ? Task.CompletedTask
                : PublishMessageAppendAsync(conversationId.ToString(), adminMessage, writeOutcome.UnreadCount, totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        FsusObservability.RecordMessageCenterReply("account", FsusObservability.GetElapsed(startedAt));
        return Result<ConversationMessageResponse>.Success(message);
    }

    private async Task<ReplyWriteOutcome> WriteReplyAsync(ReplyWriteCommand command)
    {
        DateTime now = DateTime.UtcNow;
        long messageId = SnowFlakeSingle.Instance.NextId();
        ReplyWriteOutcome outcome = ReplyWriteOutcome.NotFound;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
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
        long? ReadThroughMessageId);

    private readonly record struct ReplyDeliveryEvent(
        long ConversationId,
        long MessageId,
        MessageSenderType SenderType,
        DateTime CreatedAt);

    private readonly record struct ReplyWriteOutcome(
        ReplyWriteStatus Status,
        int UnreadCount,
        ReplyDeliveryEvent DeliveryEvent)
    {
        public static ReplyWriteOutcome NotFound => new(ReplyWriteStatus.NotFound, 0, default);
        public static ReplyWriteOutcome Forbidden => new(ReplyWriteStatus.Forbidden, 0, default);
        public static ReplyWriteOutcome Closed => new(ReplyWriteStatus.Closed, 0, default);
        public static ReplyWriteOutcome Conflict => new(ReplyWriteStatus.Conflict, 0, default);
        public static ReplyWriteOutcome CursorRegression => new(ReplyWriteStatus.CursorRegression, 0, default);
        public static ReplyWriteOutcome ReadTargetNotVisible => new(ReplyWriteStatus.ReadTargetNotVisible, 0, default);
        public static ReplyWriteOutcome InfraFailure => new(ReplyWriteStatus.InfraFailure, 0, default);
        public static ReplyWriteOutcome Succeeded(int unreadCount, ReplyDeliveryEvent deliveryEvent)
            => new(ReplyWriteStatus.Succeeded, unreadCount, deliveryEvent);
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

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        await PublishReadUpdatedAsync(accountId, conversationId, readResult.LastMessageId, readResult.UnreadCount, totalUnread);
        return Result.Success();
    }

    private sealed record MarkConversationReadResult(ReadAdvanceOutcome Outcome, long? LastMessageId, int UnreadCount);

    public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(long conversationId, string body, AdminMessageActor adminActor)
    {
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        ReplyWriteOutcome writeOutcome = await WriteReplyAsync(new ReplyWriteCommand(
            conversationId,
            normalizedBody,
            MessageSenderType.Admin,
            null,
            adminActor.AdminPrincipalId,
            adminActor.AdminSessionId,
            null));
        if (writeOutcome.Status != ReplyWriteStatus.Succeeded)
        {
            return MapReplyWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, writeOutcome.DeliveryEvent.MessageId, MessageViewer.Admin);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        var participants = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.ConversationId == conversationId)
            .ToListAsync();
        await PublishParticipantMessageFanoutAsync(conversationId, message, participants);
        await PublishConversationUpsertToAdminsAsync(conversationId);
        return Result<ConversationMessageResponse>.Success(message);
    }

    public async Task<Result> UpdateConversationStatusAsync(long conversationId, ConversationStatusValue status, AdminMessageActor adminActor)
    {
        var now = DateTime.UtcNow;
        ConversationStatusUpdateState? currentState = await LoadConversationStatusUpdateStateAsync(conversationId);
        if (currentState is null)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
        }

        int affected = await TryUpdateConversationStatusAsync(conversationId, status, currentState, now);
        if (affected <= 0)
        {
            return Result.Failure(ErrorCode.Conflict, "会话状态已被其他管理员修改");
        }

        var participants = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.ConversationId == conversationId)
            .Select(it => it.AccountId)
            .ToListAsync();
        var publishTasks = new List<Task>(participants.Count + 1);
        for (int i = 0; i < participants.Count; i++)
        {
            publishTasks.Add(PublishConversationClosedAsync(participants[i], conversationId, status));
        }

        publishTasks.Add(PublishConversationUpsertToAdminsAsync(conversationId));
        await Task.WhenAll(publishTasks);
        return Result.Success();
    }

    private sealed record ConversationStatusUpdateState(ConversationStatus Status, string RowVersion);

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

    public async Task<Result<ConversationDetailResponse>> SendSystemMessageAsync(string subject, string body, long? targetAccountId, AdminMessageActor adminActor)
    {
        if (!targetAccountId.HasValue || targetAccountId.Value <= 0)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.Validation, "目标账号不能为空");
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
        DateTime now = DateTime.UtcNow;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await db.Insertable(new MessageConversation
            {
                Id = conversationId,
                Subject = normalizedSubject,
                InitiatorAccountId = target,
                Status = ConversationStatus.Open,
                IsSystemSource = true,
                SourceMessageId = null,
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
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-send-system-message"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建失败");
        }

        int totalUnread = await RefreshUnreadCacheAsync(target);
        var detail = await GetAccountConversationDetailAsync(target, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建后读取失败");
        }

        await Task.WhenAll(
            PublishAccountConversationUpsertThenMessageAppendAsync(target, detail, totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        return Result<ConversationDetailResponse>.Success(detail);
    }

    public async Task SendAccountTransactionalNoticeAsync(int accountId, string subject, string body)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(subject, body, accountId, AdminMessageActor.System),
            "send-account-transactional-notice",
            accountId);

    public async Task SendCommentDeletedNoticeAsync(int targetAccountId, string articleTitle, string commentSnippet, string reason)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync("评论处理通知", $"您在《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}", targetAccountId, AdminMessageActor.System),
            "send-comment-deleted-notice",
            targetAccountId);

    public async Task SendAccountBannedNoticeAsync(int accountId, string reason)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync("账号处罚通知", $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}", accountId, AdminMessageActor.System),
            "send-account-banned-notice",
            accountId);
        await PushAccountStatusAsync(accountId, 1, reason);
    }

    public async Task SendAccountUnbannedNoticeAsync(int accountId)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync("账号恢复通知", "您已解除账户管控。", accountId, AdminMessageActor.System),
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

    private Task PublishConversationUpsertAsync(int accountId, ConversationListItemResponse summary, int? totalUnread = null)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxConversationUpsert,
            accountId,
            new InboxConversationUpsertPayload(summary, totalUnread, DateTime.UtcNow),
            "inbox-conversation-upsert");

    private async Task PublishConversationUpsertToAdminsAsync(long conversationId)
    {
        if (!IsAdminAccountProjectionEnabled())
        {
            return;
        }

        AdminConversationListItemResponse? summary = await BuildAdminConversationListItemAsync(conversationId);
        if (summary is null)
        {
            logger.LogWarning("Admin conversation projection missing. ConversationId: {ConversationId}", conversationId);
            return;
        }

        await notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationUpsert,
            new InboxConversationUpsertPayload(summary, null, DateTime.UtcNow),
            "admin-conversation-upsert");
    }

    private Task PublishMessageAppendAsync(string conversationId, ConversationMessageResponse message, int? conversationUnreadCount = null, int? totalUnread = null, int? targetAccountId = null)
    {
        var payload = new InboxMessageAppendPayload(conversationId, message, conversationUnreadCount, totalUnread, DateTime.UtcNow);
        if (targetAccountId.HasValue)
        {
            return notificationStreamPort.PublishToUserAsync(NotificationStreamEventType.InboxMessageAppend, targetAccountId.Value, payload, "inbox-message-append-user");
        }

        return notificationStreamPort.PublishToAdminUsersAsync(NotificationStreamEventType.InboxMessageAppend, payload, "inbox-message-append-admin");
    }

    private Task PublishReadUpdatedAsync(int accountId, long conversationId, long? lastReadMessageId, int conversationUnreadCount, int? totalUnread)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxReadUpdated,
            accountId,
            new InboxReadUpdatedPayload(conversationId.ToString(), lastReadMessageId?.ToString(), conversationUnreadCount, totalUnread, DateTime.UtcNow),
            "inbox-read-updated");

    private Task PublishConversationClosedAsync(int accountId, long conversationId, ConversationStatusValue status)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.InboxConversationClosed,
            accountId,
            new InboxConversationClosedPayload(conversationId.ToString(), status, DateTime.UtcNow),
            "inbox-conversation-closed");

    private Task PublishConversationClosedToAdminsAsync(long conversationId, ConversationStatusValue status)
        => notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationClosed,
            new InboxConversationClosedPayload(conversationId.ToString(), status, DateTime.UtcNow),
            "inbox-conversation-closed-admin");

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
