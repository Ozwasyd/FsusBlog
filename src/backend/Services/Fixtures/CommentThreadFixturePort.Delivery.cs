using System.Globalization;
using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Background;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services.Fixtures;

public sealed record CommentFixtureConsumerObservation(
    string Consumer,
    string Status,
    int AttemptCount,
    long LeaseGeneration,
    string? OwnerWorkerId,
    DateTime? CompletedAtUtc,
    string? ResultDigest,
    string? LastFailureKind);

public sealed record CommentFixtureOutboxObservation(
    string EventId,
    string EventType,
    string Status,
    int AttemptCount,
    long LeaseGeneration,
    string? ClaimedBy,
    DateTime OccurredAtUtc,
    DateTime? ProcessedAtUtc,
    IReadOnlyList<string> RequiredConsumers,
    IReadOnlyList<string> MissingConsumers,
    IReadOnlyList<CommentFixtureConsumerObservation> Consumers);

public sealed record CommentFixtureQueueItemObservation(
    string CommentId,
    [property: JsonConverter(typeof(JsonStringEnumConverter))] CommentModerationStatus Status,
    string ContentDigest);

public sealed record CommentFixtureAdminQueueObservation(
    IReadOnlyList<CommentFixtureQueueItemObservation> Items,
    IReadOnlyList<CommentFixtureQueueLeaseObservation> Leases,
    bool HasNextPage);

public sealed record CommentFixtureQueueLeaseObservation(
    string CommentId,
    string CommentRowVersion,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long? OwnerAdminPrincipalId,
    int? ClaimGeneration,
    string? ClaimRowVersion,
    DateTime? LeaseExpiresAtUtc);

public sealed record CommentFixtureReplyNoticeObservation(
    string EventId,
    [property: JsonNumberHandling(JsonNumberHandling.WriteAsString | JsonNumberHandling.AllowReadingFromString)] long SourceMessageId,
    int? CurrentEligibleRecipientAccountId,
    string ConversationId,
    int? ObservedRecipientAccountId,
    bool IsSystemSource,
    bool RecipientApiVisible,
    IReadOnlyList<CommentFixtureNoticeMessageObservation> Messages);

public sealed record CommentFixtureNoticeMessageObservation(
    string MessageId,
    string ConversationId,
    string SenderType,
    string ContentDigest,
    DateTime CreatedAt);

/// <summary>
/// Read observations with complete queue and reply-page traversal; missing or pending work is retained,
/// never promoted to qualification or an atomic snapshot. AdminQueueFirstPage retains its serialized name.
/// </summary>
public sealed record CommentFixtureDeliveryObservation(
    CommentFixtureMutationResult Authority,
    string BoundedQueueCatalogDigest,
    CommentPermalinkContextDto PublicProjection,
    CommentFixtureAdminQueueObservation AdminQueueFirstPage,
    string CacheIdentity,
    string? CacheGeneration,
    string RootCacheIdentity,
    string? RootCacheGeneration,
    IReadOnlyList<CommentFixtureOutboxObservation> Outbox,
    IReadOnlyList<CommentFixtureReplyNoticeObservation> ReplyNotices);

public sealed partial class CommentThreadFixturePort
{
    public async Task<CommentFixtureDeliveryObservation> ObserveDeliveryAsync(
        CommentFixtureMutationResult authority,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!authority.Binding.IsValid() || string.IsNullOrWhiteSpace(authority.SemanticRole)
            || authority.Identity.CommentId <= 0 || authority.After.CurrentVersion <= 0)
            throw new InvalidOperationException("Comment delivery authority binding is invalid.");
        Comment row = await RequireCommentAsync(authority.Identity.CommentId, cancellationToken).ConfigureAwait(false);
        var identity = new FixtureIdentity(row.Id, authority.Identity.AccountId, authority.Identity.ActorMode,
            authority.Identity.OperationPlanDigest, authority.Identity.CapabilityId);
        var operation = new CommentThreadFixtureOperation(identity.CapabilityId, authority.SemanticRole,
            CommentThreadFixtureOperations.Edit, identity.ActorMode, identity.AccountId, row.Content);
        RequireOwnedMutation(row, authority.Binding, operation, identity);
        RequireCurrentDeliveryAuthority(row, authority);
        if (identity.ActorMode == CommentAuthorModes.ZkAnonymous)
        {
            CommentFixtureMutationObservation current = await ReadMutationObservationAsync(row, cancellationToken)
                .ConfigureAwait(false);
            await RequireAnonymousOwnershipAsync(authority.Binding, authority.SemanticRole, identity, row, cancellationToken,
                current.Revisions.Single(revision => revision.Version == 1).Content, restoreCapabilityCustody: false)
                .ConfigureAwait(false);
        }

        CommentPermalinkContextDto publicProjection = await publicQueries.GetPermalinkContextAsync(row.ArticleId,
            row.Id).ConfigureAwait(false);
        CommentModerationQueueResponse queue = await CommentFixtureQueuePageReader.ReadAllAsync(moderationQueue,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        string commentId = row.Id.ToString(CultureInfo.InvariantCulture);
        var queueObservation = new CommentFixtureAdminQueueObservation(
            queue.Items.Where(item => item.Id == commentId)
                .Select(item => new CommentFixtureQueueItemObservation(item.Id, item.Status, Digest(item.Content))).ToArray(),
            (queue.Leases ?? []).Where(item => item.CommentId == commentId)
                .Select(item => new CommentFixtureQueueLeaseObservation(item.CommentId, item.CommentRowVersion,
                    item.OwnerAdminPrincipalId, item.ClaimGeneration, item.ClaimRowVersion, item.LeaseExpiresAtUtc)).ToArray(),
            queue.NextCursor is not null);
        string cacheIdentity = $"article:{row.ArticleId.ToString(CultureInfo.InvariantCulture)}";
        string? generation = await cacheProbe.ReadCursorGenerationAsync(cacheIdentity, cancellationToken).ConfigureAwait(false);
        string rootCacheIdentity = $"{cacheIdentity}:root:{(row.RootId ?? row.Id).ToString(CultureInfo.InvariantCulture)}";
        string? rootGeneration = await cacheProbe.ReadCursorGenerationAsync(rootCacheIdentity, cancellationToken).ConfigureAwait(false);

        List<CommentMutationOutboxEvent> events = await db.Queryable<CommentMutationOutboxEvent>()
            .Where(item => item.CommentId == row.Id && item.ArticleId == row.ArticleId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (!events.Select(item => item.EventId).Order(StringComparer.Ordinal)
            .SequenceEqual(authority.After.OutboxEventIds.Order(StringComparer.Ordinal), StringComparer.Ordinal))
            throw new InvalidOperationException("Comment delivery outbox references differ from mutation authority.");
        long[] eventIds = events.Select(item => item.Id).ToArray();
        List<CommentMutationOutboxDelivery> deliveries = eventIds.Length == 0 ? []
            : await db.Queryable<CommentMutationOutboxDelivery>().Where(item => eventIds.Contains(item.OutboxEventId))
                .ToListAsync(cancellationToken).ConfigureAwait(false);
        var observations = new List<CommentFixtureOutboxObservation>();
        var replies = new List<CommentFixtureReplyNoticeObservation>();
        foreach (CommentMutationOutboxEvent item in events.OrderBy(item => item.Id))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!CommentMutationEventTypes.All.Contains(item.EventType, StringComparer.Ordinal))
                throw new InvalidOperationException("Comment delivery event has no production consumer contract.");
            IReadOnlyList<string> required = CommentMutationOutboxConsumers.RequiredFor(item.EventType);
            CommentMutationOutboxDelivery[] consumers = deliveries.Where(delivery => delivery.OutboxEventId == item.Id)
                .OrderBy(delivery => delivery.ConsumerName, StringComparer.Ordinal).ToArray();
            observations.Add(new(item.EventId, item.EventType, item.Status, item.AttemptCount, item.LeaseGeneration,
                item.ClaimedBy, item.OccurredAtUtc, item.ProcessedAtUtc, required,
                required.Where(consumer => consumers.All(delivery => delivery.ConsumerName != consumer)).ToArray(),
                consumers.Select(delivery => new CommentFixtureConsumerObservation(delivery.ConsumerName, delivery.Status,
                    delivery.AttemptCount, delivery.LeaseGeneration, delivery.OwnerWorkerId, delivery.CompletedAt,
                    delivery.ResultDigest, delivery.LastFailureKind)).ToArray()));
            if (item.EventType == CommentMutationEventTypes.ReplyNotificationRequested)
                await ReadReplyNoticeAsync(row, item, replies, cancellationToken).ConfigureAwait(false);
        }

        // A new mutation during the observation invalidates this candidate snapshot.
        Comment after = await RequireCommentAsync(row.Id, cancellationToken).ConfigureAwait(false);
        RequireCurrentDeliveryAuthority(after, authority);
        return new(authority, BoundedQueueDeliveryCatalog.Embedded.Digest, publicProjection, queueObservation,
            cacheIdentity, generation, rootCacheIdentity, rootGeneration, observations, replies);
    }

    private async Task ReadReplyNoticeAsync(Comment row, CommentMutationOutboxEvent item,
        ICollection<CommentFixtureReplyNoticeObservation> observations, CancellationToken cancellationToken)
    {
        // Reuse the actual dispatcher's source-event derivation. No message or projection is written here.
        long sourceId = CommentMutationOutboxWorker.BuildSourceEventId(item.EventId, "reply");
        int? eligibleRecipient = !row.IsDeleted && row.ModerationStatus == CommentModerationStatus.Approved
            ? CommentCommandService.ResolveReplyRecipientId(item.ReplyToAccountId, row.UserId) : null;
        List<MessageConversation> conversations = await db.Queryable<MessageConversation>()
            .Where(conversation => conversation.SourceMessageId == sourceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (conversations.Count == 0)
            observations.Add(new(item.EventId, sourceId, eligibleRecipient, string.Empty, null, false, false, []));
        foreach (MessageConversation conversation in conversations)
        {
            IReadOnlyList<ConversationMessageResponse>? messages = conversation.InitiatorAccountId is > 0
                ? await CommentFixtureReplyMessagePageReader.ReadAsync(messageQueries,
                    conversation.InitiatorAccountId.Value, conversation.Id, cancellationToken).ConfigureAwait(false) : null;
            observations.Add(new(item.EventId, sourceId, eligibleRecipient,
                conversation.Id.ToString(CultureInfo.InvariantCulture), conversation.InitiatorAccountId,
                conversation.IsSystemSource,
                messages is not null,
                messages?.Select(message => new CommentFixtureNoticeMessageObservation(message.MessageId,
                    message.ConversationId, message.SenderType.ToString(), Digest(message.Body), message.CreatedAt)).ToArray() ?? []));
        }
    }

    private static void RequireCurrentDeliveryAuthority(Comment row, CommentFixtureMutationResult authority)
    {
        if (row.CurrentVersion != authority.After.CurrentVersion || row.ModerationStatus != authority.After.ModerationStatus
            || row.IsDeleted != authority.After.IsDeleted || Digest(row.Content) != authority.After.ContentDigest)
            throw new InvalidOperationException("Comment delivery authority revision is stale.");
    }
}
