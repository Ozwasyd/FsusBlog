using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Explicit observed facts and original temporal role for the eight-argument
/// production constructor. No identity, normalized text, history or actor proof
/// is generated or authenticated by this transport.
/// </summary>
public sealed record CommentScaleRevisionFacts(
    CommentScaleRequestCoordinate Coordinate,
    int ArticleId,
    long AllocatedCommentId,
    int Version,
    string Operation,
    string NormalizedContent,
    string CreatedAtRole,
    string ActorMode,
    int? ActorAccountId,
    long? ActorAdminPrincipalId);

/// <summary>
/// An unpersisted initial revision/outbox pair, or a zero-comment marker. Original
/// entities remain mutable. Thread/privacy/native revision allocation, artifact
/// admission, persistence and exact history correlation remain owner obligations.
/// </summary>
public sealed record CommentScaleRevisionGraphGroup(
    CommentScaleInitialOutboxGraphGroup InitialOutbox,
    CommentRevision? Revision);

/// <summary>
/// Pairs the existing initial-event stream with explicit initial revision facts.
/// Mutation revisions use the sole factory constructor separately; an initial
/// event group cannot stand in for edit/delete event policy or observed history.
/// </summary>
public static class CommentScaleRevisionGraphAdapter
{
    /// <summary>
    /// Full enumeration checks exact ordered coverage. A yielded prefix carries
    /// no complete-graph, transaction or admission claim. Initial production
    /// creation uses version one and Created; these are checked, never inferred.
    /// </summary>
    public static IEnumerable<CommentScaleRevisionGraphGroup> ResolveStream(
        IEnumerable<CommentScaleInitialOutboxGraphGroup> initialOutbox,
        IEnumerable<CommentScaleRevisionFacts> revisionFacts,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(initialOutbox);
        ArgumentNullException.ThrowIfNull(revisionFacts);
        ArgumentNullException.ThrowIfNull(temporal);
        using IEnumerator<CommentScaleRevisionFacts> input = revisionFacts.GetEnumerator();
        foreach (CommentScaleInitialOutboxGraphGroup group in initialOutbox)
        {
            if (group is null || group.Intent is null || group.Intent.Comments is null
                || group.Events is null)
            {
                throw new InvalidOperationException("comment_revision_initial_group_invalid");
            }
            CommentScaleResolvedRequestIntent[] requests = group.Intent.Comments.ToArray();
            if (requests.Length != group.Intent.Comments.Count || requests.Any(item => item is null))
            {
                throw new InvalidOperationException("comment_revision_initial_group_invalid");
            }
            if (group.Coordinate is null)
            {
                if (requests.Length != 0 || group.Events.Count != 0 || group.Events.Any())
                {
                    throw new InvalidOperationException("comment_revision_empty_marker_invalid");
                }
                yield return new(group, null);
                continue;
            }
            if (!input.MoveNext())
            {
                throw new InvalidOperationException("comment_revision_facts_missing");
            }
            CommentScaleRevisionFacts facts = input.Current;
            if (facts is null || facts.Coordinate != group.Coordinate
                || group.Coordinate.Occurrence != group.Intent.Occurrence
                || requests.Count(item => item.Coordinate == group.Coordinate) != 1
                || facts.ArticleId != group.Intent.ArticleId
                || facts.Version != 1 || facts.Operation != CommentRevisionOperations.Created
                || facts.ActorAdminPrincipalId is not null)
            {
                throw new InvalidOperationException("comment_revision_initial_binding_mismatch");
            }
            CommentRevision revision = CanonicalCommentGraphFactory.ResolveRevision(facts, temporal);
            CommentMutationOutboxEvent[] events = group.Events.ToArray();
            // Production reads the creation clock and initial-outbox clock
            // separately. Revision and event instants must not be conflated.
            if (events.Length == 0 || events.Length != group.Events.Count || events[0] is null
                || events[0].NextStatus is null || !Enum.IsDefined(events[0].NextStatus.Value)
                || events[0].OccurredAtUtc.Kind != DateTimeKind.Utc
                || events.Any(item => item is null || item.CommentId != revision.CommentId
                    || item.ArticleId != facts.ArticleId || item.OccurredAtUtc != events[0].OccurredAtUtc
                    || item.OccurredAtUtc.Kind != events[0].OccurredAtUtc.Kind
                    || item.AccountId != revision.ActorAccountId || item.ActorAdminPrincipalId is not null
                    || item.PreviousStatus is not null
                    || item.NextStatus != events[0].NextStatus || item.RootId != events[0].RootId
                    || item.ParentId != events[0].ParentId || item.ReplyToAccountId != events[0].ReplyToAccountId)
                || !events.Select(item => item.EventType).SequenceEqual(
                    CommentCommandService.ResolveInitialOutboxEventTypes(events[0].NextStatus.Value,
                        events[0].ReplyToAccountId)))
            {
                throw new InvalidOperationException("comment_revision_initial_event_binding_mismatch");
            }
            yield return new(group, revision);
        }
        if (input.MoveNext())
        {
            throw new InvalidOperationException("comment_revision_facts_extra");
        }
    }

    /// <summary>Bounds retained pair count, not physical rows, bytes or transactions.</summary>
    public static IEnumerable<IReadOnlyList<CommentScaleRevisionGraphGroup>> ResolveBatches(
        IEnumerable<CommentScaleInitialOutboxGraphGroup> initialOutbox,
        IEnumerable<CommentScaleRevisionFacts> revisionFacts,
        ResolvedTemporalRoleContext temporal,
        int batchSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, CanonicalCommentGraphFactory.MaximumIntentsPerBatch);
        var batch = new List<CommentScaleRevisionGraphGroup>(batchSize);
        foreach (CommentScaleRevisionGraphGroup group in ResolveStream(initialOutbox, revisionFacts, temporal))
        {
            batch.Add(group);
            if (batch.Count == batchSize)
            {
                yield return batch.AsReadOnly();
                batch = new List<CommentScaleRevisionGraphGroup>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.AsReadOnly();
        }
    }
}
