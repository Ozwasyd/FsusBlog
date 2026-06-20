using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
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

    public async Task<PageResponse<ConversationListItemResponse>> GetUserConversationsAsync(int accountId, int page, int size, string? filter)
    {
        int pageNum = Math.Max(1, page);
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 50);
        var query = db.Queryable<ConversationParticipantState, MessageConversation>(
            (p, c) => p.ConversationId == c.Id)
            .Where((p, c) => p.AccountId == accountId);

        query = ApplyUserFilter(query, filter);
        int total = await query.CountAsync();
        var rows = await query
            .OrderBy((p, c) => c.LastMessageAt, OrderByType.Desc)
            .Select((p, c) => new UserConversationRow
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
        return new PageResponse<ConversationListItemResponse> { Items = items, Total = total };
    }

    public async Task<ConversationDetailResponse?> GetUserConversationDetailAsync(int accountId, long conversationId)
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
        int pageNum = Math.Max(1, page);
        int pageSize = Math.Clamp(size <= 0 ? 20 : size, 1, 100);
        var query = db.Queryable<MessageConversation>();

        if (!string.IsNullOrWhiteSpace(filter))
        {
            switch (filter.Trim().ToLowerInvariant())
            {
                case "system":
                    query = query.Where(it => it.IsSystemSource);
                    break;
                case "open":
                    query = query.Where(it => it.Status == ConversationStatus.Open);
                    break;
                case "pending":
                    query = query.Where(it => it.Status == ConversationStatus.Pending);
                    break;
                case "closed":
                    query = query.Where(it => it.Status == ConversationStatus.Closed);
                    break;
            }
        }

        int total = await query.CountAsync();
        var rows = await query
            .OrderByDescending(it => it.LastMessageAt)
            .Select(it => new UserConversationRow
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

    public async Task<Result<ConversationDetailResponse>> CreateUserTicketAsync(int accountId, string subject, string body)
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
                CreatedByType = MessageSenderType.User,
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
                SenderType = MessageSenderType.User,
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

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-create-user-ticket"))
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "创建会话失败");
        }

        var detail = await GetUserConversationDetailAsync(accountId, conversationId);
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

    public async Task<Result<ConversationMessageResponse>> ReplyAsUserAsync(int accountId, long conversationId, string body)
    {
        string normalizedBody = NormalizeBody(body);
        if (normalizedBody.Length == 0)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Validation, "内容不能为空");
        }

        var conversation = await db.Queryable<MessageConversation>().InSingleAsync(conversationId);
        if (conversation is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.NotFound, "会话不存在");
        }

        if (conversation.Status == ConversationStatus.Closed)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Conflict, "会话已关闭");
        }

        var participant = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.ConversationId == conversationId && it.AccountId == accountId)
            .FirstAsync();
        if (participant is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.Forbidden, "无权访问该会话");
        }

        long messageId = SnowFlakeSingle.Instance.NextId();
        DateTime now = DateTime.UtcNow;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            await db.Insertable(new ConversationMessage
            {
                Id = messageId,
                ConversationId = conversationId,
                SenderType = MessageSenderType.User,
                SenderAccountId = accountId,
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
                    LastReadMessageId = messageId,
                    LastReadAt = now,
                    UpdatedAt = now,
                    UnreadCount = 0
                })
                .Where(it => it.ConversationId == conversationId && it.AccountId == accountId)
                .ExecuteCommandAsync();
        });

        if (!TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "message-center-reply-user"))
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        var message = await BuildMessageResponseAsync(conversationId, messageId);
        if (message is null)
        {
            return Result<ConversationMessageResponse>.Failure(ErrorCode.InfraFailure, "回复写入失败");
        }

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        await Task.WhenAll(
            PublishReadUpdatedAsync(participant.AccountId, conversationId, messageId, 0, totalUnread),
            PublishMessageAppendAsync(conversationId.ToString(), message, 0, totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        return Result<ConversationMessageResponse>.Success(message);
    }

    public async Task<Result> MarkConversationReadAsync(int accountId, long conversationId)
    {
        var state = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.AccountId == accountId && it.ConversationId == conversationId)
            .FirstAsync();
        if (state is null)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
        }

        DateTime now = DateTime.UtcNow;
        await db.Updateable<ConversationParticipantState>()
            .SetColumns(it => new ConversationParticipantState
            {
                UnreadCount = 0,
                LastReadMessageId = SqlFunc.Subqueryable<ConversationMessage>()
                    .Where(message => message.ConversationId == conversationId)
                    .Max(message => message.Id),
                LastReadAt = now,
                UpdatedAt = now
            })
            .Where(it => it.AccountId == accountId && it.ConversationId == conversationId)
            .ExecuteCommandAsync();

        long? lastMessageId = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.AccountId == accountId && it.ConversationId == conversationId)
            .Select(it => it.LastReadMessageId)
            .FirstAsync();

        int totalUnread = await RefreshUnreadCacheAsync(accountId);
        await PublishReadUpdatedAsync(accountId, conversationId, lastMessageId, 0, totalUnread);
        return Result.Success();
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
        int affected = await db.Updateable<MessageConversation>()
            .SetColumns(it => new MessageConversation
            {
                Status = ToStatusEntity(status),
                UpdatedAt = now
            })
            .Where(it => it.Id == conversationId)
            .ExecuteCommandAsync();
        if (affected <= 0)
        {
            return Result.Failure(ErrorCode.NotFound, "会话不存在");
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
        var detail = await GetUserConversationDetailAsync(target, conversationId);
        if (detail is null)
        {
            return Result<ConversationDetailResponse>.Failure(ErrorCode.InfraFailure, "系统消息创建后读取失败");
        }

        await Task.WhenAll(
            PublishUserConversationUpsertThenMessageAppendAsync(target, detail, totalUnread),
            PublishConversationUpsertToAdminsAsync(conversationId));
        return Result<ConversationDetailResponse>.Success(detail);
    }

    public async Task SendUserTransactionalNoticeAsync(int accountId, string subject, string body)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync(subject, body, accountId, AdminMessageActor.System),
            "send-user-transactional-notice",
            accountId);

    public async Task SendCommentDeletedNoticeAsync(int targetAccountId, string articleTitle, string commentSnippet, string reason)
        => await LogNotificationFailureAsync(
            await SendSystemMessageAsync("评论处理通知", $"您在《{articleTitle}》下的评论「{commentSnippet}...」已被管理员移除。原因：{reason}", targetAccountId, AdminMessageActor.System),
            "send-comment-deleted-notice",
            targetAccountId);

    public async Task SendUserBannedNoticeAsync(int accountId, string reason)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync("账号处罚通知", $"您的账号已被封禁，当前仅保留只读权限。原因：{reason}", accountId, AdminMessageActor.System),
            "send-user-banned-notice",
            accountId);
        await PushUserStatusAsync(accountId, 1, reason);
    }

    public async Task SendUserUnbannedNoticeAsync(int accountId)
    {
        await LogNotificationFailureAsync(
            await SendSystemMessageAsync("账号恢复通知", "您已解除账户管控。", accountId, AdminMessageActor.System),
            "send-user-unbanned-notice",
            accountId);
        await PushUserStatusAsync(accountId, 0, null);
    }

    public Task PushUserStatusAsync(long userId, int status, string? reason)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.UserStatusChanged,
            userId,
            new UserStatusPayload(status, reason, DateTime.UtcNow),
            "push-user-status");

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

    private async Task<List<ConversationListItemResponse>> BuildConversationListAsync(List<UserConversationRow> rows, bool includeUnread)
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

        var latestRows = await db.Queryable<ConversationMessage>()
            .Where(it => conversationIds.Contains(it.ConversationId) && !it.IsInternalNote)
            .GroupBy(it => it.ConversationId)
            .Select(it => new
            {
                it.ConversationId,
                MessageId = SqlFunc.AggregateMax(it.Id)
            })
            .ToListAsync();
        if (latestRows.Count == 0)
        {
            return [];
        }

        long[] messageIds = new long[latestRows.Count];
        for (int i = 0; i < latestRows.Count; i++)
        {
            messageIds[i] = latestRows[i].MessageId;
        }

        var rows = await db.Queryable<ConversationMessage>()
            .Where(it => messageIds.Contains(it.Id))
            .ToListAsync();

        var mapped = await MapMessagesAsync(rows);
        var mappedByMessageId = new Dictionary<long, ConversationMessagePreviewResponse>(mapped.Count);
        for (int i = 0; i < mapped.Count; i++)
        {
            ConversationMessageResponse item = mapped[i];
            mappedByMessageId[long.Parse(item.MessageId)] = ToMessagePreview(item)!;
        }

        return BuildLatestMessageMap(
            [.. latestRows.Select(static row => (row.ConversationId, row.MessageId))],
            mappedByMessageId);
    }

    private static long[] CollectConversationIds(IReadOnlyList<UserConversationRow> rows)
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

    private static Task<List<ConversationMessageResponse>> MapMessagesAsync(List<ConversationMessage> rows)
    {
        if (rows.Count == 0)
        {
            return Task.FromResult<List<ConversationMessageResponse>>([]);
        }

        if (rows.Count > 1)
        {
            rows.Sort(static (left, right) => left.Id.CompareTo(right.Id));
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

    private async Task<ConversationListItemResponse?> BuildConversationListItemForUserAsync(int accountId, long conversationId)
    {
        var rows = await db.Queryable<ConversationParticipantState, MessageConversation>(
            (p, c) => p.ConversationId == c.Id)
            .Where((p, c) => p.AccountId == accountId && c.Id == conversationId)
            .Select((p, c) => new UserConversationRow
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

        var tasks = new List<Task>(participants.Count);
        for (int i = 0; i < participants.Count; i++)
        {
            ConversationParticipantState participant = participants[i];
            int totalUnread = await RefreshUnreadCacheAsync(participant.AccountId);
            ConversationListItemResponse? item = await BuildConversationListItemForUserAsync(participant.AccountId, conversationId);
            tasks.Add(PublishPreparedParticipantMessageAsync(conversationId, message, participant, item, totalUnread));
        }

        await Task.WhenAll(tasks);
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

        await PublishMessageAppendAsync(conversationId.ToString(), message, participant.UnreadCount + 1, totalUnread, participant.AccountId);
    }

    private async Task PublishUserConversationUpsertThenMessageAppendAsync(
        int target,
        ConversationDetailResponse detail,
        int totalUnread)
    {
        await PublishConversationUpsertAsync(target, detail, totalUnread);
        await PublishMessageAppendAsync(detail.ConversationId, detail.Messages.Last(), 1, totalUnread, target);
    }

    private async Task<int> RefreshUnreadCacheAsync(int accountId)
    {
        int unread = await db.Queryable<ConversationParticipantState>()
            .Where(it => it.AccountId == accountId)
            .SumAsync(it => it.UnreadCount);
        await cache.SetUnreadAsync(accountId, unread);
        return unread;
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
            MessageSenderType.User => ConversationSenderValue.User,
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

    private static ISugarQueryable<ConversationParticipantState, MessageConversation> ApplyUserFilter(
        ISugarQueryable<ConversationParticipantState, MessageConversation> query,
        string? filter)
    {
        if (string.IsNullOrWhiteSpace(filter))
        {
            return query;
        }

        return filter.Trim().ToLowerInvariant() switch
        {
            "unread" => query.Where((p, _) => p.UnreadCount > 0),
            "system" => query.Where((_, c) => c.IsSystemSource),
            "open" => query.Where((_, c) => c.Status == ConversationStatus.Open),
            "pending" => query.Where((_, c) => c.Status == ConversationStatus.Pending),
            "closed" => query.Where((_, c) => c.Status == ConversationStatus.Closed),
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

    private Task LogNotificationFailureAsync(Result<ConversationDetailResponse> result, string operation, int userId)
    {
        if (result.IsFailure)
        {
            logger.LogWarning(
                "Message notification failed. Operation: {Operation} | UserId: {UserId} | Code: {Code} | Message: {Message}",
                operation,
                userId,
                result.Error.Code,
                result.Error.Message);
        }

        return Task.CompletedTask;
    }

    private sealed class UserConversationRow
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
}
