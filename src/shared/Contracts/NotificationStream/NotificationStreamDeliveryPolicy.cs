using System.Collections.Frozen;

namespace FsusBlog.Shared.Contracts.NotificationStream;

/// <summary>
/// Defines the ordering boundary that a notification publisher must preserve.
/// </summary>
public enum NotificationStreamOrderingScope
{
    Global,
    Route,
    Target,
    Conversation,
    None
}

/// <summary>
/// Defines whether a notification event must be appended to the durable replay backlog.
/// </summary>
public enum NotificationStreamDurability
{
    BacklogRequired,
    Ephemeral
}

/// <summary>
/// Defines whether a notification frame is lossless, replaceable, coalescible, or diagnostic-only.
/// </summary>
public enum NotificationStreamLossPolicy
{
    Lossless,
    Replaceable,
    Coalescible,
    DiagnosticDrop
}

/// <summary>
/// Selects the isolated local fanout lane used by a notification event.
/// </summary>
public enum NotificationStreamPriorityClass
{
    Lossless,
    State,
    Low
}

/// <summary>
/// Defines the client recovery required when live delivery cannot be completed.
/// </summary>
public enum NotificationStreamRecoveryAction
{
    ReplayFromCursor,
    FullResync,
    None
}

/// <summary>
/// Machine-readable transport policy for one active notification event type.
/// This policy is transport-neutral and does not change the AEDS wire layout.
/// </summary>
public sealed record NotificationStreamDeliveryPolicy(
    NotificationStreamEventType EventType,
    NotificationStreamOrderingScope OrderingScope,
    NotificationStreamDurability Durability,
    NotificationStreamLossPolicy LossPolicy,
    string? CoalescingKey,
    NotificationStreamPriorityClass Priority,
    TimeSpan MaximumUsefulAge,
    NotificationStreamRecoveryAction RecoveryAction);

/// <summary>
/// Provides the fail-closed delivery policy for every active notification event type.
/// </summary>
public static class NotificationStreamDeliveryPolicyCatalog
{
    private static readonly IReadOnlyDictionary<NotificationStreamEventType, NotificationStreamDeliveryPolicy> s_policies =
        new Dictionary<NotificationStreamEventType, NotificationStreamDeliveryPolicy>
        {
            [NotificationStreamEventType.NoticeReceived] = Lossless(NotificationStreamEventType.NoticeReceived, NotificationStreamOrderingScope.Target, TimeSpan.FromMinutes(10)),
            [NotificationStreamEventType.GlobalNoticePublished] = Lossless(NotificationStreamEventType.GlobalNoticePublished, NotificationStreamOrderingScope.Global, TimeSpan.FromMinutes(10)),
            [NotificationStreamEventType.UnreadCountUpdated] = State(NotificationStreamEventType.UnreadCountUpdated, NotificationStreamOrderingScope.Target, "target", TimeSpan.FromMinutes(2)),
            [NotificationStreamEventType.AccountStatusChanged] = State(NotificationStreamEventType.AccountStatusChanged, NotificationStreamOrderingScope.Target, "target", TimeSpan.FromMinutes(5), NotificationStreamRecoveryAction.FullResync),
            [NotificationStreamEventType.CommentAdded] = Lossless(NotificationStreamEventType.CommentAdded, NotificationStreamOrderingScope.Route, TimeSpan.FromMinutes(5)),
            [NotificationStreamEventType.CommentRemoved] = Lossless(NotificationStreamEventType.CommentRemoved, NotificationStreamOrderingScope.Route, TimeSpan.FromMinutes(5)),
            [NotificationStreamEventType.MessageReceived] = Lossless(NotificationStreamEventType.MessageReceived, NotificationStreamOrderingScope.Target, TimeSpan.FromMinutes(10)),
            [NotificationStreamEventType.ArticleChanged] = State(NotificationStreamEventType.ArticleChanged, NotificationStreamOrderingScope.Route, "target", TimeSpan.FromMinutes(2)),
            [NotificationStreamEventType.MessageRevoked] = Lossless(NotificationStreamEventType.MessageRevoked, NotificationStreamOrderingScope.Conversation, TimeSpan.FromMinutes(10)),
            [NotificationStreamEventType.CacheControl] = State(NotificationStreamEventType.CacheControl, NotificationStreamOrderingScope.Route, "cache-scope", TimeSpan.FromMinutes(1)),
            [NotificationStreamEventType.SearchIndexUpdated] = Low(NotificationStreamEventType.SearchIndexUpdated, "search-manifest", TimeSpan.FromMinutes(1)),
            [NotificationStreamEventType.InboxConversationUpsert] = State(NotificationStreamEventType.InboxConversationUpsert, NotificationStreamOrderingScope.Conversation, "conversation", TimeSpan.FromMinutes(5)),
            [NotificationStreamEventType.InboxMessageAppend] = Lossless(NotificationStreamEventType.InboxMessageAppend, NotificationStreamOrderingScope.Conversation, TimeSpan.FromMinutes(10)),
            [NotificationStreamEventType.InboxReadUpdated] = State(NotificationStreamEventType.InboxReadUpdated, NotificationStreamOrderingScope.Conversation, "conversation", TimeSpan.FromMinutes(2)),
            [NotificationStreamEventType.InboxConversationStatusChanged] = State(NotificationStreamEventType.InboxConversationStatusChanged, NotificationStreamOrderingScope.Conversation, "conversation", TimeSpan.FromMinutes(5)),
            [NotificationStreamEventType.SessionRevoked] = Lossless(NotificationStreamEventType.SessionRevoked, NotificationStreamOrderingScope.Target, TimeSpan.FromMinutes(2), NotificationStreamRecoveryAction.FullResync)
        }.ToFrozenDictionary();

    public static IReadOnlyDictionary<NotificationStreamEventType, NotificationStreamDeliveryPolicy> All => s_policies;

    public static bool TryGet(NotificationStreamEventType eventType, out NotificationStreamDeliveryPolicy policy)
        => s_policies.TryGetValue(eventType, out policy!);

    public static NotificationStreamDeliveryPolicy GetRequired(NotificationStreamEventType eventType)
        => TryGet(eventType, out NotificationStreamDeliveryPolicy? policy)
            ? policy
            : throw new InvalidOperationException($"Unknown notification stream event type: {(short)eventType}.");

    private static NotificationStreamDeliveryPolicy Lossless(
        NotificationStreamEventType eventType,
        NotificationStreamOrderingScope ordering,
        TimeSpan maximumUsefulAge,
        NotificationStreamRecoveryAction recovery = NotificationStreamRecoveryAction.ReplayFromCursor)
        => new(eventType, ordering, NotificationStreamDurability.BacklogRequired, NotificationStreamLossPolicy.Lossless, null, NotificationStreamPriorityClass.Lossless, maximumUsefulAge, recovery);

    private static NotificationStreamDeliveryPolicy State(
        NotificationStreamEventType eventType,
        NotificationStreamOrderingScope ordering,
        string coalescingKey,
        TimeSpan maximumUsefulAge,
        NotificationStreamRecoveryAction recovery = NotificationStreamRecoveryAction.ReplayFromCursor)
        => new(eventType, ordering, NotificationStreamDurability.BacklogRequired, NotificationStreamLossPolicy.Replaceable, coalescingKey, NotificationStreamPriorityClass.State, maximumUsefulAge, recovery);

    private static NotificationStreamDeliveryPolicy Low(
        NotificationStreamEventType eventType,
        string coalescingKey,
        TimeSpan maximumUsefulAge)
        => new(eventType, NotificationStreamOrderingScope.Route, NotificationStreamDurability.BacklogRequired, NotificationStreamLossPolicy.Coalescible, coalescingKey, NotificationStreamPriorityClass.Low, maximumUsefulAge, NotificationStreamRecoveryAction.ReplayFromCursor);
}
