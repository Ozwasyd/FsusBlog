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
    public Task PushAccountStatusAsync(long accountId, int status, string? reason)
        => notificationStreamPort.PublishToUserAsync(
            NotificationStreamEventType.AccountStatusChanged,
            accountId,
            new AccountStatusPayload(status, reason, UtcNow),
            "push-account-status");

    public Task PushCommentRemoveAsync(int articleId, long commentId, long? rootId, long? parentId, string? idempotencyKey = null)
        => notificationStreamPort.PublishToContentFeedAsync(
            NotificationStreamEventType.CommentRemoved,
            new CommentRemovedPayload(articleId, commentId.ToString(), rootId?.ToString(), parentId?.ToString(), UtcNow),
            "push-comment-removed",
            idempotencyKey);

    public Task PushCommentAddAsync(CommentAddedNotifyDto payload, string? idempotencyKey = null)
        => notificationStreamPort.PublishToContentFeedAsync(NotificationStreamEventType.CommentAdded, payload, "push-comment-added", idempotencyKey);

    public Task PushCacheControlAsync(CacheControlPayload payload)
        => notificationStreamPort.PublishToContentFeedAsync(NotificationStreamEventType.CacheControl, payload, "push-cache-control");

    public Task PushArticleChangedAsync(ArticleNoticeDto payload, string? idempotencyKey = null)
        => notificationStreamPort.PublishToContentFeedAsync(
            NotificationStreamEventType.ArticleChanged,
            payload,
            "push-article-changed",
            idempotencyKey);



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

    private MessageMutationOutbox CreateDelivery(
        long mutationCoordinate,
        string eventKind,
        string audienceKind,
        int? targetAccountId,
        long conversationId,
        long? messageId,
        long? readThroughMessageId,
        ConversationStatus? conversationStatus = null)
    {
        DateTime now = UtcNow;
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
}
