using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Supplied current row and original observed timeline; no event is derived from the plan.</summary>
public sealed record CommentScaleTimelineRequestFacts(
    string CommentRole,
    string EntityRole,
    Comment CurrentComment,
    CommentModerationTimelineResult Timeline);

/// <summary>Ordered observation facts and the original native binding expectations for one occurrence.</summary>
public sealed record CommentScaleTimelineOccurrenceFacts(
    CommentScaleGraphOccurrence Occurrence,
    DataScaleNativeCommentBindings Identities,
    CommentScaleNativeBindingExpectation Expectations,
    IReadOnlyList<CommentScaleTimelineRequestFacts> Comments);

/// <summary>
/// Full original observation, or a zero-comment occurrence marker with null Coordinate,
/// CurrentComment and Timeline. Containers are frozen; original entities remain mutable.
/// This carries no event authenticity, custody, temporal ordering or full graph qualification.
/// </summary>
public sealed record CommentScaleObservedModerationTimelineGroup(
    CommentScaleResolvedGraphIntent Intent,
    CommentScaleRequestCoordinate? Coordinate,
    Comment? CurrentComment,
    CommentModerationTimelineResult? Timeline);

public static partial class CanonicalCommentGraphFactory
{
    /// <summary>
    /// Observes supplied timelines in sole-plan occurrence/request order through the
    /// original canonical observation verifier. Its continuity result is not a semantic
    /// diff, complete graph, deterministic event builder, write or admission receipt.
    /// Caller supplies stable original rows, events and expectations throughout enumeration.
    /// Event order and every original field are preserved, never sorted or repaired.
    /// Missing/extra occurrences require full enumeration; a yielded prefix is not success.
    /// All observations in an occurrence are checked before yielding any of its groups.
    /// </summary>
    public static IEnumerable<CommentScaleObservedModerationTimelineGroup> ObserveModerationTimelineStream(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> graphFacts,
        IEnumerable<CommentScaleTimelineOccurrenceFacts> timelineFacts)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(graphFacts);
        ArgumentNullException.ThrowIfNull(timelineFacts);
        CommentScalePlan snapshot = CommentScalePlanContract.Parse(JsonSerializer.Serialize(plan));
        using IEnumerator<CommentScaleTimelineOccurrenceFacts> input = timelineFacts.GetEnumerator();
        foreach (CommentScaleResolvedGraphIntent intent in ResolveIntentStream(snapshot, temporal, graphFacts))
        {
            if (!input.MoveNext())
            {
                throw new InvalidOperationException("comment_timeline_occurrence_missing");
            }
            CommentScaleTimelineOccurrenceFacts observed = input.Current;
            if (observed is null || observed.Occurrence != intent.Occurrence || observed.Comments is null)
            {
                throw new InvalidOperationException("comment_timeline_occurrence_or_roster_mismatch");
            }
            ArgumentNullException.ThrowIfNull(observed.Identities);
            ArgumentNullException.ThrowIfNull(observed.Expectations);
            CommentScaleTimelineRequestFacts[] requests = FreezeTimelineObservationRoster(
                observed.Comments, intent.Comments.Count);
            CommentScaleNativeBindingExpectation expected = observed.Expectations with
            {
                FactoryRoles = Array.AsReadOnly(FreezeTimelineObservationRoster(
                    observed.Expectations.FactoryRoles, observed.Identities.Ids.Count))
            };
            CommentScaleNativeBindingAdapter.ValidateGraphBindings(snapshot, intent, temporal, observed.Identities, expected);
            var groups = new List<CommentScaleObservedModerationTimelineGroup>(requests.Length);
            var commentIds = new HashSet<long>();
            for (int index = 0; index < requests.Length; index++)
            {
                CommentScaleTimelineRequestFacts request = requests[index];
                if (request is null || request.CommentRole != intent.Comments[index].Coordinate.CommentRole
                    || string.IsNullOrWhiteSpace(request.EntityRole) || request.CurrentComment is null
                    || request.Timeline is null || request.Timeline.Events is null)
                {
                    throw new InvalidOperationException("comment_timeline_request_binding_invalid");
                }
                var role = new DataScaleNativeCommentRole(intent.Occurrence.ScenarioRole,
                    intent.Occurrence.Repetition, intent.Occurrence.ArticleTargetRole,
                    request.CommentRole, DataScaleNativeCommentEntity.Comment, request.EntityRole);
                long commentId = observed.Identities.Resolve(role);
                Comment current = request.CurrentComment;
                if (current.Id != commentId || current.ArticleId != intent.ArticleId
                    || !Enum.IsDefined(current.ModerationStatus) || !commentIds.Add(commentId))
                {
                    throw new InvalidOperationException("comment_timeline_current_row_binding_invalid");
                }
                CommentModerationEvent[] events = FreezeTimelineObservationRoster(
                    request.Timeline.Events, request.Timeline.Events.Count);
                // Unknown enum members and malformed containers are model guards.
                // Continuity remains exclusively the original verifier's decision.
                if (events.Any(item => item is null || !Enum.IsDefined(item.NextStatus)
                    || (item.PreviousStatus is { } previous && !Enum.IsDefined(previous))))
                {
                    throw new InvalidOperationException("comment_timeline_event_model_invalid");
                }
                CommentModerationTimelineResult timeline = request.Timeline with
                {
                    Events = Array.AsReadOnly(events)
                };
                if (!CommentFixtureTimelineVerifier.IsConsistent(timeline, commentId, current.ModerationStatus))
                {
                    throw new InvalidOperationException("comment_timeline_original_verifier_refused");
                }
                groups.Add(new(intent, intent.Comments[index].Coordinate, current, timeline));
            }
            if (groups.Count == 0)
            {
                yield return new(intent, null, null, null);
            }
            foreach (CommentScaleObservedModerationTimelineGroup group in groups)
            {
                yield return group;
            }
        }
        if (input.MoveNext())
        {
            throw new InvalidOperationException("comment_timeline_occurrence_extra");
        }
    }

    /// <summary>
    /// Bounds retained observation group count only. Does not bound event count,
    /// physical graph rows, bytes, CPU/RSS, caller retention or transactions.
    /// </summary>
    public static IEnumerable<IReadOnlyList<CommentScaleObservedModerationTimelineGroup>> ObserveModerationTimelineBatches(
        CommentScalePlan plan,
        ResolvedTemporalRoleContext temporal,
        IEnumerable<CommentScaleGraphFactBindings> graphFacts,
        IEnumerable<CommentScaleTimelineOccurrenceFacts> timelineFacts,
        int batchSize)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(batchSize, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(batchSize, MaximumIntentsPerBatch);
        var batch = new List<CommentScaleObservedModerationTimelineGroup>(batchSize);
        foreach (CommentScaleObservedModerationTimelineGroup group in ObserveModerationTimelineStream(
            plan, temporal, graphFacts, timelineFacts))
        {
            batch.Add(group);
            if (batch.Count == batchSize)
            {
                yield return batch.AsReadOnly();
                batch = new List<CommentScaleObservedModerationTimelineGroup>(batchSize);
            }
        }
        if (batch.Count > 0)
        {
            yield return batch.AsReadOnly();
        }
    }

    private static T[] FreezeTimelineObservationRoster<T>(IReadOnlyList<T> source, int expectedCount)
    {
        ArgumentNullException.ThrowIfNull(source);
        if (expectedCount < 0 || source.Count != expectedCount)
        {
            throw new InvalidOperationException("comment_timeline_declared_roster_mismatch");
        }
        var items = new List<T>();
        foreach (T item in source)
        {
            if (items.Count >= expectedCount)
            {
                throw new InvalidOperationException("comment_timeline_declared_roster_mismatch");
            }
            items.Add(item);
        }
        if (items.Count != expectedCount)
        {
            throw new InvalidOperationException("comment_timeline_declared_roster_mismatch");
        }
        return items.ToArray();
    }
}
