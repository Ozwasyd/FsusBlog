// fixture-catalog: producer account-messaging
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Fixtures;

public interface IMessagingFixtureSeeder
{
    Task<MessagingFixtureResult> PrepareAsync(
        MessagingFixturePlan request,
        CancellationToken cancellationToken = default);

    Task CleanupAsync(
        MessagingFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default);
}

public sealed record MessagingFixtureIdentityReferences(
    string PrimaryRecipientId,
    string SecondaryRecipientId,
    string EmptyRecipientId,
    string AdminId,
    string AdminSessionAuditReference,
    string SourceReceiptDigest);

public sealed record MessagingFixturePlan(
    string Schema,
    string ProducerId,
    string Strategy,
    string RunId,
    string Namespace,
    IReadOnlyList<string> Capabilities,
    MessagingFixtureIdentityReferences IdentityReferences,
    JsonElement SemanticRoles,
    JsonElement TemporalRoles,
    string InventoryDigest,
    string OwnershipDigest,
    string PlanDigest);

public sealed record MessagingFixtureCapabilityProof(
    string CapabilityId,
    string Status,
    string Database,
    string Api,
    string Stream,
    string Cache,
    string Outbox);

public sealed record MessagingFixtureEntityIdentity(
    string Kind,
    string Id,
    string SemanticRole,
    string? ContentDigest = null);

public sealed record MessagingFixtureObservedEntity(
    string Kind,
    string Id,
    string SemanticRole,
    IReadOnlyDictionary<string, object?> Fields);

public sealed record MessagingFixtureDatabaseObservation(
    string Namespace,
    string SchemaIdentity,
    IReadOnlyList<MessagingFixtureObservedEntity> Entities);

public sealed record MessagingFixtureRedisKeyObservation(
    string Domain,
    string KeyDigest,
    bool Present,
    IReadOnlyList<long> EventIds);

public sealed record MessagingFixtureRedisObservation(
    string Namespace,
    IReadOnlyList<MessagingFixtureRedisKeyObservation> Keys);

public sealed record MessagingFixtureCacheEntryObservation(
    string Domain,
    string Generation,
    bool MatchesDb);

public sealed record MessagingFixtureCacheObservation(
    string Namespace,
    IReadOnlyList<MessagingFixtureCacheEntryObservation> Entries);

public sealed record MessagingFixtureObservations(
    MessagingFixtureDatabaseObservation Database,
    MessagingFixtureRedisObservation Redis,
    MessagingFixtureCacheObservation Cache);

public sealed record MessagingFixtureCleanupReceipt(
    string Schema,
    string PlanDigest,
    string RunId,
    string Namespace,
    IReadOnlyList<string> OwnedEntityIds,
    IReadOnlyList<long> ConversationIds,
    IReadOnlyList<long> MessageIds,
    IReadOnlyList<long> EventIds,
    IReadOnlyList<string> DeliveryKeys);

public sealed record MessagingFixtureResult(
    string ProducerId,
    string Strategy,
    string PlanDigest,
    string InventoryDigest,
    string OwnershipDigest,
    IReadOnlyList<MessagingFixtureCapabilityProof> CapabilityProofs,
    IReadOnlyList<MessagingFixtureEntityIdentity> EntityIdentities,
    MessagingFixtureObservations Observations,
    MessagingFixtureCleanupReceipt CleanupReceipt);

public sealed class MessagingFixtureSeeder(
    IMessageCommandService commands,
    IMessageQueryService queries,
    IMessageAdminQueueMaintenance maintenance,
    MessageCacheService cache,
    NotificationStreamBacklogStore backlog,
    ISqlSugarClient db) : IMessagingFixtureSeeder
{
    private const string ProducerId = "account-messaging";
    private const string Strategy = "transaction-fixture";
    private const int PaginationMessageCount = 52;
    private static readonly TimeSpan s_outboxTimeout = TimeSpan.FromSeconds(30);
    private static readonly IReadOnlySet<string> s_noGroups = new HashSet<string>(StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> s_adminGroups = new HashSet<string>(StringComparer.Ordinal)
    {
        NotificationStreamTargetCollections.AdminUsers
    };

    public async Task<MessagingFixtureResult> PrepareAsync(
        MessagingFixturePlan request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidatePlan(request);
        int primary = ParsePositiveInt(request.IdentityReferences.PrimaryRecipientId, "primary recipient");
        int secondary = ParsePositiveInt(request.IdentityReferences.SecondaryRecipientId, "secondary recipient");
        int empty = ParsePositiveInt(request.IdentityReferences.EmptyRecipientId, "empty recipient");
        long adminId = ParsePositiveLong(request.IdentityReferences.AdminId, "admin principal");
        if (new HashSet<int> { primary, secondary, empty }.Count != 3)
        {
            throw new InvalidOperationException("Messaging fixture recipients must be distinct.");
        }
        await RequireActiveAccountsAsync([primary, secondary, empty], cancellationToken).ConfigureAwait(false);
        var adminActor = new AdminMessageActor(
            adminId,
            request.IdentityReferences.AdminSessionAuditReference);
        string owner = BuildOwner(request.Namespace, request.RunId);

        var roles = new Dictionary<string, long>(StringComparer.Ordinal);
        ConversationDetailResponse single = await RequireSuccessAsync(
            commands.CreateAccountTicketAsync(
                secondary,
                "Fixture single conversation",
                "Controlled fixture message.",
                MutationId(owner, "single-create")),
            "single conversation").ConfigureAwait(false);
        roles["single-thread"] = ParsePositiveLong(single.ConversationId, "single conversation id");

        ConversationDetailResponse multi = await RequireSuccessAsync(
            commands.CreateAccountTicketAsync(
                primary,
                "Fixture multi conversation",
                "Controlled fixture message one.",
                MutationId(owner, "multi-create")),
            "multi conversation").ConfigureAwait(false);
        long multiId = ParsePositiveLong(multi.ConversationId, "multi conversation id");
        roles["multi-thread"] = multiId;
        ConversationMessageResponse multiAdmin = await RequireSuccessAsync(
            commands.ReplyAsAdminAsync(
                multiId,
                "Controlled fixture message two.",
                adminActor,
                MutationId(owner, "multi-admin-reply")),
            "multi admin reply").ConfigureAwait(false);
        await RequireSuccessAsync(
            commands.ReplyAsAccountAsync(
                primary,
                multiId,
                ParsePositiveLong(multiAdmin.MessageId, "multi read cursor"),
                "Controlled fixture message three.",
                MutationId(owner, "multi-account-reply")),
            "multi account reply").ConfigureAwait(false);

        ConversationDetailResponse unread = await CreateAdminReplyConversationAsync(
            primary,
            adminActor,
            owner,
            "unread",
            cancellationToken).ConfigureAwait(false);
        roles["unread-thread"] = ParsePositiveLong(unread.ConversationId, "unread conversation id");

        ConversationDetailResponse read = await CreateAdminReplyConversationAsync(
            primary,
            adminActor,
            owner,
            "read",
            cancellationToken).ConfigureAwait(false);
        long readId = ParsePositiveLong(read.ConversationId, "read conversation id");
        roles["read-thread"] = readId;
        long readThrough = ParsePositiveLong(read.Messages[^1].MessageId, "read cursor");
        await RequireSuccessAsync(
            commands.MarkConversationReadAsync(primary, readId, readThrough),
            "mark read").ConfigureAwait(false);

        ConversationDetailResponse closed = await RequireSuccessAsync(
            commands.CreateAccountTicketAsync(
                primary,
                "Fixture closed conversation",
                "Controlled fixture closed message.",
                MutationId(owner, "closed-create")),
            "closed conversation").ConfigureAwait(false);
        long closedId = ParsePositiveLong(closed.ConversationId, "closed conversation id");
        roles["closed-thread"] = closedId;
        await RequireSuccessAsync(
            commands.UpdateConversationStatusAsync(
                closedId,
                ConversationStatusValue.Closed,
                "fixture closed-state contract",
                adminActor),
            "close conversation").ConfigureAwait(false);

        ConversationDetailResponse pagination = await RequireSuccessAsync(
            commands.CreateAccountTicketAsync(
                primary,
                "Fixture pagination conversation",
                "Controlled fixture pagination message 00.",
                MutationId(owner, "pagination-create")),
            "pagination conversation").ConfigureAwait(false);
        long paginationId = ParsePositiveLong(pagination.ConversationId, "pagination conversation id");
        roles["pagination-thread"] = paginationId;
        for (int index = 1; index < PaginationMessageCount; index++)
        {
            await RequireSuccessAsync(
                commands.ReplyAsAdminAsync(
                    paginationId,
                    string.Create(CultureInfo.InvariantCulture, $"Controlled fixture pagination message {index:D2}."),
                    adminActor,
                    MutationId(owner, string.Create(CultureInfo.InvariantCulture, $"pagination-{index:D2}"))),
                string.Create(CultureInfo.InvariantCulture, $"pagination reply {index}")).ConfigureAwait(false);
        }

        long[] conversationIds = roles.Values.Distinct().Order().ToArray();
        List<MessageMutationOutbox> deliveries = await WaitForOutboxAsync(conversationIds, cancellationToken)
            .ConfigureAwait(false);
        Dictionary<string, long> eventIds = await ObserveDeliveryEventsAsync(deliveries, cancellationToken)
            .ConfigureAwait(false);
        return await BuildVerifiedResultAsync(
                request,
                roles,
                conversationIds,
                deliveries,
                eventIds,
                primary,
                secondary,
                empty,
                cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task CleanupAsync(
        MessagingFixtureCleanupReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt.Schema != "fsusblog.messaging-fixture-cleanup.v1"
            || string.IsNullOrWhiteSpace(receipt.PlanDigest)
            || string.IsNullOrWhiteSpace(receipt.RunId)
            || string.IsNullOrWhiteSpace(receipt.Namespace)
            || receipt.ConversationIds is not { Count: > 0 }
            || receipt.MessageIds is null
            || receipt.EventIds is null
            || receipt.DeliveryKeys is null
            || receipt.OwnedEntityIds is null)
        {
            throw new InvalidOperationException("Messaging fixture cleanup receipt is invalid.");
        }
        long[] conversationIds = receipt.ConversationIds.Distinct().Order().ToArray();
        if (conversationIds.Length != receipt.ConversationIds.Count
            || receipt.MessageIds.Distinct().Count() != receipt.MessageIds.Count
            || receipt.EventIds.Distinct().Count() != receipt.EventIds.Count
            || receipt.DeliveryKeys.Distinct(StringComparer.Ordinal).Count() != receipt.DeliveryKeys.Count
            || receipt.OwnedEntityIds.Distinct(StringComparer.Ordinal).Count() != receipt.OwnedEntityIds.Count
            || conversationIds.Any(static id => id <= 0))
        {
            throw new InvalidOperationException("Messaging fixture cleanup conversation identity is not exact.");
        }
        List<ConversationMessage> messages = await db.Queryable<ConversationMessage>()
            .Where(item => conversationIds.Contains(item.ConversationId))
            .OrderBy(item => item.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        long[] messageIds = messages.Select(static item => item.Id).Distinct().Order().ToArray();
        if (!messageIds.SequenceEqual(receipt.MessageIds.Distinct().Order()))
        {
            throw new InvalidOperationException("Messaging fixture cleanup message identity is not exact.");
        }
        List<MessageMutationOutbox> deliveries = await db.Queryable<MessageMutationOutbox>()
            .Where(item => conversationIds.Contains(item.ConversationId))
            .OrderBy(item => item.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        string[] deliveryKeys = deliveries.Select(static item => item.DeliveryKey)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!deliveryKeys.SequenceEqual(receipt.DeliveryKeys.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Messaging fixture cleanup outbox identity is not exact.");
        }
        var observedEventIds = new SortedSet<long>();
        foreach (string deliveryKey in deliveryKeys)
        {
            long? eventId = await backlog.TryReadIdempotentEventIdAsync(deliveryKey, cancellationToken)
                .ConfigureAwait(false);
            if (!eventId.HasValue)
            {
                throw new InvalidOperationException("Messaging fixture cleanup stream identity is missing.");
            }
            observedEventIds.Add(eventId.Value);
        }
        if (!observedEventIds.SequenceEqual(receipt.EventIds.Distinct().Order()))
        {
            throw new InvalidOperationException("Messaging fixture cleanup stream identity is not exact.");
        }
        string[] ownedEntityIds = conversationIds.Select(static id => id.ToString(CultureInfo.InvariantCulture))
            .Concat(messageIds.Select(static id => id.ToString(CultureInfo.InvariantCulture)))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!ownedEntityIds.SequenceEqual(receipt.OwnedEntityIds.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal), StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Messaging fixture cleanup entity ownership is not exact.");
        }
        List<int> userIds = await db.Queryable<ConversationParticipantState>()
            .Where(item => conversationIds.Contains(item.ConversationId))
            .Select(item => item.AccountId)
            .Distinct()
            .ToListAsync(cancellationToken).ConfigureAwait(false);

        await backlog.RemoveOwnedEventsAsync(
                receipt.EventIds,
                receipt.DeliveryKeys,
                userIds.Select(static id => id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                s_adminGroups,
                cancellationToken)
            .ConfigureAwait(false);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Deleteable<MessageMutationOutbox>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await db.Deleteable<ConversationStatusEvent>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await db.Deleteable<ConversationParticipantState>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await db.Deleteable<AdminConversationQueueState>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await db.Deleteable<ConversationMessage>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
            await db.Deleteable<MessageConversation>()
                .Where(item => conversationIds.Contains(item.Id))
                .ExecuteCommandAsync(cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Messaging fixture exact cleanup failed.", transaction.ErrorException);
        }
        foreach (int userId in userIds)
        {
            await maintenance.RebuildAccountUnreadAsync(userId).ConfigureAwait(false);
        }
        bool remains = await db.Queryable<MessageConversation>()
            .Where(item => conversationIds.Contains(item.Id))
            .AnyAsync(cancellationToken).ConfigureAwait(false);
        if (remains)
        {
            throw new InvalidOperationException("Messaging fixture exact cleanup left owned conversations behind.");
        }
        foreach (string deliveryKey in deliveryKeys)
        {
            if (await backlog.TryReadIdempotentEventIdAsync(deliveryKey, cancellationToken).ConfigureAwait(false) is not null)
            {
                throw new InvalidOperationException("Messaging fixture exact cleanup left an owned stream identity behind.");
            }
        }
    }

    private async Task<MessagingFixtureResult> BuildVerifiedResultAsync(
        MessagingFixturePlan request,
        IReadOnlyDictionary<string, long> roles,
        IReadOnlyList<long> conversationIds,
        IReadOnlyList<MessageMutationOutbox> deliveries,
        IReadOnlyDictionary<string, long> deliveryEvents,
        int primary,
        int secondary,
        int empty,
        CancellationToken cancellationToken)
    {
        PageResponse<ConversationListItemResponse> primaryInbox = await queries.GetAccountConversationsAsync(
            primary, 100, null, null, cancellationToken).ConfigureAwait(false);
        PageResponse<ConversationListItemResponse> secondaryInbox = await queries.GetAccountConversationsAsync(
            secondary, 100, null, null, cancellationToken).ConfigureAwait(false);
        PageResponse<ConversationListItemResponse> emptyInbox = await queries.GetAccountConversationsAsync(
            empty, 100, null, null, cancellationToken).ConfigureAwait(false);
        if (emptyInbox.Total != 0 || emptyInbox.Items.Count != 0)
        {
            throw new InvalidOperationException("Messaging empty recipient is not exact zero.");
        }
        RequireInboxMembership(primaryInbox, roles.Where(static item => item.Key != "single-thread").Select(static item => item.Value));
        RequireInboxMembership(secondaryInbox, [roles["single-thread"]]);

        ConversationDetailResponse read = await RequireDetailAsync(primary, roles["read-thread"], cancellationToken).ConfigureAwait(false);
        ConversationDetailResponse unread = await RequireDetailAsync(primary, roles["unread-thread"], cancellationToken).ConfigureAwait(false);
        ConversationDetailResponse closed = await RequireDetailAsync(primary, roles["closed-thread"], cancellationToken).ConfigureAwait(false);
        ConversationDetailResponse multi = await RequireDetailAsync(primary, roles["multi-thread"], cancellationToken).ConfigureAwait(false);
        ConversationDetailResponse pagination = await RequireDetailAsync(primary, roles["pagination-thread"], cancellationToken).ConfigureAwait(false);
        if (read.UnreadCount != 0 || unread.UnreadCount != 1
            || closed.Status != ConversationStatusValue.Closed
            || multi.Messages.Count != 3
            || !pagination.HasOlder
            || pagination.PreviousCursor is null
            || pagination.Messages.Count != 50)
        {
            throw new InvalidOperationException("Messaging API projection matrix is incomplete or inconsistent.");
        }

        List<ConversationMessage> messages = await db.Queryable<ConversationMessage>()
            .Where(item => conversationIds.Contains(item.ConversationId))
            .OrderBy(item => item.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (messages.GroupBy(static item => item.ConversationId)
            .Any(group => group.Zip(group.Skip(1), static (left, right) => left.Id < right.Id && left.CreatedAt <= right.CreatedAt)
                .Any(static ordered => !ordered)))
        {
            throw new InvalidOperationException("Messaging sequence/timestamp order drifted.");
        }
        if (messages.Count(item => item.ConversationId == roles["pagination-thread"]) != PaginationMessageCount)
        {
            throw new InvalidOperationException("Messaging pagination boundary row count is not exact.");
        }

        Dictionary<int, int> databaseUnread = await LoadUnreadAsync([primary, secondary, empty], cancellationToken)
            .ConfigureAwait(false);
        var cacheEntries = new List<MessagingFixtureCacheEntryObservation>();
        foreach (int userId in new[] { primary, secondary, empty })
        {
            int observed = await cache.GetUnreadOrRecoverAsync(
                userId,
                () => Task.FromResult(databaseUnread.GetValueOrDefault(userId)))
                .ConfigureAwait(false);
            if (observed != databaseUnread.GetValueOrDefault(userId))
            {
                throw new InvalidOperationException("Messaging unread cache differs from database projection.");
            }
            cacheEntries.Add(new MessagingFixtureCacheEntryObservation(
                "message-unread",
                Hash(string.Create(CultureInfo.InvariantCulture, $"{userId}:{observed}")),
                true));
        }

        IReadOnlyList<long> primaryStream = await backlog.ObserveReplayEventIdsAsync(
            primary.ToString(CultureInfo.InvariantCulture), s_noGroups, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<long> secondaryStream = await backlog.ObserveReplayEventIdsAsync(
            secondary.ToString(CultureInfo.InvariantCulture), s_noGroups, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<long> adminStream = await backlog.ObserveReplayEventIdsAsync(
            null, s_adminGroups, cancellationToken).ConfigureAwait(false);
        var streamIds = new HashSet<long>(primaryStream.Concat(secondaryStream).Concat(adminStream));
        if (deliveryEvents.Values.Any(eventId => !streamIds.Contains(eventId)))
        {
            throw new InvalidOperationException("Messaging outbox and stream event identities differ.");
        }

        var entities = new List<MessagingFixtureObservedEntity>();
        var identities = new List<MessagingFixtureEntityIdentity>();
        foreach ((string role, long conversationId) in roles.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            List<ConversationMessage> ownedMessages = messages.Where(item => item.ConversationId == conversationId).ToList();
            entities.Add(new MessagingFixtureObservedEntity(
                "thread",
                conversationId.ToString(CultureInfo.InvariantCulture),
                role,
                new Dictionary<string, object?>
                {
                    ["messageIds"] = ownedMessages.Select(static item => item.Id.ToString(CultureInfo.InvariantCulture)).ToArray(),
                    ["sequenceExact"] = true,
                    ["status"] = role == "closed-thread" ? "closed" : "open"
                }));
            identities.Add(new MessagingFixtureEntityIdentity(
                "thread",
                conversationId.ToString(CultureInfo.InvariantCulture),
                role));
            foreach (ConversationMessage message in ownedMessages)
            {
                string digest = Hash(message.Body);
                entities.Add(new MessagingFixtureObservedEntity(
                    "message",
                    message.Id.ToString(CultureInfo.InvariantCulture),
                    role,
                    new Dictionary<string, object?>
                    {
                        ["contentDigest"] = digest,
                        ["createdAt"] = message.CreatedAt,
                        ["senderType"] = message.SenderType.ToString().ToLowerInvariant()
                    }));
                identities.Add(new MessagingFixtureEntityIdentity(
                    "message",
                    message.Id.ToString(CultureInfo.InvariantCulture),
                    role,
                    digest));
            }
        }
        identities.Add(new MessagingFixtureEntityIdentity("recipient", Hash(empty.ToString(CultureInfo.InvariantCulture)), "empty-recipient"));

        var proofs = request.Capabilities.Order(StringComparer.Ordinal)
            .Select(capability => new MessagingFixtureCapabilityProof(
                capability,
                "verified",
                "exact",
                "exact",
                capability.StartsWith("notifications.", StringComparison.Ordinal) ? "exact" : "not-applicable",
                "exact",
                "exact"))
            .ToArray();
        long[] messageIds = messages.Select(static item => item.Id).Order().ToArray();
        long[] eventIds = deliveryEvents.Values.Distinct().Order().ToArray();
        string[] deliveryKeys = deliveries.Select(static item => item.DeliveryKey).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        string[] ownedEntityIds = conversationIds.Select(static id => id.ToString(CultureInfo.InvariantCulture))
            .Concat(messageIds.Select(static id => id.ToString(CultureInfo.InvariantCulture)))
            .Order(StringComparer.Ordinal)
            .ToArray();
        var cleanup = new MessagingFixtureCleanupReceipt(
            "fsusblog.messaging-fixture-cleanup.v1",
            request.PlanDigest,
            request.RunId,
            request.Namespace,
            ownedEntityIds,
            conversationIds,
            messageIds,
            eventIds,
            deliveryKeys);
        return new MessagingFixtureResult(
            ProducerId,
            Strategy,
            request.PlanDigest,
            request.InventoryDigest,
            request.OwnershipDigest,
            proofs,
            identities,
            new MessagingFixtureObservations(
                new MessagingFixtureDatabaseObservation(request.Namespace, "public", entities),
                new MessagingFixtureRedisObservation(
                    request.Namespace,
                    [
                        new("redis.notification.primary", Hash("primary-stream"), primaryStream.Count > 0, primaryStream),
                        new("redis.notification.secondary", Hash("secondary-stream"), secondaryStream.Count > 0, secondaryStream),
                        new("redis.notification.admin", Hash("admin-stream"), adminStream.Count > 0, adminStream)
                    ]),
                new MessagingFixtureCacheObservation(request.Namespace, cacheEntries)),
            cleanup);
    }

    private async Task<ConversationDetailResponse> CreateAdminReplyConversationAsync(
        int accountId,
        AdminMessageActor adminActor,
        string owner,
        string role,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ConversationDetailResponse created = await RequireSuccessAsync(
            commands.CreateAccountTicketAsync(
                accountId,
                string.Create(CultureInfo.InvariantCulture, $"Fixture {role} conversation"),
                "Controlled fixture message one.",
                MutationId(owner, $"{role}-create")),
            $"{role} conversation").ConfigureAwait(false);
        long conversationId = ParsePositiveLong(created.ConversationId, $"{role} conversation id");
        ConversationMessageResponse reply = await RequireSuccessAsync(
            commands.ReplyAsAdminAsync(
                conversationId,
                "Controlled fixture message two.",
                adminActor,
                MutationId(owner, $"{role}-admin-reply")),
            $"{role} admin reply").ConfigureAwait(false);
        return created with
        {
            Messages = [.. created.Messages, reply]
        };
    }

    private async Task<List<MessageMutationOutbox>> WaitForOutboxAsync(
        IReadOnlyCollection<long> conversationIds,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow.Add(s_outboxTimeout);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            List<MessageMutationOutbox> deliveries = await db.Queryable<MessageMutationOutbox>()
                .Where(item => conversationIds.Contains(item.ConversationId))
                .OrderBy(item => item.Id)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
            if (deliveries.Count > 0
                && deliveries.All(static item => item.Status == MessageMutationOutboxStatus.Processed))
            {
                return deliveries;
            }
            if (deliveries.Any(static item => item.Status == MessageMutationOutboxStatus.Poison)
                || DateTimeOffset.UtcNow >= deadline)
            {
                throw new InvalidOperationException("Messaging outbox did not reach exact processed state.");
            }
            await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<Dictionary<string, long>> ObserveDeliveryEventsAsync(
        IReadOnlyList<MessageMutationOutbox> deliveries,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (MessageMutationOutbox delivery in deliveries)
        {
            long? eventId = await backlog.TryReadIdempotentEventIdAsync(delivery.DeliveryKey, cancellationToken)
                .ConfigureAwait(false);
            if (!eventId.HasValue)
            {
                throw new InvalidOperationException("Processed messaging outbox has no stream event identity.");
            }
            result.Add(delivery.DeliveryKey, eventId.Value);
        }
        return result;
    }

    private async Task<Dictionary<int, int>> LoadUnreadAsync(
        IReadOnlyCollection<int> accountIds,
        CancellationToken cancellationToken)
    {
        List<ConversationParticipantState> rows = await db.Queryable<ConversationParticipantState>()
            .Where(item => accountIds.Contains(item.AccountId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return accountIds.ToDictionary(
            static id => id,
            id => rows.Where(item => item.AccountId == id).Sum(static item => item.UnreadCount));
    }

    private async Task RequireActiveAccountsAsync(
        IReadOnlyCollection<int> accountIds,
        CancellationToken cancellationToken)
    {
        List<User> users = await db.Queryable<User>()
            .Where(item => accountIds.Contains(item.Id))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (users.Count != accountIds.Count || users.Any(static item => item.Status != 0 || item.DeletedAt.HasValue))
        {
            throw new InvalidOperationException("Messaging fixture identity references are missing or inactive.");
        }
    }

    private async Task<ConversationDetailResponse> RequireDetailAsync(
        int accountId,
        long conversationId,
        CancellationToken cancellationToken)
        => await queries.GetAccountConversationDetailAsync(accountId, conversationId, null, cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("Messaging API detail projection is missing.");

    private static void RequireInboxMembership(
        PageResponse<ConversationListItemResponse> page,
        IEnumerable<long> expectedIds)
    {
        string[] expected = expectedIds.Select(static id => id.ToString(CultureInfo.InvariantCulture)).Order(StringComparer.Ordinal).ToArray();
        string[] observed = page.Items.Where(item => expected.Contains(item.ConversationId, StringComparer.Ordinal))
            .Select(static item => item.ConversationId)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (!expected.SequenceEqual(observed, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("Messaging inbox projection membership is not exact.");
        }
    }

    private static void ValidatePlan(MessagingFixturePlan request)
    {
        if (request.Schema != "fsusblog.messaging-fixture-plan.v1"
            || request.ProducerId != ProducerId
            || request.Strategy != Strategy
            || string.IsNullOrWhiteSpace(request.Namespace)
            || string.IsNullOrWhiteSpace(request.RunId)
            || request.Capabilities.Count == 0
            || !request.InventoryDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || !request.OwnershipDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || !request.PlanDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || request.TemporalRoles.ValueKind != JsonValueKind.Object
            || request.TemporalRoles.GetProperty("schema").GetString() != "fsusblog.resolved-temporal-roles.v1"
            || !request.TemporalRoles.TryGetProperty("contentDigest", out JsonElement temporalDigest)
            || !StringHasSha256Digest(temporalDigest.GetString())
            || !StringHasSha256Digest(request.IdentityReferences.SourceReceiptDigest))
        {
            throw new InvalidOperationException("Messaging fixture plan identity or temporal binding is invalid.");
        }
    }

    private static async Task<T> RequireSuccessAsync<T>(
        Task<FsusBlog.Core.Common.Result<T>> operation,
        string label)
    {
        FsusBlog.Core.Common.Result<T> result = await operation.ConfigureAwait(false);
        return result.IsSuccess
            ? result.Value!
            : throw new InvalidOperationException($"Messaging fixture {label} failed: {result.Error.Code}.");
    }

    private static async Task RequireSuccessAsync(
        Task<FsusBlog.Core.Common.Result> operation,
        string label)
    {
        FsusBlog.Core.Common.Result result = await operation.ConfigureAwait(false);
        if (result.IsFailure)
        {
            throw new InvalidOperationException($"Messaging fixture {label} failed: {result.Error.Code}.");
        }
    }

    private static int ParsePositiveInt(string value, string label)
        => int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out int parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"Messaging fixture {label} is invalid.");

    private static long ParsePositiveLong(string value, string label)
        => long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long parsed) && parsed > 0
            ? parsed
            : throw new InvalidOperationException($"Messaging fixture {label} is invalid.");

    private static string BuildOwner(string fixtureNamespace, string runId)
        => Hash(string.Concat(fixtureNamespace.Trim(), ":", runId.Trim()))[7..31];

    private static string MutationId(string owner, string role)
        => string.Concat("fxmsg-", Hash(string.Concat(owner, ":", role))[7..39]);

    private static string Hash(string value)
        => string.Concat("sha256:", Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value))));

    private static bool StringHasSha256Digest(string? value)
        => value is { Length: 71 } && value.StartsWith("sha256:", StringComparison.Ordinal)
            && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;
}
