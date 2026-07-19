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

public sealed partial class MessageCenterService
{
    public async Task<PageResponse<ConversationListItemResponse>> GetAccountConversationsAsync(
        int accountId,
        int size,
        string? filter,
        MessageConversationCursor? cursor,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

    public async Task<ConversationDetailResponse?> GetAccountConversationDetailAsync(
        int accountId,
        long conversationId,
        long? beforeMessageId = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

    public async Task<ConversationDetailResponse?> GetAccountConversationDeltaAsync(
        int accountId,
        long conversationId,
        long afterMessageId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

        ConversationMessagePage page = await LoadConversationMessageDeltaPageAsync(
            conversationId,
            afterMessageId,
            MessageViewer.Account);
        return new ConversationDetailResponse
        {
            ConversationId = conversation.Id.ToString(),
            ReadSnapshotMessageId = page.Messages.Count > 0
                ? page.Messages[^1].MessageId
                : afterMessageId.ToString(CultureInfo.InvariantCulture),
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
        MessageConversationCursor? cursor,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

    public async Task<AdminConversationDetailResponse?> GetAdminConversationDetailAsync(
        long conversationId,
        long? beforeMessageId = null,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
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

    private async Task<ConversationMessagePage> LoadConversationMessageDeltaPageAsync(
        long conversationId,
        long afterMessageId,
        MessageViewer viewer)
    {
        var rows = await db.Queryable<ConversationMessage>()
            .Where(it => it.ConversationId == conversationId && !it.IsInternalNote && it.Id > afterMessageId)
            .OrderBy(it => it.Id, OrderByType.Asc)
            .Take(ConversationDetailPageSize + 1)
            .ToListAsync();
        bool hasMore = rows.Count > ConversationDetailPageSize;
        if (hasMore)
        {
            rows.RemoveAt(rows.Count - 1);
        }

        List<ConversationMessageResponse> messages = await MapMessagesAsync(rows, viewer);
        string? continuationCursor = hasMore && rows.Count > 0
            ? rows[^1].Id.ToString(CultureInfo.InvariantCulture)
            : null;
        return new ConversationMessagePage(messages, continuationCursor, hasMore);
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
                   senderadminsessionauditreference,
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
            BodyPreview = MessageContentPolicy.CreatePreview(message.Body),
            CreatedAt = message.CreatedAt
        };
    }
}
