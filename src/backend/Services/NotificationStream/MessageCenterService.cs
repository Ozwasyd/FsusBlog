using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.NotificationStream;
using SqlSugar;

namespace FsusBlog.Server.Services.NotificationStream;

public sealed class MessageCenterService(
    ISqlSugarClient db,
    MessageCacheService cache,
    IMessageNotificationStreamPort notificationStreamPort,
    ILogger<MessageCenterService> logger) : IMessageQueryService, IMessageCommandService, IMessageRealtimePublisher
{
    private const int MaxSubjectLength = 160;
    private const int MaxBodyLength = 4000;

    public async Task<PageResponse<ConversationListItemResponse>> GetAccountConversationsAsync(int accountId, int page, int size, string? filter)
    {
        long startedAt = Stopwatch.GetTimestamp();
        int pageNum = Math.Max(1, page);
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
        int total = await BuildAccountConversationQuery(accountId, filter).CountAsync();
        List<AccountConversationRow> rows = await BuildAccountConversationQuery(accountId, filter)
            .OrderBy((p, c) => c.LastMessageAt, OrderByType.Desc)
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
            .Skip((pageNum - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();

        var items = await BuildConversationListAsync(rows, includeUnread: true);
        FsusObservability.RecordMessageCenterList("account", FsusObservability.GetElapsed(startedAt));
        return new PageResponse<ConversationListItemResponse> { Items = items, Total = total };
    }

    public async Task<ConversationDetailResponse?> GetAccountConversationDetailAsync(int accountId, long conversationId)
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

        var messages = await LoadConversationMessagesAsync(conversationId);
        return new ConversationDetailResponse
        {
            ConversationId = conversation.Id.ToString(),
            Subject = conversation.Subject,
            Status = ToStatusValue(conversation.Status),
            IsSystemSource = conversation.IsSystemSource,
            CanReply = conversation.Status != ConversationStatus.Closed,
            UnreadCount = participant.UnreadCount,
            LastMessageAt = conversation.LastMessageAt,
            Messages = messages
        };
    }

    public async Task<PageResponse<ConversationListItemResponse>> GetAdminConversationsAsync(int page, int size, string? filter)
    {
        long startedAt = Stopwatch.GetTimestamp();
        int pageNum = Math.Max(1, page);
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
        int total = await BuildAdminConversationQuery(filter).CountAsync();
        List<AccountConversationRow> rows = await BuildAdminConversationQuery(filter)
            .OrderByDescending(it => it.LastMessageAt)
            .Select(it => new AccountConversationRow
            {
                ConversationId = it.Id,
                Subject = it.Subject,
                Status = it.Status,
                IsSystemSource = it.IsSystemSource,
                UnreadCount = 0,
                LastMessageAt = it.LastMessageAt,
                UpdatedAt = it.UpdatedAt
            })
            .Skip((pageNum - 1) * pageSize)
            .Take(pageSize)
            .ToListAsync();

        var unreadMap = await GetConversationUnreadMapAsync(CollectConversationIds(rows));
        foreach (var row in rows)
        {
            if (unreadMap.TryGetValue(row.ConversationId, out int unread))
            {
                row.UnreadCount = unread;
            }
        }

        var items = await BuildConversationListAsync(rows, includeUnread: true);
        FsusObservability.RecordMessageCenterList("admin", FsusObservability.GetElapsed(startedAt));
        return new PageResponse<ConversationListItemResponse> { Items = items, Total = total };
    }

    public async Task<ConversationDetailResponse?> GetAdminConversationDetailAsync(long conversationId)
    {
        var conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return null;
        }

        int unreadCount = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.ConversationId == conversationId)
            .SumAsync(it => it.UnreadCount);
        var messages = await LoadConversationMessagesAsync(conversationId);
        return new ConversationDetailResponse
        {
            ConversationId = conversation.Id.ToString(),
            Subject = conversation.Subject,
            Status = ToStatusValue(conversation.Status),
            IsSystemSource = conversation.IsSystemSource,
            CanReply = conversation.Status != ConversationStatus.Closed,
            UnreadCount = unreadCount,
            LastMessageAt = conversation.LastMessageAt,
            Messages = messages
        };
    }

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
        await Task.WhenAll(
            PublishConversationUpsertAsync(accountId, detail),
            PublishMessageAppendAsync(detail.ConversationId, detail.Messages.Last(), conversationUnreadCount: 0, totalUnread: totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        return Result<ConversationDetailResponse>.Success(detail);
    }

    public async Task<Result<ConversationMessageResponse>> ReplyAsAccountAsync(int accountId, long conversationId, string body)
    {
        long startedAt = Stopwatch.GetTimestamp();
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        long messageId = SnowFlakeSingle.Instance.NextId();
        DateTime now = DateTime.UtcNow;
        ReplyAccountWriteOutcome writeOutcome = ReplyAccountWriteOutcome.NotFound;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            ReplyLocks? locks = await LoadReplyLocksForUpdateAsync(conversationId, accountId);
            ReplyConversationLock? conversation = locks?.Conversation;
            if (conversation is null)
            {
                writeOutcome = ReplyAccountWriteOutcome.NotFound;
                return;
            }

            if (conversation.Status == ConversationStatus.Closed)
            {
                writeOutcome = ReplyAccountWriteOutcome.Closed;
                return;
            }

            ReplyParticipantLock? participant = locks?.Participant;
            if (participant is null)
            {
                writeOutcome = ReplyAccountWriteOutcome.Forbidden;
                return;
            }

            bool conversationUpdated = await TryUpdateReplyConversationActivityAsync(conversationId, now);
            if (!conversationUpdated)
            {
                writeOutcome = ReplyAccountWriteOutcome.Closed;
                return;
            }

            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Account,
                SenderAccountId = accountId,
                Body = normalizedBody,
                CreatedAt = now
            }).ExecuteCommandAsync();

            bool participantUpdated = await TryMarkReplyParticipantReadAsync(participant, messageId, now);
            if (!participantUpdated)
            {
                throw new ReplyParticipantConcurrencyException(conversationId, accountId);
            }

            writeOutcome = ReplyAccountWriteOutcome.Accepted;
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-reply-account"))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }
        if (writeOutcome != ReplyAccountWriteOutcome.Accepted)
        {
            return MapReplyAccountWriteOutcome(writeOutcome);
        }

        var message = await BuildMessageResponseAsync(conversationId, messageId);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        await Task.WhenAll(
            PublishReadUpdatedAsync(accountId, conversationId, messageId, 0, totalUnread),
            PublishMessageAppendAsync(conversationId.ToString(), message, 0, totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        FsusObservability.RecordMessageCenterReply("account", FsusObservability.GetElapsed(startedAt));
        return Result<ConversationMessageResponse>.Success(message);
    }

    private async Task<ReplyLocks?> LoadReplyLocksForUpdateAsync(long conversationId, int accountId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH locked_conversation AS (
                SELECT id,
                       status
                FROM msg_conversation
                WHERE id = @ConversationId
                FOR UPDATE
            ),
            locked_participant AS (
                SELECT conversationid,
                       accountid,
                       lastreadmessageid
                FROM msg_participant_state
                WHERE conversationid = @ConversationId
                  AND accountid = @AccountId
                FOR UPDATE
            )
            SELECT c.id,
                   c.status,
                   p.conversationid,
                   p.accountid,
                   p.lastreadmessageid
            FROM locked_conversation c
            LEFT JOIN locked_participant p ON true;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@AccountId", accountId));
        if (!await reader.ReadAsync())
        {
            return null;
        }

        var conversation = new ReplyConversationLock(
            reader.GetInt64(0),
            (ConversationStatus)reader.GetInt32(1));
        ReplyParticipantLock? participant = reader.IsDBNull(2)
            ? null
            : new ReplyParticipantLock(
                reader.GetInt64(2),
                reader.GetInt32(3),
                reader.IsDBNull(4) ? null : reader.GetInt64(4));
        return new ReplyLocks(conversation, participant);
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
            reader.GetInt64(0),
            (ConversationStatus)reader.GetInt32(1));
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
            reader.GetInt64(0),
            reader.GetInt32(1),
            reader.IsDBNull(2) ? null : reader.GetInt64(2));
    }

    private async Task<bool> TryUpdateReplyConversationActivityAsync(long conversationId, DateTime now)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_conversation
            SET updatedat = @Now,
                lastmessageat = @Now
            WHERE id = @ConversationId
              AND status <> @ClosedStatus;
            """,
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@Now", now),
            new SugarParameter("@ClosedStatus", (int)ConversationStatus.Closed));
        return updated > 0;
    }

    private async Task<bool> TryMarkReplyParticipantReadAsync(ReplyParticipantLock participant, long messageId, DateTime now)
    {
        if (participant.LastReadMessageId is null)
        {
            int updated = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE msg_participant_state
                SET lastreadmessageid = @MessageId,
                    lastreadat = @Now,
                    updatedat = @Now,
                    unreadcount = 0
                WHERE conversationid = @ConversationId
                  AND accountid = @AccountId
                  AND lastreadmessageid IS NULL;
                """,
                new SugarParameter("@ConversationId", participant.ConversationId),
                new SugarParameter("@AccountId", participant.AccountId),
                new SugarParameter("@MessageId", messageId),
                new SugarParameter("@Now", now));
            return updated > 0;
        }

        int matched = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE msg_participant_state
            SET lastreadmessageid = @MessageId,
                lastreadat = @Now,
                updatedat = @Now,
                unreadcount = 0
            WHERE conversationid = @ConversationId
              AND accountid = @AccountId
              AND lastreadmessageid = @PreviousLastReadMessageId;
            """,
            new SugarParameter("@ConversationId", participant.ConversationId),
            new SugarParameter("@AccountId", participant.AccountId),
            new SugarParameter("@PreviousLastReadMessageId", participant.LastReadMessageId.Value),
            new SugarParameter("@MessageId", messageId),
            new SugarParameter("@Now", now));
        return matched > 0;
    }

    private static Result<ConversationMessageResponse> MapReplyAccountWriteOutcome(ReplyAccountWriteOutcome outcome)
        => outcome switch
        {
            ReplyAccountWriteOutcome.Forbidden => Result<ConversationMessageResponse>.Failure(ErrorCode.Forbidden, "无权访问该会话"),
            ReplyAccountWriteOutcome.Closed => Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话已关闭"),
            _ => Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "会话不存在")
        };

    private enum ReplyAccountWriteOutcome
    {
        NotFound,
        Forbidden,
        Closed,
        Accepted
    }

    private sealed record ReplyConversationLock(long Id, ConversationStatus Status);

    private sealed record ReplyParticipantLock(long ConversationId, int AccountId, long? LastReadMessageId);

    private sealed record ReplyLocks(ReplyConversationLock Conversation, ReplyParticipantLock? Participant);

    private sealed class ReplyParticipantConcurrencyException(long conversationId, int accountId)
        : InvalidOperationException($"Participant read state changed while replying. ConversationId={conversationId}; AccountId={accountId}.")
    {
    }

    public async Task<Result> MarkConversationReadAsync(int accountId, long conversationId)
    {
        DateTime now = DateTime.UtcNow;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            bool locked = await LockConversationParticipantReadStateAsync(accountId, conversationId);
            if (!locked)
            {
                return new MarkConversationReadResult(false, null);
            }

            return await MarkConversationReadAndReturnLastMessageIdAsync(accountId, conversationId, now);
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(transaction, logger, "message-center-mark-read"))
        {
            return Result.Failure(ErrorCode.InfraFailure, "标记已读失败");
        }

        MarkConversationReadResult readResult = transaction.Data;
        if (!readResult.Found)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
        }

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        await PublishReadUpdatedAsync(accountId, conversationId, readResult.LastMessageId, 0, totalUnread);
        return Result.Success();
    }

    private sealed record MarkConversationReadResult(bool Found, long? LastMessageId);

    private async Task<bool> LockConversationParticipantReadStateAsync(int accountId, long conversationId)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT 1
            FROM msg_participant_state
            WHERE accountid = @AccountId
              AND conversationid = @ConversationId
            FOR UPDATE;
            """,
            new SugarParameter("@AccountId", accountId),
            new SugarParameter("@ConversationId", conversationId));

        return await reader.ReadAsync();
    }

    private async Task<MarkConversationReadResult> MarkConversationReadAndReturnLastMessageIdAsync(
        int accountId,
        long conversationId,
        DateTime now)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE msg_participant_state state
            SET unreadcount = 0,
                lastreadmessageid = latest.last_message_id,
                lastreadat = @Now,
                updatedat = @Now
            FROM (
                SELECT MAX(id) AS last_message_id
                FROM msg_message
                WHERE conversationid = @ConversationId
            ) latest
            WHERE state.accountid = @AccountId
              AND state.conversationid = @ConversationId
            RETURNING state.lastreadmessageid;
            """,
            new SugarParameter("@AccountId", accountId),
            new SugarParameter("@ConversationId", conversationId),
            new SugarParameter("@Now", now));

        if (!await reader.ReadAsync())
        {
            return new MarkConversationReadResult(false, null);
        }

        long? lastMessageId = reader.IsDBNull(0)
            ? null
            : Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
        return new MarkConversationReadResult(true, lastMessageId);
    }

    public async Task<Result<ConversationMessageResponse>> ReplyAsAdminAsync(long conversationId, string body, AdminMessageActor adminActor)
    {
        var conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "会话不存在");
        }

        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        long messageId = SnowFlakeSingle.Instance.NextId();
        DateTime now = DateTime.UtcNow;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.Admin,
                SenderAdminPrincipalId = adminActor.AdminPrincipalId,
                SenderAdminSessionId = adminActor.AdminSessionId,
                Body = normalizedBody,
                CreatedAt = now
            }).ExecuteCommandAsync();

            await db.Updateable<MessageConversation>()
                .SetColumns(it => new MessageConversation { UpdatedAt = now, LastMessageAt = now })
                .Where(it => it.Id == conversationId)
                .ExecuteCommandAsync();

            await db.Updateable<ConversationParticipantState>()
                .SetColumns(it => new ConversationParticipantState
                {
                    UnreadCount = it.UnreadCount + 1,
                    UpdatedAt = now
                })
                .Where(it => it.ConversationId == conversationId)
                .ExecuteCommandAsync();
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-reply-admin"))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        var message = await BuildMessageResponseAsync(conversationId, messageId);
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

        publishTasks.Add(PublishConversationClosedToAdminsAsync(conversationId, status));
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
            (ConversationStatus)reader.GetInt32(0),
            reader.GetString(1));
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

    public Task PushArticleChangedAsync(ArticleNoticeDto payload)
        => notificationStreamPort.PublishToContentFeedAsync(NotificationStreamEventType.ArticleChanged, payload, "push-article-changed");

    private async Task<List<ConversationListItemResponse>> BuildConversationListAsync(List<AccountConversationRow> rows, bool includeUnread)
    {
        if (rows.Count == 0)
        {
            return [];
        }

        long[] ids = CollectConversationIds(rows);
        var lastMessageMap = await LoadLastMessageMapAsync(ids);
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

    private async Task<Dictionary<long, int>> GetConversationUnreadMapAsync(long[] conversationIds)
    {
        if (conversationIds.Length == 0)
        {
            return [];
        }

        var rows = await db.Queryable<ConversationParticipantState>()
            .Where(it => conversationIds.Contains(it.ConversationId))
            .GroupBy(it => it.ConversationId)
            .Select(it => new UnreadRow
            {
                ConversationId = it.ConversationId,
                UnreadCount = SqlFunc.AggregateSum(it.UnreadCount)
            })
            .ToListAsync();
        var unreadMap = new Dictionary<long, int>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            UnreadRow row = rows[i];
            unreadMap[row.ConversationId] = row.UnreadCount;
        }

        return unreadMap;
    }

    private async Task<List<ConversationMessageResponse>> LoadConversationMessagesAsync(long conversationId)
    {
        var rows = await db.Queryable<ConversationMessage>()
            .Where(it => it.ConversationId == conversationId && !it.IsInternalNote)
            .OrderBy(it => it.Id)
            .ToListAsync();
        return await MapMessagesAsync(rows);
    }

    private async Task<Dictionary<long, ConversationMessagePreviewResponse>> LoadLastMessageMapAsync(long[] conversationIds)
    {
        if (conversationIds.Length == 0)
        {
            return [];
        }

        List<ConversationMessage> rows = await LoadLastMessagesSingleQueryAsync(conversationIds);
        var mapped = await MapMessagesAsync(rows);
        Dictionary<long, ConversationMessagePreviewResponse> mappedByMessageId = BuildMessagePreviewMap(mapped, logger);
        var latestRows = new List<(long ConversationId, long MessageId)>(rows.Count);
        for (int i = 0; i < rows.Count; i++)
        {
            ConversationMessage row = rows[i];
            latestRows.Add((row.ConversationId, row.Id));
        }

        return BuildLatestMessageMap(latestRows, mappedByMessageId);
    }

    private async Task<List<ConversationMessage>> LoadLastMessagesSingleQueryAsync(long[] conversationIds)
    {
        var parameters = new SugarParameter[conversationIds.Length];
        var placeholders = new string[conversationIds.Length];
        for (int i = 0; i < conversationIds.Length; i++)
        {
            string name = "@ConversationId" + i.ToString(CultureInfo.InvariantCulture);
            placeholders[i] = name;
            parameters[i] = new SugarParameter(name, conversationIds[i]);
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
            ORDER BY conversationid, id DESC;
            """;
        return await db.Ado.SqlQueryAsync<ConversationMessage>(sql, parameters);
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
                SenderName = ResolveSenderName(row),
                Body = row.Body,
                CreatedAt = row.CreatedAt
            });
        }

        return Task.FromResult(result);
    }

    private async Task<ConversationMessageResponse?> BuildMessageResponseAsync(long conversationId, long messageId)
    {
        var row = await db.Queryable<ConversationMessage>()
            .Where(it => it.ConversationId == conversationId && it.Id == messageId)
            .FirstAsync();
        if (row is null)
        {
            return null;
        }

        return (await MapMessagesAsync([row])).FirstOrDefault();
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

    private Task PublishConversationUpsertToAdminsAsync(long conversationId)
    {
        return notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationUpsert,
            new InboxConversationUpsertPayload(new ConversationListItemResponse { ConversationId = conversationId.ToString() }, null, DateTime.UtcNow),
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

        var rows = await db.Queryable<ConversationParticipantState>()
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
        MessageConversation? conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
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

    private static ConversationSenderValue ToSenderValue(MessageSenderType senderType)
        => senderType switch
        {
            MessageSenderType.Account => ConversationSenderValue.Account,
            MessageSenderType.Admin => ConversationSenderValue.Admin,
            _ => ConversationSenderValue.System
        };

    private static string ResolveSenderName(ConversationMessage row)
    {
        if (row.SenderType == MessageSenderType.System)
        {
            return "系统";
        }

        return row.SenderType == MessageSenderType.Admin ? "管理员" : "你";
    }

    private static ISugarQueryable<ConversationParticipantState, MessageConversation> ApplyAccountFilter(
        ISugarQueryable<ConversationParticipantState, MessageConversation> query,
        string? filter)
    {
        if (string.IsNullOrWhiteSpace(filter))
        {
            return query;
        }

        return (TextHelpers.LowerTrimmed(filter) ?? string.Empty) switch
        {
            "unread" => query.Where((p, _) => p.UnreadCount > 0),
            "system" => query.Where((_, c) => c.IsSystemSource),
            "open" => query.Where((_, c) => c.Status == ConversationStatus.Open),
            "pending" => query.Where((_, c) => c.Status == ConversationStatus.Pending),
            "closed" => query.Where((_, c) => c.Status == ConversationStatus.Closed),
            _ => query
        };
    }

    private ISugarQueryable<ConversationParticipantState, MessageConversation> BuildAccountConversationQuery(int accountId, string? filter)
    {
        var query = db.Queryable<ConversationParticipantState, MessageConversation>(
                (p, c) => p.ConversationId == c.Id)
            .Where((p, c) => p.AccountId == accountId);
        return ApplyAccountFilter(query, filter);
    }

    private ISugarQueryable<MessageConversation> BuildAdminConversationQuery(string? filter)
    {
        var query = db.Queryable<MessageConversation>();
        if (string.IsNullOrWhiteSpace(filter))
        {
            return query;
        }

        return (TextHelpers.LowerTrimmed(filter) ?? string.Empty) switch
        {
            "system" => query.Where(it => it.IsSystemSource),
            "open" => query.Where(it => it.Status == ConversationStatus.Open),
            "pending" => query.Where(it => it.Status == ConversationStatus.Pending),
            "closed" => query.Where(it => it.Status == ConversationStatus.Closed),
            _ => query
        };
    }

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
        public long ConversationId { get; set; }
        public string Subject { get; set; } = string.Empty;
        public ConversationStatus Status { get; set; }
        public bool IsSystemSource { get; set; }
        public int UnreadCount { get; set; }
        public DateTime LastMessageAt { get; set; }
        public DateTime UpdatedAt { get; set; }
    }

    private sealed class UnreadRow
    {
        public long ConversationId { get; set; }
        public int UnreadCount { get; set; }
    }

    private sealed record ParticipantMessageFanoutPayload(
        ConversationParticipantState Participant,
        ConversationListItemResponse? Item,
        int TotalUnread);

    private sealed class AccountUnreadRow
    {
        public int AccountId { get; set; }
        public int UnreadCount { get; set; }
    }
}
