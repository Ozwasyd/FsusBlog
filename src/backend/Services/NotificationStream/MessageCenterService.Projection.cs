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
            new InboxConversationUpsertPayload(ToRealtimeConversationReference(summary), totalUnread, UtcNow),
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
            new InboxConversationUpsertPayload(ToRealtimeConversationReference(summary), null, UtcNow),
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
        var payload = new InboxMessageAppendPayload(
            conversationId,
            message with
            {
                Body = string.Empty
            },
            conversationUnreadCount,
            totalUnread,
            UtcNow);
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
            new InboxReadUpdatedPayload(conversationId.ToString(), lastReadMessageId?.ToString(), conversationUnreadCount, totalUnread, UtcNow),
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
            new InboxConversationStatusChangedPayload(conversationId.ToString(), status, UtcNow),
            "inbox-conversation-status-changed",
            idempotencyKey);

    private Task PublishConversationStatusChangedToAdminsAsync(
        long conversationId,
        ConversationStatusValue status,
        string? idempotencyKey = null)
        => notificationStreamPort.PublishToAdminUsersAsync(
            NotificationStreamEventType.InboxConversationStatusChanged,
            new InboxConversationStatusChangedPayload(conversationId.ToString(), status, UtcNow),
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
}
